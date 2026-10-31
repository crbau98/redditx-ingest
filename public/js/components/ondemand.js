/**
 * Components most visits never open, loaded on first use instead of with the app: the viewer (lightbox), the
 * command palette, the phone menu, display settings and the report dialogs. Each wrapper has the same signature as
 * the function it stands for. After the first screen has painted, warm() fetches them in the background, so a tap
 * a moment later still opens instantly.
 */
import { parse } from '../router.js';

let lb = null; let pal = null;
const lightboxModule = () => import('./lightbox.js').then((m) => (lb = m));
const paletteModule = () => import('./palette.js').then((m) => (pal = m));

export const openLightbox = (...a) => lightboxModule().then((m) => m.openLightbox(...a));
/** Opens / closes the viewer to match ?m=; the module is fetched only when there is something to open. */
export function syncFromUrl() {
  if (lb) return lb.syncFromUrl();
  if (parse().query.get('m')) lightboxModule().then((m) => m.syncFromUrl());
  return undefined;
}
export const lightboxOpen = () => !!(lb && lb.isOpen());

export const openPalette = (...a) => paletteModule().then((m) => m.openPalette(...a));
export const paletteOpen = () => !!(pal && pal.paletteOpen());
export const surpriseMe = (...a) => paletteModule().then((m) => m.surpriseMe(...a));

export const openMenu = (...a) => import('./menu.js').then((m) => m.openMenu(...a));
export const openDisplaySettings = (...a) => import('./display.js').then((m) => m.openDisplaySettings(...a));
export const openTakedownForm = (...a) => import('./report.js').then((m) => m.openTakedownForm(...a));
export const openReport = (...a) => import('./report.js').then((m) => m.openReport(...a));

/**
 * Fetch the on-demand pieces (and any extra loaders) once the browser is idle: one module per idle period, so
 * evaluating them never adds up to one long task that would delay a tap.
 */
export function warm(extra = []) {
  const queue = [lightboxModule, paletteModule, () => import('./menu.js'), ...extra];
  const idle = (fn) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 6000 }) : setTimeout(fn, 400));
  const next = () => { const load = queue.shift(); if (!load) return; load().catch(() => {}).finally(() => idle(next)); };
  setTimeout(() => idle(next), 1500); // after the first screen has settled
}
