'use strict';
/**
 * Telegram content never reaches an AI provider (Telegram API Terms §1.5; the owner's decision): no Telegram text, caption, bio,
 * channel title or post link goes to OpenAI or Claude.
 *
 * Two layers, both enforced where every model request passes (lib/llm.js, plus Claude web search):
 *   1. taint: the Telegram adapter registers every piece of text it reads (post text, channel title, description). A request whose
 *      input contains one of those strings is refused / has the element dropped.
 *   2. structure: an object marked platform/source 'telegram', or any string holding a Telegram post link (t.me/<name>/<id>,
 *      t.me/c/<id>/<id>), counts as Telegram content.
 * Media never goes to a hosted model in this codebase (the image checks run on the server itself); the guard test pins that.
 */
const taint = new Set();   // text of 12+ characters: matched exactly or as a part of a longer string
const exact = new Set();   // 3+ characters: matched only when the whole string equals it (tags, handles, short names)
let loaded = false;
const db = () => { try { return require('../db/repo').db; } catch { return null; } };
const MAX_TAINT = 40000;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const POST_LINK = /(?:^|[^a-z0-9])(?:t|telegram)\.me\/(?:c\/\d+|s\/[a-z0-9_]+|[a-z0-9_]{4,})\/\d+/i;

/** Remember text that came from Telegram (any depth: string, array or object of strings). */
function mark(value) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) { for (const v of value) mark(v); return; }
  if (typeof value === 'object') { for (const v of Object.values(value)) mark(v); return; }
  const t = norm(value);
  if (t.length < 3) return;
  if (t.length >= 12 ? taint.has(t) : exact.has(t)) return;
  remember(t);
  persist(t);
}
function remember(t) {
  if (t.length >= 12) { taint.add(t); if (taint.size > MAX_TAINT) taint.delete(taint.values().next().value); }
  exact.add(t);
  if (exact.size > MAX_TAINT) exact.delete(exact.values().next().value);
}

/** Survive a restart: every piece of Telegram text is also written to the database, and read back before the first check. */
function persist(t) {
  try { const d = db(); if (d) d.prepare('INSERT OR IGNORE INTO telegram_text (norm) VALUES (?)').run(t.slice(0, 4000)); } catch { /* the in-memory copy still guards this process */ }
}
const RELOAD_MS = 5 * 60 * 1000;
let loadedAt = 0;
function load() {
  if (loaded && Date.now() - loadedAt < RELOAD_MS) return;
  loaded = true; loadedAt = Date.now();
  const d = db(); if (!d) return;
  const add = (v) => { const t = norm(v); if (t.length >= 3) remember(t); };
  try {
    for (const r of d.prepare('SELECT norm FROM telegram_text ORDER BY rowid DESC LIMIT ?').all(MAX_TAINT)) remember(r.norm);
    // Provenance by row, not by text: every creator who has a Telegram feed (his bio / name may have been filled from the channel),
    // creators whose stored bio says it came from Telegram, discovery candidates found on Telegram, and the descriptions kept in
    // Telegram feeds' cursors.
    for (const r of d.prepare("SELECT c.handle, c.display_name, c.bio FROM creators c WHERE c.bio_source = 'telegram' OR EXISTS (SELECT 1 FROM feeds f WHERE f.creator_id = c.id AND f.platform = 'telegram')").all()) { add(r.handle); add(r.display_name); add(r.bio); }
    for (const r of d.prepare("SELECT bio, display_name, target FROM candidates WHERE platform = 'telegram'").all()) { add(r.bio); add(r.display_name); add(r.target); }
    for (const r of d.prepare("SELECT DISTINCT t.name FROM tags t JOIN media_tags mt ON mt.tag_id = t.id JOIN media m ON m.id = mt.media_id WHERE m.platform = 'telegram' LIMIT 20000").all()) add(r.name); // tags that came from Telegram captions
    for (const r of d.prepare("SELECT cursor FROM feeds WHERE platform = 'telegram' AND cursor IS NOT NULL").all()) { try { add(JSON.parse(r.cursor).about); } catch { /* not json */ } }
  } catch { /* tables not there yet (very first start) */ }
}

function tainted(value, depth = 0) {
  if (depth === 0) load();
  if (value === null || value === undefined || depth > 8) return false;
  if (typeof value === 'string') {
    if (POST_LINK.test(value)) return true;
    const t = norm(value);
    if (t.length < 3) return false;
    if (exact.has(t) || exact.has(t.replace(/\s*\(\d+\)$/, ''))) return true; // "gym (12)" is the tag "gym" with its count
    if (t.length >= 12) for (const s of taint) if (t.includes(s)) return true; // a bio/caption embedded in a longer string
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => tainted(v, depth + 1));
  if (typeof value === 'object') {
    for (const k of ['platform', 'source', 'origin']) if (String(value[k] || '').toLowerCase() === 'telegram') return true;
    return Object.values(value).some((v) => tainted(v, depth + 1));
  }
  return false;
}

/** Drop Telegram-derived elements from the arrays directly under `input`; throw when anything else carries Telegram content. */
function scrub(input, purpose = 'ai') {
  if (!tainted(input)) return input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const out = {}; let kept = 0;
    for (const [k, v] of Object.entries(input)) {
      if (Array.isArray(v)) { out[k] = v.filter((x) => !tainted(x)); kept += out[k].length; }
      else if (tainted(v)) throw refuse(purpose);
      else { out[k] = v; }
    }
    if (kept === 0 && Object.values(input).some(Array.isArray)) throw refuse(purpose);
    return out;
  }
  throw refuse(purpose);
}
const refuse = (purpose) => Object.assign(new Error(`AI request "${purpose}" refused: it contains Telegram content (Telegram API Terms §1.5)`), { aiGuard: true, refusal: true });

function _reset({ keepDb = false } = {}) { taint.clear(); exact.clear(); loaded = false; loadedAt = 0; if (!keepDb) { try { const d = db(); if (d) d.prepare('DELETE FROM telegram_text').run(); } catch { /* none */ } } }
module.exports = { mark, load, tainted, scrub, refuse, _reset };
