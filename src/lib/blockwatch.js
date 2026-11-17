'use strict';
/**
 * Who is blocking the loop?
 *
 * `monitorEventLoopDelay` says HOW LONG the process stopped answering; it never says what was
 * running. Jobs tag themselves and a block over the threshold is recorded against every tag that
 * was active when it happened. `/api/health` then reports `slowest block 1.4s during feed web:…,
 * imageSweep`, which is the difference between guessing at a stall and fixing it.
 *
 *   work(label)    one shared "current job" label (the sweeps and timers that run one at a time)
 *   enter(label)   a label for one of several jobs that overlap (feed runs, around()); returns leave()
 *
 * Blame is MEASURED, not inferred. `enter()`/`around()` labels say which async jobs were pending, which is not who held the
 * loop: a job that awaits stays "active" through every yield, so three overlapping jobs were all named for one block.
 * Synchronous stretches are therefore timed where they run:
 *   slice(label, fn)   run fn() and record how long it held the loop (a chunk of index adds, a JSON parse, ...)
 *   instrumentDb(db)   time every better-sqlite3 call (run/get/all/iterate, exec, transaction, pragma); a call over
 *                      SLICE_MIN_MS is recorded under its SQL text, so a block reads `sql: UPDATE media SET ...`
 * A block names its culprit (`rec.culprit`, `rec.slices`) when the timed work in its window explains at least half of it; otherwise
 * `rec.job` falls back to the pending labels and `culprit` is null (CPU in untimed JS, or GC: see gcMs and the profile).
 *
 * Also recorded, to tell a slow function from the runtime:
 *   - garbage-collection pauses over GC_LOG_MS (PerformanceObserver 'gc'), and how much of each block was GC;
 *   - a CPU profile around any block over PROFILE_BLOCK_MS: a low-rate sampling profile runs in rolling
 *     windows and is written to <dataDir>/profiles only when its window held such a block (at most
 *     PROFILE_KEEP files; older ones are deleted). Off with PRISM_BLOCK_PROFILE=0.
 *
 * Cost: one histogram reset and one comparison per interval; the profiler samples every 10 ms. It never throws.
 */
const { monitorEventLoopDelay, PerformanceObserver, performance } = require('perf_hooks');
const fs = require('fs');
const path = require('path');
const events = require('../engine/events');

let hist = null;
let timer = null;
let active = 'idle';
const stack = [];
const live = new Map(); // id -> label, for jobs that overlap
let seq = 0;
// Jobs that finished inside the current sample window: a block is measured only at the next tick, so a job whose
// last synchronous stretch IS the block has already left by then. It still owns that window.
const leftThisWindow = [];

// Timed synchronous work inside the current sample window: label -> { ms, n }. Cleared at every tick.
const SLICE_MIN_MS = Number(process.env.PRISM_SLICE_MIN_MS) || 25;
const SLICE_LABELS_MAX = 40;
let windowSlices = new Map();

function noteSlice(label, ms) {
  if (ms < SLICE_MIN_MS) return;
  const cur = windowSlices.get(label);
  if (cur) { cur.ms += ms; cur.n++; } else if (windowSlices.size < SLICE_LABELS_MAX) windowSlices.set(label, { ms, n: 1 });
}

/** Run a synchronous stretch of work under a name, timing it. Returns the elapsed ms. Never swallows errors. */
function slice(label, fn) {
  const t = performance.now();
  try { fn(); } finally { noteSlice(String(label || 'unknown'), performance.now() - t); }
  return performance.now() - t;
}

const sqlLabel = (sql) => `sql: ${String(sql).replace(/\s+/g, ' ').trim().slice(0, 90)}`;
const wrapped = new WeakSet();

/**
 * Time every synchronous better-sqlite3 call on `db` (the serving thread's connection). Idempotent. Cost: two clock reads per
 * call; the statement wrapper is built once per db.prepare().
 */
