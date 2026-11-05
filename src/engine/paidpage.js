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

module.exports = { paidPageUrl, registerPaidPage };
