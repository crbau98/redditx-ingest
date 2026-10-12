'use strict';
/**
 * Discovery: find creators PRISM is not following yet, score them on
 * independent signals, and follow the strong ones automatically.
 *
 * Signals (each counted once per distinct source, with caps):
 *   identity  web search found this account under the *same name* as a creator
 *             we already follow → it is that creator's other account (linked)
 *   mention   a followed creator @-mentioned / linked the account in a post
 *             (collabs, shout-outs) — the strongest organic signal
 *   cofollow  followed Bluesky creators follow this account
 *   search    a web search on one of the admin's topics surfaced the profile, or
 *             a keyword search found the community / custom feed (v4.6)
 * plus a bonus for reach (subscribers / followers / likes, log-scaled, up to +3),
 * a bonus when the name/bio reads male-focused, and a heavy penalty when
 * it reads female-focused. Everything passes the same safety gate as ingest:
 * a blocked bio rejects the candidate permanently.
 *
 * Network budget: Bluesky graph reads are free; web searches go through Brave
 * with a per-day cap (Admin → Settings). Mention mining is pure SQL.
 */
const config = require('../config');
const repo = require('../db/repo');
const settingsStore = require('../settings');
const events = require('./events');
const brave = require('../lib/brave');
const tgBot = require('../lib/telegram-bot');
const registry = require('../sources');
const { parseProfile, extractLinks, profileUrl } = require('../lib/links');
const { checkText } = require('../lib/safety');
const { classify } = require('../lib/scope');
const bskyHttp = require('../sources/http').forPlatform('bluesky', 400);

const WEIGHTS = { identity: 6, mention: 3, cofollow: 1.5, search: 2 };
const CAPS = { identity: 1, mention: 5, cofollow: 8, search: 3 };
const FOLLOWABLE_KINDS = new Set(['user', 'page']);
// Words that suggest an account publishes adult/creator content (used to keep follow-graph noise out).
const CREATOR_HINT = /onlyfans|fansly|justfor\.?fans|18\s*\+|🔞|nsfw|\bnude|\bxxx\b|\bporn|\bcontent creator|\bcreator\b|\bmodel\b|linktr\.ee|allmylinks|beacons\.ai|throne|\bfeet\b|\bgay\b|\bbi\b|\bmuscle|\btwink|\bbear\b|\bjock|\bdaddy|\bhung\b|\bbulge|\bm4m\b/i;

/** Same person, different platform? Compare handles stripped to their core. */
function coreHandle(h) {
  return String(h || '').toLowerCase()
    .replace(/^@|^u\//, '').split('@')[0]
    .replace(/\.bsky\.social$/, '').replace(/\.(bsky|social|xyz|com|net|app)$/, '')
    .replace(/[^a-z0-9]/g, '');
}

function scoreOf(signals, scope) {
  let s = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) s += w * Math.min((signals[k] || []).length, CAPS[k]);
  const pop = Number(signals.popularity) || 0;
  if (pop >= 100) s += Math.min(3, Math.log10(pop) - 1);
  if (scope === 'in') s += 2;
  if (scope === 'excluded') s -= 20;
  return Math.round(s * 10) / 10;
}

function describeSignals(sig) {
  return Object.entries(sig).filter(([k, v]) => WEIGHTS[k] && v.length).map(([k, v]) => `${v.length} ${k}${v.length === 1 ? '' : 's'}`).join(', ');
}

/** Is this spec something discovery may follow at all? */
function usable(spec) {
  if (!spec || spec.external || !spec.ingestable) return false;
  if (spec.platform === 'web' || spec.platform === 'rss') return false; // arbitrary sites are too noisy to auto-follow
  if (spec.kind === 'community' && (spec.platform === 'reddit' || spec.platform === 'lemmy')) return true;
  if (spec.platform === 'bluesky' && (spec.kind === 'feedgen' || spec.kind === 'list')) return true;
  if (!FOLLOWABLE_KINDS.has(spec.kind)) return false;
  if (spec.kind === 'page' && spec.platform !== 'linkinbio') return false;
  const a = registry.get(spec.platform);
  return !!a && a.kinds.includes(spec.kind);
}

