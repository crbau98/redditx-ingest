'use strict';
/**
 * Image filter: keeps women out of the library by looking at the pictures themselves.
 *
 * The text gates (lib/scope) cannot see a woman in a photo with a neutral title, so every candidate
 * image (a photo, or the poster frame of a video) is run through an on-device face detector + gender
 * classifier (Human / BlazeFace + FaceRes on the TensorFlow.js WebAssembly backend; weights ship inside the
 * npm package, nothing is downloaded and no image ever leaves the server).
 *
 *   any detected face classified female (score >= threshold)  ->  the item is female-containing: exclude
 *   no face found (torso / body shots, art, gifs)             ->  no verdict: the text gates decide
 *
 * The dependencies are OPTIONAL (`optionalDependencies`): when they are missing, or the model cannot start,
 * the filter reports itself as unavailable (Admin → Overview / Settings show it) and ingestion continues
 * with the text gates only. Inference is serialised (the wasm backend is single-threaded) and results are
 * cached per URL.
 */
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const net = require('./net');
const phash = require('./phash');
const events = require('../engine/events');

const MAX_BYTES = 4 * 1024 * 1024;
const MIN_FACE_CONFIDENCE = 0.45; // detector confidence for a box to count as a face
const CACHE_MAX = 2000;

let initPromise = null;
let initError = null;
let analyzer = null;   // test hook: async (url) => result
const cache = new Map();
const counters = { analyzed: 0, female: 0, errors: 0, cached: 0, totalMs: 0, hashed: 0, measured: 0, heavy: 0 };

/* ------------------------------------------------------------------ the model */
/**
 * Pool of worker threads, each with its own copy of the model (the wasm backend is single-threaded, so one copy would
 * both serialise every picture AND freeze the server's event loop while it thinks). IMAGE_WORKERS sets the size
 * (default: min(3, cpus - 1), at least 1); 0 runs the model in-process.
 */
class Pool {
  constructor(size) { this.size = size; this.workers = []; this.pending = new Map(); this.nextId = 1; this.info = ''; }

  start() {
    return Promise.all(Array.from({ length: this.size }, () => this.spawn())).then((infos) => { this.info = `${infos[0]} x${this.size} worker${this.size === 1 ? '' : 's'}`; });
  }

  spawn() {
    return new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'imagefilter-worker.js'));
      const slot = { w, busy: 0, ready: false };
      // referenced while starting up or working (so a script awaiting a verdict is not abandoned), unreferenced when idle
      slot.sync = () => { if (slot.busy > 0 || !slot.ready) w.ref(); else w.unref(); };
      this.workers.push(slot);
      w.on('message', (m) => {
        if (m.type === 'ready') { slot.ready = true; slot.sync(); return resolve(m.info); }
        if (m.type === 'failed') return reject(new Error(m.error));
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id); slot.busy--; slot.sync();
        if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
      });
      w.on('error', (e) => { reject(e); this.failAll(slot, e); });
      w.on('exit', () => { this.workers = this.workers.filter((x) => x !== slot); this.failAll(slot, new Error('image worker exited')); });
      slot.sync(); // AFTER the listeners: attaching a 'message' listener re-references the worker
    });
  }

  failAll(slot, err) { for (const [id, p] of this.pending) if (p.slot === slot) { this.pending.delete(id); p.reject(err); } }

  detect(buffer, opts = {}) {
    const slot = this.workers.reduce((a, b) => (!a || b.busy < a.busy ? b : a), null);
    if (!slot) return Promise.reject(new Error('no image workers'));
    const id = this.nextId++;
    slot.busy++; slot.sync();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, slot });
      const copy = new Uint8Array(buffer); // the cached download stays usable: the copy is transferred
      slot.w.postMessage({ type: 'detect', id, buffer: copy.buffer, body: !!opts.body }, [copy.buffer]);
    });
  }

  async shutdown() { await Promise.all(this.workers.map((s) => s.w.terminate())); this.workers = []; }
}

let pool = null;
let inProcess = null; // { detect } when running the model in this thread

function workerCount() {
  const env = process.env.IMAGE_WORKERS;
  if (env !== undefined && env !== '') return Math.max(0, parseInt(env, 10) || 0);
  return Math.max(1, Math.min(3, os.cpus().length - 1));
}

