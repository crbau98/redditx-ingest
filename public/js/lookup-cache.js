/**
 * Session cache for Find lookups. /api/lookup is rate-limited and slow, so a query that already
 * resolved is answered from here: Back, "Try again", Enter twice and the ?q= remount all reuse it.
 * Keys ignore case and extra spaces. Empty results and failed lookups are never stored.
 */
export const LOOKUP_TTL_MS = 10 * 60 * 1000;
export const LOOKUP_MAX = 20;

export function createLookupCache({ ttl = LOOKUP_TTL_MS, max = LOOKUP_MAX, now = () => Date.now() } = {}) {
  const entries = new Map();
  const keyOf = (q) => String(q || '').trim().replace(/\s+/g, ' ').toLowerCase();

  return {
    get(q) {
      const k = keyOf(q);
      const e = entries.get(k);
      if (!e) return null;
      if (now() - e.at > ttl) { entries.delete(k); return null; }
      return e.result;
    },
    set(q, result) {
      const k = keyOf(q);
      if (!k || !result) return;
      entries.delete(k); // re-store moves the key to the newest slot
      entries.set(k, { at: now(), result });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}

export const lookupCache = createLookupCache();