/**
 * Record one signal for an account. Creates the candidate if needed.
 * @returns the candidate row, or null when it is already followed / blocked / unusable
 */
function consider(spec, type, value, meta = {}) {
  if (!usable(spec)) return null;
  const target = String(spec.target);
  if (repo.feeds.find(spec.platform, spec.kind, target)) return null;               // already following it
  if (repo.blocklist.has('creator', `${spec.platform}:${target.toLowerCase()}`)) return null;
  let c = repo.candidates.find(spec.platform, spec.kind, target);
  if (c && c.status !== 'pending') return c;

  const displayName = meta.displayName || (c && c.display_name) || null;
  const bio = meta.bio || (c && c.bio) || null;
  const verdict = checkText(target, spec.label, displayName, bio);
  if (verdict.level === 'block') {
    const row = { status: 'rejected', reason: `safety: ${verdict.rule || 'blocked'}`, decided_at: new Date().toISOString() };
    if (c) return repo.candidates.update(c.id, row);
    return repo.candidates.insert({ platform: spec.platform, kind: spec.kind, target, label: spec.label, url: spec.url || profileUrl(spec.platform, spec.kind, target), signals: {}, ...row });
  }

  const signals = { ...(c ? c.signals : {}) };
  const list = new Set(signals[type] || []);
  if (value) list.add(String(value).slice(0, 120));
  signals[type] = [...list].slice(0, 25);
  if (meta.popularity) signals.popularity = Math.max(Number(signals.popularity) || 0, Math.round(Number(meta.popularity)) || 0);
  const scope = classify([displayName, bio, target], { trusted: false }).scope;
  const score = scoreOf(signals, scope);
  const fields = {
    label: spec.label || (c && c.label) || target, url: spec.url || (c && c.url) || profileUrl(spec.platform, spec.kind, target),
    display_name: displayName, bio, avatar_url: meta.avatarUrl || (c && c.avatar_url) || null, signals, scope, score,
  };
  if (meta.creatorId) fields.creator_id = meta.creatorId;
  // Borderline wording (e.g. "teen") never auto-follows; a human decides.
  if (verdict.level === 'review') fields.reason = `needs review: ${verdict.rule}`;
  if (c) return repo.candidates.update(c.id, fields);
  return repo.candidates.insert({ platform: spec.platform, kind: spec.kind, target, ...fields });
}

/* ------------------------------------------------------------ strategies */

const MENTION_PATTERNS = {
  x: [/(?:^|[^\w@/.])@([A-Za-z0-9_]{3,15})\b(?![.@]\w)/g, (h) => `https://x.com/${h}`],
  bluesky: [/(?:^|[^\w@/])@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi, (h) => `https://bsky.app/profile/${h.replace(/\.$/, '')}`],
};

