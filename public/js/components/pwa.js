// The installed-app side of PRISM: the "offline" pill, the install prompt, the browser chrome colour, and the
// service worker. Small on purpose; the worker itself (public/sw.js) holds the caching rules.
import { h, icon, toast } from '../dom.js';
import { bus, prefs } from '../store.js';

/* ------------------------------------------------------------ offline state */
let pill = null;
function paintOffline() {
  const off = navigator.onLine === false;
  if (off && !pill) {
    pill = h('div', { class: 'offline-pill', role: 'status' }, icon('alert', 'sm'), h('span', null, 'You’re offline — showing saved'));
    document.body.appendChild(pill);
  } else if (!off && pill) { pill.remove(); pill = null; }
}

/* ---------------------------------------------------------- install prompt */
let deferred = null; // the browser's beforeinstallprompt event, held until the person asks
const listeners = new Set();
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIosSafari = () => /iP(hone|ad|od)/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

/** 'prompt' (the browser can show its install dialog), 'ios' (Share > Add to Home Screen), or '' (installed / not offered). */
export function installKind() {
  if (standalone()) return '';
  if (deferred) return 'prompt';
  return isIosSafari() ? 'ios' : '';
}
export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export async function promptInstall() {
  if (!deferred) return false;
  const ev = deferred; deferred = null;
  ev.prompt();
  let accepted = false;
  try { accepted = (await ev.userChoice).outcome === 'accepted'; } catch { /* dismissed */ }
  listeners.forEach((fn) => fn());
  return accepted;
}

/* ----------------------------------------------------------------- startup */
export function initPwa() {
  paintOffline();
  window.addEventListener('offline', paintOffline);
  window.addEventListener('online', () => { const was = !!pill; paintOffline(); if (was) toast('Back online'); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; listeners.forEach((fn) => fn()); });
  window.addEventListener('appinstalled', () => { deferred = null; toast('PRISM installed'); listeners.forEach((fn) => fn()); });

  // the address bar / status bar colour follows the theme
  const paintChrome = () => { const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', document.documentElement.dataset.theme === 'light' ? '#f5f5f7' : '#0b0b0e'); };
  paintChrome(); bus.on('theme', paintChrome);

  // "forget what I opened" also forgets what the worker kept
  bus.on('history', (id) => { if (id === null && navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'prism-clear-caches' }); });

  // "Keep what I browse for offline use" (off by default): tell the worker, now and whenever it changes or a new one takes over
  const tellWorker = () => { const c = navigator.serviceWorker && navigator.serviceWorker.controller; if (c) c.postMessage({ type: 'prism-offline-content', on: !!prefs.offlineContent }); };
  bus.on('offlineContent', tellWorker);
  if ('serviceWorker' in navigator) { navigator.serviceWorker.addEventListener('controllerchange', tellWorker); navigator.serviceWorker.ready.then(tellWorker).catch(() => {}); }

  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* optional enhancement */ });
}
