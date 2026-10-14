'use strict';
/**
 * Keep a copy of videos whose links will not last, so every video keeps playing inside PRISM.
 *
 * Most video links are stable and stream straight through the media proxy (/api/proxy, /api/hls). Two kinds are not:
 *   - links that refresh: RedGIFs and X hand out links that can go stale; the proxy asks the source for a fresh one
 *     when that happens (sources.refreshMedia), so nothing is stored for them;
 *   - signed links nobody can refresh (an `expires=` / `signature=` / `oe=` query, Meta and Discord CDNs):
 *     these are copied into the object store (R2) at ingest, within a size cap, and the item points at the stored copy.
 *
 * Setting keepVideos: 'expiring' (default) keeps only the second kind, 'all' keeps every direct video, 'off' none.
 * Only items that passed every gate reach this step, so rejected posts never cost a download.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('./net');
const store = require('./objectstore');

/** Platforms whose stream links the proxy refreshes on demand (see sources/index.js refreshMedia). */
const REFRESHABLE = new Set(['redgifs', 'x']);
const SIGNED_PARAM = /^(expires?|x-amz-expires|x-amz-signature|x-amz-credential|signature|sig|token|oe|oh|_nc_sid|hdnts|hdnea|validto|policy|key-pair-id|exp|e|st)$/i;
const EXPIRING_HOSTS = ['fbcdn.net', 'cdninstagram.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'snapchat.com', 'discordapp.net', 'discordapp.com', 'cdn.discordapp.com'];
const VIDEO_TYPE = /^video\/(mp4|webm|quicktime|x-m4v)$/i;
const EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v' };

const hostMatches = (h, d) => h === d || h.endsWith(`.${d}`);

/** Does this link carry a signature or an expiry, i.e. will it stop working on its own? */
function expiring(url) {
  let u; try { u = new URL(url); } catch { return false; }
  const h = u.hostname.toLowerCase();
  if (EXPIRING_HOSTS.some((d) => hostMatches(h, d))) return true;
  return [...u.searchParams.keys()].some((k) => SIGNED_PARAM.test(k));
}

/** Should this (already accepted) item's video be copied into the store? */
function wanted(item, platform, settings = {}) {
  const mode = settings.keepVideos || 'expiring';
  if (mode === 'off' || item.mediaType !== 'video') return false;
  const url = item.mediaUrl;
  if (!/^https?:\/\//i.test(url || '') || store.isStoreUrl(url) || /\.m3u8(\?|$)/i.test(url)) return false;
  if (REFRESHABLE.has(platform) || item.resolve === 'redgifs' || /redgifs\.com|twimg\.com/i.test(url)) return false;
  if (!store.kind()) return false;
  return mode === 'all' || expiring(url);
}

/**
 * Download the video (streamed to a temp file, never held in memory) and store it.
 * @returns {Promise<{key: string, url: string, bytes: number} | null>} null when it could not be kept (the original link stays)
 */
async function keep(item, { sourceKey, maxMb = 80, timeoutMs = 120000, open = net.open } = {}) {
  const cap = Math.max(1, maxMb || 80) * 1024 * 1024;
  let origin = ''; try { origin = new URL(item.mediaUrl).origin; } catch { return null; }
  let up;
  try { up = await open(item.mediaUrl, { headers: { referer: `${origin}/`, accept: 'video/*,*/*;q=0.5', 'accept-encoding': 'identity' }, timeout: 20000, maxRedirects: 4 }); } catch { return null; }
  const { res, req } = up;
  const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const declared = Number(res.headers['content-length'] || 0);
  if (res.statusCode !== 200 || !VIDEO_TYPE.test(type) || declared > cap) { res.resume(); try { req.destroy(); } catch { /* ignore */ } return null; }

  const id = crypto.createHash('md5').update(String(sourceKey || item.mediaUrl)).digest('hex');
  const tmp = path.join(os.tmpdir(), `prism-keep-${process.pid}-${id}`);
  const ok = await new Promise((resolve) => {
    const out = fs.createWriteStream(tmp);
    let bytes = 0; let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { try { req.destroy(); } catch { /* ignore */ } out.destroy(); finish(false); }, timeoutMs);
    res.on('data', (c) => { bytes += c.length; if (bytes > cap) { try { req.destroy(); } catch { /* ignore */ } out.destroy(); finish(false); } });
    res.on('error', () => { out.destroy(); finish(false); });
    res.on('aborted', () => { out.destroy(); finish(false); });
    out.on('error', () => finish(false));
    out.on('finish', () => finish(bytes > 0));
    res.pipe(out);
  });
  try {
    if (!ok) return null;
    return await store.put(`v/${id.slice(0, 2)}/${id}.${EXT[type] || 'mp4'}`, tmp, type);
  } catch { return null; } finally { fs.rm(tmp, { force: true }, () => {}); }
}

module.exports = { wanted, keep, expiring, REFRESHABLE };
