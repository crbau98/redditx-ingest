import { h, icon, fmt } from './dom.js';
import { get } from './api.js';
import { navigate, href } from './router.js';

/**
 * Smart search: what people type ("hairy beard guys at the beach, videos this week") is read by
 * /api/understand into filters — tags, creator, type, time, source, sort — using the library's own
 * vocabulary. Anything it can't place stays as words for full-text search.
 */

const cache = new Map();
export async function understand(text) {
  const key = text.trim().toLowerCase();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  const p = get('/api/understand', { q: text.trim() }).catch(() => null);
  cache.set(key, p);
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return p;
}

/** Explore parameters for a typed query (falls back to plain words). */
export async function smartQuery(text) {
  const raw = String(text || '').trim();
  if (!raw) return {};
  const u = await understand(raw);
  if (!u || !u.understood) return { q: raw };
  return { ...u.query, smart: '1', raw };
}

export async function smartSearch(text) {
  navigate('/explore', await smartQuery(text));
}

/** Compact "what Enter will do" preview: chips for each understood piece. */
export function understoodChips(u, { small = true } = {}) {
  const chips = u.chips.map((c) => h('span', { class: `chip ${small ? 'sm ' : ''}u-chip u-${c.key}` }, c.label));
  if (u.text) chips.push(h('span', { class: `chip ${small ? 'sm ' : ''}u-chip u-text` }, `“${u.text}”`));
  return chips;
}

const SINCE_LABEL = { day: 'Past day', week: 'Past week', month: 'Past month', year: 'Past year' };
const TYPE_LABEL = { video: 'Videos', image: 'Photos' };

/**
 * Filters to try dropping, least important first, when a search finds nothing.
 * Each step is {patch, label} where label names what was dropped.
 */
export function relaxations(f, { creatorName } = {}) {
  const steps = [];
  if (f.since) steps.push({ patch: { since: '' }, label: SINCE_LABEL[f.since] || f.since });
  if (f.platform) steps.push({ patch: { platform: '' }, label: `only ${f.platform}` });
  if (f.type) steps.push({ patch: { type: '' }, label: `only ${TYPE_LABEL[f.type] || f.type}` });
  const tags = f.tags ? f.tags.split(',').filter(Boolean) : [];
  for (let i = tags.length - 1; i >= 1; i--) steps.push({ patch: { tags: tags.slice(0, i).join(',') }, label: `#${tags[i]}` });
  if (f.community) steps.push({ patch: { community: '' }, label: f.community });
  if (f.q && (tags.length || f.creator || f.tag)) steps.push({ patch: { q: '' }, label: `“${f.q}”` });
  if (f.creator) steps.push({ patch: { creator: '' }, label: creatorName ? `by ${creatorName}` : 'the creator' });
  return steps;
}

/** First relaxation that returns results: {patch, label, total} or null. Probes in order, cheaply. */
export async function findRelaxation(f, toApi, opts) {
  let acc = {};
  const dropped = [];
  for (const step of relaxations(f, opts)) {
    acc = { ...acc, ...step.patch };
    dropped.push(step.label);
    try {
      const r = await get('/api/media', { ...toApi({ ...f, ...acc }), limit: 1 });
      if (r.total) return { patch: acc, label: dropped.join(', '), total: r.total };
    } catch { return null; }
  }
  return null;
}

/** Rail of tags that often appear alongside the given ones; click refines (adds an AND tag). */
export function relatedRail(tagNames, { onPick, title = 'Related' } = {}) {
  const el = h('div', { class: 'related-rail', hidden: true });
  get('/api/tags/related', { tags: tagNames.join(','), limit: 14 }).then((list) => {
    if (!list.length) return;
    el.replaceChildren(h('span', { class: 'rr-label' }, icon('sparkle', 'sm'), title),
      ...list.map((t) => h('a', { class: 'chip sm', href: onPick ? '#' : href('/explore', { tag: t.name }), onclick: onPick ? (e) => { e.preventDefault(); onPick(t.name); } : null, title: `${fmt.num(t.count)} items together · ${t.lift.toFixed(1)}× more likely` }, icon('plus', 'sm'), `#${t.name}`)));
    el.hidden = false;
  }).catch(() => {});
  return el;
}
