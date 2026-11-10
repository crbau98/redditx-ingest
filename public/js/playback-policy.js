/** Pure rules for resume position and playback speed. No DOM, so the same file is what the player and the tests run. */

export const RATES = [0.75, 1, 1.25, 1.5, 2];

export function clampRate(n) {
  const x = Number(n);
  return RATES.includes(x) ? x : 1;
}

/** Step one stop. Stays on the end rate instead of wrapping, so 2× does not jump back to 0.75×. */
export function stepRate(current, dir) {
  const i = RATES.indexOf(clampRate(current));
  const next = i + (dir < 0 ? -1 : 1);
  return RATES[Math.min(RATES.length - 1, Math.max(0, next))];
}

/**
 * Where to seek when a video opens again. 0 means start at the beginning:
 * too short to be worth remembering, barely started, or already at the end.
 */
export function resumeAt(seconds, duration) {
  const t = Number(seconds);
  const d = Number(duration);
  if (!Number.isFinite(t) || !Number.isFinite(d) || d < 8) return 0;
  if (t < 3 || t > d - 2) return 0;
  if (t / d > 0.92) return 0;
  return t;
}

export function keepProgress(seconds, duration) {
  return resumeAt(seconds, duration) > 0;
}

const RESUME_KEEP = 24;
const RESUME_MS = 21 * 86400000;

/**
 * Merge a file of resume points into the ones already on this device.
 * The newer timestamp wins. Points older than 21 days, and rows without an id and a time, are dropped.
 */
export function mergeResume(current, incoming, now = Date.now()) {
  const map = new Map();
  const take = (p) => {
    if (!p || typeof p.id !== 'string' || !Number.isFinite(Number(p.t))) return;
    const at = Number(p.at) || 0;
    if (now - at >= RESUME_MS) return;
    const row = { id: p.id, t: Math.round(Number(p.t)), d: Math.round(Number(p.d) || 0), at };
    const prev = map.get(row.id);
    if (!prev || row.at >= prev.at) map.set(row.id, row);
  };
  for (const p of incoming || []) take(p);
  for (const p of current || []) take(p);
  return [...map.values()].sort((a, b) => b.at - a.at).slice(0, RESUME_KEEP);
}
