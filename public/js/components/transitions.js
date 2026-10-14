// Shared-element transitions: things that move between views keep their identity on the way.
// A card's image grows into the viewer and shrinks back into its card; a creator's avatar flies
// from wherever you tapped it into his profile header. Every animation here is transform, opacity
// or a one-shot clip-path, timed with the motion tokens in app.css, and nothing runs for
// reduced-motion users.
//
// Why FLIP with ghosts rather than the View Transitions API: a creator page waits on a fetch before
// it has a header to land in, and the viewer is an overlay, not a route. A same-document view
// transition would freeze the page for the whole fetch; a ghost keeps the page live and lands when
// the destination exists, in every browser.

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------ motion tokens
 * One source of truth: app.css defines the springs and durations; JS reads them once. */
let tokens = null;
function readTokens() {
  if (tokens) return tokens;
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  const ms = (name, fallback) => { const x = v(name, ''); const n = parseFloat(x); return Number.isFinite(n) ? (/ms$/.test(x) ? n : n * 1000) : fallback; };
  tokens = {
    snap: v('--spring-snap', 'cubic-bezier(.3, 1.25, .5, 1)'),
    glide: v('--spring-glide', 'cubic-bezier(.2, .8, .2, 1)'),
    settle: v('--spring-settle', 'cubic-bezier(.22, 1.2, .36, 1)'),
    quick: ms('--dur-quick', 140),
    base: ms('--dur-base', 260),
    slow: ms('--dur-slow', 440),
  };
  return tokens;
}
/** Easing string for a spring: 'snap' | 'glide' | 'settle'. */
export const spring = (name) => readTokens()[name];
/** Duration in ms: 'quick' | 'base' | 'slow'. */
export const dur = (name) => readTokens()[name];

/* -------------------------------------------------------------- geometry
 * A card shows its image with object-fit: cover; the viewer shows all of it. To morph one into the
 * other without stretching, the full image is clipped to the card's crop and scaled so that crop
 * covers the card's box exactly, then both ease to nothing. */
function cropTo(full, box) {
  const fa = full.width / full.height; const ba = box.width / box.height;
  let cw = full.width; let ch = full.height;
  if (fa > ba) cw = full.height * ba; else ch = full.width / ba;
  const ix = (full.width - cw) / 2; const iy = (full.height - ch) / 2;
  const s = box.width / cw;
  const dx = (box.left + box.width / 2) - (full.left + full.width / 2);
  const dy = (box.top + box.height / 2) - (full.top + full.height / 2);
  return { ix, iy, s, dx, dy };
}
const inset = (ix, iy, r) => `inset(${iy.toFixed(1)}px ${ix.toFixed(1)}px round ${r.toFixed(1)}px)`;
const visible = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
const radiusOf = (el, fallback) => { const r = parseFloat(getComputedStyle(el).borderTopLeftRadius); return Number.isFinite(r) ? r : fallback; };

/**
 * Animate `el` (laid out at `full`) from the card's box to its own place, or back with `reverse`.
 * The move and the clip are two animations: the move carries the spring (its overshoot is the
 * "landing"), the clip glides, so the crop never bounces. Returns the move animation.
 */
function morph(el, full, box, cardRadius, endRadius, { reverse = false, easing = spring('settle'), fill = 'none', shadow = false } = {}) {
  const c = cropTo(full, box);
  // cropTo() measures centre to centre, so scale about the centre whatever origin the element has
  // (the viewer's image keeps a 0 0 origin for pinch-zoom)
  const moveA = { transform: `translate(${c.dx}px, ${c.dy}px) scale(${c.s})`, transformOrigin: '50% 50%' };
  const moveB = { transform: 'translate(0px, 0px) scale(1)', transformOrigin: '50% 50%' };
  const clipA = { clipPath: inset(c.ix, c.iy, cardRadius / c.s) };
  const clipB = { clipPath: inset(0, 0, endRadius) };
  const duration = dur('slow');
  // Growing in: the clip opens past the edges at the very end, so the media's own shadow fades in
  // rather than appearing in one frame when the clip is dropped.
  const clip = reverse ? [clipB, clipA] : shadow ? [clipA, { ...clipB, offset: 0.8 }, { clipPath: inset(-140, -140, endRadius + 140) }] : [clipA, clipB];
  const anims = [el.animate(clip, { duration, easing: spring('glide'), fill }), el.animate(reverse ? [moveB, moveA] : [moveA, moveB], { duration, easing, fill })];
  holdForFirstFrame(anims);
  return anims[1];
}

/**
 * Opening the viewer or a page builds a lot of DOM in the same task; on a slow phone that task can
 * outlast most of the flight, and the first painted frame would already be near the end. Hold each
 * animation on its first keyframe until the next frame, then run it in full.
 */
