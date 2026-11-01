'use strict';
/**
 * Admin-facing operations for adding things to follow: pasted links and
 * handles become feeds and creators, with the invariants the engine relies on
 * (every `user` feed has a creator; paid / closed platforms are display-only).
 */
const repo = require('../db/repo');
const paid = require('../lib/paid');
const registry = require('../sources');
const { checkText } = require('../lib/safety');
const { femaleCheck } = require('../lib/scope');
const physiqueText = require('../lib/physique').textCheck;
const { profileUrl } = require('../lib/links');

/** Clean a raw platform target ("onlyfans/renogold", "https://gayforfans.com/performer/reno-gold-c2gav", "Paul Wagner (paulwagner)") into a human handle and display name. */
function cleanCreatorNames(spec) {
  const rawLabel = spec.label ? String(spec.label).replace(/^[@u/]+/, '').trim() : '';
  const rawTarget = String(spec.target || '').trim();
  if (spec.platform === 'gff' || /^https?:\/\/(?:gayforfans\.com|justthegays\.tv)\/performer\//i.test(rawTarget)) {
    const slug = (rawTarget.match(/\/performer\/([a-z0-9-]+)/i) || [])[1] || '';
    // The slug ends in a site id ("reno-gold-66", "alejandro-pino-hotalex6-x9b1v"): drop it.
    const baseSlug = slug.replace(/-[a-z0-9]{4,6}$/i, '');
    const paren = rawLabel.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    const displayName = paren ? paren[1].trim() : (rawLabel && !/^https?:/i.test(rawLabel) && rawLabel !== slug ? rawLabel : baseSlug.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));
    // The handle is the name plus his stage/paid handle ("alejandro-pino-hotalex6" → "alejandropinohotalex6"),
    // so two pages of the same man share it.
    const handle = paren ? paren[2].trim().replace(/^@/, '') : baseSlug.replace(/-/g, '');
    return { handle: handle || slug, displayName: displayName || handle || slug };
  }
  if (spec.platform === 'coomer') {
    const bare = rawTarget.replace(/^(?:onlyfans|fansly|patreon|subscribestar|gd|justforfans)\//i, '');
    const cleanLabel = rawLabel.replace(/\s*\((?:onlyfans|fansly|patreon|subscribestar|gd|justforfans)\s+on\s+coomer\)\s*$/i, '').trim();
    return { handle: bare || rawTarget, displayName: cleanLabel || bare || rawTarget };
  }
  return { handle: rawTarget, displayName: rawLabel || rawTarget };
}

const defaultInterval = (spec) => {
  const a = registry.get(spec.platform);
  return (a && a.intervalMin && a.intervalMin[spec.kind]) || 180;
};

/**
 * Add one parsed spec. Returns {status, feed?, creator?, reason?}
 *   created | exists | conflict | external | invalid
 */
