import { h, icon, $, toast, fmt, openModal } from './dom.js';
import { get, post, onAgeRequired, streamPublic, ApiError, clearApiCache, prefetch } from './api.js';
import { parse, href, navigate, matchRoute, routeKey } from './router.js';
import { prefs, favorites, follows, platforms, bus, visits } from './store.js';
import { syncFromUrl, isOpen } from './components/lightbox.js';
import { openPalette, paletteOpen, surpriseMe } from './components/palette.js';
import { openDisplaySettings } from './components/display.js';
import { initTilt, initRails, gpuTier } from './components/fx.js';
import { openTakedownForm } from './components/report.js';
import { openMenu } from './components/menu.js';
import { dropFeedStash } from './components/feed.js';
import { attachSuggest } from './components/suggest.js';
import { primeEager } from './components/card.js';
import { smartSearch } from './smart.js';
import { home } from './views/home.js';
import { explore } from './views/explore.js';
import { creators } from './views/creators.js';
import { creator } from './views/creator.js';
import { saved } from './views/saved.js';
import { browse } from './views/browse.js';
import { reels } from './views/reels.js';
import { following } from './views/following.js';
import { find } from './views/find.js';
import { wireFollowBadges, followNewContent } from './following.js';

const routes = [
  { pattern: '/', view: home, nav: 'home' },
  { pattern: '/following', view: following, nav: 'following' },
  { pattern: '/explore', view: explore, nav: 'explore' },
  { pattern: '/reels', view: reels, nav: 'reels' },
  { pattern: '/browse', view: browse, nav: 'browse' },
  { pattern: '/creators', view: creators, nav: 'creators' },
  { pattern: '/find', view: find, nav: 'creators' },
  // loaded on first visit: the 3D map is the heaviest view and most sessions never open it
  { pattern: '/galaxy', view: (...a) => import('./views/galaxy.js').then((m) => m.galaxy(...a)), nav: 'creators' },
  { pattern: '/creator/:id', view: creator, nav: 'creators' },
  { pattern: '/saved', view: saved, nav: 'saved' },
  { pattern: '/admin/:tab?', view: (...a) => import('./views/admin/index.js').then((m) => m.admin(...a)), nav: 'admin' },
];

let cleanup = null;
let currentKey = null;
let renderToken = 0;
const scrollMemory = new Map();

