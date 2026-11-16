'use strict';
/**
 * The key a client is limited, counted and capped by.
 *
 * express-rate-limit 7.5 keys on the exact `req.ip`. One IPv6 subscriber is routinely handed a whole /64 (2^64 addresses), so a
 * per-address limit, a per-address like/view dedupe or a per-address stream cap could be dodged by rotating the low 64 bits.
 * IPv6 clients are therefore keyed by their /64; IPv4 (including IPv4-mapped IPv6) stays one address.
 */
const net = require('net');

/** The eight 16-bit groups of an IPv6 address (zone dropped, "::" expanded, a dotted IPv4 tail turned into two groups), or null. */
function groupsOf(s) {
  let str = s;
  const dotted = str.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!net.isIPv4(dotted[2])) return null;
    const o = dotted[2].split('.').map(Number);
    str = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let all;
  if (halves.length === 1) all = head;
  else { const fill = 8 - head.length - tail.length; if (fill < 1) return null; all = [...head, ...Array(fill).fill('0'), ...tail]; }
  if (all.length !== 8) return null;
  const g = all.map((x) => parseInt(x || '0', 16));
  return g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff) ? null : g;
}

function ipKey(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (!s) return 'unknown';
  const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone); // fe80::1%en0
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return s;
  const g = groupsOf(s);
  if (!g) return s;
  // IPv4-mapped (::ffff:a.b.c.d, ::ffff:102:304, 0:0:0:0:0:ffff:1.2.3.4 ...): the client is the IPv4 address inside
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/** express-rate-limit `keyGenerator`. */
const keyGenerator = (req) => ipKey(req.ip);

module.exports = { ipKey, keyGenerator };