function init() {
  if (initError) return Promise.reject(initError);
  if (!initPromise) {
    initPromise = (async () => {
      const n = workerCount();
      if (n > 0) {
        try {
          pool = new Pool(n);
          await pool.start();
          events.log('INFO', `Image filter ready (${pool.info})`);
          return;
        } catch (e) {
          events.log('WARN', `Image filter workers could not start (${e.message}); trying in-process`);
          if (pool) { pool.shutdown().catch(() => {}); pool = null; }
        }
      }
      const { createModel } = require('./imagefilter-core');
      inProcess = await createModel();
      events.log('INFO', `Image filter ready (in-process, ${inProcess.info})`);
    })().catch((e) => { initError = e; events.log('WARN', `Image filter unavailable: ${e.message} — only the text gates will keep women out. Install the optional dependencies (npm install) to enable it.`); throw e; });
  }
  return initPromise;
}

/** @returns {Promise<{faces: object[], body: object|null}>} */
const detectFaces = (buffer, opts) => (pool ? pool.detect(buffer, opts) : inProcess.detect(buffer, opts));

/* ----------------------------------------------------------------- analysis */
/** Faces (and, with `body`, the build) and/or perceptual hash of picture bytes already in memory. */
async function readBuffer(buffer, { faces = true, hash = true, body = false } = {}) {
  const res = { status: 'ok' };
  const jobs = [];
  if (hash) jobs.push(phash.hashBuffer(buffer).then((h) => { res.phash = h; if (h) counters.hashed++; }, () => { res.phash = null; }));
  if (faces) {
    jobs.push((async () => {
      try { await init(); } catch (e) { res.status = 'unavailable'; res.reason = e.message; return; }
      try {
        const r = await detectFaces(buffer, { body });
        res.faces = r.faces;
        if (body) { res.body = r.body; if (r.body && r.body.decided) counters.measured++; }
      } catch (e) { counters.errors++; res.status = 'error'; res.reason = String(e.message || e).slice(0, 160); }
    })());
  }
  await Promise.all(jobs);
  return res;
}

/**
 * Fetch a picture ONCE and read everything we want from it: the faces (policy: women are excluded), the body's build
 * (`body:true`, policy: heavy bodies are hidden; same model pass as the faces) and its perceptual hash (policy: duplicates
 * collapse). `faces:false` / `hash:false` skip a part. A failed model never costs the hash.
 * @returns {Promise<{status:'ok'|'unavailable'|'error', faces?: object[], body?: object|null, phash?: string|null, reason?: string, cached?: boolean, ms?: number}>}
 */
