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
  get muted() { return read('prism.muted', true); },
  set muted(v) { write('prism.muted', !!v); },
  get theme() { return read('prism.theme', 'auto'); },
  set theme(v) {
    write('prism.theme', v);
    const light = v === 'light' || (v === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
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
  toggle(id) {
    if (favSet.has(id)) { favSet.delete(id); favs = favs.filter((x) => x !== id); }
    else { favSet.add(id); favs.unshift(id); favs = favs.slice(0, MAX_FAVS); }
    write('prism.favs', favs);
    bus.emit('fav', { id, on: favSet.has(id) });
    return favSet.has(id);
  },
  clear() { favs = []; favSet.clear(); write('prism.favs', favs); bus.emit('fav', {}); },
  export: () => JSON.stringify({ app: 'prism', version: 1, favorites: favs, follows: followsList }, null, 2),
  import(text) {
    const data = JSON.parse(text);
    if (!data || data.app !== 'prism') throw new Error('Not a PRISM export');
    let added = 0;
    for (const id of data.favorites || []) if (typeof id === 'string' && !favSet.has(id)) { favSet.add(id); favs.push(id); added++; }
    write('prism.favs', favs);
    for (const c of data.follows || []) if (c && c.id && !followSet.has(c.id)) { followSet.add(c.id); followsList.push(c); }
    write('prism.follows', followsList);
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
    else { followSet.add(creator.id); followsList.unshift({ id: creator.id, handle: creator.handle, name: creator.display_name, seen: new Date().toISOString() }); }
    write('prism.follows', followsList);
    bus.emit('follow', { id: creator.id, on: followSet.has(creator.id) });
    return followSet.has(creator.id);
  },
  seen(id) { const c = followsList.find((x) => x.id === id); return c ? c.seen : null; },
  markSeen(id) {
    const c = followsList.find((x) => x.id === id);
    if (c) { c.seen = new Date().toISOString(); write('prism.follows', followsList); }
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
