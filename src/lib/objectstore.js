'use strict';
/**
 * Object store for media PRISM has to keep itself (Telegram files cannot be hotlinked from a third-party CDN).
 *
 *   s3    any S3-compatible bucket (Cloudflare R2, Backblaze B2, MinIO, AWS). Nothing is stored on the server: files stream
 *         from the downloader to the bucket and back to the browser through PRISM's proxy.
 *   disk  a folder in the data volume (development, tests, or a deliberate choice).
 *
 * Objects are addressed inside PRISM as  https://media.prism.invalid/<key>  (a reserved name that never resolves). lib/net.js
 * recognises that host and answers from the store, so the media proxy, the image filter and the probes work unchanged.
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const config = require('../config');
const STORE_HOST = config.storeHost;
const sigv4 = require('./sigv4');

const EXT_TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' };
const typeOfKey = (key) => EXT_TYPE[String(key).split('.').pop().toLowerCase()] || 'application/octet-stream';
const KEY_RE = /^[A-Za-z0-9._\-/]{1,300}$/;
const validKey = (key) => KEY_RE.test(key) && !key.split('/').some((p) => p === '..' || p === '.' || p === '');

const prefix = () => config.store.prefix || '';
const s3Ready = () => !!(config.store.endpoint && config.store.bucket && config.store.accessKeyId && config.store.secretAccessKey);
/**
 * 's3' | 'disk' | null.
 *   MEDIA_STORE=disk   the data volume, on purpose.
 *   MEDIA_STORE=s3     the bucket, or null while it is incomplete.
 *   unset              the bucket when complete; otherwise the data volume in development and tests only. In production a
 *                      missing or half-set bucket is null (media features report "not configured"): it must never fall back
 *                      to the volume that holds the database. On 2026-11-03 that fallback wrote ~50 GB of Telegram media to
 *                      /data/store in five hours and the database could no longer open its WAL.
 */
function kind() {
  const k = config.store.kind;
  if (k === 'disk') return 'disk';
  if (k === 's3') return s3Ready() ? 's3' : null;
  if (s3Ready()) return 's3';
  return config.isProd || config.isHosted ? null : 'disk';
}
const anyStoreVar = () => !!(config.store.endpoint || config.store.bucket || config.store.accessKeyId || config.store.secretAccessKey);
const describe = () => {
  const k = kind();
  if (k === 's3') return { kind: 's3', where: `${new URL(config.store.endpoint).host}/${config.store.bucket}`, prefix: prefix() };
  if (k === 'disk') return { kind: 'disk', where: path.join(config.dataDir, 'store') };
  return { kind: null, error: config.store.kind === 's3' || anyStoreVar()
    ? 'MEDIA_STORE_* is set but incomplete or unusable (need endpoint, bucket, access key id and secret): refusing to use the data volume instead'
    : 'No media store configured: set MEDIA_STORE_ENDPOINT, MEDIA_STORE_BUCKET, MEDIA_STORE_ACCESS_KEY_ID and MEDIA_STORE_SECRET_ACCESS_KEY (or MEDIA_STORE=disk to use the data volume on purpose)' };
};

const urlFor = (key) => `https://${STORE_HOST}/${key.split('/').map(encodeURIComponent).join('/')}`;
/** Key of a store URL, or null for any other URL. */
function keyOf(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.hostname.toLowerCase() !== STORE_HOST) return null;
  let key; try { key = decodeURIComponent(u.pathname.replace(/^\/+/, '')); } catch { return null; }
  return validKey(key) ? key : null;
}
const isStoreUrl = (url) => { try { return new URL(url).hostname.toLowerCase() === STORE_HOST; } catch { return false; } };

/* -------------------------------------------------------------------------------- s3 */
function s3Request(method, key, { headers = {}, body, contentLength } = {}) {
  const c = config.store;
  const base = new URL(c.endpoint);
  const objectPath = `/${[c.bucket, ...(prefix() + key).split('/')].map(sigv4.enc).join('/')}`;
  const basePath = base.pathname.replace(/\/+$/, '');
  const fullPath = `${basePath}${objectPath}`;
  const signed = sigv4.sign({ method, host: base.host, path: fullPath, headers, region: c.region, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey });
  const hdrs = { ...headers, ...signed.headers };
  delete hdrs.host;
  if (contentLength !== undefined) hdrs['content-length'] = String(contentLength);
  const net = require('./net');
  const internal = (config.internalHosts || []).includes(base.hostname.toLowerCase());
  return net.open(`${base.protocol}//${base.host}${fullPath}`, { method, headers: { ...hdrs, 'accept-encoding': 'identity' }, body, timeout: method === 'PUT' ? 10 * 60 * 1000 : 20000, maxRedirects: 0, allowInternal: internal });
}
async function drain(res) { await new Promise((resolve) => { res.on('end', resolve); res.on('error', resolve); res.on('close', resolve); res.resume(); }); }
async function s3Fail(res, what) {
  const chunks = []; let n = 0;
  await new Promise((resolve) => { res.on('data', (c) => { if (n < 600) { chunks.push(c); n += c.length; } }); res.on('end', resolve); res.on('error', resolve); res.on('close', resolve); });
  const msg = Buffer.concat(chunks).toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return Object.assign(new Error(`object store ${what} failed: http ${res.statusCode}${msg ? ` (${msg})` : ''}`), { status: res.statusCode });
}

