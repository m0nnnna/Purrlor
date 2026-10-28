# Live streaming

Public live streams from a person's profile: 720p at 30 fps from the browser, or whatever OBS sends
over WHIP (below, "OBS"), watched by anyone
(signed in on this server or a peer, or signed out on the public web), with a chat beside it and a
replay kept for 3 days. This is the contract the web client builds on. The plan, and why it's
shaped like this (the bandwidth sums), is the "Live streaming" sections of the Claude Docs doc
"Purrlor: WATCH and AUDIO".

The service side is `services/token-server/src/streams.ts` (the pure rules: caps, grants, records,
expiry; unit-tested in `streams.test.ts`), `streamRoutes.ts` (the HTTP side, LiveKit and the chat
room), `recordings.ts` (Egress and the replay files), `whip.ts` (stream keys and the WHIP address
OBS sends to) and `controlServer.ts` (`purrlor streams`).

## How it fits together

- A stream is sent **from the streamer's browser to their own server's LiveKit**, and every viewer,
  wherever they're from, receives it from there. Nothing is re-encoded for viewers: LiveKit forwards
  the layer each one needs. So the streamer's server's upload decides how many can watch (the cap,
  below).
- Only **this server's own people** can go live here. Someone on a peer goes live on their own
  server, and people here watch it from there.
- A stream has a **LiveKit room** (`stream-<id>`), a **chat room** (a Matrix room the service bot
  makes for it), a **record** in the token server, and a **pointer in the streamer's profile room**
  so apps showing the profile know it's live.
- Egress **records** every stream to one MP4, which becomes the replay when it ends.

## The stream ID and record

`id` is 16 random characters from `[A-Za-z0-9_-]`. The token server keeps every stream it has
records for in `/data/streams.json`:

```json
{ "id": "k3J9x_Qm2PzL0aBc", "owner": "@luna:purr.example", "title": "Drawing a commission",
  "state": "live", "createdAt": 1790000000000, "liveAt": 1790000004000, "endedAt": null,
  "chatRoom": "!abc:purr.example", "egressId": "EG_…", "replay": null, "expiresAt": null }
```

| `state` | Meaning | Who sees it |
| --- | --- | --- |
| `starting` | Made, the streamer is connecting and publishing | Only the streamer |
| `live` | The streamer said it's on (`POST …/live`), recording runs | Everyone |
| `ended` | Over; `replay` is set once the recording is written | Everyone, until `expiresAt` |

`expiresAt` is `endedAt` + `STREAM_REPLAY_HOURS` (default 72). At that time the replay file, the
chat log and the record are deleted and the chat room is closed (below). A stream that stays in
`starting` for 10 minutes is deleted as if it never was.

A stream ends when:

- the streamer stops it (`POST …/stop`), or an admin does (`purrlor streams end <id>`);
- the streamer has been out of the LiveKit room for 2 minutes (a closed tab, a lost connection:
  they have that long to come back);
- it has run `STREAM_MAX_HOURS` (default 12).

## The pointer in the profile room

The streamer's app writes this when it goes live and empties it (`{}`) when it stops:

```json
// xyz.nekous.live_stream, state key "", in the owner's profile room
{ "stream_id": "k3J9x_Qm2PzL0aBc", "title": "Drawing a commission", "started_at": 1790000004000 }
```