/* --------------------------------------------------------------- age gate */
let agePromise = null;
function ensureAgeGate() {
  if (agePromise) return agePromise;
  agePromise = new Promise((resolve) => {
    const root = $('#age-root');
    const confirmBtn = h('button', { class: 'btn primary lg', onclick: async () => {
      try { await post('/api/age/confirm'); } catch { /* proceed anyway; API will re-prompt if needed */ }
      root.replaceChildren(); agePromise = null; resolve();
    } }, 'I’m 18 or older — Enter');
    root.replaceChildren(h('div', { class: 'age', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Age verification' },
      h('div', { class: 'age-card' },
        h('div', { class: 'brand' }, icon('logo'), h('span', null, 'PRISM')),
        h('h2', null, 'Adults only'),
        h('p', null, 'This site contains explicit adult content. You must be at least 18 years old (or the age of majority where you live) to continue.'),
        confirmBtn,
        h('a', { class: 'leave', href: 'https://www.google.com', rel: 'noopener noreferrer' }, 'I’m under 18 — leave'),
        h('p', { class: 'legal' }, 'By entering you confirm that you are of legal age and that viewing adult content is legal where you are.'))));
    setTimeout(() => confirmBtn.focus(), 50);
  });
  return agePromise;
}
onAgeRequired(ensureAgeGate);

/* ------------------------------------------------------------------ shell */
// 5th field: desktop-only (the phone tab bar keeps five entries)
const NAV = [['home', '/', 'Home', 'home'], ['following', '/following', 'Following', 'rss', true], ['explore', '/explore', 'Explore', 'compass'], ['reels', '/reels', 'Reels', 'film'], ['browse', '/browse', 'Browse', 'layers', true], ['creators', '/creators', 'Creators', 'users'], ['saved', '/saved', 'Saved', 'heart']];

/* --------------------------------------------------------- global shortcuts */
function showShortcuts() {
  const rows = [['Ctrl / ⌘ + K', 'Command palette — jump anywhere, run actions'], ['/', 'Search'], ['?', 'This help'], ['G then H / F / E / R / C / S / M', 'Go to Home, Following, Explore, Reels, Creators, Saved, Galaxy map'], ['X', 'Surprise me (open something random)'],
    ['In the viewer', ''], ['← / →  (J / K)', 'Previous / next'], ['F · C', 'Save · add to collection'], ['S · I · M', 'Slideshow · details · mute'],
    ['In Reels', ''], ['↑ / ↓  (K / J)', 'Previous / next'], ['Space · M', 'Pause · sound'], ['F · C · Enter', 'Save · collect · open details'], ['Double-tap', 'Save']];
  const m = openModal({ title: 'Keyboard shortcuts', wide: true, body: h('dl', { class: 'kv', style: { gridTemplateColumns: 'auto 1fr' } }, rows.map(([k, d]) => (d
    ? [h('dt', null, h('kbd', { class: 'kbd' }, k)), h('dd', { style: { textAlign: 'left' } }, d)]
    : [h('dt', { style: { gridColumn: '1 / -1', marginTop: '10px', fontWeight: 700, color: 'var(--text)' } }, k)]))), actions: [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Got it')] });
}

function wireShortcuts() {
  let g = 0; // timestamp of a pending "g" prefix
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || isOpen() || paletteOpen() || $('#modal-root').children.length || e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (Date.now() - g < 1200) {
      const dest = { h: '/', f: '/following', e: '/explore', r: '/reels', c: '/creators', s: '/saved', b: '/browse', a: '/admin', m: '/galaxy' }[e.key.toLowerCase()];
      g = 0;
      if (dest) { e.preventDefault(); navigate(dest); }
      return;
    }
    if (e.key === 'g' || e.key === 'G') { g = Date.now(); return; }
    if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
    if ((e.key === 'x' || e.key === 'X') && !document.body.classList.contains('reels-mode')) { e.preventDefault(); surpriseMe(); }
  });
}

function buildShell() {
  const app = $('#app');
  // the long example gets cut off mid-word on a phone, so narrow screens get a short one
  const narrow = window.matchMedia('(max-width: 560px)');
  const searchInput = h('input', { class: 'input', type: 'search', id: 'global-search', 'aria-label': 'Search', enterkeyhint: 'search', autocomplete: 'off' });
  const paintPlaceholder = () => { searchInput.placeholder = narrow.matches ? 'Search creators, tags…' : 'Search anything — “bearded guys at the beach, videos”'; };
  paintPlaceholder();
  narrow.addEventListener('change', paintPlaceholder);
  attachSuggest(searchInput); // registered first so it can claim Enter for a highlighted suggestion
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { smartSearch(searchInput.value); searchInput.blur(); }
    if (e.key === 'Escape') searchInput.blur();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select') && !isOpen()) { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  });

  const themeBtn = h('button', { class: 'btn icon ghost', 'aria-label': 'Toggle theme', title: 'Toggle theme' });
  const paintTheme = () => themeBtn.replaceChildren(icon(document.documentElement.dataset.theme === 'light' ? 'moon' : 'sun'));
  themeBtn.addEventListener('click', () => { prefs.theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; paintTheme(); });
  paintTheme();
  bus.on('theme', paintTheme);

  const savedBadge = h('span', { class: 'badge', style: { display: 'none', padding: '0 7px' } });
  const paintBadge = () => { const n = favorites.count(); savedBadge.textContent = n > 99 ? '99+' : n; savedBadge.style.display = n ? '' : 'none'; };
  bus.on('fav', paintBadge); paintBadge();

  const header = h('header', { class: 'appbar' }, h('div', { class: 'scroll-progress', 'aria-hidden': 'true' }),
    h('a', { class: 'brand', href: href('/'), 'aria-label': 'PRISM home' }, icon('logo'), h('span', null, 'PRISM')),
    h('nav', { class: 'nav', 'aria-label': 'Primary' }, NAV.map(([key, path, label, ic]) => h('a', { href: href(path), dataset: { nav: key }, title: label }, icon(ic, 'sm'), h('span', { class: 'nav-label' }, label), key === 'saved' ? savedBadge : key === 'following' ? h('span', { class: 'badge follow-badge', hidden: true, dataset: { followBadge: 'count' } }) : null))),
    h('div', { class: 'search' }, icon('search'), searchInput, h('span', { class: 'kbd hide-mobile' }, '/')),
    h('div', { class: 'appbar-actions' }, h('button', { class: 'btn icon ghost hide-mobile', 'aria-label': 'Command palette', title: 'Command palette (Ctrl/⌘ K)', onclick: openPalette }, icon('command')), themeBtn, h('button', { class: 'btn icon ghost', 'aria-label': 'Display settings', title: 'Display settings', onclick: openDisplaySettings }, icon('palette')), h('a', { class: 'btn icon ghost hide-mobile', href: href('/admin'), 'aria-label': 'Admin', title: 'Admin' }, icon('sliders')),
      h('button', { class: 'btn icon ghost only-mobile more-btn', 'aria-label': 'More', title: 'More', 'aria-haspopup': 'dialog', onclick: openMenu }, icon('more'), h('span', { class: 'nav-dot', hidden: true, dataset: { followBadge: 'dot' } }))));

  const main = h('main', { id: 'main', tabindex: '-1' });
  const footer = h('footer', { class: 'footer' },
    h('span', null, 'PRISM — adults only (18+)'),
    h('a', { href: href('/browse') }, 'Browse'),
    h('a', { href: href('/galaxy') }, 'Creator galaxy'),
    h('button', { onclick: showShortcuts }, 'Keyboard shortcuts'),
    h('button', { onclick: openDisplaySettings }, 'Display settings'),
    h('button', { onclick: openTakedownForm }, 'Report content / takedown'),
    h('a', { href: href('/admin') }, 'Admin'));
  const bottom = h('nav', { class: 'bottomnav five', 'aria-label': 'Primary' }, h('span', { class: 'bn-ind', 'aria-hidden': 'true' }), NAV.filter((n) => !n[4]).map(([key, path, label, ic]) => h('a', { href: href(path), dataset: { nav: key } }, icon(ic, 'lg'), label)));
  window.addEventListener('resize', () => setNav(currentNav), { passive: true });
  // A primary tab is a fresh start: it opens the page at the top (not where you left it), and
  // tapping the tab you are already on scrolls back to the top, like a native app's tab bar.
  app.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    if (a.getAttribute('href') === (location.hash || '#/')) {
      e.preventDefault();
      const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      window.scrollTo({ top: 0, behavior });
      const track = document.querySelector('.reels-track'); // Reels scrolls its own track, not the page
      if (track) track.scrollTo({ top: 0, behavior });
      return;
    }
    freshNav = true;
  });
  const fab = h('button', { class: 'fab', hidden: true, 'aria-label': 'Back to top', onclick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) }, icon('up'));
  window.addEventListener('scroll', () => { fab.hidden = window.scrollY < 900; }, { passive: true });

  app.replaceChildren(header, main, footer, bottom, fab);
  return { main, searchInput };
}

