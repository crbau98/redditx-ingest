'use strict';
/**
 * "Which site is this address on?": the registrable domain of a URL's host, without a public-suffix database.
 *
 * Taking the last two labels conflates unrelated sites below a multi-label suffix (`images.foo.co.uk` and `cdn.bar.co.uk` would both
 * be `co.uk`) and below shared hosting / CDN suffixes (`a.github.io`, `d1.cloudfront.net`). So the suffix is taken first, from:
 *   - a list of common multi-label suffixes (country second levels, and popular shared-hosting and CDN domains where every customer
 *     is a different site), and
 *   - a rule for any other two-letter country code whose second label is short (co, com, org, net, gov, edu, ac, or, ne, go, ...).
 * It is deliberately conservative: an unknown multi-label suffix still falls back to two labels, and callers use this only to
 * decide that two addresses are the SAME site, where being too strict is harmless and being too loose is not.
 */
const MULTI = new Set([
  // country second levels
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'net.nz', 'co.za', 'org.za',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'co.in', 'net.in', 'org.in', 'com.cn', 'net.cn', 'org.cn',
  'com.br', 'net.br', 'org.br', 'com.mx', 'com.ar', 'com.tr', 'com.tw', 'com.hk', 'com.sg', 'com.my', 'com.ph', 'com.ua', 'co.il', 'co.id', 'co.th',
  // shared hosting / CDN / app platforms: each subdomain belongs to someone else
  'github.io', 'gitlab.io', 'blogspot.com', 'wordpress.com', 'tumblr.com', 'herokuapp.com', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev',
  'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'r2.dev', 'fly.dev', 'onrender.com',
  'glitch.me', 'repl.co', 'myshopify.com', 'weebly.com', 'wixsite.com', 'substack.com',
]);
// Object-storage and cloud endpoints where the tenant is a label BELOW a service/region part (`bucket.s3.us-east-1.amazonaws.com`,
// `acct.blob.core.windows.net`): the registrable domain would be the service itself (`s3.amazonaws.com`) and every customer would be
// one site, so on these the whole host is the site. (A path-style address, `s3.amazonaws.com/bucket/..`, keeps its tenant in the path,
// which this host-only rule cannot see.)
const WHOLE_HOST = ['amazonaws.com', 'amazonaws.com.cn', 'core.windows.net', 'digitaloceanspaces.com', 'backblazeb2.com', 'cloudflarestorage.com',
  'storage.googleapis.com', 'googleusercontent.com', 'wasabisys.com', 'linodeobjects.com'];
const SHORT_SECOND = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'ltd', 'plc', 'sch', 'nom', 'info', 'biz']);

/** The registrable domain of a host ("images.foo.co.uk" -> "foo.co.uk"), or null for an IP address or a name with no dot. */
function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || !h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':')) return null; // IPv4 / IPv6 / a bare name
  if (WHOLE_HOST.some((w) => h === w || h.endsWith(`.${w}`))) return h;
  const labels = h.split('.');
  const last2 = labels.slice(-2).join('.');
  let suffixLabels = 1;
  if (MULTI.has(last2)) suffixLabels = 2;
  else if (labels.length >= 3 && labels[labels.length - 1].length === 2 && SHORT_SECOND.has(labels[labels.length - 2])) suffixLabels = 2;
  return labels.length <= suffixLabels ? h : labels.slice(-(suffixLabels + 1)).join('.');
}

/** The site of an address (its registrable domain), or null when it has no usable host. */
function siteOf(url) {
  try { return registrableDomain(new URL(url).hostname); } catch { return null; }
}

module.exports = { registrableDomain, siteOf };
