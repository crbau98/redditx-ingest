'use strict';
/**
 * Background OCR. One rate-limited sweep a minute picks pictures that have not been read yet, fetches
 * the smallest rendition, and stores only the words in `media.ocr_text`; the FTS trigger then makes
 * them searchable. A picture is marked `ocr_at` even when it fails, so a dead URL is not retried forever.
 *
 * This is deliberately separate from ingestion: OCR is slower than the image filter, and a slow OCR
 * pass must never hold a feed run open.
 */
const repo = require('../db/repo');
const settingsStore = require('../settings');
const blockwatch = require('../lib/blockwatch');
const net = require('../lib/net');
const ocr = require('../lib/ocr');

const TICK_MS = 90 * 1000;
const MAX_PIXELS_BYTES = 8 * 1024 * 1024;
let timer = null;
let running = false;

/** Newest ingested first, read in the order of the partial index v37 (sorting by ingested_at stalled the loop for 23 s). */
function pick(limit) {
  return repo.db.prepare(`SELECT id, media_type, media_url, preview_url, thumbnail_url
    FROM media INDEXED BY ix_media_ocr_todo
    WHERE ocr_at IS NULL AND publish_state = 'published' AND COALESCE(scope, 'creator') != 'excluded'
      AND (media_type = 'image' OR thumbnail_url IS NOT NULL OR preview_url IS NOT NULL)
    ORDER BY seq DESC LIMIT ?`).all(limit);
}

function imageUrl(row) {
  if (row.media_type === 'image') return row.preview_url || row.thumbnail_url || row.media_url || null;
  return row.thumbnail_url || row.preview_url || null;
}

async function tick({ limit } = {}) {
  if (running) return { checked: 0, stored: 0, busy: true };
  const s = settingsStore.get();
  if (!s.ocr || !(s.ocrPerMinute > 0)) return { checked: 0, stored: 0, off: true };
  if (!(await ocr.available())) return { checked: 0, stored: 0, unavailable: true };
  running = true;
  const count = Math.max(1, Math.min(300, Number(limit || s.ocrPerMinute || 20)));
  let checked = 0; let stored = 0;
  try {
    for (const row of pick(count)) {
      checked++;
      const url = imageUrl(row);
      const now = new Date().toISOString();
      if (!url) {
        repo.db.prepare('UPDATE media SET ocr_at = ? WHERE id = ?').run(now, row.id);
        continue;
      }
      let buffer = null;
      try {
        let referer;
        try { referer = `${new URL(url).origin}/`; } catch { /* none */ }
        const got = await net.fetchBuffer(url, {
          headers: { accept: 'image/avif,image/webp,image/*;q=0.8,*/*;q=0.5', ...(referer ? { referer } : {}) },
          timeout: 15000, maxBytes: MAX_PIXELS_BYTES, retries: 0,
        });
        if (got.status < 400 && !/^(text|application\/json)/i.test(got.contentType)) buffer = got.buffer;
      } catch { /* mark the attempt below */ }
      if (!buffer) {
        repo.db.prepare('UPDATE media SET ocr_at = ? WHERE id = ?').run(now, row.id);
        continue;
      }
      const result = await ocr.recognize(buffer, { lang: s.ocrLang || 'eng' });
      if (result.status === 'unavailable') break; // do not mark the rest as read when the binary is missing
      const text = result.status === 'ok' ? String(result.text || '').trim() : null;
      repo.db.prepare('UPDATE media SET ocr_text = ?, ocr_at = ? WHERE id = ?').run(text || null, now, row.id);
      if (text) stored++;
    }
  } catch (e) {
    try { require('./events').log('WARN', `OCR tick failed: ${String(e.message || e).slice(0, 160)}`); } catch { /* ignore */ }
  } finally { running = false; }
  return { checked, stored };
}

function start() {
  if (timer) return;
  timer = setInterval(() => { blockwatch.work('ocr'); tick().catch(() => {}).finally(() => blockwatch.work('idle')); }, TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, TICK_MS, pick, imageUrl };
