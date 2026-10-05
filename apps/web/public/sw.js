// Service worker for background push notifications, for receiving shared files, and for signing
// and caching media requests (below). No offline caching of the app itself. The only requests it
// touches are the share target's POST and GETs of the homeserver's media. Registered at app start (main.tsx), since the phone's
// share sheet can open the app before push is ever enabled.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not JSON — show something rather than nothing.
    data = { title: 'Purrlor', body: event.data ? event.data.text() : 'New activity' };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Purrlor', {
      body: data.body || '',
      icon: '/favicon.ico',
      // A reminder brings its own tag, the one an open tab shows it under, so the two replace each
      // other; anything else collapses repeat notifications from the same room.
      tag: data.tag || data.roomId || undefined,
      data: { roomId: data.roomId },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const roomId = event.notification.data?.roomId;

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clientsList[0];
      if (existing) {
        await existing.focus();
        if (roomId) existing.postMessage({ type: 'nekous-open-room', roomId });
        return;
      }
      await self.clients.openWindow(roomId ? `/?openRoom=${encodeURIComponent(roomId)}` : '/');
    })()
  );
});

// Sharing images or video to the installed app (manifest.webmanifest's share_target) is a
// multipart POST, which a static host can't answer. The worker takes the files, keeps them in a
// cache for the page to pick up (matrix/shareFiles.ts has the other half), and sends the browser
// on to the app with the text fields and a count of the files as ordinary query parameters.
const SHARE_PATH = '/share-target';
const SHARE_CACHE = 'purrlor-share';
const MAX_SHARED_FILES = 10;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'POST' || new URL(request.url).pathname !== SHARE_PATH) return;
  event.respondWith(takeShare(request));
});

async function takeShare(request) {
  const target = new URL('./', self.registration.scope);
  try {
    const form = await request.formData();
    for (const name of ['share_title', 'share_text', 'share_url']) {
      const value = form.get(name);
      if (typeof value === 'string' && value) target.searchParams.set(name, value);
    }
    const files = form
      .getAll('share_media')
      .filter((f) => typeof f !== 'string' && /^(image|video)\//.test(f.type))
      .slice(0, MAX_SHARED_FILES);
    await caches.delete(SHARE_CACHE);
    if (files.length) {
      const cache = await caches.open(SHARE_CACHE);
      await Promise.all(
        files.map((file, i) =>
          cache.put(
            `/share-target/files/${i}`,
            new Response(file, { headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) } })
          )
        )
      );
      target.searchParams.set('share_files', String(files.length));
    }
  } catch {
    // Nothing usable arrived: open the app as it is.
  }
  return Response.redirect(target.href, 303);
}

// Media: the homeserver wants an access token on every media request, which an <img>, <video> or
// <audio> can't send, so the page used to fetch each file whole into a blob before showing any
// of it. The worker adds the token instead (matrix/mediaWorker.ts has the page's half), and the
// page can point those elements straight at the media URL: video streams, images are cached and
// load lazily. The token isn't kept here: each request asks the page that made it, and it goes
// only to that page's homeserver, only on its media endpoints, never anywhere else.
const MEDIA_WORKER_VERSION = 1;
const MEDIA_PATH = /^\/_matrix\/client\/v1\/media\/(download|thumbnail)\//;
const TOKEN_TIMEOUT_MS = 3000;

self.addEventListener('message', (event) => {
  if (event.data?.type === 'purrlor-media-ping') event.ports[0]?.postMessage({ version: MEDIA_WORKER_VERSION });
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('Authorization') || !event.clientId) return;
  if (!MEDIA_PATH.test(new URL(request.url).pathname)) return;
  event.respondWith(signedMedia(request, event.clientId, event));
});

async function askForToken(clientId) {
  const client = await self.clients.get(clientId);
  if (!client) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), TOKEN_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    client.postMessage({ type: 'purrlor-media-token' }, [channel.port2]);
  });
}

// What was fetched once is kept on the device: a media ID's bytes never change, so a cached copy is
// good forever, and a room opened again (or the app opened again) shows its images, thumbnails
// and avatars from disk without asking the page for the token or the homeserver for anything.
// Another server's media is the slowest to arrive (it crosses federation first), and is cached
// the same way. Not kept: a range request (a video streaming or seeking), a whole video or audio
// file, or anything larger than MEDIA_CACHE_MAX_BYTES. An encrypted attachment is kept as it
// arrived, still encrypted: the page decrypts it each time. Signing out deletes the cache
// (matrix/deviceCache.ts).
const MEDIA_CACHE = 'purrlor-media-v1';
const MEDIA_CACHE_MAX_ENTRIES = 5000;
const MEDIA_CACHE_MAX_BYTES = 20 * 1024 * 1024;
/** The cache is trimmed (oldest first) once every this many additions. */
const TRIM_EVERY = 100;
let addedSinceTrim = 0;

function cacheable(request, response) {
  if (request.headers.get('Range') || response.status !== 200) return false;
  const type = response.headers.get('Content-Type') || '';
  if (/^(video|audio)\//.test(type)) return false;
  const length = Number(response.headers.get('Content-Length'));
  // Without a length (a streamed thumbnail) only a thumbnail is kept: they're small.
  if (!length) return isThumbnail(request.url);
  return length <= MEDIA_CACHE_MAX_BYTES;
}

function isThumbnail(url) {
  return new URL(url).pathname.includes('/media/thumbnail/');
}

async function trimMediaCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MEDIA_CACHE_MAX_ENTRIES;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

async function rememberMedia(url, response) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(url, response);
    if (++addedSinceTrim >= TRIM_EVERY) {
      addedSinceTrim = 0;
      await trimMediaCache(cache);
    }
  } catch {
    // Out of space, or the response was cut off (the image left the page): just not kept.
  }
}

async function signedMedia(request, clientId, event) {
  if (!request.headers.get('Range')) {
    const hit = await caches.match(request.url, { cacheName: MEDIA_CACHE }).catch(() => undefined);
    if (hit) return hit;
  }
  const auth = await askForToken(clientId).catch(() => null);
  const url = new URL(request.url);
  let homeserver = null;
  try {
    homeserver = auth?.homeserver ? new URL(auth.homeserver).origin : null;
  } catch {
    homeserver = null;
  }
  if (!auth?.token || homeserver !== url.origin) return fetch(request);
  const headers = new Headers();
  // A video's seeks and its first bytes are range requests: keep them.
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);
  headers.set('Authorization', `Bearer ${auth.token}`);
  // 'only-if-cached' is allowed on same-origin requests only, and this one goes to the homeserver.
  const cache = request.cache === 'only-if-cached' ? 'default' : request.cache;
  const response = await fetch(request.url, { headers, mode: 'cors', credentials: 'omit', cache, signal: request.signal });
  if (cacheable(request, response)) event.waitUntil(rememberMedia(request.url, response.clone()));
  return response;
}
