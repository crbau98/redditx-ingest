'use strict';
/**
 * Coverage: for every active creator with a TRUSTED handle, look for the same account on the platforms PRISM can read, and
 * follow it where it exists and there is EVIDENCE it is his.
 *
 * Why this exists (Bigggwild, 2026-11-17): he had hundreds of pictures and videos across coomer, redgifs, fapello, gaysdream and gff,
 * and PRISM showed a few. Deep search (engine/deepsearch) finds pages through budgeted web-search queries, two creators an hour; a
 * handle only entered its queries while one of his feeds was ENABLED. Nothing asked each platform directly "is this account there?".
 * This module does: no web search, one bounded adapter read per candidate account.
 *
 * Safety (Crucible, v4.23.0: a namesake attached by coverage got a real man BLOCKED and his items PURGED). Therefore:
 *  - OFF by default (setting coverageEnabled): run POST /api/admin/coverage/run {dryRun:true} first, enable after reading it;
 *  - handles only from trusted sources: a CLAIMED paid-page lead, an alias an admin / lookup / merge set (never one a feed made),
 *    and the account of a feed that produced items and that an admin, a seed or the app's own ingest created (never one discovery,
 *    deep search, coverage or a bio link attached: that would pass an earlier mistake on);
 *  - every attach needs evidence that is independent of the shared handle: the probed profile names him (his full name, or another
 *    handle / alias of his, as whole words), or links to his known accounts or paid pages; a claimed paid page's own coomer mirror
 *    is that account. A short name match on a common handle ("Alexander K") is NOT evidence;
 *  - the probed profile name, bio and target are run through the male-only scope check and the safety check before anything is
 *    followed, and addSpec re-checks the target;
 *  - feeds are created UNTRUSTED: items still need their own male signal in the pipeline;
 *  - X and Telegram are never probed (a probe spends the X search budget / MTProto budget); TikTok stays a link-out.
 * Leak and mirror hosts such as Fapello are in scope by the owner's decision of 2026-11-05.
 * Budgets: a per-platform daily cap reserved BEFORE each probe (so a parallel or aborted pass cannot overspend), a per-creator
 * cooldown, and creators people view first, then the most popular.
 */
const repo = require('../db/repo');
const config = require('../config');
const events = require('./events');
const settingsStore = require('../settings');

const PROBE_PLATFORMS = ['coomer', 'redgifs', 'reddit', 'bluesky', 'tumblr', 'web', 'pornhub', 'xhamster'];
const PROBE_TIMEOUT_MS = 15_000;
const OK_HANDLE = /^[A-Za-z0-9._]{4,30}$/;
const COOLDOWN_DAYS = 14;
const COOLDOWN_FOUND_DAYS = 3; // a creator that just gained feeds is looked at again sooner (his other handles)
const MAX_HANDLES = 2;
const MIN_SINGLE_TOKEN = 6;                       // a one-word name this short is too common to be evidence
const TRUSTED_ALIAS_SOURCES = ['admin', 'lookup', 'merge'];
const TRUSTED_FEED_ORIGINS = ['admin', 'seed', 'ingest'];
const GENERIC = new Set(['official', 'admin', 'support', 'contact', 'gaymuscle', 'gayporn', 'fitness', 'model', 'creator']);

const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const dayKey = () => new Date().toISOString().slice(0, 10);
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms).unref())]);

/* ----------------------------------------------------------------- the daily budget */
function loadDay() {
  let s; try { s = JSON.parse(repo.discoveryState.get('coverage.day', '{}') || '{}'); } catch { s = {}; }
  return s && s.day === dayKey() ? s : { day: dayKey(), probes: {}, created: 0 };
}
function saveDay(s) { repo.discoveryState.set('coverage.day', JSON.stringify(s)); }
const capOf = () => Math.max(0, Number(settingsStore.get().coveragePerPlatformPerDay) || 0);
/**
 * Take one probe from a platform's daily budget. Load, check, increment and save happen in ONE synchronous step, so two passes
 * running at once (the hourly rotation and an admin POST) cannot both spend the last probe, and a pass that is aborted after this
 * point has still paid for the probe it started.
 */
function reserveProbe(platform) {
  const d = loadDay();
  if ((d.probes[platform] || 0) >= capOf()) return false;
  d.probes[platform] = (d.probes[platform] || 0) + 1;
  saveDay(d);
  return true;
}
function noteCreated() { const d = loadDay(); d.created = (d.created || 0) + 1; saveDay(d); }

