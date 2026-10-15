import { h, icon, openModal } from '../dom.js';
import { href } from '../router.js';
import { openPalette, surpriseMe } from './palette.js';
import { openDisplaySettings } from './display.js';
import { openTakedownForm } from './report.js';
import { repaintFollowBadges } from '../following.js';

/**
 * Phone "more" sheet. The tab bar has room for five destinations; everything else
 * (Find, Browse, the galaxy map, collections, history, settings, admin) used to live only in
 * the footer, which an infinite feed never lets you reach.
 */
export function openMenu() {
  let m;
  const run = (fn) => () => { m.close(); fn(); };
  const link = (ic, label, sub, to) => h('a', { class: 'menu-item', href: to, onclick: () => m.close() }, h('span', { class: 'menu-ico' }, icon(ic), to === href('/following') ? h('span', { class: 'badge follow-badge', hidden: true, dataset: { followBadge: 'count' } }) : null), h('span', { class: 'menu-txt' }, h('b', null, label), sub ? h('small', null, sub) : null));
  const action = (ic, label, sub, fn, hint) => h('button', { class: 'menu-item', onclick: run(fn), title: hint || label }, h('span', { class: 'menu-ico' }, icon(ic)), h('span', { class: 'menu-txt' }, h('b', null, label), sub ? h('small', null, sub) : null));
  const group = (label) => h('div', { class: 'menu-group', 'aria-hidden': 'true' }, label);
  m = openModal({
    title: 'More',
    body: h('div', { class: 'menu-stack' },
      group('Find & explore'),
      h('div', { class: 'menu-grid' },
        link('search', 'Find a creator', 'Name, @handle or link', href('/find')),
        link('rss', 'Following', 'New from creators you follow', href('/following')),
        link('layers', 'Browse', 'Tags, sources, communities', href('/browse')),
        link('sparkle', 'Creator galaxy', 'Map of who posts alike', href('/galaxy'))),
      group('Your library'),
      h('div', { class: 'menu-grid' },
        link('folder', 'Collections', 'Grouped saves', href('/saved', { tab: 'collections' })),
        link('history', 'History', 'What you opened', href('/saved', { tab: 'history' })),
        action('shuffle', 'Surprise me', 'Open something random', surpriseMe, 'Surprise me (X)'),
        action('command', 'Find anything', 'Creators, tags, actions (Ctrl/⌘ K)', openPalette, 'Command palette (Ctrl/⌘ K)')),
      group('Settings & help'),
      h('div', { class: 'menu-grid' },
        action('palette', 'Display', 'Theme, accent, grid', openDisplaySettings),
        action('flag', 'Report content', 'Takedown request', openTakedownForm),
        link('sliders', 'Admin', 'Sources & curation', href('/admin')))),
  });
  repaintFollowBadges();
  return m;
}
