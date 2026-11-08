'use strict';
/**
 * Who is blocking the loop?
 *
 * `monitorEventLoopDelay` says HOW LONG the process stopped answering; it never says what was
 * running. Every background job tags itself (`blockwatch.work('imageSweep')`), the histogram is
 * reset on a short interval, and a block over the threshold is recorded against the tag that was
 * active when it happened. `/api/health` then reports `slowest block 1.4s during imageSweep`, which
 * is the difference between guessing at a stall and fixing it.
 *
 * Cost: one histogram reset and one comparison per interval. It never throws.
 */
const { monitorEventLoopDelay } = require('perf_hooks');
const events = require('../engine/events');

let hist = null;
let timer = null;
let active = 'idle';
const stack = [];
const since = { job: 'idle', at: 0 };

let worst = { ms: 0, job: null, at: null };
const recent = []; // last few blocks, for the admin console

const THRESHOLD_MS = Number(process.env.PRISM_SLOW_BLOCK_MS) || 300;
const INTERVAL_MS = 250;

/** What is running now: a label that should read well in a warning ("imageSweep", "feed coomer/user:x"). */
function work(label) {
  active = String(label || 'unknown');
}

/** The label the next block would be attributed to (health and tests read it). */
function current() { return active; }

/** Push a label for the duration of an async job, then restore the previous one. */
async function around(label, fn) {
  stack.push(active);
  work(label);
  try { return await fn(); } finally { active = stack.pop() || 'idle'; }
}

function reset() { worst = { ms: 0, job: null, at: null }; recent.length = 0; }

function start() {
  if (timer) return;
  try {
    hist = monitorEventLoopDelay({ resolution: 20 });
    hist.enable();
  } catch { return; } // older runtime: health still reports the plain delay
  timer = setInterval(() => {
    try {
      const ms = hist.max / 1e6;
      hist.reset();
      if (ms < THRESHOLD_MS) return;
      const job = active;
      const at = new Date().toISOString();
      if (ms > worst.ms) worst = { ms: Math.round(ms), job, at };
      recent.push({ ms: Math.round(ms), job, at });
      if (recent.length > 5) recent.shift();
      // One line per significant block: the label is the whole point of the watch.
      if (ms >= 1000) events.log('WARN', `Loop blocked ${Math.round(ms)} ms during ${job}`);
    } catch { /* never let the watch itself stall the server */ }
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() { clearInterval(timer); timer = null; if (hist) { try { hist.disable(); } catch { /* ignore */ } hist = null; } }

/** For /api/health: the worst block since the last reset(), with the job that was running. */
function lastBlock() { return worst.ms ? { ...worst } : null; }
function blocks() { return recent.slice(); }

module.exports = { work, current, around, start, stop, reset, lastBlock, blocks };