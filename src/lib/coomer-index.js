'use strict';
/**
 * Coomer's public creator index.
 *
 * One request — https://coomer.st/api/v1/creators — returns every account the mirror has indexed
 * (220k+ creators across onlyfans / fansly / candfans, as of the last fetch). Cached on disk for a
 * day, it answers "does this creator exist on the mirror, and under which service?" with no
 * per-handle probe: that is what makes following *every* gay male creator's mirrored page
 * affordable, instead of guessing one handle at a time and paying coomer's rate limit for it.
 *
 * The index is public data the site already publishes (name, service, id, last-indexed time); it
 * says nothing about anyone's content. Which creators become feeds is decided by the caller's own
 * safety and male-scope gates, exactly as for every other discovered account.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const http = require('../sources/http').forPlatform('coomer', 2500);

const BASE = config.baseUrls.coomer;
const CREATORS_URL = `${BASE}/api/v1/creators`;
// Coomer asks scrapers to identify with a stylesheet Accept header (same as the posts API).
const HEADERS = { accept: 'text/css' };
const CACHE_FILE = path.join(config.dataDir, 'coomer-creators.json');
/** Test override: the mock server is a different origin, so the disk cache must not be shared. */
const cacheFile = () => (config.isTest && process.env.COOMER_INDEX_CACHE ? process.env.COOMER_INDEX_CACHE : CACHE_FILE);
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_BYTES = 60 * 1024 * 1024;

/** "Nash.Brandt" / "nash_brandt" / "NASHBRANDT" → "nashbrandt". */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

let mem = null; // {at, byHandle, byName, services}

function readCache() {
  try {
    const st = fs.statSync(cacheFile());
    if (Date.now() - st.mtimeMs > MAX_AGE_MS) return null;
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (!j || !Array.isArray(j.creators)) return null;
    return j;
  } catch { return null; } // no cache yet / unreadable: fetch
}

function writeCache(creators, at) {
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify({ at, creators }), 'utf8');
  } catch { /* a full disk must not stop discovery */ }
}

function build(creators) {
  const byHandle = new Map();
  const byName = new Map();
  const services = {};
  for (const c of creators) {
    if (!c || !c.id) continue;
    const entry = { id: String(c.id), name: c.name ? String(c.name) : String(c.id), service: String(c.service || 'onlyfans'), indexed: c.indexed || 0, updated: c.updated || 0 };
    services[entry.service] = (services[entry.service] || 0) + 1;
    const h = norm(entry.id);
    if (h && !byHandle.has(h)) byHandle.set(h, entry);
    const n = norm(entry.name);
    if (n) {
      const list = byName.get(n);
      if (list) { if (list.length < 40) list.push(entry); }
      else byName.set(n, [entry]);
    }
  }
  return { at: Date.now(), byHandle, byName, services, count: creators.length };
}

/**
 * Load the index (memory → disk → network). Never throws: a failed fetch leaves the
 * previous index in place and the caller simply finds nothing new this run.
 * @returns {Promise<{count: number, services: object, fetchedAt: number, fresh: boolean} | null>}
 */
async function ensure({ force = false } = {}) {
  if (mem && !force) return summary();
  const cached = force ? null : readCache();
  if (cached && !force) {
    mem = build(cached.creators);
    mem.at = cached.at;
    return summary();
  }
  try {
    const res = await http.json(CREATORS_URL, { headers: HEADERS, retries: 2, timeout: 60000, maxBytes: MAX_BYTES });
    const creators = Array.isArray(res) ? res : (res && Array.isArray(res.creators) ? res.creators : null);
    if (!creators || !creators.length) return summary();
    mem = build(creators);
    writeCache(creators, mem.at);
    return summary();
  } catch {
    return summary();
  }
}

function summary() {
  if (!mem) return null;
  return { count: mem.count, services: mem.services, fetchedAt: mem.at, fresh: Date.now() - mem.at < MAX_AGE_MS };
}

/** Exact handle match (dots, dashes and underscores are not significant). */
function lookup(handle) {
  if (!mem) return null;
  const h = norm(handle);
  if (!h || h.length < 3) return null;
  return mem.byHandle.get(h) || null;
}

/** Every indexed creator whose *name* normalises to the same string. */
function byName(name) {
  if (!mem) return [];
  const n = norm(name);
  if (!n || n.length < 4) return [];
  return mem.byName.get(n) || [];
}

/**
 * Best index match for a person, from whatever we know about him: a handle (his own or one a page
 * named) and/or a display name. A handle match always wins; a name match is only returned when the
 * indexed account's own handle is built from that name (so "Adam Gray" → adamgray / adamgrayxxx,
 * never an unrelated "adam.gray.official" that happens to share the name).
 * @returns {{id: string, name: string, service: string, how: 'handle'|'name'} | null}
 */
function best({ handle = null, name = null } = {}) {
  const hit = lookup(handle);
  if (hit) return { ...hit, how: 'handle' };
  const n = norm(name);
  if (!n || n.length < 4) return null;
  for (const e of byName(name)) {
    const h = norm(e.id);
    if (h === n || h.startsWith(n) || n.startsWith(h)) return { ...e, how: 'name' };
  }
  return null;
}

module.exports = { norm, ensure, summary, lookup, byName, best, CACHE_FILE };
