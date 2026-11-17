'use strict';
/**
 * Identity repair: undo fragmentation (one man split over several creator rows) and cross-attribution (other men's links and
 * feeds filed on him). Every operation is a dry run unless `apply` is true, and every change it makes is audited.
 *
 *   cleanQueue    identity-queue pairs whose evidence was a path segment or asset read as a paid handle ("same-paid
 *                 JustFor.Fans:images", "justfor.fans/wallet-topup.php"): the junk evidence goes; a pair left with none is rejected
 *   repairFeeds   feeds a search, discovery or an aggregator page attached although their handle is not his: re-filed on the one
 *                 creator whose handle it is, or detached when there is none or several
 *   repairLinks   profile links that are not his: links into aggregator sites, links owned by another creator, and the page dumps an
 *                 aggregator left (3+ paid / social links in other people's names)
 *   autoMerge     rows of one man: the same handle on 2+ platforms, or a strong pending pair (the same paid page, mutual bio links),
 *                 with nothing against it; the richest active row is kept
 *   hiddenReport / unhide   hidden creators by the last recorded action; unhide only those hidden by no recorded action or by the
 *                 body filter (switched off since 2026-11-02), never one with an open safety report
 *
 * Evidence is only ever what creators publish about themselves and the handles they use. Nothing here compares faces or looks.
 */
const repo = require('../db/repo');
const identity = require('./identity');
const paid = require('../lib/paid');
const aggregators = require('../lib/aggregators');
const { samePerson, stemHandle, accountHandle } = require('./deepsearch');
const { PATH_WORDS, FILE_EXT } = require('../lib/handle-words');

const db = repo.db;
const compact = aggregators.compact;
const turn = () => new Promise((r) => setTimeout(r, 0));
const parse = (s, d) => { try { return JSON.parse(s || ''); } catch { return d; } };

/* ------------------------------------------------------------ queue cleanup */

/** Is this piece of identity evidence a site path or asset that was read as a handle? */
function junkEvidence(e) {
  if (!e || !e.detail) return false;
  const d = String(e.detail);
  if (e.type === 'same-onlyfans') return !paid.validHandle(d);
  if (e.type === 'same-paid') { const h = d.includes(':') ? d.slice(d.lastIndexOf(':') + 1) : d; return !paid.validHandle(h); }
  if (e.type === 'same-linkpage') {
    const seg = (d.split('/')[1] || '').toLowerCase();
    return !seg || FILE_EXT.test(seg) || PATH_WORDS.has(seg) || aggregators.isAggregator(d);
  }
  return false;
}

