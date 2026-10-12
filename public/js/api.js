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

export const get = (path, query, opts) => api(`${path}${qs(query)}`, opts);
export const post = (path, body, opts) => api(path, { method: 'POST', body: body ?? {}, ...opts });
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
