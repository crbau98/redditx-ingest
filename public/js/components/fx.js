// Small, cheap effects that make the UI feel physical. Everything here respects
// prefers-reduced-motion and only runs on devices where it makes sense.

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Rough graphics tier, detected once: 'software' when WebGL runs on the CPU (SwiftShader,
 * llvmpipe — VMs, blocklisted GPUs), where continuous 3D/shader animation would make the
 * whole page stutter; 'low' for small touch devices; otherwise 'high'.
 */
let tier = null;
export function gpuTier() {
  if (tier) return tier;
  tier = 'high';
  try {
    // failIfMajorPerformanceCaveat: no context at all on software rendering, instead of a slow,
    // console-warning fallback — which is exactly what we want to detect.
    const gl = document.createElement('canvas').getContext('webgl', { failIfMajorPerformanceCaveat: true });
    if (!gl) tier = 'software';
    else {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      if (/swiftshader|llvmpipe|software|basic render/i.test(r)) tier = 'software';
      const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
    }
  } catch { tier = 'software'; }
  if (tier === 'high' && window.matchMedia('(pointer: coarse)').matches && (navigator.hardwareConcurrency || 8) <= 4) tier = 'low';
  return tier;
}
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/* ------------------------------------------------------------ 3D tilt + glare
 * One delegated pointer listener for the whole app: the card under the pointer
 * leans toward it and a soft glare follows. Values go through CSS custom
 * properties, written at most once per frame. */
export function initTilt() {
  if (!finePointer || reduced()) return;
  let active = null; let raf = 0; let px = 0; let py = 0;
  const SEL = '.card, .creator-card, .coll-card, .browse-tile, .orbit-card';
  const apply = () => {
    raf = 0;
    if (!active) return;
    const r = active.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (px - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (py - r.top) / r.height));
    const max = active.classList.contains('orbit-card') ? 0 : active.classList.contains('card') ? 5 : 7;
    active.style.setProperty('--ry', `${((x - 0.5) * 2 * max).toFixed(2)}deg`);
    active.style.setProperty('--rx', `${((0.5 - y) * 2 * max).toFixed(2)}deg`);
    active.style.setProperty('--gx', `${(x * 100).toFixed(1)}%`);
    active.style.setProperty('--gy', `${(y * 100).toFixed(1)}%`);
  };
  const release = (el) => { if (!el) return; el.classList.remove('tilting'); ['--rx', '--ry'].forEach((p) => el.style.setProperty(p, '0deg')); };
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest && e.target.closest(SEL);
    if (el !== active) { release(active); active = el; if (el) el.classList.add('tilting'); }
    if (!active) return;
    px = e.clientX; py = e.clientY;
    if (!raf) raf = requestAnimationFrame(apply);
  }, { passive: true });
  document.addEventListener('pointerleave', () => { release(active); active = null; });
  window.addEventListener('blur', () => { release(active); active = null; });
}

/* ---------------------------------------------------------------- heart burst */
/** A little shower of hearts from a point (e.g. the save button). */
export function heartBurst(x, y, { count = 9 } = {}) {
  if (reduced()) return;
  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  document.body.appendChild(layer);
  for (let i = 0; i < count; i++) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'fx-heart'); s.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#i-heart'); s.appendChild(use);
    const size = 10 + Math.random() * 12;
    Object.assign(s.style, { left: `${x - size / 2}px`, top: `${y - size / 2}px`, width: `${size}px`, height: `${size}px` });
    layer.appendChild(s);
    const ang = (-Math.PI / 2) + (Math.random() - 0.5) * Math.PI * 1.3;
    const dist = 40 + Math.random() * 70;
    s.animate([
      { transform: 'translate(0,0) scale(.4) rotate(0deg)', opacity: 1 },
      { transform: `translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist}px) scale(1) rotate(${(Math.random() - 0.5) * 60}deg)`, opacity: 1, offset: 0.6 },
      { transform: `translate(${Math.cos(ang) * dist * 1.2}px, ${Math.sin(ang) * dist * 1.2 + 30}px) scale(.8)`, opacity: 0 },
    ], { duration: 700 + Math.random() * 300, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
  }
  setTimeout(() => layer.remove(), 1100);
}

