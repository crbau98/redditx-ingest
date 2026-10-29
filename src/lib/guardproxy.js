'use strict';
/**
 * Guard proxy: a small HTTP proxy on 127.0.0.1 that every request of PRISM's Playwright browser goes through.
 *
 * A browser does not use lib/net.js, so without this a page could send it anywhere: a redirect hop to the cloud metadata
 * address, an <img> on 10.0.0.5, a fetch() to a name that resolves to 127.0.0.1, a WebSocket into the LAN. Here every
 * connection - page loads, redirect hops, sub-resources, XHR, workers, WebSockets (all of which reach the proxy, because
 * Chromium is started with loopback NOT exempt from the proxy) - is checked before anything is sent:
 *
 *   - literal private / loopback / link-local addresses and local names are refused;
 *   - names are resolved HERE and the connection is made to the validated address itself, so a name that resolves to a
 *     private address is refused and the browser cannot be handed a different answer afterwards (no rebinding window);
 *   - leak sites, paywalled hosts and takedown hosts are refused.
 *
 * It listens on loopback only and demands a per-process random credential, so nothing else on the host can use it.
 * HTTPS goes through CONNECT and stays end-to-end encrypted: the proxy sees host names, never content.
 */
const crypto = require('crypto');
const http = require('http');
const nodeNet = require('net');
const config = require('../config');
const net = require('./net');
const leaks = require('./leaks');
const takedowns = require('./takedowns');
const { isPaywalledHost } = require('./brave');

let server = null;
let starting = null;
const creds = { username: 'prism', password: crypto.randomBytes(18).toString('base64url') };
const blocked = []; // recent refusals, newest last: {at, host, reason}
const BLOCK_LOG = 200;

function refuse(host, reason) {
  blocked.push({ at: Date.now(), host, reason });
  if (blocked.length > BLOCK_LOG) blocked.shift();
}

const testAllow = (host) => (config.playwright.testAllowHosts || []).includes(String(host).toLowerCase()); // tests only

/** Content policy on a host (and, for plain HTTP, the full URL). @returns {string|null} why it is refused */
function policy(host, href) {
  const url = href || `https://${host}/`;
  if (leaks.isLeakUrl(url)) return 'leak site';
  if (isPaywalledHost(url)) return 'paywalled host';
  if (takedowns.checkUrl(url)) return 'takedown';
  return null;
}

/** Resolve and validate a destination. @returns {Promise<string>} the address to connect to */
function resolve(host) {
  const h = String(host).replace(/^\[|\]$/g, '');
  if (testAllow(h)) return Promise.resolve(h === 'localhost' ? '127.0.0.1' : h);
  if (net.isPrivateHost(h)) return Promise.reject(Object.assign(new Error(`${h} is a private or internal host`), { code: 'EBLOCKED' }));
  if (nodeNet.isIP(h)) {
    if (!config.allowPrivateHosts && net.isPrivateIp(h)) return Promise.reject(Object.assign(new Error(`${h} is a private address`), { code: 'EBLOCKED' }));
    return Promise.resolve(h);
  }
  return new Promise((ok, fail) => net.safeLookup(h, {}, (err, address) => (err ? fail(err) : ok(address))));
}

function authorized(req) {
  const v = String(req.headers['proxy-authorization'] || '');
  const want = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
  return v.length === want.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(want));
}

/** HTTPS and WebSockets: CONNECT host:port, validated, then a raw tunnel to the validated address. */
async function onConnect(req, socket, head) {
  socket.on('error', () => {});
  const deny = (code, reason, host) => { if (host) refuse(host, reason); socket.end(`HTTP/1.1 ${code} ${code === 407 ? 'Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="prism"' : 'Forbidden'}\r\nX-Prism-Refused: ${String(reason).replace(/[\r\n]/g, ' ')}\r\n\r\n`); };
  if (!authorized(req)) return deny(407, 'no credentials');
  const m = String(req.url || '').match(/^\[?([^\]]+?)\]?:(\d{1,5})$/);
  if (!m) return deny(403, 'bad CONNECT target');
  const host = m[1].toLowerCase(); const port = Number(m[2]);
  const why = policy(host);
  if (why) return deny(403, why, host);
  let address;
  try { address = await resolve(host); } catch (e) { return deny(403, e.message, host); }
  const upstream = nodeNet.connect({ host: address, port });
  upstream.setTimeout(60000, () => upstream.destroy());
  upstream.once('connect', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}

/** Plain HTTP: absolute-URI requests, validated, forwarded to the validated address. */
async function onRequest(req, res) {
  const deny = (code, reason, host) => { if (host) refuse(host, reason); res.writeHead(code, { 'content-type': 'text/plain', 'x-prism-refused': String(reason).replace(/[\r\n]/g, ' '), ...(code === 407 ? { 'proxy-authenticate': 'Basic realm="prism"' } : {}) }); res.end(`refused: ${reason}`); };
  if (!authorized(req)) return deny(407, 'no credentials');
  let u;
  try { u = new URL(req.url); } catch { return deny(400, 'not a proxy request'); }
  if (u.protocol !== 'http:') return deny(400, `unsupported scheme ${u.protocol}`);
  const host = u.hostname.toLowerCase();
  const why = policy(host, u.href);
  if (why) return deny(403, why, host);
  let address;
  try { address = await resolve(host); } catch (e) { return deny(403, e.message, host); }
  const headers = { ...req.headers };
  delete headers['proxy-authorization']; delete headers['proxy-connection'];
  const up = http.request({ host: address, port: u.port || 80, method: req.method, path: `${u.pathname}${u.search}`, headers, setHost: false, timeout: 60000 }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
}

/** Start (once) and return {server, username, password} for Playwright's `proxy` option. */
function start() {
  if (server) return Promise.resolve(info());
  if (starting) return starting;
  starting = new Promise((ok, fail) => {
    const s = http.createServer(onRequest);
    s.on('connect', onConnect);
    s.on('clientError', (err, socket) => socket.destroy());
    s.once('error', (e) => { starting = null; fail(e); });
    s.listen(0, '127.0.0.1', () => { server = s; s.unref(); starting = null; ok(info()); });
  });
  return starting;
}
function info() { return { server: `http://127.0.0.1:${server.address().port}`, username: creds.username, password: creds.password }; }
function stop() { return new Promise((r) => { if (!server) return r(); const s = server; server = null; s.close(() => r()); }); }
/** Refusals since `since` (ms timestamp). */
const refusedSince = (since) => blocked.filter((b) => b.at >= since);

module.exports = { start, stop, refusedSince, _policy: policy, _resolve: resolve };