function instrumentDb(db) {
  if (!db || wrapped.has(db) || typeof db.prepare !== 'function') return false;
  wrapped.add(db);
  const timed = (label, fn, self, args) => {
    const t = performance.now();
    try { return fn.apply(self, args); } finally { noteSlice(label, performance.now() - t); }
  };
  const prepare = db.prepare;
  db.prepare = function prepareTimed(sql) {
    const st = prepare.call(this, sql);
    const label = sqlLabel(sql);
    for (const m of ['run', 'get', 'all']) {
      const orig = st[m];
      if (typeof orig === 'function') st[m] = function timedStatement(...a) { return timed(label, orig, this, a); };
    }
    // iterate(): the time spent inside the database's steps is summed and recorded once, when the iteration ends (done, return or
    // throw). Untimed, a whole-table iterate() was a multi-second block with no culprit (the visual index's request-path build).
    const iter = st.iterate;
    if (typeof iter === 'function') {
      st.iterate = function timedIterate(...a) {
        const it = iter.apply(this, a);
        let spent = 0; let noted = false;
        const note = () => { if (!noted) { noted = true; noteSlice(label, spent); } };
        const step = (m) => (...x) => {
          const t = performance.now();
          try { const r = it[m](...x); if (r && r.done) { spent += performance.now() - t; note(); return r; } spent += performance.now() - t; return r; }
          catch (e) { spent += performance.now() - t; note(); throw e; }
        };
        const out = { next: step('next'), return: (v) => { const r = it.return ? it.return(v) : { done: true, value: v }; note(); return r; }, throw: step('throw') };
        out[Symbol.iterator] = () => out;
        return out;
      };
    }
    return st;
  };
  for (const m of ['exec', 'pragma']) {
    const orig = db[m];
    if (typeof orig === 'function') db[m] = function timedDb(sql, ...rest) { return timed(sqlLabel(`${m} ${sql}`), orig, this, [sql, ...rest]); };
  }
  const transaction = db.transaction;
  db.transaction = function transactionTimed(fn) {
    const t = transaction.call(this, fn);
    const label = `transaction ${(fn && fn.name) || 'anonymous'}`;
    const wrapT = (call) => function timedTxn(...a) { return timed(label, call, this, a); };
    const out = wrapT(t);
    for (const k of ['deferred', 'immediate', 'exclusive']) if (typeof t[k] === 'function') out[k] = wrapT(t[k]);
    return out;
  };
  return true;
}

let worst = { ms: 0, job: null, at: null };
const recent = []; // last few blocks, for the admin console

const THRESHOLD_MS = Number(process.env.PRISM_SLOW_BLOCK_MS) || 300;
const INTERVAL_MS = 250;
const GC_LOG_MS = 200;
const PROFILE_BLOCK_MS = 3000;
const PROFILE_WINDOW_MS = 30 * 1000;
const PROFILE_KEEP = 2;
const PROFILE_SAMPLE_US = 10000;

/** What is running now: a label that should read well in a warning ("imageSweep", "feed coomer:…"). */
function work(label) {
  active = String(label || 'unknown');
}

/** A job that runs alongside others: its label stays in every block report until leave() is called. */
function enter(label) {
  const id = ++seq;
  live.set(id, String(label || 'unknown'));
  return () => { if (live.has(id)) leftThisWindow.push(live.get(id)); live.delete(id); };
}

/** Every label active now: the overlapping jobs, then the shared one when it is not idle. */
function labels() {
  const out = [...live.values()];
  for (const l of leftThisWindow) if (!out.includes(l)) out.push(l);
  if (active !== 'idle' && !out.includes(active)) out.push(active);
  return out;
}
const describe = () => { const l = labels(); return l.length ? l.join(', ') : 'idle'; };

/** The label the next block would be attributed to (health and tests read it). */
function current() { return active; }

/** Push a label for the duration of an async job, then restore the previous one. */
async function around(label, fn) {
  stack.push(active);
  work(label);
  const leave = enter(label);
  try { return await fn(); } finally { leave(); active = stack.pop() || 'idle'; }
}

/* ---------------------------------------------------------------- garbage collection */
const GC_KIND = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weakcb', 16: 'full' };
let gcObserver = null;
let gcSinceTick = 0;      // GC time inside the current sample window (part of a block, if one is recorded)
let gcWorst = { ms: 0, kind: null, at: null };

/** One GC pause: counted toward the current window, logged when it alone is long. */
function noteGc(durationMs, kindCode) {
  gcSinceTick += durationMs;
  if (durationMs < GC_LOG_MS) return null;
  const rec = { ms: Math.round(durationMs), kind: GC_KIND[kindCode] || String(kindCode || '?'), at: new Date().toISOString() };
  if (rec.ms > gcWorst.ms) gcWorst = rec;
  events.log('WARN', `GC pause ${rec.ms} ms (${rec.kind}) during ${describe()}`);
  return rec;
}