/* ------------------------------------------------------------- count-up numbers */
export function countUp(el, to, format = (n) => String(Math.round(n)), ms = 900) {
  if (reduced() || !to) { el.textContent = format(to); return; }
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const e = 1 - (1 - t) ** 3;
    el.textContent = format(to * e);
    if (t < 1) requestAnimationFrame(tick); else el.textContent = format(to);
  };
  el.textContent = format(0);
  requestAnimationFrame(tick);
}

/* --------------------------------------------------------- rails with arrows
 * Any .rail added anywhere gets edge fades and (on desktop) prev/next buttons
 * that appear only when there is more to scroll that way. */
export function initRails(root = document.body) {
  const enhance = (rail) => {
    if (rail.dataset.fx) return;
    rail.dataset.fx = '1';
    const wrap = document.createElement('div');
    wrap.className = 'rail-wrap';
    rail.replaceWith(wrap);
    wrap.appendChild(rail);
    const mk = (dir) => {
      const b = document.createElement('button');
      b.className = `rail-arrow ${dir}`; b.type = 'button'; b.setAttribute('aria-label', dir === 'prev' ? 'Scroll back' : 'Scroll forward'); b.tabIndex = -1;
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'i');
      const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', dir === 'prev' ? '#i-chev-l' : '#i-chev-r'); s.appendChild(u); b.appendChild(s);
      b.addEventListener('click', () => rail.scrollBy({ left: (dir === 'prev' ? -1 : 1) * rail.clientWidth * 0.85, behavior: reduced() ? 'auto' : 'smooth' }));
      wrap.appendChild(b);
      return b;
    };
    const prev = mk('prev'); const next = mk('next');
    const update = () => {
      const max = rail.scrollWidth - rail.clientWidth - 4;
      wrap.classList.toggle('at-start', rail.scrollLeft <= 4);
      wrap.classList.toggle('at-end', rail.scrollLeft >= max);
      prev.hidden = rail.scrollLeft <= 4; next.hidden = rail.scrollLeft >= max;
    };
    rail.addEventListener('scroll', update, { passive: true });
    new ResizeObserver(update).observe(rail);
    update();
  };
  root.querySelectorAll('.rail').forEach(enhance);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.classList.contains('rail')) enhance(n);
      else if (n.querySelectorAll) n.querySelectorAll('.rail').forEach(enhance);
    }
  }).observe(root, { childList: true, subtree: true });
}

/* --------------------------------------------- shared-element zoom (card → viewer) */
let flipSource = null;
/** Remember where a click came from, so the viewer can grow out of it. */
export function rememberFlip(el) {
  if (!el) return;
  const img = el.querySelector('img');
  flipSource = { rect: el.getBoundingClientRect(), src: img && img.currentSrc, at: performance.now() };
}
/** Animate `target` (the viewer's image/video) from the remembered rect. One-shot. */
export function playFlip(target) {
  const src = flipSource; flipSource = null;
  if (!src || !target || reduced() || performance.now() - src.at > 900) return;
  const run = () => {
    const to = target.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const scale = Math.max(src.rect.width / to.width, src.rect.height / to.height);
    const dx = (src.rect.left + src.rect.width / 2) - (to.left + to.width / 2);
    const dy = (src.rect.top + src.rect.height / 2) - (to.top + to.height / 2);
    target.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, borderRadius: '18px', opacity: 0.6 },
      { transform: 'none', borderRadius: '12px', opacity: 1 },
    ], { duration: 420, easing: 'cubic-bezier(.2,.85,.25,1)' });
  };
  if (target.complete === false || (target.tagName === 'VIDEO' && !target.videoWidth && !target.poster)) target.addEventListener(target.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', run, { once: true });
  else requestAnimationFrame(run);
}