function holdForFirstFrame(anims) {
  anims.forEach((x) => x.pause());
  requestAnimationFrame(() => anims.forEach((x) => { if (x.playState === 'paused') x.play(); }));
}

/* ------------------------------------------------- card → viewer, and back */
let flipSource = null;

/** Remember where a click on a card came from, so the viewer can grow out of it. */
export function rememberFlip(el) {
  if (!el) return;
  flipSource = { el, rect: el.getBoundingClientRect(), radius: radiusOf(el.closest('.card') || el, 16), at: performance.now() };
}

/** Grow the viewer's image or video (`target`) out of the remembered card. One-shot. */
export function playFlip(target) {
  const src = flipSource; flipSource = null;
  if (!src || !target || reduced() || performance.now() - src.at > 900 || !visible(src.rect)) return;
  if (target.tagName === 'VIDEO') { flyPoster(src, target); return; }
  const run = () => {
    const to = target.getBoundingClientRect();
    if (!to.width || !to.height) { target.style.opacity = ''; return; }
    target.style.opacity = '';
    const endR = radiusOf(target, 12);
    morph(target, to, src.rect, src.radius, endR, { shadow: true });
    lift(src.el, dur('slow'));
  };
  if (target.complete && target.naturalWidth) { run(); return; } // already decoded (the card loaded the same preview): start before first paint
  // Not loaded yet: hold it invisible so it does not pop in at full size, then grow it once it has a size.
  target.style.opacity = '0';
  const t0 = performance.now();
  const go = () => { if (performance.now() - t0 < 900 && target.isConnected) run(); else target.style.opacity = ''; };
  target.addEventListener('load', go, { once: true });
  target.addEventListener('error', () => { target.style.opacity = ''; }, { once: true });
}

/** Hide the card's own media while its ghost is in flight, so the picture is in one place only. */
function lift(el, ms) {
  if (!el || !el.isConnected) return;
  el.style.visibility = 'hidden';
  setTimeout(() => { el.style.visibility = ''; }, ms);
}

/** Videos size themselves only once metadata arrives (often after an HLS round trip), so a ghost of the
 * card's poster flies to where the video will sit and hands over with a crossfade. */
function flyPoster(src, video) {
  const img = src.el.querySelector('img');
  const stage = video.parentElement;
  if (!img || !img.naturalWidth || !stage) return;
  const box = contentBox(stage);
  const a = img.naturalWidth / img.naturalHeight;
  let w = box.width; let hh = w / a;
  if (hh > box.height) { hh = box.height; w = hh * a; }
  const full = { left: box.left + (box.width - w) / 2, top: box.top + (box.height - hh) / 2, width: w, height: hh };
  const ghost = ghostImg(img.currentSrc || img.src, full);
  video.style.opacity = '0';
  const endR = radiusOf(video, 12);
  const fly = morph(ghost, full, src.rect, src.radius, endR, { fill: 'forwards' });
  lift(src.el, dur('slow'));
  let handed = false;
  const handOff = () => {
    if (handed) return; handed = true;
    video.style.opacity = '';
    if (video.isConnected) video.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur('base'), easing: spring('glide') });
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur('base'), easing: spring('glide'), fill: 'forwards' });
    fade.onfinish = () => ghost.remove();
  };
  // Hand over when the flight has landed and the video can show a frame, whichever is later;
  // never hold the ghost longer than ~1.2 s, and never leave it behind if the viewer closes.
  let landed = false; let ready = video.readyState >= 2;
  fly.onfinish = () => { landed = true; if (ready || !video.isConnected) handOff(); };
  video.addEventListener('loadeddata', () => { ready = true; if (landed) handOff(); }, { once: true });
  setTimeout(handOff, dur('slow') + 800);
}

function contentBox(el) {
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  const pl = parseFloat(cs.paddingLeft) || 0; const pr = parseFloat(cs.paddingRight) || 0;
  const pt = parseFloat(cs.paddingTop) || 0; const pb = parseFloat(cs.paddingBottom) || 0;
  return { left: r.left + pl, top: r.top + pt, width: r.width - pl - pr, height: r.height - pt - pb };
}

