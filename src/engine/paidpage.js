'use strict';
/**
 * A paid creator page is a public page.
 *
 * PRISM keeps the paid page on the creator's profile as a link-out card (what fans pay for stays
 * between creator and audience) AND reads the page itself like any other web page, so the media the
 * platform serves publicly to any visitor — free posts, previews, teasers, public CDN assets — is
 * ingested like the rest of the library.
 *
 * Owner decision 2026-11-05: this holds for every paid service PRISM knows, for mirror, leak,
 * tube-rip and file-locker hosts too, and for a paid page that only a web or image search
 * surfaced. What stays hard: no paywall or entitlement bypass, no signing in as a fan, no borrowed
 * session cookie or token, no private or subscriber-only content — and the safety gate, the
 * male-only scope gate and takedowns run on every item the page yields.
 *
 *   paidPageUrl(url)        {service, handle, url} for a paid service page, or null
 *   registerPaidPage(url)   register that page as a web/page feed, so the web adapter reads it
 *   registerPaidMirror(service, handle)  the creator's public mirror page, which is where the content
 *                          actually is when the platform itself serves a login shell
 */
const repo = require('../db/repo');
const paid = require('../lib/paid');
const takedowns = require('../lib/takedowns');
const settingsStore = require('../settings');

/** The canonical public page of a paid service, or null when the URL is not one. */
function paidPageUrl(url) {
  const service = paid.serviceOf(url);
  if (!service) return null;
  const handle = paid.paidHandle(service, url);
  if (!handle) return null;
  return { service, handle, url: paid.pageUrl(service, handle) };
}

/**
 * The paid services the public mirror (coomer.st) carries, and the segment it uses for each.
 * The mirror serves the same creator's posts on its own public API - no login, no credits - so it
 * is the free way to pull a creator in when the platform itself answers with a login shell.
 */
const MIRROR_SERVICES = {
  'OnlyFans': 'onlyfans', 'Fansly': 'fansly', 'JustFor.Fans': 'justforfans',
  'Patreon': 'patreon', 'SubscribeStar': 'subscribestar', 'GD': 'gd',
};

/** How many paid pages one creator may have read. A creator has one or two; the cap stops a noisy profile from eating the feed budget. */
const MAX_PAID_PAGES_PER_CREATOR = 3;

/**
 * Register a paid page as a web/page feed so its public media is read like any other page.
 * Idempotent: an existing feed for the same page is reused (its creator is filled in when we know it).
 * @returns {object|null} the feed row, or null when the URL is not a paid page, is taken down, or the
 *   feed cap is reached.
 */
function registerPaidPage(url, { creatorId = null, origin = 'paid-page', trusted = null } = {}) {
  const page = paidPageUrl(url);
  if (!page) return null;
  if (takedowns.checkUrl(page.url)) return null;
  // The platform itself often answers with a login shell (OnlyFans: a 17 KB app shell, Fansly: the same
  // generic shell), so the page feed can be empty. The creator's public mirror page is where the content
  // actually is, and it costs nothing: register it alongside.
  registerPaidMirror(page.service, page.handle);
  const existing = repo.feeds.find('web', 'page', page.url);
  if (existing) {
    if (creatorId && !existing.creator_id) repo.feeds.update(existing.id, { creatorId });
    return existing;
  }
  const cfg = settingsStore.get();
  if (repo.feeds.countEnabled() >= cfg.maxFeeds) return null;
  if (creatorId) {
    const pages = repo.feeds.list({ creatorId, platform: 'web', limit: MAX_PAID_PAGES_PER_CREATOR + 1 }).total;
    if (pages >= MAX_PAID_PAGES_PER_CREATOR) return null;
  }
  const r = repo.feeds.upsert({
    platform: 'web', kind: 'page', target: page.url, label: `${page.service} · ${page.handle}`,
    creatorId, trusted: trusted === null ? (creatorId ? 1 : 0) : trusted, origin, intervalMin: 720, runNow: true,
  });
  return r.feed || null;
}

/**
 * Register the creator's public mirror page (coomer.st) as a coomer feed, so the content that the paid
 * platform does not serve to an anonymous reader still reaches the library - free, no login, no credits.
 * The mirror is a public host the owner put in scope on 2026-11-05; the item still passes the safety,
 * male-only scope and takedown gates, and the identity engine merges it with the creator it belongs to.
 * @returns {object|null} the feed row, or null when the service has no mirror or the handle is taken down
 */
function registerPaidMirror(service, handle) {
  const segment = MIRROR_SERVICES[service];
  if (!segment) return null;
  const h = String(handle || '').toLowerCase();
  if (!h) return null;
  const target = `${segment}/${h}`;
  if (takedowns.checkHandle(h, 'coomer')) return null;
  const existing = repo.feeds.find('coomer', 'user', target);
  if (existing) return existing;
  const cfg = settingsStore.get();
  if (repo.feeds.countEnabled() >= cfg.maxFeeds) return null;
  const r = repo.feeds.upsert({
    platform: 'coomer', kind: 'user', target, label: `${h} (${segment} on Coomer)`,
    creatorId: null, trusted: 0, origin: 'paid-mirror', intervalMin: 240, runNow: true,
  });
  return r.feed || null;
}

module.exports = { paidPageUrl, registerPaidPage, registerPaidMirror, MIRROR_SERVICES };
