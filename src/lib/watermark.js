'use strict';
/**
 * The PRISM mark on a downloaded image: a small wordmark in the bottom-right corner, composited
 * once by sharp. Only the download path uses it (/api/proxy?mark=prism); normal viewing is never marked.
 */
const sharp = require('sharp');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const OUTPUT = new Set(['jpeg', 'png', 'webp', 'avif']);

/** Box geometry for an image of w×h: ~20% of the width, at least 96px, 3% in from the corner. */
function markBox(w, h) {
  const bw = clamp(Math.round(w * 0.2), 96, 240);
  const bh = Math.round(bw * 0.34);
  const pad = Math.max(8, Math.round(Math.min(w, h) * 0.03));
  return { x: w - bw - pad, y: h - bh - pad, w: bw, h: bh };
}

function markSvg(w, h) {
  const b = markBox(w, h);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
    + `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${Math.round(b.h / 4)}" fill="rgba(0,0,0,0.55)"/>`
    + `<text x="${b.x + b.w / 2}" y="${b.y + b.h * 0.7}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${Math.round(b.h * 0.56)}" fill="#fff">PRISM</text>`
    + '</svg>');
}

/**
 * @param {Buffer} input an image (jpeg, png, webp, gif, avif ...)
 * @returns {Promise<{buffer: Buffer, type: string}>} the marked image, in its own format where sharp can write it
 */
async function markImage(input) {
  const meta = await sharp(input, { failOn: 'error' }).metadata();
  const w = meta.width; const h = meta.height;
  if (!w || !h) throw new Error('not an image');
  const format = OUTPUT.has(meta.format) ? meta.format : 'png';
  const buffer = await sharp(input, { failOn: 'error' }).rotate()
    .composite([{ input: markSvg(w, h), top: 0, left: 0 }])
    .toFormat(format).toBuffer();
  return { buffer, type: `image/${format === 'jpeg' ? 'jpeg' : format}` };
}

module.exports = { markImage, markBox };
