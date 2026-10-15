import { h, icon, fmt } from '../dom.js';
import { get } from '../api.js';
import { platformLabel, platformColor } from '../store.js';
import { paidPages } from './elsewhere.js';

/*
 * The platform switcher on a creator's page: one row of pills (All, then every platform PRISM
 * has his posts from, busiest first) that filters his feed, and link-out cards for his paid
 * pages (OnlyFans, Fansly, JustFor.Fans...) with the price and whether a free tier exists.
 * Paid pages are link-outs only: PRISM never shows what is behind them.
 *
 *   platformSwitcher(creator, { value: 'reddit' | '', onChange: (platform) => {} }) -> element
 */

const count = (n) => h('span', { class: 'ps-n' }, fmt.int(n));

function pills(list, total, value, onChange) {
  const opts = [{ id: '', label: 'All', n: total }, ...list.map((p) => ({ id: p.platform, label: platformLabel(p.platform), n: p.n }))];
  // a filter set to a platform he no longer has still shows, so it can be switched off
  if (value && !opts.some((o) => o.id === value)) opts.push({ id: value, label: platformLabel(value), n: 0 });
  const row = h('div', { class: 'ps-pills', role: 'radiogroup', 'aria-label': 'Show posts from' });
  const buttons = opts.map((o) => {
    const on = o.id === (value || '');
    return h('button', {
      type: 'button', class: `ps-pill${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', 'data-platform': o.id,
      title: o.id ? `Only his ${o.label} posts` : 'Posts from every platform',
      onclick: () => { if (!on) onChange(o.id); },
    }, o.id ? h('span', { class: 'ps-dot', style: { '--c': platformColor(o.id) } }) : icon('grid', 'sm'), h('span', { class: 'ps-label' }, o.label), count(o.n));
  });
  // arrow keys move between pills (and pick, as radios do); Home and End jump to the ends
  row.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const b = buttons[(to + buttons.length) % buttons.length];
    b.focus();
    b.click();
  });
  row.append(...buttons);
  return row;
}

function paidCards(pages) {
  if (!pages.length) return null;
  const paidTone = (name) => (/onlyfans/i.test(name) ? ' of' : /fansly/i.test(name) ? ' fansly' : /justfor\.?fans|^jff$/i.test(name) ? ' jff' : '');
  return h('div', { class: 'ps-paid', role: 'list', 'aria-label': 'Paid pages' }, pages.map((p) => h('a', {
    class: `ps-card${paidTone(p.name)}`, role: 'listitem', href: p.url, target: '_blank', rel: 'noopener noreferrer nofollow',
    title: `Opens ${p.name} in a new tab`,
  },
  h('span', { class: 'ps-card-txt' }, h('b', null, p.name), p.handle ? h('small', null, `@${p.handle}`) : null),
  h('span', { class: 'ps-card-meta' },
    p.free ? h('span', { class: 'badge good' }, 'Free tier') : null,
    p.price ? h('span', { class: 'ps-price' }, String(p.price)) : null),
  icon('external', 'sm'))));
}

export function platformSwitcher(c, { value = '', onChange = () => {} } = {}) {
  const el = h('div', { class: 'ps', 'data-creator': c.id });
  const paid = paidCards(paidPages(c));
  // until counts arrive, show the cards so the row doesn't jump twice
  if (paid) el.append(paid);
  get(`/api/creators/${c.id}/activity`).then((a) => {
    const list = (a.platforms || []).filter((p) => p.platform && p.n > 0);
    const total = list.reduce((s, p) => s + p.n, 0);
    // one platform and no filter set: nothing to switch between
    if (list.length < 2 && !value) return;
    el.prepend(pills(list, total, value, onChange));
  }).catch(() => {});
  return el;
}
