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
const { findOnlyFans, freeHint, ofLink } = require('../lib/onlyfans');

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

  // Body filter: a refreshed profile that now reads chub / gainer / dad bod hides the creator (reversible, see engine/physique).
  // The profile is stored first, so switching the filter off and on again re-reaches the same verdict.
  const physique = require('./physique');
  if (physique.enabled(physique.live(settings))) {
    const body = physique.textCheck(creator.handle, profile.displayName, profile.bio);
    if (body.heavy && physique.hideCreator(repo.creators.get(creator.id), `body filter: profile says "${body.rule.slice(physique.REASON.length)}"`)) return { ...out, hidden: true };
  }
  if (profile.verified && !creator.verified) repo.creators.update(creator.id, { verified: true });

  // His handles and names, and "backup / new account: @x" handles his bio names (engine/identity).
  const named = require('./identity').noteProfile(creator.id, feed, profile);
  if (settings.autoLinkProfiles) for (const a of named.accounts) require('./discovery').consider(a, 'identity', creator.id, { creatorId: creator.id });

  const externals = [];
  const free = freeHint(profile.bio);
  for (const l of profile.links || []) {
    if (l.external && l.handle && l.service === 'OnlyFans') { externals.push(ofLink(l.handle, { free })); continue; }
    if (l.external) { externals.push({ platform: 'external', service: l.service, label: l.label, url: l.url }); continue; }
    if (!settings.autoLinkProfiles || !l.ingestable || !LINKABLE_KINDS.has(l.kind) || l.platform === 'web') continue;
    const adapter = registry.get(l.platform);
    if (!adapter || !adapter.kinds.includes(l.kind)) continue;
    if (repo.blocklist.has('creator', `${l.platform}:${String(l.target).toLowerCase()}`)) continue;
    if (repo.feeds.list({ creatorId: creator.id, limit: 1 }).total >= MAX_LINKED_FEEDS_PER_CREATOR) break;
    const owner = l.kind === 'user' ? repo.creators.byAccount(l.platform, l.target) : null;
    if (owner && owner.id !== creator.id) { // his bio links to an account filed under someone else: maybe the same man (engine/identity)
      require('./identity').noteLink(creator.id, owner.id, { type: 'bio-link', from: creator.id, detail: `${l.platform}:${l.target}` }, { autoMerge: false }); // merged below, once the profile is applied
      continue;
    }
    const r = repo.feeds.upsert({
      platform: l.platform, kind: l.kind, target: l.target, label: l.label, creatorId: creator.id, trusted: 1, origin: 'linked',
      intervalMin: (adapter.intervalMin && adapter.intervalMin[l.kind]) || 240,
    });
    physique.screenFeed(r);
    if (r.created) { out.linked++; events.log('INFO', `Linked ${l.platform}:${l.target} to ${creator.handle}`); }
  }
  // "OnlyFans: @name" written out in the bio, with no link.
  for (const handle of findOnlyFans(profile.bio)) if (!externals.some((e) => e.handle === handle)) externals.push(ofLink(handle, { free }));
  if (externals.length) repo.creators.enrich(creator.id, { links: externals });
  for (const e of externals) if (e.handle) repo.onlyfans.claim(e.handle, creator.id);
  // Last, now nothing else will touch creator.id: merge him with any account the evidence says is the same man.
  const kept = require('./identity').settle(creator.id);
  if (kept !== creator.id) {
    out.mergedInto = kept;
    for (const e of externals) if (e.handle) repo.onlyfans.claim(e.handle, kept);
  }
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
