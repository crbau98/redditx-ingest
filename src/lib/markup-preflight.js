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

const crypto = require('crypto');

const PREFLIGHT_MIN = 16 * 1024;          // below this even the worst shapes stay well under 100 ms
const IDLE_MS = 5 * 60_000;
const START_WAIT_MS = 1000;               // the worker is up in ~70 ms; a start that takes longer counts as failed
const START_RETRY_MS = 5 * 60_000;        // after a failed start, the text scan alone guards until this has passed
const REFUSED_TTL_MS = 6 * 3600_000;      // a document refused once is refused again from memory (no second wait)
const REFUSED_MAX = 1000;
/** Budget: MARKUP_PREFLIGHT_MS (default 400) plus 300 ms per MB, so a large ordinary page on a busy CPU is not refused. */
const budgetMs = (bytes = 0) => {
  const v = Number(process.env.MARKUP_PREFLIGHT_MS);
  const base = Number.isFinite(v) && v > 0 ? v : 400;
  return Math.round(base + 300 * (bytes / 1048576));
};

let WORKER_FILE = path.join(__dirname, 'markup-preflight-worker.js');
let worker = null; let i32 = null; let idleTimer = null; let warned = false; let startFailedAt = 0;
const refused = new Map(); // sha1 of the text -> { why, at }
const stats = { checked: 0, refusedSlow: 0, refusedError: 0, refusedRemembered: 0, unavailable: 0, restarts: 0 };
const digest = (text) => crypto.createHash('sha1').update(text).digest('base64');
function remember(key, why) {
  refused.set(key, { why, at: Date.now() });
  if (refused.size > REFUSED_MAX) refused.delete(refused.keys().next().value);
}

function stop() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const w = worker; worker = null; i32 = null;
  if (w) w.terminate().catch(() => {});
}

function start() {
  const sab = new SharedArrayBuffer(12);
  const view = new Int32Array(sab);
  let w;
  try { w = new Worker(WORKER_FILE, { workerData: { sab } }); } catch { startFailedAt = Date.now(); return false; }
  w.unref();
  w.on('error', () => { if (worker === w) { worker = null; i32 = null; } });
  w.on('exit', () => { if (worker === w) { worker = null; i32 = null; } });
  Atomics.wait(view, 0, 0, START_WAIT_MS);
  if (Atomics.load(view, 0) !== 3) { w.terminate().catch(() => {}); startFailedAt = Date.now(); return false; }
  worker = w; i32 = view; stats.restarts++; startFailedAt = 0;
  return true;
}

/**
 * @param {string} text
 * @param {'html'|'xml'|'fragment'} kind
 * @returns {null | {elements: number, depth: number} | {refused: string}} null: not checked (small, or no worker)
 */
function check(text, kind) {
  if (text.length < PREFLIGHT_MIN) return null;
  const key = digest(text);
  const seen = refused.get(key);
  if (seen && Date.now() - seen.at < REFUSED_TTL_MS) { stats.refusedRemembered++; return { refused: seen.why }; }
  if (!worker && (Date.now() - startFailedAt < START_RETRY_MS || !start())) {
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
  const ms = budgetMs(text.length);
  Atomics.wait(view, 0, 0, ms);
  const state = Atomics.load(view, 0);
  if (state === 0) { stats.refusedSlow++; stop(); const why = `the parser needed more than ${ms} ms`; remember(key, why); return { refused: why }; }
  if (state === 2) { stats.refusedError++; const why = 'the parser failed on it'; remember(key, why); return { refused: why }; }
  return { elements: Atomics.load(view, 1), depth: Atomics.load(view, 2) };
}

/** Test hooks: point at another worker file (a broken one) and forget the start-failure and refused-document memory. */
function _reset({ workerFile } = {}) { stop(); refused.clear(); startFailedAt = 0; warned = false; if (workerFile) WORKER_FILE = workerFile; }
module.exports = { check, stop, stats: () => ({ ...stats, running: !!worker, remembered: refused.size }), PREFLIGHT_MIN, budgetMs, _reset };
