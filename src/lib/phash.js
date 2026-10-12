'use strict';
/**
 * Perceptual image hashing, for finding the SAME picture across platforms, re-uploads, re-encodes and resizes.
 *
 * Two 64-bit hashes are computed from one 32x32 grayscale rendition and stored together as 32 hex characters:
 *   pHash (hex 0-15)   DCT based: the low-frequency structure of the picture. Survives resizing, JPEG recompression,
 *                      mild colour/brightness changes and watermarks better than anything pixel-based.
 *   dHash (hex 16-31)  horizontal gradients of a 9x8 rendition. A cheap second opinion that rejects pHash look-alikes.
 * Two pictures are "the same" when BOTH are close (see `similar`): this is what keeps false positives rare.
 *
 * Pictures with almost no structure (solid colours, dark frames) hash to near-identical values whatever they show, so
 * they are never hashed (hashBuffer returns null): better to miss a duplicate than to merge two different photos.
 */
const N = 32;          // rendition size for the DCT
const KEEP = 8;        // low-frequency block kept
const MIN_STDDEV = 7;  // below this the picture is "flat"

let sharpMod = null;
function sharp() { if (!sharpMod) sharpMod = require('sharp'); return sharpMod; }

// Precomputed DCT-II basis for N points.
const COS = (() => {
  const t = new Float64Array(N * N);
  for (let k = 0; k < N; k++) for (let n = 0; n < N; n++) t[k * N + n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));
  return t;
})();

/** 2-D DCT of an NxN block, returning only the top-left KEEPxKEEP coefficients (separable: rows, then columns). */
function dctLow(gray) {
  const tmp = new Float64Array(KEEP * N); // KEEP row-frequencies x N columns... computed per input row
  // rows: for each input row y, transform along x for the first KEEP frequencies
  const rowT = new Float64Array(N * KEEP);
  for (let y = 0; y < N; y++) {
    for (let u = 0; u < KEEP; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += gray[y * N + x] * COS[u * N + x];
      rowT[y * KEEP + u] = s;
    }
  }
  const out = new Float64Array(KEEP * KEEP);
  for (let u = 0; u < KEEP; u++) {
    for (let v = 0; v < KEEP; v++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rowT[y * KEEP + u] * COS[v * N + y];
      out[v * KEEP + u] = s;
    }
  }
  void tmp;
  return out;
}

const hex16 = (bits) => { // bits: array of 64 booleans -> 16 hex chars
  let out = '';
  for (let i = 0; i < 64; i += 4) out += ((bits[i] ? 8 : 0) | (bits[i + 1] ? 4 : 0) | (bits[i + 2] ? 2 : 0) | (bits[i + 3] ? 1 : 0)).toString(16);
  return out;
};

/** pHash of a 32x32 grayscale array (values 0..255). */
function pHashOf(gray) {
  const c = dctLow(gray);
  const ac = Array.from(c).slice(1).sort((a, b) => a - b); // skip the DC term
  const median = (ac[Math.floor(ac.length / 2) - 1] + ac[Math.floor(ac.length / 2)]) / 2;
  const bits = new Array(64).fill(false);
  for (let i = 1; i < 64; i++) bits[i] = c[i] > median;
  return hex16(bits);
}

/** dHash of a 9x8 grayscale array. */
function dHashOf(gray9x8) {
  const bits = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(gray9x8[y * 9 + x] > gray9x8[y * 9 + x + 1]);
  return hex16(bits);
}

/** Population count of a 4-bit nibble table for fast Hamming distance on hex strings. */
const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
function hamming(a, b) {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

/**
 * @param {Buffer} buf image bytes (any format sharp reads)
 * @returns {Promise<string|null>} 32 hex chars, or null when the picture is unusable (flat / unreadable)
 */
async function hashBuffer(buf) {
  try {
    const base = sharp()(buf, { failOn: 'none', limitInputPixels: 60e6 }).rotate().removeAlpha().greyscale();
    const [big, small] = await Promise.all([
      base.clone().resize(N, N, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer(),
      base.clone().resize(9, 8, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer(),
    ]);
    let mean = 0; for (let i = 0; i < big.length; i++) mean += big[i];
    mean /= big.length;
    let varSum = 0; for (let i = 0; i < big.length; i++) varSum += (big[i] - mean) ** 2;
    if (Math.sqrt(varSum / big.length) < MIN_STDDEV) return null;
    return pHashOf(big) + dHashOf(small);
  } catch { return null; }
}

/** Distances between two stored hashes. */
function distances(a, b) {
  if (!a || !b || a.length !== 32 || b.length !== 32) return { p: 64, d: 64 };
  return { p: hamming(a.slice(0, 16), b.slice(0, 16)), d: hamming(a.slice(16), b.slice(16)) };
}

/** Same picture? pHash within `max` bits AND dHash within max+6 (dHash moves more under crops and shifts). */
function similar(a, b, max = 6) {
  const { p, d } = distances(a, b);
  return p <= max && d <= max + 6;
}

module.exports = { hashBuffer, hamming, distances, similar, pHashOf, dHashOf, N, MIN_STDDEV };
