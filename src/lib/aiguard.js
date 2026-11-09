'use strict';
/**
 * Telegram and Reddit text never reach a hosted model.
 *
 *   Telegram API Terms §1.5 (the owner's earlier decision): no Telegram text, caption, bio,
 *   channel title or post link goes to OpenAI or Claude.
 *   Reddit Data API Terms §2.4 and §3.2 (owner, 2026-11-09): Reddit posts are still stored and
 *   shown. Their text is not sent to a hosted model, and it is not used to train one. Copying
 *   and displaying it inside this app is the use the terms allow without a separate agreement.
 *
 * Two layers, both enforced where every model request passes (lib/llm.js, plus Claude web search):
 *   1. taint: the adapter registers every piece of text it reads. A request whose input contains
 *      one of those strings is refused / has the element dropped.
 *   2. structure: an object marked platform/source 'telegram' or 'reddit', or any string holding a
 *      Telegram post link or a Reddit comments link, counts as that source's content.
 * Media never goes to a hosted model in this codebase (the image checks run on the server itself).
 * This module does not hide, delete, or skip a post.
 */
const taint = new Set();   // text of 12+ characters: matched exactly or as a part of a longer string
const exact = new Set();   // 3+ characters: matched only when the whole string equals it (tags, handles, short names)
const sourceOf = new Map();
let loaded = false;
const db = () => { try { return require('../db/repo').db; } catch { return null; } };
const MAX_TAINT = 40000;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const POST_LINK = /(?:^|[^a-z0-9])(?:t|telegram)\.me\/(?:c\/\d+|s\/[a-z0-9_]+|[a-z0-9_]{4,})\/\d+/i;
const REDDIT_POST = /(?:^|[^a-z0-9])(?:www\.|old\.|np\.)?reddit\.com\/r\/[a-z0-9_]+\/comments\/[a-z0-9]+|(?:^|[^a-z0-9])redd\.it\/[a-z0-9]+/i;
const asSource = (source) => (source === 'reddit' ? 'reddit' : 'telegram');

/** Remember text that came from Telegram (default) or Reddit. Any depth: string, array or object of strings. */
function mark(value, source = 'telegram') {
  if (value === null || value === undefined) return;
  const src = asSource(source);
  if (Array.isArray(value)) { for (const v of value) mark(v, src); return; }
  if (typeof value === 'object') { for (const v of Object.values(value)) mark(v, src); return; }
  const t = norm(value);
  if (t.length < 3) return;
  if ((t.length >= 12 ? taint.has(t) : exact.has(t)) && sourceOf.has(t)) return;
  remember(t, src);
  persist(t, src);
}
function remember(t, source = 'telegram') {
  if (t.length >= 12) { taint.add(t); if (taint.size > MAX_TAINT) taint.delete(taint.values().next().value); }
  exact.add(t);
  if (exact.size > MAX_TAINT) exact.delete(exact.values().next().value);
  if (!sourceOf.has(t)) sourceOf.set(t, asSource(source));
}

/** Survive a restart: every piece of source text is also written to the database, and read back before the first check. */
function persist(t, source) {
  const table = asSource(source) === 'reddit' ? 'reddit_text' : 'telegram_text';
  try { const d = db(); if (d) d.prepare(`INSERT OR IGNORE INTO ${table} (norm) VALUES (?)`).run(t.slice(0, 4000)); } catch { /* the in-memory copy still guards this process */ }
}
const RELOAD_MS = 5 * 60 * 1000;
let loadedAt = 0;
function load() {
  if (loaded && Date.now() - loadedAt < RELOAD_MS) return;
  loaded = true; loadedAt = Date.now();
  const d = db(); if (!d) return;
  const add = (v, source) => { const t = norm(v); if (t.length >= 3) remember(t, source); };
  const addLong = (v, source) => { const t = norm(v); if (t.length >= 12) remember(t, source); };
  try {
    for (const r of d.prepare('SELECT norm FROM telegram_text ORDER BY rowid DESC LIMIT ?').all(MAX_TAINT)) remember(r.norm, 'telegram');
    // Provenance by row, not by text: every creator who has a Telegram feed (his bio / name may have been filled from the channel),
    // creators whose stored bio says it came from Telegram, discovery candidates found on Telegram, and the descriptions kept in
    // Telegram feeds' cursors.
    for (const r of d.prepare("SELECT c.handle, c.display_name, c.bio FROM creators c WHERE c.bio_source = 'telegram' OR EXISTS (SELECT 1 FROM feeds f WHERE f.creator_id = c.id AND f.platform = 'telegram')").all()) { add(r.handle, 'telegram'); add(r.display_name, 'telegram'); add(r.bio, 'telegram'); }
    for (const r of d.prepare("SELECT bio, display_name, target FROM candidates WHERE platform = 'telegram'").all()) { add(r.bio, 'telegram'); add(r.display_name, 'telegram'); add(r.target, 'telegram'); }
    for (const r of d.prepare("SELECT DISTINCT t.name FROM tags t JOIN media_tags mt ON mt.tag_id = t.id JOIN media m ON m.id = mt.media_id WHERE m.platform = 'telegram' LIMIT 20000").all()) add(r.name, 'telegram'); // tags that came from Telegram captions
    for (const r of d.prepare("SELECT cursor FROM feeds WHERE platform = 'telegram' AND cursor IS NOT NULL").all()) { try { add(JSON.parse(r.cursor).about, 'telegram'); } catch { /* not json */ } }
  } catch { /* tables not there yet (very first start) */ }
  try {
    for (const r of d.prepare('SELECT norm FROM reddit_text ORDER BY rowid DESC LIMIT ?').all(MAX_TAINT)) remember(r.norm, 'reddit');
    // Reddit User Content only. A creator who also has a Reddit feed keeps his other bios available to the model
    // unless that bio was stored from Reddit. Short historical titles are not loaded: a one-word title would block
    // any AI field that equals that word. New reads still register through mark().
    for (const r of d.prepare("SELECT handle, display_name, bio FROM creators WHERE bio_source = 'reddit'").all()) { addLong(r.handle, 'reddit'); addLong(r.display_name, 'reddit'); addLong(r.bio, 'reddit'); }
    for (const r of d.prepare("SELECT title, description FROM media WHERE platform = 'reddit' ORDER BY seq DESC LIMIT 20000").all()) { addLong(r.title, 'reddit'); addLong(r.description, 'reddit'); }
  } catch { /* reddit_text arrives with migration v30 */ }
}

