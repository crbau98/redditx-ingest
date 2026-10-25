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
const websearch = require('../lib/websearch');
const tgBot = require('../lib/telegram-bot');
const registry = require('../sources');
const { parseProfile, extractLinks, profileUrl, linkHubHandle } = require('../lib/links');
const { classify, femaleCheck } = require('../lib/scope');
const physiqueText = require('../lib/physique').textCheck;

/** Body filter on and the name / bio reads chub, gainer, dad bod ...: the rule that matched, else null. */
function heavyRule(...texts) {
  if (!settingsStore.get().physiqueFilter) return null;
  const t = physiqueText(...texts);
  return t.heavy ? t.rule : null;
}
const { findOnlyFans, freeHint, ofLink, creatorOnlyFans } = require('../lib/onlyfans');
const leadKey = (service, handle) => (service && service !== 'OnlyFans' ? `${service}:${handle}` : handle);
function splitLead(key) {
  const i = String(key || '').indexOf(':');
  if (i > 0 && paid.SERVICES[String(key).slice(0, i)]) return { service: String(key).slice(0, i), handle: String(key).slice(i + 1) };
  return { service: 'OnlyFans', handle: String(key || '') };
}
const bskyHttp = require('../sources/http').forPlatform('bluesky', 400);

// similar: Bluesky lists the account among those most like a followed creator (per creator, max 4)
// hangout: a community where several followed creators post (per creator, max 6)
// ofconfirmed: the account links to the exact OnlyFans page we were looking for (same person, proven)
// onlyfans: the account has the same handle as an OnlyFans page creators promote (likely the same person)
const WEIGHTS = { identity: 6, mention: 3, cofollow: 1.5, search: 2, similar: 2, hangout: 1.5, ofconfirmed: 8, onlyfans: 2 };
const CAPS = { identity: 1, mention: 5, cofollow: 8, search: 3, similar: 4, hangout: 6, ofconfirmed: 1, onlyfans: 1 };
const FOLLOWABLE_KINDS = new Set(['user', 'page']);
// Communities and custom feeds mix many posters, so they are held to a stricter bar than people.
const SHARED_KINDS = new Set(['community', 'feedgen', 'list', 'niche']);
// CamelCase / snake_case names ("TeenBoysNSFW") are split so the safety gate can read their words.
const splitCamel = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
/** Safety verdict over the raw texts and their split forms; the stricter of the two wins. */
function gate(...texts) {
  const raw = checkText(...texts);
  const split = checkText(...texts.map(splitCamel));
  if (raw.level === 'block') return raw;
  if (split.level === 'block') return split;
  return raw.level ? raw : split;
}
const borderline = (...texts) => gate(...texts).level === 'review';
// Unmistakable "I publish adult content" wording. Keyword people search needs this (or an adult
// label): a bio that merely says "gay" matches every keyword and is not a creator.
const CREATOR_STRONG = /onlyfans|fansly|justfor\.?fans|18\s*\+|🔞|nsfw|\bnude|\bxxx\b|\bporn|\bcontent creator|\bcreator\b|\bmodel\b|linktr\.ee|allmylinks|beacons\.ai|throne|\bm4m\b|\bhung\b|\bbulge/i;
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
  if (spec.kind === 'community' && (spec.platform === 'reddit' || spec.platform === 'lemmy')) return true;
  if (spec.kind === 'niche' && spec.platform === 'redgifs') return true;
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
  if (takedowns.checkHandle(target, spec.platform) || (spec.url && takedowns.checkUrl(spec.url))) return null;
  let c = repo.candidates.find(spec.platform, spec.kind, target);
  if (c && c.status !== 'pending') return c;

  const displayName = meta.displayName || (c && c.display_name) || null;
  const bio = meta.bio || (c && c.bio) || null;
  const verdict = gate(target, spec.label, displayName, bio);
  // Borderline wording waits for a human on a person, but a shared space with it is rejected outright,
  // whichever strategy found it (mentions, web search or community search).
  if (verdict.level === 'block' || (verdict.level === 'review' && SHARED_KINDS.has(spec.kind))) {
    const row = { status: 'rejected', reason: `safety: ${verdict.rule || 'blocked'}${verdict.level === 'review' ? ' (community)' : ''}`, decided_at: new Date().toISOString() };
    if (c) return repo.candidates.update(c.id, row);
    return repo.candidates.insert({ platform: spec.platform, kind: spec.kind, target, label: spec.label, url: spec.url || profileUrl(spec.platform, spec.kind, target), signals: {}, ...row });
  }

  // Male-only: a female / feminine / trans-feminine name, bio or community is rejected for good, never queued.
  // Fit / athletic only: chub, gainer, dad-bod people and spaces are rejected the same way (body filter).
  const gender = femaleCheck(target, spec.label, displayName, bio);
  const heavy = gender.level === 'hard' ? null : heavyRule(target, spec.label, displayName, bio);
  if (gender.level === 'hard' || heavy) {
    const row = { status: 'rejected', reason: heavy ? `body filter: ${heavy}` : `scope: ${gender.rule}`, decided_at: new Date().toISOString() };
    if (c) return repo.candidates.update(c.id, row);
    return repo.candidates.insert({ platform: spec.platform, kind: spec.kind, target, label: spec.label, url: spec.url || profileUrl(spec.platform, spec.kind, target), signals: {}, ...row });
  }

  const signals = { ...(c ? c.signals : {}) };
  // proof that an account is the creator behind an OnlyFans page supersedes the guess from the handle alone
  if (type === 'ofconfirmed' && signals.onlyfans) delete signals.onlyfans;
  if (type === 'onlyfans' && (signals.ofconfirmed || []).length) return c;
  const list = new Set(signals[type] || []);
  if (value) list.add(String(value).slice(0, 120));
  signals[type] = [...list].slice(0, 25);
  if (meta.ofSources) signals.ofsrc = Math.max(Number(signals.ofsrc) || 0, Number(meta.ofSources) || 0);
  if (type === 'ofconfirmed') signals.ofsrc = Math.max(Number(signals.ofsrc) || 0, 1);
  if (meta.popularity) signals.popularity = Math.max(Number(signals.popularity) || 0, Math.round(Number(meta.popularity)) || 0);
  const scope = classify([displayName, bio, target], { trusted: false }).scope;
  if (bio && !(signals.ofconfirmed || []).length) {
    const own = spec.platform === 'linkinbio' ? (linkHubHandle(target) || (() => { try { return new URL(target).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; } })()) : target;
    for (const { service, handle } of paid.findPaidHandles(bio)) {
      if (!paid.SERVICES[service] || !paid.SERVICES[service].trace || !paid.pageLinked(service, bio, handle)) continue;
      const key = leadKey(service, handle);
      const lead = repo.onlyfans.get(handle, service);
      const activeLead = lead && lead.status !== 'rejected' && lead.status !== 'claimed';
      const matchesQueued = (signals.onlyfans || []).includes(key);
      if (matchesQueued || ((spec.platform === 'linkinbio' || sameName(own, handle)) && (activeLead || scope === 'in'))) {
        signals.ofconfirmed = [key];
        delete signals.onlyfans;
        signals.ofsrc = Math.max(Number(signals.ofsrc) || 0, (lead && (lead.sources.length || lead.mentions)) || 1);
        break;
      }
    }
  }
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
    notePaidHandles(text, r.creator_id);
    // Bare profile links ("bsky.app/profile/x", "t.me/x", "linktr.ee/x", "bento.me/x") are how people usually type them.
    for (const m of text.matchAll(/(?:^|[\s(])((?:bsky\.app|x\.com|twitter\.com|t\.me|linktr\.ee|allmylinks\.com|beacons\.ai|carrd\.co|campsite\.bio|solo\.to|bento\.me|direct\.me|milkshake\.app|msha\.ke|hoo\.be|snipfeed\.co|lnk\.bio|taplink\.cc|redgifs\.com|reddit\.com)\/[^\s)<>"']+)/gi)) specs.push(parseProfile(`https://${m[1]}`));
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

/** "gymjake" and "GymJake_X" are the same name; short or unrelated handles are not. */
function sameName(a, b) {
  const x = coreHandle(a); const y = coreHandle(b);
  if (x.length < 4 || y.length < 4) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.length - short.length <= 3 && (long.startsWith(short) || long.endsWith(short));
}

/**
 * Paid pages named in a post. A creator naming a page with their own handle is telling us it is
 * theirs; any other page is a shout-out or a promo channel featuring someone: a lead to work later.
 * OnlyFans, Fansly and JustFor.Fans are traced and read.
 */
function notePaidHandles(text, creatorId) {
  const found = paid.findPaidHandles(text).filter((p) => paid.SERVICES[p.service] && paid.SERVICES[p.service].trace);
  if (!found.length) return 0;
  const creator = creatorId ? repo.creators.get(creatorId) : null;
  const free = freeHint(text);
  let n = 0;
  for (const { service, handle } of found) {
    if (creator && sameName(handle, creator.handle)) {
      repo.creators.enrich(creator.id, { links: [paid.paidLink(service, handle, { free })] });
      repo.onlyfans.claim(handle, creator.id, service);
      continue;
    }
    const lead = repo.onlyfans.get(handle, service);
    if (lead && (lead.status === 'claimed' || lead.status === 'rejected')) continue;
    repo.onlyfans.note(handle, { service, sourceId: creatorId, origin: 'post', free });
    n++;
  }
  return n;
}
/** @deprecated use notePaidHandles (kept for OnlyFans-only callers) */
function noteOnlyFans(text, creatorId) {
  const handles = findOnlyFans(text);
  if (!handles.length) return 0;
  const creator = creatorId ? repo.creators.get(creatorId) : null;
  const free = freeHint(text);
  let n = 0;
  for (const handle of handles) {
    if (creator && sameName(handle, creator.handle)) {
      repo.creators.enrich(creator.id, { links: [ofLink(handle, { free })] });
      repo.onlyfans.claim(handle, creator.id);
      continue;
    }
    const lead = repo.onlyfans.get(handle);
    if (lead && (lead.status === 'claimed' || lead.status === 'rejected')) continue;
    repo.onlyfans.note(handle, { sourceId: creatorId, origin: 'post', free });
    n++;
  }
  return n;
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
    try { results = await websearch.search(`"${core}" (onlyfans OR fansly OR "justfor.fans" OR bluesky OR twitter OR reddit OR redgifs OR telegram OR linktree)`, { budget }); searched++; } catch (e) {
      if (e.budget || e.skip) break; // out of budget: try this creator again next time
      events.log('WARN', `Discovery: web search for ${t.handle} failed — ${e.message}`);
      results = [];
    }
    repo.discoveryState.set(`brave.identity.${t.id}`, new Date().toISOString());
    for (const r of results) {
      const spec = parseProfile(r.url);
      if (!usable(spec) || spec.kind === 'community') continue;
      const handle = spec.platform === 'linkinbio' ? (linkHubHandle(spec.target) || new URL(spec.target).pathname.split('/').filter(Boolean)[0]) : spec.target;
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
    try { results = await websearch.search(q, { budget }); searched++; } catch (e) {
      if (e.budget || e.skip) break;
      events.log('WARN', `Discovery: web search "${q}" failed — ${e.message}`);
      continue;
    }
    for (const r of results) {
      const svc = paid.serviceOf(r.url);
      const ph = svc ? paid.paidHandle(svc, r.url) : null;
      if (svc && paid.SERVICES[svc] && paid.SERVICES[svc].trace && ph) { if (noteSearchedPaid(svc, ph, r)) found++; continue; }
      const specs = [parseProfile(r.url), ...extractLinks(`${r.description} ${r.title}`)];
      for (const spec of specs) if (consider(spec, 'search', q, { displayName: (r.title || '').split(/[(|•·-]/)[0].trim() || null, bio: r.description || null })) found++;
    }
  }
  repo.discoveryState.set('brave.topics.index', String(idx % Math.max(1, list.length)));
  return { searched, found };
}

/** A web search surfaced someone's paid page: its search snippet is their public bio. */
function noteSearchedPaid(service, handle, r) {
  const title = (r.title || '').split(/\s*[[(|]/, 1)[0];
  const cut = service === 'OnlyFans' ? 'only\\s*fans' : service === 'Fansly' ? 'fansly' : '(?:justfor\\.?fans|jff)';
  const name = (title.match(new RegExp(`^[\\s\\S]*?(?=\\b${cut}\\b|$)`, 'i'))?.[0] || '').replace(/[-–—·:]+\s*$/, '').trim() || null;
  const bio = r.description || null;
  if (repo.onlyfans.ownerOf(handle, service)) return false;
  const existing = repo.onlyfans.get(handle, service);
  if (existing && existing.status !== 'pending' && existing.status !== 'searching') return false;
  repo.onlyfans.note(handle, { service, origin: 'search', displayName: name, bio, free: freeHint(`${r.title} ${bio}`) });
  return true;
}
/** @deprecated use noteSearchedPaid (kept for OnlyFans-only callers) */
function noteSearchedOnlyFans(handle, r) { return noteSearchedPaid('OnlyFans', handle, r); }

// Custom feeds and communities have to read adult/creator-ish to be worth a lead (keeps out news and art-only feeds).
const ADULT_HINT = /nsfw|18\s*\+|🔞|\bnude|\bnaked|\bporn|\bxxx\b|\bhot\b|sexy|thirst|bulge|muscle|hunk|daddy|daddies|twink|\bbears?\b|\bjocks?\b|\bcock|\bdick|horny|kink|leather|underwear|speedo|jockstrap|\bhung\b|\bgay\b|gaybros|\bm4m\b|\bhairy/i;
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
        repo.discoveryState.set(key, new Date().toISOString()); // only a successful read counts as today's
      } catch (e) { events.log('WARN', `Discovery: Lemmy communities on ${host} — ${e.message}`); }
    }
  }
  return out;
}

const underReview = (c) => typeof c.reason === 'string' && c.reason.startsWith('needs review');
/**
 * Judge looked-up profile fields with the same gate as consider() (raw + CamelCase-split, so
 * "ChildModel" is read as "Child Model"), together with what we already knew about the lead.
 * A lookup can add a review flag or reject, but never clears an earlier review flag.
 */
function judgeLookup(c, ...texts) {
  const v = gate(c.target, c.label, c.display_name, c.bio, ...texts);
  if (v.level === 'block') return { reject: { status: 'rejected', reason: `safety: ${v.rule || 'blocked'}`, decided_at: new Date().toISOString() } };
  return { reason: v.level === 'review' ? `needs review: ${v.rule}` : underReview(c) ? c.reason : 'checked' };
}
/** Nothing to read (missing profile, lookup error): stop asking, keeping any review flag. */
const nothingFound = (c) => (underReview(c) ? { bio: c.bio == null ? '' : c.bio } : { reason: 'checked' });

/* ------------------------------------------------------- v4.7: wider reach */

/** Communities where several of the creators we follow already post. Pure SQL. */
function creatorHangouts({ minCreators = 2 } = {}) {
  let found = 0;
  for (const h of repo.communityHangouts({ minCreators })) {
    let spec = null;
    if (h.platform === 'reddit') spec = parseProfile(`r/${h.community}`);
    else if (h.platform === 'lemmy' && h.community.includes('@')) { const [name, host] = h.community.split('@'); spec = parseProfile(`https://${host}/c/${name}`); }
    // the RedGIFs niches followed creators post in (an untrusted feed: every item still needs a male signal)
    else if (h.platform === 'redgifs' && /^[a-z0-9-]{2,60}$/i.test(h.community)) spec = { platform: 'redgifs', kind: 'niche', target: h.community.toLowerCase(), label: h.community, ingestable: true };
    if (!spec) continue;
    let c = null;
    const shown = h.platform === 'reddit' ? `r/${h.community}` : h.platform === 'redgifs' ? h.community.replace(/-/g, ' ') : h.community;
    for (const cid of h.ids.slice(0, CAPS.hangout)) c = consider(spec, 'hangout', cid, { displayName: shown }) || c;
    if (c && c.status === 'pending' && c.scope !== 'excluded') found++;
  }
  return { found };
}

/** Bluesky's own "accounts like this one" for followed creators (refreshed weekly per creator). */
async function blueskyLookalikes({ creators = 4, aborted = () => false } = {}) {
  const bsky = registry.get('bluesky');
  if (!bsky || !bsky.suggestedFor) return { checked: 0, found: 0 };
  const targets = repo.discoveryTargets({ platform: 'bluesky', prefix: 'bsky.similar.', staleDays: 7, limit: creators });
  let found = 0; let checked = 0;
  for (const t of targets) {
    if (aborted()) break;
    try {
      for (const p of await bsky.suggestedFor(t.target)) {
        if (p.labels.includes('!no-unauthenticated')) continue;
        const spec = parseProfile(`https://bsky.app/profile/${p.handle}`);
        if (!spec) continue;
        const adult = p.labels.some((l) => ['porn', 'sexual', 'nudity'].includes(l));
        const existing = repo.candidates.find(spec.platform, spec.kind, spec.target);
        if (!existing && !adult && !CREATOR_HINT.test(`${p.displayName || ''} ${p.description || ''}`)) continue;
        const c = consider(spec, 'similar', t.id, { displayName: p.displayName, bio: p.description, avatarUrl: p.avatar, popularity: p.followers });
        if (c && c.status === 'pending') found++;
      }
      checked++;
    } catch (e) { events.log('WARN', `Discovery: Bluesky lookalikes of ${t.target} — ${e.message}`); }
    repo.discoveryState.set(`bsky.similar.${t.id}`, new Date().toISOString());
  }
  return { checked, found };
}

/**
 * Keyword people search: Bluesky and Misskey-family accounts whose name/bio match, and the RedGIFs
 * creators behind the top results for the keyword. Uses the same rotating community keywords (one per run).
 */
async function peopleSearch({ aborted = () => false } = {}) {
  const list = keywordList();
  const out = { searched: 0, found: 0, bluesky: 0, redgifs: 0, misskey: 0 };
  if (!list.length) return out;
  let idx = parseInt(repo.discoveryState.get('people.index', '0'), 10) || 0;
  const kw = list[idx % list.length];
  repo.discoveryState.set('people.index', String((idx + 1) % list.length));
  const bsky = registry.get('bluesky');
  if (bsky && bsky.searchActors && !aborted()) {
    try {
      out.searched++;
      for (const p of await bsky.searchActors(kw, 25)) {
        if (p.labels.includes('!no-unauthenticated')) continue;
        const adult = p.labels.some((l) => ['porn', 'sexual', 'nudity'].includes(l));
        if (!adult && !CREATOR_STRONG.test(`${p.displayName || ''} ${p.description || ''}`)) continue;
        const c = consider(parseProfile(`https://bsky.app/profile/${p.handle}`), 'search', `bluesky-people:${kw}`, { displayName: p.displayName, bio: p.description, avatarUrl: p.avatar, popularity: p.followers });
        if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.bluesky++; }
      }
    } catch (e) { events.log('WARN', `Discovery: Bluesky people search "${kw}" — ${e.message}`); }
  }
  const mk = registry.get('misskey');
  if (mk && mk.searchUsers && !aborted()) {
    for (const host of (config.misskeyInstances || []).slice(0, 2)) {
      if (aborted()) break;
      try {
        out.searched++;
        for (const u of await mk.searchUsers(kw, host, 10)) {
          if (!CREATOR_STRONG.test(`${u.displayName || ''} ${u.description || ''}`)) continue;
          const c = consider(parseProfile(`@${u.username}@${u.host}`, { platform: 'misskey' }), 'search', `misskey-people:${kw}`, { displayName: u.displayName, bio: u.description, avatarUrl: u.avatar, popularity: u.followers });
          if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.misskey++; }
        }
      } catch (e) { events.log('WARN', `Discovery: Misskey people search "${kw}" on ${host} — ${e.message}`); }
    }
  }
  const rg = registry.get('redgifs');
  if (rg && rg.searchCreators && !aborted()) {
    try {
      out.searched++;
      for (const u of (await rg.searchCreators(kw)).slice(0, 25)) {
        if (u.gifs < 2) continue; // one stray result is not a creator of this kind of content
        const spec = parseProfile(`https://www.redgifs.com/users/${u.username}`);
        const c = consider(spec, 'search', `redgifs:${kw}`, { displayName: u.name || u.username, bio: [u.description, u.tags.join(' ')].filter(Boolean).join(' · ') || null, avatarUrl: u.avatar, popularity: u.followers });
        if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.redgifs++; }
      }
    } catch (e) { events.log('WARN', `Discovery: RedGIFs creator search "${kw}" — ${e.message}`); }
  }
  // Related creators: who posts the most in one of the RedGIFs niches PRISM follows (one niche per run, in rotation).
  // A verified poster is a "similar" lead per niche; an unverified one needs several gifs there and counts as a search hit.
  const niches = rg && rg.nicheCreators ? repo.feeds.list({ platform: 'redgifs', kind: 'niche', enabled: true, limit: 200 }).items.map((f) => f.target) : [];
  if (niches.length && !aborted()) {
    const n = parseInt(repo.discoveryState.get('people.niche', '0'), 10) || 0;
    const niche = niches[n % niches.length];
    repo.discoveryState.set('people.niche', String((n + 1) % niches.length));
    out.niche = niche;
    try {
      out.searched++;
      for (const u of (await rg.nicheCreators(niche)).slice(0, 30)) {
        if (u.gifs < (u.verified ? 2 : 3)) continue;
        const spec = parseProfile(`https://www.redgifs.com/users/${u.username}`);
        const c = consider(spec, u.verified ? 'similar' : 'search', `redgifs-niche:${niche}`, { displayName: u.name || u.username, bio: [u.description, u.tags.join(' ')].filter(Boolean).join(' · ') || null, avatarUrl: u.avatar, popularity: u.followers });
        if (c && c.status === 'pending' && c.scope !== 'excluded') { out.found++; out.redgifs++; }
      }
    } catch (e) { events.log('WARN', `Discovery: RedGIFs niche creators "${niche}" — ${e.message}`); }
  }
  return out;
}

