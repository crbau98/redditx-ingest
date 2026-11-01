'use strict';
/**
 * Coomer scout: which *creators* on the mirror are gay male creators?
 *
 * The old pass searched four generic phrases ("gay muscle", "gay jock", …) and followed any handle
 * that showed up twice. Two problems with that:
 *
 *   1. It never rotated — every run re-ran the same four phrases, so the same handful of creators
 *      were the only ones the mirror was ever asked about.
 *   2. A handle's *name* was the only evidence. A caption that says "hot wife" or a page that is
 *      mostly someone else's content still went through, and a creator whose handle says nothing
 *      ("xxl_92") was skipped even when his posts are unmistakably male.
 *
 * This module replaces both halves with evidence:
 *
 *   • a rotating bank of specific male-creator niches (so the whole bank is covered over a few runs)
 *   • corroboration: a creator must be surfaced by independent queries, or by one query with volume
 *   • verification: the candidate's own mirrored page is read once and classified; a page that reads
 *     female is dropped, a page whose captions read male is accepted even when the handle is opaque,
 *     and a page with no readable signal is accepted only when query corroboration is strong.
 *
 * Everything here is pure (no network, no DB) so the thresholds are unit-tested; the caller does the
 * fetching and the safety / takedown / male-scope gates.
 */
const { classify, femaleCheck } = require('./scope');

/**
 * Specific male-creator niches. Deliberately not "gay porn" (a keyword that returns every studio
 * clip on the mirror): these describe the *man* or the act, which is what a creator's caption says.
 * The bank is long on purpose — eight per run means the whole set is covered in about six runs.
 */
const QUERY_BANK = [
  'gay onlyfans muscle',
  'gay onlyfans jock',
  'gay onlyfans amateur',
  'gay fitness model',
  'gay bodybuilder',
  'gay gym bro',
  'gay muscle hunk',
  'gay muscle worship',
  'gay chest hair muscle',
  'gay bearded muscle',
  'gay hairy muscle',
  'gay otter',
  'gay cub muscle',
  'gay silver fox',
  'gay mature muscle',
  'gay latino muscle',
  'gay asian muscle',
  'gay black muscle',
  'gay arab muscle',
  'gay european muscle',
  'gay uncut',
  'gay big cock',
  'gay solo jerk',
  'gay amateur homemade',
  'gay couple amateur',
  'gay underwear bulge',
  'gay jockstrap',
  'gay locker room',
  'gay shower',
  'gay massage',
  'gay wrestler',
  'gay swimmer',
  'gay athlete',
  'gay firefighter',
  'gay soldier',
  'gay cop',
  'gay construction worker',
  'gay mechanic',
  'gay leather',
  'gay fetish gear',
  'gay pup play',
  'gay rope bondage',
  'gay top muscle',
  'gay bottom muscle',
  'gay vers muscle',
  'gay m4m',
  'gay hung stud',
  'gay alpha male',
];

/** Queries for this run, rotating through the bank (never the same four every time). */
function pickQueries(rotate, n) {
  const bank = QUERY_BANK;
  const count = Math.max(1, Math.min(Number(n) || 6, bank.length));
  const start = ((Number(rotate) || 0) % bank.length + bank.length) % bank.length;
  const out = [];
  for (let i = 0; i < count; i++) out.push(bank[(start + i) % bank.length]);
  return out;
}

/** Next rotation cursor after this run. */
function nextRotate(rotate, n) {
  return (((Number(rotate) || 0) + Math.max(1, Number(n) || 6)) % QUERY_BANK.length + QUERY_BANK.length) % QUERY_BANK.length;
}

/**
 * Group search results by creator. `items` are adapter items (one per file), so a post with three
 * pictures counts as one creator-surfacing post: dedupe by `postKey`/`sourceId` header.
 */
function tally(items, query = null) {
  const byHandle = new Map();
  const postsSeen = new Set();
  for (const it of items || []) {
    const handle = String((it && it.author) || '').toLowerCase().trim();
    if (!handle) continue;
    const postId = String(it.postKey || it.sourceId || '').replace(/-\d+$/, '');
    const key = `${handle}|${postId}`;
    const entry = byHandle.get(handle) || { handle, service: it.service || 'onlyfans', posts: 0, queries: new Set(), texts: [] };
    if (query) entry.queries.add(query);
    if (!postsSeen.has(key)) {
      postsSeen.add(key);
      entry.posts++;
      const text = `${it.title || ''} ${it.body || ''}`.trim();
      if (text && entry.texts.length < 20) entry.texts.push(text);
    }
    byHandle.set(handle, entry);
  }
  return byHandle;
}

/** Merge one tally into another (one per query). */
function merge(into, add) {
  for (const [handle, e] of add) {
    const cur = into.get(handle);
    if (!cur) { into.set(handle, e); continue; }
    cur.posts += e.posts;
    for (const q of e.queries) cur.queries.add(q);
    for (const t of e.texts) if (cur.texts.length < 20) cur.texts.push(t);
    if (!cur.service || cur.service === 'onlyfans') cur.service = e.service || cur.service;
  }
  return into;
}

/**
 * Corroboration score for one creator: independent queries are the signal (a creator surfaced by
 * "gay jock" *and* "gay massage" is a male creator, not a coincidence of one caption), with post
 * volume as a smaller tie-breaker. Handle wording adds a little when it is explicit.
 */
