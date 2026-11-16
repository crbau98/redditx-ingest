'use strict';
/**
 * Small on-disk LRU for proxied *images*. Origins throttle, expire signed
 * URLs and sometimes vanish; caching what we have already served keeps the
 * gallery working through all three. Videos are streamed, never cached.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const MAX_FILE = 6 * 1024 * 1024;
const maxBytes = config.mediaCacheMb * 1024 * 1024;
const dir = path.join(config.dataDir, 'cache');
let enabled = maxBytes > 0;
let puts = 0;

if (enabled) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { enabled = false; }
}

const keyOf = (url) => crypto.createHash('sha1').update(url).digest('hex');
const filePath = (key) => path.join(dir, `${key.slice(0, 2)}`, key);

function get(url) {
  if (!enabled) return null;
  const key = keyOf(url);
  const file = filePath(key);
  try {
    const meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
    const stat = fs.statSync(file);
    const now = new Date();
    fs.utimes(file, now, now, () => {});
    return { file, type: meta.type, size: stat.size };
  } catch { return null; }
}

function put(url, buffer, type) {
  if (!enabled || !buffer || buffer.length > MAX_FILE || buffer.length < 200) return;
  if (require('./diskguard').paused()) return; // the volume is nearly full: do not cache
  const file = filePath(keyOf(url));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
    fs.writeFileSync(`${file}.json`, JSON.stringify({ type }));
    if (approx >= 0) approx += buffer.length;
    if (++puts % 50 === 0) scheduleEvict();
  } catch { /* cache is best-effort */ }
}

// Eviction never runs on the request path: the proxy calls put() per image, and a full
// directory walk (tens of thousands of stats on a big cache) would stall every other request.
// Instead puts only schedule one run, at most once a minute, and the run itself skips the walk
// while the running byte estimate is under budget.
let lastEvict = 0;
let evictScheduled = false;
let approx = -1; // running byte estimate; unknown until the first full walk
function scheduleEvict() {
  if (evictScheduled || Date.now() - lastEvict < 60000) return;
  evictScheduled = true;
  setImmediate(() => { evictScheduled = false; evict().catch(() => {}); });
}

/**
 * Trim the cache to 85% of its budget when the running estimate says it is over (or unknown, after a restart). The walk is
 * asynchronous: readdir/stat of tens of thousands of files, one synchronous call each, held the event loop for the whole walk
 * (a cold network volume turns each stat into a disk read: seconds to minutes with the loop stopped). Now every call is a thread-pool
 * request, stats run 64 at a time, and the loop gets a turn between directories and between batches of unlinks.
 * Returns a promise; a second call while a walk is running joins it.
 */
let walking = null;
function evict({ force = false } = {}) {
  if (walking) return walking;
  if (!force && Date.now() - lastEvict < 60000) return Promise.resolve();
  lastEvict = Date.now();
  if (approx >= 0 && approx <= maxBytes) return Promise.resolve(); // cheap path: no directory walk
  walking = walk().catch(() => { /* ignore */ }).finally(() => { walking = null; });
  return walking;
}
const turn = () => new Promise((r) => setTimeout(r, 0));
async function walk() {
  const files = [];
  let total = 0;
  for (const sub of await fsp.readdir(dir)) {
    const subDir = path.join(dir, sub);
    let names;
    try { names = (await fsp.readdir(subDir)).filter((f) => !f.endsWith('.json')); } catch { continue; }
    for (let i = 0; i < names.length; i += 64) {
      const part = names.slice(i, i + 64);
      const sts = await Promise.all(part.map((f) => fsp.stat(path.join(subDir, f)).catch(() => null)));
      sts.forEach((st, k) => { if (!st) return; files.push({ p: path.join(subDir, part[k]), t: st.mtimeMs, s: st.size }); total += st.size; });
    }
    await turn();
  }
  approx = total;
  if (total <= maxBytes) return;
  files.sort((a, b) => a.t - b.t);
  let n = 0;
  for (const f of files) {
    if (total <= maxBytes * 0.85) break;
    try { await fsp.unlink(f.p); await fsp.unlink(`${f.p}.json`); approx -= f.s; } catch { /* ignore */ }
    total -= f.s;
    if (++n % 200 === 0) await turn();
  }
}

module.exports = { get, put, evict, MAX_FILE, get enabled() { return enabled; } };
