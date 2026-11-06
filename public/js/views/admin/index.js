import { h, icon, toast, emptyState, openModal } from '../../dom.js';
import { adminGet, ApiError } from '../../api.js';
import { adminSession } from '../../store.js';
import { href, navigate } from '../../router.js';
import { PHONE_NAV } from './logic.js';

const TABS = [
  ['overview', 'Overview', 'layers', () => import('./overview.js')],
  ['moderation', 'Review queue', 'shield', () => import('./moderation.js')],
  ['reports', 'Reports', 'flag', () => import('./reports.js')],
  ['media', 'Media', 'image', () => import('./media.js')],
  ['creators', 'Creators', 'users', () => import('./creators.js')],
  ['identities', 'Same person?', 'link', () => import('./identities.js')],
  ['sources', 'Sources', 'compass', () => import('./sources.js')],
  ['feeds', 'Feeds', 'rss', () => import('./feeds.js')],
  ['discovery', 'Discovery', 'sparkle', () => import('./discovery.js')],
  ['blocklist', 'Blocklist', 'lock', () => import('./blocklist.js')],
  ['audit', 'Audit log', 'clock', () => import('./audit.js')],
  ['live', 'Live log', 'bolt', () => import('./live.js')],
  ['settings', 'Settings', 'sliders', () => import('./settings.js')],
];

/** Sidebar grouped by task (tab keys and URLs unchanged, so deep links keep working). */
const GROUPS = [
  ['Work queue', ['overview', 'moderation', 'reports', 'media']],
  ['Creators and sources', ['creators', 'identities', 'sources', 'feeds', 'discovery']],
  ['Safety and access', ['blocklist', 'audit']],
  ['System', ['live', 'settings']],
];

function keyGate(root, message, retry) {
  const input = h('input', { class: 'input', type: 'password', placeholder: 'Admin key', autocomplete: 'current-password', 'aria-label': 'Admin key' });
  // A real form: Enter submits, and password managers recognise the field.
  const go = (e) => { if (e) e.preventDefault(); adminSession.key = input.value.trim(); retry(); };
  root.replaceChildren(h('form', { class: 'panel keycard stack', onsubmit: go },
    h('div', { class: 'empty', style: { padding: '8px' } }, h('div', { class: 'ico' }, icon('lock')), h('h3', null, 'Admin console'), h('p', null, message)),
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'admin', hidden: true, 'aria-hidden': 'true' }),
    input, h('button', { class: 'btn primary lg', type: 'submit' }, 'Unlock')));
  setTimeout(() => input.focus(), 30);
}

// The console's stylesheets arrive with the console: public pages never download them. Resolved from
// this module's own URL, so they share the deploy's versioned (immutable) prefix.
let styles = null;
export function adminStyles() {
  if (!styles) {
    const load = (url) => new Promise((resolve) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = url;
      l.onload = l.onerror = () => resolve();
      document.head.appendChild(l);
    });
    styles = Promise.all([
      load(new URL('../../../css/admin.css', import.meta.url).href),
      load(new URL('../../../css/admin-console.css', import.meta.url).href),
    ]);
  }
  return styles;
}

let attempts = 0;

/** The console. `is-admin` on <body> swaps the public tab bar for the console's own while this view is open. */
export async function admin(root, ctx) {
  document.body.classList.add('is-admin');
  let inner = () => {};
  try { inner = await adminView(root, ctx); } catch (e) { document.body.classList.remove('is-admin'); throw e; }
  return () => { document.body.classList.remove('is-admin'); if (typeof inner === 'function') inner(); };
}

