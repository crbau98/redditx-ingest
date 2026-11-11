'use strict';
/**
 * Reddit adapter.
 *
 * Reddit is the richest source but also the one that most often blocks
 * unauthenticated server traffic (403/429 from datacenter IPs). To keep
 * ingestion working without babysitting, every request walks a transport
 * ladder and uses the first one that answers:
 *
 *   1. OAuth app-only token (REDDIT_CLIENT_ID/SECRET)   - the supported way
 *   2. www  /<path>.json                                 - public JSON
 *   3. old  /<path>.json                                 - different edge
 *   4. /<path>.rss                                       - Atom, rarely blocked
 *   5. Arctic Shift archive                              - works when Reddit is down
 *
 * Public mode (no credentials) reads the archive first and keeps only RSS behind it: the www and old JSON legs are
 * guaranteed 403 from a datacenter host, so they are not asked at all. With credentials, OAuth stays first and the
 * archive is the last fallback.
 *
 * The archive (Arctic Shift /api/posts/search, verified 2026-11-10) returns newest first by default, takes `before` /
 * `after` as created_utc seconds (`after` is exclusive) and `sort=asc`, limit 1-100, no time window. A first run pages
 * back with `before`; an incremental run asks `after` the cursor's second with `sort=asc` and pages forward, so nothing
 * between runs is skipped. Its scores lag about 36 h; the hot-score recomputation already ages them. Under load it answers
 * 200 with an `error` field and no rows; that is treated as a 429 (same penalty as Reddit's own), never as "empty".
 */
const config = require('../config');
// Reddit answers an anonymous reader at about one request a minute (x-ratelimit-remaining: 0,
// x-ratelimit-reset ~60). A 429 is a wait, not a failure, so hold the call for the whole
// Retry-After window instead of giving up at the shared 30 s ceiling.
const REDDIT_WAIT = { maxCooldownWaitMs: 70_000 };
const http = require('./http').forPlatform('reddit', 1100, { penalty: { ms: 60_000 } });
const net = require('../lib/net');
const rss = require('./rss');
const events = require('../engine/events');
const { toIso, decodeHtml, pickWidth, clip, repostsOn } = require('./util');
const { hostOf, hostBlocked, hostMatches, normalizeMediaUrl, looksLikeDirectMedia } = require('../lib/mediaurl');
const aiguard = require('../lib/aiguard');

const base = config.baseUrls.reddit;
const oldBase = base.includes('www.reddit.com') ? base.replace('www.reddit.com', 'old.reddit.com') : base;
// watch / ifr / embed / legacy gifs/detail pages on www., v3. or bare redgifs.com.
const REDGIFS_LINK = /redgifs\.com\/(?:watch|ifr|embed|gifs\/detail)\/[a-z0-9]+/i;
const VREDDIT = /^https?:\/\/v\.redd\.it\/([a-z0-9]+)\/?$/i;
// A link post to one X post: the pipeline reads its media keylessly (see pipeline.js step 1).
const X_STATUS = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/i;

/* ----------------------------------------------------------------- OAuth */
// Reddit reads are on unless an admin sets redditEnabled off. The switch is checked INSIDE this module, at every function that
// can reach the network (the engine's feed runs, the discovery searches, profile reads, every transport): "off" means zero
// requests, and nothing already stored is deleted. Text read while it is on is registered with lib/aiguard and never sent to a hosted model.
const OFF_NOTE = 'Reddit is switched off (setting redditEnabled): feeds wait, nothing is deleted';
const enabled = () => !!require('../settings').get().redditEnabled;
function assertOn() { if (!enabled()) throw Object.assign(new Error(OFF_NOTE), { skip: true }); }

