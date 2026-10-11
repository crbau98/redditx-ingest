'use strict';
// Copies browser-side dependencies out of node_modules into public/vendor so the
// production image (npm install --omit=dev) needs no CDN and no build step.
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });

const hls = path.dirname(require.resolve('hls.js/package.json'));
const files = [
  [path.join(hls, 'dist', 'hls.light.min.js'), 'hls.light.min.js'],
  [path.join(hls, 'LICENSE'), 'hls.js.LICENSE'],
];
for (const [from, to] of files) {
  fs.copyFileSync(from, path.join(out, to));
  console.log('vendored', to);
}
