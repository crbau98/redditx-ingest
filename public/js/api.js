import { adminSession } from './store.js';

export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

let ageHandler = null;
export const onAgeRequired = (fn) => { ageHandler = fn; };

export function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

export async function api(path, { method = 'GET', body, admin = false, signal } = {}, retried = false) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (admin && adminSession.key) headers['x-admin-key'] = adminSession.key;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal, credentials: 'same-origin' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Network error — is the server reachable?', 0, 'network');
  }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    if (res.status === 403 && data && data.code === 'age_gate' && ageHandler && !retried) {
      await ageHandler();
      return api(path, { method, body, admin, signal }, true);
    }
    throw new ApiError((data && data.error) || res.statusText || 'Request failed', res.status, data && data.code);
  }
  return data;
}

/*
 * Public GETs share a short-lived in-memory cache with in-flight de-duplication: going back to a
 * page, re-opening a profile or a hover prefetch followed by the click all reuse one response
 * instead of waiting on the network again. Each caller gets its own copy (callers may mutate).
 * Any write (POST) clears it, so likes/saves are never shown stale.
 */
const CACHE_MS = 30000;
const cache = new Map(); // url -> { at, promise }
const noCache = /^\/api\/(stream|admin|age|health)/;
export function get(path, query, opts) {
  const url = `${path}${qs(query)}`;
  if ((opts && (opts.signal || opts.fresh)) || noCache.test(path)) return api(url, opts);
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise.then((d) => structuredClone(d));
  const promise = api(url, opts);
  cache.set(url, { at: Date.now(), promise });
  if (cache.size > 250) cache.delete(cache.keys().next().value);
  promise.catch(() => { if (cache.get(url) && cache.get(url).promise === promise) cache.delete(url); });
  return promise.then((d) => structuredClone(d));
}
/**
 * A read that carries its question in a POST body (a follow list does not fit in a URL). Shares
 * the GET cache, and unlike `post` it never clears it: nothing on the server changes.
 */
export function query(path, body, opts) {
  const key = `POST ${path} ${JSON.stringify(body ?? {})}`;
  const run = () => api(path, { method: 'POST', body: body ?? {}, ...opts });
  if (opts && (opts.signal || opts.fresh)) return run();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise.then((d) => structuredClone(d));
  const promise = run();
  cache.set(key, { at: Date.now(), promise });
  if (cache.size > 250) cache.delete(cache.keys().next().value);
  promise.catch(() => { if (cache.get(key) && cache.get(key).promise === promise) cache.delete(key); });
  return promise.then((d) => structuredClone(d));
}
/** Warm the cache for a likely next request (hover, idle time). Errors are ignored. */
export function prefetch(path, query) { get(path, query).catch(() => {}); }
export function clearApiCache() { cache.clear(); }
// View pings and broken-media reports change nothing anyone sees; every other write may.
export const post = (path, body, opts) => { if (!/\/(view|broken)$/.test(path)) cache.clear(); return api(path, { method: 'POST', body: body ?? {}, ...opts }); };

/**
 * Tell the server an item failed to load here (once per item per page session). The server only
 * re-checks it at the source; nothing is hidden on a viewer's word.
 */
const reported = new Set();
export function reportBroken(id) {
  if (!id || reported.has(id)) return;
  reported.add(id);
  post(`/api/media/${id}/broken`).catch(() => {});
}
export const adminGet = (path, query) => api(`/api/admin${path}${qs(query)}`, { admin: true });
export const adminPost = (path, body) => api(`/api/admin${path}`, { method: 'POST', body: body ?? {}, admin: true });
export const adminPatch = (path, body) => api(`/api/admin${path}`, { method: 'PATCH', body: body ?? {}, admin: true });
export const adminPut = (path, body) => api(`/api/admin${path}`, { method: 'PUT', body: body ?? {}, admin: true });
export const adminDelete = (path) => api(`/api/admin${path}`, { method: 'DELETE', admin: true });

/** Public "new content" pings (EventSource reconnects on its own). */
export function streamPublic(onEvent) {
  if (!('EventSource' in window)) return { close() {} };
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* ignore */ } };
  return { close: () => es.close() };
}

/** Admin SSE over fetch (EventSource cannot send the admin key header). */
export function streamAdmin(onEvent) {
  const ctrl = new AbortController();
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const res = await fetch('/api/admin/stream', { headers: { 'x-admin-key': adminSession.key }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
          }
        }
      } catch (e) { if (stopped || e.name === 'AbortError') return; }
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
  return { close: () => { stopped = true; ctrl.abort(); } };
}
