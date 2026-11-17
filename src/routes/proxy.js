'use strict';
/**
 * Media + HLS proxy.
 *
 * Why proxy at all: viewers never contact third-party CDNs (privacy), hotlink
 * protection is satisfied with the right Referer, and images survive origin
 * outages through the disk cache.
 *
 * Hardening vs the previous proxy:
 *   - SSRF: connections go through net.open's validating DNS lookup, and every
 *     redirect hop is re-validated (not just the first URL).
 *   - HTTP Range pass-through, so <video> seeking works (Safari requires it).
 *   - Upstream is aborted when the viewer disconnects.
 *   - Only image/video/HLS content types are relayed; SVG and HTML are refused.
 *   - Host allow-list = known CDN suffixes + hosts ingestion already accepted.
 */
const express = require('express');
const config = require('../config');
const net = require('../lib/net');
const cache = require('../lib/media-cache');
const repo = require('../db/repo');
const playback = require('../engine/playback');
const { isChallengeText } = require('../sources/util');
const { markImage } = require('../lib/watermark');
const egress = require('../lib/egress');

const router = express.Router();

/**
 * Egress counter (lib/egress): the bytes this response put on the wire (socket delta, headers included, as billed), by
 * kind and cache result. Counting only; the response itself is untouched.
 */
router.use((req, res, next) => {
  const sock = req.socket;
  const start = sock ? sock.bytesWritten : 0;
  let counted = false;
  const count = () => {
    if (counted || !sock) return;
    counted = true;
    const type = String(res.getHeader('content-type') || '').toLowerCase();
    const kind = req.path === '/hls' || HLS_TYPES.test(type) ? 'hls' : type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'other';
    egress.record(kind, res.getHeader('x-cache') === 'HIT' ? 'hit' : 'miss', sock.bytesWritten - start);
  };
  res.on('finish', count);
  res.on('close', count);
  next();
});

const KNOWN_SUFFIXES = [
  'redd.it', 'redditmedia.com', 'imgur.com', 'redgifs.com', 'gfycat.com', 'twimg.com',
  'bsky.app', 'bsky.social', 'bsky.network',
  'telesco.pe', 'telegram-cdn.org', 'cdn-telegram.org', 'telegram.org',
  // GayForFans streams from its own CDN (manifest on gayforfans.com, segments on
  // cdn.gff.network / cache-<city>-fbs-<n>.gff.network, all one infrastructure).
  'gff.network',
  // Coomer serves thumbnails, icons and banners from img.coomer.st and files from nX.coomer.st.
  'coomer.st',
];
const HLS_TYPES = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|octet-stream)|audio\/mpegurl|video\/mp2t)/i;

/** Hosts whose hotlink protection demands a specific site as the Referer — sending the CDN's own
 * origin (the generic behaviour) is exactly what gets refused with a 403. */
const REFERER_BY_HOST = {
  'cdn.gff.network': 'https://gayforfans.com/',
};
/** Same, for a whole CDN: Pornhub's media nodes (hv-h.phncdn.com, ev-h.phncdn.com, …) answer 412 to
 * anything but the site itself as the Referer. */
const REFERER_BY_SUFFIX = [
  ['phncdn.com', 'https://www.pornhub.com/'],
];

function refererFor(host) {
  if (REFERER_BY_HOST[host]) return REFERER_BY_HOST[host];
  for (const [domain, referer] of REFERER_BY_SUFFIX) {
    if (host === domain || host.endsWith(`.${domain}`)) return referer;
  }
  return null;
}

/** The proxy's allow-list: PRISM's own store, known CDN suffixes, and hosts ingestion already accepted. */
function hostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  return host === config.storeHost || KNOWN_SUFFIXES.some((d) => host === d || host.endsWith(`.${d}`)) || repo.hosts.has(host);
}
/** Every redirect hop is held to the same rules as the first URL (net.open's allowHop). */
const hopAllowed = (u) => (u.protocol === 'http:' || u.protocol === 'https:') && !net.isPrivateHost(u.hostname) && hostAllowed(u.hostname);