let currentNav = null;
let freshNav = false; // the next render came from a primary tab: start at the top
function setNav(key) {
  currentNav = key;
  document.querySelectorAll('[data-nav]').forEach((a) => { if (a.dataset.nav === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  // slide the phone tab bar's highlight under the current tab
  const ind = document.querySelector('.bn-ind');
  const on = document.querySelector(`.bottomnav [data-nav="${key}"]`);
  if (ind) {
    if (on) { ind.style.width = `${on.offsetWidth - 12}px`; ind.style.transform = `translateX(${on.offsetLeft + 6}px)`; ind.style.opacity = '1'; } else ind.style.opacity = '0';
  }
}

/* ----------------------------------------------------------------- router */
async function render(shell) {
  const p = parse();
  const key = routeKey(p);
  syncFromUrl();                       // lightbox follows ?m=
  if (key === currentKey) return;      // only the overlay changed
  const token = ++renderToken;
  if (currentKey) scrollMemory.set(currentKey, window.scrollY);
  currentKey = key;
  const fresh = freshNav; freshNav = false;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  // after cleanup: tearing the old page down stashes its feed, which a fresh start must not reuse
  if (fresh) { scrollMemory.delete(key); dropFeedStash(key); }

  const match = matchRoute(routes, p);
  if (!match) { navigate('/', {}, { replace: true }); return; }
  setNav(match.route.nav);
  if (p.path === '/explore') shell.searchInput.value = p.query.get('q') || '';
  else if (p.path !== '/') shell.searchInput.value = '';
  shell.main.classList.remove('view-enter'); void shell.main.offsetWidth; shell.main.classList.add('view-enter');
  primeEager(6);
  visits.touch();
  document.title = 'PRISM — Discover male creators';
  try {
    const result = await match.route.view(shell.main, { params: match.params, query: p.query });
    if (token !== renderToken) { if (typeof result === 'function') result(); return; }
    cleanup = typeof result === 'function' ? result : null;
    // Back from a creator or a search lands where you were: feeds rebuild from their stash
    // synchronously (see feed.js), so the old scroll position exists again by now.
    const y = scrollMemory.get(key);
    window.scrollTo({ top: y || 0 });
  } catch (e) {
    if (token !== renderToken) return;
    console.error(e);
    shell.main.replaceChildren(h('div', { class: 'empty' }, h('h3', null, 'Something went wrong'), h('p', null, e instanceof ApiError ? e.message : 'The page failed to load.'), h('button', { class: 'btn primary', onclick: () => { currentKey = null; render(shell); } }, 'Reload page')));
  }
}

/* -------------------------------------------------------------- live pill */
function wireLiveUpdates(shell) {
  let pending = 0; let pill = null;
  streamPublic((evt) => {
    if (evt.type !== 'new') return;
    clearApiCache(); // new content: the next request must not come from the cache
    followNewContent();
    const p = parse().path;
    if (p !== '/' && p !== '/explore') return;
    pending += evt.count || 1;
    if (!pill) { pill = h('button', { class: 'btn primary newpill', onclick: () => { pending = 0; pill.remove(); pill = null; dropFeedStash(); scrollMemory.clear(); freshNav = true; currentKey = null; render(shell); window.scrollTo({ top: 0 }); } }); document.body.appendChild(pill); }
    pill.replaceChildren(icon('refresh', 'sm'), `${fmt.int(pending)} new — refresh`);
  });
  window.addEventListener('hashchange', () => { if (pill) { pill.remove(); pill = null; pending = 0; } });
}

/* ---------------------------------------------------------- offline shell (PWA) */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* optional enhancement */ });
}

