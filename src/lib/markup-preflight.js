'use strict';
/**
 * Parser preflight for HTML (Crucible v4.21 gate). The text scanner in lib/markup-guard models the HTML parser, and every
 * model gap (abrupt comments, "/>" on non-void tags, raw text in svg/math, the adoption agency for misnested <b>/<a>) let a
 * crafted page build a deep tree whose cost is quadratic INSIDE cheerio.load, freezing the server for seconds to minutes.
 *
 * So the real parser decides: a document over PREFLIGHT_MIN bytes is first parsed in a worker thread. The main thread waits
 * (Atomics.wait, synchronous, so markupGuard.load keeps its signature) at most MARKUP_PREFLIGHT_MS. When the worker is still
 * busy then, it is terminated and the document refused; otherwise its element count and depth are checked against the
 * limits, and only then is the same text parsed on the main thread, which is bounded because the worker just did it.
 *
 * Cost: an accepted large document is parsed twice (the worker's copy blocks the main thread for the same few ms). A refused
 * one costs at most the budget. The worker is started on first use and stopped after IDLE_MS without work.
 */
const path = require('path');
const { Worker } = require('worker_threads');

const PREFLIGHT_MIN = 16 * 1024;          // below this even the worst shapes stay well under 100 ms
const IDLE_MS = 5 * 60_000;
const START_WAIT_MS = 5000;
const budgetMs = () => {
  const v = Number(process.env.MARKUP_PREFLIGHT_MS);
  return Number.isFinite(v) && v > 0 ? v : 400;
};

let worker = null; let i32 = null; let idleTimer = null; let warned = false;
const stats = { checked: 0, refusedSlow: 0, refusedError: 0, unavailable: 0, restarts: 0 };

function stop() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const w = worker; worker = null; i32 = null;
  if (w) w.terminate().catch(() => {});
}

function start() {
  const sab = new SharedArrayBuffer(12);
  const view = new Int32Array(sab);
  let w;
  try { w = new Worker(path.join(__dirname, 'markup-preflight-worker.js'), { workerData: { sab } }); } catch { return false; }
  w.unref();
  w.on('error', () => { if (worker === w) { worker = null; i32 = null; } });
  w.on('exit', () => { if (worker === w) { worker = null; i32 = null; } });
  Atomics.wait(view, 0, 0, START_WAIT_MS);
  if (Atomics.load(view, 0) !== 3) { w.terminate().catch(() => {}); return false; }
  worker = w; i32 = view; stats.restarts++;
  return true;
}

/**
 * @param {string} text
 * @param {'html'|'fragment'} kind
 * @returns {null | {elements: number, depth: number} | {refused: string}} null: not checked (small, or no worker)
 */
function check(text, kind) {
  if (text.length < PREFLIGHT_MIN) return null;
  if (!worker && !start()) {
    stats.unavailable++;
    if (!warned) { warned = true; console.error('[markup] parser preflight worker unavailable; falling back to the text scan only'); }
    return null;
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_MS); idleTimer.unref?.();
  stats.checked++;
  const view = i32;
  Atomics.store(view, 0, 0);
  worker.postMessage({ text, kind });
  const ms = budgetMs();
  Atomics.wait(view, 0, 0, ms);
  const state = Atomics.load(view, 0);
  if (state === 0) { stats.refusedSlow++; stop(); return { refused: `the parser needed more than ${ms} ms` }; }
  if (state === 2) { stats.refusedError++; return { refused: 'the parser failed on it' }; }
  return { elements: Atomics.load(view, 1), depth: Atomics.load(view, 2) };
}

module.exports = { check, stop, stats: () => ({ ...stats, running: !!worker }), PREFLIGHT_MIN };
