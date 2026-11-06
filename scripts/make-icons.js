'use strict';
/**
 * Renders the install icons from public/favicon.svg into public/icons/ (needs sharp, an optional dependency):
 *
 *     node scripts/make-icons.js
 *
 * icon-192 / icon-512 keep the rounded tile of the favicon ("any"). icon-maskable-512 and apple-touch-icon are full
 * bleed with the mark scaled into the inner 70% so a circular / squircle mask never clips it (the Android "safe zone"
 * is the inner 80%). The PNGs are committed; run this only when the mark changes.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const pub = path.join(__dirname, '..', 'public');
const out = path.join(pub, 'icons');
fs.mkdirSync(out, { recursive: true });
const svg = fs.readFileSync(path.join(pub, 'favicon.svg'), 'utf8');
const glyph = svg.replace(/^[\s\S]*?<\/defs>/, '').replace(/<rect[^>]*\/>/, '').replace('</svg>', '');
const defs = svg.match(/<defs>[\s\S]*?<\/defs>/)[0];
const bleed = (scale) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">${defs}<rect width="64" height="64" fill="#0b0b11"/><g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${glyph}</g></svg>`);

(async () => {
  await sharp(Buffer.from(svg), { density: 384 }).resize(192, 192).png({ compressionLevel: 9 }).toFile(path.join(out, 'icon-192.png'));
  await sharp(Buffer.from(svg), { density: 384 }).resize(512, 512).png({ compressionLevel: 9 }).toFile(path.join(out, 'icon-512.png'));
  await sharp(bleed(0.7), { density: 384 }).resize(512, 512).png({ compressionLevel: 9 }).toFile(path.join(out, 'icon-maskable-512.png'));
  await sharp(bleed(0.78), { density: 384 }).resize(180, 180).png({ compressionLevel: 9 }).toFile(path.join(out, 'apple-touch-icon.png'));
  console.log('icons written to', out);
})().catch((e) => { console.error(e); process.exit(1); });
