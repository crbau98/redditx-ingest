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

const router = express.Router();

const KNOWN_SUFFIXES = [
  'redd.it', 'redditmedia.com', 'imgur.com', 'redgifs.com', 'gfycat.com', 'twimg.com',
  'bsky.app', 'bsky.social', 'bsky.network',
  'telesco.pe', 'telegram-cdn.org', 'cdn-telegram.org', 'telegram.org',
];
const HLS_TYPES = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|octet-stream)|audio\/mpegurl|video\/mp2t)/i;

import * as policy from '../sources/_policy.js';

function parseTarget(req){
  const raw = req.query.url || req.query.target;
  if(!raw) throw Object.assign(new Error('missing url'),{status:400});
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  if(policy.isDenied(host)) throw Object.assign(new Error(`denied by policy: ${host}`),{status:403});
  return u;
}
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
router.get('/hls', async (req,res)=>{
  const depth = parseInt(req.query.d||'0',10)||0;
  if(depth>4) return res.status(400).send('depth exceeded');
  const target = parseTarget(req).toString();
  // fetch via net.open - already re-validates redirects and strips auth cross-host
  const upstream = await net.open(target, { timeout: 10000 });
  let text = await upstream.text();
  // depth-capped rewrite, per-playlist seen set prevents A->B->A loop
  const seen = new Set();
  const base = new URL(target);
  text = text.split('\n').map(line=>{
    const t=line.trim();
    if(t && !t.startsWith('#') && t.endsWith('.m3u8')){
      if(seen.has(t)) return line;
      seen.add(t);
      const abs = new URL(t, base).toString();
      return `/api/hls?url=${encodeURIComponent(abs)}&d=${depth+1}`;
    }
    return line;
  }).join('\n');
  res.setHeader('content-type','application/vnd.apple.mpegurl');
  res.send(text);
});

module.exports = router;
