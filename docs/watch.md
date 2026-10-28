# WATCH

Videos people upload to their profiles, everyone's stories and who's live, on one page on the rail
(Home, Feed, Chat, Watch), for everyone on this server and its approved peers. This is the contract
the web client builds on. The plan is the Claude Docs doc "Purrlor: WATCH and AUDIO" (AUDIO, the
music side, comes later and reuses the same catalogue).

The service side is `services/token-server/src/watch.ts` (the pure rules: reading video events,
the catalogue, signed play addresses, view counts; unit-tested in `watch.test.ts`) and
`watchRoutes.ts` (the HTTP side). It reads profile rooms in the same pass as the public web's feed
(`publicWebRoutes.ts`, `refreshFeed`), so it sees the same rooms: this server's profile rooms from
the room directory, and the peers' profile rooms the service bot has joined (`docs/federation.md`).

## How it fits together

- A **video** is a file in Matrix media plus a state event in its owner's profile room. The profile
  is the channel. Nothing is transcoded: MP4 and WebM play as uploaded.
- The **catalogue** is the token server's index of every video, live stream and story in the rooms
  it reads, rebuilt with the feed (every 60 s) and kept in memory. Your own server answers for its
  own people and its peers' people alike, so WATCH asks one server.
- **Playing** a video asks the **owner's server** (as watching a stream does): it counts the view
  and hands back a short-lived address its token server serves the file from, with real range
  requests so the player can seek. (Continuwuity ignores `Range`, so the file can't come straight
  from the homeserver.)
- **Comments** are the posts' comment threads (`docs/posts.md`), hung off the video's first event.
- **Stories** are the existing ones (`docs/stories.md`): WATCH lists everyone who has one, not only
  the people you follow, and opens them in the same story viewer.
- **Live** is the existing streams (`docs/streaming.md`): WATCH lists everyone live, here and on
  peers, from the pointers in their profile rooms. A pointer of this server's own people is listed
  only while the stream it names is live here; a peer's is taken as it is (the app reads the stream
  from its server before drawing a player, as everywhere).

## The video event

`xyz.nekous.video`, a state event in the owner's profile room, state key = the video's id (16
characters from `[A-Za-z0-9_-]`). Only the owner sends it (the type's power level is 100, as for
stories). Content:

| Field | Type | |
|---|---|---|
| `url` | mxc | the file |
| `mimetype` | `video/mp4` \| `video/webm` | |
| `size` | integer, bytes | |
| `duration` | integer, seconds | at least 1 |
| `w`, `h` | integer | the picture's size |
| `title` | string, 1–100 | |
| `description` | string, up to 5000 | plain text; links are linkified when shown |
| `thumbnail` | mxc | JPEG or PNG or WebP, 1280 wide at most |
| `visibility` | `public` \| `private` | below |
| `uploaded_at` | integer, ms | set once, kept by edits |
| `anchor` | event id | absent on the first write; every later write carries the first write's event id |

Events can't hold fractions, so every number is a whole number.

- **Edit** = send the event again with the same state key, every field filled in, and `anchor` set.
- **Delete** = send it with `{}`. The file stays on the media server until an admin purges it (as
  for deleted posts).
- An event missing a required field, with another mimetype, or sent by anyone but the owner is
  ignored everywhere.
- A person has at most `WATCH_MAX_VIDEOS` videos (default 500); the catalogue indexes the newest
  that many by `uploaded_at`.

### The videos block

Videos show on the channel's **Videos tab** whether or not the page has a block. The profile page
(`docs/profile-pages.md`) can also arrange them with a block:

```
{ id, type: 'videos', title?, side?, playlists: { id, title?, videoIds: string[] }[] }
```

At most 20 playlists of 200 ids. An id with no video behind it is skipped.

## Visibility

- **Public**: anyone. Signed-out visitors see it on the owner's public web page (and at
  `/@name/video/<id>`) when the profile's public web is on (`docs/public-web.md`).
