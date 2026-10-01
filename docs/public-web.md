# The public web

What a Purrlor deployment shows people who aren't signed in: **Global posts**, and the **profile
pages** of people who opted in. Everything else stays behind sign-in. The service side is in
`services/token-server/src/publicWeb.ts` (the rules, unit-tested) and `publicWebRoutes.ts` (the
HTTP side). The web client's signed-out views (`/@name`, `/feed`) are built on the API below.

## The rules

| What | Signed out |
| --- | --- |
| A post made to **Global** | Shown, always, with its author's avatar and username (Matrix ID) and nothing else about them |
| A post in a **Space**, public or not | Never. The service reads profile rooms only, never a Space's feed room |
| A Global repost or quote of a **Space** post | Shown as `{ "kind": "hidden" }`: something was shared, never what or by whom |
| A Global repost of a **Global** post | Shown, with the original's author |
| Likes and comments | Counts only. Who liked and what commenters said stay behind sign-in |
| Mentions in a post | The post's plain text, as written. The formatted body (whose mention links carry Matrix IDs) isn't sent, only the emotes in it |
| A **profile page** | Only if its owner opted in. Otherwise the answer is identical to "no such user" |
| Anyone on another homeserver | Never |
| Anyone an admin hid | Never: their page, and their posts on the public feed |
| A page an admin switched off | Not the page, whatever its owner's switch says; their Global posts still show |
| Media | Only files a public post or a public page names now (or an avatar or banner shown in the last six hours), only pictures, video and allowed sound, never a file an admin blocked |

### Opting in

The owner's profile room carries, as state:

```json
// xyz.nekous.public_web, state key ""
{ "enabled": true }
```

