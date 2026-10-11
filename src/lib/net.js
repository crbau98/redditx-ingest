'use strict';
/**
 * SSRF-safe HTTP client.
 *
 * The old client only string-matched private hostnames, which is bypassed by
 * DNS records that point at 127.0.0.1, IPv6 literals, IPv4-mapped IPv6, octal
 * or decimal IPs, and redirects. Here every connection goes through a custom
 * `lookup` that resolves the name and rejects private/reserved addresses, so
 * the socket can only ever connect to the address we validated (no
 * time-of-check/time-of-use window for DNS rebinding).
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');
const { URL } = require('url');
const config = require('../config');

// ---------------------------------------------------------------- IP rules
const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['100::', 64],
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));

/** Extract the embedded IPv4 from ::ffff:a.b.c.d / ::ffff:7f00:1 / 64:ff9b::/96 forms. */
function embeddedV4(ip) {
  const lower = ip.toLowerCase();
  let m = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  m = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (!kind) return true; // not an IP at all: treat as unsafe
  if (kind === 4) return blocked.check(ip, 'ipv4');
  const v4 = embeddedV4(ip);
  if (v4) return blocked.check(v4, 'ipv4');
  return blocked.check(ip, 'ipv6');
}

/** Hostname pre-check (literal IPs + obviously local names). */
function isPrivateHost(hostname) {
  if (config.allowPrivateHosts) return false;
  let h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  // Numeric forms like 2130706433 or 0x7f.1 are normalised by WHATWG URL to
  // dotted quads before we get here, so a plain name is all that is left.
  return false;
}

function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const wantAll = options && options.all;
  dns.lookup(hostname, { all: true, family: options && options.family }, (err, addrs) => {
    if (err) return callback(err);
    const list = (addrs || []).filter((a) => config.allowPrivateHosts || !isPrivateIp(a.address));
    if (!list.length) {
      const e = new Error(`Blocked host: ${hostname} resolves to a private address`);
      e.code = 'EBLOCKED';
      return callback(e);
    }
    if (wantAll) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

const agentOpts = { keepAlive: true, maxSockets: 32, timeout: 30000, lookup: safeLookup };
const httpAgent = new http.Agent(agentOpts);
const httpsAgent = new https.Agent(agentOpts);

class HttpError extends Error {
  constructor(message, { status = 0, url = '', retryAfter = 0, body = null, code = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfter = retryAfter;
    this.body = body;
    this.code = code;
  }
  get rateLimited() { return this.status === 429; }
  get forbidden() { return this.status === 401 || this.status === 403; }
  get gone() { return this.status === 404 || this.status === 410; }
  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500 || this.status === 408;
  }
}

function parseRetryAfter(h) {
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 120000);
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 120000)) : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(res, buf) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch { /* fall through with raw bytes */ }
  return buf;
}

/**
 * Open a validated connection and hand back the raw response (not yet
 * consumed). Follows redirects itself so every hop is re-validated.
 */
function open(url, { method = 'GET', headers = {}, timeout = 20000, maxRedirects = 5, body } = {}) {
  return new Promise((resolve, reject) => {
    let hops = 0;
    const go = (target, hdrs) => {
      let parsed;
      try { parsed = new URL(target); } catch (e) { return reject(new HttpError('Invalid URL', { url: String(target) })); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reject(new HttpError('Unsupported protocol', { url: target }));
      }
      if (isPrivateHost(parsed.hostname)) {
        return reject(new HttpError('Blocked host', { url: target, code: 'EBLOCKED' }));
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(parsed, {
        method,
        headers: hdrs,
        agent: parsed.protocol === 'https:' ? httpsAgent : httpAgent,
      }, (res) => {
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
          res.resume();
          if (hops >= maxRedirects) return reject(new HttpError('Too many redirects', { url: target }));
          hops++;
          const next = new URL(loc, parsed);
          const nextHdrs = { ...hdrs };
          if (next.host !== parsed.host) {
            delete nextHdrs.authorization; delete nextHdrs.Authorization;
            delete nextHdrs.cookie; delete nextHdrs.Cookie;
          }
          return go(next.toString(), nextHdrs);
        }
        res.finalUrl = parsed.toString();
        resolve({ res, req });
      });
      req.on('error', (e) => reject(new HttpError(e.message, { url: target, code: e.code || '' })));
      req.setTimeout(timeout, () => { req.destroy(new Error('Timeout')); });
      if (body) req.write(body);
      req.end();
    };
    go(url, { 'user-agent': config.userAgent, accept: '*/*', 'accept-encoding': 'gzip, deflate, br', ...lower(headers) });
  });
}

function lower(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (v !== undefined && v !== null) out[k.toLowerCase()] = v;
  return out;
}

/** Buffered request with decompression, size cap and single-shot semantics. */
async function requestOnce(url, opts = {}) {
  const { maxBytes = 3_000_000 } = opts;
  const { res, req } = await open(url, opts);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new HttpError('Response too large', { url, status: res.statusCode }));
        return;
      }
      chunks.push(c);
    });
    res.on('error', (e) => reject(new HttpError(e.message, { url, code: e.code || '' })));
    res.on('aborted', () => reject(new HttpError('Connection aborted', { url })));
    res.on('end', () => {
      resolve({
        status: res.statusCode,
        headers: res.headers,
        url: res.finalUrl || url,
        body: decode(res, Buffer.concat(chunks)),
      });
    });
  });
}

/** Request with retry/backoff for transient failures. */
async function request(url, opts = {}) {
  const { retries = 2, retryOn5xx = true } = opts;
  let attempt = 0;
  for (;;) {
    try {
      const out = await requestOnce(url, opts);
      if (retryOn5xx && (out.status === 429 || out.status >= 500) && attempt < retries) {
        const wait = parseRetryAfter(out.headers['retry-after']) || 600 * 2 ** attempt;
        attempt++;
        await sleep(Math.min(wait, 8000));
        continue;
      }
      return out;
    } catch (e) {
      if (e.code === 'EBLOCKED' || e.message === 'Blocked host' || attempt >= retries) throw e;
      attempt++;
      await sleep(400 * 2 ** attempt);
    }
  }
}

function toError(res, url) {
  return new HttpError(`HTTP ${res.status} for ${url}`, {
    status: res.status,
    url,
    retryAfter: parseRetryAfter(res.headers['retry-after'] || res.headers['x-ratelimit-reset']),
    body: res.body && res.body.length < 2000 ? res.body.toString('utf8') : null,
  });
}

async function fetchText(url, opts = {}) {
  const res = await request(url, opts);
  if (res.status >= 400) throw toError(res, url);
  return res.body.toString('utf8');
}

async function fetchJSON(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers || {}) } });
  if (res.status >= 400) throw toError(res, url);
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new HttpError(`Invalid JSON from ${url}`, { status: res.status, url });
  }
}

async function fetchBuffer(url, opts = {}) {
  const res = await request(url, opts);
  return { buffer: res.body, status: res.status, contentType: res.headers['content-type'] || '', url: res.url, headers: res.headers };
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

module.exports = {
  HttpError, open, request, requestOnce, fetchText, fetchJSON, fetchBuffer,
  sleep, isPrivateHost, isPrivateIp, hostnameOf, parseRetryAfter, safeLookup,
};