- **Private**: anyone signed in, on this server or a peer. Still listed in WATCH and on the profile
  for them; never shown on the public web or served by its media route.

The file itself sits in Matrix media, which needs a login (authenticated media), so a private
video's file only reaches someone through a play address, which needs a signed-in caller.

## Comments

A video's comments are `xyz.nekous.comment` events in the owner's profile room with
`m.relates_to: { rel_type: 'm.reference', event_id: <anchor> }`, where `<anchor>` is the video's
`anchor`, or the event id of its current event when it has none (the first write). Everything else
is as for a post's comments: content, replies, likes, deleting, reporting (`docs/posts.md`), and the
same `CommentThread` and `usePostInteractions(roomId, anchor, owner, uploaded_at)`. Signed-out
visitors read a public video's comments and can't add any.

## Views

The owner's server counts a play when `POST /api/public/watch/play` succeeds: once per viewer per
video per UTC day (a signed-in viewer by Matrix ID, a signed-out one by IP). Who has been counted
today is kept in memory only (as salted hashes), so a restart can count someone twice that day.
Counts live in `/data/watch-views.json` `{ views: { "<owner>|<video id>": n } }`, written at most
every 30 s. Deleting a video drops its count. Counts for a peer's videos are fetched from that peer
(`GET /api/public/watch/views`, its newest 1000 videos) with each catalogue rebuild, and are absent
when the peer doesn't answer.

## Limits

Token server env, with the homeserver's own upload limit above them:

| Setting | Default | |
|---|---|---|
| `WATCH_MAX_BYTES` | 500 MiB | one video's size; the app uses the smaller of this and the homeserver's `m.upload.size` |
| `WATCH_MAX_VIDEOS` | 500 | per person |
| `WATCH_PLAY_TTL_S` | 21600 (6 h) | how long a play address works |

The homeserver's limit is `MATRIX_MAX_UPLOAD_BYTES` (default 100 MiB) and nginx's
`client_max_body_size` (100M); raise both to allow bigger videos. Video files are copied into the
token server's media cache to be served (`PUBLIC_MEDIA_CACHE_BYTES`, default 1 GiB, least recently
used first), so the cache should hold a few videos at the size cap.

## API

All on the token server, under `/api/public/watch/` (nginx passes `/api/public/` to the token server
on every instance; a path outside it would need every server's nginx changed). Every route may be
called from any site (`corsPolicy.ts`), as the streams' are: a peer's app plays a video here. Every
body is JSON; `openid_token` is the caller's Matrix OpenID token (`docs/voice-architecture.md`), from
this server or a peer as each route says. Rate limits are per IP, as the streams' routes. Errors are
`{ error, code }`; 401 `auth_failed` for a token that doesn't check out, 429 `rate_limited`.

### `POST /api/public/watch/catalogue`

Signed in, **this server's people only** (403 `not_local`). Body:

```
{ openid_token, q?, owners?: string[], cursor?, limit? }
```

- `q`: words matched against title, description and channel name, case-insensitively.
- `owners`: only these channels (the client sends the people it follows for "Following").
- `limit`: 1–60, default 30. `cursor`: from the previous answer's `next` (opaque; one that can't be
  read gives the first page).

Answer:

```
{
  videos: CatalogueVideo[],      // newest uploaded_at first
  next?: string,
  live: LiveEntry[],             // first page only (no cursor), newest first
  stories: StoryEntry[]          // first page only, newest story first
}
CatalogueVideo = {
  owner, id, room_id, title, description, duration, w, h, mimetype, size,
  thumbnail,                     // mxc, read through the app's own media
  visibility, uploaded_at, anchor, views?,  // views absent when unknown
  server                         // the owner's server name
}
LiveEntry  = { owner, stream_id, title, started_at, server }
StoryEntry = { owner, room_id, latest_ts, count }
```