async function adminView(root, { params }) {
  document.title = 'Admin — PRISM';
  await adminStyles();
  const tabKey = params.tab || 'overview';
  const tab = TABS.find((t) => t[0] === tabKey);
  if (!tab) { navigate('/admin/overview', {}, { replace: true }); return () => {}; }

  // Only the newest attempt may act on its answer: a slow 401 for an earlier, wrong key must not clear the key typed
  // after it, nor cover the console the newer attempt is already showing.
  const attempt = ++attempts;
  const tried = adminSession.key;
  let overview;
  try { overview = await adminGet('/overview'); } catch (e) {
    if (attempt !== attempts) return () => {};
    if (e.status === 401) { adminSession.key = ''; keyGate(root, tried ? 'That key was not accepted.' : 'Enter the ADMIN_KEY to continue.', () => admin(root, { params })); return () => {}; }
    if (e.status === 503) { root.replaceChildren(emptyState({ icon: 'lock', title: 'Admin is disabled', text: 'Set the ADMIN_KEY environment variable on the server (or ADMIN_OPEN=true for a private dev box), then reload.' })); return () => {}; }
    root.replaceChildren(emptyState({ icon: 'alert', title: 'Couldn’t reach the admin API', text: e.message, actions: [h('button', { class: 'btn', type: 'button', onclick: () => admin(root, { params }) }, 'Try again')] })); return () => {};
  }

  if (attempt !== attempts) return () => {};
  const badge = (n, tone) => (n ? h('span', { class: `badge ${tone}`, 'aria-label': `${n} waiting` }, n > 99 ? '99+' : n) : null);
  const badgeFor = (key) => {
    if (key === 'moderation') return badge(overview.queues.review, 'warn');
    if (key === 'reports') return badge(overview.queues.reports, 'bad');
    if (key === 'feeds') return badge(overview.feeds.failing, 'bad');
    if (key === 'discovery' && overview.discovery) return badge(overview.discovery.pending, 'info');
    if (key === 'identities' && overview.identity) return badge(overview.identity.pending, 'info');
    return null;
  };
  const byKey = new Map(TABS.map((t) => [t[0], t]));
  const link = (key, extra = {}) => { const t = byKey.get(key); return h('a', { href: href(`/admin/${key}`), 'aria-current': key === tabKey ? 'page' : null, ...extra }, icon(t[2], 'sm'), t[1], badgeFor(key)); };

  // Desktop: the grouped sidebar.
  const side = h('nav', { class: 'adm-side', 'aria-label': 'Admin sections' },
    GROUPS.map(([groupLabel, keys]) => h('section', { class: 'adm-group' }, h('h4', null, groupLabel), keys.map((key) => (byKey.get(key) ? link(key) : null)))));

  // Phone: four sections one tap away, the rest behind "More". Badges show what is waiting.
  const moreBadgeN = TABS.filter((t) => !PHONE_NAV.includes(t[0])).reduce((n, t) => n + (['reports'].includes(t[0]) ? overview.queues.reports : 0), 0);
  const openMore = () => {
    const rest = GROUPS.map(([g, keys]) => [g, keys.filter((k) => !PHONE_NAV.includes(k))]).filter(([, keys]) => keys.length);
    const m = openModal({ title: 'All sections', body: h('nav', { class: 'a-more-list', 'aria-label': 'More admin sections' },
      rest.map(([g, keys]) => [h('h4', null, g), keys.map((k) => { const a = link(k); a.addEventListener('click', () => m.close()); return a; })]),
      h('h4', null, 'Site'), h('a', { href: href('/') , onclick: () => m.close() }, icon('home', 'sm'), 'Back to PRISM')), actions: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Close')] });
  };
  const inPrimary = PHONE_NAV.includes(tabKey);
  const tabbar = h('nav', { class: 'a-tabbar', 'aria-label': 'Admin sections' },
    PHONE_NAV.map((key) => { const t = byKey.get(key); return h('a', { href: href(`/admin/${key}`), 'aria-current': key === tabKey ? 'page' : null }, icon(t[2]), h('span', { class: 'l' }, key === 'moderation' ? 'Review' : t[1]), badgeFor(key)); }),
    h('button', { type: 'button', class: inPrimary ? '' : 'on', 'aria-haspopup': 'dialog', onclick: openMore, 'aria-label': inPrimary ? 'More sections' : `${tab[1]}, more sections` }, icon('more'), h('span', { class: 'l' }, inPrimary ? 'More' : tab[1]), moreBadgeN ? h('span', { class: 'badge bad', 'aria-hidden': 'true' }, moreBadgeN) : null));

  const main = h('div', { class: 'adm-main', id: 'admin-content' });
  root.replaceChildren(h('div', { class: 'adm' }, h('a', { class: 'a-skip', href: '#admin-content', onclick: (e) => { e.preventDefault(); const t = main.querySelector('h1'); if (t) t.focus(); } }, 'Skip to content'), side, main, tabbar));

  if (overview.adminOpen) main.appendChild(h('div', { class: 'a-alert warn', role: 'alert' }, icon('alert', 'sm'), h('div', null, h('b', null, 'Admin is open. '), 'No ADMIN_KEY is set, so anyone who can reach this server can use this console. Fine for local development; set ADMIN_KEY before deploying.')));

  // The data volume: a full disk takes the database down (2026-11-03), so a warning, a pause or an unknown size is shown on every tab.
  const dk = overview.disk;
  if (dk && (!dk.known || dk.level !== 'ok')) {
    const text = !dk.known ? 'The data volume does not report its size, so the disk watchdog cannot protect it. Check the volume by hand (Railway → volume metrics).'
      : dk.level === 'paused' ? `Ingestion is paused: the data volume is ${dk.usedPct}% full (${dk.freeGb} GB free). It resumes by itself under ${dk.resumeAtPct}%.`
        : `The data volume is ${dk.usedPct}% full (${dk.freeGb} GB free). Ingestion pauses at ${dk.pauseAtPct}%.`;
    main.appendChild(h('div', { class: `a-alert ${dk.level === 'paused' || !dk.known ? 'bad' : 'warn'}`, role: 'alert' }, icon('alert', 'sm'), h('div', null, h('b', null, !dk.known ? 'Disk size unknown. ' : dk.level === 'paused' ? 'Disk almost full. ' : 'Disk filling up. '), text)));
  }

  let cleanup = () => {};
  const body = main;
  try {
    const mod = await tab[3]();
    const out = await mod.render(body, { overview });
    if (typeof out === 'function') cleanup = out;
  } catch (e) {
    console.error(e);
    body.appendChild(emptyState({ icon: 'alert', title: 'This section failed to load', text: e instanceof ApiError ? e.message : String(e.message || e), actions: [h('button', { class: 'btn', type: 'button', onclick: () => admin(root, { params }) }, 'Try again')] }));
  }
  // Keyboard and screen-reader order: after a section opens, the heading has the focus (without scrolling the page away).
  const h1 = body.querySelector('h1');
  if (h1 && document.activeElement === document.body) h1.focus({ preventScroll: true });
  return () => cleanup();
}

export { toast };
