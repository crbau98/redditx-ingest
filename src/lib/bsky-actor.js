'use strict';
/**
 * Bluesky actor strings the AppView accepts: a DID (did:plc:… / did:web:…) or a domain handle
 * ("name.bsky.social", "name.example.com"). Anything else fails the request with HTTP 400
 * ("Invalid AT identifier"), and getProfiles takes a whole batch down with it, so one bare word
 * with an underscore costs the other 24 handles in the batch.
 *
 * normalizeBskyActor returns the string the AppView will accept, or null when no valid actor can be
 * made from the input. Kept here (not in engine/) so the source adapters can use it without importing
 * the engine.
 */
const DID = /^did:(plc|web):[A-Za-z0-9._:%-]+$/;
const BARE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * @param {string|null|undefined} raw a handle as stored or typed ("@Trick", "anonanimeme", "x.bsky.social", "did:plc:…")
 * @returns {string|null}
 */
function normalizeBskyActor(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/^@+/, '');
  if (DID.test(s)) return s; // a DID is case-sensitive: kept as written
  s = s.toLowerCase();
  if (!s.includes('.')) {
    // A bare name is a bsky.social handle when it is a legal label on its own (3..63 characters).
    if (s.length < 3 || s.length > 63 || !BARE.test(s)) return null;
    s = `${s}.bsky.social`;
  }
  return DOMAIN.test(s) ? s : null;
}

module.exports = { normalizeBskyActor };