Only the owner can write it (their profile room's power levels). It is a hint for apps, never
trusted on its own: an app reads the stream from the owner's server (`GET /api/public/streams/:id`)
before it draws a player, so a stale or made-up pointer shows nothing. It carries no address: the app
finds the owner's server from the owner's user ID: its own server's app, or a peer's `url` from
`GET /api/public/peers` (docs/federation.md). A person on a server that is neither isn't shown as
live; their own server's page is where they're watched.

## Where people watch

- **On the profile.** While its owner is live, a player sits at the top of the profile's middle
  column, above the posts, pushing them down, with the title and viewer count. It doesn't play until
  pressed. **Watch with chat** opens the watch page.
- **The watch page**: `/@name/live/<id>`, the player and the chat beside it (under it on a phone).
  The same address works signed out (the public web) and signed in. After the stream ends, it plays
  the replay until it expires, then says the stream has ended.
- **The feed.** The streamer can post about it: a normal Global post (docs/posts.md) whose text has
  the watch page's link, which shows as a link card (docs/embeds.md) with the stream's thumbnail.
- **The profile's Streams tab.** Every live or unexpired stream of the person, newest first, as
  cards (thumbnail, title, LIVE or REPLAY with its length, when it ended and when it'll be
  deleted). It shows when they have any, and always on your own profile. On your own, each card can
  also be renamed, downloaded, and (once ended) deleted for good.
- **Home, "Live now".** The streams live on the signed-in person's own server, beside the voice
  channels with people in them: thumbnail, viewer count, title and streamer. Asked every 30 s while
  Home is showing; a card opens the watch page.
- **Small views** (a card, a link preview) show the thumbnail, refreshed every 60 s, never video.

There is no directory of every server's streams; Home lists this server's live ones
(`GET /api/public/streams` below).

## The cap

One viewer cap per server, shared by every stream on it. Signed-in and signed-out viewers count
alike; signed-out viewers may fill at most half of it.

```
cap       = STREAM_VIEWER_CAP, or floor(0.7 × STREAM_UPLINK_MBPS / 1.6)    (default uplink 100 → 43)
guest cap = floor(cap / 2)
```

1.6 Mbps is about what one viewer at 720p costs (VP9); the 30% left is for voice, the site and
federation. purr.meowops.net: `STREAM_UPLINK_MBPS=300`, cap 131, guest cap 65. Viewers on small
players take less, so this is a safe floor, not a ceiling.

Counted at the moment a viewer token is asked for: everyone in every stream's LiveKit room except
streamers and recorders, plus tokens given in the last 30 s whose holders haven't joined yet. At the
cap the answer is `503 { "code": "stream_full" }` (`"guest_full"` for signed-out viewers when only the
guest share is full). Someone already watching is never cut off.

`STREAM_MAX_LIVE` (default 2) streams may be live on a server at once; another `start` gets `409
{ "code": "server_busy" }`. One person has one stream at a time (`409 { "code": "already_live" }`).

## LiveKit

### Rooms

The token server makes each stream's room itself (`createRoom`): `stream-<id>`, `maxParticipants` =
cap + 4, `emptyTimeout` 600 s (as long as a stream may be `starting`), `departureTimeout` 120 s. Stream rooms are kept apart from voice
channels (`matrix-…`): a voice token never names a stream room and the other way round.

### Grants

| Who | Identity | Grants | Token lifetime |
| --- | --- | --- | --- |
| Streamer | their Matrix ID | `canPublish` (sources: screen share, screen-share audio, microphone), `canSubscribe` (LiveKit never connects a client without it; nobody else in the room sends anything), `canPublishData: false`, `canUpdateOwnMetadata: false` | 12 h |
| Signed-in viewer | their Matrix ID, `#`, 8 random hex digits | `canSubscribe`, `hidden`, nothing else | 5 min (only for joining) |
| Signed-out viewer | `guest-` + 16 random characters | `canSubscribe`, `hidden`, nothing else | 5 min |
| OBS's picture (Ingress) | the streamer's Matrix ID | given by Ingress itself: a camera and a microphone track | while OBS sends |
| The streamer's dashboard, OBS streams | their Matrix ID + `#preview` | as a viewer (`canSubscribe`, `hidden`) | 12 h |

The preview identity isn't a viewer: it doesn't count toward the cap or in `viewers`, like the
streamer and the recorder.

Each viewing is its own identity, so one person in two tabs (or the streamer checking their own
stream) doesn't knock the other out, and each counts toward the cap, as each costs upload. A viewer
who drops and comes back sends the identity they had as `resume`: if it's still in the room (and,
signed in, starts with their own Matrix ID), they get it back without counting again.

`hidden` keeps viewers out of everyone's participant list, so a viewer joining doesn't send a message
to every other viewer; the count comes from the token server instead. A viewer token for a stream
that isn't `live` is refused (`404`). A viewer whose token expired while watching stays connected; a
new token is only needed to reconnect.

### The stream's encoding (the client's side)

Defined in `apps/web/src/features/streaming/streamRoomOptions.ts`, kept apart from voice's
screen share (`voiceChannelRoomOptions.ts`), which stays at 1080p60.

