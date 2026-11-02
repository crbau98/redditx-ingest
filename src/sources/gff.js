'use strict';
/**
 * GayForFans adapter (gayforfans.com — the ranked directory of gay male OnlyFans performers).
 *
 *   user  target "https://gayforfans.com/performer/<slug>"   one performer's page: every video he
 *         has on the site is fetched through its own page and ingested as HLS (the site serves
 *         /play/<id>/manifest, which its robots.txt explicitly allows for that pattern).
 *
 * JustTheGays (justthegays.tv) is the site's 2026-era sister directory on the same infrastructure:
 *   - its robots.txt allows / (only /login, /register, /my/* and *.json are off limits),
 *   - its performer pages carry the same VideoObject JSON-LD, but with the HLS playlist pointing
 *     straight at cdn.gff.network (no /play/<id>/manifest interstitial), so it plays even when
 *     gayforfans.com itself is answering with a bot check,
 *   - it publishes material from 2026 that the mirror (coomer.st) stopped indexing in late 2025,
 *   - and it has a live performer search (https://justthegays.tv/search?q=<name>) that answers with
 *     the exact performer pages, so a creator can be found by name without spending search quota.
 * The same /search?q= endpoint exists on gayforfans.com.
 *
 * Items are creator-owned (the page *is* his), so they carry `trusted: true`; the engine's safety,
 * takedown, male-scope and picture gates still run on every one of them.
 *
 * Discovery (engine/discovery.js `gffDiscovery`) walks the public /performer directory — ranked by
 * popularity, 75 pages — and registers the top performers as feeds; it also walks JustTheGays'
 * trending top-performers list, which is where the new 2026 performers appear first.
 */
const cheerio = require('cheerio');
const http = require('./http').forPlatform('gff', 900);
const { clip, toIso, isChallengeText } = require('./util');
const { robotsAllows } = require('./web');

const PAGE_VIDEOS = 14;   // video pages read per run (each is one full page fetch)
const PROBE_VIDEOS = 2;   // a lookup probe asks "does this performer page exist?" — read only two
const SEEN_KEEP = 400;    // remembered video slugs in the feed cursor

// The two directories that share the gff.network infrastructure: GayForFans (gayforfans.com) and
// JustTheGays (justthegays.tv). Both serve performer pages, both have a /search?q= endpoint.
const SITES = [
  { host: 'gayforfans.com', label: 'GayForFans' },
  { host: 'justthegays.tv', label: 'JustTheGays' },
];
/** Performer-page URL for a slug on either directory. */
const performerUrl = (host, slug) => `https://${host}/performer/${slug}`;

/**
 * The link text of a performer card is "#34 Alejandro Pino (hotalex6)" or "Alejandro Pino (hotalex6)".
 * Strip the rank and the stage handle, and keep the display name.
 */
function performerNameFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.replace(/^#\d+\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim() || t.replace(/^#\d+\s*/, '').trim();
}

/**
 * How well a performer name matches what was searched for (0..1). An exact match (ignoring case,
 * spaces and punctuation) scores 1, a name that contains the query scores high, a name that merely
 * shares a first name scores low. Used to put the man the user asked for first.
 */
function performerScore(query, name, slug) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
  const q = norm(query);
  const n = norm(name);
  const sl = norm(slug);
  if (!q || !n) return 0;
  // The slug is the performer's own page name ("alejandro-pino-hotalex6-x9b1v"): when the query is
  // IN the slug, this page really is his page. A page that merely names him in its title (a video
  // page of a pair, say) has an unrelated slug, so it never scores as an exact match.
  if (sl === q || sl.startsWith(q) || sl.includes(`-${q}`)) return 1;
  if (n === q) return 0.95;
  const words = String(name || '').toLowerCase().split(/\s+/).filter(Boolean);
  const qw = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (qw.length > 1 && qw.every((w) => words.includes(w))) return 0.9;
  if (n.startsWith(q) || q.startsWith(n)) return 0.8;
  if (words.includes(qw[0]) && qw[0].length >= 4) return 0.6;
  if (n.includes(q)) return 0.5;
  return 0.1;
}
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

/** The VideoObject block of a video page: {name, contentUrl (HLS manifest), thumbnailUrl, uploadDate, duration, actor}. */
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

/** The performer's own name from a video page's JSON-LD ("actor": [{name}]}), when the page says so. */
function actorName(vo) {
  const a = vo && vo.actor;
  const first = Array.isArray(a) ? a[0] : a;
  return (first && first.name) ? String(first.name).trim() : null;
}

