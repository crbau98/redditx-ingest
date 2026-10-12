import { h, icon, proxied, fmt } from '../dom.js';
import { gpuTier } from './fx.js';

/**
 * A 3D carousel: media cards on a slowly turning cylinder (pure CSS 3D, one transform
 * per frame on the ring). Drag or swipe to spin it with momentum; hovering pauses it;
 * clicking a card opens it. Cards facing away dim, the front card lifts and brightens.
 * Reduced-motion users get a still ring they can still drag.
 */
export function createOrbit(items, { onOpen, compact = false } = {}) {
  const list = items.filter((it) => it.preview_url || it.thumbnail_url || it.media_type === 'image').slice(0, compact ? 9 : 12);
  const n = list.length;
  // Without a real GPU, or for reduced-motion users, the ring does not turn on its own (it still drags).
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || gpuTier() === 'software';
  const cardW = compact ? 118 : 168;
  const radius = Math.round((cardW / 2) / Math.tan(Math.PI / Math.max(n, 3)) + (compact ? 18 : 34));
  const step = 360 / Math.max(n, 1);

  const ring = h('div', { class: 'orbit-ring' });
  const cards = list.map((it, i) => {
    const src = it.preview_url || it.thumbnail_url || it.media_url;
    const card = h('button', { class: 'orbit-card', type: 'button', 'aria-label': it.title || `Open item ${i + 1}`, style: { width: `${cardW}px`, transform: `rotateY(${i * step}deg) translateZ(${radius}px)` } },
      h('img', { src: proxied(src), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }),
      it.media_type === 'video' ? h('span', { class: 'pill' }, icon('play', 'fill'), it.duration ? fmt.duration(it.duration) : '') : null,
      h('span', { class: 'orbit-cap' }, it.creator_name || it.creator_handle || it.author || ''),
      h('span', { class: 'orbit-shade', 'aria-hidden': 'true' }));
    card.addEventListener('click', (e) => { if (moved > 6) { e.preventDefault(); return; } onOpen && onOpen(it, list); });
    ring.appendChild(card);
    return card;
  });
  const el = h('div', { class: `orbit${compact ? ' compact' : ''}`, style: { '--r': `${radius}px`, '--cw': `${cardW}px` }, role: 'region', 'aria-label': 'Trending — drag to spin' },
    h('div', { class: 'orbit-stage' }, ring), h('div', { class: 'orbit-floor' }));
  if (!n) return { el, destroy() {} };

  let angle = 0; let vel = reduced ? 0 : -0.012; // deg per ms
  const idle = reduced ? 0 : -0.012;
  let dragging = false; let lastX = 0; let lastT = 0; let moved = 0; let hover = false; let raf = 0; let prev = performance.now(); let visible = true;

  const paint = () => {
    ring.style.transform = `translateZ(${-radius}px) rotateY(${angle}deg)`;
    // brightness/lift by how directly each card faces the viewer
    for (let i = 0; i < n; i++) {
      const a = ((i * step + angle) % 360 + 360) % 360;
      const facing = Math.cos((a * Math.PI) / 180); // 1 = front, -1 = back
      cards[i].style.setProperty('--f', facing.toFixed(3));
      cards[i].tabIndex = facing > 0.7 ? 0 : -1;
    }
  };
  const loop = (now) => {
    const dt = Math.min(64, now - prev); prev = now;
    if (!dragging) {
      const target = hover ? 0 : idle;
      vel += (target - vel) * 0.03;
      angle += vel * dt;
    }
    paint();
    // keep animating while it moves; once idle (still mode) or off-screen, stop until the next drag
    const moving = dragging || Math.abs(vel) > 0.0004;
    raf = visible && !document.hidden && moving ? requestAnimationFrame(loop) : 0;
  };
  const kick = () => { if (!raf) { prev = performance.now(); raf = requestAnimationFrame(loop); } };

  el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') hover = true; });
  el.addEventListener('pointerleave', () => { hover = false; kick(); });
  // Capture the pointer only once it actually drags, so a plain tap still reaches the card.
  let captured = false;
  el.addEventListener('pointerdown', (e) => { dragging = true; captured = false; moved = 0; lastX = e.clientX; lastT = performance.now(); kick(); });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const now = performance.now(); const dx = e.clientX - lastX;
    moved += Math.abs(dx);
    if (!captured && moved > 6) { captured = true; try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ } el.classList.add('grabbing'); }
    angle += dx * 0.32;
    vel = (dx * 0.32) / Math.max(1, now - lastT);
    lastX = e.clientX; lastT = now;
    if (reduced) paint();
  });
  const end = () => { dragging = false; el.classList.remove('grabbing'); if (reduced) vel = 0; };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); angle += e.key === 'ArrowLeft' ? step : -step; paint(); } });

  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); });
  io.observe(el);
  const onVis = () => { if (!document.hidden) kick(); };
  document.addEventListener('visibilitychange', onVis);
  paint(); kick();
  return { el, destroy() { cancelAnimationFrame(raf); io.disconnect(); document.removeEventListener('visibilitychange', onVis); } };
}
