'use strict';
/**
 * One search box, grouped answers: Creators, Posts and Tags for whatever was typed.
 *
 * The text is read by lib/query.js first ("athletic blond gym on fansly" → build, tags, paid
 * platform), so every group answers the same understood query:
 *   creators  the named creator (exact or a typo away), then name matches, then creators whose
 *             style matches the tags (tf-idf profiles from the library snapshot), then creators who post
 *             all of the tags (a tag only one creator uses has no style to compare), then, for a bare
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

/** Ids of creators with a page on the paid platform at `host` (one indexed-free scan of a small table). */
function paidCreators(host) {
  return new Set(db.prepare("SELECT id FROM creators WHERE links LIKE ? ESCAPE '\\'").all(`%${host.replace(/[\\%_]/g, (x) => `\\${x}`)}/%`).map((r) => r.id));
}

function creatorsFor(u, paidHost, limit) {
  const out = []; const seen = new Set();
  const add = (list, match) => { for (const c of list) if (out.length < limit && !seen.has(c.id)) { seen.add(c.id); out.push({ ...c, match }); } };
  if (u.creator) add(cards([u.creator.id], paidHost), 'name');
  if (u.text) add(repo.creators.list({ q: u.text, limit, paidHost }).items, 'name');
  if (u.tags.length) {
    const lib = library();
    const weights = new Map(u.tags.map((t) => [t, 1]));
    // With a paid platform, narrow the style matches to its creators before taking the top few.
    const paid = paidHost ? paidCreators(paidHost) : null;
    let ids = sim.creatorsForTags(lib, GENERIC_TAGS, weights, paid ? Infinity : limit * 3).map(([id]) => id);
    if (paid) ids = ids.filter((id) => paid.has(id)).slice(0, limit * 3);
    add(cards(ids, paidHost), 'style');
    // A tag only one creator uses is not in the similarity index (it compares nobody), but he owns it: list who posts
    // every one of these tags, most posts first.
    if (out.length < limit) {
      const owners = [];
      for (const [cid, tags] of lib.creatorTags) {
        let n = Infinity;
        for (const t of u.tags) { const k = tags.get(t) || 0; if (k < n) n = k; if (!n) break; }
        if (n && n !== Infinity && !seen.has(cid) && (!paid || paid.has(cid))) owners.push([cid, n]);
      }
      add(cards(owners.sort((a, b) => b[1] - a[1]).slice(0, limit * 2).map(([id]) => id), paidHost), 'tag');
    }
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
  // "gym blond xyzzy": the filters were right, the leftover word matched nothing. Decided on the query as a whole (does
  // the text match anything at all?), so every page of a relaxed search is relaxed too.
  let relaxed = false;
  if (f.q && u.understood && !repo.media.list({ ...f, page: 0, limit: 1, noCount: true }).items.length
    && repo.media.list({ ...f, q: undefined, page: 0, limit: 1, noCount: true }).items.length) {
    relaxed = true; f.q = undefined;
  }
  const posts = repo.media.list(f);
  const query = {
    type: f.type, sort: f.sort, since: f.since, platform: f.platform, community: f.community, paid: u.paid, build: u.build,
    tags: u.tags.length ? u.tags.join(',') : undefined, creator: f.creator, q: f.q,
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
