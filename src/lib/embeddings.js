'use strict';
/**
 * Visual embeddings for "More like this": a compact vector per picture that places similar-looking pictures close
 * together (setting, framing, body, light, style). It is search by look: no face or identity model is involved.
 *
 * Model: MobileNetV2 at 224 px, an ImageNet backbone fine-tuned on adult and neutral photos (the MIT-licensed nsfwjs
 * package), vendored as /models/mobilenet.json + .bin (~2.6 MB of uint8-quantised weights). Human bundles TensorFlow.js
 * core and the WebAssembly backend but not the layers API, so the Keras layer graph is run here with core ops; the image
 * workers already hold that runtime, so this adds no dependency. Cost: one 224 px pass, a few tens of ms of CPU.
 *
 * Vector: the 1280-d pooled backbone features, square-rooted (so a few strong channels do not drown the rest), projected
 * to DIM dims by a fixed seeded Gaussian projection and L2-normalised. Stored as a 4-byte float scale plus DIM int8
 * values (`pack`), DIM + 4 bytes per item.
 */
const fs = require('fs');
const path = require('path');

const MODEL_ID = 'mnv2-p256-v1';
const DIM = 256;
const FEATURES = 1280;
const SIZE = 224;
const MODEL_JSON = path.join(__dirname, '..', '..', 'models', 'mobilenet.json');

/** Deterministic Gaussian projection (mulberry32 + Box-Muller), so every process and every rebuild agrees. */
let projection = null;
function getProjection() {
  if (projection) return projection;
  let s = 0x9e3779b9 >>> 0;
  const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  projection = new Float32Array(FEATURES * DIM);
  for (let i = 0; i < projection.length; i += 2) {
    const u = Math.max(1e-12, rand()); const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    projection[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < projection.length) projection[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return projection;
}

/** 1280 pooled features -> unit-length DIM-d Float32Array. */
function project(features) {
  const P = getProjection();
  const out = new Float32Array(DIM);
  for (let i = 0; i < FEATURES; i++) {
    const x = Math.sqrt(Math.max(0, features[i]));
    if (!x) continue;
    const row = i * DIM;
    for (let j = 0; j < DIM; j++) out[j] += x * P[row + j];
  }
  let ss = 0;
  for (let j = 0; j < DIM; j++) ss += out[j] * out[j];
  const n = Math.sqrt(ss) || 1;
  for (let j = 0; j < DIM; j++) out[j] /= n;
  return out;
}

/** Float vector -> Buffer [float32 scale][int8 x DIM]. */
function pack(vec) {
  let max = 0;
  for (const x of vec) if (Math.abs(x) > max) max = Math.abs(x);
  const scale = max / 127 || 1;
  const buf = Buffer.alloc(4 + vec.length);
  buf.writeFloatLE(scale, 0);
  for (let i = 0; i < vec.length; i++) buf.writeInt8(Math.max(-127, Math.min(127, Math.round(vec[i] / scale))), 4 + i);
  return buf;
}

/** Buffer from `pack` -> {scale, q: Int8Array} (a view, no copy), or null when malformed. */
function unpack(buf) {
  if (!buf || buf.length !== 4 + DIM) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return { scale: b.readFloatLE(0), q: new Int8Array(b.buffer, b.byteOffset + 4, DIM) };
}

/**
 * Load the backbone onto `tf` (Human's bundled TensorFlow.js). Returns `features(rgbTensor3d) -> Promise<Float32Array(1280)>`.
 * Only the layers up to the global pool are kept; the classifier head is never run.
 */
async function loadBackbone(tf, jsonPath = MODEL_JSON) {
  const spec = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const manifest = spec.weightsManifest[0];
  const bin = fs.readFileSync(path.join(path.dirname(jsonPath), manifest.paths[0]));
  const weights = tf.io.decodeWeights(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), manifest.weights);
  const layers = spec.modelTopology.model_config.config.layers;
  const stop = layers.findIndex((l) => l.class_name === 'AveragePooling2D');
  if (stop < 0) throw new Error('mobilenet: no pooling layer');
  const plan = layers.slice(0, stop + 1).map((l) => ({ name: l.name, kind: l.class_name, cfg: l.config, inputs: (l.inbound_nodes[0] || []).map((n) => n[0]) }));
  const W = (name) => { const w = weights[name]; if (!w) throw new Error(`mobilenet: missing weight ${name}`); return w; };
  const pad = (p) => (p === 'same' ? 'same' : 'valid');

  function run(x) {
    const out = new Map();
    for (const L of plan) {
      const a = L.inputs.map((n) => out.get(n));
      let y;
      switch (L.kind) {
        case 'InputLayer': y = x; break;
        case 'ZeroPadding2D': { const [[t, b], [l, r]] = L.cfg.padding; y = tf.pad(a[0], [[0, 0], [t, b], [l, r], [0, 0]]); break; }
        case 'Conv2D': y = tf.conv2d(a[0], W(`${L.name}/kernel`), L.cfg.strides, pad(L.cfg.padding)); if (L.cfg.use_bias) y = tf.add(y, W(`${L.name}/bias`)); break;
        case 'DepthwiseConv2D': y = tf.depthwiseConv2d(a[0], W(`${L.name}/depthwise_kernel`), L.cfg.strides, pad(L.cfg.padding)); if (L.cfg.use_bias) y = tf.add(y, W(`${L.name}/bias`)); break;
        case 'BatchNormalization': y = tf.batchNorm(a[0], W(`${L.name}/moving_mean`), W(`${L.name}/moving_variance`), W(`${L.name}/beta`), W(`${L.name}/gamma`), L.cfg.epsilon); break;
        case 'ReLU': y = Number.isFinite(L.cfg.max_value) ? tf.clipByValue(a[0], 0, L.cfg.max_value) : tf.relu(a[0]); break;
        case 'Add': y = tf.add(a[0], a[1]); break;
        case 'AveragePooling2D': y = tf.avgPool(a[0], L.cfg.pool_size, L.cfg.strides, pad(L.cfg.padding)); break;
        default: throw new Error(`mobilenet: unsupported layer ${L.kind}`);
      }
      out.set(L.name, y);
    }
    return out.get(plan[plan.length - 1].name);
  }

  return async function features(rgb) {
    const pooled = tf.tidy(() => {
      const img = tf.div(tf.cast(rgb, 'float32'), 255);
      const sized = tf.image.resizeBilinear(img, [SIZE, SIZE], true);
      return tf.reshape(run(tf.expandDims(sized, 0)), [FEATURES]);
    });
    try { return await pooled.data(); } finally { tf.dispose(pooled); }
  };
}

module.exports = { MODEL_ID, DIM, project, pack, unpack, loadBackbone, getProjection };
