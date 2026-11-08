'use strict';
/**
 * Snapshot store for library-wide aggregates (see aggregate-jobs.js).
 *
 * In production the jobs run on a worker thread: a request never computes an aggregate, it reads
 * the last snapshot, and a stale snapshot is refreshed in the background (stale-while-revalidate).
 * The first request after boot waits for the worker's first answer; it does not block other users.
 *
 * In tests and for ':memory:' databases there is no worker: jobs run inline, with the same TTLs.
 * If the worker dies, requests in flight get the error and the next request starts a new one.
 */
const path = require('path');
const { Worker } = require('worker_threads');
const config = require('../config');
const { JOB_FNS, JOB_TTL_MS } = require('./aggregate-jobs');

const USE_WORKER = !config.isTest && config.dbPath !== ':memory:' && process.env.PRISM_AGGREGATE_WORKER !== '0';
const RESTART_MS = 10000;

const store = new Map(); // name -> { value, at }
const inflight = new Map(); // name -> Promise
const pending = new Map(); // request id -> { resolve, reject }
let worker = null;
let seq = 0;

function computeInline(name) {
  const value = JOB_FNS[name]();
  store.set(name, { value, at: Date.now() });
  return value;
}

function startWorker() {
  if (worker) return worker;
  const w = new Worker(path.join(__dirname, 'aggregate-worker.js'));
  w.on('message', (msg) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value); else p.reject(new Error(msg.error));
  });
  w.on('error', (err) => {
    console.error('[snapshots] aggregate worker error:', err.message);
    worker = null;
    for (const [id, p] of pending) { pending.delete(id); p.reject(err); }
    setTimeout(startWorker, RESTART_MS).unref();
  });
  w.on('exit', () => { if (worker === w) worker = null; });
  worker = w;
  return w;
}

/** Ask the worker for one job. Resolves with the raw value; rejects if the job threw. */
function runOnWorker(name) {
  return new Promise((resolve, reject) => {
    const w = startWorker();
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, name });
  });
}

// A job that failed is not re-queued by every request (each one would run the whole job again, and on the
// worker that is the library build, seconds of CPU per request). The failure is kept for FAIL_BACKOFF_MS and
// returned to callers; the next attempt starts after that.
const FAIL_BACKOFF_MS = 30000;
const failed = new Map(); // name -> { at, error }

function refresh(name) {
  if (inflight.has(name)) return inflight.get(name);
  const f = failed.get(name);
  if (f && Date.now() - f.at < FAIL_BACKOFF_MS) return Promise.reject(f.error);
  const run = USE_WORKER ? runOnWorker(name) : Promise.resolve().then(() => computeInline(name));
  const p = run.then((value) => {
    failed.delete(name);
    store.set(name, { value, at: Date.now() });
    return value;
  }, (error) => {
    failed.set(name, { at: Date.now(), error });
    throw error;
  }).finally(() => { inflight.delete(name); });
  inflight.set(name, p);
  return p;
}

/**
 * The aggregate `name`, from the snapshot store. Resolves immediately when a snapshot exists
 * (refreshing it in the background if it is older than its TTL), otherwise waits for the first one.
 */
function snapshot(name) {
  if (!JOB_FNS[name]) return Promise.reject(new Error(`unknown snapshot ${name}`));
  const entry = store.get(name);
  if (entry) {
    if (Date.now() - entry.at > JOB_TTL_MS[name]) refresh(name).catch((e) => console.error(`[snapshots] ${name}:`, e.message));
    return Promise.resolve(entry.value);
  }
  return refresh(name);
}

/** Fill every snapshot once, in order, so the first visitors after boot never wait for a cold one. */
function prime() {
  if (!USE_WORKER) return;
  // Search needs vocabulary and the library before a first visitor types; home wants discover. Put
  // those first, then everything else in declared order. Previously vocabulary was last, so the
  // first search after boot could wait through every other snapshot (measured 11.6 s).
  const first = ['vocabulary', 'library', 'discover'];
  const names = [...first, ...Object.keys(JOB_FNS).filter((n) => !first.includes(n))];
  const next = () => {
    const name = names.shift();
    if (!name) return;
    refresh(name).catch((e) => console.error(`[snapshots] prime ${name}:`, e.message)).finally(next);
  };
  next();
}

/** The last value of `name` and when it was computed, without waiting or refreshing. */
function peek(name) { return store.get(name); }

/** Tests only: forget a recorded failure so the next call runs the job again. */
function _forget(name) { failed.delete(name); }

module.exports = { snapshot, prime, refresh, peek, USE_WORKER, FAIL_BACKOFF_MS, _store: store, _forget };