function cleanQueue({ apply = false, actor = 'identity-repair' } = {}) {
  const out = { pending: 0, junkPairs: 0, rejected: 0, trimmed: 0, mergedOnJunk: [], examples: [] };
  const upd = db.prepare("UPDATE identity_links SET evidence = ?, strength = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
  const rows = db.prepare("SELECT * FROM identity_links WHERE status IN ('pending', 'merged')").all();
  const strength = (ev, a, b) => {
    const kinds = new Set(ev.map((e) => e.type)); let s = 0;
    for (const k of kinds) s += identity.WEIGHTS[k] || 0;
    const dirs = new Set(ev.filter((e) => e.type === 'bio-link').map((e) => e.from));
    if (dirs.has(a) && dirs.has(b)) s += identity.WEIGHTS.mutual;
    return s;
  };
  const work = () => {
    for (const r of rows) {
      const ev = parse(r.evidence, []);
      const good = ev.filter((e) => !junkEvidence(e));
      if (good.length === ev.length) { if (r.status === 'pending') out.pending++; continue; }
      if (r.status === 'merged') { // already done: listed for the admin, never undone here
        if (!good.length) out.mergedOnJunk.push({ linkId: r.id, a: r.a_label, b: r.b_label, kept: r.kept_id, evidence: ev.map((e) => `${e.type} ${e.detail}`) });
        continue;
      }
      out.pending++; out.junkPairs++;
      if (out.examples.length < 50) out.examples.push({ linkId: r.id, a: r.a_label, b: r.b_label, junk: ev.filter(junkEvidence).map((e) => `${e.type} ${e.detail}`), left: good.map((e) => `${e.type} ${e.detail || ''}`.trim()) });
      if (!good.length) { out.rejected++; if (apply) identity.reject(r.id, actor); }
      else { out.trimmed++; if (apply) upd.run(JSON.stringify(good), strength(good, r.a_id, r.b_id), r.id); }
    }
  };
  if (apply) db.transaction(work)(); else work();
  return { apply, ...out };
}

/* ------------------------------------------------------------- his names */

const TRUSTED_ORIGINS = new Set(['admin', 'import', 'seed', 'linked', 'ingest', 'telegram-sync', 'paid-page', 'admin-paid-page', 'import-paid-page', 'lookup', 'paid-mirror']);
const trusted = (origin) => !origin || TRUSTED_ORIGINS.has(origin);

/**
 * The names that are his for these checks: his handle and display name, aliases an admin, a lookup or a merge gave him, and the
 * handles of the accounts filed on him by a trusted path (his own links, an admin, an import). Account aliases that came from a
 * search-attached feed are NOT his proof: those feeds are what is being checked.
 */
function anchors(creatorId) {
  const c = repo.creators.get(creatorId);
  if (!c) return { creator: null, known: [] };
  const known = db.prepare("SELECT alias FROM creator_aliases WHERE creator_id = ? AND source IN ('admin', 'lookup', 'merge')").all(creatorId).map((r) => r.alias);
  // the paid pages he claimed (a lead traced to him) are his names too
  for (const r of db.prepare("SELECT handle FROM onlyfans_leads WHERE creator_id = ? AND status != 'rejected'").all(creatorId)) known.push(r.handle);
  for (const f of db.prepare('SELECT platform, target, origin FROM feeds WHERE creator_id = ?').all(creatorId)) {
    if (trusted(f.origin) && !/^https?:\/\//i.test(f.target)) known.push(accountHandle(f.platform, f.target));
  }
  return { creator: c, known };
}

/**
 * compact handle / confirmed alias -> creator ids (not blocked), built once and kept for a few seconds: one repair pass asks for
 * thousands of handles, and a table scan per question was seconds of blocked loop on 15k creators.
 */
let handleIx = null;
/** The keys a handle is known by: compact, compact without a platform domain ("x.bsky.social"), and the alias key. */
function keysOf(h) {
  const raw = String(h || '').trim().replace(/^@+/, '');
  const out = new Set([compact(raw), compact(raw.replace(/\.(bsky\.social|bsky\.app|bsky\.team)$/i, '')), require('../lib/alias').normAlias(raw) || '']);
  return [...out].filter((k) => k.length >= 4);
}
function handleIndex() {
  if (handleIx && Date.now() - handleIx.at < 5000) return handleIx.map;
  const map = new Map();
  const put = (h, id) => { for (const k of keysOf(h)) { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(id); } };
  for (const r of db.prepare("SELECT id, handle FROM creators WHERE status != 'blocked'").all()) put(r.handle, r.id);
  for (const r of db.prepare(`SELECT a.creator_id AS id, a.alias FROM creator_aliases a JOIN creators c ON c.id = a.creator_id
      WHERE a.source IN ('account', 'admin', 'lookup', 'merge') AND c.status != 'blocked'`).all()) put(r.alias, r.id);
  handleIx = { at: Date.now(), map };
  return map;
}
/** The one other creator (not blocked) whose own handle or confirmed alias is this handle, or null when none or several. */
function ownerOf(handle, notId) {
  const ix = handleIndex();
  const ids = new Set();
  for (const k of keysOf(handle)) for (const id of ix.get(k) || []) ids.add(id);
  ids.delete(notId);
  // a live row wins over a hidden copy of the same man (unhiding it, then the auto-merge, folds the copy in later)
  const active = [...ids].filter((id) => { const c = repo.creators.get(id); return c && c.status === 'active'; });
  const pick = active.length ? active : [...ids];
  return pick.length === 1 ? pick[0] : null;
}
const resetIndex = () => { handleIx = null; };

/* ------------------------------------------------------------------- feeds */

/** Feeds filed on a creator by a search, discovery or an aggregator page although their own handle (or page URL) is not his. */
function foreignFeedList() {
  const rows = db.prepare(`SELECT f.id, f.platform, f.kind, f.target, f.origin, f.creator_id AS creatorId FROM feeds f
    WHERE f.creator_id IS NOT NULL`).all();
  const cache = new Map();
  const anc = (id) => { if (!cache.has(id)) cache.set(id, anchors(id)); return cache.get(id); };
  const out = [];
  for (const f of rows) {
    const isPage = /^https?:\/\//i.test(f.target) && (f.platform === 'web' || f.platform === 'rss');
    const agg = aggregators.isAggregator(f.target);
    if (f.origin === 'admin') continue;
    if (isPage && !agg) continue; // an editorial page that names him: judged when it was attached
    if (!agg && trusted(f.origin)) continue;
    const { creator, known } = anc(f.creatorId);
    if (!creator) continue;
    const handle = isPage ? null : accountHandle(f.platform, f.target);
    const his = agg ? aggregators.urlNames(creator, f.target, known) : samePerson(creator, handle, known);
    if (his) continue;
    const owner = handle ? ownerOf(handle, f.creatorId) : null;
    out.push({ ...f, creatorHandle: creator.handle, handle, aggregator: agg, reattachTo: owner, reattachHandle: owner ? repo.creators.get(owner).handle : null });
  }
  return out;
}

async function repairFeeds({ apply = false, actor = 'identity-repair', limit = 2000 } = {}) {
  resetIndex();
  const list = foreignFeedList();
  const counts = list.length ? new Map(db.prepare(`SELECT feed_id, COUNT(*) AS n FROM media WHERE feed_id IN (${list.map(() => '?').join(',')}) GROUP BY feed_id`).all(...list.map((f) => f.id)).map((r) => [r.feed_id, r.n])) : new Map();
  const items = list.map((f) => ({ ...f, mediaCount: counts.get(f.id) || 0 }));
  const out = { apply, foreign: items.length, reattach: items.filter((f) => f.reattachTo).length, detach: items.filter((f) => !f.reattachTo).length,
    mediaMoved: 0, applied: 0, items: items.slice(0, 200) };
  if (apply) {
    for (const f of items.slice(0, limit)) {
      const r = repo.media.reassignFeed(f.id, f.reattachTo || null, { actor });
      if (r) { out.applied++; out.mediaMoved += r.moved; }
      repo.logAction('feed', f.id, f.reattachTo ? 'identity-reattach' : 'identity-detach',
        `${f.platform}:${String(f.target).slice(0, 80)} was on ${f.creatorHandle}${f.reattachTo ? `, now on ${f.reattachHandle}` : ', now on no creator'} (handle is not his)`, actor);
      await turn();
    }
  }
  return out;
}

/* ------------------------------------------------------------------- links */

/** Which of this creator's links are not his, and why. */
function foreignLinks(c, known) {
  const links = parse(c.links, []);
  const foreign = []; const keep = [];
  const handleLinks = [];
  for (const l of Array.isArray(links) ? links : []) {
    if (!l) continue;
    if (l.url && aggregators.isAggregator(l.url)) { foreign.push({ link: l, kind: 'aggregator', why: 'aggregator site' }); continue; }
    const h = aggregators.linkHandle(l);
    if (h && !samePerson(c, h, known)) {
      const owner = ownerOf(h, c.id);
      if (owner) { foreign.push({ link: l, kind: 'other-creator', why: `belongs to ${repo.creators.get(owner).handle}` }); continue; }
      handleLinks.push({ link: l, handle: h });
      continue;
    }
    keep.push({ link: l, handle: h });
  }
  // A page dump: three or more links in other people's names (a man has one or two paid pages, not a list of women's): all of them
  // go, and so do the nameless links that came with them (wishlists, shop pages).
  if (handleLinks.length >= 3) {
    for (const x of handleLinks) foreign.push({ link: x.link, kind: 'page-dump', why: `not his handle (${x.handle}); ${handleLinks.length} such links: a page dump` });
    for (const x of keep.filter((k) => !k.handle)) foreign.push({ link: x.link, kind: 'page-dump-nameless', why: 'names nobody, came with a page dump' });
  }
  return foreign;
}

function repairLinks({ apply = false, actor = 'identity-repair' } = {}) {
  resetIndex();
  const out = { apply, creators: 0, links: 0, byReason: {}, items: [] };
  for (const c of db.prepare("SELECT id, handle, display_name, links FROM creators WHERE links IS NOT NULL AND links != '[]'").all()) {
    const { known } = anchors(c.id);
    const foreign = foreignLinks(c, known);
    if (!foreign.length) continue;
    out.creators++; out.links += foreign.length;
    for (const f of foreign) out.byReason[f.kind] = (out.byReason[f.kind] || 0) + 1;
    if (out.items.length < 100) out.items.push({ id: c.id, handle: c.handle, remove: foreign.map((f) => ({ url: f.link.url || null, handle: f.link.handle || null, why: f.why })) });
    if (apply) {
      const drop = new Set(foreign.map((f) => f.link));
      const all = parse(c.links, []);
      const left = all.filter((l) => !drop.has(l) && !foreign.some((f) => f.link.url && l && l.url === f.link.url));
      repo.creators.update(c.id, { links: left });
      repo.logAction('creator', c.id, 'identity-prune-links', foreign.map((f) => `${f.link.url || f.link.handle} (${f.why})`).join('; ').slice(0, 900), actor);
    }
  }
  return out;
}

/* -------------------------------------------------------------- auto-merge */

const MERGE_SUFFIX = ['official', 'onlyfans', 'fansly', 'justforfans', 'jff', 'of', 'vip', 'free', 'xxx', 'real', 'nsfw'];
const MERGE_PREFIX = ['the', 'real', 'its', 'im', 'official'];
/** The key one man's handles share across platforms: compact, platform filler stripped ("bigggwild OnlyFans Official" -> bigggwild). */
function mergeKey(handle) {
  let s = compact(handle); let prev;
  do {
    prev = s;
    for (const w of MERGE_SUFFIX) if (s.endsWith(w) && s.length - w.length >= 5) s = s.slice(0, -w.length);
    for (const w of MERGE_PREFIX) if (s.startsWith(w) && s.length - w.length >= 5) s = s.slice(w.length);
  } while (s !== prev);
  return stemHandle(s);
}

/** His paid pages (service:handle), from his links. */
function paidPages(c) {
  const out = new Set();
  for (const l of parse(c.links, [])) {
    if (!l) continue;
    const svc = l.service && paid.SERVICES[l.service] ? l.service : paid.serviceOf(l.url || '');
    if (!svc || !['OnlyFans', 'Fansly', 'JustFor.Fans'].includes(svc)) continue;
    const h = l.handle || paid.paidHandle(svc, l.url || '');
    if (h && paid.validHandle(h)) out.add(`${svc}:${String(h).toLowerCase()}`);
  }
  return out;
}

/** Why these two rows must not be merged automatically, or null. */
function conflict(a, b) {
  const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  const link = db.prepare('SELECT status FROM identity_links WHERE a_id = ? AND b_id = ?').get(x, y);
  if (link && link.status === 'rejected') return 'marked different people';
  const pa = paidPages(a); const pb = paidPages(b);
  if (pa.size && pb.size && ![...pa].some((p) => pb.has(p))) return `distinct paid pages (${[...pa][0]} / ${[...pb][0]})`;
  return null;
}

function platformsOf(id) { return db.prepare('SELECT DISTINCT platform FROM feeds WHERE creator_id = ?').all(id).map((r) => r.platform); }

/** Strong pending pairs: the same paid page, or each links the other from his own bio. Junk evidence does not count. */
function strongPairs() {
  const out = [];
  for (const r of db.prepare("SELECT * FROM identity_links WHERE status = 'pending'").all()) {
    const ev = parse(r.evidence, []).filter((e) => !junkEvidence(e));
    const same = ev.find((e) => e.type === 'same-onlyfans' || e.type === 'same-paid');
    const dirs = new Set(ev.filter((e) => e.type === 'bio-link').map((e) => e.from));
    const mutual = dirs.has(r.a_id) && dirs.has(r.b_id);
    if (same || mutual) out.push({ a: r.a_id, b: r.b_id, linkId: r.id, why: same ? `${same.type} ${same.detail}` : 'mutual bio links' });
  }
  return out;
}

/**
 * The merges due. Same-handle groups of 2-4 rows (more is a common name) on 2+ platforms, and strong pending pairs; joined into
 * clusters. Blocked rows never take part (nothing merges into a blocked creator, and a blocked one is not folded into a live one);
 * a hidden row is reported, not merged (folding it in would publish what was hidden: unhide first, the user decides).
 */
function plan() {
  const rows = db.prepare("SELECT id, handle, display_name, status, media_count, links FROM creators WHERE status != 'blocked'").all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parent = new Map(); const why = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (x, y, reason) => { add(x); add(y); const a = find(x); const b = find(y); if (a !== b) parent.set(a, b); why.set(`${x}|${y}`, reason); };
  const skipped = { hidden: [], conflict: [], commonName: 0 };

  const byKey = new Map();
  for (const r of rows) { const k = mergeKey(r.handle); if (k.length >= 6) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(r); } }
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    if (list.length > 4) { skipped.commonName++; continue; }
    const plats = new Set(list.flatMap((r) => platformsOf(r.id)));
    if (plats.size < 2) continue;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      if (a.status !== 'active' || b.status !== 'active') { skipped.hidden.push({ key, a: a.handle, aStatus: a.status, b: b.handle, bStatus: b.status }); continue; }
      const c = conflict(a, b);
      if (c) { skipped.conflict.push({ a: a.handle, b: b.handle, why: c }); continue; }
      union(a.id, b.id, `same handle "${key}" on ${[...plats].join(', ')}`);
    }
  }
  for (const p of strongPairs()) {
    const a = byId.get(p.a); const b = byId.get(p.b);
    if (!a || !b) continue;
    if (a.status !== 'active' || b.status !== 'active') { skipped.hidden.push({ key: p.why, a: a.handle, aStatus: a.status, b: b.handle, bStatus: b.status }); continue; }
    const c = conflict(a, b);
    if (c) { skipped.conflict.push({ a: a.handle, b: b.handle, why: c }); continue; }
    union(a.id, b.id, p.why);
  }
  const clusters = new Map();
  for (const id of parent.keys()) { const r = find(id); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(id); }
  const merges = [];
  for (const ids of clusters.values()) {
    if (ids.length < 2) continue;
    const members = ids.map((id) => byId.get(id)).sort((x, y) => (y.media_count || 0) - (x.media_count || 0) || (x.id < y.id ? -1 : 1));
    // one cluster must not hold two distinct paid identities either (A~B and B~C can join A and C)
    const keep = members[0];
    const gone = members.slice(1).filter((m) => !conflict(keep, m));
    if (!gone.length) continue;
    const evidence = [];
    for (const [k, v] of why) { const [x, y] = k.split('|'); if (ids.includes(x) && ids.includes(y)) evidence.push(v); }
    merges.push({ keep: { id: keep.id, handle: keep.handle, media: keep.media_count || 0 }, gone: gone.map((g) => ({ id: g.id, handle: g.handle, media: g.media_count || 0 })),
      media: members.reduce((s, m) => s + (m.media_count || 0), 0), evidence: [...new Set(evidence)] });
  }
  merges.sort((a, b) => b.media - a.media);
  return { merges, skipped };
}

