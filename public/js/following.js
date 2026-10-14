import { query } from './api.js';
import { follows, followVisits, bus } from './store.js';

/*
 * What is new from the creators this device follows. One POST asks for every followed creator
 * at once (/api/follow/summary); the answer drives the badges on the Following tab, the phone
 * "More" button and the menu, and the creator rail on the Following page.
 */

let last = null;   // { at, data }
let inflight = null; // { key, p }
let asked = 0;      // newest request number: an older answer arriving late is not painted
const MAX_AGE = 60000;

const body = () => ({ follows: follows.list().map((c) => ({ id: c.id, seen: followVisits.seenFor(c) })) });

/** { creators: [{ ...card, new_count }], total_new } for the current follow list. */
export function followSummary({ fresh = false } = {}) {
  if (!follows.count()) {
    // unfollowed the last one: clear whatever badge the previous count left
    const data = { creators: [], gone: [], total_new: 0 };
    asked++; inflight = null;
    last = { at: Date.now(), data };
    paint(0);
    return Promise.resolve(data);
  }
  if (!fresh && last && Date.now() - last.at < MAX_AGE) return Promise.resolve(last.data);
  const req = body();
  const key = JSON.stringify(req);
  // a request already out for this same follow list answers this one too; a changed list asks again
  if (inflight && inflight.key === key) return inflight.p;
  const n = ++asked;
  const p = query('/api/follow/summary', req, { fresh: true })
    .then((data) => {
      if (n !== asked) return data; // a newer follow list was asked for since; its answer paints
      last = { at: Date.now(), data };
      paint(data.total_new);
      // creators removed or opted out on the server: stop following them, as Saved › Following does
      if (data.gone && data.gone.length) follows.prune(data.gone);
      return data;
    })
    .finally(() => { if (inflight && inflight.p === p) inflight = null; });
  inflight = { key, p };
  return p;
}

/** Fill every [data-follow-badge] with the unread count (hidden at zero). */
function paint(n) {
  const text = n > 99 ? '99+' : String(n || '');
  for (const el of document.querySelectorAll('[data-follow-badge]')) {
    el.hidden = !n;
    if (el.dataset.followBadge !== 'dot') { el.textContent = text; continue; }
    // a bare dot on the phone's More button: the count goes in the button's name instead
    if (el.parentElement) el.parentElement.setAttribute('aria-label', n ? `More, ${text} new from creators you follow` : 'More');
  }
}
export const repaintFollowBadges = () => paint(last ? last.data.total_new : 0);

let timer = null; let due = 0;
/** Recount after `delay` ms; an earlier pending recount is kept rather than pushed back. */
const refresh = (delay = 0) => {
  const at = Date.now() + delay;
  if (timer && due <= at) return;
  clearTimeout(timer); due = at;
  timer = setTimeout(() => { timer = null; followSummary({ fresh: true }).catch(() => {}); }, delay);
};

/** New posts landed somewhere (the live stream): recount soon, spread out so tabs don't all ask at once. */
export function followNewContent() { if (follows.count()) refresh(20000 + Math.random() * 20000); }

/** Keep the badges current: on boot, when follows or seen marks change, and when the tab comes back. */
export function wireFollowBadges() {
  bus.on('follow', () => refresh(300));
  // a seen mark changed (a creator page, or the Following page): counts drop without a request
  bus.on('followSeen', (id) => {
    if (!last) return;
    const d = last.data;
    for (const c of d.creators) if (id === null || c.id === id) c.new_count = 0;
    d.total_new = d.creators.reduce((s, c) => s + c.new_count, 0);
    paint(d.total_new);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && last && Date.now() - last.at > MAX_AGE) refresh(); });
  refresh(1500); // after first paint
}
