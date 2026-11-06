'use strict';
/**
 * The PRISM mark on a downloaded image: a small wordmark in the bottom-right corner, composited
 * once by sharp. Only the download path uses it (/api/proxy?mark=prism); normal viewing is never marked.
 */
const sharp = require('sharp');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const OUTPUT = new Set(['jpeg', 'png', 'webp', 'avif']);
const ANIMATED = new Set(['gif', 'webp']);
// Re-marking a long animation is O(frames); past this many pixels the first frame is marked instead.
const ANIMATED_MAX_PIXELS = 60e6;

/** Box geometry for an image of w×h: ~20% of the width, at least 96px, 3% in from the corner. */
function markBox(w, h) {
  const bw = clamp(Math.round(w * 0.2), 96, 240);
  const bh = Math.round(bw * 0.34);
  const pad = Math.max(8, Math.round(Math.min(w, h) * 0.03));
  return { x: w - bw - pad, y: h - bh - pad, w: bw, h: bh };
}

function markParts(b) {
  return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${Math.round(b.h / 4)}" fill="rgba(0,0,0,0.55)"/>`
    + `<text x="${b.x + b.w / 2}" y="${b.y + b.h * 0.7}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${Math.round(b.h * 0.56)}" fill="#fff">PRISM</text>`;
}

function markSvg(w, h) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${markParts(markBox(w, h))}</svg>`);
}

/**
 * One SVG over the whole frame stack: sharp composites an animated image as a vertical strip, and an
 * overlay only lands on the first frame, so the mark is repeated at every frame's bottom-right corner.
 */
function marksSvg(w, frameH, pages) {
  const parts = markParts(markBox(w, frameH));
  let body = '';
  for (let p = 0; p < pages; p++) body += `<g transform="translate(0 ${p * frameH})">${parts}</g>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${frameH * pages}">${body}</svg>`);
}

/**
 * @param {Buffer} input an image (jpeg, png, webp, gif, avif ...)
 * @returns {Promise<{buffer: Buffer, type: string}>} the marked image, in its own format where sharp can write it
 */
async function markImage(input) {
  const meta = await sharp(input, { failOn: 'error', animated: true }).metadata();
  const w = meta.width; const h = meta.pageHeight || meta.height;
  const pages = meta.pages || 1;
  if (!w || !h) throw new Error('not an image');

  if (pages > 1 && ANIMATED.has(meta.format) && w * h * pages <= ANIMATED_MAX_PIXELS) {
    const drawn = sharp(input, { failOn: 'error', animated: true })
      .composite([{ input: marksSvg(w, h, pages), top: 0, left: 0 }]);
    const buffer = meta.format === 'gif' ? await drawn.gif().toBuffer() : await drawn.webp().toBuffer();
    return { buffer, type: `image/${meta.format}` };
  }

  const format = OUTPUT.has(meta.format) ? meta.format : 'png';
  const buffer = await sharp(input, { failOn: 'error' }).rotate()
    .composite([{ input: markSvg(w, meta.height), top: 0, left: 0 }])
    .toFormat(format).toBuffer();
  return { buffer, type: `image/${format === 'jpeg' ? 'jpeg' : format}` };
}

module.exports = { markImage, markBox };
