# What the app keeps on the device

So a room opened again, or the app opened again, doesn't wait on the homeserver (and, for another
server's rooms and media, on federation) for what it already had.

| What | Where | Kept | Code |
|---|---|---|---|
| Rooms, their latest ~50 events, account data | matrix-js-sdk's `IndexedDBStore` (`nekous-sync-store`) | Until sign-out. Written every 5 minutes and whenever the tab is hidden | `matrix/client.ts` |
| Media: thumbnails, avatars, emotes, images, files up to 20 MB (encrypted ones still encrypted) | The service worker's Cache Storage, `purrlor-media-v1` | Until sign-out; the oldest go past 5000 files. Never: range requests (video streaming), whole video or audio files | `public/sw.js` |
| Link previews | IndexedDB `purrlor-device-cache` | 24 hours (an answer of "no preview": 1 hour) | `matrix/hooks/useUrlPreview.ts`, `matrix/deviceCache.ts` |
| Decrypted attachments, resolved media URLs, previews | Memory | The session | `useAttachmentUrl.ts`, `useMediaUrl.ts` |
| Where each room was left, if scrolled up | Memory | The session | `MessageTimeline.tsx` (`roomViews`) |

Signing out and deleting the account delete the media cache and the preview store along with the
SDK's own (`clearDeviceCaches`).

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

## Going back to a room

A room left scrolled up opens again at the same message, with the same history drawn; one left at
the bottom opens at the bottom. Sending a message takes you to the bottom.