/* ---------------------------------------------------------------- CPU profile */
let profile = { session: null, timer: null, dir: null, windowBlock: null, files: [] };

function profileDir() {
  try { return path.join(require('../config').dataDir, 'profiles'); } catch { return null; }
}

/** Write one profile and keep only the newest PROFILE_KEEP. Async; errors are swallowed. */
function writeProfile(dir, data, block) {
  if (!dir || !data) return Promise.resolve(null);
  const name = `block-${block.at.replace(/[:.]/g, '-')}-${block.ms}ms.cpuprofile`;
  return fs.promises.mkdir(dir, { recursive: true })
    .then(() => fs.promises.writeFile(path.join(dir, name), JSON.stringify(data)))
    .then(() => fs.promises.readdir(dir))
    .then(async (list) => {
      const mine = list.filter((f) => /^block-.*\.cpuprofile$/.test(f)).sort(); // ISO stamp in the name: oldest first
      for (const f of mine.slice(0, Math.max(0, mine.length - PROFILE_KEEP))) await fs.promises.unlink(path.join(dir, f)).catch(() => {});
      profile.files = mine.slice(-PROFILE_KEEP);
      events.log('INFO', `Loop block ${block.ms} ms: CPU profile saved as ${name} (during ${block.job})`);
      return name;
    })
    .catch(() => null);
}

function startProfiler() {
  let enabled = true;
  try { enabled = require('../config').blockProfile; } catch { enabled = false; }
  if (!enabled || profile.session) return;
  let inspector;
  try { inspector = require('inspector'); } catch { return; }
  const s = new inspector.Session();
  try { s.connect(); } catch { return; }
  profile.session = s;
  profile.dir = profileDir();
  const begin = () => s.post('Profiler.start', () => {});
  s.post('Profiler.enable', () => s.post('Profiler.setSamplingInterval', { interval: PROFILE_SAMPLE_US }, begin));
  // Rolling windows: each ends with a stop; the samples are kept only when the window held a long block.
  profile.timer = setInterval(() => {
    const block = profile.windowBlock;
    profile.windowBlock = null;
    try {
      s.post('Profiler.stop', (err, res) => {
        if (!err && block && res && res.profile) writeProfile(profile.dir, res.profile, block);
        begin();
      });
    } catch { /* the session closed: stop() cleans up */ }
  }, PROFILE_WINDOW_MS);
  if (profile.timer.unref) profile.timer.unref();
}

function stopProfiler() {
  clearInterval(profile.timer);
  if (profile.session) { try { profile.session.post('Profiler.stop', () => {}); profile.session.disconnect(); } catch { /* ignore */ } }
  profile = { session: null, timer: null, dir: null, windowBlock: null, files: profile.files };
}

/* ---------------------------------------------------------------- the watch */
function reset() { windowSlices = new Map(); worst = { ms: 0, job: null, at: null }; recent.length = 0; gcWorst = { ms: 0, kind: null, at: null }; leftThisWindow.length = 0; }

/**
 * Could this block have lasted PROFILE_BLOCK_MS? A measured length can be short by up to one sample interval (the tick's
 * lateness is a lower bound; the exact histogram reading does not always arrive, e.g. while the profiler samples), so a
 * window is kept when the block may have reached the bar.
 */
const mayBeLong = (ms) => ms + INTERVAL_MS >= PROFILE_BLOCK_MS;

/** A block measured by the sampler: recorded, logged, and marked for a profile when it is long. */
function noteBlock(ms) {
  const gcMs = Math.round(gcSinceTick);
  gcSinceTick = 0;
  const jobs = labels();
  const timed = [...windowSlices].map(([label, v]) => ({ label, ms: Math.round(v.ms), n: v.n })).sort((a, b) => b.ms - a.ms).slice(0, 5);
  windowSlices = new Map();
  leftThisWindow.length = 0; // the window is over: jobs that left in it are forgotten
  if (ms < THRESHOLD_MS) return null;
  // the culprit is the timed work that explains at least half of the block; the pending labels are only context
  const top = timed[0];
  const culprit = top && top.ms >= ms * 0.5 ? top : null;
  const pending = jobs.length ? jobs.join(', ') : 'idle';
  const rec = { ms: Math.round(ms), job: culprit ? `${culprit.label} (${culprit.ms} ms${culprit.n > 1 ? `, ${culprit.n} calls` : ''})` : pending, culprit: culprit ? culprit.label : null, slices: timed, pending, jobs, gcMs, at: new Date().toISOString() };
  if (ms > worst.ms) worst = rec;
  recent.push(rec);
  if (recent.length > 5) recent.shift();
  if (mayBeLong(ms) && (!profile.windowBlock || ms > profile.windowBlock.ms)) profile.windowBlock = rec;
  // One line per significant block: the labels are the whole point of the watch.
  if (ms >= 1000) events.log('WARN', `Loop blocked ${rec.ms} ms during ${rec.job}${gcMs ? ` (GC ${gcMs} ms of it)` : ''}`);
  return rec;
}