/* -------------------------------------------------------------------- the handles */
/**
 * Handles a creator is known by, from TRUSTED sources only, strongest first. A disabled productive feed still counts: it says what
 * the account is called. Returns the handles plus the other trusted names (for the evidence test).
 */
function confidentHandles(creator) {
  const { accountHandle } = require('./deepsearch');
  const found = new Map(); // compact -> { handle, reason, rank }
  const add = (handle, reason, rank) => {
    const h = String(handle || '').trim().replace(/^@/, '');
    const n = compact(h);
    if (!OK_HANDLE.test(h) || n.length < 4 || GENERIC.has(n)) return;
    if (!found.has(n) || found.get(n).rank > rank) found.set(n, { handle: h, reason, rank });
  };
  const id = creator.id;
  try {
    for (const r of repo.db.prepare("SELECT handle FROM onlyfans_leads WHERE creator_id = ? AND status = 'claimed'").all(id)) add(r.handle, 'paid page', 0);
    const origins = TRUSTED_FEED_ORIGINS.map(() => '?').join(',');
    for (const r of repo.db.prepare(`SELECT platform, target FROM feeds WHERE creator_id = ? AND COALESCE(items_total, 0) > 0 AND origin IN (${origins}) AND platform NOT IN ('web', 'rss', 'linkinbio')`).all(id, ...TRUSTED_FEED_ORIGINS)) add(accountHandle(r.platform, r.target), 'productive feed', 1);
    const src = TRUSTED_ALIAS_SOURCES.map(() => '?').join(',');
    for (const r of repo.db.prepare(`SELECT alias FROM creator_aliases WHERE creator_id = ? AND source IN (${src})`).all(id, ...TRUSTED_ALIAS_SOURCES)) add(r.alias, 'trusted alias', 2);
  } catch { /* identity tables must never fail a pass */ }
  return [...found.values()].sort((a, b) => a.rank - b.rank || b.handle.length - a.handle.length).slice(0, MAX_HANDLES);
}

