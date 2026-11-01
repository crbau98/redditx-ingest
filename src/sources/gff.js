'use strict';
/**
 * GayForFans adapter (gayforfans.com — the ranked directory of gay male OnlyFans performers).
 *
 *   user  target "https://gayforfans.com/performer/<slug>"   one performer's page: every video he
 *         has on the site is fetched through its own page and ingested as HLS (the site serves
 *         /play/<id>/manifest, which its robots.txt explicitly allows for that pattern).
 *
 * Items are creator-owned (the page *is* his), so they carry `trusted: true`; the engine's safety,
 * takedown, male-scope and picture gates still run on every one of them.
 *
 * Discovery (engine/discovery.js `gffDiscovery`) walks the public /performer directory — ranked by
 * popularity, 75 pages — and registers the top performers as feeds.
 */
const cheerio = require('cheerio');
const http = require('./http').forPlatform('gff', 900);
const { clip, toIso, isChallengeText } = require('./util');
const { robotsAllows } = require('./web');

const PAGE_VIDEOS = 14;   // video pages read per run (each is one full page fetch)
const PROBE_VIDEOS = 2;   // a lookup probe asks "does this performer page exist?" — read only two
const SEEN_KEEP = 400;    // remembered video slugs in the feed cursor
// When the site puts up a bot check, one long cool-down beats the breaker's 1-hour cap: the whole
// platform is closed for this long before the next single probe.
const CHALLENGE_COOLDOWN_MS = 6 * 3600_000;

/** The site is actively blocking this server. Thrown (not swallowed into notes) so the circuit
 *  breaker sees it and pauses every gff feed; existing items stay in the library as link-outs. */
function challengeError() {
  const e = new Error('gayforfans is showing a bot check — the site blocks this server; videos remain link-outs');
  e.status = 503;
  e.retryAfter = CHALLENGE_COOLDOWN_MS;
  e.challenged = true;
  return e;
}

function isBlockedStatus(status) {
  return status === 403 || status === 503 || status === 520 || status === 524;
}

function durationOf(iso) {
  const m = String(iso || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

/** The VideoObject block of a video page: {name, contentUrl (HLS manifest), thumbnailUrl, uploadDate, duration}. */
function videoObject(html) {
  const $ = cheerio.load(html);
  let out = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (out) return;
    let j;
    try { j = JSON.parse($(el).text()); } catch { return; }
    const list = Array.isArray(j) ? j : [j, ...(j && j['@graph'] ? j['@graph'] : [])];
    for (const node of list) if (node && node['@type'] === 'VideoObject' && node.contentUrl) out = node;
  });
  return out;
}

/** The performer page: display name, avatar, and the video page links (newest first as listed). */
function performerPage(html) {
  const $ = cheerio.load(html);
  const name = ($('h1').first().text() || '').trim() || null;
const avatar = $('img[alt]').filter((i, el) => !/GayForFans|placeholder|logo/i.test(($(el).attr('alt') || '') + ' ' + ($(el).attr('src') || ''))).first().attr('src')
    || $('meta[property="og:image"]').filter((i, el) => !/logo/i.test($(el).attr('content') || '')).attr('content')
    || null;
  const videos = [];
  const seen = new Set();
  $('a[href*="/video/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/video\/([a-z0-9-]{6,})/i);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    videos.push({ slug: m[1], url: /^https?:/i.test(href) ? href : `https://gayforfans.com${href}`, title: ($(el).text() || '').replace(/\s+/g, ' ').trim() });
  });
  return { name, avatar, videos };
}

module.exports = {
  platform: 'gff',
  label: 'GayForFans',
  color: '#38bdf8',
  kinds: ['user'],
  intervalMin: { user: 360 },
  isConfigured: () => ({ ok: true }),

  /** Parse a gayforfans performer URL into a feed spec. */
  parse(input) {
    const m = String(input || '').match(/gayforfans\.com\/performer\/([a-z0-9-]{3,})/i);
    if (!m) return null;
    return { platform: 'gff', kind: 'user', target: `https://gayforfans.com/performer/${m[1]}`, ingestable: true, label: m[1], url: `https://gayforfans.com/performer/${m[1]}` };
  },

  async fetch(feed, ctx = {}) {
    const notes = [];
    const items = [];
    if (!(await robotsAllows(feed.target))) return { items: [], notes: ['robots.txt disallows this page'], via: 'gff' };

    let html;
    try {
      html = await http.text(feed.target, { maxBytes: 3_000_000, retries: 1, headers: { accept: 'text/html' } });
    } catch (e) {
      // A site-wide block or a systemic failure must reach the circuit breaker, not hide in notes:
      // before, every gff run "finished empty" while the site was 403ing us, so nothing ever backed off.
      if (isBlockedStatus(e.status) || isChallengeText(e.body)) throw challengeError();
      throw e;
    }
    if (isChallengeText(html)) throw challengeError();
    const page = performerPage(String(html));
    const seen = new Set((ctx.cursor && ctx.cursor.seen) || []);
    // A small explicit limit is the lookup probe ("does this performer exist?"): two video pages
    // answer it, where reading fourteen cost ~8 s of the 18 s probe budget.
    const asked = Number(ctx.limit) || 0;
    const cap = asked > 0 && asked < 50 ? Math.min(PROBE_VIDEOS, asked) : PAGE_VIDEOS;
    const fresh = page.videos.filter((v) => !seen.has(v.slug)).slice(0, cap);
    if (!fresh.length && page.videos.length) notes.push('gayforfans: no new videos since the last run');

    for (const v of fresh) {
      if (ctx.aborted && ctx.aborted()) break;
      let vh;
      try {
        vh = await http.text(v.url, { maxBytes: 3_000_000, retries: 1, headers: { accept: 'text/html' } });
      } catch (e) {
        if (isBlockedStatus(e.status) || isChallengeText(e.body)) throw challengeError();
        notes.push(`gayforfans: ${v.slug} — ${e.message}`);
        seen.add(v.slug);
        continue;
      }
      if (isChallengeText(vh)) throw challengeError();
      seen.add(v.slug);
      const vo = videoObject(String(vh));
      if (!vo || !vo.contentUrl) continue;
      items.push({
        sourceId: `gff-${v.slug}`,
        position: 0,
        title: clip(vo.name || v.title || page.name || v.slug, 200),
        body: clip(vo.description || '', 2000),
        author: page.name || v.slug,
        score: 0,
        postedAt: toIso(vo.uploadDate),
        permalink: v.url,
        mediaType: 'video',
        mediaUrl: vo.contentUrl,
        hlsUrl: vo.contentUrl,
        previewUrl: vo.thumbnailUrl || null,
        thumbnailUrl: vo.thumbnailUrl || null,
        duration: durationOf(vo.duration),
        tags: [],
        nsfw: 'explicit',
        trusted: true,
      });
      if (ctx.limit && items.length >= ctx.limit) break;
    }

    const kept = [...seen].slice(-SEEN_KEEP);
    return {
      items,
      cursor: { seen: kept },
      profile: page.name ? { displayName: page.name, avatarUrl: page.avatar, bio: null, links: [] } : null,
      notes,
      via: 'gff-html',
    };
  },
};
