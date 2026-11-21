self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch {}
  const title = payload.title || 'Netrue website activity';
  const options = {
    body: payload.body || 'There is a new activity to review.',
    icon: '/icons/netrue-192.png',
    badge: '/icons/netrue-192.png',
    tag: payload.tag || 'netrue-activity',
    data: { url: typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/admin' },
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || '/admin', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin && new URL(client.url).pathname.startsWith('/admin'));
    if (existing) { existing.navigate(destination); return existing.focus(); }
    return self.clients.openWindow(destination);
  }));
});
