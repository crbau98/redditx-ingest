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
const zlib = require('zlib');
const { promisify } = require('util');

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
const CSS_BUNDLE = ['tokens.css', 'app.css', 'ux.css', 'v6.css', 'aurora.css'];

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

/* ------------------------------------------------------------ pre-compressed copies */
// The `compression` middleware squeezes every response on the fly at Brotli quality 4 (its default, chosen for speed).
// The app's own files never change within a version, so they are compressed once at quality 11 instead (about 15%
// smaller than quality 4 on this code base, see the test) and the bytes are served from memory with a Content-Length.
// Compression runs on the libuv thread pool, one file at a time, so it never blocks the event loop.
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const brotliQ11 = (buf) => brotli(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });

/** The best encoding the request accepts out of those we pre-compress: 'br', 'gzip' or null. */
function acceptedEncoding(header) {
  if (!header) return null;
  const q = {};
  for (const part of String(header).split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const m = /^\s*q\s*=\s*([0-9.]+)/.exec(params.join(';'));
    q[name.trim()] = m ? Number(m[1]) : 1;
  }
  const ok = (n) => (q[n] !== undefined ? q[n] > 0 : (q['*'] || 0) > 0);
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

/**
 * An in-memory store of pre-compressed responses. `add(key, type, body)` registers one and starts compressing it in
 * the background; `send(req, res, key, opts)` answers from it once it is ready and returns false when it is not (the
 * caller then falls back to the ordinary path), so a request is never held up by compression.
 */
function createCompressedStore() {
  const entries = new Map(); // key -> { type, raw, etag, br, gzip, work }
  const queue = [];
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const e = queue.shift();
        try { [e.br, e.gzip] = [await brotliQ11(e.raw), await gzip(e.raw, { level: 9 })]; } catch { /* stays uncompressed: served by the ordinary path */ }
        e.done();
      }
    } finally { running = false; }
  }

  return {
    has: (key) => entries.has(key),
    add(key, type, body) {
      if (entries.has(key)) return entries.get(key).work;
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const e = { type, raw, etag: crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16), br: null, gzip: null };
      e.work = new Promise((resolve) => { e.done = resolve; });
      entries.set(key, e);
      queue.push(e);
      drain();
      return e.work;
    },
    /** Resolves when everything added so far has been compressed (tests, boot warm-up). */
    async settled() { await Promise.all([...entries.values()].map((e) => e.work)); },
    /**
     * @param opts.immutable  `Cache-Control: public, max-age=31536000, immutable` (a versioned URL), otherwise `no-cache` + ETag revalidation
     * @returns true when the response was sent
     */
    send(req, res, key, { immutable = false } = {}) {
      const e = entries.get(key);
      const enc = acceptedEncoding(req.headers['accept-encoding']);
      const body = e && enc && (enc === 'br' ? e.br : e.gzip);
      if (!body) return false;
      const etag = `"${e.etag}-${enc}"`;
      res.set({ 'Content-Type': e.type, 'Content-Encoding': enc, Vary: 'Accept-Encoding', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
      if (!immutable) {
        res.set('ETag', etag);
        const inm = req.headers['if-none-match'];
        if (inm && inm.split(',').some((t) => t.trim() === etag)) { res.status(304).end(); return true; }
      }
      res.set('Content-Length', String(body.length));
      res.status(200);
      if (req.method === 'HEAD') res.end(); else res.end(body);
      return true;
    },
  };
}

/**
 * Express middleware for `/v/:ver/...` that answers .js and .css files of the CURRENT version from a
 * pre-compressed store. Anything else (another version, another type, not ready yet, a client that accepts no
 * encoding) is passed on with next().
 */
function compressedStatic(publicDir, store, currentVersion) {
  const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const root = path.resolve(publicDir);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const ext = path.extname(req.path);
    if (!TYPES[ext] || req.params.ver !== currentVersion()) return next();
    const file = path.resolve(root, `.${req.path}`);
    const inside = path.relative(root, file);
    if (inside.startsWith('..') || path.isAbsolute(inside) || !/^(js|css)[\\/]/.test(inside)) return next();
    const key = `${req.params.ver}${req.path}`;
    if (!store.has(key)) {
      let raw; try { raw = fs.readFileSync(file); } catch { return next(); }
      store.add(key, TYPES[ext], raw);
      return next(); // this first request takes the ordinary path
    }
    return store.send(req, res, key, { immutable: true }) ? undefined : next();
  };
}

/** Pre-compress everything the shell references, in the background (called once the server is listening). */
function warmCompressed(store, publicDir, built) {
  const root = path.resolve(publicDir);
  store.add(`${built.version}/css/bundle.css`, 'text/css; charset=utf-8', built.css);
  store.add(`${built.version}:shell`, 'text/html; charset=utf-8', built.html);
  // every module, not only the static graph: the views load on first visit and are fetched ahead while idle
  for (const file of walk(path.join(root, 'js')).filter((f) => f.endsWith('.js'))) {
    try { store.add(`${built.version}/${path.relative(root, file).split(path.sep).join('/')}`, 'text/javascript; charset=utf-8', fs.readFileSync(file)); } catch { /* gone: ordinary path */ }
  }
  return store.settled();
}

module.exports = { build, staticGraph, minifyCss, CSS_BUNDLE, acceptedEncoding, createCompressedStore, compressedStatic, warmCompressed };
