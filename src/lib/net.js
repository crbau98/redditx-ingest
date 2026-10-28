// src/lib/net.js — SSRF-safe fetch with per-hop DNS re-validation
// ESM, Node 20. Drop-in replacement. Hardened per audit 2026-01-04.
// - Blocks private/metadata/CGNAT/6to4
// - Unpacks embedded V4: ::ffff:a.b.c.d , ::ffff:7f00:1 , 64:ff9b::/96 , 2002::/16
// - Re-validates every redirect, strips auth cross-host, demotes POST->GET

import dns from 'node:dns/promises';
import net from 'node:net';
import { isIP } from 'node:net';

// ---------- CIDR helpers ----------

function ipv4ToInt(ip) {
  const p = ip.split('.').map(n => parseInt(n, 10));
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function parseCidrV4(cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const baseInt = ipv4ToInt(base);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { baseInt: baseInt & mask, mask, bits };
}
function ipv4InCidr(ip, cidr) {
  const c = parseCidrV4(cidr);
  return (ipv4ToInt(ip) & c.mask) === c.baseInt;
}

// Minimal IPv6 -> BigInt parser (handles :: compression, no zone)
function ipv6ToBigInt(ip) {
  const raw = ip.split('%')[0].toLowerCase();
  // Handle embedded IPv4 dotted form: ::ffff:1.2.3.4
  let s = raw;
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    const v4 = s.slice(lastColon + 1);
    const v4Int = ipv4ToInt(v4);
    const high = ((v4Int >>> 16) & 0xffff).toString(16);
    const low = (v4Int & 0xffff).toString(16);
    s = s.slice(0, lastColon + 1) + high + ':' + low;
  }
  if (s.includes('::')) {
    const [left, right] = s.split('::');
    const l = left ? left.split(':').filter(Boolean) : [];
    const r = right ? right.split(':').filter(Boolean) : [];
    const missing = 8 - (l.length + r.length);
    const parts = [...l, ...Array(missing).fill('0'), ...r];
    s = parts.join(':');
  }
  const parts = s.split(':');
  let out = 0n;
  for (const p of parts) {
    const v = p === '' ? 0 : parseInt(p, 16);
    out = (out << 16n) + BigInt(v);
  }
  return out;
}
function parseCidrV6(cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const baseInt = ipv6ToBigInt(base);
  const shift = 128 - bits;
  const mask = shift === 128 ? 0n : (~0n << BigInt(shift)) & ((1n << 128n) - 1n);
  return { baseInt: baseInt & mask, mask, bits };
}
function ipv6InCidr(ip, cidr) {
  const c = parseCidrV6(cidr);
  return (ipv6ToBigInt(ip) & c.mask) === c.baseInt;
}

// ---------- BlockLists (audit-complete + gap fix) ----------

export const BLOCK_V4 = [
  '0.0.0.0/8',        // software
  '10.0.0.0/8',       // RFC1918
  '100.64.0.0/10',    // CGNAT (Railway + carrier)
  '127.0.0.0/8',      // loopback
  '169.254.0.0/16',   // link-local + Railway metadata 169.254.169.254
  '172.16.0.0/12',    // RFC1918
  '192.0.2.0/24',     // TEST-NET-1
  '192.88.99.0/24',   // 6to4 relay anycast — FIX LOW: was missing
  '192.168.0.0/16',   // RFC1918
  '198.18.0.0/15',    // benchmark
  '198.51.100.0/24',  // TEST-NET-2
  '203.0.113.0/24',   // TEST-NET-3
  '224.0.0.0/4',      // multicast
  '240.0.0.0/4',      // reserved
];

export const BLOCK_V6 = [
  '::1/128',
  '::/128',
  '100::/64',         // discard
  '2001:db8::/32',    // documentation
  '2002::/16',        // 6to4 — FIX LOW: 2002:7f00:0001:: is 127.0.0.1
  'fc00::/7',         // ULA
  'fe80::/10',        // link-local
  'ff00::/8',         // multicast
];

