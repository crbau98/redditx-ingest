import { h, icon, openModal } from '../dom.js';
import { href } from '../router.js';
import { openPalette, surpriseMe } from './palette.js';
import { openDisplaySettings } from './display.js';
import { openTakedownForm } from './report.js';

/**
 * Phone "more" sheet. The tab bar has room for five destinations; everything else
 * (Browse, the galaxy map, collections, history, settings, admin) used to live only in
 * the footer, which an infinite feed never lets you reach.
 */
export function openMenu() {
  let m;
  const run = (fn) => () => { m.close(); fn(); };
  const link = (ic, label, sub, to) => h('a', { class: 'menu-item', href: to, onclick: () => m.close() }, h('span', { class: 'menu-ico' }, icon(ic)), h('span', { class: 'menu-txt' }, h('b', null, label), sub ? h('small', null, sub) : null));
  const action = (ic, label, sub, fn) => h('button', { class: 'menu-item', onclick: run(fn) }, h('span', { class: 'menu-ico' }, icon(ic)), h('span', { class: 'menu-txt' }, h('b', null, label), sub ? h('small', null, sub) : null));
  m = openModal({
    title: 'More',
    body: h('div', { class: 'menu-grid' },
      link('layers', 'Browse', 'Tags, sources, communities', href('/browse')),
      link('sparkle', 'Creator galaxy', 'Map of who posts alike', href('/galaxy')),
      link('folder', 'Collections', null, href('/saved', { tab: 'collections' })),
      link('history', 'History', 'What you opened', href('/saved', { tab: 'history' })),
      action('shuffle', 'Surprise me', 'Open something random', surpriseMe),
      action('command', 'Find anything', 'Creators, tags, actions', openPalette),
      action('palette', 'Display', 'Theme, accent, grid', openDisplaySettings),
      action('flag', 'Report content', 'Takedown request', openTakedownForm),
      link('sliders', 'Admin', null, href('/admin'))),
  });
  return m;
}
