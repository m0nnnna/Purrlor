# What the app keeps on the device

So a room opened again, or the app opened again, doesn't wait on the homeserver (and, for another
server's rooms and media, on federation) for what it already had.

| What | Where | Kept | Code |
|---|---|---|---|
| Rooms, their latest ~50 events, account data | matrix-js-sdk's `IndexedDBStore` (`nekous-sync-store`) | Until sign-out. Written every 5 minutes and whenever the tab is hidden | `matrix/client.ts` |
| Media: thumbnails, avatars, emotes, images, files up to 20 MB (encrypted ones still encrypted) | The service worker's Cache Storage, `purrlor-media-v1` | Until sign-out; the oldest go past 5000 files. Never: range requests (video streaming), whole video or audio files | `public/sw.js` |
| Link previews | IndexedDB `purrlor-device-cache` | 24 hours (an answer of "no preview": 1 hour) | `matrix/hooks/useUrlPreview.ts`, `matrix/deviceCache.ts` |
| The feed's last timeline, and each profile's: up to 300 posts, every feed it reads and how far each was read, edits; never an encrypted post | IndexedDB `purrlor-device-cache`, and memory | A week | `matrix/feedSnapshot.ts`, `useGlobalFeed` |
| A post's likes, reposts and newest comments | IndexedDB `purrlor-device-cache`, and memory | A day; not asked again for 3 minutes | `matrix/hooks/usePostInteractions.ts` |
| Profile pages | IndexedDB `purrlor-device-cache`, and memory | A week; not asked again for 10 minutes | `matrix/hooks/useProfilePage.ts` |
| Extended profiles (bio, banner, where someone's posts live) | IndexedDB `purrlor-device-cache`, and memory | A week; shown at once, asked again after 5 minutes (where posts live: a day). Your own changes forget your own | `matrix/extendedProfile.ts` |
| A peer's room directory (read over federation) | IndexedDB `purrlor-device-cache`, and memory | Used as is for 5 minutes, then shown while a fresh one is read, up to a day | `listPeerDirectory` in `matrix/globalFeed.ts` |
| Decrypted attachments, resolved media URLs, previews | Memory | The session | `useAttachmentUrl.ts`, `useMediaUrl.ts` |
| Where each room was left, if scrolled up | Memory | The session | `MessageTimeline.tsx` (`roomViews`) |

Signing out and deleting the account delete the media cache and the preview store along with the
SDK's own (`clearDeviceCaches`). Expired entries in the store are swept once a session.

## Media

A media ID's bytes never change, so the worker answers a cached request from disk without asking
the page for the access token or the homeserver for anything. Everything that shows media points
at the media URL itself (the worker signs it, `matrix/mediaWorker.ts`) rather than at a blob
fetched by the page, so it all goes through this cache. The exception is something the worker
can't sign for, such as the system's media controls loading a track's artwork (`useMediaUrl`'s
`blob` option).

## Thumbnails

The homeserver makes thumbnails in five sizes only (32×32 and 96×96 cropped; 320×240, 640×480
and 800×600 scaled: Continuwuity's, and Synapse's defaults) and answers any request with the first
that fits it, or the whole original past 800×600. The app asks for exactly those sizes
(`matrix/thumbnails.ts`), so one thumbnail has one URL wherever it's shown, and is made once and
cached once; an image in a message asks for 800×600 rather than the 720×640 that used to bring the
whole original.

The edge nginx gives media a year's `Cache-Control` (`deploy/edge/purr.meowops.net.conf`,
`deploy/setup.sh`): Continuwuity sends none, so without the app's own cache the browser fetched
every thumbnail and avatar again on each visit to a channel.

## Ahead of time

After start, the most recently active rooms (60, three at a time) have their history filled to a
screenful (`matrix/historyPrefetch.ts`), and their newest images and senders' avatars put in the
media cache at the exact URLs the timeline will ask for (`matrix/mediaWarm.ts`). Resting the
pointer on a channel does the same for it. Another server's media is the slowest to arrive the
first time; this moves that wait out of the way.

## Posts and federated content

Gathering the feed is the app's slowest read: this server's directory and every peer's (over
federation, several pages each), then a `/state` and a `/messages` for every Space and profile in
it, each followed person's extended profile (their own server's answer, over federation for a
peer's), then each post card's likes and comments. None of it syncs, so none of it is in the SDK's
store. It used to be read again from nothing on every visit and every profile opened.

Now what was read last time is shown at once, and only what may have changed is asked for:

- **The timeline** (`matrix/feedSnapshot.ts`). The feed and each profile keep the posts they last
  showed, every feed they read and how far each was read. Opened again, in this session or a new
  one, the posts are there on the first paint, and then:
  - the **list of feeds** (directory, peers' directories, every Space's and profile's state) is used
    as it is if it was gathered in the last 15 minutes, and gathered again otherwise;
  - each **feed** kept from a load in the last 6 hours is asked only for its newest 10 posts, which
    also brings in edits and drops deleted ones; one read in the last 30 seconds isn't asked at all.
    A feed with 10 new posts (there may be more), one whose kept posts don't reach where its older
    posts carry on, and any feed not kept, is read from the top as before;
  - older than 6 hours, everything is read again, which also catches deletions further back.

  The refresh button always reads everything again. A profile reads only that person's feeds, and
  starts from the feed's own posts by them when it has none of its own yet. Encrypted posts are
  never written to the device (their feed is read from the top next time).
- **Likes and comments.** A card shows what it had last time, and asks again only once that's three
  minutes old. A feed room you're in updates them live anyway.
- **Profile pages.** Drawn at once from the last read; one you aren't in is asked again after ten
  minutes, or after your own publish. A peer's person's kept page is used only while their instance
  is still an approved peer.
- **Extended profiles.** Shown at once from the last read and asked again after five minutes; where
  someone's posts live is trusted for a day (a room that turns out not to be theirs is asked again).
  When their server doesn't answer, what was read last time is used.
- **Peers' directories.** Kept on the device and used for five minutes as they are; after that, a
  copy up to a day old is used at once while a fresh one is read for next time. Only approved peers'
  directories are ever used.
- **Post media.** Pictures in posts and their authors' avatars go through the service worker's cache
  like a channel's. The newest 20 posts' pictures (at the size `PostMedia` asks for) and avatars are
  fetched ahead once the feed or a profile loads (`warmPostMedia`), nothing behind a content warning
  or marked sensitive.

## What the browser keeps

The web container's nginx (`apps/web/deploy/nginx.conf`) tells the browser, and the desktop app's
WebView2 (which keeps its cache in `%LOCALAPPDATA%\Purrlor` between runs), what it may keep:

| What | Cache-Control | So |
|---|---|---|
| `/assets/` (the build's scripts and styles, named by their contents) | `public, max-age=31536000, immutable` | Never downloaded twice. A missing one is a 404, never `index.html` |
| `index.html` (every app address), `sw.js`, `global-shim.js`, the manifest | `no-cache` | Kept, but checked on each load (a 304 when nothing changed), so a deploy shows at once |
| Icons | `public, max-age=604800` | A week |
| `/config.json` | `no-store` | Never kept |

Text is gzipped. Media keeps the edge nginx's year-long `private` header (above), and the token
server's public answers carry their own short `max-age`.

## Going back to a room

A room left scrolled up opens again at the same message, with the same history drawn; one left at
the bottom opens at the bottom. Sending a message takes you to the bottom.
