'use strict';
/**
 * The key a client is limited, counted and capped by.
 *
 * express-rate-limit 7.5 keys on the exact `req.ip`. One IPv6 subscriber is routinely handed a whole /64 (2^64 addresses), so a
 * per-address limit, a per-address like/view dedupe or a per-address stream cap could be dodged by rotating the low 64 bits.
 * IPv6 clients are therefore keyed by their /64; IPv4 (including IPv4-mapped IPv6) stays one address.
 */
const net = require('net');

function ipKey(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (!s) return 'unknown';
  const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone); // fe80::1%en0
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (net.isIPv4(s)) return s;
  if (!net.isIPv6(s)) return s;
  // expand "::" and keep the first four 16-bit groups (the /64), as the Node address library would
  let [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  if (tail === undefined) { /* no "::": all eight groups are in head */ } else while (h.length + t.length < 8) h.push('0');
  const groups = [...h, ...t].slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, ''));
  // an embedded IPv4 tail ("::1.2.3.4") only appears past the first four groups for a /64 key: nothing to keep
  return `${groups.join(':')}::/64`;
}

/** express-rate-limit `keyGenerator`. */
const keyGenerator = (req) => ipKey(req.ip);

module.exports = { ipKey, keyGenerator };
