import { h, icon, toast, emptyState } from '../../dom.js';
import { adminGet, ApiError } from '../../api.js';
import { adminSession } from '../../store.js';
import { href, navigate } from '../../router.js';

const TABS = [
  ['overview', 'Needs attention', 'layers', () => import('./overview.js')],
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

// The console's stylesheet arrives with the console: public pages never download it. Resolved from
// this module's own URL, so it shares the deploy's versioned (immutable) prefix.
let styles = null;
export function adminStyles() {
  if (!styles) {
    styles = new Promise((resolve) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = new URL('../../../css/admin.css', import.meta.url).href;
      l.onload = l.onerror = () => resolve();
      document.head.appendChild(l);
    });
  }
  return styles;
}

let attempts = 0;
export async function admin(root, { params }) {
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
    root.replaceChildren(emptyState({ icon: 'alert', title: 'Couldn’t reach the admin API', text: e.message })); return () => {};
  }

  if (attempt !== attempts) return () => {};
  const badge = (n, tone) => (n ? h('span', { class: `badge ${tone}` }, n > 99 ? '99+' : n) : null);
  const badgeFor = (key) => {
    if (key === 'moderation') return badge(overview.queues.review, 'warn');
    if (key === 'reports') return badge(overview.queues.reports, 'bad');
    if (key === 'feeds') return badge(overview.feeds.failing, 'bad');
    if (key === 'discovery' && overview.discovery) return badge(overview.discovery.pending, 'info');
    if (key === 'identities' && overview.identity) return badge(overview.identity.pending, 'info');
    return null;
  };
  const byKey = new Map(TABS.map((t) => [t[0], t]));
  const side = h('nav', { class: 'adm-side', 'aria-label': 'Admin sections' },
    GROUPS.map(([groupLabel, keys]) => h('section', { class: 'adm-group' },
      h('h4', null, groupLabel),
      keys.map((key) => {
        const t = byKey.get(key);
        return t ? h('a', { href: href(`/admin/${key}`), 'aria-current': key === tabKey ? 'page' : null }, icon(t[2], 'sm'), t[1], badgeFor(key)) : null;
      }))));
  const main = h('div', { class: 'adm-main' });
  root.replaceChildren(h('div', { class: 'adm' }, side, main));

  if (overview.adminOpen) main.appendChild(h('div', { class: 'panel', style: { borderColor: 'var(--warn)' } }, h('b', null, 'Admin is open. '), 'No ADMIN_KEY is set, so anyone who can reach this server can use this console. Fine for local development; set ADMIN_KEY before deploying.'));

  let cleanup = () => {};
  try {
    const mod = await tab[3]();
    const out = await mod.render(main, { overview });
    if (typeof out === 'function') cleanup = out;
  } catch (e) {
    console.error(e);
    main.appendChild(emptyState({ icon: 'alert', title: 'This section failed to load', text: e instanceof ApiError ? e.message : String(e.message || e) }));
  }
  return () => cleanup();
}

export { toast };
