'use strict';
/**
 * The face + gender model itself (Human / BlazeFace + FaceRes on the TensorFlow.js WebAssembly backend).
 * No logging, no caching, no policy: just "bytes in, faces out". It runs inside worker threads (imagefilter-worker.js) so
 * inference never blocks the server's event loop, and in-process when IMAGE_WORKERS=0 (or when workers cannot start).
 */
const fs = require('fs');
const path = require('path');

const MAX_SIDE = 896; // faces in group shots are small: do not shrink more than this

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

/** @returns {Promise<{detect: (buf: Buffer) => Promise<object[]>, info: string}>} */
async function createModel() {
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

  async function detect(buffer) {
    const { data, info } = await sharp(buffer, { failOn: 'none', limitInputPixels: 60e6 })
      .rotate().removeAlpha().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .raw().toBuffer({ resolveWithObject: true });
    const tensor = human.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
    try {
      const result = await human.detect(tensor);
      return (result.face || []).map((f) => ({
        gender: f.gender || 'unknown', score: Number(f.genderScore) || 0, confidence: Number(f.score) || 0, age: Number.isFinite(f.age) ? Math.round(f.age) : null,
      }));
    } finally { human.tf.dispose(tensor); }
  }
  return { detect, info: `${human.tf.getBackend()} backend, models: ${loaded.join(', ')}` };
}

module.exports = { createModel };
