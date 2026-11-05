'use strict';
/**
 * An adult site may put an age/consent interstitial in front of its pages ("Before using this site, please
 * verify you are 18 or older and please accept our cookies policy, terms of use and privacy policy"). PRISM has
 * its own age gate (src/middleware/age.js), so the visitor is already confirmed as an adult; the interstitial is
 * the site's own way of recording that, and the site's own button simply re-requests the page with a confirmation
 * parameter (JustFor.Fans: ?TermsAgree=yes, which makes the site set its `cookiesAccepted` cookie).
 *
 * Owner decision 2026-11-05: pass it. This is NOT an access-control bypass. Nothing behind a paywall, a login
 * or an identity check is reached by it - JustFor.Fans' own performer verification (ID documents) stays out of
 * reach - and no credential, cookie or session belonging to anyone is ever reused.
 *
 *   isGateUrl(url)          true when the URL is an age/consent interstitial
 *   confirmUrl(url)         the same URL with the site's confirmation parameter
 *   confirmFor(req, final, html)  the URL to read instead, or null when there is no gate to pass
 */

/** URL shapes of an age/consent interstitial. */
const GATE_PATH = /\/(?:age[-_]?verify|verify[-_]?age|age[-_]?gate|agecheck)(?:\.php)?/i;
/** Page text of an interstitial that answers the request itself. */
const GATE_TEXT = /verify you are 18 or older|cookieAcceptBarConfirm|are you 18 or older/i;
/** The confirmation the site's own button uses. */
const CONFIRM_PARAMS = [{ name: 'TermsAgree', value: 'yes' }];

function isGateUrl(url) {
  const s = String(url || '');
  return GATE_PATH.test(s) || /[?&](?:age|ageverif\w*)=/i.test(s);
}

function confirmUrl(url) {
  try {
    const u = new URL(url);
    for (const p of CONFIRM_PARAMS) u.searchParams.set(p.name, p.value);
    return u.toString();
  } catch { return null; }
}

/**
 * The URL to read when a request for `requested` ended up on an age/consent interstitial.
 * @param {string} requested the URL we asked for
 * @param {string} final the URL we ended up on, after redirects
 * @param {string} html the page we got
 * @returns {string|null} the confirmed URL, or null when there is no gate to pass
 */
function confirmFor(requested, final, html) {
  const onGate = isGateUrl(final) || GATE_TEXT.test(String(html || ''));
  if (!onGate) return null;
  const u = confirmUrl(final || requested);
  if (!u) return null;
  const ask = String(requested || '');
  // Already confirmed? Nothing to do.
  if (ask && u === ask) return null;
  return u;
}

module.exports = { isGateUrl, confirmUrl, confirmFor, GATE_PATH, GATE_TEXT };
