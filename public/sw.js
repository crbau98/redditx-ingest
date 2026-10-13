/* PRISM offline shell.
 * Network-first for the app's own static files with a cached fallback, so the UI
 * always loads fresh when online and still opens (showing its own error states)
 * when offline. API calls, media and admin traffic are NEVER cached: adult
 * content must not linger in a shared device cache. */
const VERSION = 'prism-shell-v4.9';
const SHELL = ['/', '/css/app.css', '/css/admin.css', '/css/ux.css', '/js/main.js', '/favicon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/demo/')) return; // never cached

  // Versioned assets (/v/<hash>/…) never change: serve from cache first, fill it on a miss.
  if (url.pathname.startsWith('/v/')) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        const prefix = url.pathname.split('/').slice(0, 3).join('/'); // "/v/<hash>"
        caches.open(VERSION).then(async (c) => {
          await c.put(req, copy);
          // a new deploy's assets replace the previous deploy's: drop other versions
          for (const k of await c.keys()) { const p = new URL(k.url).pathname; if (p.startsWith('/v/') && !p.startsWith(`${prefix}/`)) c.delete(k); }
        }).catch(() => {});
      }
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && (req.mode === 'navigate' || /^\/(css|js|vendor|v)\/|^\/(favicon\.svg|manifest\.webmanifest)$/.test(url.pathname))) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const cached = await caches.match(req.mode === 'navigate' ? '/' : req);
      if (cached) return cached;
      throw err;
    }
  })());
});