function ghostImg(src, rect, cls = 'fx-ghost') {
  const g = document.createElement('img');
  g.className = cls; g.alt = ''; g.decoding = 'sync'; g.src = src;
  Object.assign(g.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  document.body.appendChild(g);
  return g;
}

/**
 * The viewer is closing: fly its media back into the card it belongs to, if that card is on screen.
 * Called by the viewer just before it removes itself; `media` is the stage's <img> or <video>.
 */
export function viewerExit(media, id) {
  if (!media || !id || reduced()) return;
  const card = document.querySelector(`main .card[data-id="${CSS.escape(id)}"] .card-media`);
  const from = media.getBoundingClientRect();
  if (!card || !from.width || !from.height) return;
  const to = card.getBoundingClientRect();
  const cardImg = card.querySelector('img');
  // land only on a card that shows a picture; a placeholder would swap colours on arrival
  if (!visible(to) || !cardImg || !cardImg.naturalWidth) return;
  let src = null;
  if (media.tagName === 'IMG') src = media.currentSrc || media.src;
  else src = videoFrame(media) || media.poster || null;
  if (!src) return;
  // The ghost starts exactly where the media is now (a drag-to-close may have moved and shrunk it),
  // drawn at the image's own proportions so the clip lands on the card's crop.
  const natural = media.tagName === 'IMG' ? [media.naturalWidth, media.naturalHeight] : [media.videoWidth, media.videoHeight];
  const full = natural[0] && natural[1] ? fitInside(from, natural[0] / natural[1]) : from;
  const ghost = ghostImg(src, full);
  const scrim = document.createElement('div');
  scrim.className = 'fx-scrim';
  document.body.insertBefore(scrim, ghost);
  scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur('base'), easing: spring('glide'), fill: 'forwards' }).onfinish = () => scrim.remove();
  const anim = morph(ghost, full, to, radiusOf(card.closest('.card') || card, 16), radiusOf(media, 12), { reverse: true, easing: spring('glide'), fill: 'forwards' });
  card.style.visibility = 'hidden';
  const done = () => { card.style.visibility = ''; ghost.remove(); };
  anim.onfinish = done; anim.oncancel = done;
}

function fitInside(r, aspect) {
  let w = r.width; let hh = w / aspect;
  if (hh > r.height) { hh = r.height; w = hh * aspect; }
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - hh) / 2, width: w, height: hh };
}

/** The frame a video is showing, as a data URL (same-origin through the proxy), or null. */
function videoFrame(v) {
  try {
    if (!v.videoWidth || v.readyState < 2) return null;
    const scale = Math.min(1, 640 / v.videoWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } catch { return null; }
}

/* ------------------------------------------------------- avatar → profile
 * Tapping anything that leads to a creator and carries his avatar (a creator card, the viewer's
 * creator row, a search result) lifts a copy of the avatar off the page. It hovers while the
 * profile loads, then flies into the header when creator.js calls landAvatar(). */
let flight = null;

export function initAvatarFlights() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || reduced()) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const m = /#\/creator\/([^/?#]+)/.exec(a.getAttribute('href') || '');
    if (!m) return;
    // the viewer's creator row has its avatar and its name in two separate links
    const row = a.closest('.lb-creator');
    const av = a.querySelector('.avatar') || (row && row.querySelector('.avatar'));
    if (!av) return;
    const rect = av.getBoundingClientRect();
    if (!visible(rect)) return;
    cancelFlight();
    const ghost = av.cloneNode(true);
    ghost.classList.add('fx-ghost-avatar');
    Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    document.body.appendChild(ghost);
    // a small lift so the tap reads as "picked up" while the profile loads
    ghost.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }], { duration: dur('base'), easing: spring('snap'), fill: 'forwards' });
    flight = { id: decodeURIComponent(m[1]), ghost, rect, timer: setTimeout(cancelFlight, 2500) };
  }, true);
}

function cancelFlight() {
  if (!flight) return;
  const { ghost, timer } = flight; flight = null;
  clearTimeout(timer);
  const fade = ghost.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.9)' }], { duration: dur('quick'), easing: spring('glide'), fill: 'forwards' });
  fade.onfinish = () => ghost.remove();
}

/** creator.js: the header avatar for creator `id` now exists. Fly the waiting ghost into it. */
export function landAvatar(target, id) {
  if (!flight || !target) return;
  if (String(flight.id) !== String(id)) { cancelFlight(); return; }
  const f = flight; flight = null; clearTimeout(f.timer);
  target.style.opacity = '0';
  // Measure after the router has restored scroll for the new page (it runs once the view resolves).
  requestAnimationFrame(() => {
    const to = target.getBoundingClientRect();
    const from = f.ghost.getBoundingClientRect();
    if (!target.isConnected || !visible(to)) { target.style.opacity = ''; f.ghost.remove(); return; }
    const s = to.width / f.rect.width;
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    const cur = from.width / f.rect.width;
    f.ghost.getAnimations().forEach((x) => x.cancel());
    const fly = f.ghost.animate([
      { transform: `scale(${cur})` },
      { transform: `translate(${dx}px, ${dy}px) scale(${s})` },
    ], { duration: dur('slow'), easing: spring('settle'), fill: 'forwards' });
    holdForFirstFrame([fly]);
    const done = () => { target.style.opacity = ''; f.ghost.remove(); };
    fly.onfinish = done; fly.oncancel = done;
  });
}

// Self-starting: one capture listener for the whole app, installed when the shell loads fx.js.
if (typeof document !== 'undefined') initAvatarFlights();
