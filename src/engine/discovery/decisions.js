'use strict';
/** Part of discovery (src/engine/discovery.js), moved here unchanged: named-creator seeds, profile enrichment, and the follow / reject / promote decisions. */
const config = require('../../config');
const repo = require('../../db/repo');
const settingsStore = require('../../settings');
const events = require('../events');
const websearch = require('../../lib/websearch');
const tgBot = require('../../lib/telegram-bot');
const registry = require('../../sources');
const { parseProfile, extractLinks, profileUrl, linkHubHandle, isMisskeyHost, cleanDisplayName, cleanSlug } = require('../../lib/links');
const { classify, femaleCheck } = require('../../lib/scope');
const { findOnlyFans, freeHint, ofLink, creatorOnlyFans } = require('../../lib/onlyfans');
const paid = require('../../lib/paid');
const { normalizeBskyActor } = require('../../lib/bsky-actor');
const { WEIGHTS, CAPS, scoreOf, describeSignals, mergeSignal } = require('../discovery-score');
const { heavyRule, leadKey, splitLead, fetchBskyProfiles, SHARED_KINDS, sameName, noteSearchedPaid, judgeLookup, nothingFound } = require('./core');

/**
 * Creators the admin named (Admin → Discovery → creators to find): each is looked up by name across every
 * platform (handle probes, people search, web search, bios and link pages, every account verified through its
 * adapter) and his strong, new matches are followed as one creator. A name is retried monthly, so accounts he
 * opens later are picked up; one or two names per run, since a lookup is the heaviest thing discovery does.
 */
async function seedCreators({ perRun = 2, staleDays = 30, aborted = () => false, lookupImpl } = {}) {
  const lookup = lookupImpl || require('../lookup');
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
        if (/(?:_bot|bot)$/i.test(c.target)) {
          repo.candidates.update(c.id, { status: 'rejected', reason: 'Telegram: bots cannot be ingested as feeds', decided_at: new Date().toISOString() });
          continue;
        }
        const info = (tgAdapter && tgAdapter.lookupChannel)
          ? await tgAdapter.lookupChannel(c.target)
          : (tgBot.configured() ? await tgBot.channelInfo(c.target) : null);
        if (!info) { repo.candidates.update(c.id, { status: 'rejected', reason: 'Telegram: channel preview unavailable or private', decided_at: new Date().toISOString() }); continue; }
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
      // A target that is not a valid Bluesky actor is marked not found now: sent, it would fail the batch for the others.
      const actorOf = new Map(bsky.map((c) => [c.id, normalizeBskyActor(c.target)]));
      for (const c of bsky) if (!actorOf.get(c.id)) repo.candidates.update(c.id, nothingFound(c));
      const sendable = bsky.filter((c) => actorOf.get(c.id));
      const byActor = new Map();
      for (const p of await fetchBskyProfiles(sendable.map((c) => actorOf.get(c.id)))) {
        byActor.set(String(p.handle).toLowerCase(), p);
        if (p.did) byActor.set(p.did, p);
      }
      for (const c of sendable) {
        const p = byActor.get(actorOf.get(c.id));
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
  const targets = require('../../services/targets');
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
  // Auto-register the creator's public mirror page, but only the page that actually exists: the
  // creator index says which accounts the mirror has. Guessing `coomer/<service>/user/<handle>` from
  // a Reddit or Bluesky handle was registering hundreds of pages the mirror does not have (and
  // paying coomer's rate limit to find out). When the index is not loaded yet, the pass is skipped —
  // coomerNameDiscovery matches him by name later, which is the reliable path anyway.
  if (r.creator) {
    const t = require('../../services/targets');
    const ofPageNow = (c.signals.ofconfirmed || [])[0];
    const svcHandle = ofPageNow ? splitLead(ofPageNow) : null;
    const handle = (svcHandle && svcHandle.handle) || String(c.target || '').replace(/^@/, '').toLowerCase();
    try {
      const index = require('../../lib/coomer-index');
      const hit = handle ? index.best({ handle, name: c.display_name }) : null;
      if (hit) t.addSpec(`https://coomer.st/${hit.service}/user/${hit.id}`, { creatorId: r.creator.id, origin: 'discovered', trusted: true });
    } catch { /* the index is optional: discovery still runs without it */ }
  }
  repo.logAction('candidate', c.id, status === 'linked' ? 'link' : 'follow', describeSignals(c.signals) || null, actor);
  try { require('../engine').enqueue([r.feed.id], { trigger: 'discovery', front: false }); } catch { /* engine not running (tests) */ }
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

module.exports = { seedCreators, seedStatus, confirmOnlyFans, enrich, follow, reject, promote };
