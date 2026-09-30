// Service worker for background push notifications only — no offline caching, no asset
// interception. Registered on demand by matrix/push.ts when a user enables background
// notifications, not on every page load.

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
