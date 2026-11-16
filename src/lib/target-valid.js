'use strict';
/**
 * Shape checks a feed target must pass before a feed is created. They refuse the targets that only ever fail:
 * an empty handle (".bsky.social" from a blank name), a Bluesky actor the AppView rejects, and a PeerTube target that
 * is an encoded token or e-mail rather than "account@instance".
 * Returns a reason string, or null when the target is acceptable. Other platforms are not checked here.
 */
const { normalizeBskyActor } = require('./bsky-actor');

const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const PEERTUBE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function invalidTarget(spec) {
  const target = String((spec && spec.target) ?? '').trim();
  if (!target) return 'Empty account name';
  if (spec.platform === 'bluesky' && spec.kind === 'user') {
    if (!normalizeBskyActor(target)) return `"${target.slice(0, 60)}" is not a valid Bluesky handle or DID`;
  }
  if (spec.platform === 'peertube' && (spec.kind === 'user' || spec.kind === 'channel')) {
    const at = target.lastIndexOf('@');
    const name = at > 0 ? target.slice(0, at) : '';
    const host = at > 0 ? target.slice(at + 1) : '';
    if (!name || !host) return 'A PeerTube target is account@instance';
    if (!PEERTUBE_NAME.test(name) || !HOST.test(host)) return `"${target.slice(0, 60)}" is not a PeerTube account@instance`;
    // A long run of letters and digits with no separator is an encoded token, not an account name.
    if (name.length > 40 && !/[._-]/.test(name)) return 'That looks like an encoded token, not a PeerTube account';
  }
  return null;
}

module.exports = { invalidTarget };