`live` and `stories` aren't filtered by `q` or `owners`. A hidden or public-off person (`purrlor
hide`, `docs/admin.md`) and anyone a peer reports hidden are left out, as is a video whose file an
admin took down (`purrlor takedown`). The catalogue is the feed's snapshot, so a new video shows up
within about two minutes (an open WATCH page asks again every 30 s). The client opens a story
entry with the existing story loading (`loadUserProfileSource` and the story events), and a live
entry with the stream's own server (`streamBaseFor`, `docs/streaming.md`).

### `POST /api/public/watch/play`

Asked of the **owner's** server, for one of its own people's videos. Body `{ openid_token?, owner,
video_id }`. A token from any server is checked; a private video needs one from this server or a
peer. Without one, only a public video whose owner's public web is on. A video newer than the
snapshot (just uploaded) is found by reading the owner's room again. Answer:

```
{ url: "/api/public/watch/file/<play token>", expires_at, views }   // expires_at in ms
```

`url` is relative to that server. 404 `not_found` (no such video, deleted, taken down, or private
and no token), 403 `hidden`. The server starts copying the file into its media cache as it answers,
so it's ready when the player asks.

### `GET /api/public/watch/file/<play token>`

The file, with `Accept-Ranges` and 206 answers, through the media cache, as the type its event names,
with `Cross-Origin-Resource-Policy: cross-origin` (peers' apps play it). The play token is
`base64url(<owner>|<video id>|<url>|<expires_at>)`, a `.`, then `base64url(HMAC-SHA256(key, that
same text))`, with the key the token server keeps in `/data/watch-key` (32 random bytes, made on
first start, mode 0600). It works for anyone holding it until `expires_at`, then 410 `expired`; a
video deleted, taken down or given another file since gives 404, as does a file over
`WATCH_MAX_BYTES`.

### `GET /api/public/watch/views?ids=<owner>|<id>,…`

Up to 100 ids, this server's own videos only (`0` for one not watched yet; an id that isn't one of
them is left out). Answer `{ views: { "<owner>|<id>": n } }`. Public: a peer's catalogue asks it.

### `GET /api/public/watch/limits`

`{ max_bytes, max_videos, types: ["video/mp4", "video/webm"] }`. The app also checks the
homeserver's `m.upload.size`.

### `GET /api/public/watch/:owner/:id`

The public web's video page data: the video's fields, as the answer itself (a `CatalogueVideo`,
`thumbnail` as a public media path `/api/public/media/<server>/<media id>`), if it is public and the
owner's public web is on, else 404. `:owner` is `name` for this server's people, `name:server` (or
`@name:server`) for a peer's. The public web's media route also serves a public video's thumbnail (not its file: that
goes through `play`).

## The app

- **Rail**: Watch, after Chat (`RailSection` gets `'watch'`; on phones a tab).
- **The WATCH page**: a **Live now** row (thumbnails, as Home's), a **Stories** row (everyone with a
  story, seen ones last), then the videos grid with **Latest** / **Following** and search. Cards:
  thumbnail, duration, title, channel, views, age.
- **The video page** (`/@name/video/<id>`, signed in or out): the player (through `play`, seeking
  works), title, views, age, description, the channel (avatar, name, link to the profile), comments,
  and more from the channel.
- **The channel**: the profile's **Videos** tab, newest first; on your own, **Upload**, and on each
  card edit (title, description, thumbnail, visibility) and delete.
- **Upload**: MP4 or WebM under the limit. The app reads the duration and size from a `<video>`
  element, grabs a thumbnail from a frame about 10% in (or the person picks a picture), uploads the
  file and the thumbnail to Matrix media, then sends the event. A progress bar shows the upload.
- **From a post**: a post going to the global feed or a profile (plain uploads, not a members-only
  Space) with an MP4 or WebM offers **Also add to WATCH**, on by default. After the post is sent
  each such video also gets an event in the poster's profile room that reuses the post's `mxc` URL
  (no second upload); only the thumbnail, a frame about 10% in, is uploaded. The title is the
  post's text cut to 100 characters (else the file name), the description the post's text, and it is
  public. A video over the size limit is skipped with a note; if publishing fails the post stands
  and the composer shows the error.
