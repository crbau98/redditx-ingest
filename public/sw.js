/* PRISM service worker: installable shell, offline fallback, and short-lived read caches.
 *
 *   shell      cache-first. The shell is "/" plus the content-hashed /v/<hash>/… files it names; install fetches them
 *              all, so the app opens offline after the first visit. A deploy changes the hash, which replaces the
 *              old files. Bump VERSION whenever this file or a SHELL file changes in a way the hash does not cover.
 *   navigation network first (fresh HTML after a deploy), but gives up after NAV_TIMEOUT_MS on a bad connection and
 *              shows the cached shell; with nothing cached it shows /offline.html.
 *   api        public GET reads: stale-while-revalidate. A copy younger than API_FRESH_MS is served at once and
 *              refreshed behind it; an older one is tried against the network first and is only served when that
 *              fails (offline). Any write (POST/PUT/PATCH/DELETE) empties it, like the app's own memory cache.
 *   images     /api/proxy pictures: cache-first, newest IMG_MAX kept. Video, HLS, ranges, admin, SSE: never cached.
 *
 * The api and image caches are OPT-IN and off by default: they would keep adult content on the device, which the previous
 * worker deliberately never did. The page tells the worker with {type:'prism-offline-content', on:true|false} (Display >
 * "Keep what I browse for offline use"); the choice is remembered in a tiny cache entry, and turning it off deletes both
 * caches. The shell, the offline page and the install icons hold no content and are always cached.
 *
 * Everything is same-origin and capped, and the caches hold only what this device already showed. Posting
 * {type:'prism-clear-caches'} to the worker (the app does on "Clear history") empties them all. */
const VERSION = 'prism-shell-v13';
const API_CACHE = 'prism-api-v1';
const IMG_CACHE = 'prism-img-v1';
const FLAGS_CACHE = 'prism-flags-v1';
const OFFLINE_FLAG = '/__prism/offline-content';
const SHELL = ['/', '/offline.html', '/offline.js', '/css/tokens.css', '/css/app.css', '/css/ux.css', '/css/v6.css', '/css/aurora.css', '/js/main.js', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];
const API_FRESH_MS = 60 * 1000;
const API_STALE_MS = 24 * 60 * 60 * 1000; // an offline answer older than a day is worse than the offline state
const API_MAX = 80;
const IMG_MAX = 150;
const NAV_TIMEOUT_MS = 4000;
const NEVER_API = /^\/api\/(admin|stream|age|health|hls|proxy|lookup|ai)(\/|$|\?)/; // proxy is handled as images
const NETWORK_FIRST_API = /^\/api\/meta(\?|$)/; // carries "age verified": never served from a copy while online
const CACHED_AT = 'x-prism-cached-at';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    // the hashed files the shell names (bundle.css, every module): what makes the first offline start work
    try {
      const html = await (await c.match('/')).text();
      const urls = [...new Set([...html.matchAll(/(?:href|src)="(\/v\/[^"]+)"/g)].map((m) => m[1]))];
      await Promise.all(urls.map((u) => c.add(u).catch(() => {})));
    } catch { /* online later: the fetch handler fills the rest */ }
    await self.skipWaiting();
  })());
});

/** Is "keep what I browse for offline use" on? null = not read yet since this worker started. */
let offlineContent = null;
async function offlineContentOn() {
  if (offlineContent === null) offlineContent = !!(await caches.match(OFFLINE_FLAG, { cacheName: FLAGS_CACHE }));
  return offlineContent;
}

self.addEventListener('activate', (event) => {
  const keep = new Set([VERSION, API_CACHE, IMG_CACHE, FLAGS_CACHE]);
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  const d = event.data;
  if (!d) return;
  if (d.type === 'prism-clear-caches') event.waitUntil(Promise.all([caches.delete(API_CACHE), caches.delete(IMG_CACHE)]));
  if (d.type === 'prism-offline-content') {
    offlineContent = !!d.on;
    event.waitUntil((async () => {
      if (offlineContent) await (await caches.open(FLAGS_CACHE)).put(OFFLINE_FLAG, new Response('1'));
      else await Promise.all([caches.delete(FLAGS_CACHE), caches.delete(API_CACHE), caches.delete(IMG_CACHE)]);
    })());
  }
});

