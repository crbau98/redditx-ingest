'use strict';
/**
 * Hosts that feeds must not be created or re-enabled on, because the host is gone or is not the platform the row says.
 * Evidence is recorded per host (checked 2026-11-04). repo.feeds.upsert creates such feeds disabled, and seed derivation
 * skips them, so a seed or a discovered link cannot turn them back on.
 *
 * This is a source-health guard, not a safety gate: it never blocks content that is already in the library.
 */
const DEAD = [
  { host: 'nsfw.lgbt', reason: 'parked: HTTP 301 to expireddomains.com' },
  { host: 'h5q.net', reason: 'DNS does not resolve (ENOTFOUND)' },
  { host: 'mastodon.lol', reason: 'DNS does not resolve (ENOTFOUND)' },
];
/** Platform rows that the host does not speak: gayfr.social is a Mastodon server, so Misskey rows there always 404. */
const WRONG_PLATFORM = [
  { platform: 'misskey', host: 'gayfr.social', reason: 'gayfr.social is Mastodon: /api/users/show is 404' },
  { platform: 'mastodon', host: 'fanhub.com', reason: 'fanhub.com is not a Mastodon server (/api/v1/accounts/lookup returns HTML)' },
  { platform: 'mastodon', host: 'theb.co', reason: 'theb.co is not a Mastodon server (/api/v1/accounts/lookup returns HTML)' },
  { platform: 'peertube', host: 'xxxerome.com', reason: 'xxxerome.com is not a PeerTube server' },
  { platform: 'peertube', host: 'onlyfaphouse.com', reason: 'onlyfaphouse.com is not a PeerTube server' },
];

/**
 * The host a feed target names, in one form, for every caller: lower case, no scheme, no "user@" (Mastodon/Misskey
 * "user@host" targets keep the host), no path, query or fragment, no port, no trailing dot. Accepts a scheme-less host
 * with or without a port or path, and a leading "@". Returns '' when there is no host.
 */
function normalizeHost(target) {
  let s = String(target || '').trim().toLowerCase().replace(/^@+/, '');
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // https:// and the like
  const at = s.lastIndexOf('@');                    // user@host and user:pass@host: keep the host
  if (at >= 0) s = s.slice(at + 1);
  s = s.replace(/[/?#].*$/, '');                    // path, query, fragment
  s = s.replace(/:\d*$/, '');                      // port (or a bare trailing colon)
  s = s.replace(/\.+$/, '');                        // trailing dot(s): "nsfw.lgbt." is "nsfw.lgbt"
  return s;
}

/** True when host is the wanted host or one of its sub-domains ("feed.nsfw.lgbt"), never a look-alike ("notnsfw.lgbt"). */
const onHost = (host, want) => host === want || host.endsWith(`.${want}`);

/** The normalised host of a feed target. Kept under this name: callers and tests use it. */
const hostOfTarget = (target) => normalizeHost(target);

/** Why a feed on this platform/target must stay disabled, or null when it is fine. Every enable path asks this. */
function deadReason(platform, target) {
  const host = normalizeHost(target);
  if (!host) return null;
  const d = DEAD.find((x) => onHost(host, x.host));
  if (d) return d.reason;
  const plat = String(platform || '').trim().toLowerCase();
  const w = WRONG_PLATFORM.find((x) => x.platform === plat && onHost(host, x.host));
  return w ? w.reason : null;
}

module.exports = { DEAD, WRONG_PLATFORM, normalizeHost, hostOfTarget, deadReason };
