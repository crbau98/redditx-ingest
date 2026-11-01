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

/**
 * A conservative CSS minifier: drops comments and collapses whitespace outside strings, and removes the spaces
 * around { } ; , (nothing inside quotes, url() or calc() operators changes meaning).
 */
function minifyCss(css) {
  // One pass over char codes (a regex per character took a full second on the app's 150 KB).
  const WS = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
  const TIGHT = (c) => c === 123 || c === 125 || c === 59 || c === 44; // { } ; ,
  const out = []; let last = 0; let i = 0; const n = css.length;
  while (i < n) {
    const c = css.charCodeAt(i);
    if (c === 34 || c === 39) { // a string: copied verbatim
      let j = i + 1;
      while (j < n && css.charCodeAt(j) !== c) j += css.charCodeAt(j) === 92 ? 2 : 1;
      out.push(css.slice(i, j + 1)); last = c; i = j + 1; continue;
    }
    if (c === 47 && css.charCodeAt(i + 1) === 42) { const end = css.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (WS(c)) {
      while (i < n && WS(css.charCodeAt(i))) i++;
      if (out.length && !TIGHT(last) && i < n && !TIGHT(css.charCodeAt(i))) { out.push(' '); last = 32; }
      continue;
    }
    out.push(css[i]); last = c; i++;
  }
  return out.join('').replace(/;}/g, '}').trim();
}

// The stylesheets of the public app, in cascade order: served as one minified file.
const CSS_BUNDLE = ['tokens.css', 'app.css', 'ux.css', 'v6.css'];

// Development rebuilds the shell on every request (so edits show without a restart): keep the last build until a
// front-end file changes (a stat of each file is far cheaper than re-hashing and re-minifying them).
let memo = null;
function build(publicDir) {
  const files = [...walk(path.join(publicDir, 'js')), ...walk(path.join(publicDir, 'css')), path.join(publicDir, 'index.html')];
  const sig = `${publicDir}|${files.map((f) => { try { const st = fs.statSync(f); return `${f}:${st.size}:${st.mtimeMs}`; } catch { return f; } }).join('|')}`;
  if (memo && memo.sig === sig) return memo.value;
  const value = buildNow(publicDir);
  memo = { sig, value };
  return value;
}

function buildNow(publicDir) {
  const files = [...walk(path.join(publicDir, 'js')), ...walk(path.join(publicDir, 'css'))].sort();
  const h = crypto.createHash('sha1');
  for (const f of files) { h.update(path.relative(publicDir, f)); h.update(fs.readFileSync(f)); }
  const version = h.digest('hex').slice(0, 10);
  const prefix = `/v/${version}`;
  const graph = staticGraph(path.join(publicDir, 'js'), 'main.js').map((f) => `/${path.relative(publicDir, f).split(path.sep).join('/')}`);
  const raw = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const preloads = graph.map((u) => `<link rel="modulepreload" href="${prefix}${u}">`).join('\n');
  const css = minifyCss(CSS_BUNDLE.map((f) => path.join(publicDir, 'css', f)).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n'));
  // the separate stylesheet links in index.html become one link to the bundle
  const sheets = new RegExp(`(?:<link rel="stylesheet" href="/css/(?:${CSS_BUNDLE.map((f) => f.replace('.', '\\.')).join('|')})">\\s*)+`);
  const html = raw
    .replace(sheets, `<link rel="stylesheet" href="/css/bundle.css">\n`)
    .replace(/(href|src)="\/(js|css)\//g, `$1="${prefix}/$2/`)
    .replace('</head>', `${preloads}\n</head>`);
  return { version, prefix, html, css, modules: graph };
}

module.exports = { build, staticGraph, minifyCss, CSS_BUNDLE };
