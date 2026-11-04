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
];

const onHost = (h, want) => h === want || h.endsWith(`.${want}`);

/** The host a feed target names: "user@host" for Mastodon/Misskey, a URL's hostname for web-style targets. */
function hostOfTarget(target) {
  const t = String(target || '').trim().replace(/^@/, '');
  if (!/^https?:/i.test(t)) {
    const at = t.lastIndexOf('@');
    if (at > 0) return t.slice(at + 1).toLowerCase().replace(/\/.*$/, '');
    return '';
  }
  try { return new URL(t).hostname.toLowerCase(); } catch { return ''; }
}

/** Why a feed on this platform/target must stay disabled, or null when it is fine. */
function deadReason(platform, target) {
  const host = hostOfTarget(target);
  if (!host) return null;
  const d = DEAD.find((x) => onHost(host, x.host));
  if (d) return d.reason;
  const w = WRONG_PLATFORM.find((x) => x.platform === platform && onHost(host, x.host));
  return w ? w.reason : null;
}

module.exports = { DEAD, WRONG_PLATFORM, hostOfTarget, deadReason };
