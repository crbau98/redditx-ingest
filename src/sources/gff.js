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
 * Discovery (engine/discovery.js `gffDiscovery`) reads JustTheGays' open lists (latest, trending,
 * popular, most viewed, top rated) and registers their performers as feeds; the gayforfans.com
 * /performer directory (75 pages) is walked only when those lists find nobody new.
 */
const cheerio = require('cheerio');
const http = require('./http').forPlatform('gff', 900);
const { clip, toIso, isChallengeText } = require('./util');
const { robotsAllows } = require('./web');
const settingsStore = require('../settings');
const scrapfly = require('../lib/scrapfly');
const oxylabs = require('../lib/oxylabs');
const { checkHtmlOptOut } = require('../lib/takedowns');
const { cleanDisplayName } = require('../lib/links');

const PAGE_VIDEOS = 14;   // video pages read per run (each is one full page fetch)
const FIRST_VIDEOS = 50;
const PROBE_VIDEOS = 2;   // a lookup probe asks "does this performer page exist?" — read only two
const SEEN_KEEP = 400;    // remembered video slugs in the feed cursor

// The two directories that share the gff.network infrastructure: GayForFans (gayforfans.com) and
// JustTheGays (justthegays.tv). Both serve performer pages, both have a /search?q= endpoint.
const SITES = [
  { host: 'justthegays.tv', label: 'JustTheGays' },
  { host: 'gayforfans.com', label: 'GayForFans' },
];
// justthegays.tv answers 403 to the identified PRISM user agent and serves the same public HTML
// to a normal browser. gayforfans.com can still answer with a real bot check; that path stays a challenge.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
/**
 * The identity PRISM uses for these two sites: the page request AND the robots.txt request carry the same user agent,
 * so the robots we obey is the robots served to the identity we actually use. Setting gffBrowserAgent off = PRISM's own agent.
 */
function identity() {
  let on = true;
  try { on = settingsStore.get().gffBrowserAgent !== false; } catch { on = true; }
  return { userAgent: on ? BROWSER_UA : null };
}
const pageHeaders = () => { const { userAgent } = identity(); return { accept: 'text/html', ...(userAgent ? { 'user-agent': userAgent } : {}) }; };
/** JustTheGays list pages that answer with plain HTML (the a-z, all-time and search pages bot-check). */
const JTG_LISTS = ['/p7103/latest', '/p6914/top-performers/trending', '/p7138/popular', '/p7113/most-viewed', '/p6976/top-rated'];
/** Performer-page URL for a slug on either directory. */
const performerUrl = (host, slug) => `https://${host}/performer/${slug}`;

/**
 * The link text of a performer card is "#34 Alejandro Pino (hotalex6)" or "Alejandro Pino (hotalex6)".
 * Strip the rank and the stage handle, and keep the display name.
 */
function performerNameFrom(text) {
  return cleanDisplayName(text) || String(text || "").replace(/^#\d+\s*/, "").trim();
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

/**
 * A performer page that answered with a bot check or a refusal, read through the Scrapfly tier instead - only when the tier is
 * on (scrapflyUnlocker) and this feed belongs to an allowlisted creator. Returns the page, {optedOut}, or null (not used, or it
 * failed for a reason the caller should treat as the challenge). The cost goes into the run notes; opt-outs still win.
 */
async function unlockPerformer(url, feed, notes) {
  let cfg = {};
  try { cfg = settingsStore.get(); } catch { cfg = {}; }
  if (cfg.scrapflyUnlocker !== 'fallback' || !scrapfly.configured() || !scrapfly.allowedFor(feed)) return null;
  try {
    const r = await scrapfly.read(url, {
      allowed: true,
      host: new URL(url).hostname.toLowerCase(),
      parse: (html) => {
        const opt = checkHtmlOptOut(String(html), {}, 200);
        if (opt && opt.optedOut) return { optedOut: true, reason: opt.reason, videos: [] };
        return performerPage(String(html));
      },
      count: (pg) => (pg.optedOut ? 0 : pg.videos.length),
    });
    if (r.value && r.value.optedOut) {
      notes.push(`Skipped page (${r.value.reason || 'opted out'})`);
      return { optedOut: true };
    }
    notes.push(`Scrapfly Unblocker read the performer page (${r.cost} credits)`);
    return r.value;
  } catch (e) {
    // Our own limits (not allowed, caps, account) leave the challenge path as it was; a real failure is noted and does the same.
    if (e.escalationRefused || (e.cost && !e.skip)) notes.push(`Scrapfly Unblocker: ${e.message}${e.cost ? ` (${e.cost} credits spent)` : ''}`);
    else if (!e.skip && !e.budget && !e.ours) notes.push(`Scrapfly Unblocker: ${e.message}`);
    return null;
  }
}

/**
 * A page that answered with a bot check or a refusal, read through the Oxylabs Web API instead (lib/oxylabs.js: takedown and
 * private-host gate, daily cap, key never logged). The caller has already checked robots.txt, as for a direct read. Returns the
 * HTML, or null when the tier is not configured, out of budget, or failed (noted); the caller then treats it as the refusal.
 */
async function oxylabsHtml(url, notes) {
  if (!oxylabs.configured()) return null;
  try {
    const r = await oxylabs.scrape(url);
    if (r.blocked) { notes.push(`Oxylabs: ${new URL(url).pathname} came back as a bot check too`); return null; }
    return r.html;
  } catch (e) {
    if (!e.skip) notes.push(`Oxylabs: ${e.message}`);
    return null;
  }
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
/** Every performer the video's JSON-LD names ("actor": [{name}, {name}]), in order. */
function actorNames(vo) {
  const a = vo && vo.actor;
  return (Array.isArray(a) ? a : a ? [a] : []).map((x) => (x && x.name ? String(x.name).trim() : '')).filter(Boolean);
}

function actorName(vo) {
  const a = vo && vo.actor;
  const first = Array.isArray(a) ? a[0] : a;
  return (first && first.name) ? String(first.name).trim() : null;
}

/** A performer name, or null when it is empty or only the site's own name ("GayForFans", "JustTheGays.com | Just The Gays"). */
function realName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const rest = n.replace(/gay\s*for\s*fans|just\s*the\s*gays/gi, '').replace(/\.(com|tv)\b/gi, '').replace(/[\s|·:\-–—]+/g, '');
  return rest ? n : null;
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
  // JustTheGays performer pages carry their newest videos as JSON-LD VideoObjects with the stream URL,
  // so those need no video-page request (individual video pages are the ones that answer 403 most).
  const embedded = new Map();
  $('script[type="application/ld+json"]').each((_, el) => {
    let j;
    try { j = JSON.parse($(el).text()); } catch { return; }
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 6) return;
      if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
      if (node['@type'] === 'VideoObject' && node.contentUrl) {
        const m = String(node.url || node['@id'] || '').match(/\/video\/([a-z0-9-]{6,})/i);
        if (m && !embedded.has(m[1])) embedded.set(m[1], node);
        return;
      }
      Object.values(node).forEach((v) => walk(v, depth + 1));
    };
    walk(j, 0);
  });
  return { name, avatar, banner, videos, embedded };
}