- Capture: 1280×720 at 30 fps, `contentHint: 'motion'`; the sound of the shared tab or window
  (the same rules as screen share), and the streamer's microphone if they turn it on.
- Video: **VP9 with SVC, `L3T3_KEY`** (720p, 360p, 180p layers in one stream), at most 2.5 Mbps.
  Where the browser can't send VP9 SVC, `backupCodec` is **VP8** with simulcast (720p, 360p, 180p).
- `dynacast: true`: layers nobody is watching aren't encoded.
- Audio: Opus, stereo, about 96 kbps, with echo cancellation, noise suppression and automatic gain
  off for the shared sound (on for the microphone).
- Viewers: `adaptiveStream: true` (the layer that fits the player), video paused while the tab is
  hidden, and an **audio only** switch that unsubscribes the video.
- No frame-rate option: streams are 30 fps.

`deploy/livekit.yaml` lists `video/vp9` in `enabled_codecs` (Opus, H.264 and VP8 stay listed: the
list replaces LiveKit's own), and throttles keyframe requests (`rtc.pli_throttle`) so a burst of new
viewers doesn't force a burst of full frames.

## Chat

Each stream's chat is a Matrix room the service bot makes when the stream starts:

- name "`<title>` · live chat", topic the watch page's address, `xyz.nekous.stream_chat` state
  (`{ "stream_id": "…", "owner": "@luna:…" }`), join rule `public`, history `shared`, not in the
  room directory;
- power levels: the bot 100, the streamer 50 (they can delete messages, kick and ban), everyone else
  0, anyone timed out -1 (sending takes 0);
- anyone signed in, on this server or another, joins it and talks; the app joins when the chat is
  opened and leaves when the watch page closes;
- **signed out**, the chat is read-only, through `GET /api/public/streams/:id/chat`: the newest
  messages, plain text only, with the sender's user ID and avatar. There's no way to send.

**Moderating.** The streamer moderates from their dashboard through `POST /:id/moderate` (below), and
the bot does it, so it works the same whichever server the person is from: deleting a message
(a redaction), a **timeout** of 1 minute to 24 hours (the bot sets them to -1; the sweep puts them
back when it's over, within 15 s), and ban and unban. The streamer can't be moderated, nor the bot.
Timeouts are kept in the record (`timeouts`, user to until when) and dropped when the stream ends,
as the room is read-only from then on.

When the stream ends, the bot makes the room read-only (sending needs power level 50) and writes the
whole chat to the log (below); the watch page shows it beside the replay. When the replay expires, the bot closes the room: join rule `invite`,
everyone removed, and the bot leaves. Copies of the room's history on other servers whose people
were in it stay until those servers clean up their own empty rooms: Matrix can't delete a room from
someone else's server.

## Recording and replays

Egress records each stream once it's `live`: **one participant egress** of the streamer (screen
share and its sound, plus the microphone; for an OBS stream, Ingress's camera and microphone
tracks) to one MP4, H.264 720p at 30 fps with AAC, written to
`/recordings/<id>.mp4`. That's the only encoding the server does: about one CPU core per live stream.
When the stream ends the egress is stopped and the record's `replay` is filled in:

```json
"replay": { "bytes": 734003200, "durationMs": 3600000 }
```

`/recordings` is a volume shared by the Egress container (writes) and the token server (reads and
deletes). About 0.7 GB an hour of stream.

The **chat log** is written when the stream ends, to `/data/streams/<id>/chat.jsonl`, one message a
line (`{ "ts", "sender", "body" }`, plain text, deleted messages left out). The chat is read-only from
then on, so the log is all of it.

Who gets what:

| | The replay (play) | The replay file (download) | The chat log |
| --- | --- | --- | --- |
| Anyone, signed in or out | Yes, on the watch page, until it expires | No download button | No |
| The streamer | Yes | Yes | Yes |
| The server's admins | Yes | `purrlor streams export <id>` | `purrlor streams export <id>` |

A replay plays from a file, so a determined viewer can still save what their browser receives; the
download button and the original file are what's kept to the streamer and admins.

## API

All under `/api/public/streams` (nginx already forwards `/api/public/`). Open to any page (CORS),
like voice: people on peers watch through their own server's app. `openid_token` is a Matrix OpenID
token, as for voice (docs/voice-architecture.md). Signed-out requests are rate limited per address
like the public web's pages; token requests have their own, tighter limit (bursts of 10, 20 a
minute).

