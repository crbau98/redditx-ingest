'use strict';
/**
 * Admin-facing operations for adding things to follow: pasted links and
 * handles become feeds and creators, with the invariants the engine relies on
 * (every `user` feed has a creator; external/paywalled links are display-only).
 */
const repo = require('../db/repo');
const registry = require('../sources');
const { checkText } = require('../lib/safety');
const { profileUrl } = require('../lib/links');

const defaultInterval = (spec) => {
  const a = registry.get(spec.platform);
  return (a && a.intervalMin && a.intervalMin[spec.kind]) || 180;
};

/**
 * Add one parsed spec. Returns {status, feed?, creator?, reason?}
 *   created | exists | conflict | external | invalid
 */
function addSpec(spec, { creatorId = null, origin = 'admin', trusted, hint } = {}) {
  if (typeof spec === 'string') spec = registry.parseInput(spec, hint);
  if (!spec) return { status: 'invalid', reason: 'Not a recognised handle, community or link' };
  if (spec.external) return { status: 'external', spec };
  if (repo.blocklist.has('creator', `${spec.platform}:${String(spec.target).toLowerCase()}`)) {
    return { status: 'invalid', reason: 'This account is on the blocklist' };
  }

  let creator = creatorId ? repo.creators.get(creatorId) : null;
  if (spec.kind === 'user') {
    const owner = repo.creators.byAccount(spec.platform, spec.target);
    if (owner && creator && owner.id !== creator.id) return { status: 'conflict', creator: owner, spec, reason: `Already belongs to ${owner.display_name || owner.handle}` };
    if (owner) creator = owner;
    if (!creator) {
      if (checkText(spec.target, spec.label).level === 'block') return { status: 'invalid', reason: 'Rejected by the safety gate' };
      creator = repo.creators.create({ handle: spec.target, displayName: spec.label ? spec.label.replace(/^[@u/]+/, '') : spec.target, origin });
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

  // If any account already belongs to a creator, extend that creator instead of duplicating.
  let creator = null;
  for (const s of ingestable) {
    if (s.kind !== 'user') continue;
    const owner = repo.creators.byAccount(s.platform, s.target);
    if (owner) { creator = owner; break; }
  }
  if (creator && creator.status === 'blocked') return { error: `${creator.display_name || creator.handle} is blocked. Restore them first if you want to follow them again.` };
  if (!creator) {
    const first = ingestable.find((s) => s.kind === 'user') || ingestable[0];
    const handle = name || (first && String(first.label || first.target).replace(/^[@/]?(?:u\/)?/, '')) || 'creator';
    if (checkText(handle, name, bio).level === 'block') return { error: 'Rejected by the safety gate' };
    creator = repo.creators.create({ handle, displayName: name || handle, bio, origin: 'admin' });
  } else if (name || bio) {
    repo.creators.update(creator.id, { displayName: name || undefined, bio: bio || undefined });
  }

  const feeds = []; const conflicts = []; const links = [];
  for (const s of specs) {
    if (s.external) { links.push({ platform: 'external', service: s.service, label: s.label, url: s.url }); continue; }
    const r = addSpec(s, { creatorId: creator.id });
    if (r.status === 'conflict') conflicts.push({ input: s.label || s.target, reason: r.reason, creatorId: r.creator.id });
    else if (r.feed) feeds.push(r.feed);
  }
  if (links.length) repo.creators.enrich(creator.id, { links });
  return { creator: repo.creators.detail(creator.id), feeds, conflicts, skipped, links };
}

/** Bulk paste: each token becomes its own feed (communities, searches, feeds, accounts...). */
function importTargets(text, { hint } = {}) {
  const out = { created: 0, exists: 0, external: 0, invalid: [], feeds: [] };
  for (const raw of tokens(text)) {
    const r = addSpec(raw, { hint, origin: 'import' });
    if (r.status === 'created') { out.created++; out.feeds.push(r.feed); }
    else if (r.status === 'exists') out.exists++;
    else if (r.status === 'external') out.external++;
    else out.invalid.push({ input: raw, reason: r.reason || r.status });
  }
  return out;
}

/** Public-safe list of a creator's account links. */
function publicAccounts(creatorId) {
  return repo.feeds.list({ creatorId, limit: 50 }).items
    .filter((f) => f.kind === 'user' || f.kind === 'feed')
    .map((f) => ({ platform: f.platform, label: f.label || f.target, url: profileUrl(f.platform, f.kind, f.target) }))
    .filter((a) => a.url);
}

function moderate(id, action, reason, actor = 'admin') {
  const m = repo.media.get(id);
  if (!m) return null;
  switch (action) {
    case 'approve': case 'publish': repo.media.update(id, { publish_state: 'published', scope: 'in' }); break;
    case 'hide': repo.media.setState(id, 'hidden', reason); break;
    case 'flag': repo.media.setState(id, 'review', reason); break;
    case 'reject': case 'remove': repo.media.setState(id, 'removed', reason); break;
    case 'block': repo.media.block(id, reason, actor); return repo.media.get(id);
    default: return undefined;
  }
  repo.logAction('media', id, action, reason, actor);
  return repo.media.get(id);
}

module.exports = { addSpec, addCreator, importTargets, publicAccounts, moderate, tokens };