/** Keep a cache to `max` entries, dropping the oldest (insertion order). */
async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/** A copy of `res` that remembers when it was stored. */
async function stamp(res) {
  const headers = new Headers(res.headers);
  headers.set(CACHED_AT, String(Date.now()));
  return new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers });
}
const age = (res) => Date.now() - Number(res.headers.get(CACHED_AT) || 0);

async function apiRequest(req, event) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(req);
  const refresh = () => fetch(req).then(async (res) => {
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) { cache.put(req, await stamp(res)).then(() => trim(cache, API_MAX)).catch(() => {}); }
    return res;
  });
  if (cached && age(cached) < API_STALE_MS && !NETWORK_FIRST_API.test(new URL(req.url).pathname + new URL(req.url).search)) {
    if (age(cached) < API_FRESH_MS) { event.waitUntil(refresh().catch(() => {})); return cached; }
  }
  try { return await refresh(); } catch (err) {
    if (cached && age(cached) < API_STALE_MS) return cached; // offline: the last answer beats an error
    throw err;
  }
}

async function imageRequest(req) {
  const cache = await caches.open(IMG_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200 && (res.headers.get('content-type') || '').startsWith('image/')) cache.put(req, res.clone()).then(() => trim(cache, IMG_MAX)).catch(() => {});
  return res;
}

async function navigation(req) {
  const shell = () => caches.match('/', { cacheName: VERSION });
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), NAV_TIMEOUT_MS))]);
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('/', copy)).catch(() => {}); }
    return res;
  } catch {
    return (await shell()) || (await caches.match('/offline.html', { cacheName: VERSION })) || Response.error();
  }
}

/* Push alerts: one notification per message. The server sends only a title, a generic body and a
 * creator URL, so a lock screen never shows explicit text. Clicking focuses an open PRISM tab. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = String(data.title || 'PRISM');
  const options = {
    body: String(data.body || 'Tap to see the new post.'),
    icon: data.icon || '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'prism-new',
    renotify: false,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin)) {
        await client.focus();
        if ('navigate' in client) await client.navigate(url).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') { if (url.pathname.startsWith('/api/')) event.waitUntil(caches.delete(API_CACHE)); return; } // a write: reads may be stale now
  if (url.pathname.startsWith('/demo/') || req.headers.has('range') || req.destination === 'video' || req.destination === 'audio') return;
  if ((req.headers.get('accept') || '').includes('text/event-stream')) return;

  if (url.pathname === '/api/proxy') { // pictures only; the proxy also carries video bytes
    if (req.destination === 'image' && offlineContent !== false) event.respondWith((async () => ((await offlineContentOn()) ? imageRequest(req) : fetch(req)))());
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (NEVER_API.test(url.pathname + url.search)) return;
    if (offlineContent !== false) event.respondWith((async () => ((await offlineContentOn()) ? apiRequest(req, event) : fetch(req)))()); // off (the default): the browser's own fetch
    return;
  }

  if (req.mode === 'navigate') { event.respondWith(navigation(req)); return; }

  // Versioned assets (/v/<hash>/…) never change: cache first, fill on a miss, drop other deploys' copies.
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
          for (const k of await c.keys()) { const p = new URL(k.url).pathname; if (p.startsWith('/v/') && !p.startsWith(`${prefix}/`)) c.delete(k); }
        }).catch(() => {});
      }
      return res;
    })());
    return;
  }

  // Other static files (fonts, icons, vendor, manifest, unversioned css/js): cache first when we have it, refreshed
  // behind the answer, so the next visit is current. Not cached when it is not one of ours.
  if (/^\/(css|js|vendor|fonts|icons)\/|^\/(favicon\.svg|manifest\.webmanifest|offline\.(html|js))$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req, { cacheName: VERSION });
      const net = fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {}); } return res; });
      if (cached) { event.waitUntil(net.catch(() => {})); return cached; }
      return net;
    })());
  }
});
