import { h } from '../dom.js';

const MIN_COL = { s: 150, m: 215, l: 310 };
const MIN_COL_PHONE = { s: 100, m: 155, l: 330 }; // phones: dense/cozy = 3/2 columns, large = 1
const GAP = { s: 8, m: 14, l: 16 };

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
  let cur = density;

  const count = () => {
    const w = el.clientWidth || el.parentElement?.clientWidth || window.innerWidth;
    const gap = GAP[cur];
    const min = (w < 640 ? MIN_COL_PHONE : MIN_COL)[cur];
    return Math.max(1, Math.min(8, Math.floor((w + gap) / (min + gap))));
  };

  const estimate = (item) => {
    const r = item.width && item.height ? Math.min(Math.max(item.height / item.width, 0.52), 1.8) : 1.25;
    return colWidth * r + (cur === 's' ? 0 : 64);
  };

  function build() {
    el.textContent = '';
    colCount = count();
    const w = el.clientWidth || window.innerWidth;
    colWidth = (w - (colCount - 1) * GAP[cur]) / colCount;
    cols = Array.from({ length: colCount }, () => h('div', { class: 'masonry-col' }));
    heights = new Array(colCount).fill(0);
    el.append(...cols);
  }

  function place(items) {
    for (const item of items) {
      let target = 0;
      for (let i = 1; i < colCount; i++) if (heights[i] < heights[target]) target = i;
      const est = estimate(item);
      const card = render(item, cur);
      // the size a card stands in for while the browser skips rendering it off-screen (see app.css)
      card.style.containIntrinsicSize = `auto ${Math.round(est)}px`;
      cols[target].appendChild(card);
      heights[target] += est + GAP[cur];
    }
  }

  const ro = 'ResizeObserver' in window ? new ResizeObserver(() => {
    if (!el.isConnected) return;
    if (count() !== colCount && all.length) { build(); place(all); }
  }) : null;
  if (ro) ro.observe(el);

  return {
    el,
    get items() { return all; },
    add(items) {
      if (!cols.length) build();
      all = all.concat(items);
      place(items);
    },
    clear() { all = []; el.textContent = ''; cols = []; heights = []; },
    setDensity(d) {
      cur = d; el.className = `masonry density-${d}`;
      if (all.length) { build(); place(all); }
    },
    destroy() { if (ro) ro.disconnect(); },
  };
}
