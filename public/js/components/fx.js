// Small, cheap effects that make the UI feel physical. Everything here respects
// prefers-reduced-motion and only runs on devices where it makes sense.

import { spring } from './transitions.js';

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
  haptic(12);
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
    ], { duration: 700 + Math.random() * 300, easing: spring('glide'), fill: 'forwards' });
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
  // One shared observer for every rail. A rail removed from the page reports a final 0×0 resize,
  // which is where it is unobserved, so views that come and go never leave observers behind.
  const updaters = new WeakMap();
  const sizes = new ResizeObserver((entries) => {
    const todo = [];
    for (const e of entries) {
      if (!e.target.isConnected) { sizes.unobserve(e.target); updaters.delete(e.target); continue; }
      const u = updaters.get(e.target); if (u) todo.push(u);
    }
    const states = todo.map((u) => u.measure()); // all reads first…
    todo.forEach((u, i) => u.apply(states[i])); // …then all writes: one layout, not one per rail
  });
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
    // Read, then write only what changed. Writing unconditionally restyled the rail's edge mask on
    // every scroll event, and on load each rail's write forced layout for the next rail's read.
    let atStart = null; let atEnd = null;
    const measure = () => { const x = rail.scrollLeft; return [x <= 4, x >= rail.scrollWidth - rail.clientWidth - 4]; };
    const apply = ([s, e]) => {
      if (s !== atStart) { atStart = s; wrap.classList.toggle('at-start', s); prev.hidden = s; }
      if (e !== atEnd) { atEnd = e; wrap.classList.toggle('at-end', e); next.hidden = e; }
    };
    let raf = 0;
    rail.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; apply(measure()); }); }, { passive: true });
    // No first measure here: observing delivers an initial size for every new rail in one batch,
    // after layout and before paint, so the arrows and fades are right on the first frame.
    updaters.set(rail, { measure, apply }); sizes.observe(rail);
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

/* --------------------------------------------- shared-element zoom (card → viewer)
 * Lives in transitions.js with the other shared-element moves; re-exported here for the callers
 * that have always imported it from fx.js. */
export { rememberFlip, playFlip } from './transitions.js';

/* ---------------------------------------------------------------- haptics */
/** A tiny tap on phones that support it (Android Chrome); silently nothing elsewhere. */
export function haptic(ms = 10) {
  try { if (navigator.vibrate && window.matchMedia('(pointer: coarse)').matches) navigator.vibrate(ms); } catch { /* ignore */ }
}

/* ------------------------------------------------------- colour from an image
 * The most characterful colour of an image: a 24×24 sample, weighted toward saturated
 * mid-tones, then nudged into a range that reads well as an accent in both themes.
 * Works because every remote image is served same-origin through the proxy. */
const colourCache = new Map();
export function dominantColor(src) {
  if (!src) return Promise.resolve(null);
  if (colourCache.has(src)) return colourCache.get(src);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = 24; c.height = 24;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 24, 24);
        const d = g.getImageData(0, 0, 24, 24).data;
        let r = 0; let gg = 0; let b = 0; let ws = 0;
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i]; const G = d[i + 1]; const B = d[i + 2]; const A = d[i + 3] / 255;
          const max = Math.max(R, G, B); const min = Math.min(R, G, B);
          const sat = max ? (max - min) / max : 0; const light = (max + min) / 510;
          const w = A * (sat * sat * (1 - Math.min(1, Math.abs(light - 0.5) * 1.6)) + 0.01);
          r += R * w; gg += G * w; b += B * w; ws += w;
        }
        if (!ws) { resolve(null); return; }
        resolve(vivid(r / ws, gg / ws, b / ws));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
  colourCache.set(src, p);
  return p;
}

/* ------------------------------------------------- ambient backdrop from an image
 * A soft, dark colour field made from an image: what `filter: blur(38px) brightness(.42)` on the full
 * picture looks like, baked once into a tiny bitmap. The browser stretches it smoothly, so the
 * backdrop costs nothing per frame (a live CSS blur was re-rendered on every frame of a swipe).
 * Resolves to a data: URL, or null when the image cannot be read. */
const ambientCache = new Map();
export function ambientBackdrop(src, { brightness = 0.42, saturate = 1.3 } = {}) {
  if (!src) return Promise.resolve(null);
  const key = `${src}|${brightness}|${saturate}`;
  if (ambientCache.has(key)) return ambientCache.get(key);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const small = document.createElement('canvas'); small.width = 10; small.height = 10;
        const sg = small.getContext('2d', { willReadFrequently: true });
        sg.imageSmoothingQuality = 'high';
        sg.drawImage(img, 0, 0, 10, 10);
        const px = sg.getImageData(0, 0, 10, 10); const d = px.data;
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, (l + (d[i + k] - l) * saturate) * brightness));
          d[i + 3] = 255;
        }
        sg.putImageData(px, 0, 0);
        // two smooth upscales read as a blur; the element then stretches the result
        const out = document.createElement('canvas'); out.width = 40; out.height = 40;
        const og = out.getContext('2d');
        og.imageSmoothingEnabled = true; og.imageSmoothingQuality = 'high';
        og.drawImage(small, 0, 0, 40, 40);
        resolve(out.toDataURL());
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
  ambientCache.set(key, p);
  if (ambientCache.size > 200) ambientCache.delete(ambientCache.keys().next().value);
  return p;
}

function vivid(r, g, b) {
  // RGB → HSL, then clamp saturation/lightness so the colour works as an accent
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2;
  let h = 0; let s = 0;
  if (max !== min) {
    const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
  }
  return { h: Math.round(h), s: Math.round(Math.min(92, Math.max(58, s * 100))), l: Math.round(Math.min(66, Math.max(52, l * 100))) };
}
