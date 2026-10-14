// Client state: preferences, device-local favourites and follows. Nothing here
// ever leaves the device (no accounts), and every access is guarded because
// localStorage can throw (private mode, blocked storage).

const read = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
};
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } };

const listeners = new Map();
export const bus = {
  on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); },
  emit(evt, data) { (listeners.get(evt) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
};

/* ---------------------------------------------------------------- prefs */
export const prefs = {
  get density() { return read('prism.density', 'm'); },
  set density(v) { write('prism.density', v); bus.emit('density', v); },
  get previews() { return read('prism.previews', true); },
  set previews(v) { write('prism.previews', !!v); },
  get muted() { return read('prism.muted', true); },
  set muted(v) { write('prism.muted', !!v); },
  get hideSeen() { return read('prism.hideSeen', false); },
  set hideSeen(v) { write('prism.hideSeen', !!v); bus.emit('hideSeen', !!v); },
  get reelsHint() { return read('prism.reelsHint', false); },
  set reelsHint(v) { write('prism.reelsHint', !!v); },
  get introDone() { return read('prism.introDone', false); },
  set introDone(v) { write('prism.introDone', !!v); },
  get accent() { return read('prism.accent', 'prism'); },
  set accent(v) { write('prism.accent', v); document.documentElement.dataset.accent = v; bus.emit('accent', v); },
  get historyOff() { return read('prism.historyOff', false); },
  set historyOff(v) { write('prism.historyOff', !!v); },
  get theme() { return read('prism.theme', 'auto'); },
  set theme(v) {
    write('prism.theme', v);
    const light = v === 'light' || (v === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    bus.emit('theme', document.documentElement.dataset.theme);
  },
};

/* ----------------------------------------------------------- favourites */
const MAX_FAVS = 1000;
let favs = read('prism.favs', []);       // [id] newest first
const favSet = new Set(favs);
export const favorites = {
  has: (id) => favSet.has(id),
  list: () => [...favs],
  count: () => favs.length,
  /** `item` (optional) teaches the taste model what was saved. */
  toggle(id, item) {
    if (favSet.has(id)) { favSet.delete(id); favs = favs.filter((x) => x !== id); }
    else { favSet.add(id); favs.unshift(id); favs = favs.slice(0, MAX_FAVS); if (item) tastes.record(item, 4); }
    write('prism.favs', favs);
    bus.emit('fav', { id, on: favSet.has(id) });
    return favSet.has(id);
  },
  clear() { favs = []; favSet.clear(); write('prism.favs', favs); bus.emit('fav', {}); },
  export: () => JSON.stringify({ app: 'prism', version: 2, favorites: favs, follows: followsList, collections: colls, searches: searchList }, null, 2),
  import(text) {
    const data = JSON.parse(text);
    if (!data || data.app !== 'prism') throw new Error('Not a PRISM export');
    let added = 0;
    for (const id of data.favorites || []) if (typeof id === 'string' && !favSet.has(id)) { favSet.add(id); favs.push(id); added++; }
    write('prism.favs', favs);
    for (const c of data.follows || []) if (c && c.id && !followSet.has(c.id)) { followSet.add(c.id); followsList.push(c); }
    write('prism.follows', followsList);
    for (const c of data.collections || []) {
      if (!c || typeof c.name !== 'string' || !Array.isArray(c.items)) continue;
      const mine = colls.find((x) => x.id === c.id) || colls.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
      const ids = c.items.filter((id) => typeof id === 'string');
      if (mine) { mine.items = [...new Set([...mine.items, ...ids])].slice(0, MAX_COLL_ITEMS); } else colls.push({ id: c.id || uid(), name: c.name.slice(0, 60), items: ids.slice(0, MAX_COLL_ITEMS), createdAt: c.createdAt || new Date().toISOString() });
    }
    saveColls();
    for (const q of data.searches || []) if (q && q.query && !searchList.some((x) => searchKey(x.query) === searchKey(q.query))) searchList.push({ ...q, key: searchKey(q.query) });
    saveSearches();
    bus.emit('fav', {}); bus.emit('follow', {});
    return added;
  },
};

/* -------------------------------------------------------------- follows */
let followsList = read('prism.follows', []); // [{id, handle, name, seen}]
const followSet = new Set(followsList.map((c) => c.id));
export const follows = {
  has: (id) => followSet.has(id),
  list: () => [...followsList],
  count: () => followsList.length,
  toggle(creator) {
    if (followSet.has(creator.id)) { followSet.delete(creator.id); followsList = followsList.filter((c) => c.id !== creator.id); }
    else { followSet.add(creator.id); followsList.unshift({ id: creator.id, handle: creator.handle, name: creator.display_name, seen: new Date().toISOString() }); tastes.recordCreator(creator.id, 5); }
    write('prism.follows', followsList);
    bus.emit('follow', { id: creator.id, on: followSet.has(creator.id) });
    return followSet.has(creator.id);
  },
  seen(id) { const c = followsList.find((x) => x.id === id); return c ? c.seen : null; },
  markSeen(id) {
    const c = followsList.find((x) => x.id === id);
    if (c) { c.seen = new Date().toISOString(); write('prism.follows', followsList); bus.emit('followSeen', id); }
  },
  /** Creators the server no longer shows (removed, opted out): stop following them quietly. */
  prune(ids) {
    const gone = new Set(ids || []);
    if (!gone.size || !followsList.some((c) => gone.has(c.id))) return;
    followsList = followsList.filter((c) => !gone.has(c.id));
    for (const id of gone) followSet.delete(id);
    write('prism.follows', followsList);
    bus.emit('follow', {});
  },
};

/* ------------------------------------------------------ following visits */
// When this device last opened the Following page. Opening it marks everything up to now as
// seen (badges clear); `since` is the visit before, which places the "new since you were last
// here" divider. Reopening within 30 minutes keeps the same divider, so Back never loses it.
const FOLLOW_VISIT_KEY = 'prism.followVisit';
let followVisit = read(FOLLOW_VISIT_KEY, { at: null, prev: null });
export const followVisits = {
  open() {
    const now = Date.now();
    const at = followVisit.at ? Date.parse(followVisit.at) : 0;
    if (!at || now - at > 30 * 60000) followVisit.prev = followVisit.at;
    followVisit.at = new Date(now).toISOString();
    write(FOLLOW_VISIT_KEY, followVisit);
    bus.emit('followSeen', null);
    return followVisit.prev;
  },
  get since() { return followVisit.prev; },
  /** What counts as "new" for one followed creator: after the later of its own seen mark and the last page visit. */
  seenFor(c) {
    const a = c && c.seen ? c.seen : null; const b = followVisit.at;
    return !a ? b : !b ? a : (a > b ? a : b);
  },
  /** Same, for this visit's divider: after the previous page visit, or the creator's own seen mark if later. */
  sinceFor(c) {
    const a = c && c.seen ? c.seen : null; const b = followVisit.prev;
    return !a ? b : !b ? a : (a > b ? a : b);
  },
};

/* -------------------------------------------------------------- visits */
// When this device was last here, for "Since your last visit". A gap of 30+ minutes since the
// last activity starts a new visit; the previous visit's time is what "since" means.
const VISIT_KEY = 'prism.visit';
let visit = read(VISIT_KEY, { last: null, prev: null });
export const visits = {
  touch() {
    if (prefs.historyOff) return;
    const now = Date.now();
    const last = visit.last ? Date.parse(visit.last) : 0;
    if (!last || now - last > 30 * 60000) visit.prev = visit.last;
    visit.last = new Date(now).toISOString();
    write(VISIT_KEY, visit);
  },
  get since() { return prefs.historyOff ? null : visit.prev; },
};

/* -------------------------------------------------------------- history */
// What this device has opened in the viewer, newest first. Powers "History" and "Hide seen".
const MAX_HISTORY = 800;
let hist = read('prism.history', []); // [id]
let histSet = new Set(hist);
export const history = {
  has: (id) => histSet.has(id),
  list: () => [...hist],
  count: () => hist.length,
  add(id) {
    if (prefs.historyOff || !id) return;
    if (hist[0] === id) return;
    hist = [id, ...hist.filter((x) => x !== id)].slice(0, MAX_HISTORY);
    histSet = new Set(hist);
    write('prism.history', hist);
    bus.emit('history', id);
  },
  clear() { hist = []; histSet = new Set(); write('prism.history', hist); bus.emit('history', null); },
};

/* ---------------------------------------------------------- collections */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
const MAX_COLL_ITEMS = 1000;
let colls = read('prism.collections', []); // [{id, name, items:[mediaId] newest first, createdAt}]
const saveColls = () => { write('prism.collections', colls); bus.emit('collections', null); };
export const collections = {
  list: () => colls.map((c) => ({ ...c, items: [...c.items] })),
  get: (id) => { const c = colls.find((x) => x.id === id); return c ? { ...c, items: [...c.items] } : null; },
  count: () => colls.length,
  create(name) {
    const c = { id: uid(), name: String(name || 'Untitled').trim().slice(0, 60) || 'Untitled', items: [], createdAt: new Date().toISOString() };
    colls.unshift(c); saveColls(); return c;
  },
  rename(id, name) { const c = colls.find((x) => x.id === id); if (c && name) { c.name = String(name).trim().slice(0, 60); saveColls(); } },
  remove(id) { colls = colls.filter((x) => x.id !== id); saveColls(); },
  has: (id, mediaId) => { const c = colls.find((x) => x.id === id); return !!c && c.items.includes(mediaId); },
  /** Collections that contain this item. */
  containing: (mediaId) => colls.filter((c) => c.items.includes(mediaId)).map((c) => c.id),
  toggle(id, mediaId) {
    const c = colls.find((x) => x.id === id);
    if (!c) return false;
    const on = !c.items.includes(mediaId);
    c.items = on ? [mediaId, ...c.items].slice(0, MAX_COLL_ITEMS) : c.items.filter((x) => x !== mediaId);
    saveColls();
    return on;
  },
  /** Drop ids the server no longer has (taken down / removed at source). */
  prune(id, keep) { const c = colls.find((x) => x.id === id); if (c) { const k = new Set(keep); const before = c.items.length; c.items = c.items.filter((x) => k.has(x)); if (c.items.length !== before) saveColls(); } },
};

/* -------------------------------------------------------- smart feeds */
// A saved Explore search. `seen` marks the last visit, so the app can say "12 new".
const SEARCH_KEYS = ['q', 'type', 'platform', 'community', 'tag', 'tags', 'anytags', 'creator', 'sort', 'since', 'following'];
export const searchKey = (query) => SEARCH_KEYS.map((k) => `${k}=${(query && query[k]) || ''}`).join('&');
let searchList = read('prism.searches', []); // [{id, name, query, key, seen, createdAt}]
const saveSearches = () => { write('prism.searches', searchList); bus.emit('searches', null); };
export const searches = {
  list: () => searchList.map((x) => ({ ...x, query: { ...x.query } })),
  count: () => searchList.length,
  find: (query) => { const k = searchKey(query); return searchList.find((x) => searchKey(x.query) === k) || null; },
  add(name, query) {
    const clean = Object.fromEntries(SEARCH_KEYS.filter((k) => query[k]).map((k) => [k, String(query[k])]));
    const existing = searches.find(clean);
    if (existing) return existing;
    const now = new Date().toISOString();
    const s = { id: uid(), name: String(name || 'Saved search').slice(0, 60), query: clean, key: searchKey(clean), seen: now, createdAt: now };
    searchList.unshift(s); saveSearches(); return s;
  },
  remove(id) { searchList = searchList.filter((x) => x.id !== id); saveSearches(); },
  rename(id, name) { const s = searchList.find((x) => x.id === id); if (s && name) { s.name = String(name).slice(0, 60); saveSearches(); } },
  markSeen(id) { const s = searchList.find((x) => x.id === id); if (s) { s.seen = new Date().toISOString(); saveSearches(); } },
};

/* ------------------------------------------------------ recent searches */
// What was typed into search on this device, newest first, offered again when the box is empty.
const RECENT_KEY = 'prism.recentSearches';
const MAX_RECENT = 8;
let recent = read(RECENT_KEY, []).filter((x) => typeof x === 'string');
export const recentSearches = {
  list: () => [...recent],
  add(text) {
    const q = String(text || '').trim().slice(0, 100);
    if (!q || prefs.historyOff) return;
    recent = [q, ...recent.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENT);
    write(RECENT_KEY, recent);
  },
  remove(text) { recent = recent.filter((x) => x !== text); write(RECENT_KEY, recent); },
  clear() { recent = []; write(RECENT_KEY, recent); },
};

/* ---------------------------------------------------------------- taste */
// A small, decaying model of what this device likes: tags, creators, sources and the
// photo/video mix, learned from views (longer looks count more, quick skips count against),
// saves, collections and follows, plus what you asked to see less of. It powers "For you" and
// is sent to the server only as a short weighted query, never stored there.
const TASTE_KEY = 'prism.taste';
const HALF_LIFE_DAYS = 21;
const blankTaste = () => ({ t: {}, c: {}, p: {}, n: { t: {}, c: {} }, video: 0, image: 0, at: Date.now(), events: 0 });
let taste = { ...blankTaste(), ...read(TASTE_KEY, {}) };
if (!taste.n) taste.n = { t: {}, c: {} };
const decayTaste = () => {
  const days = (Date.now() - (taste.at || Date.now())) / 86400000;
  if (days < 0.5) return;
  const f = 0.5 ** (days / HALF_LIFE_DAYS);
  for (const obj of [taste.t, taste.c, taste.p, taste.n.t, taste.n.c]) for (const key of Object.keys(obj)) { obj[key] *= f; if (obj[key] < 0.05) delete obj[key]; }
  taste.video *= f; taste.image *= f; taste.at = Date.now();
};
const trim = (obj, n) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
let tasteTimer = null;
const saveTaste = () => { clearTimeout(tasteTimer); tasteTimer = setTimeout(() => { write(TASTE_KEY, taste); bus.emit('taste', null); }, 400); };
const GENERIC = new Set(['reddit', 'redgifs', 'bluesky', 'mastodon', 'misskey', 'tumblr', 'peertube', 'lemmy', 'x', 'telegram', 'rss', 'web', 'gay', 'nsfw']);
const styleTags = (item, n = 8) => (item.tags || []).filter((x) => !GENERIC.has(x)).slice(0, n);
const lower = (obj, key, by) => { if (obj[key] === undefined) return; obj[key] -= by; if (obj[key] < 0.05) delete obj[key]; };
const weighted = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, w]) => `${k}:${Math.max(0.1, w).toFixed(1)}`).join(',');
export const tastes = {
  /** weight: view 1 · long look 1 more · collect 3 · save 4 · follow 5 */
  record(item, weight = 1) {
    if (!item || prefs.historyOff) return;
    decayTaste();
    for (const tg of styleTags(item)) { taste.t[tg] = (taste.t[tg] || 0) + weight; lower(taste.n.t, tg, weight * 0.5); }
    if (item.creator_id) { taste.c[item.creator_id] = (taste.c[item.creator_id] || 0) + weight * 1.5; lower(taste.n.c, item.creator_id, weight); }
    if (item.platform) taste.p[item.platform] = (taste.p[item.platform] || 0) + weight * 0.5;
    if (item.media_type === 'video') taste.video += weight; else taste.image += weight;
    taste.events = (taste.events || 0) + 1;
    taste.t = trim(taste.t, 80); taste.c = trim(taste.c, 80); taste.p = trim(taste.p, 12);
    saveTaste();
  },
  /**
   * Swiped past almost at once: a small step away from its tags and creator. What you had no liking
   * for yet builds up a negative instead, so a creator skipped three times or so drops out of
   * "For you" (avoid at 2) and a tag skipped repeatedly sinks (avoid at 1); both decay like the rest.
   */
  skip(item) {
    if (!item || prefs.historyOff) return;
    decayTaste();
    for (const tg of styleTags(item, 6)) { if (taste.t[tg]) lower(taste.t, tg, 0.6); else taste.n.t[tg] = (taste.n.t[tg] || 0) + 0.25; }
    if (item.creator_id) { if (taste.c[item.creator_id]) lower(taste.c, item.creator_id, 0.9); else taste.n.c[item.creator_id] = (taste.n.c[item.creator_id] || 0) + 0.7; }
    taste.n.t = trim(taste.n.t, 40); taste.n.c = trim(taste.n.c, 100);
    saveTaste();
  },
  /** "Not interested": stop recommending this creator and push its tags down. */
  dislike(item) {
    if (!item) return;
    decayTaste();
    for (const tg of styleTags(item, 3)) { taste.n.t[tg] = (taste.n.t[tg] || 0) + 1; if (taste.t[tg]) taste.t[tg] *= 0.5; }
    if (item.creator_id) { taste.n.c[item.creator_id] = (taste.n.c[item.creator_id] || 0) + 3; delete taste.c[item.creator_id]; }
    taste.n.t = trim(taste.n.t, 40); taste.n.c = trim(taste.n.c, 100);
    saveTaste();
  },
  recordCreator(id, weight = 5) { if (!id || prefs.historyOff) return; decayTaste(); taste.c[id] = (taste.c[id] || 0) + weight; delete taste.n.c[id]; taste.c = trim(taste.c, 80); saveTaste(); },
  /** "Show less #tag". */
  forgetTag(tag) { delete taste.t[tag]; taste.n.t[tag] = (taste.n.t[tag] || 0) + 1.5; saveTaste(); },
  reset() { taste = blankTaste(); write(TASTE_KEY, taste); bus.emit('taste', null); },
  /** Enough signal to personalise? */
  ready: () => (taste.events || 0) >= 3 && (Object.keys(taste.t).length > 0 || Object.keys(taste.c).length > 0),
  topTags: (n = 8) => Object.entries(taste.t).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k),
  /** A short human reason an item was picked for you ("A creator you like", "#beach", "Like @jake"), or null. */
  why(item) {
    if (!item) return null;
    if (item.reason) return item.reason;
    const creators = Object.entries(taste.c).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k]) => k);
    if (item.creator_id && creators.includes(item.creator_id)) return 'A creator you like';
    const top = Object.entries(taste.t).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
    const hit = (item.tags || []).find((t) => top.includes(t));
    return hit ? `#${hit}` : null;
  },
  /** Query parameters for /api/recommend (weighted: "beach:3.5,beard:1.2"). */
  query({ exclude = [] } = {}) {
    decayTaste();
    const total = taste.video + taste.image;
    const avoid = (obj, min) => Object.entries(obj).filter(([, w]) => w >= min).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return {
      tags: weighted(taste.t, 16), creators: weighted(taste.c, 30), platforms: weighted(taste.p, 4),
      avoid_tags: avoid(taste.n.t, 1).slice(0, 20).join(',') || undefined,
      avoid_creators: avoid(taste.n.c, 2).slice(0, 60).join(',') || undefined,
      video: total >= 5 ? (taste.video / total).toFixed(2) : undefined,
      exclude: exclude.slice(0, 150).join(',') || undefined,
    };
  },
};

/* ---------------------------------------------------------- admin session */
export const adminSession = {
  get key() { try { return sessionStorage.getItem('prism.admin') || ''; } catch { return ''; } },
  set key(v) { try { if (v) sessionStorage.setItem('prism.admin', v); else sessionStorage.removeItem('prism.admin'); } catch { /* ignore */ } },
};

/* ----------------------------------------------------- platform registry */
export const platforms = { map: {} };
export const platformLabel = (p) => (platforms.map[p] && platforms.map[p].label) || p;
export const platformColor = (p) => (platforms.map[p] && platforms.map[p].color) || '#94a3b8';
