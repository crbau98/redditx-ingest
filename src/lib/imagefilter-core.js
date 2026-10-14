'use strict';
/**
 * The models themselves (Human on the TensorFlow.js WebAssembly backend): BlazeFace + FaceRes for faces and gender, and,
 * for the physique check, MoveNet-Lightning body keypoints + MediaPipe selfie segmentation (a person silhouette; weights
 * vendored in /models, ~300 KB). No logging, no caching, no policy: just "bytes in, faces (and a body measurement) out". It runs inside worker threads (imagefilter-worker.js) so
 * inference never blocks the server's event loop, and in-process when IMAGE_WORKERS=0 (or when workers cannot start).
 */
const fs = require('fs');
const path = require('path');
const physique = require('./physique');

const MAX_SIDE = 896; // faces in group shots are small: do not shrink more than this
const SELFIE_MODEL = path.join(__dirname, '..', '..', 'models', 'selfie.json');

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
    body: { enabled: true, modelPath: 'movenet-lightning.json', maxDetected: 1, minConfidence: 0.2 },
    hand: { enabled: false }, object: { enabled: false }, gesture: { enabled: false },
    segmentation: { enabled: fs.existsSync(SELFIE_MODEL), modelPath: `file://${SELFIE_MODEL}`, mode: 'alpha' },
  });
  await withFileFetch(async () => { await human.load(); });
  const loaded = Object.values(human.models.loaded ? human.models.loaded() : {});
  if (!loaded.length) throw new Error('face models did not load');
  const canMeasure = loaded.includes('movenet') && loaded.includes('selfie');

  /**
   * Silhouette of the torso region only: the segmentation model works at 256 px, so cropping to the shoulders-to-hips box
   * (plus room for the arms) keeps the gap between an arm and the belly visible instead of blurring them into one blob.
   */
  async function measureBody(tensor, keypoints, width, height) {
    const pick = (p) => keypoints.find((k) => k.part === p && k.score >= 0.3);
    const pts = ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'].map(pick);
    if (pts.some((k) => !k)) return { decided: false, reason: 'torso not in view' };
    const xs = pts.map((k) => k.position[0]); const ys = pts.map((k) => k.position[1]);
    const L = Math.hypot((xs[0] + xs[1] - xs[2] - xs[3]) / 2, (ys[0] + ys[1] - ys[2] - ys[3]) / 2);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - 0.7 * L)); const x1 = Math.min(width, Math.ceil(Math.max(...xs) + 0.7 * L));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - 0.25 * L)); const y1 = Math.min(height, Math.ceil(Math.max(...ys) + 0.25 * L));
    if (x1 - x0 < 16 || y1 - y0 < 16) return { decided: false, reason: 'body too small' };
    const t = {};
    try {
      t.crop = human.tf.slice(tensor, [y0, x0, 0], [y1 - y0, x1 - x0, 3]);
      t.input = human.tf.expandDims(human.tf.cast(t.crop, 'float32'), 0);
      t.mask = await human.segmentation(t.input);
      if (!t.mask) return { decided: false, reason: 'no silhouette' };
      const mask = await t.mask.data();
      const local = keypoints.map((k) => ({ part: k.part, score: k.score, position: [k.position[0] - x0, k.position[1] - y0] }));
      return physique.measure(local, mask, x1 - x0, y1 - y0);
    } finally { for (const v of Object.values(t)) if (v) human.tf.dispose(v); }
  }

  /** @returns {Promise<{faces: object[], body: object|null}>} `body` only when asked for (and measurable at all). */
  async function detect(buffer, { body = false } = {}) {
    const { data, info } = await sharp(buffer, { failOn: 'none', limitInputPixels: 60e6 })
      .rotate().removeAlpha().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .raw().toBuffer({ resolveWithObject: true });
    const tensor = human.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
    const wantBody = body && canMeasure;
    try {
      // Human merges per-call config into its own: always say both, so one call's choice never leaks into the next.
      const result = await human.detect(tensor, { body: { enabled: wantBody } });
      const faces = (result.face || []).map((f) => ({
        gender: f.gender || 'unknown', score: Number(f.genderScore) || 0, confidence: Number(f.score) || 0, age: Number.isFinite(f.age) ? Math.round(f.age) : null,
      }));
      let measured = null;
      if (wantBody) {
        const kps = (result.body && result.body[0] && result.body[0].keypoints) || [];
        measured = kps.length ? await measureBody(tensor, kps, info.width, info.height) : { decided: false, reason: 'no body' };
      }
      return { faces, body: measured };
    } finally { human.tf.dispose(tensor); }
  }
  /** Visual embedding for "More like this" (lib/embeddings): loaded on first use, so workers that never embed pay nothing. */
  let backbone = null;
  async function embed(buffer) {
    const embeddings = require('./embeddings');
    if (!backbone) backbone = embeddings.loadBackbone(human.tf);
    const features = await backbone;
    const { data, info } = await sharp(buffer, { failOn: 'none', limitInputPixels: 60e6 })
      .rotate().removeAlpha().resize({ width: 224, height: 224, fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const tensor = human.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
    try { return embeddings.pack(embeddings.project(await features(tensor))); } finally { human.tf.dispose(tensor); }
  }
  return { detect, embed, canMeasure, info: `${human.tf.getBackend()} backend, models: ${loaded.join(', ')}` };
}

module.exports = { createModel };
