const CACHE = 'alcoach-v3';
const SHELL = ['/', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Pages and forms are always live (queue state changes constantly); cache only static assets.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isStatic = url.pathname === '/style.css' || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest';
  if (e.request.method === 'GET' && isStatic) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return resp;
      }))
    );
    return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match('/')));
});

self.addEventListener('push', (e) => {
  e.waitUntil(self.registration.showNotification('الكوتش', {
    body: 'عندك زبون جديد في الدور 🔔',
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    tag: 'new-customer', renotify: true, vibrate: [300, 150, 300], dir: 'rtl', lang: 'ar',
    data: { url: '/dashboard' }
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.navigate('/dashboard'); return c.focus(); } }
    return clients.openWindow('/dashboard');
  }));
});
