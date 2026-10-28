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
const policy = require('../sources/_policy');

const router = express.Router();

const KNOWN_SUFFIXES = [
  'redd.it', 'redditmedia.com', 'imgur.com', 'redgifs.com', 'gfycat.com', 'twimg.com',
  'bsky.app', 'bsky.social', 'bsky.network',
  'telesco.pe', 'telegram-cdn.org', 'cdn-telegram.org', 'telegram.org',
];
const HLS_TYPES = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|octet-stream)|audio\/mpegurl|video\/mp2t)/i;

function parseTarget(req) {
  const raw = req.query.url;
  if (!raw || typeof raw !== 'string' || raw.length > 2048) return { error: [400, 'Missing or invalid url'] };
  let u;
  try { u = new URL(raw); } catch { return { error: [400, 'Invalid url'] }; }
  if (policy.isDenied(u.hostname)) return { error: [403, 'Denied host'] };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: [400, 'Invalid protocol'] };
  if (net.isPrivateHost(u.hostname)) return { error: [403, 'Blocked host'] };
  const host = u.hostname.toLowerCase();
  const known = host === config.storeHost || KNOWN_SUFFIXES.some((d) => host === d || host.endsWith(`.${d}`)) || repo.hosts.has(host);
  if (!known) return { error: [403, 'Host not allowed'] };
  return { url: u.toString(), host, origin: u.origin };
}

function sendError(res, [status, message]) {
  if (res.headersSent) return res.end();
  res.status(status).json({ error: message });
}

const proxyHeaders = (origin, extra = {}) => ({
  referer: `${origin}/`,
  accept: 'image/avif,image/webp,video/*,image/*;q=0.8,*/*;q=0.5',
  'accept-encoding': 'identity',
  ...extra,
});

router.get('/proxy', async (req, res) => {
  const t = parseTarget(req);
  if (t.error) return sendError(res, t.error);

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

  let upstream;
  try {
    upstream = await net.open(t.url, { headers: proxyHeaders(t.origin, hasRange ? { range: req.headers.range } : {}), timeout: 15000, maxRedirects: 4 });
  } catch (e) {
    return sendError(res, e.code === 'EBLOCKED' ? [403, 'Blocked host'] : [502, 'Upstream unreachable']);
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
  const chunks = []; let size = 0;
  up.on('data', (c) => { if (cacheable) { size += c.length; if (size <= cache.MAX_FILE) chunks.push(c); } });
  up.on('end', () => { if (cacheable && size <= cache.MAX_FILE && size > 0) cache.put(t.url, Buffer.concat(chunks), type); });
  up.on('error', () => res.destroy());
  up.pipe(res);
});

/** HLS: rewrite playlist URIs so every segment/variant is fetched through us. */
router.get('/hls', async (req, res) => {
  const depth = Math.max(0, Math.min(4, Number.parseInt(req.query.d, 10) || 0));
  if (Number.parseInt(req.query.d, 10) > 4) return sendError(res, [400, 'HLS playlist depth exceeded']);
  const t = parseTarget(req);
  if (t.error) return sendError(res, t.error);
  let r;
  try { r = await net.request(t.url, { headers: { referer: `${t.origin}/`, accept: 'application/vnd.apple.mpegurl, */*' }, timeout: 15000, maxBytes: 1_500_000, retries: 1 }); }
  catch (e) { return sendError(res, e.code === 'EBLOCKED' ? [403, 'Blocked host'] : [502, 'Upstream unreachable']); }
  if (r.status >= 400) return sendError(res, [r.status === 404 ? 404 : 502, 'Upstream error']);
  const text = r.body.toString('utf8');
  if (!text.startsWith('#EXTM3U')) return sendError(res, [415, 'Not an HLS playlist']);

  const base = r.url;
  const rewrite = (uri) => {
    let abs;
    try { abs = new URL(uri, base).toString(); } catch { return uri; }
    const isPlaylist = /\.m3u8(\?|$)/i.test(abs);
    if (isPlaylist) return `/api/hls?url=${encodeURIComponent(abs)}&d=${depth + 1}`;
    return `/api/proxy?url=${encodeURIComponent(abs)}`;
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
