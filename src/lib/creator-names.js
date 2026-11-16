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

/**
 * A handle as it is stored: Unicode-normalised (NFC), without the zero-width space (U+200B), word joiner (U+2060), BOM (U+FEFF) and
 * the bidi controls, trimmed. ZWJ / ZWNJ / variation selectors stay: they are part of emoji sequences and of Persian and Indic words.
 * "Alice", "Alice " and "Alice\u200b" were three different rows; case is left alone (it is how the platform shows the name, and
 * lookups are case-insensitive), and two people who share a handle are never merged by this.
 */
const INVISIBLE = /[\u200B\u2060\uFEFF\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
function cleanHandle(h) {
  if (h === null || h === undefined) return h;
  const out = String(h).normalize('NFC').replace(INVISIBLE, '').trim();
  // nothing but joiners, variation selectors, marks and other format characters is not a name: it is empty
  return /^[\p{Cf}\p{Mn}\p{Me}\p{Z}\p{Cc}\uFE00-\uFE0F]*$/u.test(out) ? '' : out;
}

module.exports = { cleanHandle, orderNames, looksLikeHandle, looksLikeName };