/** The same block measured again one tick later (exactly, by the histogram): keep the longer length. */
function extendBlock(rec, ms) {
  if (ms <= rec.ms) return;
  rec.ms = Math.round(ms);
  if (rec.ms > worst.ms) worst = rec;
  if (mayBeLong(rec.ms) && (!profile.windowBlock || rec.ms > profile.windowBlock.ms)) profile.windowBlock = rec;
}

function start() {
  if (timer) return;
  try {
    hist = monitorEventLoopDelay({ resolution: 20 });
    hist.enable();
  } catch { return; } // older runtime: health still reports the plain delay
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) noteGc(e.duration, e.detail ? e.detail.kind : e.kind);
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch { gcObserver = null; }
  // The tick's own lateness is the block it waited behind. The histogram alone could miss a block: after a long
  // stall both timers are overdue, and when this tick runs first it reads and resets the histogram before the
  // histogram's own timer has recorded the delay (measured: a 1.2 s block went unrecorded).
  // That late histogram reading lands on the NEXT tick with the exact length: it is folded into the same block.
  let lastTick = performance.now();
  let prev = null;
  timer = setInterval(() => {
    try {
      const now = performance.now();
      const late = now - lastTick - INTERVAL_MS;
      lastTick = now;
      const ms = Math.max(hist.max / 1e6, late);
      hist.reset();
      if (prev && ms >= THRESHOLD_MS) { extendBlock(prev, ms); prev = null; gcSinceTick = 0; leftThisWindow.length = 0; windowSlices = new Map(); return; }
      prev = noteBlock(ms);
    } catch { /* never let the watch itself stall the server */ }
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  startProfiler();
  // only a database this process already opened: the watch must never be the reason a connection is created
  try { const m = require.cache[require.resolve('../db')]; if (m && m.exports && m.exports.db) instrumentDb(m.exports.db); } catch { /* no database in this process: the labels still work */ }
}

function stop() {
  clearInterval(timer); timer = null;
  if (hist) { try { hist.disable(); } catch { /* ignore */ } hist = null; }
  if (gcObserver) { try { gcObserver.disconnect(); } catch { /* ignore */ } gcObserver = null; }
  stopProfiler();
}

/** For /api/health: the worst block since the last reset(), with every job that was running. */
function lastBlock() { return worst.ms ? { ...worst, jobs: [...(worst.jobs || [])] } : null; }
function blocks() { return recent.slice(); }
/** The longest GC pause since the last reset() and the saved profile files (names only). */
function lastGc() { return gcWorst.ms ? { ...gcWorst } : null; }
function profiles() { return profile.files.slice(); }
/** Saved profile files on disk (names only), and the full path of one, for the admin download. */
const PROFILE_NAME = /^block-[0-9TZ-]+-\d+ms\.cpuprofile$/;
function profileFiles() {
  const dir = profileDir();
  try { return dir ? fs.readdirSync(dir).filter((f) => PROFILE_NAME.test(f)).sort() : []; } catch { return []; }
}
function profilePath(name) {
  const dir = profileDir();
  return dir && PROFILE_NAME.test(String(name || '')) ? path.join(dir, String(name)) : null;
}

module.exports = {
  work, enter, slice, instrumentDb, current, labels, around, start, stop, reset, lastBlock, blocks, lastGc, profiles, profileFiles, profilePath,
  _noteSlice: noteSlice, _noteBlock: noteBlock, _extendBlock: extendBlock, _noteGc: noteGc, _writeProfile: writeProfile, PROFILE_KEEP,
};
