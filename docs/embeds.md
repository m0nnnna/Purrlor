# Link embeds

How a link in a message or a post becomes an embed: a card with the page's title and picture, a
post from another site with its author and text, a player, or the image or video a link points
at. This is the contract between the token server's resolver and the web client. The plan is the
Claude Docs doc "Purrlor: link embeds for messages and posts".

The service side is in `services/token-server/src/`: `embedGuard.ts` (what may be fetched),
`embedFetch.ts` (the guarded fetcher), `embedHtml.ts` (reading a page's tags), `embedProviders.ts`
(site-specific resolvers), `embedResolve.ts` (putting it together, the caches) and `embedRoutes.ts`
(the API), tested in `embeds.test.ts`. The client side is `apps/web/src/matrix/embeds.ts` (reading and writing the field,
the provider table for players), `matrix/hooks/useComposerEmbeds.ts` (resolving while you type)
and `features/messaging/EmbedCard.tsx` (drawing them).

## The rules

1. **The sender resolves a link once and stores the result in the event.** Readers, peer servers
   and the public web draw what's stored and fetch nothing. The person who posted and the people
   reading are never seen by the linked site.
2. **Nothing reaches a third-party site until someone presses play.** Players load only on a click.
   Thumbnails and media are re-uploaded by the sender, so they come from the homeserver like any
   upload.
3. **Encrypted chats get no embeds unless the sender has allowed them** (Settings → Privacy). Even
   then only the sender's own server sees the link, the same as Element's previews; the embed and
   its thumbnail are encrypted like the rest of the message.
4. **An embed is a claim by whoever sent it.** Clients draw only the kinds below, as plain text
   (never HTML), images only from `mxc://` (or an encrypted `file`), and players only from the
   provider table, built from a validated ID, never from a URL in the event.
5. **No embed, or one that fails to draw, leaves a plain link.** Never an empty box.

## `xyz.nekous.embeds`

A list in the content of an `m.room.message` (`m.text`, `m.emote`, `m.notice`) or an
`xyz.nekous.post`, at most 3, in the order their links appear in the body. In an edit it goes in
`m.new_content` like the rest of the content; an edit without it has no embeds.

An **empty list** means "no embeds": the sender removed them, or the sites had nothing to show.
Readers then don't ask the homeserver for a preview either. The field is **left out** when the body
has no links, when embeds aren't allowed (rule 3), or when none of its links could be looked up at
all (the token server unreachable): then readers fall back to the homeserver's preview, as for a
message from before embeds.

```json
"xyz.nekous.embeds": [
  {
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "kind": "player",
    "site": { "name": "YouTube", "color": "#ff0000" },
    "title": "Rick Astley - Never Gonna Give You Up",
    "author": { "name": "Rick Astley", "url": "https://www.youtube.com/@RickAstleyYT" },
    "image": { "url": "mxc://purr.example/AbC", "info": { "mimetype": "image/jpeg", "size": 48213, "w": 1280, "h": 720 } },
    "player": { "provider": "youtube", "id": "dQw4w9WgXcQ" }
  }
]
```

| Field | Type | Notes |
| --- | --- | --- |
| `url` | string, ≤ 2048 | The link as it appears in the body (`http:` or `https:`). Required. An embed whose `url` isn't in the body is ignored. |
| `kind` | `card`, `post`, `player`, `image`, `video`, `audio` | Required. Unknown kinds are ignored. |
| `site` | `{ name?, color? }` | The site's name (≤ 64) and theme color (`#rrggbb`). |
| `title` | string, ≤ 256 | |
| `description` | string, ≤ 1000 | For `post`, the post's text. |
| `author` | `{ name?, handle?, url?, avatar? }` | `post` and `player`. `name`, `handle` ≤ 128; `url` an `https:` link; `avatar` an image (below). |
| `image` | image | A card's or player's picture, or for `image` the image itself (a GIF stays a GIF). |
| `media` | media | `video` and `audio`: the file itself. |
| `player` | `{ provider, id }` | `player` only. See "Players". |
| `published` | number | When the linked post was made (ms since 1970), `post` only. |
| `sensitive` | `true` | The site marks it adult or sensitive: drawn blurred until clicked. |

An **image** is `{ "url": "mxc://…", "info": { "mimetype", "size", "w", "h" } }`, or in an
encrypted room `{ "file": <EncryptedFile>, "info": { … } }` (the spec's encrypted attachment, its
own key). **Media** is the same shape with `info.duration` (ms) allowed. `w`/`h` let the client
reserve space before the bytes arrive.

Clients cut strings to the limits above and drop fields of the wrong type rather than refusing the
embed.

### Kinds

| Kind | Drawn as |
| --- | --- |
| `card` | Site name, title, description, picture. The whole card links to `url`. |
| `post` | A post from another site (X, Bluesky, Mastodon, Reddit, Threads): author's name, handle and avatar, the text, its first picture, when it was posted. |
| `player` | The picture with a play button; pressing it swaps in the provider's player. |
| `image` | The image itself (GIFs animate, honoring reduced motion). |
| `video`, `audio` | Native controls, nothing autoplays. |

### Players

`player.provider` names an entry in the client's table, and `player.id` must match its pattern.
The client builds the frame's URL itself. Anything else draws as a card.

| Provider | `id` | Frame |
| --- | --- | --- |
| `youtube` | `[A-Za-z0-9_-]{11}` | `https://www.youtube-nocookie.com/embed/<id>?autoplay=1` |
| `vimeo` | digits | `https://player.vimeo.com/video/<id>?dnt=1&autoplay=1` |
| `spotify` | `(track\|album\|playlist\|episode\|show\|artist)/[A-Za-z0-9]{22}` | `https://open.spotify.com/embed/<id>` |
| `soundcloud` | `[a-z0-9_-]+/(sets/)?[a-z0-9_-]+` (the path) | `https://w.soundcloud.com/player/?url=https://soundcloud.com/<id>&auto_play=true` |
| `twitch-clip` | `[A-Za-z0-9_-]+` | `https://clips.twitch.tv/embed?clip=<id>&parent=<host>&autoplay=true` |
| `twitch-video` | digits | `https://player.twitch.tv/?video=<id>&parent=<host>&autoplay=true` |
| `streamable` | `[a-z0-9]+` | `https://streamable.com/e/<id>?autoplay=1` |

Each frame host is in the app's `frame-src` and nothing else is. One player plays at a time: starting
one stops the others.

## What gets an embed

- The first 3 `http:`/`https:` links in the body, in order. A link written `<https://…>` gets none
  (Discord's convention), and so does a link inside a code span or block.
- The sender can remove any of them before sending (the composer's preview), or afterwards (the
  message menu, which sends an edit without it).
- Not: commands, polls, stickers, files, messages in an encrypted room unless allowed (rule 3).

## Resolving: the token server

### `POST /api/public/embeds/resolve`

```json
{ "openid_token": { … }, "url": "https://…" }
```

The caller must be an account on this server (`openid_token` as for `/api/public/online`). Answers:

- `200` `{ "embed": { … }, "files": { "image": { "id", "mimetype", "size" }, "media": { … }, "avatar": { … } } }`:
  the embed as above but with no `image`, `media` or `author.avatar` yet, and the files to fetch for them.
- `204`: nothing worth embedding (no title, an error page, a link the guard refuses). Not an error:
  the link stays plain.
- `401` bad token, `403` not an account here, `429` more than 60 links a minute for this account.

### `GET /api/public/embeds/files/:id`

The bytes a resolve found (a picture, a GIF, a short video), kept for 15 minutes under an
unguessable ID. The client checks the dimensions, uploads them to its homeserver (encrypting them
in an encrypted room) and puts the result in the embed.

### How a link is resolved

1. **Site-specific, from the site's own public API**, when the URL matches one:

   | Site | From | Kind |
   | --- | --- | --- |
   | YouTube, YouTube Music | oEmbed (`youtube.com/oembed`) | `player` |
   | Vimeo | oEmbed (`vimeo.com/api/oembed.json`) | `player` |
   | Spotify | oEmbed (`open.spotify.com/oembed`) | `player` |
   | SoundCloud | oEmbed (`soundcloud.com/oembed`) | `player` |
   | Twitch clips and videos | the page's OpenGraph | `player` |
   | Streamable | oEmbed (`api.streamable.com/oembed.json`) | `player` |
   | TikTok | oEmbed (`tiktok.com/oembed`) | `post` |
   | X / Twitter | oEmbed (`publish.twitter.com/oembed`), else the page's OpenGraph | `post` |
   | Bluesky | the public AppView (`public.api.bsky.app`, `getPostThread`) | `post` |
   | Mastodon (and compatible) | the instance's `/api/v1/statuses/:id` | `post` |
   | Reddit | the post's `.json` | `post` |
   | Imgur, Giphy, Tenor | the page's `og:video` / `og:image` | `video` / `image` |

2. **Otherwise the page's OpenGraph** (and Twitter card) tags: `og:title`, `og:description`,
   `og:image`, `og:site_name`, `theme-color`, falling back to `<title>` and `<meta
   name="description">`. A page with no title gets no embed.
3. **A direct file**: a link whose response is `image/*` (≤ 8 MB), `video/*` or `audio/*` (≤ 25 MB)
   is that file. Larger ones get a card naming the file.

No Meta app: Instagram and Facebook get whatever their OpenGraph gives. No third-party mirror for X.

### The fetcher's guard

The token server fetches pages people post, so it must never be pointed at itself or its network:

- `http:` and `https:` only, ports 80, 443, 8080 and 8443 only, no user:password in the URL.
- Every address a host name resolves to is checked when the connection is made (so a name can't
  change address between the check and the request): loopback, private (10/8, 172.16/12,
  192.168/16, fc00::/7), link-local (169.254/16, fe80::/10, so the cloud metadata address too),
  carrier-grade NAT, multicast and unspecified addresses are refused, as are Docker's own names.
  Through `OUTBOUND_PROXY` the proxy makes the connection, so the name is checked just before.
- At most 5 redirects, each checked the same way. 10 seconds per request.
- At most 1 MB of a page is read (the `<head>` is near the top), 8 MB of an image, 25 MB of a video.
- Files are handed back only as PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, Ogg, QuickTime and common
  audio types: never HTML or SVG, which a browser could run (they're served from the app's own
  origin, as attachments, with `nosniff` and a sandboxing policy too).
- It identifies itself as `Purrlor link previews (+https://<this server>)` and sends no cookies.

Resolved embeds are cached per URL for 14 minutes, while their files are still kept (failures for
10 minutes), so a link posted many times, or retyped while composing, is fetched once.

## Drawing

- Up to 3 per event, under its text, in order. Reply previews, notifications and the public web's
  link previews show none.
- An event without `xyz.nekous.embeds` (sent before embeds, or by another client) asks the
  homeserver's `/preview_url` for its first link, as before, except in encrypted rooms.
- The person's setting (Settings → Appearance, "Link embeds"): all (default), no players (players
  draw as cards that open the link), or none (plain links).
- `sensitive`, or a post marked sensitive: blurred until clicked.
- A channel can turn players off for everyone in it (its permissions, "No players in link embeds":
  `no_players: true` in `xyz.nekous.channel_settings`, which only Purrlor reads). They draw as cards.
- A YouTube player, while you're in a call, offers "Watch together", which hands the link to the
  call's Watch Together.

## Peers and the public web

Embeds are part of the event, so peers' posts carry them with nothing extra; their pictures are
`mxc` URLs on the poster's server, fetched over federation like any upload.

The public web's posts (`docs/public-web.md`) include `embeds`, cards and pictures only: a `player`
is a card with its picture whose link opens the site, and `video`/`audio` are cards linking to the
original. Their pictures are served by `/api/public/media` like a post's own.
