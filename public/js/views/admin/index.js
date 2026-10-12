import { h, icon, toast, emptyState } from '../../dom.js';
import { adminGet, ApiError } from '../../api.js';
import { adminSession } from '../../store.js';
import { href, navigate } from '../../router.js';

const TABS = [
  ['overview', 'Overview', 'layers', () => import('./overview.js')],
  ['feeds', 'Feeds', 'rss', () => import('./feeds.js')],
  ['creators', 'Creators', 'users', () => import('./creators.js')],
  ['moderation', 'Review queue', 'shield', () => import('./moderation.js')],
  ['reports', 'Reports', 'flag', () => import('./reports.js')],
  ['media', 'Media', 'image', () => import('./media.js')],
  ['sources', 'Sources', 'compass', () => import('./sources.js')],
  ['live', 'Live log', 'bolt', () => import('./live.js')],
  ['blocklist', 'Blocklist', 'lock', () => import('./blocklist.js')],
  ['audit', 'Audit log', 'clock', () => import('./audit.js')],
  ['settings', 'Settings', 'sliders', () => import('./settings.js')],
];

function keyGate(root, message, retry) {
  const input = h('input', { class: 'input', type: 'password', placeholder: 'Admin key', autocomplete: 'current-password', 'aria-label': 'Admin key' });
  const go = () => { adminSession.key = input.value.trim(); retry(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  root.replaceChildren(h('div', { class: 'panel keycard stack' },
    h('div', { class: 'empty', style: { padding: '8px' } }, h('div', { class: 'ico' }, icon('lock')), h('h3', null, 'Admin console'), h('p', null, message)),
    input, h('button', { class: 'btn primary lg', onclick: go }, 'Unlock')));
  setTimeout(() => input.focus(), 30);
}

export async function admin(root, { params }) {
  document.title = 'Admin — PRISM';
  const tabKey = params.tab || 'overview';
  const tab = TABS.find((t) => t[0] === tabKey);
  if (!tab) { navigate('/admin/overview', {}, { replace: true }); return () => {}; }

  let overview;
  try { overview = await adminGet('/overview'); } catch (e) {
    if (e.status === 401) { adminSession.key = ''; keyGate(root, adminSession.key ? 'That key was not accepted.' : 'Enter the ADMIN_KEY to continue.', () => admin(root, { params })); return () => {}; }
    if (e.status === 503) { root.replaceChildren(emptyState({ icon: 'lock', title: 'Admin is disabled', text: 'Set the ADMIN_KEY environment variable on the server (or ADMIN_OPEN=true for a private dev box), then reload.' })); return () => {}; }
    root.replaceChildren(emptyState({ icon: 'alert', title: 'Couldn’t reach the admin API', text: e.message })); return () => {};
  }

  const badge = (n, tone) => (n ? h('span', { class: `badge ${tone}` }, n > 99 ? '99+' : n) : null);
  const side = h('nav', { class: 'adm-side', 'aria-label': 'Admin sections' },
    h('h4', null, 'Manage'),
    TABS.map(([key, label, ic]) => h('a', { href: href(`/admin/${key}`), 'aria-current': key === tabKey ? 'page' : null }, icon(ic, 'sm'), label,
      key === 'moderation' ? badge(overview.queues.review, 'warn') : key === 'reports' ? badge(overview.queues.reports, 'bad') : key === 'feeds' ? badge(overview.feeds.failing, 'bad') : null)));
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
