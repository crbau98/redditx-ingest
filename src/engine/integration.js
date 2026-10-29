'use strict';
/**
 * THE ONLY MODULE THAT TOUCHES EXISTING PRISM INTERNALS.
 *
 * Every new module (firehoses, nostr, extractor, backfill) talks
 * to the app through here. Written without repo access: each binding probes a
 * list of plausible export names and FAILS LOUDLY rather than silently no-op.
 *
 * INTEGRATION STEP: run `node -e "require('./src/engine/integration').selfTest()"`.
 * Anything it reports unbound, fix in this file. Nothing else needs editing.
 */

const path = require('node:path');

function tryRequire(...candidates) {
  for (const c of candidates) {
    try { return require(c); }
    catch (err) {
      if (!err || err.code !== 'MODULE_NOT_FOUND') throw err;
      if (err.message && !err.message.includes(c)) throw err; // nested failure, not ours
    }
  }
  return null;
}

function pick(obj, names, label) {
  if (obj) for (const n of names) if (typeof obj[n] === 'function') return obj[n].bind(obj);
  const err = new Error(
    `[prism-integration] could not bind "${label}". Tried: ${names.join(', ')}. ` +
    `Edit src/engine/integration.js and point it at the real export.`
  );
  err.code = 'PRISM_INTEGRATION_UNBOUND';
  throw err;
}

// ---------------------------------------------------------------- logging ---
const rawLog = tryRequire('../lib/log', '../lib/logger', '../util/log', '../log');

function mkLogger(scope) {
  if (rawLog) {
    if (typeof rawLog.child === 'function') return rawLog.child(scope);
    if (typeof rawLog.scoped === 'function') return rawLog.scoped(scope);
    if (typeof rawLog.info === 'function') {
      return {
        debug: (...a) => (rawLog.debug || rawLog.info)(`[${scope}]`, ...a),
        info: (...a) => rawLog.info(`[${scope}]`, ...a),
        warn: (...a) => (rawLog.warn || rawLog.info)(`[${scope}]`, ...a),
        error: (...a) => (rawLog.error || rawLog.info)(`[${scope}]`, ...a),
      };
    }
  }
  const stamp = () => new Date().toISOString();
  return {
    debug: (...a) => (process.env.PRISM_DEBUG ? console.log(stamp(), 'DEBUG', `[${scope}]`, ...a) : undefined),
    info: (...a) => console.log(stamp(), 'INFO ', `[${scope}]`, ...a),
    warn: (...a) => console.warn(stamp(), 'WARN ', `[${scope}]`, ...a),
    error: (...a) => console.error(stamp(), 'ERROR', `[${scope}]`, ...a),
  };
}

// ------------------------------------------------------------------- repo ---
const repoMod = tryRequire('../db/repo', '../db/repository', '../db');
const pipelineMod = tryRequire('./pipeline', '../engine/pipeline');
const netMod = tryRequire('../lib/net');

let _db = null;
function db() {
  if (_db) return _db;
  if (repoMod && repoMod.db) _db = typeof repoMod.db === 'function' ? repoMod.db() : repoMod.db;
  else if (repoMod && typeof repoMod.getDb === 'function') _db = repoMod.getDb();
  else {
    const m = tryRequire('../db/index', '../db/connection', '../db');
    _db = m && (m.db || (m.getDb && m.getDb()));
  }
  if (!_db) {
    const err = new Error('[prism-integration] no better-sqlite3 handle found');
    err.code = 'PRISM_INTEGRATION_UNBOUND';
    throw err;
  }
  return _db;
}

// ---------------------------------------------------------------- cursors ---
let cursorStmts = null;
function cursors() {
  if (cursorStmts) return cursorStmts;
  const d = db();
  cursorStmts = {
    get: d.prepare('SELECT cursor FROM firehose_cursor WHERE source = ?'),
    set: d.prepare(
      `INSERT INTO firehose_cursor (source, cursor, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`
    ),
  };
  return cursorStmts;
}

async function loadCursor(source) {
  try { const r = cursors().get.get(source); return r ? r.cursor : null; }
  catch (e) { mkLogger('integration').warn('loadCursor failed', source, e.message); return null; }
}
async function saveCursor(source, cursor) {
  try { cursors().set.run(source, String(cursor), Date.now()); return true; }
  catch (e) { mkLogger('integration').warn('saveCursor failed', source, e.message); return false; }
}
// --------------------------------------------------------------- settings ---
// Precedence: env (hard override, no DB needed) > settings table (no redeploy) > default.
const _settingGet = repoMod
  ? (repoMod.getSetting || repoMod.settingGet || repoMod.getConfig || null)
  : null;