function addSpec(spec, { creatorId = null, origin = 'admin', trusted, hint, bodyOverride = false } = {}) {
  if (typeof spec === 'string') spec = registry.parseInput(spec, hint);
  if (!spec) return { status: 'invalid', reason: 'Not a recognised handle, community or link' };
  if (spec.external) return { status: 'external', spec };
  if (repo.blocklist.has('creator', `${spec.platform}:${String(spec.target).toLowerCase()}`)) {
    return { status: 'invalid', reason: 'This account is on the blocklist' };
  }

  // Male-only: refuse accounts, communities and searches whose own name reads female / feminine.
  const gender = femaleCheck(spec.target, spec.label);
  if (gender.level === 'hard') return { status: 'invalid', reason: `Not male-focused (${gender.rule})` };
  // Body filter: chub / gainer / dad-bod accounts and communities are refused while it is on (Admin → Settings).
  if (!bodyOverride && require('../settings').get().physiqueFilter) {
    const body = physiqueText(spec.target, spec.label);
    if (body.heavy) return { status: 'invalid', reason: `Body filter (${body.rule.replace(/^physique:/, '')}): switch it off in Settings to add this` };
  }

  let creator = creatorId ? repo.creators.get(creatorId) : null;
  if (spec.kind === 'user' || (spec.kind === 'channel' && spec.platform === 'youtube')) {
    const owner = repo.creators.byAccount(spec.platform, spec.target);
    if (owner && creator && owner.id !== creator.id) return { status: 'conflict', creator: owner, spec, reason: `Already belongs to ${owner.display_name || owner.handle}` };
    if (owner) creator = owner;
    if (!creator) {
      if (checkText(spec.target, spec.label).level === 'block') return { status: 'invalid', reason: 'Rejected by the safety gate' };
      const { handle, displayName } = cleanCreatorNames(spec);
      // The same man often has two pages on one platform ("reno-gold-c2gav" and "reno-gold-71").
      // When his name already belongs to a creator, the new page belongs to him too — otherwise
      // every page of one performer becomes a creator of his own.
      const named = repo.db.prepare("SELECT id FROM creators WHERE status != 'blocked' AND LOWER(display_name) = LOWER(?) AND LENGTH(?) >= 5 ORDER BY media_count DESC LIMIT 1").get(displayName, displayName);
      if (named) creator = repo.creators.get(named.id);
      else creator = repo.creators.create({ handle, displayName, origin });
    }
  }
  const res = repo.feeds.upsert({
    platform: spec.platform, kind: spec.kind, target: spec.target, label: spec.label,
    creatorId: creator ? creator.id : (['feed', 'page'].includes(spec.kind) ? creatorId : null),
    trusted: trusted !== undefined ? trusted : (['search', 'tag'].includes(spec.kind) ? 0 : 1),
    origin, intervalMin: defaultInterval(spec),
  });
  if (!res.created && !res.feed.enabled) repo.feeds.update(res.feed.id, { enabled: true, runNow: true });
  return { status: res.created ? 'created' : 'exists', feed: repo.feeds.get(res.feed.id), creator };
}

