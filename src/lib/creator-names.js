'use strict';
/**
 * A creator row's handle and display name the right way round.
 *
 * Some paths name a creator from a page or feed label ("Dante Colle") and take the display name from the item's
 * author ("dantecolle.bsky.social"), which stores them swapped: the site then shows "@Dante Colle". A handle never
 * has a space; when the handle has one and the display name looks like a platform handle, the two are swapped.
 * Anything less clear is left exactly as it is.
 */

/** Looks like a platform handle: no spaces, and a dot, underscore or digit, or all lowercase ("dantecolle.bsky.social"). */
function looksLikeHandle(s) {
  const t = String(s || '').trim().replace(/^@/, '');
  if (!t || /\s/.test(t) || t.length > 80 || !/^[\w.-]+$/u.test(t)) return false;
  return /[._\d]/.test(t) || t === t.toLowerCase();
}

/** Looks like a person's name, not a handle: it has a space. */
const looksLikeName = (s) => /\S\s+\S/.test(String(s || '').trim());

/** { handle, displayName } with a swapped pair put right; any other pair is returned unchanged. */
function orderNames(handle, displayName) {
  if (looksLikeName(handle) && looksLikeHandle(displayName)) {
    return { handle: String(displayName).trim().replace(/^@/, ''), displayName: String(handle).trim(), swapped: true };
  }
  return { handle, displayName, swapped: false };
}

module.exports = { orderNames, looksLikeHandle, looksLikeName };