/* ---------------------------------------------------------------------- the specs */
/** Candidate accounts for one handle on the platforms we probe. Lookup's directSpecs already knows the per-platform target shapes. */
function specsFor(handle) {
  const out = [];
  try {
    for (const s of require('./lookup').directSpecs({ handles: [handle] })) if (PROBE_PLATFORMS.includes(s.platform)) out.push(s);
  } catch { /* lookup unavailable: the page templates below still run */ }
  const slug = handle.toLowerCase().replace(/[._]+/g, '-');
  if (/^[a-z0-9-]{4,40}$/.test(slug)) {
    out.push({ platform: 'pornhub', kind: 'user', target: `https://www.pornhub.com/model/${slug}`, label: `${handle} (Pornhub)`, ingestable: true });
    out.push({ platform: 'xhamster', kind: 'user', target: `https://xhamster.com/gay/creators/${slug}`, label: `${handle} (xHamster)`, ingestable: true });
  }
  if (/^[A-Za-z0-9._-]{4,40}$/.test(handle)) out.push({ platform: 'web', kind: 'page', target: `https://fapello.com/${handle.toLowerCase()}/`, label: `${handle} (Fapello)`, ingestable: true });
  const seen = new Set();
  return out.filter((s) => { const k = `${s.platform}|${s.kind}|${String(s.target).toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/* --------------------------------------------------------------------- the probe */
async function defaultProbe(spec) {
  const registry = require('../sources');
  const adapter = registry.get(spec.platform);
  if (!adapter || !adapter.kinds.includes(spec.kind)) return { exists: false, why: 'no adapter' };
  const conf = adapter.isConfigured(spec.kind);
  if (conf && conf.ok === false) return { exists: false, why: conf.note || 'not configured' };
  const feed = { id: 'coverage', platform: spec.platform, kind: spec.kind, target: spec.target, trusted: 1, label: spec.label };
  try {
    const res = await withTimeout(adapter.fetch(feed, { cursor: {}, limit: 8, force: true, probe: true, needProfile: true, aborted: () => false }), PROBE_TIMEOUT_MS, `${spec.platform} probe`);
    const items = (res && res.items) || [];
    return { exists: items.length > 0, items: items.length, profile: (res && res.profile) || {} };
  } catch (e) {
    return { exists: false, why: e && e.status === 404 ? 'not found' : String((e && e.message) || e).slice(0, 100), error: true };
  }
}

const wordsOf = (text) => String(text || '').toLowerCase().normalize('NFKD').split(/[^a-z0-9]+/).filter(Boolean);
/** Does `needle` (a list of words) appear in `hay` (a list of words) as a whole, consecutive run? */
function hasRun(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, k) => hay[i + k] === w)) return true;
  return false;
}

/**
 * Is the account that exists HIM? A handle match alone is not evidence: a namesake has the same handle, and the probed handle is
 * always one he is known by, so a profile that only repeats THAT handle proves nothing ("Alexander K, a different man" for the
 * handle "alexander"). Evidence is one of:
 *  - the profile names him by something other than the probed handle: his full display name (two or more words), or another of his
 *    handles / aliases (one word of 6+ letters), as whole words in the profile name or bio;
 *  - the profile links to his paid page (a claimed lead handle) or to an account he is already known to have;
 *  - this is the coomer mirror of a CLAIMED paid page (onlyfans/<handle>, fansly/<handle>): the same account by construction.
 * @returns {string|null} what the evidence was, or null
 */
function readsAsHim(creator, handle, hit, ctx) {
  const probed = compact(handle);
  const p = (hit && hit.profile) || {};
  const spec = (hit && hit.spec) || {};
  const claimed = ctx.claimed || new Set();
  if (spec.platform === 'coomer') {
    const m = /^(onlyfans|fansly)\/(.+)$/i.exec(String(spec.target || ''));
    if (m && claimed.has(compact(m[2]))) return 'mirror of his claimed paid page';
  }
  const hay = wordsOf(`${p.displayName || ''} ${p.bio || ''}`);
  const names = [creator.display_name, creator.handle, ...(ctx.others || [])].filter(Boolean);
  for (const name of names) {
    const w = wordsOf(name);
    if (compact(name) === probed) continue; // the shared handle itself is not independent
    if (w.length >= 2 ? hasRun(hay, w) : (w[0] && w[0].length >= MIN_SINGLE_TOKEN && hay.includes(w[0]))) return 'profile names him';
  }
  const linkText = (p.links || []).map((l) => String(l.target || l.url || l.handle || '')).filter(Boolean);
  if (linkText.length) {
    try {
      const paidHandles = require('../lib/paid').findPaidHandles(linkText.join('\n')).map((x) => compact(x.handle));
      if (paidHandles.some((h) => claimed.has(h))) return 'profile links to his paid page';
      const { parseProfile } = require('../lib/links');
      const known = ctx.knownAccounts || new Set();
      for (const l of linkText) {
        const sp = parseProfile(l);
        if (sp && sp.platform && sp.target && known.has(`${sp.platform}|${compact(sp.target)}`)) return 'profile links to his known accounts';
      }
    } catch { /* an unreadable link is no evidence */ }
  }
  return null;
}

/** The male-only scope and safety gates on what the probe actually found, before anything is followed. */
function profileRefusal(spec, profile) {
  const { femaleCheck } = require('../lib/scope'); const { checkText } = require('../lib/safety');
  const texts = [spec.target, spec.label, profile && profile.displayName, profile && profile.bio, profile && profile.handle];
  const f = femaleCheck(texts);
  if (f.level) return `profile reads female (${f.rule})`;
  const sf = checkText(...texts.map((t) => t || ''));
  if (sf.level === 'block') return `safety gate (${sf.rule})`;
  return null;
}

/* ----------------------------------------------------------------------- a pass */
/**
 * One creator. Never throws. `probe` can be replaced by tests.
 * @returns {{creatorId, handles: string[], probed: number, created: object[], skipped: object}}
 */
async function coverCreator(creator, { dryRun = false, probe = defaultProbe, aborted = () => false } = {}) {
  const out = { creatorId: creator.id, name: creator.display_name || creator.handle, handles: [], probed: 0, created: [], skipped: {} };
  const skip = (k) => { out.skipped[k] = (out.skipped[k] || 0) + 1; };
  const handles = confidentHandles(creator);
  out.handles = handles.map((h) => `${h.handle} (${h.reason})`);
  if (!handles.length) return out;
  const t = require('../services/targets');
  const ctx = evidenceContext(creator, handles);
  const have = new Set(repo.db.prepare('SELECT platform || \'|\' || kind AS k FROM feeds WHERE creator_id = ?').all(creator.id).map((r) => r.k));
  for (const h of handles) {
    for (const spec of specsFor(h.handle)) {
      if (aborted()) return out;
      if (have.has(`${spec.platform}|${spec.kind}`) || repo.feeds.find(spec.platform, spec.kind, spec.target)) { skip('already followed'); continue; }
      if (dryRun) { skip('dry run'); continue; }
      if (!reserveProbe(spec.platform)) { skip('platform daily cap'); continue; }
      out.probed++;
      const hit = await probe(spec);
      if (!hit || !hit.exists) { skip(hit && hit.error ? 'probe error' : 'not there'); continue; }
      const refused = profileRefusal(spec, hit.profile);
      if (refused) { skip(refused.startsWith('safety') ? 'safety gate' : 'profile reads female'); continue; }
      const why = readsAsHim(creator, h.handle, { ...hit, spec }, ctx);
      if (!why) { skip('exists but no evidence it is him'); continue; }
      const r = t.addSpec(spec, { creatorId: creator.id, origin: 'coverage', trusted: false });
      if (r.status === 'created' && r.feed) {
        have.add(`${spec.platform}|${spec.kind}`); noteCreated();
        out.created.push({ id: r.feed.id, platform: spec.platform, target: spec.target, why });
        events.log('OK', `Coverage: ${out.name} → ${spec.platform}:${spec.target} (${why})`);
      } else skip(r.status === 'conflict' ? 'belongs to another creator' : `refused (${r.status})`);
    }
  }
  if (out.created.length && !config.isTest) {
    try { require('./engine').enqueue(out.created.map((c) => c.id), { force: true, trigger: 'coverage' }); } catch { /* the scheduler picks them up */ }
  }
  return out;
}

/** What the evidence test may compare a profile against: his claimed paid handles, his other trusted names, his known accounts. */
function evidenceContext(creator, handles) {
  const { accountHandle } = require('./deepsearch');
  const claimed = new Set(); const others = handles.map((h) => h.handle); const knownAccounts = new Set();
  try {
    for (const r of repo.db.prepare("SELECT handle FROM onlyfans_leads WHERE creator_id = ? AND status = 'claimed'").all(creator.id)) claimed.add(compact(r.handle));
    for (const r of repo.db.prepare('SELECT alias FROM creator_aliases WHERE creator_id = ? AND source IN (\'admin\', \'lookup\', \'merge\')').all(creator.id)) others.push(r.alias);
    const origins = TRUSTED_FEED_ORIGINS.map(() => '?').join(',');
    for (const r of repo.db.prepare(`SELECT platform, target FROM feeds WHERE creator_id = ? AND COALESCE(items_total, 0) > 0 AND origin IN (${origins})`).all(creator.id, ...TRUSTED_FEED_ORIGINS)) knownAccounts.add(`${r.platform}|${compact(accountHandle(r.platform, r.target))}`);
  } catch { /* identity tables must never fail a pass */ }
  return { claimed, others, knownAccounts };
}

/** Hourly: the most popular creators not looked at lately. Bounded by `limit` creators and the per-platform daily caps. */
async function rotate({ limit = 4, probe = defaultProbe, aborted = () => false } = {}) {
  if (!settingsStore.get().coverageEnabled) return { started: 0, creators: [], skipped: 'off in Settings' };
  const now = Date.now();
  const viewed = require('./viewed').recentIds();
  const rows = repo.db.prepare(`SELECT id, handle, display_name, media_count, popularity FROM creators WHERE status = 'active'
    ORDER BY COALESCE(popularity, 0) DESC, media_count DESC LIMIT 800`).all()
    .map((r, i) => ({ ...r, i, seen: viewed.has(r.id) })).sort((a, b) => (b.seen - a.seen) || (a.i - b.i)); // viewed first, then popularity order
  const results = [];
  for (const c of rows) {
    if (results.length >= limit || aborted()) break;
    const at = Date.parse(repo.discoveryState.get(`coverage.at.${c.id}`, '') || '');
    if (Number.isFinite(at) && now - at < COOLDOWN_DAYS * 86400000) continue;
    const r = await coverCreator(c, { probe, aborted });
    if (!r.handles.length) continue; // nothing to go on: no state written, nothing spent
    repo.discoveryState.set(`coverage.at.${c.id}`, new Date(r.created.length ? now - (COOLDOWN_DAYS - COOLDOWN_FOUND_DAYS) * 86400000 : now).toISOString());
    results.push(r);
  }
  return { started: results.length, creators: results.map((r) => ({ id: r.creatorId, name: r.name, probed: r.probed, created: r.created.length })), created: results.reduce((n, r) => n + r.created.length, 0) };
}

function status() {
  const d = loadDay();
  return { day: d.day, probesToday: d.probes, createdToday: d.created, perPlatformCap: capOf(), platforms: PROBE_PLATFORMS, enabled: !!settingsStore.get().coverageEnabled };
}

module.exports = { coverCreator, rotate, status, confidentHandles, specsFor, readsAsHim, profileRefusal, evidenceContext, reserveProbe, PROBE_PLATFORMS };