function parseTarget(req) {
  const raw = req.query.url;
  if (!raw || typeof raw !== 'string' || raw.length > 2048) return { error: [400, 'Missing or invalid url'] };
  let u;
  try { u = new URL(raw); } catch { return { error: [400, 'Invalid url'] }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: [400, 'Invalid protocol'] };
  if (net.isPrivateHost(u.hostname)) return { error: [403, 'Blocked host'] };
  const host = u.hostname.toLowerCase();
  if (!hostAllowed(host)) return { error: [403, 'Host not allowed'] };
  return { url: u.toString(), host, origin: u.origin, pathname: u.pathname };
}

/**
 * Coomer's /data/<path> 302s to its file nodes (n1..n4.coomer.st). When a file node times out for an image,
 * img.coomer.st/thumbnail/data/<path> serves the 800px JPEG from Coomer's reachable image CDN.
 */
function coomerThumbFallback(t) {
  if (!t || !t.pathname || !/^\/data\/.+\.(?:jpe?g|png|webp|gif)$/i.test(t.pathname)) return null;
  if (!(t.host === 'coomer.st' || t.host.endsWith('.coomer.st'))) return null;
  return `${config.baseUrls.coomerImg}/thumbnail${t.pathname}`;
}

function sendError(res, [status, message]) {
  if (res.headersSent) return res.end();
  res.status(status).json({ error: message });
}

const proxyHeaders = (target, extra = {}) => {
  let origin;
  try { origin = new URL(target).origin; } catch { origin = ''; }
  let host = '';
  try { host = new URL(target).hostname.toLowerCase(); } catch { /* none */ }
  return {
    referer: refererFor(host) || `${origin}/`,
    accept: 'image/avif,image/webp,video/*,image/*;q=0.8,*/*;q=0.5',
    'accept-encoding': 'identity',
    ...extra,
  };
};

/**
 * A downloaded image with the PRISM mark (/api/proxy?url=…&mark=prism). The marked file is cached under
 * its own key, so normal viewing (which never sends mark=prism) is untouched.
 */
