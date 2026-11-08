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
const paid = require('../lib/paid');

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
  const free = paid.freeHint(profile.bio);
  for (const l of profile.links || []) {
    if (l.external && l.handle && l.service && paid.SERVICES[l.service] && paid.SERVICES[l.service].trace) {
      externals.push(paid.paidLink(l.service, l.handle, { free }));
      continue;
    }
    if (l.external && l.handle && (!l.service || l.service === 'OnlyFans')) {
      externals.push(paid.ofLink(l.handle, { free }));
      continue;
    }
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
  // "OnlyFans: @name" / "Fansly: @name" / "JFF: @name" written out in the bio, with no link.
  for (const { service, handle } of paid.findPaidHandles(profile.bio)) {
    if (!externals.some((e) => e.handle === handle && (e.service || 'OnlyFans') === service)) {
      externals.push(paid.paidLink(service, handle, { free }));
    }
  }
  if (externals.length) repo.creators.enrich(creator.id, { links: externals });
  // The paid page is a public page too: read it so the media the platform serves publicly is ingested
  // like the rest of the library, while the page stays on the profile as a link-out card.
  for (const e of externals) {
    if (!e || !e.url || !e.service || !paid.SERVICES[e.service]) continue;
    try { require('./paidpage').registerPaidPage(e.url, { creatorId: creator.id, origin: 'paid-page' }); }
    catch (err) { events.log('WARN', `Could not register the paid page ${e.url}: ${err.message}`); }
  }
  for (const e of externals) if (e.handle) repo.onlyfans.claim(e.handle, creator.id, e.service || 'OnlyFans');
  // Last, now nothing else will touch creator.id: merge him with any account the evidence says is the same man.
  const kept = require('./identity').settle(creator.id);
  if (kept !== creator.id) {
    out.mergedInto = kept;
    for (const e of externals) if (e.handle) repo.onlyfans.claim(e.handle, kept, e.service || 'OnlyFans');
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

async function crawlLinkHubs({ limit = 5 } = {}) {
  const settings = require('../settings').get();
  if (!settings.autoLinkProfiles) return { checked: 0, linked: 0, feeds: 0 };
  const http = require('../sources/http').forPlatform('linkhub', 800);
  const cheerio = require('cheerio');
  const { extractLinks, isLinkHubUrl, parseProfile } = require('../lib/links');
  const repo = require('../db/repo');
  const registry = require('../sources');
  const LINKABLE_KINDS = new Set(['user','feed','page']);
  const seen = new Set(JSON.parse(repo.discoveryState.get('linkhub.seen', '[]') || '[]'));
  let checked=0, linked=0, feeds=0;
  // creators whose stored links contain a hub
  const rows = repo.db.prepare("SELECT id, handle, links FROM creators WHERE links LIKE '%linktr.ee%' OR links LIKE '%allmylinks%' OR links LIKE '%beacons%' OR links LIKE '%lnk.bio%' OR links LIKE '%solo.to%' LIMIT ?").all(limit*4);
  for (const row of rows) {
    if (checked>=limit) break;
    let links=[]; try{links=JSON.parse(row.links||'[]')}catch{}
    for (const l of links) {
      if (checked>=limit) break;
      const url = l.url || l.href || '';
      if (!url || !isLinkHubUrl(url) || seen.has(url)) continue;
      seen.add(url); checked++;
      try {
        const html = await http.text(url, { timeout: 9000 });
        const $ = cheerio.load(html);
        // hrefs + hydration JSON (__NEXT_DATA__, JSON-LD) — extractLinks already handles raw hrefs
        const hrefs = $('a[href]').map((_,a)=>$(a).attr('href')).get().join(' ');
        const scripts = $('script[type="application/json"], script[id="__NEXT_DATA__"], script[type="application/ld+json"]').map((_,e)=>$(e).html()).get().join(' ');
        const extra = extractLinks(hrefs + ' ' + scripts + ' ' + html);
        for (const spec of extra) {
          if (!spec.ingestable || !LINKABLE_KINDS.has(spec.kind) || spec.platform==='web') continue;
          const adapter=registry.get(spec.platform);
          if (!adapter || !adapter.kinds.includes(spec.kind)) continue;
          const r = repo.feeds.upsert({ platform: spec.platform, kind: spec.kind, target: spec.target, label: spec.label, creatorId: row.id, trusted: 1, origin: 'linked', intervalMin: (adapter.intervalMin && adapter.intervalMin[spec.kind]) || 240 });
          if (r.created) feeds++;
          linked++;
        }
      } catch {}
    }
  }
  repo.discoveryState.set('linkhub.seen', JSON.stringify([...seen].slice(-500)));
  return { checked, linked, feeds };
}
module.exports = { applyProfile, autoTrack, crawlLinkHubs };