/* ------------------------------------------------------------------- boot */
async function boot() {
  prefs.theme = prefs.theme; // re-apply (handles "auto")
  let meta;
  try { meta = await get('/api/meta'); } catch { meta = { ageGate: { enforce: false, verified: true }, platforms: [] }; }
  for (const pl of meta.platforms || []) platforms.map[pl.platform] = pl;
  if (meta.ageGate && meta.ageGate.enforce && !meta.ageGate.verified) await ensureAgeGate();

  const shell = buildShell();
  wireShortcuts();
  document.documentElement.dataset.gpu = gpuTier(); // CSS trims costly effects on software rendering
  initTilt();
  initRails($('#app'));
  // Hover (or touch) on a creator link warms the profile request, so the click opens instantly.
  // Pointer hover waits a brief 65ms intent window so fast cursor sweeps across a grid never fire a storm of prefetches.
  const warmed = new Map();
  let hoverTimer = 0;
  let hoverLink = null;
  const fireWarm = (a) => {
    const id = a.getAttribute('href').slice('#/creator/'.length).split(/[?/]/)[0];
    if (!id || Date.now() - (warmed.get(id) || 0) < 25000) return;
    warmed.set(id, Date.now());
    prefetch(`/api/creators/${id}`);
  };
  document.addEventListener('pointerover', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href^="#/creator/"]') : null;
    if (a === hoverLink) return;
    clearTimeout(hoverTimer);
    hoverLink = a;
    if (!a) return;
    hoverTimer = setTimeout(() => { if (hoverLink === a) fireWarm(a); }, 65);
  }, { passive: true });
  document.addEventListener('pointerout', (e) => {
    if (!hoverLink) return;
    const rel = e.relatedTarget;
    if (rel && rel.closest && rel.closest('a[href^="#/creator/"]') === hoverLink) return;
    clearTimeout(hoverTimer);
    hoverLink = null;
  }, { passive: true });
  document.addEventListener('touchstart', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href^="#/creator/"]') : null;
    if (a) fireWarm(a);
  }, { passive: true });
  window.addEventListener('hashchange', () => render(shell));
  await render(shell);
  wireFollowBadges();
  wireLiveUpdates(shell);
  registerServiceWorker();
}

boot();
