import { h, icon, proxied, fmt, emptyState, debounce } from '../dom.js';
import { get } from '../api.js';
import { navigate, href, parse } from '../router.js';
import { gpuTier } from '../components/fx.js';

/**
 * Galaxy: every active creator as a star, linked to the creators whose posts they most
 * resemble, laid out in 3D by a force simulation and drawn on a 2D canvas with perspective.
 * Drag to rotate, wheel/pinch to zoom, hover (or tap) for a card, click to open, search to fly.
 * Avatars become pre-rendered glowing sprites, so a frame is just a few hundred drawImage calls.
 */

const HUES = [330, 268, 200, 160, 32, 52, 290, 12];

/** 3D force-directed layout (O(n²) repulsion is fine for a few hundred nodes). */
function layout(n, edges, iters = 320) {
  const p = new Float32Array(n * 3);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) { p[i * 3] = rnd(); p[i * 3 + 1] = rnd(); p[i * 3 + 2] = rnd(); }
  const d = new Float32Array(n * 3);
  const REP = 0.022; const LEN = 0.38; const SPRING = 0.07;
  for (let it = 0; it < iters; it++) {
    const alpha = 1 - it / iters;
    d.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = p[i * 3] - p[j * 3]; const dy = p[i * 3 + 1] - p[j * 3 + 1]; const dz = p[i * 3 + 2] - p[j * 3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz + 0.004;
        const f = REP / d2;
        d[i * 3] += dx * f; d[i * 3 + 1] += dy * f; d[i * 3 + 2] += dz * f;
        d[j * 3] -= dx * f; d[j * 3 + 1] -= dy * f; d[j * 3 + 2] -= dz * f;
      }
    }
    for (const [a, b, w] of edges) {
      const dx = p[b * 3] - p[a * 3]; const dy = p[b * 3 + 1] - p[a * 3 + 1]; const dz = p[b * 3 + 2] - p[a * 3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
      const f = ((dist - LEN) * SPRING * (0.4 + w)) / dist;
      d[a * 3] += dx * f; d[a * 3 + 1] += dy * f; d[a * 3 + 2] += dz * f;
      d[b * 3] -= dx * f; d[b * 3 + 1] -= dy * f; d[b * 3 + 2] -= dz * f;
    }
    for (let i = 0; i < n * 3; i++) {
      const v = d[i] - p[i] * 0.012; // gentle pull to the centre
      p[i] += Math.max(-0.08, Math.min(0.08, v)) * (0.25 + alpha);
    }
  }
  // centre and fit inside a unit sphere
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += p[i * 3 + k] / n;
  let max = 0;
  for (let i = 0; i < n; i++) { for (let k = 0; k < 3; k++) p[i * 3 + k] -= c[k]; max = Math.max(max, Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2])); }
  for (let i = 0; i < n * 3; i++) p[i] /= max || 1;
  return p;
}

/** A glowing round sprite: the creator's avatar (or best preview) inside a ring of their group colour. */
function makeSprite(node, color) {
  const S = 128; const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d');
  const paint = (img) => {
    g.clearRect(0, 0, S, S);
    g.save(); g.shadowColor = color; g.shadowBlur = 26;
    g.beginPath(); g.arc(S / 2, S / 2, 38, 0, Math.PI * 2); g.fillStyle = color; g.fill(); g.restore();
    g.save(); g.beginPath(); g.arc(S / 2, S / 2, 34, 0, Math.PI * 2); g.clip();
    if (img) {
      const r = Math.max(68 / img.width, 68 / img.height);
      g.drawImage(img, S / 2 - (img.width * r) / 2, S / 2 - (img.height * r) / 2, img.width * r, img.height * r);
    } else {
      const grd = g.createLinearGradient(0, 0, S, S); grd.addColorStop(0, '#2a2140'); grd.addColorStop(1, '#151422');
      g.fillStyle = grd; g.fillRect(0, 0, S, S);
      g.fillStyle = '#fff'; g.font = '700 30px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(((node.display_name || node.handle || '?').replace(/^[^A-Za-z0-9]+/, '')[0] || '?').toUpperCase(), S / 2, S / 2 + 1);
    }
    g.restore();
  };
  paint(null);
  const url = node.avatar_url || node.preview;
  if (url) { const img = new Image(); img.decoding = 'async'; img.onload = () => paint(img); img.src = proxied(url); }
  return c;
}

