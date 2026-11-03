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
const taint = new Set();
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
  if (t.length < 8) return;
  if (taint.has(t)) return;
  taint.add(t);
  if (taint.size > MAX_TAINT) taint.delete(taint.values().next().value);
  persist(t);
}

/** Survive a restart: every piece of Telegram text is also written to the database, and read back before the first check. */
function persist(t) {
  try { const d = db(); if (d) d.prepare('INSERT OR IGNORE INTO telegram_text (norm) VALUES (?)').run(t.slice(0, 4000)); } catch { /* the in-memory copy still guards this process */ }
}
function load() {
  if (loaded) return;
  loaded = true;
  const d = db(); if (!d) return;
  try {
    for (const r of d.prepare('SELECT norm FROM telegram_text ORDER BY rowid DESC LIMIT ?').all(MAX_TAINT)) taint.add(r.norm);
    // rows that came from Telegram even if the text table was pruned: creators whose stored bio is from a Telegram channel, and
    // discovery candidates found on Telegram
    for (const r of d.prepare("SELECT bio, display_name FROM creators WHERE bio_source = 'telegram'").all()) for (const v of [r.bio, r.display_name]) { const t = norm(v); if (t.length >= 8) taint.add(t); }
    for (const r of d.prepare("SELECT bio, display_name, target FROM candidates WHERE platform = 'telegram'").all()) for (const v of [r.bio, r.display_name]) { const t = norm(v); if (t.length >= 8) taint.add(t); }
  } catch { /* tables not there yet (very first start) */ }
}

function tainted(value, depth = 0) {
  if (depth === 0) load();
  if (value === null || value === undefined || depth > 8) return false;
  if (typeof value === 'string') {
    if (POST_LINK.test(value)) return true;
    const t = norm(value);
    if (t.length < 8) return false;
    if (taint.has(t)) return true;
    for (const s of taint) if (s.length >= 12 && t.includes(s)) return true; // a bio/caption embedded in a longer string
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

function _reset({ keepDb = false } = {}) { taint.clear(); loaded = false; if (!keepDb) { try { const d = db(); if (d) d.prepare('DELETE FROM telegram_text').run(); } catch { /* none */ } } }
module.exports = { mark, tainted, scrub, refuse, _reset };
