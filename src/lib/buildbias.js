'use strict';
/**
 * Lean preference: a gentle RANKING bias, never a filter.
 *
 * The owner asked for lean / athletic men (fitness-model types) to surface more and bear /
 * dad-bod content less, without turning the body filter back on (it misjudged lean men and
 * hid nearly every creator — decision of 2026-11-02, still standing). So this module derives
 * a small multiplier for a picture's trending score instead:
 *
 *   1.3  clearly lean: fitness / gym / muscle wording, or a measured build score at or
 *        below 35 (physique: 0 = lean … 100 = very large)
 *   0.7  clearly heavy: the body filter's own heavy/older word list matches, or a measured
 *        score of 65 or more
 *   NULL neutral: everything else, unmeasured, ambiguous — ranks exactly as before
 *
 * Nobody is hidden and no feed is paused; rows only rank a little above or below where they
 * otherwise would. Words only, never a guess from a face — the same rule the body filter's
 * text check follows. The multiplier is stored per row (`media.lean_bias`) and folded into
 * the trending refresh; switching the preference off clears the stored biases again.
 */

/** Words that describe the lean / athletic build the owner wants to see more of. */
const LEAN_RE = new RegExp(`(^|[^a-z])(${[
  'fitness', 'gym', 'bodybuilder', 'muscle', 'muscles', 'muscular', 'abs', 'shredded', 'ripped',
  'jock', 'hunk', 'twink', 'twunk', 'athlete', 'athletic', 'swimmer', 'surfer', 'skater',
  'personal trainer', 'male model', 'fitness model', 'underwear model', 'sixpack', 'six pack',
].join('|')})([^a-z]|$)`, 'i');

const LEAN_BIAS = 1.3;
const HEAVY_BIAS = 0.7;
/** Measured heaviness at or below this counts as lean (the build:'fit' query filter uses 30). */
const LEAN_SCORE_MAX = 35;
/** Measured heaviness at or above this counts as heavy. */
const HEAVY_SCORE_MIN = 65;

/**
 * The bias for one picture. `measured` is the physique score when the model pass has one
 * (0..100; the -1 / 101 markers and null mean "not measured"), otherwise the words decide.
 * Returns the multiplier, or null when the row should stay neutral (stored as NULL).
 * `pref` false short-circuits to neutral: the preference is switched off.
 */
function biasFor(measured, texts, pref = true) {
  if (!pref) return null;
  if (typeof measured === 'number' && measured >= 0 && measured <= 100) {
    if (measured <= LEAN_SCORE_MAX) return LEAN_BIAS;
    if (measured >= HEAVY_SCORE_MIN) return HEAVY_BIAS;
    return null; // measured mid-range: neutral, nothing stored
  }
  const parts = (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === 'string' && t.trim());
  if (!parts.length) return null;
  if (LEAN_RE.test(parts.join(' '))) return LEAN_BIAS;
  try {
    if (require('./physique').textCheck(...parts).heavy) return HEAVY_BIAS;
  } catch { /* the physique module is unavailable in a stripped test env: words only then */ }
  return null;
}

module.exports = { biasFor, LEAN_BIAS, HEAVY_BIAS, LEAN_SCORE_MAX, HEAVY_SCORE_MIN };
