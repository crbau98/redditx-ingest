'use strict';
/**
 * Thumbnails and tints (v5 E, schema v10).
 *
 * Grids used to load every picture at full size through the proxy. In the background, newest first, each published item's
 * picture (a photo itself, or a video's poster frame) is read once and gets:
 *   - thumb_url: a ~360px-wide WebP kept in the object store (only when a store is configured and the original is larger);
 *   - tint: its dominant colour, '#rrggbb', for the placeholder shown while the picture loads.
 * An item with no readable picture gets tint '' so it is not tried again. Settings → Sources: thumbnails, thumbnailsPerMinute.
 */
const repo = require('../db/repo');
const net = require('../lib/net');
const store = require('../lib/objectstore');
const settingsStore = require('../settings');
const events = require('./events');
const { imageUrlOf } = require('../lib/imagefilter');

const WIDTH = 360;
const MAX_BYTES = 15 * 1024 * 1024;
let sharpMod;
function sharp() { if (sharpMod === undefined) { try { sharpMod = require('sharp'); } catch { sharpMod = null; } } return sharpMod; }

// An item whose picture cannot be read right now (a dead host answering 5xx, a timeout) used to stay at the head of this
// newest-first queue and be retried every minute for ever: with `thumbnailsPerMinute` of them, nothing behind them was ever
// served. They now wait (4, 8, 16 min) and are given up on (tint '' = unreadable) after MAX_TRIES. State is in memory: a
// restart simply starts counting again.
const MAX_TRIES = 4;
const RETRY_BASE_MS = 2 * 60 * 1000;
const retry = new Map(); // id -> { tries, until }

const q = {
  todo: repo.db.prepare(`SELECT id, media_type, media_url, preview_url, thumbnail_url, width, height FROM media
    WHERE tint IS NULL AND publish_state = 'published' ORDER BY seq DESC LIMIT ?`),
  // @w/@h only come for a picture (never a video: its poster is not its size) and only fill a size that is missing; a size a source
  // reported is never replaced
  save: repo.db.prepare(`UPDATE media SET tint = @tint, thumb_url = COALESCE(@thumb_url, thumb_url),
    width = CASE WHEN @w IS NOT NULL AND (width IS NULL OR width <= 0 OR height IS NULL OR height <= 0) THEN @w ELSE width END,
    height = CASE WHEN @h IS NOT NULL AND (width IS NULL OR width <= 0 OR height IS NULL OR height <= 0) THEN @h ELSE height END
    WHERE id = @id`),
  left: repo.db.prepare("SELECT COUNT(*) AS n FROM media WHERE tint IS NULL AND publish_state = 'published'"),
};

const hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/**
 * Thumbnail and tint for one picture buffer.
 * @returns {Promise<{tint: string, thumb: Buffer|null}>}
 */
