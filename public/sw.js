/* PRISM offline shell.
 * Network-first for the app's own static files with a cached fallback, so the UI
 * always loads fresh when online and still opens (showing its own error states)
 * when offline. API calls, media and admin traffic are NEVER cached: adult
 * content must not linger in a shared device cache. */
const VERSION = 'prism-shell-v4.6';
const SHELL = ['/', '/css/app.css', '/css/admin.css', '/js/main.js', '/favicon.svg', '/manifest.webmanifest'];

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

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && (req.mode === 'navigate' || /^\/(css|js|vendor)\/|^\/(favicon\.svg|manifest\.webmanifest)$/.test(url.pathname))) {
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