/** How many people watched a video (the JSON-LD watch counter), used as the item's score. */
function watchCount(vo) {
  const stats = vo && vo.interactionStatistic;
  const list = Array.isArray(stats) ? stats : [];
  for (const s of list) {
    if (s && s.interactionType && /WatchAction/i.test(s.interactionType)) {
      const n = Number(s.userInteractionCount);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

/** The performer page: display name, avatar, banner, and the video page links (newest first as listed). */
function performerPage(html) {
  const $ = cheerio.load(html);
  // The <h1> is often "Christian Hogue - porn, OnlyFans & nude videos on JustTheGays": keep the name only.
  const rawName = ($('h1').first().text() || '').trim();
  const name = (rawName ? rawName.replace(/\s+-\s+porn.*$/i, '').replace(/\s+-\s+OnlyFans.*$/i, '').trim() : '') || null;
  const banner = $('meta[property="og:image"]').attr('content') || null;
  const avatar = $('img[alt]').filter((i, el) => !/GayForFans|placeholder|logo/i.test(($(el).attr('alt') || '') + ' ' + ($(el).attr('src') || ''))).first().attr('src')
    || $('meta[property="og:image"]').filter((i, el) => !/logo/i.test($(el).attr('content') || '')).attr('content')
    || null;
  // Relative video links belong to the page's own host: a JustTheGays performer page must not send
  // its videos to gayforfans.com (different performer pages live there).
  const origin = ($('link[rel="canonical"]').attr('href') || '').match(/^https?:\/\/[^/]+/i);
  const base = origin ? origin[0] : 'https://gayforfans.com';
  const videos = [];
  const seen = new Set();
  $('a[href*="/video/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/video\/([a-z0-9-]{6,})/i);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    videos.push({ slug: m[1], url: /^https?:/i.test(href) ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`, title: ($(el).text() || '').replace(/\s+/g, ' ').trim() });
  });
  return { name, avatar, banner, videos };
}

module.exports = {
  platform: 'gff',
  label: 'GayForFans',
  color: '#38bdf8',
  kinds: ['user'],
  intervalMin: { user: 360 },
  isConfigured: () => ({ ok: true }),

  /** Parse a gayforfans / justthegays performer URL into a feed spec. */
  parse(input) {
    const m = String(input || '').match(/(gayforfans\.com|justthegays\.tv)\/performer\/([a-z0-9-]{3,})/i);
    if (!m) return null;
    const host = m[1].toLowerCase() === 'justthegays.tv' ? 'justthegays.tv' : 'gayforfans.com';
    const url = performerUrl(host, m[2]);
    return { platform: 'gff', kind: 'user', target: url, ingestable: true, label: m[2], url };
  },

  /**
   * Find a performer by name across both directories.
   *
   * Both sites answer https://<host>/search?q=<name> with their own performer links, so a name is
   * enough — no web-search quota, no guessing of handles. Used by creator lookup so that typing
   * "Christian Hogue" finds his pages (and through them his mirrored OnlyFans page) immediately.
   *
   * @param {string} query a performer name
   * @returns {Promise<Array<{url: string, name: string, slug: string, host: string}>>}
   */
  async searchPerformers(query, { limit = 8, timeout = 9000 } = {}) {
    const q = String(query || '').trim().slice(0, 120);
    if (!q) return [];
    const out = [];
    const seen = new Set();
    for (const site of SITES) {
      let html;
      try {
        html = await http.text(`https://${site.host}/search?q=${encodeURIComponent(q)}`, {
          maxBytes: 2_000_000, retries: 0, timeout, headers: { accept: 'text/html' },
        });
      } catch {
        // One directory being unreachable must not hide the other one's answers.
        continue;
      }
      if (isChallengeText(String(html))) continue;
      const $ = cheerio.load(String(html));
      $('a[href*="/performer/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const m = href.match(/\/performer\/([a-z0-9-]{3,})/i);
        if (!m) return;
        const url = /^https?:/i.test(href) ? href : `https://${site.host}${href.startsWith('/') ? '' : '/'}${href}`;
        // The same performer appears under several slugs on one site ("reno-gold-66",
        // "reno-gold-71"): the slug stem (name + paid handle, without the trailing id) identifies him.
        const stem = m[1].toLowerCase().replace(/-[a-z0-9]{4,6}$/, '');
        const key = `${site.host}:${stem}`;
        if (seen.has(key)) return;
        seen.add(key);
        // The link text is "First Last (paidhandle)" or "#12 First Last (paidhandle)".
        const name = performerNameFrom($(el).text());
        out.push({ url, name, slug: m[1], host: site.host, score: performerScore(q, name, m[1]) });
      });
    }
    // The man the user named comes first; the two directories' pages for him sit next to each other.
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  },

  /**
   * The trending top-performer list of a directory (JustTheGays: /p6914/top-performers/trending).
   * This is where the newest 2026 performers show up — the mirror stopped indexing them.
   * @returns {Promise<Array<{url: string, name: string, slug: string, host: string}>>}
   */
  async trendingPerformers({ limit = 24, timeout = 12000 } = {}) {
    const out = [];
    const seen = new Set();
    for (const site of SITES) {
      for (const path of ['/p6914/top-performers/trending', '/p6913/top-performers/a-z']) {
        if (out.length >= limit) break;
        let html;
        try {
          html = await http.text(`https://${site.host}${path}`, { maxBytes: 2_000_000, retries: 0, timeout, headers: { accept: 'text/html' } });
        } catch { continue; }
        if (isChallengeText(String(html))) continue;
        const $ = cheerio.load(String(html));
        $('a[href*="/performer/"]').each((_, el) => {
          if (out.length >= limit) return;
          const href = $(el).attr('href') || '';
          const m = href.match(/\/performer\/([a-z0-9-]{3,})/i);
          if (!m) return;
          const key = `${site.host}:${m[1].toLowerCase()}`;
          if (seen.has(key)) return;
          seen.add(key);
          const url = /^https?:/i.test(href) ? href : `https://${site.host}${href.startsWith('/') ? '' : '/'}${href}`;
          const name = performerNameFrom($(el).text());
          out.push({ url, name, slug: m[1], host: site.host });
        });
      }
    }
    return out.slice(0, limit);
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
        // The video page names him; the performer page's <h1> can be generic ("GayForFans").
        author: actorName(vo) || (page.name && !/^gayforfans$/i.test(page.name) ? page.name : v.slug),
        score: watchCount(vo),
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
      profile: page.name ? { displayName: page.name, avatarUrl: page.avatar, bannerUrl: page.banner, bio: null, links: [{ platform: 'external', service: 'GayForFans', label: `GayForFans · ${page.name}`, url: feed.target, handle: page.name }] } : null,
      notes,
      via: 'gff-html',
    };
  },
};