async function servePrismMarked(req, res, t) {
  // ":2" retires the first mark's cached files (it flattened animated GIFs to one still frame).
  const key = `${t.url}#mark=prism:2`;
  const hit = cache.get(key);
  if (hit) {
    res.set({ 'Content-Type': hit.type, 'Content-Length': hit.size, 'Cache-Control': 'public, max-age=604800', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Cache': 'HIT' });
    const file = require('fs').createReadStream(hit.file);
    file.on('error', () => { if (!res.headersSent) sendError(res, [404, 'Gone']); else res.destroy(); });
    return file.pipe(res);
  }
  let source;
  const base = cache.get(t.url);
  if (base) {
    source = await require('fs').promises.readFile(base.file).catch(() => null);
  }
  if (!source) {
    let up;
    try { up = await net.open(t.url, { headers: proxyHeaders(t.url), timeout: 15000, maxRedirects: 4, allowHop: hopAllowed }); }
    catch (e) { return sendError(res, e.code === 'EBLOCKED' ? [403, 'Blocked host'] : [502, 'Upstream unreachable']); }
    const type = String(up.res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (up.res.statusCode !== 200 || !type.startsWith('image/') || type === 'image/svg+xml') { up.res.resume(); return sendError(res, [415, 'Only images can be marked']); }
    const chunks = []; let size = 0; let tooBig = false;
    for await (const c of up.res) { size += c.length; if (size > cache.MAX_FILE) { tooBig = true; up.res.destroy(); break; } chunks.push(c); }
    if (tooBig) return sendError(res, [413, 'Image too large to mark']);
    source = Buffer.concat(chunks);
  }
  let marked;
  try { marked = await markImage(source); }
  catch { return sendError(res, [502, 'Could not mark this image']); } // never fall back to an unmarked file
  cache.put(key, marked.buffer, marked.type);
  res.set({ 'Content-Type': marked.type, 'Content-Length': marked.buffer.length, 'Cache-Control': 'public, max-age=604800', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Cache': 'MISS' });
  res.end(marked.buffer);
}

router.get('/proxy', async (req, res) => {
  const t = parseTarget(req);
  if (t.error) return sendError(res, t.error);
  if (req.query.mark === 'prism') return servePrismMarked(req, res, t);

  // Stored media in bucket mode: send the browser to the bucket (presigned, no egress through us). The watermarked download
  // above never gets here; disk mode, files still on the volume and STORE_DIRECT=0 fall through to the relay below.
  if (t.host === config.storeHost) {
    const direct = require('../lib/objectstore').directUrl(t.url);
    if (direct) {
      res.status(307).set({ Location: direct.url, 'Cache-Control': `private, max-age=${direct.maxAge}`, 'Content-Length': '0' });
      return res.end();
    }
  }

  const hasRange = !!req.headers.range;
  if (!hasRange) {
    const hit = cache.get(t.url);
    if (hit) {
      res.set({ 'Content-Type': hit.type, 'Content-Length': hit.size, 'Cache-Control': 'public, max-age=604800', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Cache': 'HIT' });
      // the file can be evicted between the lookup and the open: an unhandled stream error would crash the server
      const file = require('fs').createReadStream(hit.file);
      file.on('error', () => { if (!res.headersSent) sendError(res, [404, 'Gone']); else res.destroy(); });
      return file.pipe(res);
    }
  }

  // The viewer can leave before the origin answers: abort the upstream then too, not only once it is streaming (an aborted
  // first-frame tile used to hold its origin socket until the 15 s timeout, and 32 of them starved the per-host agent).
  const viewerGone = new AbortController();
  res.on('close', () => { if (!res.writableFinished) viewerGone.abort(); });
  let upstream;
  const isCoomerData = (t.host === 'coomer.st' || t.host.endsWith('.coomer.st')) && /^\/data\//i.test(t.pathname || '');
  try {
    upstream = await net.open(t.url, { headers: proxyHeaders(t.url, hasRange ? { range: req.headers.range } : {}), timeout: isCoomerData ? 6000 : 15000, maxRedirects: 4, allowHop: hopAllowed, signal: viewerGone.signal });
  } catch (e) {
    if (e.code === 'EABORTED' || viewerGone.signal.aborted) return; // nobody is waiting for an answer
    const thumbFallback = e.code !== 'EBLOCKED' ? coomerThumbFallback(t) : null;
    if (thumbFallback) {
      try {
        upstream = await net.open(thumbFallback, { headers: proxyHeaders(thumbFallback), timeout: 10000, maxRedirects: 3, allowHop: hopAllowed, signal: viewerGone.signal });
      } catch (e2) {
        return sendError(res, e2.code === 'EBLOCKED' ? [403, 'Blocked host'] : [502, 'Upstream unreachable']);
      }
    } else {
      return sendError(res, e.code === 'EBLOCKED' ? [403, 'Blocked host'] : [502, 'Upstream unreachable']);
    }
  }
  const { res: up, req: upReq } = upstream;
  req.on('close', () => { if (!up.complete) upReq.destroy(); });

  const status = up.statusCode;
  const type = String(up.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  // A stale RedGIFs / X link: ask the source for a current one and send the player there (every video plays in PRISM).
  if ([401, 403, 404, 410].includes(status) && playback.canRefresh(t.host)) {
    up.resume();
    const fresh = await playback.refresh(t.url);
    if (fresh && fresh !== t.url && !res.headersSent) {
      res.set({ 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' });
      return res.redirect(307, `/api/proxy?url=${encodeURIComponent(fresh)}`);
    }
  }
  if (status >= 400) { up.resume(); return sendError(res, [status === 404 || status === 410 ? 404 : status >= 500 ? 502 : status, 'Upstream error']); }
  if (type === 'image/svg+xml' || type.startsWith('text/') || type === 'application/json' || type === 'application/xml') {
    up.resume(); return sendError(res, [415, 'Unsupported media type']);
  }
  if (!type.startsWith('image/') && !type.startsWith('video/') && !HLS_TYPES.test(type)) {
    up.resume(); return sendError(res, [415, 'Unsupported media type']);
  }

  const headers = {
    'Content-Type': type || 'application/octet-stream',
    'Cache-Control': 'public, max-age=604800',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Accept-Ranges': up.headers['accept-ranges'] || 'bytes',
    'X-Cache': 'MISS',
  };
  for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) if (up.headers[h]) headers[h] = up.headers[h];
  res.writeHead(status, headers);

  const cacheable = status === 200 && !hasRange && type.startsWith('image/') && Number(up.headers['content-length'] || 0) <= cache.MAX_FILE;
  const chunks = []; let size = 0; let relayed = 0;
  const cap = relayCapBytes();
  up.on('data', (c) => {
    relayed += c.length;
    // One response never relays more than PROXY_MAX_MB (egress is billed): past it, both ends are cut.
    if (cap && relayed > cap) { upReq.destroy(); res.destroy(); return; }
    if (cacheable) { size += c.length; if (size <= cache.MAX_FILE) chunks.push(c); }
  });
  up.on('end', () => { if (cacheable && size <= cache.MAX_FILE && size > 0) cache.put(t.url, Buffer.concat(chunks), type); });
  up.on('error', () => res.destroy());
  up.pipe(res);
});

/**
 * Most bytes one proxied response may relay: env PROXY_MAX_MB (default 1024; 0 = no cap). Read per request. A value that is
 * not a plain non-negative number ('1GB', '-1', 'abc') keeps the default instead of turning the cap off.
 */
let warnedCap = false;
function relayCapBytes() {
  const v = String(process.env.PROXY_MAX_MB ?? '').trim();
  if (v === '') return 1024 * 1048576;
  if (!/^\d+(\.\d+)?$/.test(v)) {
    if (!warnedCap) { warnedCap = true; console.error(`[proxy] PROXY_MAX_MB=${JSON.stringify(v)} is not a number of MB; using 1024`); }
    return 1024 * 1048576;
  }
  return Math.round(Number(v) * 1048576);
}

/** HLS: rewrite playlist URIs so every segment/variant is fetched through us. */
const hlsHeaders = (host, origin) => ({ referer: refererFor(host) || `${origin}/`, accept: 'application/vnd.apple.mpegurl, */*' });
router.get('/hls', async (req, res) => {
  const t = parseTarget(req);
  if (t.error) return sendError(res, t.error);
  let r;
  try { r = await net.request(t.url, { headers: hlsHeaders(t.host, t.origin), timeout: 15000, maxBytes: 1_500_000, retries: 1, allowHop: hopAllowed }); }
  catch (e) { return sendError(res, e.code === 'EBLOCKED' ? [403, 'Blocked host'] : [502, 'Upstream unreachable']); }
  // A signed playlist (Pornhub's exp=/e=, xHamster's) that went stale since the page was rendered: ask the
  // source for a current one and read that, so a viewer never gets a dead master playlist.
  if ([401, 403, 404, 410, 412].includes(r.status) && playback.canRefresh(t.host)) {
    const fresh = await playback.refresh(t.url);
    if (fresh && fresh !== t.url) {
      try {
        const retry = await net.request(fresh, { headers: hlsHeaders(t.host, t.origin), timeout: 15000, maxBytes: 1_500_000, retries: 1, allowHop: hopAllowed });
        if (retry.status < 400) r = retry;
      } catch { /* the dead link's own error stands */ }
    }
  }
  if (r.status >= 400) {
    // A bot-protection interstitial (Cloudflare "Just a moment...") is not a broken video: say so, so the
    // player shows a clear state instead of a generic failure. We do not solve or route around the challenge.
    const body = r.body ? r.body.toString('utf8', 0, 4096) : '';
    if (isChallengeText(body)) {
      return res.status(503).json({ error: 'The source is showing a bot check right now, so this video cannot be streamed here. Open it on the source site.', code: 'source_challenged' });
    }
    return sendError(res, [r.status === 404 ? 404 : 502, 'Upstream error']);
  }
  const text = r.body.toString('utf8');
  if (!text.startsWith('#EXTM3U')) return sendError(res, [415, 'Not an HLS playlist']);

  const base = r.url;
  const rewrite = (uri) => {
    let abs;
    try { abs = new URL(uri, base).toString(); } catch { return uri; }
    const isPlaylist = /\.m3u8(\?|$)/i.test(abs);
    return `/api/${isPlaylist ? 'hls' : 'proxy'}?url=${encodeURIComponent(abs)}`;
  };
  const out = text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${rewrite(u)}"`);
    return rewrite(line.trim());
  }).join('\n');
  res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'public, max-age=30', 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.send(out);
});

module.exports = router;
module.exports._relayCapBytes = relayCapBytes;
module.exports._hostAllowed = hostAllowed; // test hook
module.exports._refererFor = refererFor; // test hook: the hotlink Referer rules
