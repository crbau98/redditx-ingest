'use strict';
/**
 * Creator-centric growth: apply what a platform tells us about a creator
 * (bio, avatar, links to their other accounts) and decide which discovered
 * creators are worth following.
 */
const repo = require('../db/repo');
const registry = require('../sources');
const events = require('./events');
const { checkText } = require('../lib/safety');
const { femaleCheck } = require('../lib/scope');

const LINKABLE_KINDS = new Set(['user', 'feed', 'page']);
const MAX_LINKED_FEEDS_PER_CREATOR = 10;

function applyProfile(feed, profile, settings) {
  const out = { linked: 0, blocked: false };
  if (!profile || !feed.creator_id) return out;
  const creator = repo.creators.get(feed.creator_id);
  if (!creator) return out;

  // A bio that says the person is under 18 ends the relationship, immediately.
  const safety = checkText(profile.displayName, profile.bio);
  if (safety.level === 'block') {
    repo.creators.block(creator.id, `safety:${safety.rule} (profile)`, 'system');
    events.log('WARN', `Creator ${creator.handle} blocked by safety gate (profile)`);
    return { ...out, blocked: true };
  }

  // PRISM follows men only: a female / feminine / trans-feminine profile ends the relationship too.
  const gender = femaleCheck(creator.handle, profile.displayName, profile.bio);
  if (gender.level === 'hard') {
    repo.creators.block(creator.id, `scope:${gender.rule} (profile)`, 'system');
    events.log('WARN', `Creator ${creator.handle} blocked by the male-only scope (profile: ${gender.rule})`);
    return { ...out, blocked: true };
  }

  repo.creators.enrich(creator.id, { displayName: profile.displayName, bio: profile.bio, avatarUrl: profile.avatarUrl, bannerUrl: profile.bannerUrl });
  if (profile.verified && !creator.verified) repo.creators.update(creator.id, { verified: true });

  const externals = [];
  for (const l of profile.links || []) {
    if (l.external) { externals.push({ platform: 'external', service: l.service, label: l.label, url: l.url }); continue; }
    if (!settings.autoLinkProfiles || !l.ingestable || !LINKABLE_KINDS.has(l.kind) || l.platform === 'web') continue;
    const adapter = registry.get(l.platform);
    if (!adapter || !adapter.kinds.includes(l.kind)) continue;
    if (repo.blocklist.has('creator', `${l.platform}:${String(l.target).toLowerCase()}`)) continue;
    if (repo.feeds.list({ creatorId: creator.id, limit: 1 }).total >= MAX_LINKED_FEEDS_PER_CREATOR) break;
    const owner = l.kind === 'user' ? repo.creators.byAccount(l.platform, l.target) : null;
    if (owner && owner.id !== creator.id) {
      events.log('INFO', `Possible duplicate creator: ${creator.handle} ↔ ${owner.handle} (${l.platform}) — merge from the Creators tab if it is the same person`);
      continue;
    }
    const r = repo.feeds.upsert({
      platform: l.platform, kind: l.kind, target: l.target, label: l.label, creatorId: creator.id, trusted: 1, origin: 'linked',
      intervalMin: (adapter.intervalMin && adapter.intervalMin[l.kind]) || 240,
    });
    if (r.created) { out.linked++; events.log('INFO', `Linked ${l.platform}:${l.target} to ${creator.handle}`); }
  }
  if (externals.length) repo.creators.enrich(creator.id, { links: externals });
  return out;
}

/** Turn on the user feed of any creator who has proven worthwhile. */
function autoTrack(creatorIds, settings) {
  if (!settings.autoTrack) return 0;
  let enabled = 0;
  let capacity = settings.maxFeeds - repo.feeds.countEnabled();
  for (const id of creatorIds) {
    if (capacity <= 0) break;
    const c = repo.creators.get(id);
    if (!c || c.status !== 'active') continue;
    const n = repo.db.prepare("SELECT COUNT(*) AS n FROM media WHERE creator_id = ? AND publish_state = 'published'").get(id).n;
    if (n < settings.autoTrackMinItems) continue;
    for (const f of repo.db.prepare("SELECT * FROM feeds WHERE creator_id = ? AND kind = 'user' AND enabled = 0 AND origin = 'ingest'").all(id)) {
      if (capacity <= 0) break;
      const stagger = new Date(Date.now() + Math.floor(Math.random() * 45 * 60000)).toISOString();
      repo.feeds.update(f.id, { enabled: true, nextRunAt: stagger });
      enabled++; capacity--;
    }
  }
  if (enabled) events.log('INFO', `Auto-followed ${enabled} creator${enabled === 1 ? '' : 's'}`);
  return enabled;
}

module.exports = { applyProfile, autoTrack };
