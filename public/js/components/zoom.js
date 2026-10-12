// Zoom & pan for the viewer's image: wheel/trackpad zooms around the cursor, a click toggles
// 2.5× at that point, drag pans while zoomed, two fingers pinch. Transform-only (no layout),
// clamped so the image never slides out of view.

const MAX = 6;

export function makeZoomable(img, stage, { onChange, onSingleClick } = {}) {
  let scale = 1; let tx = 0; let ty = 0;
  img.style.transformOrigin = '0 0';
  img.style.willChange = 'transform';

  const base = () => { const r = img.getBoundingClientRect(); return { left: r.left - tx, top: r.top - ty, w: r.width / scale, h: r.height / scale }; };
  const clamp = (b) => {
    if (scale <= 1) { tx = 0; ty = 0; return; }
    tx = Math.min(0, Math.max(b.w * (1 - scale), tx));
    ty = Math.min(0, Math.max(b.h * (1 - scale), ty));
  };
  const apply = (animate = false) => {
    img.style.transition = animate ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : 'none';
    img.style.transform = scale === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    const zoomed = scale > 1.001;
    stage.classList.toggle('zoomed-wrap', zoomed);
    img.classList.toggle('zoomed', zoomed);
    if (onChange) onChange(scale);
  };
  const zoomAt = (cx, cy, next, animate = false) => {
    const b = base();
    next = Math.min(MAX, Math.max(1, next));
    const u = (cx - b.left - tx) / scale; const v = (cy - b.top - ty) / scale;
    scale = next;
    tx = cx - b.left - u * scale; ty = cy - b.top - v * scale;
    clamp(b); apply(animate);
  };

  img.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, scale * Math.exp(-e.deltaY * 0.0016)); }, { passive: false });

  // click toggles zoom; double-click is left to the caller (e.g. "save"), so single clicks wait a beat
  let clickTimer = null; let moved = 0;
  img.addEventListener('click', (e) => {
    if (moved > 5) return;
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
    const { clientX: x, clientY: y } = e;
    clickTimer = setTimeout(() => {
      clickTimer = null;
      if (onSingleClick && onSingleClick() === false) return;
      if (scale > 1) { scale = 1; tx = 0; ty = 0; apply(true); } else zoomAt(x, y, 2.5, true);
    }, 230);
  });

  const pts = new Map(); let pinch = null; let last = null;
  img.addEventListener('pointerdown', (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: scale, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; }
    if (scale > 1 || pts.size === 2) { img.setPointerCapture(e.pointerId); e.stopPropagation(); }
    last = { x: e.clientX, y: e.clientY };
  });
  img.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      zoomAt(pinch.cx, pinch.cy, pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
      moved += 10; return;
    }
    if (scale <= 1 || !last) return;
    const dx = e.clientX - last.x; const dy = e.clientY - last.y;
    moved += Math.abs(dx) + Math.abs(dy);
    last = { x: e.clientX, y: e.clientY };
    tx += dx; ty += dy; clamp(base()); apply();
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  img.addEventListener('pointerup', up); img.addEventListener('pointercancel', up);

  return {
    get scale() { return scale; },
    zoomBy(f) { const r = img.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, scale * f, true); },
    reset() { scale = 1; tx = 0; ty = 0; apply(true); },
  };
}