function linkSource(value) {
  if (POST_LINK.test(value)) return 'telegram';
  if (REDDIT_POST.test(value)) return 'reddit';
  return null;
}

function tainted(value, depth = 0) {
  if (depth === 0) load();
  if (value === null || value === undefined || depth > 8) return false;
  if (typeof value === 'string') {
    if (linkSource(value)) return true;
    const t = norm(value);
    if (t.length < 3) return false;
    if (exact.has(t) || exact.has(t.replace(/\s*\(\d+\)$/, ''))) return true; // "gym (12)" is the tag "gym" with its count
    if (t.length >= 12) for (const s of taint) if (t.includes(s)) return true; // a bio/caption embedded in a longer string
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => tainted(v, depth + 1));
  if (typeof value === 'object') {
    for (const k of ['platform', 'source', 'origin']) {
      const p = String(value[k] || '').toLowerCase();
      if (p === 'telegram' || p === 'reddit') return true;
    }
    return Object.values(value).some((v) => tainted(v, depth + 1));
  }
  return false;
}

function which(value, depth = 0) {
  if (value === null || value === undefined || depth > 8) return null;
  if (typeof value === 'string') {
    const link = linkSource(value);
    if (link) return link;
    const t = norm(value);
    if (sourceOf.has(t)) return sourceOf.get(t);
    const bare = t.replace(/\s*\(\d+\)$/, '');
    if (sourceOf.has(bare)) return sourceOf.get(bare);
    if (t.length >= 12) for (const s of taint) if (t.includes(s) && sourceOf.has(s)) return sourceOf.get(s);
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) { const s = which(v, depth + 1); if (s) return s; }
    return null;
  }
  if (typeof value === 'object') {
    for (const k of ['platform', 'source', 'origin']) {
      const p = String(value[k] || '').toLowerCase();
      if (p === 'telegram' || p === 'reddit') return p;
    }
    for (const v of Object.values(value)) { const s = which(v, depth + 1); if (s) return s; }
  }
  return null;
}

/** Drop tainted elements from the arrays directly under `input`; throw when anything else carries guarded content. */
function scrub(input, purpose = 'ai') {
  if (!tainted(input)) return input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const out = {}; let kept = 0;
    for (const [k, v] of Object.entries(input)) {
      if (Array.isArray(v)) { out[k] = v.filter((x) => !tainted(x)); kept += out[k].length; }
      else if (tainted(v)) throw refuse(purpose, which(v));
      else { out[k] = v; }
    }
    if (kept === 0 && Object.values(input).some(Array.isArray)) throw refuse(purpose, which(input));
    return out;
  }
  throw refuse(purpose, which(input));
}
function refuse(purpose, source) {
  const why = source === 'reddit'
    ? 'Reddit content (Reddit Data API Terms §2.4 and §3.2)'
    : source === 'telegram'
      ? 'Telegram content (Telegram API Terms §1.5)'
      : 'Telegram or Reddit content';
  return Object.assign(new Error(`AI request "${purpose}" refused: it contains ${why}`), { aiGuard: true, refusal: true, source: source || null });
}

function _reset({ keepDb = false } = {}) {
  taint.clear(); exact.clear(); sourceOf.clear(); loaded = false; loadedAt = 0;
  if (!keepDb) {
    try { const d = db(); if (d) { d.prepare('DELETE FROM telegram_text').run(); d.prepare('DELETE FROM reddit_text').run(); } } catch { /* none */ }
  }
}
module.exports = { mark, load, tainted, scrub, refuse, _reset };