const tokens = (text) => String(Array.isArray(text) ? text.join('\n') : text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

/** One creator with any number of profile links (any platform). */
function addCreator({ name, inputs, bio }) {
  const specs = [];
  const skipped = [];
  for (const raw of tokens(inputs)) {
    const spec = registry.parseInput(raw);
    if (spec) specs.push(spec); else skipped.push({ input: raw, reason: 'Unrecognised link or handle' });
  }
  const ingestable = specs.filter((s) => !s.external);
  if (!ingestable.length && !specs.length && !name) return { error: 'Provide at least one profile link or a name' };

  // If any account already belongs to a creator (or a creator with the same name/handle exists), extend that creator instead of duplicating.
  let creator = null;
  for (const s of ingestable) {
    if (s.kind !== 'user' && !(s.kind === 'channel' && s.platform === 'youtube')) continue;
    const owner = repo.creators.byAccount(s.platform, s.target);
    if (owner) { creator = owner; break; }
  }
  if (!creator && name) {
    const cleanName = String(name).trim();
    const core = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const match = repo.db.prepare("SELECT * FROM creators WHERE status != 'blocked' AND (LOWER(handle) = LOWER(?) OR LOWER(display_name) = LOWER(?) OR LOWER(handle) = ?) ORDER BY media_count DESC LIMIT 1").get(cleanName, cleanName, core);
    if (match) creator = repo.creators.get(match.id);
  }
  if (creator && creator.status === 'blocked') return { error: `${creator.display_name || creator.handle} is blocked. Restore them first if you want to follow them again.` };
  if (!creator) {
    const first = ingestable.find((s) => s.kind === 'user') || ingestable[0];
    const handle = name || (first && String(first.label || first.target).replace(/^[@/]?(?:u\/)?/, '')) || 'creator';
    if (checkText(handle, name, bio).level === 'block') return { error: 'Rejected by the safety gate' };
    const g = femaleCheck(handle, name, bio);
    if (g.level === 'hard') return { error: `Not male-focused (${g.rule}) — PRISM only follows male creators` };
    creator = repo.creators.create({ handle, displayName: name || handle, bio, origin: 'admin' });
  } else if (name || bio) {
    repo.creators.update(creator.id, { displayName: name || undefined, bio: bio || undefined });
  }

  const feeds = []; const conflicts = []; const links = [];
  for (const s of specs) {
    if (s.external) {
      const traceable = s.handle && s.service && paid.SERVICES[s.service] && paid.SERVICES[s.service].trace;
      links.push(traceable ? paid.paidLink(s.service, s.handle) : { platform: 'external', service: s.service, label: s.label, url: s.url });
      continue;
    }
    const r = addSpec(s, { creatorId: creator.id });
    if (r.status === 'conflict') conflicts.push({ input: s.label || s.target, reason: r.reason, creatorId: r.creator.id });
    else if (r.feed) feeds.push(r.feed);
  }
  if (links.length) repo.creators.enrich(creator.id, { links });
  // A paid page added by hand: discovery then looks for this person's free accounts elsewhere.
  for (const l of links) if (l.handle) repo.onlyfans.claim(l.handle, creator.id, l.service || 'OnlyFans');
  return { creator: repo.creators.detail(creator.id), feeds, conflicts, skipped, links };
}

const decodeXml = (s) => String(s).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

/**
 * OPML (the subscription-list format every feed reader exports) -> feed specs.
 * Outlines are known to be feeds, so a URL we would otherwise treat as a web page becomes an RSS feed;
 * URLs we recognise as a platform (e.g. a subreddit's .rss) become that platform's native feed instead.
 */
function parseOpml(text) {
  const specs = [];
  for (const tag of String(text).match(/<outline\b[^>]*>/gi) || []) {
    const attr = (name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')); return m ? decodeXml(m[2] ?? m[3]).trim() : ''; };
    const url = attr('xmlUrl');
    if (!/^https?:\/\//i.test(url)) continue;
    const title = (attr('title') || attr('text')).slice(0, 120);
    const p = registry.parseInput(url);
    if (p && p.platform !== 'web' && p.platform !== 'linkinbio') specs.push(p);
    else specs.push({ platform: 'rss', kind: 'feed', target: url, label: title || url, ingestable: true });
  }
  return specs;
}

/** Bulk paste: each token becomes its own feed (communities, searches, feeds, accounts...). Also accepts OPML. */
function importTargets(text, { hint } = {}) {
  const out = { created: 0, exists: 0, external: 0, invalid: [], feeds: [] };
  const opml = /<opml[\s>]/i.test(String(text));
  for (const raw of opml ? parseOpml(text) : tokens(text)) {
    const r = addSpec(raw, { hint, origin: 'import' });
    if (r.status === 'created') { out.created++; out.feeds.push(r.feed); }
    else if (r.status === 'exists') out.exists++;
    else if (r.status === 'external') out.external++;
    else out.invalid.push({ input: typeof raw === 'string' ? raw : raw.target, reason: r.reason || r.status });
  }
  return out;
}

/** Public-safe list of a creator's account links. */
function publicAccounts(creatorId) {
  return repo.feeds.list({ creatorId, limit: 50 }).items
    .filter((f) => f.kind === 'user' || (f.kind === 'channel' && (f.platform === 'youtube' || f.platform === 'telegram')) || (f.kind === 'feed' && f.platform === 'rss'))
    .map((f) => ({ platform: f.platform, label: f.label || f.target, url: profileUrl(f.platform, f.kind, f.target) }))
    .filter((a) => a.url);
}

function moderate(id, action, reason, actor = 'admin') {
  const m = repo.media.get(id);
  if (!m) return null;
  switch (action) {
    case 'approve': case 'publish':
      repo.media.update(id, { publish_state: 'published', scope: 'in' });
      if (m.physique != null) {
        if (String(m.review_reason || '').startsWith('physique:')) repo.media.setPhysique(id, require('../engine/physique').APPROVED); // overriding the body filter itself: no sweep or setting hides it again
        else {
          // approved for another reason (safety / scope review): the body verdict still applies
          const physique = require('../engine/physique');
          const v = physique.stateFor(m.physique, require('../settings').get());
          if (v) repo.media.setState(id, v.state, v.reason, { exact: true });
        }
      }
      break;
    case 'hide': repo.media.setState(id, 'hidden', reason); break;
    case 'flag': repo.media.setState(id, 'review', reason); break;
    case 'reject': case 'remove': repo.media.setState(id, 'removed', reason); break;
    case 'block': repo.media.block(id, reason, actor); return repo.media.get(id);
    default: return undefined;
  }
  repo.logAction('media', id, action, reason, actor);
  return repo.media.get(id);
}

module.exports = { addSpec, addCreator, importTargets, parseOpml, publicAccounts, moderate, tokens };
