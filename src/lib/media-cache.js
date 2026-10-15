'use strict';
/**
 * Small on-disk LRU for proxied *images*. Origins throttle, expire signed
 * URLs and sometimes vanish; caching what we have already served keeps the
 * gallery working through all three. Videos are streamed, never cached.
 */
const fs = require('fs');
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
  const file = filePath(keyOf(url));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
    fs.writeFileSync(`${file}.json`, JSON.stringify({ type }));
    approx += buffer.length;
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
  setImmediate(() => { evictScheduled = false; evict(); });
}
function evict({ force = false } = {}) {
  try {
    if (!force && Date.now() - lastEvict < 60000) return;
    lastEvict = Date.now();
    if (approx >= 0 && approx <= maxBytes) return; // cheap path: no directory walk
    const files = [];
    let total = 0;
    for (const sub of fs.readdirSync(dir)) {
      const subDir = path.join(dir, sub);
      for (const f of fs.readdirSync(subDir)) {
        if (f.endsWith('.json')) continue;
        const st = fs.statSync(path.join(subDir, f));
        files.push({ p: path.join(subDir, f), t: st.mtimeMs, s: st.size });
        total += st.size;
      }
    }
    approx = total;
    if (total <= maxBytes) return;
    files.sort((a, b) => a.t - b.t);
    for (const f of files) {
      if (total <= maxBytes * 0.85) break;
      try { fs.unlinkSync(f.p); fs.unlinkSync(`${f.p}.json`); approx -= f.s; } catch { /* ignore */ }
      total -= f.s;
    }
  } catch { /* ignore */ }
}

module.exports = { get, put, evict, MAX_FILE, get enabled() { return enabled; } };