async function render(buf, { width = null, keepThumb = true } = {}) {
  const sh = sharp();
  if (!sh) throw new Error('sharp is not installed');
  const img = sh(buf, { failOn: 'none' }).rotate();
  const small = await img.resize({ width: WIDTH, height: WIDTH * 2, fit: 'inside', withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
  const { dominant } = await sh(small).stats();
  const tint = `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
  // a picture already about thumbnail size is served as it is
  const meta = await sh(buf, { failOn: 'none' }).metadata().catch(() => ({}));
  const w = meta.width || width || 0;
  // EXIF orientation 5-8 turns the picture on its side: the size that matters is the displayed one
  const turned = meta.orientation >= 5;
  const size = meta.width && meta.height ? (turned ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height }) : null;
  return { tint, thumb: keepThumb && w > WIDTH * 1.4 ? small : null, size };
}

/** One item. Never throws; returns what was saved. */
async function make(row, { fetch = net.fetchBuffer } = {}) {
  const url = imageUrlOf({ mediaType: row.media_type, mediaUrl: row.media_url, previewUrl: row.preview_url, thumbnailUrl: row.thumbnail_url });
  let out = { tint: '', thumb_url: null, w: null, h: null };
  if (url) {
    try {
      const got = await fetch(url, { headers: { accept: 'image/avif,image/webp,image/*;q=0.8' }, timeout: 12000, maxBytes: MAX_BYTES, retries: 0 });
      if (got.status >= 400) throw new Error(`http ${got.status}`);
      const r = await render(got.buffer, { width: row.width, keepThumb: !!store.kind() });
      out.tint = r.tint;
      if (row.media_type === 'image' && r.size) { out.w = r.size.width; out.h = r.size.height; }
      if (r.thumb) {
        const key = `th/${row.id.slice(0, 2)}/${row.id}.webp`;
        const saved = await store.put(key, r.thumb, 'image/webp');
        out.thumb_url = saved.url;
      }
    } catch (e) {
      // a passing error (timeout, 5xx, rate limit) leaves the item for a later round; a picture that cannot be read is marked
      if (!/^http 4(?!29)\d\d$|unsupported image|Input buffer|corrupt|bad seek/i.test(String(e.message || e))) {
        // remember how it failed (sweep tells "the network is down" from "this host is dead" with it)
        row.failure = { http: /^http \d{3}$/i.test(String(e.message || e)), host: (() => { try { return new URL(url).hostname; } catch { return ''; } })() };
        return null;
      }
    }
  }
  q.save.run({ id: row.id, tint: out.tint, thumb_url: out.thumb_url, w: out.w, h: out.h });
  return out;
}

/**
 * One round: up to `limit` items, newest first, `concurrency` pictures in flight (they wait on the network).
 * Items that failed lately are skipped until their wait is over (the page is read deeper by that many rows, so they never
 * take the places of items behind them). `now` is for tests.
 */
async function sweep({ limit = 30, concurrency = 3, fetch, now = Date.now() } = {}) {
  const res = { checked: 0, tinted: 0, thumbs: 0, retry: 0, given_up: 0 };
  const rows = q.todo.all(limit + retry.size).filter((row) => { const w = retry.get(row.id); return !w || w.until <= now; }).slice(0, limit);
  const failed = [];
  let i = 0;
  const take = async () => {
    while (i < rows.length) {
      const row = rows[i++];
      res.checked++;
      let r = null;
      try { r = await make(row, fetch ? { fetch } : {}); } catch { r = null; }
      if (!r) { res.retry++; failed.push(row); continue; }
      retry.delete(row.id);
      if (r.tint) res.tinted++;
      if (r.thumb_url) res.thumbs++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, rows.length)) }, take));
  // A round where nothing could be read, with no server answering at all (no HTTP status) from at least two different hosts, says
  // the network is down, not that these pictures are bad: nobody's tries are used. A dead host answering 5xx still counts.
  const hosts = new Set(failed.filter((r) => r.failure && !r.failure.http).map((r) => r.failure.host));
  const networkDown = res.checked >= 3 && res.retry === res.checked && hosts.size >= 2 && failed.every((r) => r.failure && !r.failure.http);
  if (!networkDown) {
    for (const row of failed) {
      const tries = ((retry.get(row.id) || {}).tries || 0) + 1;
      if (tries >= MAX_TRIES) { q.save.run({ id: row.id, tint: '', thumb_url: null, w: null, h: null }); retry.delete(row.id); res.given_up++; }
      else retry.set(row.id, { tries, until: now + RETRY_BASE_MS * 2 ** tries });
    }
  }
  // forget waits of items that are no longer in the queue (published state changed, removed)
  if (retry.size > 5000) for (const k of [...retry.keys()].slice(0, retry.size - 5000)) retry.delete(k);
  return res;
}

function progress() { return { remaining: q.left.get().n, waiting: retry.size }; }

let timer = null; let busy = false; let failures = 0; let wait = 0;
function start() {
  if (timer || !sharp()) return;
  timer = setInterval(async () => {
    const s = settingsStore.get();
    if (busy || !s.thumbnails || !s.thumbnailsPerMinute) return;
    if (wait > 0) { wait--; return; }
    busy = true;
    try {
      const r = await sweep({ limit: s.thumbnailsPerMinute });
      // a round where nothing could be read (network down) backs off instead of retrying the same items every minute
      failures = r.checked && r.retry === r.checked ? failures + 1 : 0;
      wait = failures ? Math.min(30, 2 ** failures) : 0;
    } catch (e) {
      failures++;
      wait = Math.min(30, 2 ** failures);
      if (failures === 1) events.log('WARN', `Thumbnails: ${e.message}`);
    } finally { busy = false; }
  }, 60 * 1000);
  timer.unref();
}
function stop() { clearInterval(timer); timer = null; }

module.exports = { start, stop, sweep, make, render, progress };
