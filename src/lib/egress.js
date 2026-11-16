'use strict';
/**
 * Bytes the media proxy (routes/proxy.js) sends to viewers, per UTC day, split by kind (image / video / hls / other) and by
 * the media cache (HIT = served from our disk cache, MISS = relayed from the origin, so we paid ingress for it too).
 * Counting only: nothing about proxying changes. Kept for KEEP_DAYS days, saved to settings every few minutes so a deploy
 * loses at most that window. Shown in GET /api/admin/engine as `egress`.
 */
const KEEP_DAYS = 14;
const SAVE_MS = 5 * 60 * 1000;
const KEY = 'proxy_egress';
const KINDS = ['image', 'video', 'hls', 'other'];

let days = null; // { 'YYYY-MM-DD': { image: { hit: {bytes, n}, miss: {bytes, n} }, ... } }
let dirty = false;
let timer = null;

const repo = () => require('../db/repo');
function load() {
  if (days) return days;
  days = {};
  try { const saved = JSON.parse(repo().settings.get(KEY) || '{}'); if (saved && typeof saved === 'object') days = saved; } catch { days = {}; }
  return days;
}
function save() {
  if (!dirty || !days) return;
  dirty = false;
  try { repo().settings.set(KEY, JSON.stringify(days)); } catch { /* a failed save is retried at the next one */ }
}
const empty = () => Object.fromEntries(KINDS.map((k) => [k, { hit: { bytes: 0, n: 0 }, miss: { bytes: 0, n: 0 } }]));

/** One finished response. kind: image | video | hls | other; cache: 'hit' | 'miss'. */
function record(kind, cache, bytes, now = Date.now()) {
  if (!(bytes > 0)) return;
  load();
  const day = new Date(now).toISOString().slice(0, 10);
  const d = days[day] || (days[day] = empty());
  const slot = (d[KINDS.includes(kind) ? kind : 'other'] || (d[kind] = empty().other))[cache === 'hit' ? 'hit' : 'miss'];
  slot.bytes += bytes; slot.n++;
  for (const old of Object.keys(days).sort().slice(0, -KEEP_DAYS)) delete days[old];
  dirty = true;
  if (!timer) { timer = setInterval(save, SAVE_MS); if (timer.unref) timer.unref(); }
}

/** Per day, newest first, with totals: { days: [{ day, total, image: {hit, miss}, ... }], today }. Bytes. */
function summary() {
  load();
  const out = Object.keys(days).sort().reverse().map((day) => {
    const d = days[day];
    const row = { day, total: 0, hit: 0, miss: 0 };
    for (const k of KINDS) {
      const v = d[k] || empty().other;
      row[k] = { hit: v.hit.bytes, miss: v.miss.bytes, requests: v.hit.n + v.miss.n };
      row.hit += v.hit.bytes; row.miss += v.miss.bytes; row.total += v.hit.bytes + v.miss.bytes;
    }
    return row;
  });
  return { days: out, today: out[0] && out[0].day === new Date().toISOString().slice(0, 10) ? out[0] : null };
}

module.exports = { record, summary, save, _reset: () => { days = {}; dirty = false; } };