module.exports = {
  _identity: identity,
  _unlockPerformer: unlockPerformer,
  _pageHeaders: pageHeaders,
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
          maxBytes: 2_000_000, retries: 0, timeout, headers: pageHeaders(),
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
   * Performers from JustTheGays' public lists (latest, trending, popular, most viewed, top rated).
   * This is where the newest 2026 performers show up — the mirror stopped indexing them. Only the
   * lists JustTheGays serves as plain HTML are read; gayforfans.com bot-checks this server.
   * @returns {Promise<Array<{url: string, name: string, slug: string, host: string}>>}
   */
  async trendingPerformers({ limit = 24, timeout = 12000 } = {}) {
    const out = [];
    const seen = new Set();
    for (const site of SITES.filter((x) => x.host === 'justthegays.tv')) {
      for (const path of JTG_LISTS) {
        if (out.length >= limit) break;
        let html;
        try {
          html = await http.text(`https://${site.host}${path}`, { maxBytes: 2_000_000, retries: 0, timeout, headers: pageHeaders() });
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
    if (!(await robotsAllows(feed.target, identity()))) return { items: [], notes: ['robots.txt disallows this page'], via: 'gff' };

    const original = this.parse(feed.target);
    let target = feed.target;
    const read = async (url) => {
      if (!(await robotsAllows(url, identity()))) return null;
      try {
        const html = await http.text(url, { maxBytes: 3_000_000, retries: 1, headers: pageHeaders() });
        if (isChallengeText(html)) throw challengeError();
        return performerPage(String(html));
      } catch (e) {
        if (isBlockedStatus(e.status) || isChallengeText(e.body)) {
          const unlocked = await unlockPerformer(url, feed, notes);
          if (unlocked) return unlocked.optedOut ? null : unlocked;
          // The site refuses this server: read the public page through Oxylabs instead of parking the platform.
          const html = await oxylabsHtml(url, notes);
          if (html) {
            const opt = checkHtmlOptOut(html, {}, 200);
            if (opt && opt.optedOut) { notes.push(`Skipped page (${opt.reason || 'opted out'})`); return null; }
            notes.push('read the performer page through Oxylabs (the site refused this server)');
            return performerPage(html);
          }
          throw challengeError();
        }
        if (e.status === 404) return null;
        throw e;
      }
    };
    // Resolve a gayforfans performer on the sister directory. The two sites slug the same man
    // differently ("adam-gray-so_much_adam-e5021" vs "adam-gray-somuchadam-43"), so trying the same
    // slug usually 404s: try it first (exact, cheap) and then the site's own search by name.
    const alternateFor = async () => {
      if (!original) return null;
      const same = performerUrl('justthegays.tv', original.label);
      let candidate = sisterTried ? null : await read(same).catch(() => null);
      if (candidate && candidate.videos.length) return { page: candidate, url: same };
      const query = String(feed.label || '').trim()
        || original.label.replace(/-[a-z0-9]{4,6}$/i, '').replace(/_/g, ' ').trim();
      if (!query) return null;
      let matches = [];
      try { matches = await this.searchPerformers(query, { limit: 8 }); } catch { matches = []; }
      const best = matches.find((m) => m.host === 'justthegays.tv' && m.score >= 0.5);
      if (!best) return null;
      candidate = await read(best.url).catch(() => null);
      return candidate && candidate.videos.length ? { page: candidate, url: best.url } : null;
    };

    let page;
    let resolvedTarget;
    let sisterTried = false;
    let triedAlternate = false;
    if (original && /gayforfans\.com\/performer\//i.test(target)) {
      // JustTheGays serves the same performer as plain HTML; gayforfans.com bot-checks this server.
      // Try the sister page under the same slug first and move the feed there when it has videos.
      const sister = performerUrl('justthegays.tv', original.label);
      sisterTried = true;
      const first = await read(sister).catch(() => null);
      if (first && first.videos.length) { page = first; resolvedTarget = sister; }
    }
    if (page) {
      // read from JustTheGays above
    } else if (original && /gayforfans\.com\/performer\//i.test(target)) {
      try {
        page = await read(target);
      } catch (e) {
        // A challenge on the primary host must not end the run while the sister directory works.
        // The feed keeps its gayforfans target on purpose: a bot check is usually temporary, so the
        // next run tries the primary again (and falls back again if it is still closed), while the
        // library keeps filling from the sister directory in the meantime.
        if (!(e.challenged || isBlockedStatus(e.status))) throw e;
        triedAlternate = true;
        const alt = await alternateFor();
        if (!alt) throw e;
        page = alt.page;
        notes.push('gayforfans is bot-checking; read the same performer on JustTheGays this run');
      }
      if (!triedAlternate && (!page || !page.videos.length)) {
        triedAlternate = true;
        const alt = await alternateFor();
        if (alt) { page = alt.page; resolvedTarget = alt.url; }
      }
    } else {
      page = await read(target);
    }
    if (!page) return { items: [], notes: ['performer page unavailable'], via: 'gff' };
    const seen = new Set((ctx.cursor && ctx.cursor.seen) || []);
    const asked = Number(ctx.limit) || 0;
    const cap = ctx.probe ? Math.min(PROBE_VIDEOS, asked || PROBE_VIDEOS) : (!seen.size ? FIRST_VIDEOS : PAGE_VIDEOS);
    const fresh = page.videos.filter((v) => !seen.has(v.slug)).slice(0, cap);
    if (!fresh.length && page.videos.length) notes.push('gayforfans: no new videos since the last run');

    let blocked = 0;
    for (const v of fresh) {
      if (ctx.aborted && ctx.aborted()) break;
      let vo = page.embedded && page.embedded.get(v.slug);
      if (!vo) {
        let vh;
        try {
          vh = await http.text(v.url, { maxBytes: 3_000_000, retries: 1, headers: pageHeaders() });
          if (isChallengeText(vh)) throw Object.assign(new Error('bot check'), { status: 403 });
        } catch (e) {
          const refused = isBlockedStatus(e.status) || isChallengeText(e.body);
          vh = refused && (await robotsAllows(v.url, identity())) ? await oxylabsHtml(v.url, notes) : null;
          if (!vh) {
            // Not marked seen: a failed or blocked page read is usually transient, so the next run tries it again.
            if (refused) blocked++;
            notes.push(`gayforfans: ${v.slug} — ${e.message}`);
            continue;
          }
          if (checkHtmlOptOut(String(vh), {}, 200)?.optedOut) { notes.push(`gayforfans: ${v.slug} — opted out, skipped`); seen.add(v.slug); continue; }
        }
        vo = videoObject(String(vh));
      }
      if (!vo || !vo.contentUrl) continue;
      // The video page names him; the performer page's <h1> can be the site's own name. With neither,
      // the slug would become a junk creator, so the video is skipped (and retried next run).
      const author = realName(actorName(vo)) || realName(page.name);
      // A scene with two performers names both in its own JSON-LD: the others are credited on the item (alt sources),
      // never as its creator and never through any picture or face matching.
      const credits = actorNames(vo).map(realName).filter((n) => n && n.toLowerCase() !== String(author || '').toLowerCase());
      if (!author) { notes.push(`gayforfans: ${v.slug} — no performer name on the page, skipped`); continue; }
      seen.add(v.slug);
      items.push({
        sourceId: `gff-${v.slug}`,
        position: 0,
        title: clip(vo.name || v.title || page.name || v.slug, 200),
        body: clip(vo.description || '', 2000),
        author,
        ...(credits && credits.length ? { credits: [...new Set(credits)] } : {}),
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

    // Every video page was blocked and nothing was read: the site is bot-checking, report it as such.
    if (blocked && !items.length) throw challengeError();
    const kept = [...seen].slice(-SEEN_KEEP);
    return {
      items,
      resolvedTarget,
      cursor: { seen: kept },
      profile: page.name ? { displayName: page.name, avatarUrl: page.avatar, bannerUrl: page.banner, bio: null, links: [{ platform: 'external', service: 'GayForFans', label: `GayForFans · ${page.name}`, url: target, handle: page.name }] } : null,
      notes,
      via: 'gff-html',
    };
  },
};
