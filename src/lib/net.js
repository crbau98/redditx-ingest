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
const tls = require('tls');
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
function isPrivateHost(hostname, { allowInternal = false } = {}) {
  if (config.allowPrivateHosts) return false;
  let h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (allowInternal && isInternalHost(h)) return false; // only for explicit, first-hop callers (see open())
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  // Numeric forms like 2130706433 or 0x7f.1 are normalised by WHATWG URL to
  // dotted quads before we get here, so a plain name is all that is left.
  return false;
}

/** Exact hostnames an operator vouched for (INTERNAL_HOSTS, e.g. a SearXNG container on the compose network). */
function isInternalHost(h) { return (config.internalHosts || []).includes(String(h || '').toLowerCase()); }

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

/**
 * Lookup for the dedicated internal agent: it resolves ONLY names the operator vouched for in INTERNAL_HOSTS (a SearXNG
 * container on the compose network) and refuses everything else, so even a mistake upstream cannot turn it into a
 * general private-network door. It is used only when a caller passes `allowInternal` and only for the first hop.
 */
function internalLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (!isInternalHost(hostname)) { const e = new Error(`Blocked host: ${hostname} is not an internal host`); e.code = 'EBLOCKED'; return callback(e); }
  return dns.lookup(hostname, options || {}, callback);
}

const agentOpts = { keepAlive: true, maxSockets: 32, timeout: 30000, lookup: safeLookup };
const internalAgentOpts = { keepAlive: true, maxSockets: 8, timeout: 30000, lookup: internalLookup };
const internalHttpAgent = new http.Agent(internalAgentOpts);
const internalHttpsAgent = new https.Agent(internalAgentOpts);
const httpAgent = new http.Agent(agentOpts);
const httpsAgent = new https.Agent(agentOpts);

/**
 * Optional egress through an HTTP CONNECT proxy (OUTBOUND_PROXY=http://host:port), for networks that only allow
 * outbound traffic via a proxy. Trade-off, stated plainly: the proxy resolves DNS, so the resolved-address check in
 * safeLookup cannot run for these connections; literal-IP and local-name checks still apply, and the proxy
 * itself is what keeps private ranges unreachable. Off by default.
 */
class ProxyTunnelAgent extends https.Agent {
  constructor(proxyUrl, opts) { super(opts); this.proxy = new URL(proxyUrl); }
  createConnection(options, cb) {
    const host = options.host || options.hostname; const port = options.port || 443;
    // Keep the SSRF guarantee: the proxy would resolve the name itself, so resolve it HERE first and refuse private
    // answers. If local DNS cannot answer, the destination cannot be validated: refuse too, unless the operator has
    // declared that their proxy does the resolving (OUTBOUND_PROXY_TRUST_DNS=true, e.g. split-horizon DNS).
    // Residual risk, stated plainly: the proxy re-resolves, so a rebinding DNS server could still answer differently
    // the second time; the proxy should also deny private ranges.
    if (!config.allowPrivateHosts && !net.isIP(host)) {
      dns.lookup(host, { all: true }, (err, addrs) => { // (not returned: Node would mistake the lookup request for a socket)
        if (err) {
          if (config.outboundProxyTrustDns) return this.tunnel(host, port, options, cb);
          const e = new Error(`Blocked host: cannot validate ${host} (local DNS failed: ${err.code || err.message}); set OUTBOUND_PROXY_TRUST_DNS=true if the proxy resolves names for you`);
          e.code = 'EBLOCKED'; return cb(e);
        }
        if ((addrs || []).some((a) => isPrivateIp(a.address))) {
          const e = new Error(`Blocked host: ${host} resolves to a private address`); e.code = 'EBLOCKED'; return cb(e);
        }
        return this.tunnel(host, port, options, cb);
      });
      return undefined;
    }
    this.tunnel(host, port, options, cb);
    return undefined;
  }
  tunnel(host, port, options, cb) {
    const headers = { host: `${host}:${port}` };
    if (this.proxy.username) headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`).toString('base64')}`;
    const req = http.request({ host: this.proxy.hostname, port: this.proxy.port || 80, method: 'CONNECT', path: `${host}:${port}`, headers, agent: false, timeout: 15000 });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return cb(Object.assign(new Error(`proxy refused CONNECT to ${host} (HTTP ${res.statusCode})`), { code: 'EPROXY', status: res.statusCode })); }
      const secure = tls.connect({ socket, servername: options.servername || host, ALPNProtocols: ['http/1.1'] });
      secure.once('secureConnect', () => cb(null, secure));
      secure.once('error', cb);
    });
    req.once('timeout', () => req.destroy(Object.assign(new Error('proxy CONNECT timed out'), { code: 'ETIMEDOUT' })));
    req.once('error', cb);
    req.end();
  }
}
const proxiedHttpsAgent = config.outboundProxy ? new ProxyTunnelAgent(config.outboundProxy, { keepAlive: true, maxSockets: 32, timeout: 30000 }) : null;

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