/* ------------------------------------------------------ v4.14: OnlyFans */

const BSKY_HANDLE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TG_HANDLE = /^[a-z][a-z0-9_]{4,31}$/;
const namesOf = (text, handle) => findOnlyFans(text).includes(String(handle).toLowerCase());

/**
 * Look for the free, public accounts of the person behind a paid page: the same handle on RedGIFs and
 * Bluesky (free lookups), a web search for the exact page link (budgeted), and same-handle X / Telegram
 * leads that enrich() verifies. An account whose profile links that exact page is proven to be them.
 * The paid page itself is always fetched. Lead services: OnlyFans, Fansly, JustFor.Fans.
 * @param {{handle: string, service?: string}} lead
 * @param {(spec, proven: boolean, meta) => any} found  called for every account found
 */
async function probeOnlyFans(lead, found, { budget, search = true } = {}) {
  const handle = lead.handle;
  const service = lead.service || 'OnlyFans';
  const pageHost = paid.PAID_HOSTS[service] || 'onlyfans.com';
  const linked = (text) => paid.pageLinked(service, text, handle);
  const rg = registry.get('redgifs');
  if (rg && rg.lookupUser) {
    try {
      const u = await rg.lookupUser(handle);
      if (u && u.gifs > 0) {
        const proven = linked(`${u.description || ''} ${u.links.join(' ')}`);
        found(parseProfile(`https://www.redgifs.com/users/${u.username}`), proven, { displayName: u.name || u.username, bio: u.description, avatarUrl: u.avatar, popularity: u.followers });
      }
    } catch (e) { events.log('WARN', `Discovery: RedGIFs lookup for ${service} ${handle} — ${e.message}`); }
  }
  const bh = handle.replace(/[_.]/g, '');
  if (BSKY_HANDLE.test(bh)) {
    const bskyDash = handle.replace(/[_.]/g, '-');
    const actors = [`${bh}.bsky.social`];
    if (bskyDash !== bh && BSKY_HANDLE.test(bskyDash)) actors.push(`${bskyDash}.bsky.social`);
    try {
      const qs = actors.map((a) => `actors=${encodeURIComponent(a)}`).join('&');
      const json = await bskyHttp.json(`${config.baseUrls.bsky}/xrpc/app.bsky.actor.getProfiles?${qs}`);
      for (const p of json.profiles || []) {
        if ((p.labels || []).some((l) => l.val === '!no-unauthenticated')) continue;
        const proven = linked(p.description);
        found(parseProfile(`https://bsky.app/profile/${p.handle}`), proven, { displayName: p.displayName, bio: p.description, avatarUrl: p.avatar, popularity: p.followersCount });
      }
    } catch (e) { if (e.status !== 400) events.log('WARN', `Discovery: Bluesky lookup for ${service} ${handle} — ${e.message}`); }
  }
  // Same-handle guesses that enrich() confirms (or drops) once it reads the profile.
  const xa = registry.get('x');
  if (xa && xa.apiAvailable && xa.apiAvailable() && /^[a-z0-9_]{3,15}$/i.test(handle)) found(parseProfile(`https://x.com/${handle}`), false, {});
  const canTgPreview = !config.isTest || !!process.env.TELEGRAM_WEB_BASE_URL;
  if ((tgBot.configured() || canTgPreview) && TG_HANDLE.test(handle)) found(parseProfile(`https://t.me/${handle}`), false, {});
  if (search && websearch.configured()) {
    let results = [];
    try { results = await websearch.search(`"${pageHost}/${handle}"`, { budget }); } catch (e) {
      if (!e.budget && !e.skip) events.log('WARN', `Discovery: web search for ${service} ${handle} — ${e.message}`);
      return { searched: false, outOfBudget: !!(e.budget || e.skip) };
    }
    for (const r of results) {
      const snippet = `${r.title || ''} ${r.description || ''}`;
      if (leaks.isLeakUrl(r.url) || leaks.isLeakText(snippet) || takedowns.checkUrl(r.url)) continue;
      const page = parseProfile(r.url);
      const named = linked(snippet); // the result page itself shows the exact paid-page link
      for (const spec of [page, ...extractLinks(snippet)]) {
        if (!usable(spec) || spec.kind === 'community') continue;
        const own = spec.platform === 'linkinbio' ? (linkHubHandle(spec.target) || new URL(spec.target).pathname.split('/').filter(Boolean)[0] || '') : spec.target;
        // Proof needs the page to be theirs, not a fan's post that names the link: a link page (owner-curated)
        // or an account under the same name. Anyone else is just mentioning them.
        const same = sameName(own, handle);
        const proven = named && spec === page && (spec.platform === 'linkinbio' || same);
        if (!proven && !same) continue;
        found(spec, proven, { displayName: (r.title || '').split(/[(|•·-]/)[0].trim() || null, bio: r.description || null });
      }
    }
    return { searched: true };
  }
  return { searched: false };
}

/**
 * Work the paid leads: (1) pages creators promote that we do not follow yet become discovery
 * candidates for that person's public accounts; (2) followed creators who have a paid page but few
 * known accounts get the same search, and what it finds is linked to them (their content from elsewhere).
 * OnlyFans, Fansly and JustFor.Fans; the paid hosts themselves are never read.
 */
async function onlyfansDiscovery({ leads = 10, reach = 4, searches = 4, budget, aborted = () => false } = {}) {
  const out = { checked: 0, found: 0, linked: 0, searched: 0, rejected: 0 };
  let searchLeft = searches;
  for (const lead of repo.onlyfans.workable(leads)) {
    if (aborted()) break;
    const key = leadKey(lead.service, lead.handle);
    const owner = repo.onlyfans.ownerOf(lead.handle, lead.service);
    if (owner) { repo.onlyfans.claim(lead.handle, owner.id, lead.service); continue; }
    const verdict = gate(lead.handle, lead.display_name, lead.bio);
    const gender = femaleCheck(lead.handle, lead.display_name, lead.bio);
    // Borderline wording ("teen") is not traced at all: unlike a queued candidate, a lead has no human checkpoint.
    if (verdict.level || gender.level === 'hard') {
      repo.onlyfans.update(lead.handle, { service: lead.service, status: 'rejected', reason: verdict.level ? `safety: ${verdict.rule}` : `scope: ${gender.rule}`, checked_at: new Date().toISOString() });
      out.rejected++;
      continue;
    }
    const accounts = [];
    // Web searches are the scarce resource: spend them on pages more than one source vouches for.
    const search = searchLeft > 0 && (lead.mentions >= 2 || lead.origin === 'search' || lead.attempts > 0);
    const r = await probeOnlyFans(lead, (spec, proven, meta) => {
      const c = consider(spec, proven ? 'ofconfirmed' : 'onlyfans', key, { ...meta, ofSources: Math.max(1, lead.sources.length || lead.mentions || 1) });
      if (c) accounts.push({ platform: spec.platform, kind: spec.kind, target: spec.target, proven, candidate: c.id });
    }, { budget, search });
    if (r.searched) { searchLeft--; out.searched++; }
    if (r.outOfBudget) searchLeft = 0;
    out.checked++;
    if (accounts.length) out.found++;
    repo.onlyfans.update(lead.handle, { service: lead.service, status: accounts.length ? 'found' : 'searching', accounts: accounts.length ? accounts : lead.accounts, attempts: (lead.attempts || 0) + 1, checked_at: new Date().toISOString() });
  }
  for (const service of ['OnlyFans', 'Fansly', 'JustFor.Fans']) {
    const keyPrefix = service === 'OnlyFans' ? 'of.reach.' : `paid.reach.${service}.`;
    for (const t of repo.onlyfans.reachTargets(reach, 30, 4, service, keyPrefix)) {
      if (aborted()) break;
      const of = service === 'OnlyFans' ? creatorOnlyFans(t) : paid.creatorPaid(t).find((l) => l.service === service && l.handle);
      repo.discoveryState.set(`${keyPrefix}${t.id}`, new Date().toISOString());
      if (!of) continue;
      const r = await probeOnlyFans({ handle: of.handle, service }, (spec, proven, meta) => {
        // the creator's own other account: an identity link (same person), not a new creator
        const owner = spec.kind === 'user' ? repo.creators.byAccount(spec.platform, spec.target) : null;
        if (owner) return;
        // probeOnlyFans only reports same-handle or proven accounts; a same-handle one is theirs only when
        // the paid handle is also the creator's own name (otherwise it may be a namesake)
        if (!proven && !sameName(t.handle, of.handle)) return;
        if (consider(spec, 'identity', t.id, { ...meta, creatorId: t.id })) out.linked++;
      }, { budget, search: searchLeft > 0 });
      if (r.searched) { searchLeft--; out.searched++; }
      if (r.outOfBudget) searchLeft = 0;
    }
  }
  return out;
}

/**
 * One web query per subject. The paid-page slug is a search term only — the paid host is never fetched.
 * Display name is added when it is not just the handle, so one request covers handle, name and slug.
 */
function mentionSearchQuery(subject) {
  const handle = String((subject && subject.handle) || '').replace(/^@/, '').trim();
  const service = (subject && subject.service) || 'OnlyFans';
  const host = (paid.PAID_HOSTS && paid.PAID_HOSTS[service]) || 'onlyfans.com';
  const name = String((subject && subject.displayName) || '').replace(/["<>]/g, '').trim();
  const nameBit = name && name.length >= 3 && name.length <= 80 && name.toLowerCase() !== handle.toLowerCase()
    ? ` OR "${name}"` : '';
  const sites = [
    'site:x.com', 'site:twitter.com', 'site:reddit.com', 'site:redgifs.com', 'site:bsky.app',
    'site:t.me', 'site:youtube.com', 'site:pixelfed.social', 'site:mastodon.social',
  ].join(' OR ');
  return `"${host}/${handle}" OR "@${handle}"${nameBit} (${sites})`;
}

function fediHostIsLocal(host) {
  return /^(127\.0\.0\.1|localhost)(:|$)/i.test(String(host || ''));
}

/** Live instances in production. Tests only probe when the instance list points at the mock, so a suite never fans out to the public fediverse. */
function fediMentionsOn() {
  if (!config.isTest) return true;
  const hosts = [...(config.mastodonInstances || []).slice(0, 1), ...(config.misskeyInstances || []).slice(0, 1)];
  return hosts.some(fediHostIsLocal);
}

/**
 * One Mastodon account search and one Misskey username search for this subject.
 * Two requests at most. Bios that do not name the subject and do not read as a creator are dropped.
 */
async function probeFediMentions(subject, creatorId = null, aborted = () => false) {
  const tally = { found: 0, linked: 0 };
  if (aborted() || !subject || !subject.handle || !fediMentionsOn()) return tally;
  const note = (spec, bio, displayName, avatar, followers) => {
    if (!usable(spec) || spec.kind !== 'user') return;
    if (takedowns.checkHandle(spec.target, spec.platform)) return;
    const own = String(spec.target || '').split('@')[0];
    const text = `${displayName || ''} ${bio || ''}`;
    const isSame = sameName(own, subject.handle) || paid.pageLinked(subject.service || 'OnlyFans', text, subject.handle);
    const mentions = String(bio || '').toLowerCase().includes(String(subject.handle).toLowerCase());
    if (!isSame && !mentions && !CREATOR_STRONG.test(text)) return;
    if (gate(displayName, bio, own).level) return;
    const c = consider(spec, creatorId && isSame ? 'identity' : 'mention', creatorId || subject.handle, {
      displayName: displayName || own,
      bio: bio || null,
      avatarUrl: avatar || null,
      popularity: followers,
      ...(creatorId && isSame ? { creatorId } : {}),
    });
    if (!c) return;
    if (creatorId && isSame) tally.linked++; else tally.found++;
  };
  const mastodon = registry.get('mastodon');
  if (mastodon && mastodon.searchAccounts && !aborted()) {
    try {
      for (const u of (await mastodon.searchAccounts(subject.handle, { limit: 5 })).slice(0, 5)) {
        if (aborted()) break;
        const parts = String(u.acct || '').split('@');
        if (parts.length < 2 || !parts[0] || !parts[1]) continue;
        note(parseProfile(`https://${parts[1]}/@${parts[0]}`), u.note, u.displayName, u.avatar, u.followers);
      }
    } catch { /* best effort */ }
  }
  const misskey = registry.get('misskey');
  const mkHost = (config.misskeyInstances || [])[0];
  if (misskey && misskey.searchUsers && mkHost && !aborted()) {
    try {
      for (const u of (await misskey.searchUsers(subject.handle, mkHost, 5)).slice(0, 5)) {
        if (aborted()) break;
        note(parseProfile(`https://${u.host}/@${u.username}`), u.description, u.displayName, u.avatar, u.followers);
      }
    } catch { /* best effort */ }
  }
  return tally;
}

/**
 * Creator mention / collab / feature discovery across X, Reddit, RedGIFs, Bluesky,
 * Telegram, Mastodon, Misskey, YouTube, and the open web (via Brave Web + Images + Videos and DDG fallback).
 *
 * For known creators and active OF/Fansly/JFF leads, searches for public posts, videos, and images
 * mentioning the creator's `@handle`, display name, or paid-page slug (`onlyfans.com/<handle>` and
 * the Fansly / JustFor.Fans equivalents). The slug is a search term only. 
 */
async function discoverCreatorMentions({ creators = 3, leads = 3, budget, aborted = () => false } = {}) {
  const out = { checked: 0, found: 0, linked: 0, searched: 0 };
  const activeCreators = repo.discoveryTargets({ prefix: 'mentions.web.', staleDays: 14, limit: creators, minMedia: 0, maxAccounts: 10 });
  const workableLeads = repo.onlyfans.workable(leads);

  const ingestSearchHit = (hit, subject, creatorId = null) => {
    if (!hit || !hit.url) return 0;
    const text = `${hit.title || ''} ${hit.description || ''} ${hit.creator || ''} ${hit.publisher || ''}`;
    if (leaks.isLeakUrl(hit.url) || leaks.isLeakText(text) || brave.isPaywalledHost(hit.url)) return 0;
    if (takedowns.checkUrl(hit.url) || takedowns.checkItem({ title: hit.title, text: hit.description, permalink: hit.url })) return 0;
    if (gate(hit.title, hit.description).level) return 0;

    let added = 0;
    const specs = [parseProfile(hit.url), ...extractLinks(`${hit.url} ${text}`)];
    for (const spec of specs) {
      if (!usable(spec) || spec.kind === 'community') continue;
      if (takedowns.checkHandle(spec.target, spec.platform)) continue;
      const own = spec.platform === 'linkinbio' ? (linkHubHandle(spec.target) || '') : spec.target;
      const isSame = sameName(own, subject.handle);
      const isPaidNamed = subject.service ? paid.pageLinked(subject.service, text, subject.handle) : false;
      const sc = classify([hit.title, hit.description, spec.target, subject.displayName], { trusted: isSame || isPaidNamed });
      if (sc.scope === 'excluded') continue;

      if (creatorId && (isSame || (isPaidNamed && spec.platform === 'linkinbio'))) {
        if (consider(spec, 'identity', creatorId, { displayName: subject.displayName || hit.title, bio: hit.description, creatorId })) {
          out.linked++;
          added++;
        }
      } else if (isPaidNamed || isSame || sc.scope === 'in') {
        const sigType = isPaidNamed && isSame ? 'ofconfirmed' : 'mention';
        const sigVal = creatorId || (subject.service ? leadKey(subject.service, subject.handle) : subject.handle);
        const c = consider(spec, sigType, sigVal, {
          displayName: (hit.title || '').split(/[(|•·-]/)[0].trim() || null,
          bio: hit.description || null,
          avatarUrl: hit.thumbnailUrl || null,
        });
        if (c && c.status === 'pending' && c.scope !== 'excluded') {
          out.found++;
          added++;
        }
      }
    }
    return added;
  };

  const searchAdaptersForSubject = async (subject, creatorId = null) => {
    const qHandle = subject.handle;
    const paidPage = subject.service ? `${paid.PAID_HOSTS[subject.service] || 'onlyfans.com'}/${qHandle}` : `onlyfans.com/${qHandle}`;
    const fedi = await probeFediMentions(subject, creatorId, aborted);
    out.found += fedi.found;
    out.linked += fedi.linked;

    // 1. Reddit post search for paid page or @handle mentions
    const reddit = registry.get('reddit');
    if (reddit && reddit.searchPosts && !aborted()) {
      try {
        const posts = await reddit.searchPosts(`"${paidPage}" OR "${qHandle}"`, 15);
        for (const p of posts || []) {
          if (!p || !p.author) continue;
          const postText = `${p.title || ''} ${p.selftext || ''} ${p.url || ''}`;
          if (leaks.isLeakText(postText) || leaks.isLeakUrl(p.url)) continue;
          if (gate(p.title, p.selftext, p.author).level) continue;
          const spec = parseProfile(`u/${p.author}`);
          if (spec && usable(spec)) {
            const isSame = sameName(p.author, qHandle);
            const sigType = creatorId && isSame ? 'identity' : 'mention';
            const c = consider(spec, sigType, creatorId || qHandle, {
              displayName: p.author,
              bio: p.title || null,
              ...(creatorId && isSame ? { creatorId } : {}),
            });
            if (c && c.status === 'pending') out.found++;
          }
        }
      } catch { /* best effort */ }
    }

    // 2. RedGIFs creator search
    const rg = registry.get('redgifs');
    if (rg && rg.searchCreators && !aborted()) {
      try {
        for (const u of (await rg.searchCreators(qHandle)).slice(0, 8)) {
          if (!u || !u.username || u.gifs < 1) continue;
          const spec = parseProfile(`https://www.redgifs.com/users/${u.username}`);
          if (!usable(spec)) continue;
          const uBio = `${u.description || ''} ${(u.links || []).join(' ')}`;
          const isSame = sameName(u.username, qHandle) || paid.pageLinked(subject.service || 'OnlyFans', uBio, qHandle);
          const mentionsHandle = uBio.toLowerCase().includes(qHandle.toLowerCase());
          if (!isSame && !mentionsHandle && !CREATOR_STRONG.test(uBio)) continue;
          const sigType = isSame ? (creatorId ? 'identity' : 'ofconfirmed') : 'mention';
          const c = consider(spec, sigType, creatorId || leadKey(subject.service || 'OnlyFans', qHandle), {
            displayName: u.name || u.username,
            bio: u.description || null,
            avatarUrl: u.avatar || null,
            popularity: u.followers,
            ...(creatorId && isSame ? { creatorId } : {}),
          });
          if (c) { if (creatorId && isSame) out.linked++; else out.found++; }
        }
      } catch { /* best effort */ }
    }

    // 3. Bluesky actor search
    const bsky = registry.get('bluesky');
    if (bsky && bsky.searchActors && !aborted()) {
      try {
        for (const p of (await bsky.searchActors(qHandle, 8))) {
          if (!p || !p.handle || (p.labels || []).includes('!no-unauthenticated')) continue;
          const spec = parseProfile(`https://bsky.app/profile/${p.handle}`);
          if (!usable(spec)) continue;
          const isSame = sameName(p.handle, qHandle) || paid.pageLinked(subject.service || 'OnlyFans', p.description || '', qHandle);
          if (!isSame && !CREATOR_STRONG.test(`${p.displayName || ''} ${p.description || ''}`)) continue;
          const c = consider(spec, creatorId && isSame ? 'identity' : 'mention', creatorId || qHandle, {
            displayName: p.displayName,
            bio: p.description,
            avatarUrl: p.avatar,
            popularity: p.followers,
            ...(creatorId && isSame ? { creatorId } : {}),
          });
          if (c) { if (creatorId && isSame) out.linked++; else out.found++; }
        }
      } catch { /* best effort */ }
    }

    // 4. Web + Images + Videos search (Brave API or DDG HTML fallback)
    if (!aborted()) {
      const webQ = mentionSearchQuery(subject);
      try {
        const webHits = websearch.configured()
          ? await websearch.search(webQ, { count: 15, budget })
          : await brave.web(webQ, { count: 15, budget });
        out.searched++;
        for (const h of webHits || []) ingestSearchHit(h, subject, creatorId);
      } catch { /* ignore */ }

      try {
        const imgHits = await brave.images(`"${qHandle}" "${paidPage}"`, { count: 10, budget });
        for (const h of imgHits || []) ingestSearchHit(h, subject, creatorId);
      } catch { /* ignore */ }

      try {
        const vidHits = await brave.videos(`"${qHandle}"`, { count: 10, budget });
        for (const h of vidHits || []) ingestSearchHit(h, subject, creatorId);
      } catch { /* ignore */ }
    }
  };

  for (const c of activeCreators) {
    if (aborted()) break;
    if (takedowns.checkHandle(c.handle) || takedowns.checkItem({ creator_id: c.id, author: c.handle })) continue;
    const paidEntries = paid.creatorPaid(c);
    const primaryPaid = paidEntries.find((p) => p.handle) || null;
    await searchAdaptersForSubject({
      handle: (primaryPaid && primaryPaid.handle) || c.handle,
      displayName: c.display_name || c.handle,
      service: (primaryPaid && primaryPaid.service) || 'OnlyFans',
    }, c.id);
    repo.discoveryState.set(`mentions.web.${c.id}`, new Date().toISOString());
    out.checked++;
  }

  for (const lead of workableLeads) {
    if (aborted()) break;
    if (takedowns.checkHandle(lead.handle)) continue;
    if (gate(lead.handle, lead.display_name, lead.bio).level) continue;
    await searchAdaptersForSubject({
      handle: lead.handle,
      displayName: lead.display_name || lead.handle,
      service: lead.service || 'OnlyFans',
    }, lead.creator_id || null);
    out.checked++;
  }

  return out;
}

/**
 * Creators the admin named (Admin → Discovery → creators to find): each is looked up by name across every
 * platform (handle probes, people search, web search, bios and link pages, every account verified through its
 * adapter) and his strong, new matches are followed as one creator. A name is retried monthly, so accounts he
 * opens later are picked up; one or two names per run, since a lookup is the heaviest thing discovery does.
 */
async function seedCreators({ perRun = 2, staleDays = 30, aborted = () => false, lookupImpl } = {}) {
  const lookup = lookupImpl || require('./lookup');
  const names = String(settingsStore.get().creatorSeeds || '').split('\n').map((n) => n.trim()).filter(Boolean);
  const out = { checked: 0, followed: 0, accounts: 0, results: [] };
  const due = names.filter((n) => {
    const at = repo.discoveryState.touchedAt(`seed.${n.toLowerCase()}`);
    return !at || Date.now() - new Date(at).getTime() > staleDays * 86400000;
  }).slice(0, perRun);
  for (const name of due) {
    if (aborted()) break;
    let r;
    try { r = await lookup.findAndFollow(name, { minConfidence: 0.7 }); } catch (e) { r = { error: e.message }; }
    out.checked++;
    const f = r && r.followed && r.followed.ok ? r.followed : null;
    const known = r && r.candidates ? r.candidates.filter((c) => c.status === 'following' && c.confidence >= 0.7) : [];
    const extPaid = ((r && r.externalLinks) || []).filter((l) => l && l.handle);
    const summary = {
      at: new Date().toISOString(), error: (r && r.error) || null,
      creatorId: f ? f.creator.id : (known[0] && known[0].creatorId) || null,
      followed: f ? f.feeds.length : 0, already: known.length,
      onlyfans: extPaid.map((l) => l.handle),
      note: (r && r.note) || null,
    };
    if (f) { out.followed++; out.accounts += f.feeds.length; }
    // already followed earlier: the page he links still belongs on his profile
    if (!f && summary.creatorId && extPaid.length) {
      const links = extPaid.map((l) => {
        const svc = l.service || paid.serviceOf(l.url) || 'OnlyFans';
        return paid.SERVICES[svc] && paid.SERVICES[svc].trace ? paid.paidLink(svc, l.handle, { free: !!l.free }) : ofLink(l.handle);
      });
      repo.creators.enrich(summary.creatorId, { links });
      for (const l of links) if (l.handle) repo.onlyfans.claim(l.handle, summary.creatorId, l.service || 'OnlyFans');
    }
    // "creators like him": paid pages that come up next to his name (lists, collabs) become leads to trace
    if (websearch.configured() && !summary.error) {
      try {
        for (const res of await websearch.search(`"${name}" male onlyfans creators like`, { budget: settingsStore.get().braveDailyBudget })) {
          const svc = paid.serviceOf(res.url);
          const ph = svc ? paid.paidHandle(svc, res.url) : null;
          const spec = parseProfile(res.url);
          const pages = svc && paid.SERVICES[svc] && paid.SERVICES[svc].trace && ph
            ? [{ service: svc, handle: ph }]
            : paid.findPaidHandles(`${res.title || ''} ${res.description || ''}`).filter((p) => paid.SERVICES[p.service].trace);
          for (const p of pages) {
            if (p.service === 'OnlyFans' && (summary.onlyfans.includes(p.handle) || (spec && spec.handle === p.handle))) continue;
            if (noteSearchedPaid(p.service, p.handle, (spec && spec.handle === p.handle) || (svc === p.service && ph === p.handle) ? res : { title: null, description: null })) summary.similar = (summary.similar || 0) + 1;
          }
        }
      } catch { /* out of budget / no provider: next month */ }
    }
    repo.discoveryState.set(`seed.${name.toLowerCase()}`, JSON.stringify(summary));
    out.results.push({ name, ...summary });
    events.log(f ? 'OK' : 'INFO', `Discovery: "${name}" — ${f ? `followed ${f.feeds.length} account(s)` : summary.already ? `already following ${summary.already} account(s)` : summary.error || 'no strong match yet'}`);
  }
  return out;
}

/** What each named creator's last lookup found (for the admin panel). */
function seedStatus() {
  const names = String(settingsStore.get().creatorSeeds || '').split('\n').map((n) => n.trim()).filter(Boolean);
  return names.map((name) => {
    let last = null; try { last = JSON.parse(repo.discoveryState.get(`seed.${name.toLowerCase()}`) || 'null'); } catch { last = null; }
    const creator = last && last.creatorId ? repo.creators.get(last.creatorId) : null;
    return { name, last, creator: creator ? { id: creator.id, handle: creator.handle, display_name: creator.display_name, media_count: creator.media_count } : null };
  });
}

/** A profile read later (enrich) that links the paid page we guessed from its handle proves it. */
function confirmOnlyFans(c, bio) {
  const key = (c.signals.onlyfans || [])[0];
  if (key) {
    const { service, handle } = splitLead(key);
    if (paid.pageLinked(service, bio, handle)) {
      const signals = { ...c.signals, ofconfirmed: [key], ofsrc: Math.max(Number(c.signals.ofsrc) || 0, 1) };
      delete signals.onlyfans;
      return signals;
    }
  }
  if (!(c.signals.ofconfirmed || []).length && bio) {
    for (const { service, handle } of paid.findPaidHandles(bio)) {
      if (!paid.SERVICES[service] || !paid.SERVICES[service].trace || !paid.pageLinked(service, bio, handle)) continue;
      const lead = repo.onlyfans.get(handle, service);
      const activeLead = lead && lead.status !== 'rejected' && lead.status !== 'claimed';
      if ((c.platform === 'linkinbio' || sameName(c.target, handle)) && activeLead) {
        const signals = { ...c.signals, ofconfirmed: [leadKey(service, handle)], ofsrc: Math.max(Number(c.signals.ofsrc) || 0, lead.sources.length || lead.mentions || 1) };
        delete signals.onlyfans;
        return signals;
      }
    }
  }
  return c.signals;
}

/** Fill in names/bios for Telegram, Bluesky and X leads so scope and safety can judge them. */
async function enrich({ limit = 12 } = {}) {
  let done = 0;
  const tgAdapter = registry.get('telegram');
  const canTgPreview = !config.isTest || !!process.env.TELEGRAM_WEB_BASE_URL;
  if (tgBot.configured() || (canTgPreview && tgAdapter && tgAdapter.lookupChannel)) {
    for (const c of repo.candidates.needingDetails('telegram', limit)) {
      try {
        const info = tgBot.configured()
          ? await tgBot.channelInfo(c.target)
          : await tgAdapter.lookupChannel(c.target);
        if (!info) { repo.candidates.update(c.id, { status: 'rejected', reason: 'Telegram: channel not found or private', decided_at: new Date().toISOString() }); continue; }
        const scope = classify([info.title, info.description, c.target], { trusted: false }).scope;
        const j = judgeLookup(c, info.title, info.description);
        if (j.reject) { repo.candidates.update(c.id, j.reject); continue; }
        const signals = confirmOnlyFans(c, info.description);
        repo.candidates.update(c.id, { display_name: info.title, bio: info.description || '', signals, scope, score: scoreOf(signals, scope), reason: j.reason });
        done++;
      } catch (e) { repo.candidates.update(c.id, nothingFound(c)); events.log('WARN', `Discovery: ${e.message}`); }
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
        if (!p) { repo.candidates.update(c.id, nothingFound(c)); continue; }
        const j = judgeLookup(c, p.displayName, p.description);
        if (j.reject) { repo.candidates.update(c.id, j.reject); continue; }
        const scope = classify([p.displayName, p.description, c.target], { trusted: false }).scope;
        const signals = confirmOnlyFans(c, p.description);
        repo.candidates.update(c.id, { display_name: p.displayName || null, bio: p.description || '', avatar_url: p.avatar || null, signals, scope, score: scoreOf(signals, scope), reason: j.reason });
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
          if (!u) { repo.candidates.update(c.id, nothingFound(c)); continue; } // suspended, renamed or protected
          const j = judgeLookup(c, u.name, u.description);
          if (j.reject) { repo.candidates.update(c.id, j.reject); continue; }
          const scope = classify([u.name, u.description, c.target], { trusted: false }).scope;
          const signals = { ...confirmOnlyFans(c, u.description), popularity: Math.max(Number(c.signals.popularity) || 0, u.followers || 0) };
          repo.candidates.update(c.id, { display_name: u.name || null, bio: u.description || '', avatar_url: u.avatar || null, signals, scope, score: scoreOf(signals, scope), reason: j.reason });
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
  // Profile text fetched after the lead was queued (bios of Telegram / Bluesky / X leads) can still turn out female.
  const gender = femaleCheck(c.target, c.label, c.display_name, c.bio);
  if (c.scope === 'excluded' || gender.level === 'hard') {
    const reason = `scope: ${gender.rule || 'not male-focused'}`;
    repo.candidates.update(c.id, { status: 'rejected', reason, decided_at: new Date().toISOString() });
    return { ok: false, reason };
  }
  const heavy = actor === 'discovery' ? heavyRule(c.target, c.label, c.display_name, c.bio) : null; // an admin's own Follow click wins
  if (heavy) {
    const reason = `body filter: ${heavy}`;
    repo.candidates.update(c.id, { status: 'rejected', reason, decided_at: new Date().toISOString() });
    return { ok: false, reason };
  }
  const targets = require('../services/targets');
  const spec = { platform: c.platform, kind: c.kind, target: c.target, label: c.label || c.target, ingestable: true };
  const identity = (c.signals.identity || [])[0];
  // Communities and custom feeds mix many posters: when discovery follows one on its own, every
  // post is still scope-checked (untrusted). A human follow trusts it like an admin-added source.
  const shared = c.kind === 'community' || c.kind === 'feedgen' || c.kind === 'list';
  const trusted = actor !== 'discovery' ? true : shared ? false : c.scope === 'in' || !!identity || !!(c.signals.ofconfirmed || []).length;
  const r = targets.addSpec(spec, { creatorId: identity || null, origin: 'discovered', trusted, bodyOverride: actor !== 'discovery' });
  if (r.status !== 'created' && r.status !== 'exists') {
    repo.candidates.update(c.id, { status: 'rejected', reason: r.reason || r.status, decided_at: new Date().toISOString() });
    return { ok: false, reason: r.reason || r.status };
  }
  const status = identity ? 'linked' : 'followed';
  repo.candidates.update(c.id, { status, creator_id: (r.creator && r.creator.id) || identity || null, decided_at: new Date().toISOString(), reason: actor === 'discovery' ? `auto (score ${c.score})` : `by ${actor}` });
  if (r.creator && c.display_name) repo.creators.enrich(r.creator.id, { displayName: c.display_name, bio: c.bio || null, avatarUrl: c.avatar_url || null });
  // An account proven to belong to a paid-page creator carries that page onto their creator profile.
  const ofPage = (c.signals.ofconfirmed || [])[0];
  if (ofPage && r.creator) {
    const { service, handle } = splitLead(ofPage);
    const lead = repo.onlyfans.get(handle, service);
    repo.creators.enrich(r.creator.id, { links: [paid.paidLink(service, handle, { free: !!(lead && lead.free) || paid.freeHint(c.bio) })] });
    repo.onlyfans.claim(handle, r.creator.id, service);
  } else if (r.creator && c.bio) {
    for (const { service, handle } of paid.findPaidHandles(c.bio)) {
      if (paid.SERVICES[service] && paid.SERVICES[service].trace && (c.platform === 'linkinbio' || sameName(c.target, handle))) {
        repo.creators.enrich(r.creator.id, { links: [paid.paidLink(service, handle, { free: paid.freeHint(c.bio) })] });
        repo.onlyfans.claim(handle, r.creator.id, service);
      }
    }
  }
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
  // Page through the queue: ineligible leads (shared spaces with the switch off, no male signal)
  // stay pending, so they must not use up the window and hide eligible ones ranked below them.
  // Followed or rejected rows leave the pending set, so only skipped rows advance the offset.
  const PAGE = Math.max(25, limit * 2);
  let skipped = 0;
  for (let pages = 0; pages < 20 && followed + linked < limit; pages++) {
    const rows = repo.candidates.promotable(s.discoveryAutoFollowScore, PAGE, skipped);
    if (!rows.length) break;
    for (const c of rows) {
      if (followed + linked >= limit) break;
      const shared = SHARED_KINDS.has(c.kind);
      // shared spaces need the switch and a male-focused description; people need a male signal unless already a known creator
      // An account proven to run an OnlyFans page that followed creators promote is vouched for by them.
      const vouched = (c.signals.ofconfirmed || []).length > 0 && c.scope !== 'excluded';
      if ((shared && (!s.discoveryAutoCommunities || c.scope !== 'in')) || (c.scope !== 'in' && !(c.signals.identity || []).length && !vouched)) { skipped++; continue; }
      const r = follow(c);
      if (r.ok && !r.already) {
        if (r.status === 'linked') linked++; else followed++;
        events.log('OK', `Discovery: ${r.status === 'linked' ? 'linked' : 'followed'} ${c.platform}:${c.target} (score ${c.score}: ${describeSignals(c.signals)})`);
      }
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
    if (websearch.configured() && (s.braveDailyBudget > 0 || websearch.PROVIDERS.searxng.configured())) {
      // SearXNG costs nothing per query: search more per run when it is there (metered providers keep the daily budget either way).
      const free = websearch.PROVIDERS.searxng.configured();
      report.identity = await braveIdentity({ creators: free ? 5 : 3, budget: s.braveDailyBudget, aborted });
      report.topics = await braveTopics({ queries: free ? 3 : 1, budget: s.braveDailyBudget, aborted });
    }
    report.seeds = await seedCreators({ aborted });
    if (s.discoveryOnlyFans) report.onlyfans = await onlyfansDiscovery({ budget: s.braveDailyBudget, aborted });
    if (s.discoveryCommunities) report.communities = await communityDiscovery({ aborted });
    if (s.discoveryCommunities) report.hangouts = creatorHangouts();
    if (s.discoveryExpand) {
      report.lookalikes = await blueskyLookalikes({ aborted });
      report.people = await peopleSearch({ aborted });
      report.creatorMentions = await discoverCreatorMentions({ budget: s.braveDailyBudget, aborted });
    }
    report.identities = require('./identity').scan();
    report.enrich = await enrich();
    report.promote = s.autoDiscover || trigger === 'manual' ? promote(s) : { followed: 0, linked: 0 };
    report.pruned = repo.candidates.prune();
    events.log('INFO', `Discovery ${trigger === 'manual' ? '(manual) ' : ''}finished: ${report.mentions.found} mention leads, ${report.graph ? report.graph.found : 0} graph leads, ${report.topics ? report.topics.found : 0} search leads, ${report.communities ? report.communities.found : 0} community/feed leads, ${report.hangouts ? report.hangouts.found : 0} hangouts, ${report.lookalikes ? report.lookalikes.found : 0} lookalikes, ${report.people ? report.people.found : 0} people-search leads, ${report.identity ? report.identity.linked : 0} identity matches, ${report.seeds ? report.seeds.followed : 0} named creators found, ${report.onlyfans ? report.onlyfans.found : 0} OnlyFans creators traced (${report.onlyfans ? report.onlyfans.linked : 0} accounts linked), ${report.identities.links} same-creator links (${report.identities.merged} merged); followed ${report.promote.followed}, linked ${report.promote.linked}`);
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

/**
 * Which kinds of signal bring creators who actually post: for every followed/linked lead, credit
 * the signal that contributed most to its score, and count how many of those creators have
 * published media since. Lets the admin see which rules earn their keep.
 */
function signalYield() {
  const out = new Map();
  for (const c of repo.db.prepare(`SELECT ca.signals, cr.media_count FROM candidates ca LEFT JOIN creators cr ON cr.id = ca.creator_id
      WHERE ca.status IN ('followed', 'linked')`).iterate()) {
    let sig = {}; try { sig = JSON.parse(c.signals || '{}'); } catch { sig = {}; }
    let best = null; let bw = 0;
    for (const [k, w] of Object.entries(WEIGHTS)) { const v = w * Math.min((sig[k] || []).length, CAPS[k]); if (v > bw) { bw = v; best = k; } }
    if (!best) continue;
    const e = out.get(best) || { signal: best, followed: 0, posting: 0 };
    e.followed++; if ((c.media_count || 0) > 0) e.posting++;
    out.set(best, e);
  }
  return [...out.values()].sort((a, b) => b.followed - a.followed);
}

function status() {
  let last = null;
  try { last = JSON.parse(repo.discoveryState.get('lastRun') || 'null'); } catch { last = null; }
  const s = settingsStore.get();
  return {
    running, last, counts: repo.candidates.counts(), yield: signalYield(),
    brave: { configured: brave.configured(), usage: brave.usage(), budget: s.braveDailyBudget },
    websearch: websearch.status(),
    telegramBot: tgBot.configured(), xApi: !!config.creds.xBearer, communities: s.discoveryCommunities, autoCommunities: s.discoveryAutoCommunities, expand: s.discoveryExpand,
    onlyfans: { enabled: s.discoveryOnlyFans, ...repo.onlyfans.counts() },
    seeds: seedStatus(),
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

module.exports = { seedCreators, seedStatus, onlyfansDiscovery, discoverCreatorMentions, mentionSearchQuery, probeFediMentions, noteOnlyFans, notePaidHandles, noteSearchedPaid, probeOnlyFans, run, status, statusSummary: status, start, stop, follow, reject, promote, consider, mineMentions, blueskyGraph, braveIdentity, braveTopics, communityDiscovery, creatorHangouts, blueskyLookalikes, peopleSearch, signalYield, enrich, scoreOf, coreHandle, usable };
import sources from '../sources/index.js';
import { isMaleContent } from '../lib/scope.js';

async function discover(query) {
    const leads = [];
    
    for (const [name, adapter] of Object.entries(sources)) {
        try {
            const results = await adapter(query);
            for (const asset of results) {
                // HERE IS THE OVERRIDE: 
                // We only ingest the lead if it matches the male-content filter
                if (isMaleContent(query) || isMaleContent(asset.url)) {
                    leads.push(asset);
                }
            }
        } catch (err) {
            console.error(`Error scanning ${name}:`, err);
        }
    }
    return leads;
}
