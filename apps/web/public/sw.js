// Service worker for background push notifications and for receiving shared files. No offline
// caching, and the only request it touches is the share target's POST (below). Registered at app
// start (main.tsx), since the phone's share sheet can open the app before push is ever enabled.

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
