'use strict';
/**
 * Discovery ranking, the pure part: how much each kind of signal is worth, how a candidate's signals add up to a score,
 * and how one new signal is merged into the ones a candidate already has. No database, no network, no settings: the I/O
 * around it (finding, storing, following candidates) stays in discovery.js, which re-exports these.
 *
 * identity / mention / cofollow / search: see the header of discovery.js.
 * similar: Bluesky lists the account among those most like a followed creator (per creator, max 4)
 * hangout: a community where several followed creators post (per creator, max 6)
 * ofconfirmed: the account links to the exact OnlyFans page we were looking for (same person, proven)
 * onlyfans: the account has the same handle as an OnlyFans page creators promote (likely the same person)
 * ai: Claude read the public name and bio and judged it an adult male creator (engine/ai.js triage).
 * A signal type with no weight (e.g. 'directory', a bare catalogue hit) adds nothing to the score.
 */
const WEIGHTS = { identity: 6, mention: 3, cofollow: 1.5, search: 2, similar: 2, hangout: 1.5, ofconfirmed: 8, onlyfans: 2, ai: 2, poster: 6, imagesearch: 3 };
const CAPS = { identity: 1, mention: 5, cofollow: 8, search: 3, similar: 4, hangout: 6, ofconfirmed: 1, onlyfans: 1, ai: 1, poster: 1, imagesearch: 2 };
function scoreOf(signals, scope) {
  let s = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) s += w * Math.min((signals[k] || []).length, CAPS[k]);
  const pop = Number(signals.popularity) || 0;
  if (pop >= 100) s += Math.min(3, Math.log10(pop) - 1);
  if (scope === 'in') s += 2;
  if (scope === 'excluded') s -= 20;
  return Math.round(s * 10) / 10;
}

function describeSignals(sig) {
  return Object.entries(sig).filter(([k, v]) => WEIGHTS[k] && v.length).map(([k, v]) => `${v.length} ${k}${v.length === 1 ? '' : 's'}`).join(', ');
}

/**
 * One new signal merged into a candidate's existing signals (a new object; the input is not changed).
 * Returns null when the signal must not be recorded: an OnlyFans guess by handle once the account is confirmed.
 */
function mergeSignal(prev, type, value, meta = {}) {
  const signals = { ...(prev || {}) };
  // proof that an account is the creator behind an OnlyFans page supersedes the guess from the handle alone
  if (type === 'ofconfirmed' && signals.onlyfans) delete signals.onlyfans;
  if (type === 'onlyfans' && (signals.ofconfirmed || []).length) return null;
  const list = new Set(signals[type] || []);
  if (value) list.add(String(value).slice(0, 120));
  signals[type] = [...list].slice(0, 25);
  if (meta.ofSources) signals.ofsrc = Math.max(Number(signals.ofsrc) || 0, Number(meta.ofSources) || 0);
  if (type === 'ofconfirmed') signals.ofsrc = Math.max(Number(signals.ofsrc) || 0, 1);
  if (meta.popularity) signals.popularity = Math.max(Number(signals.popularity) || 0, Math.round(Number(meta.popularity)) || 0);
  return signals;
}

module.exports = { WEIGHTS, CAPS, scoreOf, describeSignals, mergeSignal };