async function autoMerge({ apply = false, limit = 500, actor = 'identity-auto' } = {}) {
  const { merges, skipped } = plan();
  const out = { apply, clusters: merges.length, rowsFolded: merges.reduce((s, m) => s + m.gone.length, 0), skippedHidden: skipped.hidden.length,
    skippedConflict: skipped.conflict.length, skippedCommonName: skipped.commonName, top: merges.slice(0, 50),
    hiddenExamples: skipped.hidden.slice(0, 20), conflictExamples: skipped.conflict.slice(0, 20), merged: 0 };
  if (apply) {
    for (const m of merges.slice(0, limit)) {
      for (const g of m.gone) {
        if (!repo.creators.get(g.id) || !repo.creators.get(m.keep.id)) continue;
        if (identity.mergeCreators(m.keep.id, g.id, { actor, reason: `auto: ${m.evidence.join('; ').slice(0, 300)}` })) out.merged++;
        await turn(); // one merge per turn of the loop
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ hidden */

const LAST_ACTION = "(SELECT action FROM moderation_actions a WHERE a.target_type = 'creator' AND a.target_id = c.id ORDER BY a.id DESC LIMIT 1)";
function hiddenReport({ limit = 50 } = {}) {
  const rows = db.prepare(`SELECT c.id, c.handle, c.media_count AS media, ${LAST_ACTION} AS last,
      (SELECT COUNT(*) FROM reports r WHERE r.creator_id = c.id AND r.status = 'open') AS openReports
    FROM creators c WHERE c.status = 'hidden' ORDER BY c.media_count DESC`).all();
  const byAction = {};
  for (const r of rows) { const k = r.last || 'none'; byAction[k] = (byAction[k] || 0) + 1; }
  const unhideable = rows.filter(eligible);
  return { hidden: rows.length, byAction, openReports: rows.filter((r) => r.openReports).length, unhideable: unhideable.length,
    unhideableMedia: unhideable.reduce((s, r) => s + (r.media || 0), 0), top: rows.slice(0, limit).map((r) => ({ ...r, last: r.last || 'none', unhideable: eligible(r) })) };
}
/** Hidden by no recorded action, or by the body filter; never with an open report. */
const eligible = (r) => !r.openReports && (!r.last || r.last === 'physique-hide');

function unhide({ apply = false, actor = 'identity-repair', limit = 1000 } = {}) {
  const rows = db.prepare(`SELECT c.id, c.handle, c.media_count AS media, ${LAST_ACTION} AS last,
      (SELECT COUNT(*) FROM reports r WHERE r.creator_id = c.id AND r.status = 'open') AS openReports
    FROM creators c WHERE c.status = 'hidden' ORDER BY c.media_count DESC`).all().filter(eligible);
  const out = { apply, creators: rows.length, media: rows.reduce((s, r) => s + (r.media || 0), 0), noAction: rows.filter((r) => !r.last).length,
    bodyFilter: rows.filter((r) => r.last === 'physique-hide').length, unhidden: 0, items: rows.slice(0, 100).map((r) => ({ id: r.id, handle: r.handle, media: r.media, last: r.last || 'none' })) };
  if (apply) {
    const physique = require('./physique');
    for (const r of rows.slice(0, limit)) {
      if (r.last === 'physique-hide') { if (physique.unhideCreator(repo.creators.get(r.id))) out.unhidden++; continue; }
      repo.creators.update(r.id, { status: 'active' });
      repo.logAction('creator', r.id, 'unhide', 'hidden with no recorded action (identity repair)', actor);
      out.unhidden++;
    }
  }
  return out;
}

module.exports = { _index: handleIndex, junkEvidence, cleanQueue, repairFeeds, foreignFeedList, repairLinks, foreignLinks, autoMerge, plan, mergeKey, conflict, hiddenReport, unhide, anchors, ownerOf };