function settingBool(key, envKey, dflt) {
  const env = process.env[envKey];
  if (env !== undefined && env !== '') return /^(1|true|on|yes)$/i.test(env);
  if (typeof _settingGet === 'function') {
    try {
      const v = _settingGet(key);
      if (v !== undefined && v !== null && v !== '') {
        return v === 1 || v === '1' || v === true || String(v).toLowerCase() === 'true';
      }
    } catch { /* settings table may not exist on first boot */ }
  }
  return dflt;
}

// ------------------------------------------------------------------ leads ---
let _upsertLead = null;
/** Resolves the lead writer without calling it, so probes never write. */
function leadWriter() {
  if (!_upsertLead) {
    _upsertLead = pick(repoMod,
      ['upsertDiscoveryLead', 'upsertLead', 'insertLead', 'addLead', 'recordLead', 'saveLead'],
      'emitLead');
  }
  return _upsertLead;
}
function emitLead(lead) {
  return leadWriter()(lead);
}

function leadExists(platform, externalId) {
  const fn = repoMod && (repoMod.getDiscoveryLead || repoMod.getLead || repoMod.findLead);
  if (typeof fn !== 'function') return false;
  try { return Boolean(fn.call(repoMod, platform, externalId)); } catch { return false; }
}

// --------------------------------------------------------------- pipeline ---
// EVERY media item from every new module goes through here. No other write path.
let _ingest = null;
/** Resolves the pipeline entry point without calling it, so probes never process items. */
function pipelineWriter() {
  if (!_ingest) {
    _ingest = pick(pipelineMod,
      ['processItem', 'runItem', 'ingestItem', 'handleItem', 'process', 'run'],
      'pipeline.processItem');
  }
  return _ingest;
}
async function ingest(item, ctx) {
  return pipelineWriter()(item, ctx);
}

// --------------------------------------------------------------- creators ---
function listCreators(limit, offset) {
  const fn = repoMod && (repoMod.listCreators || repoMod.getCreators || repoMod.allCreators);
  if (typeof fn !== 'function') return [];
  return fn.call(repoMod, limit, offset) || [];
}
function findCreatorByHandle(platform, handle) {
  const fn = repoMod && (repoMod.findCreatorByHandle || repoMod.getCreatorByHandle);
  if (typeof fn !== 'function') return null;
  try { return fn.call(repoMod, platform, handle) || null; } catch { return null; }
}

// --------------------------------------------------------------- pressure ---
/** Backfill yields to live ingestion. 0 when the engine exposes nothing. */
function livePressure() {
  const eng = tryRequire('./engine', './scheduler');
  if (eng) {
    for (const n of ['queueDepth', 'pendingCount', 'liveQueueDepth', 'backlog']) {
      if (typeof eng[n] === 'function') { try { return Number(eng[n]()) || 0; } catch { /* noop */ } }
    }
  }
  return 0;
}

// ------------------------------------------------------------- http (net) ---
/** All outbound HTTP from new modules routes through the audited SSRF client. */
async function fetchJSON(url, opts) {
  if (netMod && typeof netMod.fetchJSON === 'function') return netMod.fetchJSON(url, opts);
  const r = await globalThis.fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
async function fetchText(url, opts) {
  if (netMod && typeof netMod.fetchText === 'function') return netMod.fetchText(url, opts);
  const r = await globalThis.fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

const log = (level, msg, meta) => {
  const l = mkLogger('prism');
  (l[level] || l.info)(msg, meta === undefined ? '' : meta);
};

/** Run at integration time. Reports every binding as OK or UNBOUND. */
function selfTest() {
  const checks = [
    ['db', () => db()],
    ['loadCursor', () => cursors()],
    ['emitLead', () => leadWriter()],
    ['ingest', () => pipelineWriter()],
    ['listCreators', () => listCreators(1, 0)],
  ];
  for (const [name, fn] of checks) {
    try { fn(); console.log(`  OK       ${name}`); }
    catch (e) {
      const tag = e.code === 'PRISM_INTEGRATION_UNBOUND' ? 'UNBOUND ' : 'ERR     ';
      console.log(`  ${tag} ${name}: ${e.message}`);
    }
  }
}

module.exports = {
  log, mkLogger, db,
  loadCursor, saveCursor, settingBool,
  getFirehoseCursor: loadCursor, setFirehoseCursor: saveCursor,
  emitLead, leadExists, ingest,
  listCreators, findCreatorByHandle, livePressure,
  fetchJSON, fetchText, selfTest,
  _internals: { repoMod, pipelineMod, netMod, rootDir: path.resolve(__dirname, '..', '..') },
};
