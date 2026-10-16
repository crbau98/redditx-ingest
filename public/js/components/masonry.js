import { h } from '../dom.js';
import { releaseCard } from './card.js';

const MIN_COL = { s: 150, m: 215, l: 310 };
const MIN_COL_PHONE = { s: 100, m: 155, l: 330 }; // phones: dense/cozy = 3/2 columns, large = 1
const GAP = { s: 8, m: 14, l: 16 };
// Beyond the card bitmap release (~2400px): shells this far from the viewport drop their live
// card DOM and keep only a height spacer, so a long feed does not hold hundreds of nodes.
const WINDOW_PX = 3600;
const STAGGER_CAP = 8;

/**
 * Shortest-column masonry driven by known aspect ratios, so appending a page
 * never reshuffles what is already on screen and nothing jumps while images
 * load. Heights are estimated from width/height metadata (no DOM measuring).
 */
export function createMasonry({ density = 'm', render }) {
  const el = h('div', { class: `masonry density-${density}` });
  let all = [];
  let cols = [];
  let heights = [];
  let colCount = 0;
  let colWidth = 0;
  let lastWidth = 0;
  let cur = density;

  const measureWidth = (hint = 0) => Math.round(hint || el.clientWidth || el.parentElement?.clientWidth || window.innerWidth);

  const count = (w = measureWidth()) => {
    const gap = GAP[cur];
    const min = (w < 640 ? MIN_COL_PHONE : MIN_COL)[cur];
    return Math.max(1, Math.min(8, Math.floor((w + gap) / (min + gap))));
  };

  const estimate = (item) => {
    const r = item.width && item.height ? Math.min(Math.max(item.height / item.width, 0.52), 1.8) : 1.25;
    return colWidth * r; // the caption sits over the image (v4.16), so a card is exactly its media
  };

  const motionOk = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    && !(navigator.connection && navigator.connection.saveData);

  function tag(node, item, est) {
    node._masonryItem = item;
    node._est = est;
  }

  function restore(shell, { focus = false } = {}) {
    if (!shell.isConnected || !shell.classList.contains('card-parked') || !shell._masonryItem) return;
    const fresh = render(shell._masonryItem, cur, { eager: false });
    fresh.style.containIntrinsicSize = shell.style.containIntrinsicSize;
    tag(fresh, shell._masonryItem, shell._est);
    if (windowIo) windowIo.unobserve(shell);
    shell.replaceWith(fresh);
    if (windowIo) windowIo.observe(fresh);
    if (focus) {
      const next = fresh.querySelector('a, button');
      if (next) next.focus({ preventScroll: true });
    }
  }

  function park(card) {
    if (!card || !card.isConnected || card.classList.contains('card-parked') || !card._masonryItem) return;
    if (card.contains(document.activeElement)) return;
    const item = card._masonryItem;
    const px = Math.round(card.offsetHeight || card._est || 240);
    const shell = h('article', {
      class: `card card-parked${card.classList.contains('compact') ? ' compact' : ''}`,
      dataset: { id: item.id },
      tabindex: '0',
      'aria-label': item.title || 'Load post',
      style: { height: `${px}px`, containIntrinsicSize: card.style.containIntrinsicSize || `auto ${px}px` },
    });
    tag(shell, item, card._est || px);
    shell.addEventListener('focus', () => restore(shell, { focus: true }));
    if (windowIo) windowIo.unobserve(card);
    releaseCard(card);
    card.replaceWith(shell);
    if (windowIo) windowIo.observe(shell);
  }

  const windowIo = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        const node = e.target;
        if (e.isIntersecting) restore(node);
        else park(node);
      }
    }, { rootMargin: `${WINDOW_PX}px 0px`, threshold: 0 })
    : null;

  function watch(node) { if (windowIo) windowIo.observe(node); }

  function releaseAll() {
    for (const col of cols) {
      for (const child of col.children) {
        if (windowIo) windowIo.unobserve(child);
        releaseCard(child);
      }
    }
  }

  function build(wHint = 0) {
    releaseAll();
    el.textContent = '';
    const w = measureWidth(wHint);
    lastWidth = w;
    colCount = count(w);
    colWidth = (w - (colCount - 1) * GAP[cur]) / colCount;
    cols = Array.from({ length: colCount }, () => h('div', { class: 'masonry-col' }));
    heights = new Array(colCount).fill(0);
    el.append(...cols);
  }

  function place(items, { first = false, stagger = true } = {}) {
    if (!items.length || !colCount) return;
    const arrive = stagger && motionOk();
    let staggerN = 0;
    let index = 0;
    const origin = el.isConnected ? el.getBoundingClientRect().top + window.scrollY : 0;
    const viewTop = window.scrollY - WINDOW_PX;
    const viewBot = window.scrollY + (window.innerHeight || 800) + WINDOW_PX;
    const frags = cols.map(() => document.createDocumentFragment());
    for (const item of items) {
      let target = 0;
      for (let i = 1; i < colCount; i++) if (heights[i] < heights[target]) target = i;
      const est = estimate(item);
      const top = origin + heights[target];
      const far = el.isConnected && (top > viewBot || top + est < viewTop);
      const eager = first && !far && index < colCount;
      let card;
      if (far) {
        const px = Math.round(est);
        card = h('article', {
          class: 'card card-parked',
          dataset: { id: item.id },
          tabindex: '0',
          'aria-label': item.title || 'Load post',
          style: { height: `${px}px`, containIntrinsicSize: `auto ${px}px` },
        });
        tag(card, item, est);
        card.addEventListener('focus', () => restore(card, { focus: true }));
      } else {
        card = render(item, cur, { eager });
        card.style.containIntrinsicSize = `auto ${Math.round(est)}px`;
        tag(card, item, est);
        if (arrive && staggerN < STAGGER_CAP) {
          card.classList.add('card-arrive');
          card.style.animationDelay = `calc(var(--dur-quick) * ${staggerN} / 4)`;
          staggerN++;
        }
      }
      frags[target].appendChild(card);
      heights[target] += est + GAP[cur];
      index++;
    }
    for (let i = 0; i < colCount; i++) {
      if (!frags[i].childNodes.length) continue;
      const nodes = [...frags[i].childNodes];
      cols[i].appendChild(frags[i]);
      for (const node of nodes) watch(node);
    }
  }

  const ro = 'ResizeObserver' in window ? new ResizeObserver((entries) => {
    if (!el.isConnected) return;
    const w = Math.round(entries[0]?.contentRect?.width || 0);
    if (!w || w === lastWidth) return;
    lastWidth = w;
    if (count(w) !== colCount && all.length) { build(w); place(all, { stagger: false }); }
  }) : null;
  if (ro) ro.observe(el);

  return {
    el,
    get items() { return all; },
    add(items) {
      const first = all.length === 0;
      if (!cols.length) build();
      all = all.concat(items);
      place(items, { first });
    },
    clear() {
      releaseAll();
      all = []; el.textContent = ''; cols = []; heights = []; lastWidth = 0;
    },
    setDensity(d) {
      cur = d; el.className = `masonry density-${d}`;
      if (all.length) { build(lastWidth); place(all, { stagger: false }); }
    },
    destroy() {
      releaseAll();
      if (ro) ro.disconnect();
      if (windowIo) windowIo.disconnect();
    },
  };
}
