/**
 * Plain-words freshness for creator cards. Pure (no DOM, no imports) so tests/creator-words.test.js can pin it down.
 *
 * "Posted 2 days ago" reads faster than "2d" and never shows a raw date. Anything quiet for more than 90 days is marked
 * `quiet` so the card can dim its pictures; it is still shown, never hidden.
 */
const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/**
 * @param {string|null} lastMediaAt ISO time of the newest published post
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {{ text: string, days: number, live: boolean, quiet: boolean } | null}
 */
export function postedWords(lastMediaAt, now = Date.now()) {
  if (!lastMediaAt) return null;
  const t = new Date(lastMediaAt).getTime();
  if (!Number.isFinite(t)) return null;
  const days = Math.max(0, (now - t) / 86400000);
  let when;
  if (days < 1) when = 'today';
  else if (days < 2) when = 'yesterday';
  else if (days < 14) when = `${plural(Math.floor(days), 'day')} ago`;
  else if (days < 60) when = `${plural(Math.floor(days / 7), 'week')} ago`;
  else if (days < 365) when = `${plural(Math.floor(days / 30), 'month')} ago`;
  else when = `${plural(Math.floor(days / 365), 'year')} ago`;
  return { text: `Posted ${when}`, days, live: days < 7, quiet: days > 90 };
}