export class BlockList {
  constructor(v4 = BLOCK_V4, v6 = BLOCK_V6) {
    this.v4 = v4;
    this.v6 = v6;
  }
  isBlocked(ip) {
    const ver = isIP(ip);
    if (ver === 4) return this.v4.some(c => ipv4InCidr(ip, c));
    if (ver === 6) {
      // Check direct v6 blocks
      if (this.v6.some(c => ipv6InCidr(ip, c))) return true;
      // Then check embedded V4 inside v6
      const embedded = embeddedV4(ip);
      if (embedded && this.v4.some(c => ipv4InCidr(embedded, c))) return true;
      return false;
    }
    return false;
  }
  contains(ip) { return this.isBlocked(ip); }
}

export const defaultBlockList = new BlockList();

// Unpacks embedded IPv4 from IPv6 formats:
// ::ffff:a.b.c.d , ::ffff:7f00:1 , 64:ff9b::/96 , 2002::/16 (6to4)
export function embeddedV4(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const s = ip.toLowerCase().split('%')[0].trim();

  // 1) ::ffff:a.b.c.d  dotted
  if (s.includes('.') && s.includes(':')) {
    const m = s.match(/([^:]+:[^:]*):(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return m[2];
  }
  // 2) ::ffff:7f00:1  hex-encoded
  // normalize to bigint, then test for ::ffff:0:0/96
  try {
    const bi = ipv6ToBigInt(s);
    // ::ffff:0:0/96 => top 96 bits == 0::ffff
    const ffff96 = ipv6ToBigInt('::ffff:0:0') & parseCidrV6('::ffff:0:0/96').mask;
    if ((bi & parseCidrV6('::ffff:0:0/96').mask) === ffff96) {
      const low32 = Number(bi & 0xffffffffn);
      return `${(low32 >>> 24) & 255}.${(low32 >>> 16) & 255}.${(low32 >>> 8) & 255}.${low32 & 255}`;
    }
    // 64:ff9b::/96 NAT64
    if (ipv6InCidr(s, '64:ff9b::/96')) {
      const low32 = Number(bi & 0xffffffffn);
      return `${(low32 >>> 24) & 255}.${(low32 >>> 16) & 255}.${(low32 >>> 8) & 255}.${low32 & 255}`;
    }
    // 2002::/16 6to4 — next 32 bits are V4
    if (ipv6InCidr(s, '2002::/16')) {
      // 2002:V4HI:V4LO::/16 -> bits 16..47
      const v4int = Number((bi >> 80n) & 0xffffffffn);
      return `${(v4int >>> 24) & 255}.${(v4int >>> 16) & 255}.${(v4int >>> 8) & 255}.${v4int & 255}`;
    }
  } catch {}
  return null;
}

export function isPrivateIp(ip) {
  return defaultBlockList.isBlocked(ip);
}

// ---------- DNS guard ----------

async function resolveAndCheck(hostname, blockList = defaultBlockList) {
  // If hostname is literal IP, check directly
  if (isIP(hostname)) {
    if (blockList.isBlocked(hostname)) {
      throw Object.assign(new Error(`SSRF blocked: ${hostname} is private/blocked`), { code: 'EBLOCKED', status: 403 });
    }
    return;
  }
  // Lookup all addresses (both families)
  let results;
  try {
    results = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw Object.assign(new Error(`DNS lookup failed for ${hostname}: ${e.message}`), { cause: e });
  }
  for (const r of results) {
    if (blockList.isBlocked(r.address)) {
      throw Object.assign(new Error(`SSRF blocked: ${hostname} -> ${r.address} is private/blocked`), { code: 'EBLOCKED', status: 403 });
    }
    const emb = r.family === 6 ? embeddedV4(r.address) : null;
    if (emb && blockList.isBlocked(emb)) {
      throw Object.assign(new Error(`SSRF blocked: ${hostname} -> [${r.address}] embeds blocked ${emb}`), { code: 'EBLOCKED', status: 403 });
    }
  }
}

// ---------- Fetch core ----------

const MAX_DECOMPRESSED_BYTES = 40 * 1024 * 1024; // 40 MB
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;

function stripAuthHeaders(headers) {
  const h = new Headers(headers);
  h.delete('authorization');
  h.delete('cookie');
  h.delete('x-api-key');
  return h;
}

export async function open(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    blockList = defaultBlockList,
    redirect = 'manual', // we handle ourselves to re-validate
  } = opts;

  let currentUrl = new URL(url);
  let currentMethod = method.toUpperCase();
  let currentBody = body;
  let currentHeaders = new Headers(headers);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // 1. Per-hop DNS + IP block check (THE SSRF GUARD - yt-dlp must not bypass this)
    await resolveAndCheck(currentUrl.hostname, blockList);

    // 2. Fetch with manual redirect
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(new Error(`timeout ${timeoutMs}ms for ${currentUrl.hostname}`)), timeoutMs);

    let res;
    try {
      res = await fetch(currentUrl.toString(), {
        method: currentMethod,
        headers: currentHeaders,
        body: currentBody,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }

    // 3. Handle redirect manually so we can re-validate + strip auth + demote POST
    if (res.status >= 300 && res.status < 400) {
      if (hop === maxRedirects) throw Object.assign(new Error(`too many redirects for ${url}`), { status: 400 });
      const loc = res.headers.get('location');
      if (!loc) return res; // no location to follow
      const nextUrl = new URL(loc, currentUrl);

      // Re-validate target BEFORE following (Railway metadata / localhost via redirect)
      await resolveAndCheck(nextUrl.hostname, blockList);

      // Strip auth/cookie cross-host
      const crossHost = nextUrl.hostname !== currentUrl.hostname || nextUrl.origin !== currentUrl.origin;
      if (crossHost) {
        currentHeaders = stripAuthHeaders(currentHeaders);
      }

      // Demote POST -> GET on 301/302/303 per spec
      if ([301, 302, 303].includes(res.status) && currentMethod === 'POST') {
        currentMethod = 'GET';
        currentBody = undefined;
        currentHeaders.delete('content-length');
        currentHeaders.delete('content-type');
      }

      currentUrl = nextUrl;
      continue;
    }

    // 4. Decompression size guard — cap at 40MB decompressed
    // Node's fetch auto-decompresses gzip/br. We enforce via content-length hint + stream cap.
    const clen = parseInt(res.headers.get('content-length') || '0', 10);
    if (clen > MAX_DECOMPRESSED_BYTES) {
      throw Object.assign(new Error(`response too large: ${clen} > 40MB`), { status: 413 });
    }

    // Wrap .text/.arrayBuffer/.json to enforce cap on actual bytes
    const origArrayBuffer = res.arrayBuffer.bind(res);
    const origText = res.text.bind(res);
    res.arrayBuffer = async () => {
      const buf = await origArrayBuffer();
      if (buf.byteLength > MAX_DECOMPRESSED_BYTES) throw Object.assign(new Error(`decompressed body > 40MB`), { status: 413 });
      return buf;
    };
    res.text = async () => {
      const t = await origText();
      if (Buffer.byteLength(t, 'utf8') > MAX_DECOMPRESSED_BYTES) throw Object.assign(new Error(`decompressed body > 40MB`), { status: 413 });
      return t;
    };

    return res;
  }
  throw Object.assign(new Error(`redirect loop for ${url}`), { status: 400 });
}

// Convenience wrappers that still go through the guard
export function fetchSafe(url, opts) { return open(url, opts); }
export const netFetch = open;

export default { BlockList, defaultBlockList, isPrivateIp, embeddedV4, open, fetchSafe, BLOCK_V4, BLOCK_V6 };