### `POST /api/public/streams` — go live

`{ "openid_token", "title", "source"? }` → `201`

```json
{ "stream": { …the stream… }, "token": "<LiveKit JWT>", "url": "wss://livekit.purr.example" }
```

`source` is `"browser"` (the default: `token` is the streamer's, to publish with) or `"obs"`
(`token` is the dashboard's preview, to watch with; the picture comes from OBS, below). For `obs`
the token server makes the stream's own Ingress first; `403 obs_off` when the server has none,
`503 obs_unavailable` when Ingress doesn't answer.

The caller must be on this server and not hidden by an admin (docs/public-web.md). `title` is 1 to
120 characters of plain text. Makes the record (`starting`), the LiveKit room and the chat room. A
stream of theirs still `starting` (a reload while connecting) is dropped for the new one. If the
chat room can't be made, the stream goes ahead with `chatRoom: null`.
Errors: `400 bad_title`, `401`, `403 not_local | hidden | streaming_off`, `409 already_live |
server_busy`.

### `POST /api/public/streams/:id/live`

`{ "openid_token" }`, the streamer only, once their tracks are published. → `200 { "stream" }`, now
`live`; recording starts. The app writes the profile pointer after this answer.

For an OBS stream: `409 not_receiving` until OBS's picture is in the room; the dashboard asks again
every 3 s. The sweep also makes it live on its own once the picture arrives (the dashboard may be
closed), so the dashboard writes the profile pointer whenever it sees the stream `live`.

### `POST /api/public/streams/mine`

`{ "openid_token" }` → `200 { "stream": … | null }`: the caller's stream that's `starting` or
`live`, `starting` ones too (no other route shows those). The dashboard picks a stream back up with
it after a reload.

### `POST /api/public/streams/obs`

`{ "openid_token", "reset"? }` → `200 { "url": "https://purr.example/api/public/whip", "key":
"pk_…" }`: what goes in OBS. The key is made the first time it's asked for and kept; `"reset":
true` makes a new one, and the old one stops working at once (a stream already coming in goes on).
`403 obs_off` without Ingress.

### `POST /api/public/streams/:id/preview`

`{ "openid_token" }`, the streamer only, an OBS stream not yet ended → `200 { "token", "url" }`: a
new preview token (after a reload). `409 not_obs`, `409 ended`.

### `POST /api/public/streams/:id/moderate`

`{ "openid_token", "action", … }`, the streamer only:

| `action` | Also | Does |
| --- | --- | --- |
| `delete` | `event_id` | Deletes that message |
| `timeout` | `user`, `minutes` (1 to 1440) | They can't send until then (live only) |
| `untimeout` | `user` | Lifts it now |
| `ban` / `unban` | `user` | Out of the chat room for good, or let back |

→ `200 { "timeouts": { "@bob:…": 1790000304000 } }`, the timeouts running now. Errors: `400
bad_action | bad_event | bad_user | bad_minutes`, `404 no_chat`, `409 ended` (a timeout after the
end).

### `POST /api/public/streams/:id/stop`

`{ "openid_token" }`, the streamer only. → `200 { "stream" }`, now `ended`. Everyone in the LiveKit
room is disconnected. The app empties the profile pointer.

### `POST /api/public/streams/:id/title`

`{ "openid_token", "title" }`, the streamer only, any time (live or ended). `title` is 1 to 120
characters. → `200 { "stream" }` with the new title. Errors: `400 bad_title`, `403 not_yours`.

### `POST /api/public/streams/:id/delete`

`{ "openid_token" }`, the streamer only, once the stream has ended. Deletes the replay, the chat log
and the record for good. → `204`. Errors: `403 not_yours`, `409 not_ended` (still live).

### `PUT /api/public/streams/:id/thumbnail`

The streamer only: `Authorization: OpenID <access_token> <matrix_server_name>` (the body is the
picture), `Content-Type: image/jpeg` or `image/webp`, at most 300 KB, about 640×360. Sent about every
60 s while live. → `204`. Kept in memory, the newest only.

### `GET /api/public/streams/:id`

Anyone. → `200 { "stream": … }` as below, or `404 { "code": "not_found" }` (no such stream, still
`starting`, expired, or its owner is hidden).

```json
{ "id": "k3J9x_Qm2PzL0aBc", "owner": "@luna:purr.example", "title": "Drawing a commission",
  "state": "live", "liveAt": 1790000004000, "endedAt": null, "viewers": 37,
  "chatRoom": "!abc:purr.example", "thumbnail": "/api/public/streams/k3J9x_Qm2PzL0aBc/thumbnail",
  "replay": null, "saving": false, "expiresAt": null, "source": "browser" }
```

`viewers` is the number watching now (live only). `replay`, once ended and written, is `{
"durationMs", "url": "/api/public/streams/<id>/replay" }`. `saving` is true while an ended stream's
recording is still being written; ended with `replay: null` and `saving: false` means no replay
was recorded.

### `GET /api/public/streams?owner=<user>`

Anyone. This server's streams that are `live`, or `ended` with a replay that hasn't expired, newest
first, at most 20: `{ "streams": [ … ] }`. `owner` narrows it to one person (`@name` or `name`).

### `POST /api/public/streams/:id/token` — watch

`{ "openid_token", "resume"? }` signed in, or `{ "resume"? }` signed out. → `200 { "token", "url",
"roomName", "identity" }`; keep `identity` to send as `resume` when reconnecting. Errors: `404` (not
live), `503 stream_full | guest_full`, `429`.

### `GET /api/public/streams/:id/thumbnail`

The newest thumbnail (`Cache-Control: public, max-age=30`), or `404`.

### `GET /api/public/streams/:id/chat?after=<ts>`

Anyone. The newest 50 messages (or those after `after`), oldest first:
`{ "messages": [ { "id", "ts", "sender", "body" } ], "authors": { "<user>": { "userId", "avatarUrl" } } }`.
Only `m.text` and `m.emote` bodies, as plain text; deleted messages left out. Ask at most every 3 s.

### `GET /api/public/streams/:id/replay`

Anyone, while the replay hasn't expired: the MP4, with `Range` support (`206`), `Content-Disposition:
inline`, `Cache-Control: private, max-age=600`.

### `POST /api/public/streams/:id/download`

`{ "openid_token" }`, the streamer only. → `200 { "replay": "<url>", "chat": "<url>" }`: addresses
good for 10 minutes that send the MP4 and the chat log as attachments (`<id>.mp4`, `<id>-chat.jsonl`).

### Link previews

`GET /api/public/card/:user/live/:id`: the stream's title, "Live now" or "Replay", and the thumbnail.
nginx sends link-unfurling bots there for `/@name/live/<id>` (the `location` in docs/public-web.md
gains `live`).

## Admins

```sh
sudo purrlor streams                    # live and ended streams, viewers, replay sizes
sudo purrlor streams end <id>           # stop one now
sudo purrlor streams export <id> <dir>  # copy its replay and chat log out
sudo purrlor streams delete <id>        # end it and delete its replay and chat log now
```

Settings, in `.env` (then `purrlor restart token-server`):

| Setting | Default | |
| --- | --- | --- |
| `STREAMING` | `on` | `off` refuses new streams |
| `STREAM_UPLINK_MBPS` | `100` | The server's upload, which sets the cap |
| `STREAM_VIEWER_CAP` | from the uplink | Set it to override the sum |
| `STREAM_MAX_LIVE` | `2` | Streams live at once |
| `STREAM_MAX_HOURS` | `12` | Longest stream |
| `STREAM_REPLAY_HOURS` | `72` | How long replays and chat logs are kept |

## OBS

Anyone who can go live can stream from OBS (or anything else that speaks WHIP) instead of the
browser. The picture passes through as OBS sends it: nothing is encoded again, so OBS's settings
are what viewers get. Purrlor's setup page asks for 720p or 1080p at 30 fps, about 3000 to 4500
kbps, H.264 with B-frames off, a keyframe every 2 s, and Opus sound. That's OBS's default for
WHIP, apart from the resolution and bitrate. Without layers to pick from (no simulcast),
everyone receives the one stream: the cap above assumes about 1.6 Mbps a viewer, so a 4500 kbps
stream gets about a third as many viewers before the server's upload runs out. The setup page
says so.

In OBS: Settings → Stream → Service **WHIP**, Server **the `url`** from `POST /obs`, Bearer Token
**the key**.

How a stream goes:

1. On the setup page, the streamer picks OBS and a title and presses Go live (`POST /` with
   `source: "obs"`). The token server makes an **Ingress** for this stream (`WHIP_INPUT`,
   transcoding off) that puts what it gets into `stream-<id>` as the streamer's Matrix ID.
2. They press Start Streaming in OBS. OBS sends its offer to `/api/public/whip` with the key. The
   token server finds whose key it is and their OBS stream that's going, and hands the offer on to
   Ingress (`INGRESS_WHIP_URL`) under that stream's own Ingress key. With no such stream: `403
   not_live` ("Go live in Purrlor first"); a wrong key, `401 bad_key`. Ingress's answer comes back
   with its `Location` rewritten to `/api/public/whip/…`, so OBS's later requests (`PATCH`,
   `DELETE`) come back the same way.
3. Once the picture is in the room the stream is `live` (above), and recording starts.
4. Ending in Purrlor deletes the Ingress, which cuts OBS off. OBS stopping on its own counts as the
   streamer leaving: two minutes later, the stream ends.

So the key in OBS never changes between streams, and LiveKit's own keys never leave the server.
Keys are kept in `/data/obs-keys.json` (0600), one per person.

## The dashboard

Going live opens the streamer's dashboard in place of the old bar, and the setup page before it.
Everything it needs is above:

- **Setup**: title, thumbnail (uploaded as for browser streams, `PUT /:id/thumbnail`), source
  (browser, or OBS with the `url` and key to copy and a button to make a new key).
- **Preview and health**: for a browser stream, its own tracks; for OBS, the preview token. Its
  resolution, frame rate and bitrate come from the client's WebRTC stats, and `viewers` from `GET
  /:id`. The preview has its own controls: listen to OBS's sound (off by default, so it can't echo
  into a microphone OBS captures; a browser stream's own sound is never played back), hide the
  preview, full screen.
- **Sharing**: while live, the watch page's link to copy (the share sheet on a phone), and buttons
  that open X's, Bluesky's, Reddit's and Facebook's own "post this" pages with it.
- **While live**: the title (`POST /:id/title`), and for a browser stream, switching what's shared
  (another screen or window, the microphone on or off, the shared sound on or off) by replacing
  its own tracks: nothing on the server changes.
- **Chat with moderation**: the stream's chat, with delete, timeout and ban on each message
  (`POST /:id/moderate`).

## Deploying

Recording adds two containers to `deploy/docker-compose.yml`: **Redis** (Egress needs it to talk to
LiveKit) and **Egress** (`livekit/egress`), and LiveKit gains a `redis:` block. The `recordings`
volume is mounted into Egress and the token server. The token server gets `LIVEKIT_PUBLIC_URL` (the
`wss://` address viewers on other servers connect to; it's `PURRLOR_LIVEKIT_URL`). Egress's own
config is written in the compose file (`EGRESS_CONFIG_BODY`, from the same API key). If Egress can't
record, the stream goes on and `replay` stays `null`; `STREAM_RECORDING=off` doesn't ask it at all.

OBS adds an **Ingress** container (`livekit/ingress`, config `INGRESS_CONFIG_BODY` in the compose
file). Its WHIP server (port 8080) is only reached by the token server, through `INGRESS_WHIP_URL`
(default `http://ingress:8080`; set it empty to turn OBS off), so nginx needs nothing new. Its media
takes **UDP 7885**, which has to reach the server from the internet like 7882: `setup.sh` opens it
in ufw, and a router or firewall in front needs it forwarded. A host that reaches the internet
through `OUTBOUND_PROXY` needs `ingress` in `OUTBOUND_NO_PROXY`.

LiveKit needs Redis running once `livekit.yaml` names it, so voice depends on the `redis` container
too: `purrlor update` starts it with everything else.

nginx: the profile `location` (docs/public-web.md, "Deploying") matches `live` beside `music`, `art`
and `commissions`, and the card rewrite for it.
