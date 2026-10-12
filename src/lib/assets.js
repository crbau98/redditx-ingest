'use strict';
/**
 * Versioned, permanently cacheable front-end assets — without a build step.
 *
 * At boot we hash every file under public/js and public/css. The app shell (index.html) is served
 * with its script/style URLs rewritten to /v/<hash>/…, and those paths are served with
 * `Cache-Control: immutable` for a year. Because every module imports its siblings with relative
 * paths ('./dom.js'), the whole module graph inherits the versioned prefix automatically.
 *
 * The shell also gets a <link rel="modulepreload"> for every module statically reachable from
 * main.js, so the browser fetches the graph in parallel instead of discovering it level by level
 * (on a 150 ms link that waterfall cost ~3 s before first paint).
 *
 * A deploy changes the hash, which changes every URL: no stale code, no revalidation round trips.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/** Modules reachable from `entry` through static `import … from './x.js'` (dynamic imports excluded). */
function staticGraph(jsRoot, entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) visit(path.resolve(path.dirname(file), m[1]));
    for (const m of src.matchAll(/^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) visit(path.resolve(path.dirname(file), m[1]));
  };
  visit(path.join(jsRoot, entry));
  return [...seen];
}

function build(publicDir) {
  const files = [...walk(path.join(publicDir, 'js')), ...walk(path.join(publicDir, 'css'))].sort();
  const h = crypto.createHash('sha1');
  for (const f of files) { h.update(path.relative(publicDir, f)); h.update(fs.readFileSync(f)); }
  const version = h.digest('hex').slice(0, 10);
  const prefix = `/v/${version}`;
  const graph = staticGraph(path.join(publicDir, 'js'), 'main.js').map((f) => `/${path.relative(publicDir, f).split(path.sep).join('/')}`);
  const raw = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const preloads = graph.map((u) => `<link rel="modulepreload" href="${prefix}${u}">`).join('\n');
  const html = raw
    .replace(/(href|src)="\/(js|css)\//g, `$1="${prefix}/$2/`)
    .replace('</head>', `${preloads}\n</head>`);
  return { version, prefix, html, modules: graph };
}

module.exports = { build, staticGraph };
