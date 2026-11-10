/**
 * Lazy CSS background images.
 *
 * `<img loading="lazy">` has a built-in distance rule; a `background-image` does not: the browser starts downloading it as
 * soon as the element is rendered, wherever it is. A Home rail of 16 creator cards with three preview tiles each fetched
 * 48 pictures while two cards were on screen, ahead of the pictures the visitor was actually looking at.
 *
 * `lazyBackground(el, url)` sets the background only when `el` is within a screenful (a bit more sideways, so the next
 * card in a rail is already painted when it slides in). One shared observer; no layout reads.
 */

const MARGIN = '300px 500px'; // top/bottom, left/right
let observer;

function paint(el) {
  const url = el._lazyBg;
  const fallback = el._lazyFb;
  el._lazyBg = null;
  if (!url) return;
  el.style.backgroundImage = `url("${url}")`;
  if (!fallback || fallback === url) return;
  const probe = new Image();
  probe.onerror = () => { if (el.isConnected) el.style.backgroundImage = `url("${fallback}")`; };
  probe.src = url;
}

/** @returns the element, so it can be used inline: `lazyBackground(h('div'), url, eager, fallback)` */
export function lazyBackground(el, url, eager = false, fallback = null) {
  if (!url) return el;
  el._lazyFb = fallback || null;
  if (eager || typeof IntersectionObserver === 'undefined') { el._lazyBg = url; paint(el); return el; }
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        paint(e.target);
      }
    }, { rootMargin: MARGIN });
  }
  el._lazyBg = url;
  observer.observe(el);
  return el;
}