// Decompressed bodies are capped too (the wire-size cap alone does not stop a tiny gzip bomb).
const MAX_DECODED = 40 * 1024 * 1024;
function decode(res, buf, url) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  const zopts = { maxOutputLength: MAX_DECODED };
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, zopts);
    if (enc === 'deflate') {
      // Some servers send raw deflate (no zlib header) under Content-Encoding: deflate.
      try { return zlib.inflateSync(buf, zopts); } catch (e) { if (e.code === 'ERR_BUFFER_TOO_LARGE') throw e; return zlib.inflateRawSync(buf, zopts); }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buf, zopts);
  } catch (e) {
    if (e.code === 'ERR_BUFFER_TOO_LARGE') throw new HttpError('Response too large (decompressed)', { url, status: res.statusCode });
    /* otherwise fall through with raw bytes */
  }
  return buf;
}

/**
 * Open a validated connection and hand back the raw response (not yet
 * consumed). Follows redirects itself so every hop is re-validated.
 */
function open(url, { method: method0 = 'GET', headers = {}, timeout = 20000, maxRedirects = 5, body: body0, allowInternal = false } = {}) {
  return new Promise((resolve, reject) => {
    let hops = 0;
    let method = method0;
    let body = body0;
    const go = (target, hdrs) => {
      let parsed;
      try { parsed = new URL(target); } catch (e) { return reject(new HttpError('Invalid URL', { url: String(target) })); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reject(new HttpError('Unsupported protocol', { url: target }));
      }
      // `allowInternal` is an explicit grant from the caller (the SearXNG client) and holds for the FIRST hop only: a redirect,
      // however it was triggered by remote content, can never land on an internal host.
      const internal = allowInternal && hops === 0 && isInternalHost(parsed.hostname);
      if (isPrivateHost(parsed.hostname, { allowInternal: internal })) {
        return reject(new HttpError('Blocked host', { url: target, code: 'EBLOCKED' }));
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(parsed, {
        method,
        headers: hdrs,
        agent: internal ? (parsed.protocol === 'https:' ? internalHttpsAgent : internalHttpAgent) : (parsed.protocol === 'https:' ? (proxiedHttpsAgent || httpsAgent) : httpAgent),
      }, (res) => {
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
          res.resume();
          if (hops >= maxRedirects) return reject(new HttpError('Too many redirects', { url: target }));
          hops++;
          const next = new URL(loc, parsed);
          const nextHdrs = { ...hdrs };
          // 301/302/303 after a POST are followed as GET without the body (browser/curl behaviour).
          if (method === 'POST' && [301, 302, 303].includes(res.statusCode)) {
            method = 'GET'; body = undefined;
            delete nextHdrs['content-type']; delete nextHdrs['content-length'];
          }
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
  const { maxBytes = 3_000_000, timeout = 20000 } = opts;
  const startedAt = Date.now();
  const { res, req } = await open(url, opts);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // The socket timeout only fires on silence; a server that drips one byte at a time must not hold a feed run forever.
    const deadline = setTimeout(() => { req.destroy(); reject(new HttpError('Timeout (body too slow)', { url, status: res.statusCode })); },
      Math.max(5000, Math.max(timeout * 3, 60000) - (Date.now() - startedAt)));
    deadline.unref();
    res.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        clearTimeout(deadline);
        reject(new HttpError('Response too large', { url, status: res.statusCode }));
        return;
      }
      chunks.push(c);
    });
    res.on('error', (e) => { clearTimeout(deadline); reject(new HttpError(e.message, { url, code: e.code || '' })); });
    res.on('aborted', () => { clearTimeout(deadline); reject(new HttpError('Connection aborted', { url })); });
    res.on('end', () => {
      clearTimeout(deadline);
      try {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          url: res.finalUrl || url,
          body: decode(res, Buffer.concat(chunks), url),
        });
      } catch (e) { reject(e); }
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
        // A long Retry-After is the server asking us to go away: hand the 429 back so the per-platform
        // limiter can cool down, instead of retrying into it after 8 s (which only deepens the throttle).
        if (out.status === 429 && wait > 10000) return out;
        attempt++;
        await sleep(Math.min(wait, 8000));
        continue;
      }
      return out;
    } catch (e) {
      if (e.code === 'EBLOCKED' || e.message === 'Blocked host' || /^Response too large/.test(e.message) || attempt >= retries) throw e;
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