Only the owner can set it (their profile room's power levels). Anything but `enabled: true` is off.
The service reads it on each feed refresh, so switching it off takes effect within a minute.

## What the app does with it

- **Signed out** (`features/publicWeb/`): `/@name` is the person's page (or "Sign in to see this
  page", the same answer for every reason a page isn't shown), `/@name/post/<id>` is one Global
  post, `/feed` is the Global feed. Each has a bar with **Sign in** and **Join Purrlor**, and a page
  has **Make your own page**. The page goes through `parseProfilePage` first. Media goes through
  `/api/public/media` (`useMediaUrl` does that when there's no Matrix client). The Top 8 shows
  only friends whose own pages are public, drawn from their page answers; the guestbook says
  "Sign in to read and sign this guestbook": the API doesn't serve entries.
- **Signed in**, the same addresses open inside the app: `/@name` is that person's profile,
  `/feed` the global feed (`useOpenPublicRoute`).
- **The switch** is in Account Settings → Privacy and in the page builder. It writes
  `xyz.nekous.public_web` to the owner's profile room (creating it if they've never posted).
- The composer's Global option says "Anyone on the web can see this, even without signing in".

## API

Under the app's own address, by the deployment's nginx (below). All `GET`, no sign-in, rate
limited per address (pages: bursts of 60, 120 a minute; media: bursts of 200, 600 a minute).

### `GET /api/public/pages/:user`

`:user` is `@name`, `name`, or `@name:server` (this server only). `404 { "code": "not_found" }` for
every reason it isn't shown: no such person, another server, not opted in, no profile room, hidden.

```json
{ "userId": "@luna:purr.example", "displayName": "Luna", "avatarUrl": "mxc://…", "avatarAnimated": false,
  "bannerUrl": "mxc://…", "bio": "…", "page": { "version": 1, "style": { … }, "blocks": [ … ] } }
```

`page` is the stored `xyz.nekous.profile_page` content, or `null` for an opted-in person with no
page built: the client draws a plain profile then. Two things are taken out first: Top 8 friends
whose own page isn't public or who don't follow the owner back, and Mature art pieces. **The client must put it through
`parseProfilePage` before drawing it**, as the signed-in app does; the service only checks it's a
page at all.

### `GET /api/public/feed?before=<ts>&author=<user>`

Global posts, newest first, 20 at a time. `next` is the `before` for the next page. `author`
narrows it to one person (their posts below their page).

```json
{ "posts": [ { "eventId": "$…", "author": "@luna:purr.example", "ts": 1790000000000, "body": "hi :cat:",
               "emotes": [ { "shortcode": "cat", "url": "mxc://…" } ],
               "attachments": [ { "kind": "image", "url": "mxc://…", "mimetype": "image/webp", "w": 800, "h": 600 } ],
               "warning": "spoilers", "sensitive": true, "edited": true,
               "repost": { "kind": "global", "author": "@bob:purr.example", "ts": …, "body": "…" },
               "likes": 3, "comments": 1 } ],
  "authors": { "@luna:purr.example": { "userId": "@luna:purr.example", "avatarUrl": "mxc://…" } },
  "next": 1789999000000 }
```

`repost` is `{ "kind": "hidden" }` for a Space post. Optional fields are left out when empty.

### `GET /api/public/posts/:eventId`

One Global post, the same shape as the feed (`{ "posts": [ … ], "authors": { … } }`), or `404`.

### `GET /api/public/status/:user`

`{ "hidden": true | false, "publicOff": true | false }`: whether an admin hid this person's page, or
switched their public page off. The signed-in app checks `hidden` so a hidden page isn't drawn there
either (its owner is told instead).

### `GET /api/public/media/:server/:mediaId[?width=&height=]`

The file behind `mxc://server/mediaId`, or a thumbnail (up to 1600×1600) with `width` and
`height`. `404` unless it's servable right now:

- A Global post in the latest snapshot names it (its author not hidden), or
- a public page names it in a field the page format has (a background, image, gallery, link emote,
  divider emote, Space avatar, art piece that isn't Mature, or music track), its owner is opted in in the latest
  snapshot, and no admin switched that page off or hid its owner, or
- it's the avatar (or, for a public page, the banner) of someone shown in the last six hours,
- and in every case it isn't on the admin's block list (`purrlor takedown`).

The snapshot is rebuilt every minute, so a deleted post's files, or a page's files after its owner
switches it off, stop being served within a minute; hiding, switching off and blocking are
immediate. Answers carry `Cache-Control: public, max-age=600`, so copies already handed out last at
most ten minutes after a takedown.

Served with `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`; anything that isn't
a picture, video or sound (SVG included) is refused, and sound only of the types a music block
allows. Files over `PUBLIC_MEDIA_MAX_BYTES` (default 100 MiB) are refused, not cut short.

**Sound and video seek.** The homeserver ignores `Range` and sends no length, so the token server
copies a sound or video file into `/data/media-cache` on its first request (refusing it once it
passes the size limit) and answers from the copy, with `Accept-Ranges: bytes`, `206` and
`Content-Range` for a range, `416` past the end. The copies use at most `PUBLIC_MEDIA_CACHE_BYTES`
(default 1 GiB), least recently used go first, a takedown deletes its file's copy at once, and the
folder is emptied when the service starts.

### `GET /api/public/card/:user` and `/api/public/card/post/:eventId`

A tiny HTML page of link-preview tags (`og:title`, `og:image`, `theme-color`…), for the bots that
unfurl links. nginx sends only them here (below); people get the app. A page that isn't public gets
a generic "Sign in to see this page" card, so a preview never confirms an account exists.

## Limits

The feed is read from the room directory's profile rooms (up to 500) and each one's latest 100
events (posts, likes and comments together), refreshed at most once a minute. So the public feed
reaches back that far, and like and comment counts are those within it; signed-in users see
everything. Each request is answered from that snapshot.

## Hiding a page (admins)

A report from **Report this page** goes to the homeserver's admins, like any report. To act on it:

```sh
sudo purrlor pages hide luna     # their page and public posts, gone for signed-out visitors within a minute
sudo purrlor pages unhide luna
sudo purrlor pages list
```

It's a text file in the token server's data volume (`/data/hidden-pages.txt`, one user ID per
line), re-read within ten seconds of a change. Switching a public page off, taking files down,
reading reports and the audit log go through the token server's root-only control socket:
`docs/admin-control.md`.

## Deploying

`deploy/setup.sh` writes all of this; an install from before it needs three additions to its nginx
config (`deploy/nginx/nginx-proxy.conf.example` has them in place):

```nginx
# In the http block (outside any server block): which visitors are link-unfurling bots.
map $http_user_agent $purrlor_unfurl {
    default 0;
    ~*(discordbot|twitterbot|facebookexternalhit|slackbot|telegrambot|whatsapp|linkedinbot|cardyb|bluesky|mastodon|embedly|iframely|redditbot|skypeuripreview|vkshare|pinterest|google-pagerenderer) 1;
}

# In the app's server block:
location /api/public/ {
    proxy_pass http://127.0.0.1:3001/api/public/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location ~ ^/@[^/]+(/post/[^/]+)?$ {
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    if ($purrlor_unfurl) {
        rewrite ^/@[^/]+/post/([^/]+)$ /api/public/card/post/$1 break;
        rewrite ^/@([^/]+)$ /api/public/card/$1 break;
        proxy_pass http://127.0.0.1:3001;
    }
    proxy_pass http://127.0.0.1:8080;
}
```

With nginx on another machine (an edge proxy over WireGuard, say), use this server's private
address in place of `127.0.0.1`. The token server believes `X-Forwarded-For` only from private and
loopback addresses (`TRUST_PROXY` overrides that, in Express's `trust proxy` syntax). Set
`PUBLIC_WEB_URL` in `.env` to the app's address (`https://purr.example`) if previews show the wrong
one; unset, it's taken from each request's `Host`.

The rate limits are per visitor address. If something in front of nginx hides those (a relay that
forwards plain TCP, so every request arrives from the relay's own address), the limits apply to
everyone at once. Set `PUBLIC_WEB_RATE_SCALE` in `.env` to multiply them (20 suits a small
server), then `purrlor restart token-server`. The real fix is a relay that passes visitors'
addresses on (the PROXY protocol, with nginx's `set_real_ip_from`).

Uploads: the bundled homeserver accepts files up to 100 MiB (`MATRIX_MAX_UPLOAD_BYTES` in `.env`),
and nginx's homeserver blocks need the same `client_max_body_size 100M`.
