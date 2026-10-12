'use strict';
/**
 * Cheap "is this URL really media?" check for hosts we do not know. Reads at
 * most a few KB (a Range request where supported), never the whole file.
 */
const net = require('../lib/net');

const MAGIC = [
  [0xff, 0xd8, 0xff],                 // jpeg
  [0x89, 0x50, 0x4e, 0x47],           // png
  [0x47, 0x49, 0x46, 0x38],           // gif
  [0x52, 0x49, 0x46, 0x46],           // webp / riff
  [0x1a, 0x45, 0xdf, 0xa3],           // webm / mkv
];
const looksBinaryMedia = (b) => b.length >= 12 && (MAGIC.some((sig) => sig.every((x, i) => b[i] === x)) || b.slice(4, 8).toString('ascii') === 'ftyp' || b.slice(0, 4).toString('ascii') === 'avif');

async function probeMedia(url, type, { timeout = 10000, minBytes = 4000 } = {}) {
  let opened;
  try {
    opened = await net.open(url, { headers: { range: 'bytes=0-16383' }, timeout, maxRedirects: 4 });
  } catch (e) {
    return { ok: false, reason: e.code === 'EBLOCKED' ? 'blocked host' : `unreachable: ${e.message}` };
  }
  const { res, req } = opened;
  const status = res.statusCode;
  const ctype = String(res.headers['content-type'] || '').toLowerCase();
  const total = Number((String(res.headers['content-range'] || '').split('/')[1])) || Number(res.headers['content-length']) || null;

  if (status >= 400) {
    const challenge = String(res.headers['cf-mitigated'] || '').toLowerCase() === 'challenge';
    res.resume(); req.destroy();
    return { ok: false, reason: challenge ? `http ${status} (Cloudflare bot challenge: this server's IP is walled off)` : `http ${status}`, challenge };
  }
  if (ctype.includes('text/html') || ctype.includes('application/json') || ctype.includes('text/plain')) {
    res.resume(); req.destroy();
    return { ok: false, reason: `not media (${ctype.split(';')[0]})` };
  }
  if (total !== null && total < minBytes) { res.resume(); req.destroy(); return { ok: false, reason: `too small (${total} B)` }; }

  // Read enough to (a) sniff magic bytes and (b) detect tiny placeholders even when the server
  // sends no Content-Length (chunked): a body that ENDS before minBytes is too small.
  const { head, ended } = await new Promise((resolve) => {
    const chunks = []; let n = 0; let finished = false;
    const done = (ended) => { if (finished) return; finished = true; req.destroy(); resolve({ head: Buffer.concat(chunks), ended }); };
    res.on('data', (c) => { chunks.push(c); n += c.length; if (n > minBytes) done(false); });
    res.on('end', () => done(true)); res.on('error', () => done(false));
    setTimeout(() => done(false), timeout).unref();
  });
  if (ended && head.length < minBytes && status !== 206) return { ok: false, reason: `too small (${head.length} B)` };
  const mediaCtype = /^(image|video)\//.test(ctype);
  if (!mediaCtype && !looksBinaryMedia(head) && !/^application\/(octet-stream|mp4|vnd\.apple\.mpegurl|x-mpegurl)/.test(ctype)) {
    return { ok: false, reason: `not image/video bytes (${ctype || 'no content-type'})` };
  }
  return { ok: true, contentType: ctype, bytes: total };
}

module.exports = { probeMedia, looksBinaryMedia };
