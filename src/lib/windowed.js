'use strict';
/**
 * Walk a table by rowid (or seq) in windows whose size is set by MEASURED time, not a fixed count: start small (the volume
 * may be cold), grow while each window stays under `targetMs`, shrink at once when one is slow, capped both ways. A timer
 * yield after every window lets queued requests and health probes run. A fixed 5,000-row window took 1,494 ms in one
 * synchronous chunk on production's cold volume (library-health, 2026-11-17); this keeps every chunk near targetMs.
 *
 * @param {{top: number, start?: number, fn: (after: number, to: number) => void, targetMs?: number, firstSpan?: number,
 *          minSpan?: number, maxSpan?: number, stats?: object}} o  fn reads rows with after < rowid <= to, synchronously
 * @returns {Promise<{windows: number, maxChunkMs: number}>} also written to `stats`
 */
const { performance } = require('perf_hooks');

const TARGET_MS = 30;
// The cap bounds the worst surprise: a window sized on warm rows that lands on a cold patch costs at most MAX_SPAN rows of cold
// reads (about 300 ms at production's measured 0.3 ms a row). 1.27M rows in windows of 1,000 is ~1,300 yields: cheap.
const MAX_SPAN = 1000;
const tick = () => new Promise((res) => setTimeout(res, 0));

async function walkWindows({ top, start = 0, fn, targetMs = TARGET_MS, firstSpan = 50, minSpan = 20, maxSpan = MAX_SPAN, stats = {} }) {
  stats.windows = stats.windows || 0;
  stats.maxChunkMs = stats.maxChunkMs || 0;
  let after = start; let span = firstSpan; let perRow = 0;
  while (after < top) {
    const to = Math.min(after + span, top);
    const t0 = performance.now();
    fn(after, to);
    const ms = performance.now() - t0;
    stats.windows++;
    stats.maxChunkMs = Math.max(stats.maxChunkMs, Math.round(ms));
    // per-row cost: a slow window counts at once, a fast one only lowers the estimate slowly (a cold patch comes back)
    perRow = Math.max(ms / Math.max(to - after, 1), perRow * 0.9);
    after = to;
    span = Math.max(minSpan, Math.min(maxSpan, Math.round(targetMs / Math.max(perRow, 0.0005))));
    await tick();
  }
  return stats;
}

module.exports = { walkWindows, TARGET_MS, MAX_SPAN };
