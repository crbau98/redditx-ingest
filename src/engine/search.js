'use strict';
/**
 * One search box, grouped answers: Creators, Posts and Tags for whatever was typed.
 *
 * The text is read by lib/query.js first ("athletic blond gym on fansly" → build, tags, paid
 * platform), so every group answers the same understood query:
 *   creators  the named creator (exact or a typo away), then name matches, then creators whose
 *             style matches the tags (tf-idf profiles from the library snapshot), then, for a bare
 *             "on Fansly", the most recently active creators with a page there;
 *   posts     the media listing with every understood filter (Best match when there is free text);
 *             if free text sinks an otherwise good query to nothing, it is retried without the text;
 *   tags      the understood tags, tags starting with the leftover words, then tags that go with them.
 * Creators and tags come with the first page only; later pages just continue the posts.
 */
const repo = require('../db/repo');
const sim = require('../lib/similarity');
const { understand, PAID } = require('../lib/query');

const { db, library, GENERIC_TAGS } = repo;
const marks = (a) => a.map(() => '?').join(',');

function cards(ids, paidHost) {
  if (!ids.length) return [];
  const extra = paidHost ? " AND c.links LIKE ? ESCAPE '\\'" : '';
  const args = paidHost ? [...ids, `%${paidHost.replace(/[\\%_]/g, (x) => `\\${x}`)}/%`] : ids;
  const rows = db.prepare(`${repo.SELECT_CREATOR_CARD} WHERE c.id IN (${marks(ids)}) AND c.status = 'active' AND c.scope != 'excluded' AND c.media_count > 0${extra}`).all(...args);
  const byId = new Map(rows.map((r) => [r.id, repo.serializeCreator(r)]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function creatorsFor(u, paidHost, limit) {
  const out = []; const seen = new Set();
  const add = (list, match) => { for (const c of list) if (out.length < limit && !seen.has(c.id)) { seen.add(c.id); out.push({ ...c, match }); } };
  if (u.creator) add(cards([u.creator.id], paidHost), 'name');
  if (u.text) add(repo.creators.list({ q: u.text, limit, paidHost }).items, 'name');
  if (u.tags.length) {
    const weights = new Map(u.tags.map((t) => [t, 1]));
    add(cards(sim.creatorsForTags(library(), GENERIC_TAGS, weights, limit * 3).map(([id]) => id), paidHost), 'style');
  }
  if (paidHost && !u.creator && !u.text && !u.tags.length) add(repo.creators.list({ paidHost, sort: 'recent', limit }).items, 'platform');
  return out;
}

function tagsFor(u, limit) {
  const lib = library();
  const out = []; const seen = new Set();
  const add = (name, count) => { if (out.length < limit && name && !seen.has(name)) { seen.add(name); out.push({ name, count: count || lib.tagCount.get(name) || 0 }); } };
  for (const t of u.tags) add(t);
  for (const w of (u.text || '').toLowerCase().split(/\s+/).filter((x) => x.length >= 2)) {
    let n = 0;
    for (const t of lib.tagList) { if (t.name.startsWith(w)) { add(t.name, t.count); if (++n >= 4) break; } }
  }
  if (u.tags.length) for (const r of repo.tagIntel.related(u.tags, limit)) add(r.name, r.count);
  return out;
}

/**
 * @param {string} text what was typed
 * @param vocab lib/query vocabulary
 * @returns {{understood, chips, corrections, query, relaxed, creators, tags, posts: {items, total, page, limit}}}
 */
function search(text, vocab, { page = 0, limit = 24, type, sort } = {}) {
  const u = understand(text, vocab);
  const paidHost = u.paid ? PAID[u.paid].host : undefined;
  const f = {
    type: u.type || type, sort: u.sort || sort, since: u.since, platform: u.platform, community: u.community,
    creator: u.creator ? u.creator.id : undefined, tagsAll: u.tags.length ? u.tags : undefined,
    q: u.text || undefined, paidHost, build: u.build, page, limit, noCount: page > 0,
  };
  let posts = repo.media.list(f);
  let relaxed = false;
  // "gym blond xyzzy": the filters were right, the leftover word matched nothing.
  if (f.q && u.understood && page === 0 && !posts.items.length) {
    const retry = repo.media.list({ ...f, q: undefined });
    if (retry.items.length) { posts = retry; relaxed = true; }
  }
  const query = {
    type: f.type, sort: f.sort, since: f.since, platform: f.platform, community: f.community, paid: u.paid, build: u.build,
    tags: u.tags.length ? u.tags.join(',') : undefined, creator: f.creator, q: relaxed ? undefined : f.q,
  };
  return {
    understood: u.understood, query, relaxed,
    chips: u.chips.map((c) => ({ key: c.key, value: c.key === 'creator' ? c.value.id : c.value, label: c.label })),
    corrections: u.corrections,
    creators: page === 0 ? creatorsFor(u, paidHost, 8) : [],
    tags: page === 0 ? tagsFor(u, 10) : [],
    posts,
  };
}

module.exports = { search };
