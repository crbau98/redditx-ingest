import { h, icon, avatar, openModal } from '../dom.js';
import { get } from '../api.js';
import { href } from '../router.js';
import { platformLabel, platformColor } from '../store.js';

/*
 * "Where else he posts": every account and page a creator is known by, in one sheet. Free
 * accounts PRISM follows come first, then paid pages (link-outs only), then his other links.
 */

const PAID = /onlyfans\.com|fansly\.com|justfor\.fans|manyvids\.com|clips4sale\.com|loyalfans\.com|fancentro\.com|fanvue\.com|patreon\.com|throne\.com/i;
const PAID_NAMES = [['onlyfans.com', 'OnlyFans'], ['fansly.com', 'Fansly'], ['justfor.fans', 'JustFor.Fans'], ['manyvids.com', 'ManyVids'], ['clips4sale.com', 'Clips4Sale'], ['loyalfans.com', 'LoyalFans'], ['fancentro.com', 'FanCentro'], ['fanvue.com', 'Fanvue'], ['patreon.com', 'Patreon'], ['throne.com', 'Throne']];
const paidName = (url) => (PAID_NAMES.find(([d]) => String(url).toLowerCase().includes(d)) || [])[1];
const clean = (s) => String(s || '').replace(/^[@/]?(?:u\/)?/, '');

const out = (url, ...children) => h('a', { class: 'where-row', href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, ...children, icon('external', 'sm'));

export async function openElsewhere(creatorId, { name, onNavigate } = {}) {
  const body = h('div', { class: 'where-body' }, h('div', { class: 'spinner' }));
  const m = openModal({ title: name ? `Where else ${name} posts` : 'Where else he posts', body });
  let c;
  try { c = await get(`/api/creators/${creatorId}`); } catch (e) {
    body.replaceChildren(h('p', { class: 'muted' }, e.status === 404 ? 'This creator is no longer listed.' : e.message));
    return m;
  }
  const accounts = (c.accounts || []).filter((a) => a.url);
  const links = (c.links || []).filter((l) => l && l.url && !accounts.some((a) => a.url === l.url));
  const paid = links.filter((l) => PAID.test(l.url));
  const other = links.filter((l) => !PAID.test(l.url));
  const of = c.onlyfans;
  if (of && !paid.some((l) => /onlyfans\.com/i.test(l.url))) paid.unshift({ url: of.url, label: of.handle, free: of.free });

  const group = (title, sub, rows) => (rows.length ? h('section', { class: 'where-group' }, h('h4', null, title, sub ? h('small', null, sub) : null), rows) : null);
  const groups = [
    group('Free accounts', 'PRISM brings these in', accounts.map((a) => out(a.url,
      h('span', { class: 'where-dot', style: { '--c': platformColor(a.platform) } }),
      h('span', { class: 'where-txt' }, h('b', null, platformLabel(a.platform)), h('small', null, clean(a.label)))))),
    group('Paid pages', 'Opens the creator’s own page', paid.map((l) => out(l.url,
      h('span', { class: 'where-dot paid' }),
      h('span', { class: 'where-txt' }, h('b', null, paidName(l.url) || l.service || 'Page'), h('small', null, clean(l.handle || l.label) || l.url)),
      l.free || (of && of.free && /onlyfans\.com/i.test(l.url)) ? h('span', { class: 'badge good' }, 'Free tier') : null))),
    group('Other links', null, other.map((l) => out(l.url,
      h('span', { class: 'where-dot link' }, icon('link', 'sm')),
      h('span', { class: 'where-txt' }, h('b', null, l.service || l.label || 'Link'), h('small', null, l.label && l.label !== l.service ? l.label : l.url))))),
  ].filter(Boolean);

  body.replaceChildren(
    h('a', { class: 'where-head', href: href(`/creator/${c.id}`), onclick: () => { m.close(); if (onNavigate) onNavigate(); } },
      avatar(c, 44), h('span', { class: 'where-txt' }, h('b', null, c.display_name || c.handle), h('small', null, `@${c.handle} · open profile`)), icon('chev-r', 'sm')),
    ...(groups.length ? groups : [h('p', { class: 'muted' }, 'No other accounts or pages are known for him yet.')]));
  return m;
}
