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
const fs = require('fs');
const path = require('path');
const net = require('./net');
const events = require('../engine/events');

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 896;            // faces in group shots are small: do not shrink more than this
const MIN_FACE_CONFIDENCE = 0.45; // detector confidence for a box to count as a face
const CACHE_MAX = 2000;

let deps = null;       // { human, sharp } once ready
let initPromise = null;
let initError = null;
let analyzer = null;   // test hook: async (url) => result
const cache = new Map();
let chain = Promise.resolve();
const counters = { analyzed: 0, female: 0, errors: 0, cached: 0, totalMs: 0 };

/* ------------------------------------------------------------------ loading */
function resolveAssets() {
  const sharp = require('sharp');
  // The package's "exports" map has no subpaths: resolve the main entry and walk up to the package root.
  const humanMain = require.resolve('@vladmandic/human'); // .../dist/human.node.js
  const root = path.resolve(path.dirname(humanMain), '..');
  const wasmDist = path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm'));
  require.resolve('@tensorflow/tfjs-converter');
  return { sharp, root, wasmDist };
}

/** Human loads its weights with fetch(); Node's fetch has no file:// scheme, so serve exactly that scheme from disk while loading. */
async function withFileFetch(fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const s = String(url);
    if (!s.startsWith('file://')) return real(url, opts);
    try {
      const body = fs.readFileSync(decodeURIComponent(s.slice('file://'.length)));
      return new Response(body, { status: 200, headers: { 'content-type': s.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
    } catch { return new Response('not found', { status: 404 }); }
  };
  try { return await fn(); } finally { globalThis.fetch = real; }
}

async function init() {
  if (deps) return deps;
  if (initError) throw initError;
  if (!initPromise) {
    initPromise = (async () => {
      const { sharp, root, wasmDist } = resolveAssets();
      const Human = require(path.join(root, 'dist', 'human.node-wasm.js')).default;
      const human = new Human({
        backend: 'wasm',
        wasmPath: `${wasmDist}${path.sep}`,
        modelBasePath: `file://${path.join(root, 'models')}/`,
        debug: false, async: false, cacheSensitivity: 0, warmup: 'none',
        filter: { enabled: false },
        face: {
          enabled: true, detector: { rotation: false, maxDetected: 8, minConfidence: 0.4 }, mesh: { enabled: false }, iris: { enabled: false },
          description: { enabled: true }, emotion: { enabled: false }, antispoof: { enabled: false }, liveness: { enabled: false },
        },
        body: { enabled: false }, hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false }, segmentation: { enabled: false },
      });
      await withFileFetch(async () => { await human.load(); });
      const loaded = Object.values(human.models.loaded ? human.models.loaded() : {});
      if (!loaded.length) throw new Error('face models did not load');
      deps = { human, sharp };
      events.log('INFO', `Image filter ready (${human.tf.getBackend()} backend, models: ${loaded.join(', ')})`);
      return deps;
    })().catch((e) => { initError = e; events.log('WARN', `Image filter unavailable: ${e.message} — only the text gates will keep women out. Install the optional dependencies (npm install) to enable it.`); throw e; });
  }
  return initPromise;
}

/* ----------------------------------------------------------------- analysis */
async function decodeToTensor(buffer) {
  const { human, sharp } = deps;
  const { data, info } = await sharp(buffer, { failOn: 'none', limitInputPixels: 60e6 })
    .rotate().removeAlpha().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  return human.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
}

async function runModel(buffer) {
  await init();
  const tensor = await decodeToTensor(buffer);
  try {
    const result = await deps.human.detect(tensor);
    return (result.face || []).map((f) => ({
      gender: f.gender || 'unknown', score: Number(f.genderScore) || 0, confidence: Number(f.score) || 0, age: Number.isFinite(f.age) ? Math.round(f.age) : null,
    }));
  } finally { deps.human.tf.dispose(tensor); }
}

/**
 * Fetch an image and classify the faces in it.
 * @returns {Promise<{status:'ok'|'unavailable'|'error', faces?: object[], reason?: string, cached?: boolean, ms?: number}>}
 */
function analyze(url, { referer, timeout = 12000 } = {}) {
  if (analyzer) return analyzer(url);
  if (cache.has(url)) { counters.cached++; return Promise.resolve({ ...cache.get(url), cached: true }); }
  return (async () => {
    const t0 = Date.now();
    let got;
    try { // downloads run in parallel; only the model is single-file
      const headers = { accept: 'image/avif,image/webp,image/*;q=0.8,*/*;q=0.5' };
      if (referer) headers.referer = referer;
      got = await net.fetchBuffer(url, { headers, timeout, maxBytes: MAX_BYTES, retries: 0 });
      if (got.status >= 400) throw new Error(`http ${got.status}`);
      if (/^(text|application\/json)/i.test(got.contentType)) throw new Error(`not an image (${got.contentType.split(';')[0]})`);
    } catch (e) {
      counters.errors++;
      return { status: 'error', reason: String(e.message || e).slice(0, 160) };
    }
    const job = chain.then(async () => {
      try { await init(); } catch (e) { return { status: 'unavailable', reason: e.message }; }
      try { return { status: 'ok', faces: await runModel(got.buffer) }; } catch (e) { counters.errors++; return { status: 'error', reason: String(e.message || e).slice(0, 160) }; }
    });
    chain = job.catch(() => {}); // keep the queue alive whatever happens
    const res = await job;
    res.ms = Date.now() - t0;
    if (res.status === 'ok') {
      counters.analyzed++; counters.totalMs += res.ms;
      cache.set(url, res);
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
 * @returns {Promise<{female: boolean, decided: boolean, status: string, faces: number, females: number, url?: string}>}
 */
async function checkItem(item, { threshold = 0.5 } = {}) {
  const url = imageUrlOf(item);
  if (!url) return { female: false, decided: false, status: 'no-image', faces: 0, females: 0 };
  let referer;
  try { referer = `${new URL(url).origin}/`; } catch { /* none */ }
  const verdict = judge(await analyze(url, { referer }), threshold);
  if (verdict.female) counters.female++;
  return { ...verdict, url };
}

/** Is the model usable? Starts loading it on first call. */
async function available() {
  if (analyzer) return true;
  try { await init(); return true; } catch { return false; }
}

function status() {
  return {
    ready: !!deps || !!analyzer, failed: initError ? initError.message : null, ...counters,
    avgMs: counters.analyzed ? Math.round(counters.totalMs / counters.analyzed) : 0,
  };
}

/** Test hook: replace the whole fetch+detect step with `fn(url) -> {status:'ok', faces:[{gender, score, confidence}]}`. */
function _setAnalyzer(fn) { analyzer = fn; }
function _reset() { cache.clear(); analyzer = null; }

module.exports = { analyze, judge, checkItem, imageUrlOf, available, status, init, _setAnalyzer, _reset };
