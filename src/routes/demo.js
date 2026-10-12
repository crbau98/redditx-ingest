'use strict';
/**
 * Development-only abstract artwork, enabled with DEMO_ART=1.
 * Lets the UI be previewed (see scripts/seed-demo.js) with no network access
 * and no real content. Never mounted in production.
 */
const express = require('express');
const path = require('path');
const config = require('../config');

const router = express.Router();

function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}

router.get('/art/:seed/:w/:h.svg', (req, res) => {
  const w = Math.min(Math.max(parseInt(req.params.w, 10) || 800, 64), 2000);
  const h = Math.min(Math.max(parseInt(req.params.h, 10) || 1000, 64), 2400);
  const r = rng(req.params.seed);
  const hue = Math.floor(r() * 360);
  const hue2 = (hue + 40 + Math.floor(r() * 120)) % 360;
  // Cheap on purpose: radial gradients instead of blur filters, so grids of these render instantly.
  let defs = ''; let shapes = '';
  for (let i = 0; i < 6; i++) {
    const cx = Math.floor(r() * w); const cy = Math.floor(r() * h); const rad = Math.floor(Math.min(w, h) * (0.3 + r() * 0.55));
    const c = `hsl(${(hue + i * 28) % 360} 85% ${52 + r() * 14}%)`;
    defs += `<radialGradient id="r${i}" cx="${cx}" cy="${cy}" r="${rad}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${c}" stop-opacity="${0.55 + r() * 0.3}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`;
    shapes += `<rect width="100%" height="100%" fill="url(#r${i})"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 65% 18%)"/><stop offset="1" stop-color="hsl(${hue2} 70% 30%)"/></linearGradient>${defs}</defs>
<rect width="100%" height="100%" fill="url(#g)"/>${shapes}</svg>`;
  res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' }).send(svg);
});

router.get('/video.webm', (req, res) => res.sendFile(path.join(config.dataDir, 'demo', 'video.webm')));

module.exports = router;
