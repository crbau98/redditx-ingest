'use strict';
/**
 * Coverage: for every active creator with a CONFIDENT handle, look for the same account on the platforms PRISM can read, and
 * follow it where it exists and is his.
 *
 * Why this exists (Bigggwild, 2026-11-17): he had hundreds of pictures and videos across coomer, redgifs, fapello, gaysdream and gff,
 * and PRISM showed a few. Deep search (engine/deepsearch) finds pages through budgeted web-search queries, two creators an hour; a
 * handle only entered its queries while one of his feeds was ENABLED. Nothing asked each platform directly "is this account there?".
 * This module does: no web search, one bounded adapter read per candidate account.
 *
 * Safety (same rules as the rest of PRISM):
 *  - only handles with a reason to believe them: a claimed/paid page handle, the account of a feed that already produced items,
 *    or an alias a profile confirmed (not one a bio merely claimed);
 *  - an account that exists is not enough (a namesake has the same handle): it must also read as him (profile name or bio names him,
 *    or its links point at one of his accounts) or be a distinctive handle (9+ characters);
 *  - feeds go through targets.addSpec, so the male-only, safety, body-filter, takedown and blocklist gates all apply, and an account
 *    that belongs to another creator is a conflict, not a second owner;
 *  - X and Telegram are never probed (a probe spends the X search budget / MTProto budget); TikTok stays a link-out.
 * Budgets: a per-platform daily cap, a per-creator cooldown, and the most popular creators first.
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
const COMPACT_DISTINCTIVE = 9;
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

/* -------------------------------------------------------------------- the handles */
/** Handles a creator is known by, strongest evidence first. Disabled productive feeds still count: they say what the account is called. */
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
    for (const r of repo.db.prepare("SELECT handle FROM onlyfans_leads WHERE creator_id = ? AND status != 'rejected'").all(id)) add(r.handle, 'paid page', 0);
    for (const r of repo.db.prepare("SELECT platform, target FROM feeds WHERE creator_id = ? AND COALESCE(items_total, 0) > 0 AND platform NOT IN ('web', 'rss', 'linkinbio')").all(id)) add(accountHandle(r.platform, r.target), 'productive feed', 1);
    for (const r of repo.db.prepare("SELECT alias FROM creator_aliases WHERE creator_id = ? AND source != 'bio'").all(id)) add(r.alias, 'confirmed alias', 2);
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

/**
 * Is the account that exists HIM? A handle match alone is not enough (a namesake has the same handle).
 * Yes when the profile names him or links to one of his accounts, or when the handle is distinctive (9+ characters).
 */
function readsAsHim(creator, handle, hit, knownHandles) {
  const p = hit.profile || {};
  const text = compact(`${p.displayName || ''} ${p.bio || ''}`);
  const names = [creator.display_name, creator.handle, ...knownHandles].map(compact).filter((n) => n.length >= 5);
  if (text && names.some((n) => text.includes(n))) return 'profile names him';
  const links = (p.links || []).map((l) => compact(l.target || l.url || l.handle || '')).filter(Boolean);
  if (links.some((l) => names.some((n) => l.includes(n)))) return 'profile links to his accounts';
  // The probed handle is always one he is known by, so a name match proves nothing for a short, common string: only a DISTINCTIVE
  // handle (9+ letters and digits) may be followed without the profile naming or linking to him.
  if (compact(handle).length >= COMPACT_DISTINCTIVE) return 'distinctive handle';
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
  const known = handles.map((h) => h.handle);
  const t = require('../services/targets');
  const have = new Set(repo.db.prepare('SELECT platform || \'|\' || kind AS k FROM feeds WHERE creator_id = ?').all(creator.id).map((r) => r.k));
  const day = loadDay(); const cap = capOf();
  for (const h of handles) {
    for (const spec of specsFor(h.handle)) {
      if (aborted()) return out;
      if (have.has(`${spec.platform}|${spec.kind}`) || repo.feeds.find(spec.platform, spec.kind, spec.target)) { skip('already followed'); continue; }
      if ((day.probes[spec.platform] || 0) >= cap) { skip('platform daily cap'); continue; }
      if (dryRun) { skip('dry run'); continue; }
      day.probes[spec.platform] = (day.probes[spec.platform] || 0) + 1; out.probed++;
      const hit = await probe(spec);
      if (!hit || !hit.exists) { skip(hit && hit.error ? 'probe error' : 'not there'); continue; }
      const why = readsAsHim(creator, h.handle, hit, known);
      if (!why) { skip('exists but not provably him'); continue; }
      const r = t.addSpec(spec, { creatorId: creator.id, origin: 'coverage', trusted: true });
      if (r.status === 'created' && r.feed) {
        have.add(`${spec.platform}|${spec.kind}`); day.created++;
        out.created.push({ id: r.feed.id, platform: spec.platform, target: spec.target, why });
        events.log('OK', `Coverage: ${out.name} → ${spec.platform}:${spec.target} (${why})`);
      } else skip(r.status === 'conflict' ? 'belongs to another creator' : `refused (${r.status})`);
    }
  }
  saveDay(day);
  if (out.created.length && !config.isTest) {
    try { require('./engine').enqueue(out.created.map((c) => c.id), { force: true, trigger: 'coverage' }); } catch { /* the scheduler picks them up */ }
  }
  return out;
}

/** Hourly: the most popular creators not looked at lately. Bounded by `limit` creators and the per-platform daily caps. */
async function rotate({ limit = 4, probe = defaultProbe, aborted = () => false } = {}) {
  if (!settingsStore.get().coverageEnabled) return { started: 0, creators: [], skipped: 'off in Settings' };
  const now = Date.now();
  const rows = repo.db.prepare(`SELECT id, handle, display_name, media_count, popularity FROM creators WHERE status = 'active'
    ORDER BY COALESCE(popularity, 0) DESC, media_count DESC LIMIT 800`).all();
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

module.exports = { coverCreator, rotate, status, confidentHandles, specsFor, readsAsHim, PROBE_PLATFORMS };
