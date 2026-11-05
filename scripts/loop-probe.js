'use strict';
/**
 * Event-loop probe, preloaded into a real server process by scripts/scale-bench.js:
 *
 *     PROBE_OUT=/tmp/loop.jsonl node --require ./scripts/loop-probe.js server.js
 *
 * Writes one JSON line per second ({ t, max, p99, mean } in ms, t = seconds since process start) from
 * perf_hooks.monitorEventLoopDelay, and one line per stall: a 20 ms timer that fired more than STALL_MS late
 * ({ stall: ms, at: seconds since start }). The stall lines say WHEN the loop was blocked, which is what
 * lets a stall be matched to the job that ran then. Dev tool only; nothing in the app requires it.
 */
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');
const { isMainThread } = require('worker_threads');

const OUT = process.env.PROBE_OUT;
const STALL_MS = Number(process.env.PROBE_STALL_MS || 100);
// Preloaded options are inherited by worker threads (the aggregate worker); only the main thread's loop is the server's.
if (OUT && isMainThread) {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / 100) / 10;
  const write = (o) => { try { fs.appendFileSync(OUT, `${JSON.stringify(o)}\n`); } catch { /* ignore */ } };
  setInterval(() => {
    write({ t: at(), max: Math.round(h.max / 1e6), p99: Math.round(h.percentile(99) / 1e6), mean: Math.round(h.mean / 1e6) });
    h.reset();
  }, 1000).unref();
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const late = now - last - 20;
    if (late > STALL_MS) write({ stall: late, at: at() });
    last = now;
  }, 20).unref();
}
