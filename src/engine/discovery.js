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
const { parseProfile, extractLinks, profileUrl } = require('../lib/links');
const { checkText } = require('../lib/safety');
const { classify, femaleCheck } = require('../lib/scope');
const { findOnlyFans, freeHint, ofLink, creatorOnlyFans } = require('../lib/onlyfans');
const bskyHttp = require('../sources/http').forPlatform('bluesky', 400);

// similar: Bluesky lists the account among those most like a followed creator (per creator, max 4)
// hangout: a community where several followed creators post (per creator, max 6)
// ofconfirmed: the account links to the exact OnlyFans page we were looking for (same person, proven)
// onlyfans: the account has the same handle as an OnlyFans page creators promote (likely the same person)
const WEIGHTS = { identity: 6, mention: 3, cofollow: 1.5, search: 2, similar: 2, hangout: 1.5, ofconfirmed: 6, onlyfans: 2 };
const CAPS = { identity: 1, mention: 5, cofollow: 8, search: 3, similar: 4, hangout: 6, ofconfirmed: 1, onlyfans: 1 };
const FOLLOWABLE_KINDS = new Set(['user', 'page']);
// Communities and custom feeds mix many posters, so they are held to a stricter bar than people.
const SHARED_KINDS = new Set(['community', 'feedgen', 'list']);
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
  const verdict = gate(target, spec.label, displayName, bio);
  // Borderline wording waits for a human on a person, but a shared space with it is rejected outright,
  // whichever strategy found it (mentions, web search or community search).
  if (verdict.level === 'block' || (verdict.level === 'review' && SHARED_KINDS.has(spec.kind))) {
    const row = { status: 'rejected', reason: `safety: ${verdict.rule || 'blocked'}${verdict.level === 'review' ? ' (community)' : ''}`, decided_at: new Date().toISOString() };
    if (c) return repo.candidates.update(c.id, row);
    return repo.candidates.insert({ platform: spec.platform, kind: spec.kind, target, label: spec.label, url: spec.url || profileUrl(spec.platform, spec.kind, target), signals: {}, ...row });
  }

  // Male-only: a female / feminine / trans-feminine name, bio or community is rejected for good, never queued.
  const gender = femaleCheck(target, spec.label, displayName, bio);
  if (gender.level === 'hard') {
    const row = { status: 'rejected', reason: `scope: ${gender.rule}`, decided_at: new Date().toISOString() };
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
  if (meta.popularity) signals.popularity = Math.max(Number(signals.popularity) || 0, Math.round(Number(meta.popularity)) || 0);
  const scope = classify([displayName, bio, target].map(splitCamel), { trusted: false }).scope;
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
    noteOnlyFans(text, r.creator_id);
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

/** "gymjake" and "GymJake_X" are the same name; short or unrelated handles are not. */
function sameName(a, b) {
  const x = coreHandle(a); const y = coreHandle(b);
  if (x.length < 4 || y.length < 4) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.length - short.length <= 3 && (long.startsWith(short) || long.endsWith(short));
}

/**
 * OnlyFans pages named in a post. A creator naming a page with their own handle is telling us it is
 * theirs; any other page is a shout-out or a promo channel featuring someone: a lead to work later.
 */
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
    try { results = await websearch.search(`"${core}" (onlyfans OR bluesky OR twitter OR reddit OR redgifs OR telegram OR linktree)`, { budget }); searched++; } catch (e) {
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
    try { results = await websearch.search(q, { budget }); searched++; } catch (e) {
      if (e.budget || e.skip) break;
      events.log('WARN', `Discovery: web search "${q}" failed — ${e.message}`);
      continue;
    }
    for (const r of results) {
      const of = parseProfile(r.url);
      if (of && of.service === 'OnlyFans' && of.handle) { if (noteSearchedOnlyFans(of.handle, r)) found++; continue; }
      const specs = [parseProfile(r.url), ...extractLinks(`${r.description} ${r.title}`)];
      for (const spec of specs) if (consider(spec, 'search', q, { displayName: (r.title || '').split(/[(|•·-]/)[0].trim() || null, bio: r.description || null })) found++;
    }
  }
  repo.discoveryState.set('brave.topics.index', String(idx % Math.max(1, list.length)));
  return { searched, found };
}

/** A web search surfaced someone's OnlyFans page: its search snippet is their public bio. */
function noteSearchedOnlyFans(handle, r) {
  const name = (r.title || '').replace(/\s*[|(].*$/, '').replace(/\bonly\s?fans\b/ig, '').replace(/[-–—·:]+\s*$/, '').trim() || null;
  const bio = r.description || null;
  if (repo.onlyfans.ownerOf(handle)) return false;
  const existing = repo.onlyfans.get(handle);
  if (existing && existing.status !== 'pending' && existing.status !== 'searching') return false;
  repo.onlyfans.note(handle, { origin: 'search', displayName: name, bio, free: freeHint(`${r.title} ${bio}`) });
  return true;
}

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
    if (!spec) continue;
    let c = null;
    for (const cid of h.ids.slice(0, CAPS.hangout)) c = consider(spec, 'hangout', cid, { displayName: h.platform === 'reddit' ? `r/${h.community}` : h.community }) || c;
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
 * Keyword people search: Bluesky accounts whose name/bio match, and the RedGIFs creators behind the
 * top results for the keyword. Uses the same rotating community keywords (one per run).
 */
async function peopleSearch({ aborted = () => false } = {}) {
  const list = keywordList();
  const out = { searched: 0, found: 0, bluesky: 0, redgifs: 0 };
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
  return out;
}

/* ------------------------------------------------------ v4.14: OnlyFans */

const BSKY_HANDLE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TG_HANDLE = /^[a-z][a-z0-9_]{4,31}$/;
const namesOf = (text, handle) => findOnlyFans(text).includes(String(handle).toLowerCase());

/**
 * Look for the free, public accounts of the person behind an OnlyFans page: the same handle on RedGIFs and
 * Bluesky (free lookups), a web search for the exact page link (budgeted), and same-handle X / Telegram
 * leads that enrich() verifies. An account whose profile links that exact page is proven to be them.
 * @param {{handle: string}} lead
 * @param {(spec, proven: boolean, meta) => any} found  called for every account found
 */
async function probeOnlyFans(lead, found, { budget, search = true } = {}) {
  const handle = lead.handle;
  const rg = registry.get('redgifs');
  if (rg && rg.lookupUser) {
    try {
      const u = await rg.lookupUser(handle);
      if (u && u.gifs > 0) {
        const proven = namesOf(`${u.description || ''} ${u.links.join(' ')}`, handle);
        found(parseProfile(`https://www.redgifs.com/users/${u.username}`), proven, { displayName: u.name || u.username, bio: u.description, avatarUrl: u.avatar, popularity: u.followers });
      }
    } catch (e) { events.log('WARN', `Discovery: RedGIFs lookup for OnlyFans ${handle} — ${e.message}`); }
  }
  const bh = handle.replace(/[_.]/g, '');
  if (BSKY_HANDLE.test(bh)) {
    try {
      const json = await bskyHttp.json(`${config.baseUrls.bsky}/xrpc/app.bsky.actor.getProfiles?actors=${encodeURIComponent(`${bh}.bsky.social`)}`);
      for (const p of json.profiles || []) {
        if ((p.labels || []).some((l) => l.val === '!no-unauthenticated')) continue;
        const proven = namesOf(p.description, handle);
        found(parseProfile(`https://bsky.app/profile/${p.handle}`), proven, { displayName: p.displayName, bio: p.description, avatarUrl: p.avatar, popularity: p.followersCount });
      }
    } catch (e) { if (e.status !== 400) events.log('WARN', `Discovery: Bluesky lookup for OnlyFans ${handle} — ${e.message}`); }
  }
  // Same-handle guesses that enrich() confirms (or drops) once it reads the profile.
  const xa = registry.get('x');
  if (xa && xa.apiAvailable && xa.apiAvailable() && /^[a-z0-9_]{3,15}$/.test(handle)) found(parseProfile(`https://x.com/${handle}`), false, {});
  if (tgBot.configured() && TG_HANDLE.test(handle)) found(parseProfile(`https://t.me/${handle}`), false, {});
  if (search && websearch.configured()) {
    let results = [];
    try { results = await websearch.search(`"onlyfans.com/${handle}"`, { budget }); } catch (e) {
      if (!e.budget && !e.skip) events.log('WARN', `Discovery: web search for OnlyFans ${handle} — ${e.message}`);
      return { searched: false, outOfBudget: !!(e.budget || e.skip) };
    }
    for (const r of results) {
      const snippet = `${r.title || ''} ${r.description || ''}`;
      const page = parseProfile(r.url);
      const named = namesOf(snippet, handle); // the result page itself shows the exact OnlyFans link
      for (const spec of [page, ...extractLinks(snippet)]) {
        if (!usable(spec) || spec.kind === 'community') continue;
        const own = spec.platform === 'linkinbio' ? (new URL(spec.target).pathname.split('/').filter(Boolean)[0] || '') : spec.target;
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
 * Work the OnlyFans leads: (1) pages creators promote that we do not follow yet become discovery
 * candidates for that person's public accounts; (2) followed creators who have an OnlyFans page but few
 * known accounts get the same search, and what it finds is linked to them (their content from elsewhere).
 */
async function onlyfansDiscovery({ leads = 6, reach = 3, searches = 2, budget, aborted = () => false } = {}) {
  const out = { checked: 0, found: 0, linked: 0, searched: 0, rejected: 0 };
  let searchLeft = searches;
  for (const lead of repo.onlyfans.workable(leads)) {
    if (aborted()) break;
    const owner = repo.onlyfans.ownerOf(lead.handle);
    if (owner) { repo.onlyfans.claim(lead.handle, owner.id); continue; }
    const verdict = gate(lead.handle, lead.display_name, lead.bio);
    const gender = femaleCheck(lead.handle, lead.display_name, lead.bio);
    // Borderline wording ("teen") is not traced at all: unlike a queued candidate, a lead has no human checkpoint.
    if (verdict.level || gender.level === 'hard') {
      repo.onlyfans.update(lead.handle, { status: 'rejected', reason: verdict.level ? `safety: ${verdict.rule}` : `scope: ${gender.rule}`, checked_at: new Date().toISOString() });
      out.rejected++;
      continue;
    }
    const accounts = [];
    // Web searches are the scarce resource: spend them on pages more than one source vouches for.
    const search = searchLeft > 0 && (lead.mentions >= 2 || lead.origin === 'search' || lead.attempts > 0);
    const r = await probeOnlyFans(lead, (spec, proven, meta) => {
      const c = consider(spec, proven ? 'ofconfirmed' : 'onlyfans', lead.handle, { ...meta, ofSources: lead.sources.length || lead.mentions });
      if (c) accounts.push({ platform: spec.platform, kind: spec.kind, target: spec.target, proven, candidate: c.id });
    }, { budget, search });
    if (r.searched) { searchLeft--; out.searched++; }
    if (r.outOfBudget) searchLeft = 0;
    out.checked++;
    if (accounts.length) out.found++;
    repo.onlyfans.update(lead.handle, { status: accounts.length ? 'found' : 'searching', accounts: accounts.length ? accounts : lead.accounts, attempts: (lead.attempts || 0) + 1, checked_at: new Date().toISOString() });
  }
  for (const t of repo.onlyfans.reachTargets(reach)) {
    if (aborted()) break;
    const of = creatorOnlyFans(t);
    repo.discoveryState.set(`of.reach.${t.id}`, new Date().toISOString());
    if (!of) continue;
    const r = await probeOnlyFans({ handle: of.handle }, (spec, proven, meta) => {
      // the creator's own other account: an identity link (same person), not a new creator
      const owner = spec.kind === 'user' ? repo.creators.byAccount(spec.platform, spec.target) : null;
      if (owner) return;
      // probeOnlyFans only reports same-handle or proven accounts; a same-handle one is theirs only when
      // the OnlyFans handle is also the creator's own name (otherwise it may be a namesake)
      if (!proven && !sameName(t.handle, of.handle)) return;
      if (consider(spec, 'identity', t.id, { ...meta, creatorId: t.id })) out.linked++;
    }, { budget, search: searchLeft > 0 });
    if (r.searched) { searchLeft--; out.searched++; }
    if (r.outOfBudget) searchLeft = 0;
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
    const summary = {
      at: new Date().toISOString(), error: (r && r.error) || null,
      creatorId: f ? f.creator.id : (known[0] && known[0].creatorId) || null,
      followed: f ? f.feeds.length : 0, already: known.length,
      onlyfans: ((r && r.externalLinks) || []).filter((l) => l.handle).map((l) => l.handle),
      note: (r && r.note) || null,
    };
    if (f) { out.followed++; out.accounts += f.feeds.length; }
    // already followed earlier: the page he links still belongs on his profile
    if (!f && summary.creatorId && summary.onlyfans.length) {
      repo.creators.enrich(summary.creatorId, { links: summary.onlyfans.map((h) => ofLink(h)) });
      for (const h of summary.onlyfans) repo.onlyfans.claim(h, summary.creatorId);
    }
    // "creators like him": pages that come up next to his name (lists, collabs) become OnlyFans leads to trace
    if (websearch.configured() && !summary.error) {
      try {
        for (const res of await websearch.search(`"${name}" male onlyfans creators like`, { budget: settingsStore.get().braveDailyBudget })) {
          const spec = parseProfile(res.url);
          const pages = spec && spec.service === 'OnlyFans' && spec.handle ? [spec.handle] : findOnlyFans(`${res.title || ''} ${res.description || ''}`);
          for (const h of pages) if (!summary.onlyfans.includes(h) && noteSearchedOnlyFans(h, spec && spec.handle === h ? res : { title: null, description: null })) summary.similar = (summary.similar || 0) + 1;
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

/** A profile read later (enrich) that links the OnlyFans page we guessed from its handle proves it. */
function confirmOnlyFans(c, bio) {
  const handle = (c.signals.onlyfans || [])[0];
  if (!handle || !namesOf(bio, handle)) return c.signals;
  const signals = { ...c.signals, ofconfirmed: [handle] };
  delete signals.onlyfans;
  return signals;
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
  // An account proven to belong to an OnlyFans creator carries that page onto their creator profile.
  const ofPage = (c.signals.ofconfirmed || [])[0];
  if (ofPage && r.creator) {
    const lead = repo.onlyfans.get(ofPage);
    repo.creators.enrich(r.creator.id, { links: [ofLink(ofPage, { free: !!(lead && lead.free) })] });
    repo.onlyfans.claim(ofPage, r.creator.id);
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
      const vouched = (c.signals.ofconfirmed || []).length && (Number(c.signals.ofsrc) || 0) >= 1 && c.scope !== 'excluded';
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
      report.identity = await braveIdentity({ budget: s.braveDailyBudget, aborted });
      report.topics = await braveTopics({ budget: s.braveDailyBudget, aborted });
    }
    report.seeds = await seedCreators({ aborted });
    if (s.discoveryOnlyFans) report.onlyfans = await onlyfansDiscovery({ budget: s.braveDailyBudget, aborted });
    if (s.discoveryCommunities) report.communities = await communityDiscovery({ aborted });
    if (s.discoveryCommunities) report.hangouts = creatorHangouts();
    if (s.discoveryExpand) {
      report.lookalikes = await blueskyLookalikes({ aborted });
      report.people = await peopleSearch({ aborted });
    }
    report.enrich = await enrich();
    report.promote = s.autoDiscover || trigger === 'manual' ? promote(s) : { followed: 0, linked: 0 };
    report.pruned = repo.candidates.prune();
    events.log('INFO', `Discovery ${trigger === 'manual' ? '(manual) ' : ''}finished: ${report.mentions.found} mention leads, ${report.graph ? report.graph.found : 0} graph leads, ${report.topics ? report.topics.found : 0} search leads, ${report.communities ? report.communities.found : 0} community/feed leads, ${report.hangouts ? report.hangouts.found : 0} hangouts, ${report.lookalikes ? report.lookalikes.found : 0} lookalikes, ${report.people ? report.people.found : 0} people-search leads, ${report.identity ? report.identity.linked : 0} identity matches, ${report.seeds ? report.seeds.followed : 0} named creators found, ${report.onlyfans ? report.onlyfans.found : 0} OnlyFans creators traced (${report.onlyfans ? report.onlyfans.linked : 0} accounts linked); followed ${report.promote.followed}, linked ${report.promote.linked}`);
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

module.exports = { seedCreators, seedStatus, onlyfansDiscovery, noteOnlyFans, probeOnlyFans, run, status, start, stop, follow, reject, promote, consider, mineMentions, blueskyGraph, braveIdentity, braveTopics, communityDiscovery, creatorHangouts, blueskyLookalikes, peopleSearch, signalYield, enrich, scoreOf, coreHandle, usable };
