/**
 * Reels buffer window, as a pure function of the playing index. Keeps an endless swipe session at a
 * fixed number of live video streams:
 *   active   — the one slide that plays (holds a decoder, full buffer)
 *   warm     — the next slide (pre-buffers so a swipe starts at once) and the one before (small buffer)
 *   near     — two slides away: a poster only, no stream
 * Everything else is unmounted.
 */
export function planWindow(active, count) {
  const inside = (k) => k >= 0 && k < count;
  const warm = [active + 1, active - 1].filter(inside);
  const near = [active + 2, active - 2].filter(inside);
  return { active, warm, near };
}