let token = null;
let tokenFailUntil = 0; // bad credentials must not turn into a token request per page
async function oauthToken() {
  assertOn();
  const { redditClientId: id, redditClientSecret: secret } = config.creds;
  if (!id || !secret) return null;
  if (token && Date.now() < token.expires - 60000) return token.value;
  if (Date.now() < tokenFailUntil) return null;
  try {
    const res = await http.json(`${base}/api/v1/access_token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': config.redditUserAgent,
      },
      body: 'grant_type=client_credentials',
      retries: 1,
    });
    if (!res.access_token) throw new Error('Reddit OAuth returned no token');
    token = { value: res.access_token, expires: Date.now() + (res.expires_in || 3600) * 1000 };
    return token.value;
  } catch (e) {
    tokenFailUntil = Date.now() + 10 * 60000;
    events.log('WARN', `Reddit OAuth token request failed (${e.status || e.message}) — check REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET (an app of type "script" or "web app"); using public JSON/RSS/archive for the next 10 minutes`);
    throw e;
  }
}

/* --------------------------------------------------------------- parsing */
function previewOf(d) {
  const img = d.preview && d.preview.images && d.preview.images[0];
  if (!img || !img.source) return {};
  const cands = [{ url: decodeHtml(img.source.url), width: img.source.width }]
    .concat((img.resolutions || []).map((r) => ({ url: decodeHtml(r.url), width: r.width })));
  return {
    previewUrl: pickWidth(cands, 640),
    width: img.source.width || null,
    height: img.source.height || null,
    mp4: img.variants && img.variants.mp4 && img.variants.mp4.source && decodeHtml(img.variants.mp4.source.url),
  };
}

/**
 * preview.redd.it/<file> is a resized, signed rendition; i.redd.it/<file> is the unsigned original.
 * Deriving it avoids signature-bearing URLs (which Reddit can rotate or refuse when hotlinked).
 * external-preview.redd.it has no i.redd.it twin and is left alone.
 */
function toOriginal(url) {
  try {
    const u = new URL(url);
    if (u.hostname.toLowerCase() === 'preview.redd.it' && /\.(jpe?g|png|gif|webp)$/i.test(u.pathname)) return `https://i.redd.it${u.pathname}`;
  } catch { /* keep as is */ }
  return url;
}
const MIME_EXT = { 'image/jpg': 'jpg', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

/** One Reddit submission -> 0..n ingest items (galleries yield several). */
/**
 * A Reddit post -> media items. `drops` (optional) counts posts that had media-like content but were dropped, by reason,
 * so the run report shows them; ordinary text posts are not counted (a text-heavy community must not look broken).
 */
function parsePost(post, drops) {
  const drop = (reason) => { if (drops && typeof drops === 'object') drops[reason] = (drops[reason] || 0) + 1; return []; };
  const d = (post && post.data) || post;
  if (!d || !d.id) return [];
  if (d.removed_by_category || d.author === '[deleted]') return drop('removed or deleted');
  const cp = d.crosspost_parent_list && d.crosspost_parent_list[0];
  const ownMedia = d.is_gallery || d.is_video || (d.media && d.media.reddit_video);
  const src = cp && !ownMedia ? cp : d; // crossposts carry their media on the parent
  const url = decodeHtml(src.url_overridden_by_dest || src.url || '');
  const host = hostOf(url);

  // A crosspost of somebody else's post is credited to the original poster; his own crossposts stay his.
  // (Setting "reposts" off: crossposts stay credited to the crossposter, as before.)
  const original = cp && repostsOn() && cp.author && cp.author !== '[deleted]' && String(cp.author).toLowerCase() !== String(d.author || '').toLowerCase() ? cp.author : null;
  const base = {
    sourceId: d.id,
    title: clip(d.title || '', 300),
    text: clip(d.selftext || '', 400),
    author: original || d.author,
    ...(original ? { repostOf: { platform: 'reddit', handle: original, via: d.author } } : {}),
    ...(cp && cp.subreddit && String(cp.subreddit).toLowerCase() !== String(d.subreddit || '').toLowerCase() ? { crosspostFrom: cp.subreddit } : {}),
    community: d.subreddit,
    score: d.score || 0,
    postedAt: toIso(d.created_utc),
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
    nsfw: d.over_18 ? 'explicit' : 'suggestive',
    tags: d.link_flair_text ? [d.link_flair_text] : [],
    trusted: true,
  };
  aiguard.mark([base.title, base.text, base.permalink, base.community], 'reddit');
  const prev = previewOf(src);
  const items = [];

  if (src.is_gallery && src.gallery_data && src.media_metadata) {
    (src.gallery_data.items || []).slice(0, 20).forEach((gi, i) => {
      const meta = src.media_metadata[gi.media_id];
      if (!meta || meta.status !== 'valid' || !meta.s) return;
      const s = meta.s;
      const isAnim = meta.e === 'AnimatedImage';
      const video = isAnim && s.mp4 ? decodeHtml(s.mp4) : null;
      // Stills: the unsigned original at i.redd.it/<media_id>.<ext>; the signed preview URL is the fallback.
      const ext = MIME_EXT[String(meta.m || '').toLowerCase()];
      const original = !video && ext && /^[a-z0-9]+$/i.test(gi.media_id) ? `https://i.redd.it/${gi.media_id}.${ext}` : null;
      const mediaUrl = video || original || decodeHtml(s.u || s.gif || '');
      if (!mediaUrl) return;
      items.push({
        ...base, position: i, mediaType: video ? 'video' : 'image', mediaUrl,
        previewUrl: pickWidth((meta.p || []).map((p) => ({ url: decodeHtml(p.u), width: p.x })), 640) || (video ? null : mediaUrl),
        width: s.x || null, height: s.y || null,
        altText: gi.caption || null,
      });
    });
    return items;
  }

  const rv = (src.secure_media && src.secure_media.reddit_video) || (src.media && src.media.reddit_video) || (src.preview && src.preview.reddit_video_preview);
  if (rv && rv.fallback_url) {
    return [{
      ...base, position: 0, mediaType: 'video',
      mediaUrl: String(rv.fallback_url).replace(/\?source=fallback$/, ''),
      hlsUrl: rv.hls_url ? decodeHtml(rv.hls_url) : null,
      hasAudio: !rv.is_gif && !!rv.hls_url,
      previewUrl: prev.previewUrl, width: rv.width || prev.width, height: rv.height || prev.height, duration: rv.duration || null,
    }];
  }

  if (REDGIFS_LINK.test(url)) {
    return [{ ...base, position: 0, mediaType: 'video', mediaUrl: url, previewUrl: null, resolve: 'redgifs', width: prev.width, height: prev.height }];
  }

  if (X_STATUS.test(url)) {
    return [{ ...base, position: 0, mediaType: 'image', mediaUrl: url, previewUrl: prev.previewUrl, resolve: 'x', width: prev.width, height: prev.height }];
  }

  if (host && hostBlocked(host) && !hostMatches(host, 'redd.it')) return drop('blocked host');

  const isGifLike = /\.(gif|gifv)(\?|$)/i.test(url);
  if (isGifLike && prev.mp4) {
    return [{ ...base, position: 0, mediaType: 'video', mediaUrl: prev.mp4, previewUrl: prev.previewUrl, width: prev.width, height: prev.height }];
  }
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) {
    return [{ ...base, position: 0, mediaType: 'video', mediaUrl: url, previewUrl: prev.previewUrl, width: prev.width, height: prev.height }];
  }
  if (hostMatches(host, 'imgur.com') && !/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) {
    const norm = normalizeMediaUrl(url);
    if (!norm) return drop('imgur album');
    return [{ ...base, position: 0, mediaType: /\.mp4$/.test(norm) ? 'video' : 'image', mediaUrl: norm, previewUrl: prev.previewUrl, width: prev.width, height: prev.height }];
  }
  if (/\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(url) || hostMatches(host, 'i.redd.it')) {
    const full = toOriginal(url);
    return [{ ...base, position: 0, mediaType: 'image', mediaUrl: full, previewUrl: prev.previewUrl || url, width: prev.width, height: prev.height }];
  }
  // A text post has no media to lose; an external link we cannot read does.
  if (src.is_self || !url || /\/comments\//.test(url)) return [];
  return drop('unsupported link');
}

/** Atom entries from the .rss transport -> items (no scores / dimensions available). */
const RSS_MEDIA_HOSTS = new Set(['i.redd.it', 'preview.redd.it', 'i.imgur.com', 'imgur.com']);
function fromRssEntry(entry) {
  const id = String(entry.id || '').replace(/^t3_/, '') || (entry.link || '').split('/comments/')[1]?.split('/')[0];
  if (!id) return [];
  const author = (entry.author || '').replace(/^\/?u\//, '') || null;
  const sub = ((entry.link || '').match(/\/r\/([^/]+)\//) || [])[1] || null;
  const common = { sourceId: id, position: 0, title: entry.title, author, community: sub, score: 0, postedAt: entry.published, permalink: entry.link, nsfw: 'explicit', trusted: true, tags: [] };
  const links = entry.links || [];

  const redgifsLink = links.find((u) => REDGIFS_LINK.test(u));
  const redgifs = redgifsLink ? { url: redgifsLink, type: 'video' } : entry.media.find((m) => REDGIFS_LINK.test(m.url));
  if (redgifs) return [{ ...common, mediaType: 'video', mediaUrl: redgifs.url.replace(/&amp;/g, '&'), resolve: 'redgifs' }];
  const xLink = links.find((u) => X_STATUS.test(u));
  if (xLink) return [{ ...common, mediaType: 'image', mediaUrl: xLink.replace(/&amp;/g, '&'), resolve: 'x' }];

  // v.redd.it/<id> carries no file extension in the feed; its HLS playlist (video + audio) is at a fixed path.
  const vlink = links.concat(entry.media.map((m) => m.url)).find((u) => VREDDIT.test(u));
  if (vlink) {
    const hls = `https://v.redd.it/${vlink.match(VREDDIT)[1]}/HLSPlaylist.m3u8`;
    const thumb = entry.media.find((m) => m.type === 'image');
    return [{ ...common, mediaType: 'video', mediaUrl: hls, hlsUrl: hls, hasAudio: true, previewUrl: thumb ? thumb.url : null }];
  }

  // Only Reddit's own image hosts / imgur: external-preview.redd.it and *.thumbs.redditmedia.com are
  // thumbnails of link posts, not the poster's media.
  const direct = entry.media.find((m) => RSS_MEDIA_HOSTS.has(hostOf(m.url)) && looksLikeDirectMedia(m.url));
  const any = direct || entry.media.find((m) => hostOf(m.url) === 'i.redd.it');
  if (!any) return [];
  const mediaUrl = toOriginal(any.url.replace(/&amp;/g, '&'));
  return [{ ...common, mediaType: any.type, mediaUrl, previewUrl: any.type === 'image' ? mediaUrl : null }];
}

/* ------------------------------------------------------------- transports */
function listingPath(feed, sort, t) {
  if (feed.kind === 'user') return `/user/${encodeURIComponent(feed.target)}/submitted`;
  return `/r/${encodeURIComponent(feed.target)}/${sort}`;
}

function qs(params) {
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

async function viaOauth(path, params) {
  assertOn();
  const t = await oauthToken();
  if (!t) return null;
  try {
    const json = await http.json(`${config.baseUrls.redditOauth}${path}?${qs({ ...params, raw_json: 1 })}`, {
      ...REDDIT_WAIT, headers: { authorization: `Bearer ${t}`, 'user-agent': config.redditUserAgent },
    });
    if (!json || !json.data) throw new Error('unexpected Reddit OAuth JSON shape');
    return { children: json.data.children || [], after: json.data.after, via: 'oauth' };
  } catch (e) {
    if (e.status === 401) token = null; // revoked/expired early: fetch a fresh one next time
    throw e;
  }
}

/** A listing of subreddits (kind t5) means Reddit redirected a missing subreddit to its search page. */
const looksLikeSearchRedirect = (children) => children.length > 0 && children.every((c) => c && c.kind === 't5');

async function viaJson(origin, path, params, label) {
  assertOn();
  const json = await http.json(`${origin}${path}.json?${qs({ ...params, raw_json: 1 })}`, {
    ...REDDIT_WAIT, headers: { 'user-agent': config.redditUserAgent },
  });
  if (!json || !json.data) throw new Error('unexpected Reddit JSON shape'); // e.g. {"message":"Forbidden","error":403} served with 200
  const children = json.data.children || [];
  if (looksLikeSearchRedirect(children)) throw Object.assign(new Error('Reddit redirected to subreddit search (the community does not exist)'), { status: 404 });
  return { children, rawCount: children.length, after: json.data.after, via: label };
}

async function viaRss(path, params) {
  assertOn();
  const text = await http.text(`${base}${path}.rss?${qs({ limit: params.limit, sort: params.sort, t: params.t })}`, {
    ...REDDIT_WAIT, headers: { 'user-agent': config.redditUserAgent, accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9' },
  });
  // A block/challenge page served with 200 parses as an empty feed; refuse it so the ladder keeps walking.
  if (!/<(?:feed|rss|rdf:RDF)[\s>]/i.test(String(text).slice(0, 4000))) throw new Error('Reddit RSS returned a non-feed document (HTML challenge page?)');
  const feed = rss.parseFeed(text, base);
  return { items: feed.entries.flatMap(fromRssEntry), rawCount: feed.entries.length, after: null, via: 'rss' };
}

async function viaArchive(feed, params) {
  assertOn();
  // Arctic Shift: /api/posts/search?subreddit=<name>|author=<name>&limit=<=100[&after=<s>&sort=asc | &before=<s>]  ->  {data:[reddit-shaped posts]}
  const cur = params.archive || {};
  const limit = Math.min(params.limit || 100, 100);
  const q = { limit, ...(feed.kind === 'user' ? { author: feed.target } : { subreddit: feed.target }) };
  if (cur.after) { q.after = cur.after; q.sort = 'asc'; } else if (cur.before) q.before = cur.before;
  const archiveRateLimit = (detail) => {
    // "Timeout. Maybe slow down a bit": the archive's dynamic rate limit. A wait, not an empty community.
    const e = Object.assign(new Error(`Reddit archive is rate limiting: ${String(detail).slice(0, 80)}`), { status: 429, retryAfter: 60_000 });
    http.strike(e);
    return e;
  };
  let json;
  try {
    json = await http.json(`${config.baseUrls.redditArchive}/api/posts/search?${qs(q)}`, { ...REDDIT_WAIT, headers: { 'user-agent': config.redditUserAgent } });
  } catch (err) {
    // The same limit also arrives as HTTP 422 with {"error":"Timeout. Maybe slow down a bit"} (seen 2026-11-11). Read it as
    // the 429 it is; any other 422 is a real error and still surfaces.
    if (err && err.status === 422 && /slow down|Timeout/i.test(String(err.body || ''))) throw archiveRateLimit(err.body);
    throw err;
  }
  if (json && !Array.isArray(json) && json.error) throw archiveRateLimit(json.error);
  const rows = Array.isArray(json) ? json : json.data || [];
  // Next page: forward from the last row (asc) or back from the oldest (desc), only after a full page that moved.
  let next = null;
  if (rows.length >= limit) {
    const times = rows.map((r) => Number((r && r.data ? r.data : r).created_utc)).filter(Number.isFinite);
    if (cur.after) { const t = Math.max(...times); if (t > cur.after) next = { after: t }; } else if (times.length) { const t = Math.min(...times); if (!cur.before || t < cur.before) next = { before: t }; }
  }
  return { children: rows, rawCount: rows.length, after: next ? { archive: next } : null, via: 'archive', incremental: !!cur.after };
}

/** Reddit explains refusals: {"reason":"private"|"quarantined"|"banned"...,"error":403}. Those are about ONE target. */
const TARGET_REASONS = {
  private: 'is private', quarantined: 'is quarantined (needs opt-in, cannot be read anonymously)', gold_only: 'is restricted to premium members',
  gated: 'is age/opt-in gated', employees_only: 'is restricted', archived: null,
};
function targetReason(e) {
  if (!e || !e.body || e.status !== 403) return null;
  try { const r = String((JSON.parse(e.body) || {}).reason || '').toLowerCase(); return TARGET_REASONS[r] ? { reason: r, text: TARGET_REASONS[r] } : null; } catch { return null; }
}

/**
 * Walk the transport ladder; returns the first page that works plus notes about failures.
 *   - 403/429/5xx, HTML/non-JSON bodies, JSON without `data`, a non-feed RSS body: next transport.
 *   - an empty first page: also next transport (a blocked edge often answers 200 with nothing); if every
 *     transport agrees it is empty, that empty page is returned.
 *   - 404/410 (and private/quarantined): about this target, not the transport - stop at once.
 *   - `after` cursors: RSS and the archive cannot continue them, so page 2+ only uses the JSON transports.
 * `dead` remembers transports that already failed during this feed run, so pages 2..n do not re-knock.
 */
async function fetchPage(feed, sort, params, dead = new Set()) {
  assertOn();
  const path = listingPath(feed, sort);
  // A page 2+ that came from the archive carries the archive's own cursor: only the archive can continue it.
  if (params.after && typeof params.after === 'object') {
    const page = await viaArchive(feed, { ...params, after: undefined, archive: params.after.archive });
    page.notes = [];
    return page;
  }
  const paged = !!params.after;
  const label = `${feed.kind === 'user' ? 'u' : 'r'}/${feed.target}`;
  // Without OAuth credentials Reddit refuses every .json/.rss request from this host with a 403 challenge, so
  // public mode asks the archive first instead of paying three doomed requests per page. The public transports
  // stay behind it as fallbacks (the archive can lag or miss a small community) and a paged read still uses them.
  const publicMode = !config.creds.redditClientId || !config.creds.redditClientSecret;
  const { archive: archiveStart, ...live } = params;
  const archiveLeg = ['archive', () => viaArchive(feed, { ...live, archive: archiveStart })];
  const attempts = publicMode
    // www/old JSON are guaranteed 403 from a datacenter host: not asked. RSS stays for residential and dev hosts.
    ? [archiveLeg, ...(paged ? [] : [['rss', () => viaRss(path, live)]])]
    : [
      ['oauth', () => viaOauth(path, live)],
      ['json', () => viaJson(base, path, live, 'json')],
      ['old', () => viaJson(oldBase, path, live, 'old')],
      ...(paged ? [] : [['rss', () => viaRss(path, live)], archiveLeg]),
    ];
  const usable = attempts.filter(([name]) => !dead.has(name));
  const notes = [];
  const failed = [];
  let firstErr; let empty = null; let gone = 0; let explicitGone = 0; const errs = [];
  for (const [name, attempt] of usable.length ? usable : attempts) {
    try {
      const page = await attempt();
      if (!page) continue; // OAuth not configured
      // An incremental archive read with nothing after the cursor is an honest "nothing new", not a failed transport.
      if (!paged && page.rawCount === 0 && !page.incremental) {
        failed.push(`${name} empty`); notes.push(`${name}: empty listing`);
        if (name === 'archive') gone++; // an archive that knows nothing agrees with "does not exist" - but only as a tie-breaker (see below)
        else empty = empty || page;
        continue;
      }
      page.notes = notes;
      return page;
    } catch (e) {
      dead.add(name);
      if (!firstErr) firstErr = e; // the primary failure is the one worth reporting, not the last mirror's
      errs.push(e);
      failed.push(`${name} ${e.status || e.code || 'err'}`);
      notes.push(`${e.status || e.code || 'err'} ${String(e.message).slice(0, 80)}`);
      const tr = targetReason(e);
      if (tr) throw Object.assign(new Error(`${label} ${tr.text} (Reddit says "${tr.reason}")`), { status: 403, perTarget: true, targetGone: true });
      // A 404 from ONE transport proves nothing: Reddit's edge answers blocked datacenter requests to some endpoints
      // (old.reddit.com JSON) with a bare "404 Not Found". Keep walking; only unanimity makes it "gone".
      if (e.status === 404 || e.status === 410) { gone++; explicitGone++; }
    }
  }
  if (empty) { empty.notes = notes; return empty; }
  // "Gone" needs EXPLICIT 404/410 answers from at least two live transports with nothing contradicting them; an archive
  // that merely has no rows (it can lag, or not index a small community) is never enough on its own.
  if (explicitGone >= 2 && gone === failed.length) {
    throw Object.assign(new Error(`${label} not found (every transport says HTTP 404/410: banned, suspended, private or misspelled)`), { status: 404, retryAfter: 0 });
  }
  if (!firstErr) firstErr = new Error('no Reddit transport available');
  // One actionable line: what failed where. Keep the first failure's status so the engine/breaker can reason about it.
  // Not unanimous, so never report "gone": a lone 404 (an edge block) must not leave status 404/410 on the aggregate error,
  // or the engine would disable a healthy feed after three runs. Report the first failure that is not a 404/410.
  const real = errs.find((e) => e.status !== 404 && e.status !== 410) || {};
  throw Object.assign(new Error(`Reddit unavailable for ${label} on every transport: ${failed.join(', ')}`), { status: real.status || 502, retryAfter: real.retryAfter || firstErr.retryAfter || 0, code: real.code || firstErr.code || '' });
}

/** The account's profile. A failure is reported through `notes` (when given) instead of disappearing; the posts stay. */
async function fetchProfile(name, notes) {
  if (!enabled()) return null;
  try {
    const t = await oauthToken();
    const json = t
      ? await http.json(`${config.baseUrls.redditOauth}/user/${encodeURIComponent(name)}/about?raw_json=1`, { headers: { authorization: `Bearer ${t}`, 'user-agent': config.redditUserAgent } })
      : await http.json(`${base}/user/${encodeURIComponent(name)}/about.json?raw_json=1`, { headers: { 'user-agent': config.redditUserAgent } });
    const d = json.data || {};
    const sr = d.subreddit || {};
    aiguard.mark([sr.public_description, sr.title], 'reddit');
    return {
      displayName: sr.title || d.name || name,
      bio: sr.public_description || null,
      avatarUrl: decodeHtml(d.snoovatar_img || sr.icon_img || d.icon_img || '') || null,
      bannerUrl: decodeHtml(sr.banner_img || '') || null,
    };
  } catch (e) {
    if (Array.isArray(notes)) notes.push(`profile not read: ${String((e && e.message) || e).slice(0, 120)}`);
    return null;
  }
}

/** Search NSFW-inclusive subreddits by keyword (discovery). OAuth when configured, else www, else old.reddit. */
async function searchSubreddits(q, limit = 25) {
  if (!enabled()) return []; // discovery asks for a list: with Reddit off there is none, and no request is made
  const qs = `q=${encodeURIComponent(q)}&include_over_18=on&limit=${limit}&raw_json=1`;
  const t = await oauthToken().catch(() => null);
  const tries = t
    ? [() => http.json(`${config.baseUrls.redditOauth}/subreddits/search?${qs}`, { headers: { authorization: `Bearer ${t}`, 'user-agent': config.redditUserAgent } })]
    : [];
  tries.push(() => http.json(`${base}/subreddits/search.json?${qs}`, { headers: { 'user-agent': config.redditUserAgent } }));
  if (oldBase !== base) tries.push(() => http.json(`${oldBase}/subreddits/search.json?${qs}`, { headers: { 'user-agent': config.redditUserAgent } }));
  let lastErr;
  for (const attempt of tries) {
    try {
      const json = await attempt();
      return ((json.data && json.data.children) || []).map((c) => c.data).filter((d) => d && d.display_name).map((d) => {
        aiguard.mark([d.title, d.public_description], 'reddit');
        return {
          name: d.display_name, title: d.title || null, description: d.public_description || null, subscribers: d.subscribers || 0,
          over18: !!d.over18, icon: decodeHtml(d.community_icon || d.icon_img || '').split('?')[0] || null,
        };
      });
    } catch (e) { lastErr = e; if (e.status === 404) break; }
  }
  throw lastErr || new Error('Reddit search unavailable');
}

/**
 * Public post search (discovery mentions). OAuth when configured, else www JSON.
 * Returns plain post records; the caller still runs the takedown and safety checks.
 */
async function searchPosts(q, limit = 15) {
  if (!enabled()) return [];
  const n = Math.max(1, Math.min(25, limit || 15));
  const qs = `q=${encodeURIComponent(q)}&include_over_18=on&limit=${n}&sort=new&type=link&raw_json=1`;
  const t = await oauthToken().catch(() => null);
  const tries = [];
  if (t) tries.push(() => http.json(`${config.baseUrls.redditOauth}/search?${qs}`, { headers: { authorization: `Bearer ${t}`, 'user-agent': config.redditUserAgent } }));
  tries.push(() => http.json(`${base}/search.json?${qs}`, { headers: { 'user-agent': config.redditUserAgent } }));
  let lastErr;
  for (const attempt of tries) {
    try {
      const json = await attempt();
      return ((json.data && json.data.children) || []).map((c) => c.data).filter(Boolean).map((d) => {
        aiguard.mark([d.title, d.selftext, d.permalink], 'reddit');
        return {
          id: d.id,
          author: d.author,
          title: d.title || '',
          selftext: d.selftext || '',
          url: d.url || '',
          subreddit: d.subreddit || '',
          permalink: d.permalink || '',
          over18: !!d.over_18,
        };
      }).filter((p) => p.author && p.author !== '[deleted]' && p.author !== 'AutoModerator');
    } catch (e) { lastErr = e; if (e.status === 404) break; }
  }
  throw lastErr || new Error('Reddit post search unavailable');
}

module.exports = {
  searchSubreddits,
  searchPosts,
  platform: 'reddit',
  label: 'Reddit',
  color: '#ff4500',
  kinds: ['community', 'user'],
  intervalMin: { community: 90, user: 240 },
  parsePost, fromRssEntry,
  isConfigured() {
    // When redditEnabled is off the engine skips these feeds without counting a failure or tripping the breaker.
    if (!enabled()) return { ok: false, note: OFF_NOTE };
    return config.creds.redditClientId && config.creds.redditClientSecret
      ? { ok: true, note: 'OAuth enabled' }
      : { ok: true, note: 'Public mode — add REDDIT_CLIENT_ID/SECRET for reliable access' };
  },

  async fetch(feed, ctx) {
    assertOn();
    const cursor = ctx.cursor || {};
    const first = !cursor.newestAt;
    // First pass: breadth (top of the month + hot). After that: incremental "new".
    const passes = first && feed.kind === 'community'
      ? [{ sort: 'top', t: 'month' }, { sort: 'hot' }]
      : [{ sort: 'new' }];
    const items = [];
    const seen = new Set();
    const notes = new Set();
    const drops = {};
    let via = null;
    let newest = cursor.newestAt || null;

    for (let p = 0; p < passes.length; p++) {
      const pass = passes[p];
      // The archive answers with the newest rows regardless of sort and time window, so on the archive the
      // first-run top+hot second pass would re-read the same page. One pass is enough there (the feed cursor
      // then switches to the incremental `new` path anyway).
      if (p > 0 && via === 'archive') { notes.add('archive read once (it ignores sort and window)'); break; }
      let after = null;
      const maxPages = first ? 3 : 2;
      for (let page = 0; page < maxPages; page++) {
        if (ctx.aborted()) break;
        let res;
        // The archive's incremental start: the cursor's second minus one (`after` is exclusive), so a post in the same
        // second as the newest stored one is still read; re-read posts are deduped downstream by sourceId.
        const archive = !first && pass.sort === 'new' && cursor.newestAt && !ctx.force && Number.isFinite(Date.parse(cursor.newestAt))
          ? { after: Math.floor(Date.parse(cursor.newestAt) / 1000) - 1 } : undefined;
        try {
          res = await fetchPage(feed, pass.sort, { limit: Math.min(ctx.limit || 100, 100), t: pass.t, after, sort: feed.kind === 'user' ? 'new' : undefined, archive });
        } catch (e) {
          // Public Reddit allows about one request a minute: a rate-limited later page (or the second
          // pass) must not throw away the page that already worked. Only a run with nothing at all fails.
          if (!items.length) throw e;
          notes.add(`stopped early after ${items.length} items: ${e.message}`);
          break;
        }
        via = via || res.via;
        (res.notes || []).forEach((n) => notes.add(n));
        const parsed = res.items || res.children.flatMap((c) => parsePost(c, drops));
        let reachedKnown = false;
        for (const it of parsed) {
          if (it.postedAt && (!newest || it.postedAt > newest)) newest = it.postedAt;
          if (!first && pass.sort === 'new' && cursor.newestAt && it.postedAt && it.postedAt < cursor.newestAt && !ctx.force) { reachedKnown = true; continue; }
          const key = `${it.sourceId}:${it.position || 0}`;
          if (seen.has(key)) continue; // the archive can serve the same row to two passes
          seen.add(key);
          items.push(it);
        }
        after = res.after;
        if (!after || reachedKnown) break;
      }
    }

    let profile;
    const profileNotes = [];
    if (feed.kind === 'user' && (ctx.needProfile || first)) profile = await fetchProfile(feed.target, profileNotes);
    profileNotes.forEach((n) => notes.add(n));
    const dropped = Object.entries(drops).sort((a, b) => b[1] - a[1]);
    if (dropped.length) notes.add(`dropped ${dropped.reduce((n, [, v]) => n + v, 0)} post(s): ${dropped.map(([k, v]) => `${k} ×${v}`).join(', ')}`);
    return { items, cursor: newest ? { newestAt: newest } : undefined, profile, via, notes: [...notes] };
  },
};