/* -------------------------------------------------------------------------------- disk */
const diskPath = (key) => path.join(config.dataDir, 'store', ...key.split('/'));

/* -------------------------------------------------------------------------------- api */
/** Upload to the bucket, whatever `kind()` says (also used by the disk -> bucket migration). `sha256` is stored as object metadata. */
async function putS3(key, source, contentType, { sha256 = null } = {}) {
  if (!s3Ready()) throw new Error('the bucket is not configured');
  const type = contentType || typeOfKey(key);
  const isFile = typeof source === 'string';
  const bytes = isFile ? fs.statSync(source).size : source.length;
  const headers = { 'content-type': type };
  if (sha256) headers['x-amz-meta-sha256'] = sha256;
  const { res } = await s3Request('PUT', key, { headers, body: isFile ? fs.createReadStream(source) : source, contentLength: bytes });
  if (res.statusCode >= 300) throw await s3Fail(res, 'upload');
  await drain(res);
  return { key, url: urlFor(key), bytes };
}

/** What the bucket says about an object: { exists, size, sha256 (our metadata, if any), etag (without quotes, if any) }. */
async function headS3(key) {
  if (!validKey(key) || !s3Ready()) return { exists: false, size: 0, sha256: null, etag: null };
  const { res } = await s3Request('HEAD', key);
  await drain(res);
  if (res.statusCode >= 300) return { exists: false, size: 0, sha256: null, etag: null };
  const h = res.headers;
  return { exists: true, size: Number(h['content-length'] || 0), sha256: h['x-amz-meta-sha256'] ? String(h['x-amz-meta-sha256']).toLowerCase() : null, etag: h.etag ? String(h.etag).replace(/^W\//, '').replace(/"/g, '').toLowerCase() : null };
}

/** Read an object back and hash it (streamed): the proof of last resort when the bucket reports neither our metadata nor an MD5 ETag. */
async function hashS3(key) {
  if (!validKey(key) || !s3Ready()) return { exists: false, size: 0, sha256: null };
  const { res } = await s3Request('GET', key);
  if (res.statusCode >= 300) { await drain(res); return { exists: false, size: 0, sha256: null }; }
  const hash = require('crypto').createHash('sha256'); let size = 0;
  await new Promise((resolve, reject) => { res.on('data', (c) => { size += c.length; hash.update(c); }); res.on('end', resolve); res.on('error', reject); res.on('aborted', () => reject(new Error('read-back aborted'))); });
  return { exists: true, size, sha256: hash.digest('hex') };
}

/**
 * Store an object. `source` is a Buffer or the path of a local file (streamed, so a 1 GB video never sits in memory).
 * @returns {Promise<{key: string, url: string, bytes: number}>}
 */
async function put(key, source, contentType) {
  if (!validKey(key)) throw new Error(`invalid object key: ${key}`);
  const k = kind();
  if (!k) throw new Error(describe().error);
  const isFile = typeof source === 'string';
  const bytes = isFile ? fs.statSync(source).size : source.length;
  if (k === 'disk') {
    require('./diskguard').assertRoom(bytes); // never fill the volume that holds the database
    const file = diskPath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (isFile) fs.copyFileSync(source, file); else fs.writeFileSync(file, source);
    return { key, url: urlFor(key), bytes };
  }
  return putS3(key, source, contentType);
}

/** In bucket mode, objects written to the data volume before the bucket was set up are still read from there until they are moved. */
const legacyFile = (key) => { try { const f = diskPath(key); return fs.statSync(f).isFile() ? f : null; } catch { return null; } };

async function has(key) {
  if (!validKey(key)) return false;
  const k = kind();
  if (k === 'disk') return fs.existsSync(diskPath(key));
  if (k !== 's3') return !!legacyFile(key); // misconfigured: files already on the volume stay readable
  const { res } = await s3Request('HEAD', key);
  await drain(res);
  return res.statusCode < 300 || !!legacyFile(key);
}

async function remove(key) {
  if (!validKey(key)) return false;
  const k = kind();
  if (k === 'disk') { try { fs.unlinkSync(diskPath(key)); return true; } catch { return false; } }
  if (k !== 's3') return false;
  const { res } = await s3Request('DELETE', key);
  await drain(res);
  return res.statusCode < 300;
}

function openDisk(key, url, method, headers) {
  const file = diskPath(key);
  let fd = null; let st = null;
  try { fd = fs.openSync(file, 'r'); st = fs.fstatSync(fd); } catch { st = null; } // vanished (or never there): a 404 for the caller to handle
  const mk = (status, hdrs, body) => {
    const res = body || Readable.from([]);
    res.statusCode = status; res.headers = hdrs; res.finalUrl = url; res.complete = false;
    res.on('end', () => { res.complete = true; });
    return { res, req: { destroy: () => res.destroy() } };
  };
  if (!st || !st.isFile()) { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } return mk(404, { 'content-type': 'text/plain' }); }
  // An open descriptor keeps reading the file even if the migration unlinks it meanwhile.
  const stream = (range) => fs.createReadStream(file, { fd, autoClose: true, ...(range || {}) });
  const base = { 'content-type': typeOfKey(key), 'accept-ranges': 'bytes', etag: `"${st.size}-${Math.round(st.mtimeMs)}"` };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(headers.range || headers.Range || ''));
  if (m && (m[1] || m[2])) {
    const start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
    const end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
    if (start > end || start >= st.size) { try { fs.closeSync(fd); } catch { /* ignore */ } return mk(416, { ...base, 'content-range': `bytes */${st.size}` }); }
    if (method === 'HEAD') { try { fs.closeSync(fd); } catch { /* ignore */ } return mk(206, { ...base, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${st.size}` }, null); }
    return mk(206, { ...base, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${st.size}` }, stream({ start, end }));
  }
  if (method === 'HEAD') { try { fs.closeSync(fd); } catch { /* ignore */ } return mk(200, { ...base, 'content-length': String(st.size) }, null); }
  return mk(200, { ...base, 'content-length': String(st.size) }, stream());
}

/** What net.open returns for a store URL: `{res, req}` shaped like a Node HTTP exchange (status, headers, body stream). */
async function open(url, { method = 'GET', headers = {} } = {}) {
  const key = keyOf(url);
  if (!key) throw Object.assign(new Error('Invalid store URL'), { code: 'EBLOCKED' });
  const k = kind();
  if (k === 's3') {
    const range = headers.range || headers.Range;
    const fromBucket = () => s3Request(method === 'HEAD' ? 'HEAD' : 'GET', key, { headers: range ? { range } : {} });
    const out = await fromBucket();
    if (out.res.statusCode === 404 && legacyFile(key)) { // not moved yet: read the local copy
      await drain(out.res);
      const local = openDisk(key, url, method, headers);
      if (local.res.statusCode !== 404) return local;
      // The migration moved (and unlinked) it between our two looks: it is in the bucket now, read it from there.
      local.res.resume();
      const again = await fromBucket(); again.res.finalUrl = url; return again;
    }
    out.res.finalUrl = url;
    return out;
  }
  if (k === 'disk') return openDisk(key, url, method, headers);
  // No usable store (wrong variables): what is already on the volume is still served, read-only; everything else reports the misconfiguration.
  if (legacyFile(key)) return openDisk(key, url, method, headers);
  throw new Error(describe().error);
}

/**
 * Every file under the local store folder as { key, file, size, mtimeMs }, in plain lexicographic KEY order (a directory sorts as
 * "name/"), so a cursor can resume with `key > after` even when the cursor file itself is gone. `after` skips whole subtrees.
 */
function* localObjects({ after = null } = {}) {
  const root = path.join(config.dataDir, 'store');
  function* walk(dir, rel) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents = ents.map((e) => ({ e, sortKey: e.name + (e.isDirectory() ? '/' : '') })).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    for (const { e } of ents) {
      const key = rel ? `${rel}/${e.name}` : e.name; const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (after && after > `${key}/\uffff`) continue; yield* walk(full, key); continue; }
      if (!e.isFile()) continue;
      if (after && key <= after) continue;
      let st; try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isFile()) yield { key, file: full, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
    }
  }
  yield* walk(root, '');
}

module.exports = { kind, describe, put, putS3, headS3, hashS3, s3Ready, localObjects, has, remove, open, urlFor, keyOf, isStoreUrl, validKey, typeOfKey };