function analyze(url, { referer, timeout = 12000, faces = true, hash = true, body = false } = {}) {
  if (body) faces = true; // one model pass reads both
  if (analyzer) return analyzer(url, { faces, hash, body });
  const hit = cache.get(url);
  if (hit && (!faces || hit.faces !== undefined) && (!body || hit.body !== undefined) && (!hash || hit.phash !== undefined)) { counters.cached++; return Promise.resolve({ ...hit, cached: true }); }
  return (async () => {
    const t0 = Date.now();
    let got;
    try {
      const headers = { accept: 'image/avif,image/webp,image/*;q=0.8,*/*;q=0.5' };
      if (referer) headers.referer = referer;
      got = await net.fetchBuffer(url, { headers, timeout, maxBytes: MAX_BYTES, retries: 0 });
      if (got.status >= 400) throw new Error(`http ${got.status}`);
      if (/^(text|application\/json)/i.test(got.contentType)) throw new Error(`not an image (${got.contentType.split(';')[0]})`);
    } catch (e) {
      counters.errors++;
      return { status: 'error', reason: String(e.message || e).slice(0, 160) };
    }
    const res = await readBuffer(got.buffer, { faces, hash, body });
    res.ms = Date.now() - t0;
    if (res.status === 'ok' || res.phash !== undefined) {
      counters.analyzed++; counters.totalMs += res.ms;
      if (res.status === 'ok' || (hit && hit.faces !== undefined)) cache.set(url, { ...(hit || {}), ...res, status: res.status === 'ok' ? 'ok' : (hit ? hit.status : res.status) });
      else cache.set(url, { ...res });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return res;
  })();
}

/** Turn a face list into a verdict. `threshold` is the minimum gender score (0..1) for a "female" label. */
function judge(result, threshold = 0.5) {
  if (!result || result.status !== 'ok') return { female: false, faces: 0, females: 0, males: 0, decided: false, status: result ? result.status : 'error', reason: result && result.reason };
  const faces = (result.faces || []).filter((f) => f.confidence >= MIN_FACE_CONFIDENCE);
  const females = faces.filter((f) => f.gender === 'female' && f.score >= threshold);
  const males = faces.filter((f) => f.gender === 'male');
  return { female: females.length > 0, faces: faces.length, females: females.length, males: males.length, decided: faces.length > 0, status: 'ok' };
}

/** Which picture represents an item? A photo is itself; a video is judged by its poster frame. */
function imageUrlOf(item) {
  const isImage = item.mediaType === 'image';
  const cands = isImage ? [item.previewUrl, item.thumbnailUrl, item.mediaUrl] : [item.previewUrl, item.thumbnailUrl];
  const url = cands.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u) && !/\.(m3u8|mp4|webm|mov)(\?|#|$)/i.test(u));
  return url || null;
}

/**
 * Verdict for a pipeline item. Never throws.
 * `body: true` also measures the build: `physique` is the 0..100 heaviness score, or null when the body could not be measured.
 * @returns {Promise<{female: boolean, decided: boolean, status: string, faces: number, females: number, url?: string, physique: number|null, physiqueReason?: string}>}
 */
async function checkItem(item, { threshold = 0.5, faces = true, hash = false, body = false } = {}) {
  const femalePolicy = faces;
  if (body) faces = true; // one model pass reads both
  // A source may hand over the picture itself (item.localImage, e.g. a Telegram photo not uploaded yet): no fetch needed.
  const local = Buffer.isBuffer(item.localImage) && item.localImage.length ? item.localImage : null;
  const url = local ? null : imageUrlOf(item);
  if (!local && !url) return { female: false, decided: false, status: 'no-image', faces: 0, females: 0, phash: null, physique: null };
  let res;
  if (local) {
    const t0 = Date.now();
    res = analyzer ? await analyzer(`local:${item.sourceId || ''}`, { faces, hash, body }) : await readBuffer(local, { faces, hash, body });
    res.ms = Date.now() - t0;
    if (res.status === 'ok') { counters.analyzed++; counters.totalMs += res.ms; }
  } else {
    let referer;
    try { referer = `${new URL(url).origin}/`; } catch { /* none */ }
    res = await analyze(url, { referer, faces, hash, body });
  }
  const verdict = femalePolicy ? judge(res, threshold) : { female: false, faces: 0, females: 0, males: 0, decided: false, status: res.status, reason: res.reason };
  if (verdict.female) counters.female++;
  const b = body && res.status === 'ok' ? res.body : null;
  return { ...verdict, url, phash: res.phash || null, physique: b && b.decided ? b.score : null, physiqueReason: b && !b.decided ? b.reason : undefined };
}

/** Count a picture the physique policy hid (for the admin status line). */
function noteHeavy() { counters.heavy++; }

/** Is the model usable? Starts loading it on first call. */
async function available() {
  if (analyzer) return true;
  try { await init(); return true; } catch { return false; }
}

function status() {
  return {
    ready: !!pool || !!inProcess || !!analyzer, failed: initError ? initError.message : null, workers: pool ? pool.workers.length : 0, ...counters,
    avgMs: counters.analyzed ? Math.round(counters.totalMs / counters.analyzed) : 0,
  };
}

/** Stop the worker threads (tests and graceful shutdown). */
async function shutdown() { if (pool) { await pool.shutdown(); pool = null; } initPromise = null; }

/** Test hook: replace the whole fetch+detect step with `fn(url, {faces, hash, body}) -> {status:'ok', faces:[{gender, score, confidence}], body?: {decided, score}, phash?}`. */
function _setAnalyzer(fn) { analyzer = fn; }
function _reset() { cache.clear(); analyzer = null; }

module.exports = { analyze, judge, checkItem, imageUrlOf, available, status, init, shutdown, noteHeavy, _setAnalyzer, _reset };
