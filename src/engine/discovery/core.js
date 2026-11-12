'use strict';
/** Part of discovery (src/engine/discovery.js), moved here unchanged: shared discovery helpers: the safety / scope gates, consider() (record a signal on a candidate), handle matching, paid-page notes, mention mining and the shared HTTP limiters. */
const config = require('../../config');
const repo = require('../../db/repo');
const settingsStore = require('../../settings');
const registry = require('../../sources');
const { parseProfile, extractLinks, profileUrl, linkHubHandle, isMisskeyHost, cleanDisplayName, cleanSlug } = require('../../lib/links');
const { checkText } = require('../../lib/safety');
const takedowns = require('../../lib/takedowns');
const { classify, femaleCheck } = require('../../lib/scope');
const physiqueText = require('../../lib/physique').textCheck;
const net = require('../../lib/net');
const { findOnlyFans, freeHint, ofLink, creatorOnlyFans } = require('../../lib/onlyfans');
const paid = require('../../lib/paid');
const { WEIGHTS, CAPS, scoreOf, describeSignals, mergeSignal } = require('../discovery-score');

/** Body filter on and the name / bio reads chub, gainer, dad bod ...: the rule that matched, else null. */
function heavyRule(...texts) {
  if (!settingsStore.get().physiqueFilter) return null;
  const t = physiqueText(...texts);
  return t.heavy ? t.rule : null;
}
const leadKey = (service, handle) => (service && service !== 'OnlyFans' ? `${service}:${handle}` : handle);
function splitLead(key) {
  const i = String(key || '').indexOf(':');
  if (i > 0 && paid.SERVICES[String(key).slice(0, i)]) return { service: String(key).slice(0, i), handle: String(key).slice(i + 1) };
  return { service: 'OnlyFans', handle: String(key || '') };
}
const bskyHttp = require('../../sources/http').forPlatform('bluesky', 400);
// The Reddit archive is its own host with no Reddit quota, so it gets its own limiter key and never
// waits behind a reddit feed's rate-limit hold.
const archiveHttp = require('../../sources/http').forPlatform('redditArchive', 300);

/**
 * getProfiles for a list of actors. The AppView fails the whole request (HTTP 400) when any one actor is invalid, so a 400
 * splits the list in half and retries each half; an actor that still fails alone is dropped (added to `rejected`) and the
 * other profiles come back. Any other failure is thrown to the caller as before.
 */
async function fetchBskyProfiles(actors, rejected = []) {
  const list = [...new Set(actors.filter(Boolean))];
  if (!list.length) return [];
  const qs = list.map((a) => `actors=${encodeURIComponent(a)}`).join('&');
  try {
    const json = await bskyHttp.json(`${config.baseUrls.bsky}/xrpc/app.bsky.actor.getProfiles?${qs}`);
    return (json && json.profiles) || [];
  } catch (e) {
    if (!e || e.status !== 400) throw e;
    if (list.length === 1) { rejected.push(list[0]); return []; }
    const mid = Math.ceil(list.length / 2);
    return [...await fetchBskyProfiles(list.slice(0, mid), rejected), ...await fetchBskyProfiles(list.slice(mid), rejected)];
  }
}
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

/** Is this spec something discovery may follow at all? */
function usable(spec) {
  if (!spec || spec.external || !spec.ingestable) return false;
  if (spec.platform === 'web' || spec.platform === 'rss') return false; // arbitrary sites are too noisy to auto-follow
  if (spec.kind === 'community' && spec.platform === 'reddit') return true;
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

  const signals = mergeSignal(c ? c.signals : null, type, value, meta);
  if (!signals) return c; // an OnlyFans guess never overrides a confirmed OnlyFans link
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
 * OnlyFans, Fansly and JustFor.Fans are traced; the paid pages are read like any other public page.
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

/** The word a search title is cut at, per service, so the name in front of it is the person's name. */
const PAID_TITLE_CUT = {
  'OnlyFans': 'only\\s*fans', 'Fansly': 'fansly', 'JustFor.Fans': '(?:justfor\\.?fans|jff)',
  'ManyVids': 'manyvids', 'LoyalFans': 'loyalfans', 'Fanvue': 'fanvue', 'FanCentro': 'fancentro', 'Clips4Sale': 'clips4sale',
  'Patreon': 'patreon',
};

/** A web search surfaced someone's paid page: its search snippet is their public bio. */
function noteSearchedPaid(service, handle, r) {
  const title = (r.title || '').split(/\s*[[(|]/, 1)[0];
  const cut = PAID_TITLE_CUT[service] || 'only\\s*fans';
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

module.exports = { heavyRule, leadKey, splitLead, bskyHttp, archiveHttp, fetchBskyProfiles, FOLLOWABLE_KINDS, SHARED_KINDS, splitCamel, gate, borderline, CREATOR_STRONG, CREATOR_HINT, coreHandle, usable, consider, MENTION_PATTERNS, mineMentions, sameName, notePaidHandles, noteOnlyFans, PAID_TITLE_CUT, noteSearchedPaid, noteSearchedOnlyFans, ADULT_HINT, keywordList, underReview, judgeLookup, nothingFound };