function score(entry) {
  const queries = entry.queries instanceof Set ? entry.queries.size : Number(entry.queries) || 0;
  const posts = Number(entry.posts) || 0;
  let s = queries * 3 + Math.min(posts, 10) * 0.6;
  const handle = String(entry.handle || '').replace(/[._-]+/g, ' ');
  if (/\b(?:gay|m4m|jock|muscle|twink|otter|hunk|daddy|stud)\b/.test(handle)) s += 1;
  return s;
}

/** Does this creator meet the bar to even be offered to the verifier? */
function candidate(entry, { minQueries = 1, minPosts = 2 } = {}) {
  const queries = entry.queries instanceof Set ? entry.queries.size : Number(entry.queries) || 0;
  return queries >= minQueries && (Number(entry.posts) || 0) >= minPosts;
}

/**
 * Read a candidate's own mirrored page and say whether it is a male creator.
 *
 * Returns `{ verdict, maleRatio, femaleRatio, total, reason }`:
 *   verified  — captions read male (the handle may say nothing)
 *   unverified— too little readable signal to judge from content alone
 *   female    — the page reads female: never followed
 *
 * A contradiction (female wording in the captions) always wins over male evidence, the same way the
 * ingest gate treats a post.
 */
function verify(items) {
  let total = 0;
  let male = 0;
  let female = 0;
  for (const it of items || []) {
    if (!it || !it.mediaUrl) continue;
    total++;
    const v = classify([it.title, it.body, it.author], { trusted: false });
    if (v.female) { female++; continue; }
    if (v.male) male++;
  }
  const maleRatio = total ? male / total : 0;
  const femaleRatio = total ? female / total : 0;
  if (female && femaleRatio >= 0.2) return { verdict: 'female', maleRatio, femaleRatio, total, reason: `female-content (${female}/${total})` };
  if (total >= 3 && maleRatio >= 0.5) return { verdict: 'verified', maleRatio, femaleRatio, total, reason: `captions read male (${male}/${total})` };
  return { verdict: 'unverified', maleRatio, femaleRatio, total, reason: total ? `only ${male}/${total} captions read male` : 'no readable captions' };
}

/**
 * Combine corroboration and verification into a follow decision.
 * @returns {{follow: boolean, reason: string}}
 */
function decide(entry, check, { minQueries = 1 } = {}) {
  const queries = entry.queries instanceof Set ? entry.queries.size : Number(entry.queries) || 0;
  if (check.verdict === 'female') return { follow: false, reason: check.reason };
  if (check.verdict === 'verified') return { follow: true, reason: check.reason };
  // No readable captions: only follow when independent queries already agree.
  if (queries >= Math.max(3, minQueries + 2)) return { follow: true, reason: `corroborated by ${queries} queries; ${check.reason}` };
  return { follow: false, reason: `needs corroboration — ${check.reason}` };
}

/** Name/handle read: a hard-female or unsafe name never becomes a feed, whatever the captions say. */
function nameGate(handle, name) {
  const female = femaleCheck(handle, name || '');
  if (female.level === 'hard') return { ok: false, reason: female.rule };
  return { ok: true, reason: null };
}

/*
 * Corroboration has to survive the run boundary. A niche query returns a handful of creators and
 * the bank rotates, so the same man often appears under a *different* niche two runs later; without
 * memory he would be re-judged from scratch and never reach the bar. `evidence` is that memory:
 * one small JSON map in discovery_state, pruned by age and size, holding only queries/posts last
 * seen for each handle — no content, nothing that identifies anyone beyond the public handle.
 */
const EVIDENCE_TTL_MS = 14 * 86400000;

/** Fold the stored evidence for still-fresh handles into this run's tally. */
function restore(tally, stored, { now = Date.now(), ttlMs = EVIDENCE_TTL_MS } = {}) {
  for (const [handle, v] of Object.entries(stored || {})) {
    if (!v || !handle) continue;
    if (v.seenAt && now - v.seenAt > ttlMs) continue;
    const cur = tally.get(handle) || { handle, service: v.service || 'onlyfans', posts: 0, queries: new Set(), texts: [] };
    for (const q of v.queries || []) cur.queries.add(q);
    cur.posts = Math.max(Number(cur.posts) || 0, Number(v.posts) || 0);
    tally.set(handle, cur);
  }
  return tally;
}

/** The next stored evidence: this run's tally added to the old map, pruned by age then size. */
function snapshot(tally, stored, { now = Date.now(), keep = 500, ttlMs = EVIDENCE_TTL_MS } = {}) {
  const out = { ...(stored || {}) };
  for (const [handle, e] of tally) {
    out[handle] = { queries: [...e.queries], posts: Number(e.posts) || 0, service: e.service || 'onlyfans', seenAt: now };
  }
  return Object.fromEntries(Object.entries(out)
    .filter(([, v]) => v && (!v.seenAt || now - v.seenAt <= ttlMs))
    .sort((a, b) => (b[1].seenAt || 0) - (a[1].seenAt || 0))
    .slice(0, keep));
}

module.exports = { QUERY_BANK, pickQueries, nextRotate, tally, merge, score, candidate, verify, decide, nameGate, restore, snapshot, EVIDENCE_TTL_MS };
