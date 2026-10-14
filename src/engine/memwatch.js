'use strict';
/**
 * Memory watchdog. On the 4 GB server PRISM grew until the kernel's out-of-memory killer shot it (twice on 2026-10-14),
 * which drops the site mid-request with no record of why. This checks the process every 30 s instead:
 *
 *   soft limit  write where the memory is (JS heap, buffers, the image workers' models) to /data/crash.log and swap the image
 *               workers for fresh ones, which hands back what the models have grown into. At most once per 10 minutes.
 *   hard limit  write the same report and restart cleanly (SQLite closed, Docker starts PRISM again in seconds) before the
 *               kernel kills it.
 *
 * Limits default to 50% / 68% of the machine's (or the container's) memory; MEM_SOFT_MB / MEM_HARD_MB override, 0 turns
 * one off.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const events = require('./events');

const mb = (n) => Math.round(n / 1048576);

/** Memory this process may use: the container's cgroup limit when there is one, else the machine's. */
function totalBytes() {
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try { const v = Number(fs.readFileSync(f, 'utf8').trim()); if (Number.isFinite(v) && v > 0 && v < os.totalmem()) return v; } catch { /* not there */ }
  }
  return os.totalmem();
}

function limits() {
  const total = totalBytes();
  const env = (k, frac) => { const v = process.env[k]; return v !== undefined && v !== '' ? Math.max(0, parseInt(v, 10) || 0) * 1048576 : Math.round(total * frac); };
  return { total, soft: env('MEM_SOFT_MB', 0.5), hard: env('MEM_HARD_MB', 0.68) };
}

function report(kind, lim) {
  const m = process.memoryUsage();
  let workers = '';
  try { const s = require('../lib/imagefilter').status(); workers = ` imageWorkers=${s.workers ?? '?'}`; } catch { /* not loaded */ }
  const line = `${new Date().toISOString()} ${kind} rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB external=${mb(m.external)}MB arrayBuffers=${mb(m.arrayBuffers)}MB soft=${mb(lim.soft)}MB hard=${mb(lim.hard)}MB uptime=${Math.round(process.uptime())}s${workers}`;
  console.error(`[memory] ${line}`);
  try { fs.appendFileSync(path.join(config.dataDir, 'crash.log'), `${line}\n\n`); } catch { /* best effort */ }
  events.log(kind === 'memory-hard' ? 'ERR' : 'WARN', `Memory ${kind === 'memory-hard' ? 'critical: restarting' : 'high: refreshing image workers'} (${mb(m.rss)} MB in use)`);
  return line;
}

let timer = null; let lastSoft = 0;
/**
 * @param {{onCritical: () => void, rss?: () => number, recycle?: () => void, now?: () => number}} opts (rss/recycle/now: test hooks)
 */
function check({ onCritical, rss = () => process.memoryUsage().rss, recycle = () => require('../lib/imagefilter').recycle(), now = Date.now } = {}) {
  const lim = limits();
  const used = rss();
  if (lim.hard && used >= lim.hard) { report('memory-hard', lim); onCritical(); return 'hard'; }
  if (lim.soft && used >= lim.soft && now() - lastSoft > 10 * 60000) {
    lastSoft = now();
    report('memory-soft', lim);
    try { recycle(); } catch { /* ignore */ }
    return 'soft';
  }
  return null;
}

function start(opts) {
  if (timer || config.dbPath === ':memory:') return;
  const lim = limits();
  console.log(`   Memory:    watch ${mb(lim.total)} MB, refresh at ${mb(lim.soft)} MB, restart at ${mb(lim.hard)} MB`);
  timer = setInterval(() => { try { check(opts); } catch { /* never let the watchdog itself crash the server */ } }, 30000);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
function _reset() { lastSoft = 0; }

module.exports = { start, stop, check, limits, _reset };
