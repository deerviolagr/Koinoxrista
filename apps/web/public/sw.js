/* PolykatoikiaOS minimal hand-rolled service worker (no @angular/service-worker). */
const CACHE_PREFIX = 'polyos-';
const CACHE = `${CACHE_PREFIX}v2`;
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    // Network-first keeps deep links fresh; the app shell is the offline fallback.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches
              .open(CACHE)
              .then((cache) => cache.put('/index.html', copy));
          }
          return response;
        })
        .catch(
          async () => (await caches.match('/index.html')) || Response.error(),
        ),
    );
    return;
  }

  // Stale-while-revalidate for same-origin static assets.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached || Response.error());
      return cached || network;
    }),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'PolykatoikiaOS', {
      body: payload.body || '',
      icon: '/icons/icon.svg',
      badge: '/icons/icon-maskable.svg',
      data: {
        linkPath: safeNotificationPath(payload.linkPath || payload.url || '/'),
      },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const linkPath = safeNotificationPath(event.notification.data?.linkPath);
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((client) => {
          try {
            return new URL(client.url).origin === self.location.origin;
          } catch {
            return false;
          }
        });
        if (existing) {
          existing.postMessage({ type: 'NAVIGATE', url: linkPath });
          return existing.focus();
        }
        return self.clients.openWindow(linkPath);
      }),
  );
});

function safeNotificationPath(value) {
  try {
    const url = new URL(String(value || '/'), self.location.origin);
    if (url.origin !== self.location.origin) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
