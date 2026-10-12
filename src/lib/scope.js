'use strict';
/**
 * Scope classifier: is this a post about / by a man?
 *
 * Feeds come in two trust levels:
 *   - trusted   (curated communities, creators an admin or the discovery
 *                pipeline already vouched for): only a clear *female* signal
 *                without any male signal excludes an item.
 *   - untrusted (open searches / hashtags): a positive male signal is required,
 *                otherwise the item goes to the review queue.
 */
const { normalize } = require('./safety');

const MALE = /\b(?:gay|male|males|men|man|guy|guys|dude|dudes|twinks?|bears?|otters?|jocks?|cocks?|dicks?|studs?|daddy|daddies|muscles?|muscular|hunks?|bros?|boys?|lads?|hung|bulges?|jockstraps?|m4m|m4a|m4f|m4t|bi|dilf|hubby|husband|boyfriend|bf|abs|pecs|beard|bearded)\b|[\[(]\s*m\s*[\])]/;
const FEMALE = /\b(?:pussy|pussies|boobs?|busty|lesbians?|milfs?|female|females|women|woman|girls?|tits|titties|breasts?|vagina|cunt|ladies|wife|girlfriend|f4m|f4f|f4a|f4t|mommy|shemale)\b|[\[(]\s*f\s*[\])]/;

/**
 * @returns {{scope: 'in'|'uncertain'|'excluded', male: boolean, female: boolean}}
 */
function classify(texts, { trusted = false } = {}) {
  const text = normalize([].concat(texts || []).flat(Infinity).filter(Boolean).join(' \n '));
  const male = MALE.test(text);
  const female = FEMALE.test(text);
  if (female && !male) return { scope: 'excluded', male, female };
  if (female && male) return { scope: trusted ? 'in' : 'uncertain', male, female };
  if (male || trusted) return { scope: 'in', male, female };
  return { scope: 'uncertain', male, female };
}

module.exports = { classify, MALE, FEMALE };