export async function galaxy(root) {
  document.title = 'Galaxy — PRISM';
  root.replaceChildren(h('div', { class: 'galaxy loading' }, h('div', { class: 'galaxy-loading' }, h('div', { class: 'spinner' }), 'Mapping the creator galaxy…')));
  document.body.classList.add('galaxy-mode');
  let data;
  let failed = null;
  try { data = await get('/api/graph'); } catch (e) { failed = e; }
  // Left the page while the graph was loading: the next view owns `root` now, so touch nothing.
  if (parse().path !== '/galaxy') { document.body.classList.remove('galaxy-mode'); return () => {}; }
  if (failed) {
    root.replaceChildren(emptyState({ icon: 'alert', title: 'Couldn’t load the galaxy', text: failed.message }));
    document.body.classList.remove('galaxy-mode');
    return () => {};
  }
  const nodes = data.nodes;
  if (nodes.length < 3) {
    document.body.classList.remove('galaxy-mode');
    root.replaceChildren(emptyState({ icon: 'sparkle', title: 'The galaxy needs more creators', text: 'Once a few creators have posted, they appear here as a 3D map of who posts alike.', actions: [h('a', { class: 'btn primary', href: href('/creators') }, 'Browse creators')] }));
    return () => {};
  }

  const N = nodes.length;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = data.links.map((l) => [index.get(l.source), index.get(l.target), l.weight]).filter((e) => e[0] !== undefined && e[1] !== undefined);
  const neighbours = nodes.map(() => new Set());
  for (const [a, b] of edges) { neighbours[a].add(b); neighbours[b].add(a); }
  const pos = layout(N, edges);

  // colour by dominant style tag: the 8 biggest groups get hues, the rest are "other"
  const groupCount = new Map();
  for (const n of nodes) if (n.group) groupCount.set(n.group, (groupCount.get(n.group) || 0) + 1);
  const topGroups = [...groupCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g]) => g);
  const colorOf = (g) => { const i = topGroups.indexOf(g); return i >= 0 ? `hsl(${HUES[i]} 85% 62%)` : 'hsl(240 10% 70%)'; };
  const sprites = nodes.map((n) => makeSprite(n, colorOf(n.group)));
  const maxCount = Math.max(...nodes.map((n) => n.media_count));
  const sizeOf = (n) => 0.55 + 0.75 * Math.sqrt(n.media_count / maxCount);

  // stars: a fixed, slightly rotating backdrop
  const stars = Array.from({ length: 260 }, () => { const u = Math.random() * 2 - 1; const t = Math.random() * Math.PI * 2; const r = Math.sqrt(1 - u * u); return [r * Math.cos(t) * 3, u * 3, r * Math.sin(t) * 3, Math.random() * 0.9 + 0.3]; });

  /* ------------------------------------------------------------------ DOM */
  const canvas = h('canvas', { class: 'galaxy-canvas', 'aria-label': `Map of ${N} creators. Use the search box or the list below to open one.`, role: 'img', tabindex: '0' });
  const card = h('div', { class: 'galaxy-card', hidden: true });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Find a creator in the galaxy…', 'aria-label': 'Find a creator' });
  const legend = h('div', { class: 'galaxy-legend' });
  const hint = h('div', { class: 'galaxy-hint' }, icon('sparkle', 'sm'), window.matchMedia('(pointer: coarse)').matches ? 'Drag to turn · pinch to zoom · tap a star' : 'Drag to turn · scroll to zoom · click a star to open');
  const shell = h('div', { class: 'galaxy' }, canvas,
    h('div', { class: 'galaxy-top' },
      h('div', null, h('h1', null, icon('sparkle'), 'Creator galaxy'), h('div', { class: 'sub' }, `${N} creators, linked by what they post · close stars post alike`)),
      h('div', { class: 'galaxy-search' }, icon('search', 'sm'), search)),
    legend, card, hint);
  root.replaceChildren(shell);

  /* --------------------------------------------------------------- state */
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const slow = gpuTier() === 'software';
  const cam = { yaw: 0.6, pitch: -0.25, zoom: shell.clientWidth < 640 ? 1.45 : 1, vy: reduced ? 0 : 0.00008, vp: 0 };
  let W = 0; let H = 0; let dpr = 1; const ctx = canvas.getContext('2d');
  let hover = -1; let selected = -1; let focusGroup = null; let matches = null;
  let fly = null; // {yaw, pitch, t0, from}
  const proj = new Float32Array(N * 4); // x, y, depth, scale
  const order = Array.from({ length: N }, (_, i) => i);

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, slow ? 1 : 2);
    W = shell.clientWidth; H = shell.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  };
  const project = (x, y, z, out, k) => {
    const cy = Math.cos(cam.yaw); const sy = Math.sin(cam.yaw); const cp = Math.cos(cam.pitch); const sp = Math.sin(cam.pitch);
    const x1 = x * cy - z * sy; const z1 = x * sy + z * cy;
    const y1 = y * cp - z1 * sp; const z2 = y * sp + z1 * cp;
    const D = 2.8; const s = D / (D + z2);
    const R = Math.min(W, H) * 0.42 * cam.zoom;
    out[k] = W / 2 + x1 * R * s; out[k + 1] = H / 2 + y1 * R * s; out[k + 2] = z2; out[k + 3] = s;
  };
  const tmp = new Float32Array(4);
  const visibleNode = (i) => (!focusGroup || nodes[i].group === focusGroup) && (!matches || matches.has(i));

  /* -------------------------------------------------------------- render */
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // stars
    for (const [x, y, z, b] of stars) {
      project(x, y, z, tmp, 0);
      if (tmp[2] < -2.5) continue;
      ctx.globalAlpha = b * 0.55 * Math.min(1, tmp[3]);
      ctx.fillStyle = '#fff';
      const r = 0.6 + b * 0.9;
      ctx.fillRect(tmp[0], tmp[1], r, r);
    }
    for (let i = 0; i < N; i++) project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], proj, i * 4);
    const focus = selected >= 0 ? selected : hover;
    // links
    ctx.lineWidth = 1;
    for (const [a, b, w] of edges) {
      const lit = focus >= 0 && (a === focus || b === focus);
      const dim = (focusGroup || matches) && !(visibleNode(a) && visibleNode(b));
      const depth = Math.min(proj[a * 4 + 3], proj[b * 4 + 3]);
      ctx.globalAlpha = lit ? 0.9 : dim ? 0.03 : (0.06 + w * 0.22) * depth * (focus >= 0 ? 0.45 : 1);
      ctx.strokeStyle = lit ? colorOf(nodes[focus].group) : '#b9b4ff';
      ctx.lineWidth = lit ? 1.6 : 1;
      ctx.beginPath(); ctx.moveTo(proj[a * 4], proj[a * 4 + 1]); ctx.lineTo(proj[b * 4], proj[b * 4 + 1]); ctx.stroke();
    }
    // stars (creators), back to front
    order.sort((a, b) => proj[b * 4 + 2] - proj[a * 4 + 2]);
    const base = Math.min(W, H) * 0.046 * Math.sqrt(cam.zoom);
    for (const i of order) {
      const s = proj[i * 4 + 3];
      const near = focus >= 0 && (i === focus || neighbours[focus].has(i));
      const dim = (focusGroup || matches) && !visibleNode(i);
      const size = base * sizeOf(nodes[i]) * s * (i === focus ? 1.35 : 1);
      ctx.globalAlpha = dim ? 0.12 : focus >= 0 && !near ? 0.35 : Math.min(1, 0.35 + s * 0.6);
      ctx.drawImage(sprites[i], proj[i * 4] - size, proj[i * 4 + 1] - size, size * 2, size * 2);
    }
    // labels: focus and its neighbours, or the nearest few
    ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.font = '600 12px Inter, system-ui, sans-serif';
    const labelled = focus >= 0 ? [focus, ...neighbours[focus]] : order.slice(-6);
    for (const i of labelled) {
      if ((focusGroup || matches) && !visibleNode(i)) continue;
      const s = proj[i * 4 + 3];
      const y = proj[i * 4 + 1] + base * sizeOf(nodes[i]) * s * (i === focus ? 1.35 : 1) * 0.62 + 14;
      const text = nodes[i].display_name || nodes[i].handle;
      ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillText(text, proj[i * 4] + 1, y + 1);
      ctx.fillStyle = i === focus ? '#fff' : 'rgba(255,255,255,.82)'; ctx.fillText(text, proj[i * 4], y);
    }
    ctx.globalAlpha = 1;
    if (selected >= 0) placeCard(selected);
  }

  /* ---------------------------------------------------------------- loop */
  let raf = 0; let last = performance.now(); let visible = true; let dragging = false; let frameSkip = false;
  const loop = (now) => {
    raf = 0;
    const dt = Math.min(50, now - last); last = now;
    if (fly) {
      const t = Math.min(1, (now - fly.t0) / 900); const e = 1 - (1 - t) ** 3;
      cam.yaw = fly.from.yaw + (fly.yaw - fly.from.yaw) * e; cam.pitch = fly.from.pitch + (fly.pitch - fly.from.pitch) * e; cam.zoom = fly.from.zoom + (fly.zoom - fly.from.zoom) * e;
      if (t >= 1) fly = null;
    } else if (!dragging) {
      const idle = reduced || selected >= 0 || hover >= 0 ? 0 : 0.00008;
      cam.vy += (idle - cam.vy) * 0.02; cam.vp *= 0.92;
      cam.yaw += cam.vy * dt; cam.pitch = Math.max(-1.25, Math.min(1.25, cam.pitch + cam.vp * dt));
    }
    // software rendering: draw every other frame
    frameSkip = slow ? !frameSkip : false;
    if (!frameSkip) draw();
    const moving = fly || dragging || Math.abs(cam.vy) > 0.00001 || Math.abs(cam.vp) > 0.00001;
    if (visible && !document.hidden && moving) raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); } };
  const redraw = () => { if (!raf) requestAnimationFrame(() => draw()); };

  /* --------------------------------------------------------- interaction */
  const pick = (x, y) => {
    let best = -1; let bd = Infinity;
    const base = Math.min(W, H) * 0.046 * Math.sqrt(cam.zoom);
    for (let i = N - 1; i >= 0; i--) {
      const k = i * 4; const r = base * sizeOf(nodes[i]) * proj[k + 3] * 0.6;
      const dx = x - proj[k]; const dy = y - proj[k + 1]; const d = dx * dx + dy * dy;
      if (d < r * r && proj[k + 2] < bd) { bd = proj[k + 2]; best = i; }
    }
    return best;
  };
  function placeCard(i) {
    const n = nodes[i]; const k = i * 4;
    card.hidden = false;
    const x = Math.min(W - 270, Math.max(12, proj[k] + 24)); const y = Math.min(H - 190, Math.max(70, proj[k + 1] - 40));
    card.style.transform = `translate(${x}px, ${y}px)`;
    if (card.dataset.id !== n.id) {
      card.dataset.id = n.id;
      card.replaceChildren(
        n.preview ? h('div', { class: 'galaxy-card-img', style: { backgroundImage: `url("${proxied(n.preview)}")` } }) : null,
        h('div', { class: 'galaxy-card-body' },
          h('div', { class: 'name' }, n.display_name || n.handle),
          h('div', { class: 'muted' }, `@${n.handle} · ${fmt.num(n.media_count)} posts`),
          n.group ? h('span', { class: 'chip sm', style: { '--gc': colorOf(n.group) } }, `#${n.group}`) : null,
          h('div', { class: 'muted', style: { fontSize: '12px' } }, `${neighbours[i].size} similar creator${neighbours[i].size === 1 ? '' : 's'} nearby`),
          h('div', { class: 'row', style: { gap: '6px', marginTop: '4px' } },
            h('a', { class: 'btn sm primary', href: href(`/creator/${n.id}`) }, 'Open profile'),
            h('a', { class: 'btn sm', href: href('/reels', { creator: n.id, type: 'all', sort: 'recent' }) }, icon('film', 'sm'), 'Reels'))));
    }
  }
  const select = (i) => { selected = i; if (i < 0) { card.hidden = true; card.dataset.id = ''; } redraw(); kick(); };
  const flyTo = (i) => {
    const x = pos[i * 3]; const y = pos[i * 3 + 1]; const z = pos[i * 3 + 2];
    // yaw so the node sits in front (z toward the camera), pitch so it is level
    const yaw = Math.atan2(-x, -z);
    const z1 = x * Math.sin(yaw) + z * Math.cos(yaw);
    const pitch = Math.max(-1.2, Math.min(1.2, Math.atan2(y, -z1)));
    let target = yaw; while (target - cam.yaw > Math.PI) target -= Math.PI * 2; while (target - cam.yaw < -Math.PI) target += Math.PI * 2;
    fly = { yaw: target, pitch: -pitch, zoom: Math.max(cam.zoom, 1.5), t0: performance.now(), from: { yaw: cam.yaw, pitch: cam.pitch, zoom: cam.zoom } };
    if (reduced) { cam.yaw = target; cam.pitch = -pitch; cam.zoom = fly.zoom; fly = null; }
    select(i);
  };

  const pointers = new Map(); let pinch = null; let downAt = null; let moved = 0;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: cam.zoom }; }
    dragging = true; moved = 0; downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; fly = null; kick();
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect(); const x = e.clientX - r.left; const y = e.clientY - r.top;
    if (!dragging) {
      if (e.pointerType === 'mouse') { const i = pick(x, y); if (i !== hover) { hover = i; canvas.style.cursor = i >= 0 ? 'pointer' : 'grab'; redraw(); kick(); } }
      return;
    }
    const prev = pointers.get(e.pointerId); if (!prev) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; cam.zoom = Math.max(0.6, Math.min(3.2, pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d))); redraw(); return; }
    const dx = e.clientX - prev.x; const dy = e.clientY - prev.y;
    moved += Math.abs(dx) + Math.abs(dy);
    cam.yaw += dx * 0.006; cam.pitch = Math.max(-1.25, Math.min(1.25, cam.pitch + dy * 0.006));
    cam.vy = dx * 0.006 / 16; cam.vp = dy * 0.006 / 16;
    if (moved > 4) hover = -1;
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size) return;
    dragging = false;
    if (moved < 6 && downAt) {
      const r = canvas.getBoundingClientRect(); const i = pick(e.clientX - r.left, e.clientY - r.top);
      if (i < 0) select(-1);
      else if (e.pointerType === 'mouse') navigate(`/creator/${nodes[i].id}`);
      else if (selected === i) navigate(`/creator/${nodes[i].id}`); else select(i);
    }
    kick();
  };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!dragging && hover >= 0) { hover = -1; redraw(); kick(); } });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.zoom = Math.max(0.6, Math.min(3.2, cam.zoom * Math.exp(-e.deltaY * 0.0012))); redraw(); }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const step = 0.12;
    if (e.key === 'ArrowLeft') cam.yaw -= step; else if (e.key === 'ArrowRight') cam.yaw += step;
    else if (e.key === 'ArrowUp') cam.pitch = Math.max(-1.25, cam.pitch - step); else if (e.key === 'ArrowDown') cam.pitch = Math.min(1.25, cam.pitch + step);
    else if (e.key === '+' || e.key === '=') cam.zoom = Math.min(3.2, cam.zoom * 1.15); else if (e.key === '-') cam.zoom = Math.max(0.6, cam.zoom / 1.15);
    else if (e.key === 'Escape') { select(-1); return; } else return;
    e.preventDefault(); redraw();
  });

  // search: dim everything else, Enter flies to the best match
  const runSearch = () => {
    const q = search.value.trim().toLowerCase();
    if (!q) { matches = null; redraw(); kick(); return; }
    matches = new Set(); nodes.forEach((n, i) => { if (`${n.handle} ${n.display_name || ''} ${n.group || ''}`.toLowerCase().includes(q)) matches.add(i); });
    redraw(); kick();
  };
  search.addEventListener('input', debounce(runSearch, 120));
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    runSearch();
    if (matches && matches.size) { const best = [...matches].sort((a, b) => nodes[b].media_count - nodes[a].media_count)[0]; flyTo(best); kick(); }
  });

  // legend: tap a style to light up its creators
  const paintLegend = () => legend.replaceChildren(h('div', { class: 'galaxy-legend-title' }, 'Styles'),
    ...topGroups.map((g) => h('button', { class: `galaxy-chip${focusGroup === g ? ' on' : ''}`, style: { '--gc': colorOf(g) }, 'aria-pressed': String(focusGroup === g), onclick: () => { focusGroup = focusGroup === g ? null : g; paintLegend(); redraw(); kick(); } }, h('span', { class: 'dot' }), `#${g}`, h('span', { class: 'n' }, groupCount.get(g)))));
  paintLegend();

  const ro = new ResizeObserver(() => { resize(); draw(); });
  ro.observe(shell);
  const onVis = () => { if (!document.hidden) kick(); };
  document.addEventListener('visibilitychange', onVis);
  resize(); draw(); kick();
  setTimeout(() => hint.classList.add('fade'), 6000);

  return () => {
    cancelAnimationFrame(raf); raf = -1; visible = false;
    ro.disconnect(); document.removeEventListener('visibilitychange', onVis);
    document.body.classList.remove('galaxy-mode');
  };
}