/** Accounts creators mention in their own posts (collabs, shout-outs). Pure SQL + regex. */
function mineMentions(limit = 3000) {
  const cursor = repo.discoveryState.get('mentions.cursor', '');
  const rows = repo.mentionSource(cursor, limit);
  let found = 0;
  let last = cursor;
  for (const r of rows) {
    last = r.ingested_at;
    const text = `${r.title || ''}\n${r.description || ''}`;
    const specs = [];
    const pat = MENTION_PATTERNS[r.platform];
    if (pat) for (const m of text.matchAll(pat[0])) specs.push(parseProfile(pat[1](m[1])));
    for (const m of text.matchAll(/@([A-Za-z0-9_]{2,30})@([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})/gi)) specs.push(parseProfile(`@${m[1]}@${m[2]}`));
    for (const m of text.matchAll(/(?:^|[^\w/])\/?u\/([A-Za-z0-9_-]{3,20})\b/g)) specs.push(parseProfile(`u/${m[1]}`));
    for (const m of text.matchAll(/(?:^|[^\w/])\/?r\/([A-Za-z0-9_]{3,21})\b/g)) specs.push(parseProfile(`r/${m[1]}`));
    specs.push(...extractLinks(text));
    // Bare profile links ("bsky.app/profile/x", "t.me/x", "linktr.ee/x") are how people usually type them.
    for (const m of text.matchAll(/(?:^|[\s(])((?:bsky\.app|x\.com|twitter\.com|t\.me|linktr\.ee|allmylinks\.com|beacons\.ai|redgifs\.com|reddit\.com)\/[^\s)<>"']+)/gi)) specs.push(parseProfile(`https://${m[1]}`));
    const seen = new Set();
    for (const spec of specs) {
      if (!spec) continue;
      const key = `${spec.platform}:${spec.kind}:${String(spec.target).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // a creator mentioning their own other account is an identity link, not a recommendation
      const owner = spec.kind === 'user' ? repo.creators.byAccount(spec.platform, spec.target) : null;
      if (owner) continue;
      if (consider(spec, 'mention', r.creator_id)) found++;
    }
  }
  if (last && last !== cursor) repo.discoveryState.set('mentions.cursor', last);
  return { scanned: rows.length, found };
}

/** Who do followed Bluesky creators follow? Accounts followed by several of them are strong leads. */
async function blueskyGraph({ creators = 4, aborted = () => false } = {}) {
  const targets = repo.discoveryTargets({ platform: 'bluesky', prefix: 'bsky.follows.', staleDays: 7, limit: creators });
  let found = 0; let checked = 0;
  for (const t of targets) {
    if (aborted()) break;
    try {
      const json = await bskyHttp.json(`${config.baseUrls.bsky}/xrpc/app.bsky.graph.getFollows?actor=${encodeURIComponent(t.target)}&limit=100`);
      checked++;
      for (const p of json.follows || []) {
        const labels = (p.labels || []).map((l) => l.val);
        if (labels.includes('!no-unauthenticated')) continue;
        const spec = parseProfile(`https://bsky.app/profile/${p.handle}`);
        if (!spec) continue;
        const adult = labels.some((l) => ['porn', 'sexual', 'nudity'].includes(l));
        const existing = repo.candidates.find(spec.platform, spec.kind, spec.target);
        // Only open a new candidate for accounts that look like creators; always add to existing ones.
        if (!existing && !adult && !CREATOR_HINT.test(`${p.displayName || ''} ${p.description || ''}`)) continue;
        if (consider(spec, 'cofollow', t.id, { displayName: p.displayName, bio: p.description, avatarUrl: p.avatar })) found++;
      }
    } catch (e) { events.log('WARN', `Discovery: Bluesky follows of ${t.target} — ${e.message}`); }
    repo.discoveryState.set(`bsky.follows.${t.id}`, new Date().toISOString());
  }
  return { checked, found };
}

/** Find a known creator's other accounts by searching the web for their exact handle. */
async function braveIdentity({ creators = 3, budget, aborted = () => false } = {}) {
  const targets = repo.discoveryTargets({ prefix: 'brave.identity.', staleDays: 30, limit: creators, minMedia: 3, maxAccounts: 2 })
    .filter((t) => coreHandle(t.handle).length >= 5);
  let linked = 0; let searched = 0;
  for (const t of targets) {
    if (aborted()) break;
    const core = coreHandle(t.handle);
    let results;
    try { results = await brave.search(`"${core}" (onlyfans OR bluesky OR twitter OR reddit OR redgifs OR telegram OR linktree)`, { budget }); searched++; } catch (e) {
      if (e.budget || e.skip) break; // out of budget: try this creator again next time
      events.log('WARN', `Discovery: web search for ${t.handle} failed — ${e.message}`);
      results = [];
    }
    repo.discoveryState.set(`brave.identity.${t.id}`, new Date().toISOString());
    for (const r of results) {
      const spec = parseProfile(r.url);
      if (!usable(spec) || spec.kind === 'community') continue;
      const handle = spec.platform === 'linkinbio' ? new URL(spec.target).pathname.split('/').filter(Boolean)[0] : spec.target;
      if (coreHandle(handle) !== core) continue;
      const c = consider(spec, 'identity', t.id, { displayName: t.display_name, creatorId: t.id });
      if (c) linked++;
    }
  }
  return { searched, linked };
}

/** Rotate through the admin's topic searches; every profile link in the results becomes a lead. */
async function braveTopics({ queries = 1, budget, aborted = () => false } = {}) {
  const list = String(settingsStore.get().discoveryQueries || '').split('\n').map((q) => q.trim()).filter(Boolean);
  if (!list.length) return { searched: 0, found: 0 };
  let idx = parseInt(repo.discoveryState.get('brave.topics.index', '0'), 10) || 0;
  let found = 0; let searched = 0;
  for (let i = 0; i < queries; i++) {
    if (aborted()) break;
    const q = list[idx % list.length];
    idx++;
    let results;
    try { results = await brave.search(q, { budget }); searched++; } catch (e) {
      if (e.budget || e.skip) break;
      events.log('WARN', `Discovery: web search "${q}" failed — ${e.message}`);
      continue;
    }
    for (const r of results) {
      const specs = [parseProfile(r.url), ...extractLinks(`${r.description} ${r.title}`)];
      for (const spec of specs) if (consider(spec, 'search', q, { displayName: (r.title || '').split(/[(|•·-]/)[0].trim() || null, bio: r.description || null })) found++;
    }
  }
  repo.discoveryState.set('brave.topics.index', String(idx % Math.max(1, list.length)));
  return { searched, found };
}

// Custom feeds and communities have to read adult/creator-ish to be worth a lead (keeps out news and art-only feeds).
const ADULT_HINT = /nsfw|18\s*\+|🔞|\bnude|\bnaked|\bporn|\bxxx\b|\bhot\b|sexy|thirst|bulge|muscle|hunk|daddy|daddies|twink|\bbears?\b|\bjocks?\b|\bcock|\bdick|horny|kink|leather|underwear|speedo|jockstrap|\bhung\b|\bgay\b|gaybros|\bm4m\b|\bhairy/i;
// Shared spaces are held to a stricter bar than people: borderline wording ("teen", "young") is not
// queued for review, it is dropped. CamelCase names ("TeenBoysNSFW") are split so the gate can read them.
const splitCamel = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
const borderline = (...texts) => checkText(...texts.map(splitCamel)).level === 'review';
const keywordList = () => String(settingsStore.get().discoveryKeywords || '').split('\n').map((k) => k.trim()).filter(Boolean);

/**
 * Reach beyond who we already follow: search Reddit for NSFW subreddits, Bluesky for popular
 * custom feeds, and list the busiest NSFW communities on known Lemmy instances (once a day).
 * Keywords rotate (two per run). Every hit is a 'search' signal plus its audience size.
 */
async function communityDiscovery({ keywords = 2, aborted = () => false } = {}) {
  const list = keywordList();
  const out = { searched: 0, found: 0, reddit: 0, bluesky: 0, lemmy: 0 };
  const reddit = registry.get('reddit'); const bluesky = registry.get('bluesky'); const lemmy = registry.get('lemmy');
  let idx = parseInt(repo.discoveryState.get('community.index', '0'), 10) || 0;
  for (let i = 0; i < Math.min(keywords, list.length); i++) {
    if (aborted()) break;
    const kw = list[idx % list.length];
    idx++;
    if (reddit && reddit.searchSubreddits) {
      try {
        out.searched++;
        for (const sr of await reddit.searchSubreddits(kw, 25)) {
          if (!sr.over18 || borderline(sr.name, sr.title, sr.description)) continue; // SFW subs rarely carry the media this app is for
          const c = consider(parseProfile(`r/${sr.name}`), 'search', `reddit:${kw}`, { displayName: sr.title || splitCamel(sr.name), bio: sr.description, popularity: sr.subscribers, avatarUrl: sr.icon });
          if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.reddit++; }
        }
      } catch (e) { events.log('WARN', `Discovery: Reddit community search "${kw}" — ${e.message}`); }
    }
    if (aborted()) break;
    if (bluesky && bluesky.searchFeeds) {
      try {
        out.searched++;
        for (const f of await bluesky.searchFeeds(kw, 25)) {
          if (!ADULT_HINT.test(`${f.displayName || ''} ${f.description || ''}`) || borderline(f.displayName, f.description)) continue;
          const spec = parseProfile(f.uri);
          if (spec && f.displayName) spec.label = `Feed: ${f.displayName}`;
          const c = consider(spec, 'search', `bluesky:${kw}`, { displayName: f.displayName, bio: f.description, popularity: f.likeCount, avatarUrl: f.avatar });
          if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.bluesky++; }
        }
      } catch (e) { events.log('WARN', `Discovery: Bluesky feed search "${kw}" — ${e.message}`); }
    }
  }
  if (list.length) repo.discoveryState.set('community.index', String(idx % list.length));
  if (lemmy && lemmy.listCommunities) {
    for (const host of config.lemmyInstances || []) {
      if (aborted()) break;
      const key = `lemmy.list.${host}`;
      const last = new Date(repo.discoveryState.get(key, '') || 0).getTime();
      if (Date.now() - last < 24 * 3600 * 1000) continue;
      try {
        out.searched++;
        for (const lc of await lemmy.listCommunities(host, 50)) {
          if (!lc.nsfw || borderline(lc.name, lc.title, lc.description)) continue;
          const c = consider(parseProfile(`https://${lc.host}/c/${lc.name}`), 'search', `lemmy:${host}`, { displayName: lc.title, bio: lc.description, popularity: lc.subscribers });
          if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.lemmy++; }
        }
      } catch (e) { events.log('WARN', `Discovery: Lemmy communities on ${host} — ${e.message}`); }
      repo.discoveryState.set(key, new Date().toISOString());
    }
  }
  return out;
}

/** Fill in names/bios for Telegram, Bluesky and X leads so scope and safety can judge them. */
async function enrich({ limit = 12 } = {}) {
  let done = 0;
  if (tgBot.configured()) {
    for (const c of repo.candidates.needingDetails('telegram', limit)) {
      try {
        const info = await tgBot.channelInfo(c.target);
        if (!info) { repo.candidates.update(c.id, { status: 'rejected', reason: 'Telegram: channel not found or private', decided_at: new Date().toISOString() }); continue; }
        const scope = classify([info.title, info.description, c.target], { trusted: false }).scope;
        const verdict = checkText(c.target, info.title, info.description);
        if (verdict.level === 'block') { repo.candidates.update(c.id, { status: 'rejected', reason: 'safety', decided_at: new Date().toISOString() }); continue; }
        repo.candidates.update(c.id, { display_name: info.title, bio: info.description || '', scope, score: scoreOf(c.signals, scope), reason: verdict.level === 'review' ? `needs review: ${verdict.rule}` : 'checked' });
        done++;
      } catch (e) { repo.candidates.update(c.id, { reason: 'checked' }); events.log('WARN', `Discovery: ${e.message}`); }
    }
  }
  const bsky = repo.candidates.needingDetails('bluesky', 25);
  if (bsky.length) {
    try {
      const qs = bsky.map((c) => `actors=${encodeURIComponent(c.target)}`).join('&');
      const json = await bskyHttp.json(`${config.baseUrls.bsky}/xrpc/app.bsky.actor.getProfiles?${qs}`);
      const byHandle = new Map((json.profiles || []).map((p) => [String(p.handle).toLowerCase(), p]));
      for (const c of bsky) {
        const p = byHandle.get(String(c.target).toLowerCase());
        if (!p) { repo.candidates.update(c.id, { reason: 'checked' }); continue; }
        const verdict = checkText(c.target, p.displayName, p.description);
        if (verdict.level === 'block') { repo.candidates.update(c.id, { status: 'rejected', reason: 'safety', decided_at: new Date().toISOString() }); continue; }
        const scope = classify([p.displayName, p.description, c.target], { trusted: false }).scope;
        repo.candidates.update(c.id, { display_name: p.displayName || null, bio: p.description || '', avatar_url: p.avatar || null, scope, score: scoreOf(c.signals, scope), reason: verdict.level === 'review' ? `needs review: ${verdict.rule}` : 'checked' });
        done++;
      }
    } catch (e) { events.log('WARN', `Discovery: Bluesky profile lookup — ${e.message}`); }
  }
  // X: one batched users lookup (counts against the monthly read budget; skipped when it is spent).
  const xa = registry.get('x');
  if (xa && xa.lookupUsers && xa.apiAvailable && xa.apiAvailable()) {
    const xs = repo.candidates.needingDetails('x', 50);
    if (xs.length) {
      try {
        const users = await xa.lookupUsers(xs.map((c) => c.target));
        const byName = new Map(users.map((u) => [String(u.username).toLowerCase(), u]));
        for (const c of xs) {
          const u = byName.get(String(c.target).toLowerCase());
          if (!u) { repo.candidates.update(c.id, { reason: 'checked' }); continue; } // suspended, renamed or protected
          const verdict = checkText(c.target, u.name, u.description);
          if (verdict.level === 'block') { repo.candidates.update(c.id, { status: 'rejected', reason: 'safety', decided_at: new Date().toISOString() }); continue; }
          const scope = classify([u.name, u.description, c.target], { trusted: false }).scope;
          const signals = { ...c.signals, popularity: Math.max(Number(c.signals.popularity) || 0, u.followers || 0) };
          repo.candidates.update(c.id, { display_name: u.name || null, bio: u.description || '', avatar_url: u.avatar || null, signals, scope, score: scoreOf(signals, scope), reason: verdict.level === 'review' ? `needs review: ${verdict.rule}` : 'checked' });
          done++;
        }
      } catch (e) { events.log('WARN', `Discovery: X profile lookup — ${e.message}`); }
    }
  }
  return { enriched: done };
}

/* -------------------------------------------------------------- decisions */

/** Follow (or link) one candidate. Used by auto-follow and by the admin "Follow" button. */
function follow(candidate, { actor = 'discovery' } = {}) {
  const c = typeof candidate === 'string' ? repo.candidates.get(candidate) : candidate;
  if (!c) return { ok: false, reason: 'Not found' };
  if (c.status === 'followed' || c.status === 'linked') return { ok: true, already: true };
  const targets = require('../services/targets');
  const spec = { platform: c.platform, kind: c.kind, target: c.target, label: c.label || c.target, ingestable: true };
  const identity = (c.signals.identity || [])[0];
  // Communities and custom feeds mix many posters: when discovery follows one on its own, every
  // post is still scope-checked (untrusted). A human follow trusts it like an admin-added source.
  const shared = c.kind === 'community' || c.kind === 'feedgen' || c.kind === 'list';
  const trusted = actor !== 'discovery' ? true : shared ? false : c.scope === 'in' || !!identity;
  const r = targets.addSpec(spec, { creatorId: identity || null, origin: 'discovered', trusted });
  if (r.status !== 'created' && r.status !== 'exists') {
    repo.candidates.update(c.id, { status: 'rejected', reason: r.reason || r.status, decided_at: new Date().toISOString() });
    return { ok: false, reason: r.reason || r.status };
  }
  const status = identity ? 'linked' : 'followed';
  repo.candidates.update(c.id, { status, creator_id: (r.creator && r.creator.id) || identity || null, decided_at: new Date().toISOString(), reason: actor === 'discovery' ? `auto (score ${c.score})` : `by ${actor}` });
  if (r.creator && c.display_name) repo.creators.enrich(r.creator.id, { displayName: c.display_name, bio: c.bio || null, avatarUrl: c.avatar_url || null });
  repo.logAction('candidate', c.id, status === 'linked' ? 'link' : 'follow', describeSignals(c.signals) || null, actor);
  try { require('./engine').enqueue([r.feed.id], { trigger: 'discovery', front: false }); } catch { /* engine not running (tests) */ }
  return { ok: true, status, feed: r.feed, creator: r.creator };
}

function reject(id, { reason = 'rejected by admin', actor = 'admin', block = false } = {}) {
  const c = repo.candidates.get(id);
  if (!c) return null;
  if (block) repo.blocklist.add('creator', `${c.platform}:${String(c.target).toLowerCase()}`, reason);
  repo.logAction('candidate', c.id, block ? 'block' : 'reject', reason, actor);
  return repo.candidates.update(id, { status: 'rejected', reason, decided_at: new Date().toISOString() });
}

/** Auto-follow the strongest pending candidates, within the feed cap. */
function promote(s = settingsStore.get()) {
  const capacity = Math.max(0, s.maxFeeds - repo.feeds.countEnabled());
  const limit = Math.min(s.discoveryMaxFollowsPerRun, capacity);
  if (!limit) return { followed: 0, linked: 0 };
  let followed = 0; let linked = 0;
  for (const c of repo.candidates.promotable(s.discoveryAutoFollowScore, limit * 2)) {
    if (followed + linked >= limit) break;
    const shared = c.kind === 'community' || c.kind === 'feedgen' || c.kind === 'list';
    if (shared && (!s.discoveryAutoCommunities || c.scope !== 'in')) continue; // shared spaces need the switch and a male-focused description
    if (c.scope !== 'in' && !(c.signals.identity || []).length) continue; // need a male signal unless it is a known creator
    const r = follow(c);
    if (r.ok && !r.already) {
      if (r.status === 'linked') linked++; else followed++;
      events.log('OK', `Discovery: ${r.status === 'linked' ? 'linked' : 'followed'} ${c.platform}:${c.target} (score ${c.score}: ${describeSignals(c.signals)})`);
    }
  }
  return { followed, linked };
}

/* -------------------------------------------------------------------- run */
let running = false;
let timer = null;
let stopFlag = false;

async function run({ trigger = 'schedule' } = {}) {
  if (running) return { skipped: 'already running' };
  running = true; stopFlag = false;
  const s = settingsStore.get();
  const aborted = () => stopFlag;
  const started = Date.now();
  const report = { trigger, startedAt: new Date(started).toISOString() };
  try {
    report.mentions = mineMentions();
    if (s.discoveryGraph) report.graph = await blueskyGraph({ aborted });
    if (brave.configured() && s.braveDailyBudget > 0) {
      report.identity = await braveIdentity({ budget: s.braveDailyBudget, aborted });
      report.topics = await braveTopics({ budget: s.braveDailyBudget, aborted });
    }
    if (s.discoveryCommunities) report.communities = await communityDiscovery({ aborted });
    report.enrich = await enrich();
    report.promote = s.autoDiscover || trigger === 'manual' ? promote(s) : { followed: 0, linked: 0 };
    report.pruned = repo.candidates.prune();
    events.log('INFO', `Discovery ${trigger === 'manual' ? '(manual) ' : ''}finished: ${report.mentions.found} mention leads, ${report.graph ? report.graph.found : 0} graph leads, ${report.topics ? report.topics.found : 0} search leads, ${report.communities ? report.communities.found : 0} community/feed leads, ${report.identity ? report.identity.linked : 0} identity matches; followed ${report.promote.followed}, linked ${report.promote.linked}`);
  } catch (e) {
    report.error = e.message;
    events.log('ERR', `Discovery failed: ${e.message}`);
  } finally {
    report.durationMs = Date.now() - started;
    repo.discoveryState.set('lastRun', JSON.stringify(report));
    running = false;
  }
  return report;
}

function status() {
  let last = null;
  try { last = JSON.parse(repo.discoveryState.get('lastRun') || 'null'); } catch { last = null; }
  const s = settingsStore.get();
  return {
    running, last, counts: repo.candidates.counts(),
    brave: { configured: brave.configured(), usage: brave.usage(), budget: s.braveDailyBudget },
    telegramBot: tgBot.configured(), xApi: !!config.creds.xBearer, communities: s.discoveryCommunities, autoCommunities: s.discoveryAutoCommunities,
    auto: s.autoDiscover, intervalMin: s.discoveryIntervalMin, threshold: s.discoveryAutoFollowScore,
  };
}

/** Background loop: checks every 5 minutes whether a run is due (so interval changes apply live). */
function start() {
  if (timer) return;
  timer = setInterval(() => {
    const s = settingsStore.get();
    if (!s.schedulerEnabled || !s.autoDiscover || running) return;
    let last = 0;
    try { last = new Date(JSON.parse(repo.discoveryState.get('lastRun') || '{}').startedAt || 0).getTime(); } catch { last = 0; }
    if (Date.now() - last >= s.discoveryIntervalMin * 60000) run().catch(() => {});
  }, 5 * 60 * 1000);
  timer.unref();
}
function stop() { stopFlag = true; clearInterval(timer); timer = null; }

module.exports = { run, status, start, stop, follow, reject, promote, consider, mineMentions, blueskyGraph, braveIdentity, braveTopics, communityDiscovery, enrich, scoreOf, coreHandle, usable };
