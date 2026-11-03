'use strict';
/**
 * Move the media that was written to the data volume (/data/store) into the bucket, under the same keys, so every stored URL
 * (https://media.prism.invalid/<key>) keeps resolving. Runs inside the container as an admin-started background job.
 *
 *   dry-run   (default) counts files and bytes per top-level folder and, with `check`, asks the bucket about a sample. Changes nothing.
 *   copy      uploads each file that is not in the bucket yet and then HEADs it: the object must exist with exactly the local size.
 *   delete    a SEPARATE switch on top of copy: a local file is removed only after its bucket copy was verified by that HEAD and
 *             the local file did not change in the meantime. Off unless asked for twice (see routes/admin.js).
 *
 * Resumable: every file is checked against the bucket before it is uploaded, so a restart simply walks again and skips what is
 * done; the cursor (last key handled) in settings only saves the re-walk. Reads stay correct throughout: lib/objectstore serves a
 * key from the local folder while the bucket does not have it yet.
 */
const fs = require('fs');
const repo = require('../db/repo');
const store = require('../lib/objectstore');
const events = require('../engine/events');

const KEY = 'store_migrate';
const CONCURRENCY = 3;
let job = null; // the running job { stop: bool, promise }

const top = (key) => (key.includes('/') ? key.slice(0, key.indexOf('/')) : '(root)');
const load = () => { try { return JSON.parse(repo.settings.get(KEY) || 'null'); } catch { return null; } };
const save = (st) => { try { repo.settings.set(KEY, JSON.stringify(st)); } catch { /* best effort */ } };

const fresh = (mode, opts) => ({
  mode, deleteLocal: !!opts.deleteLocal, startedAt: new Date().toISOString(), finishedAt: null, state: 'running',
  files: 0, bytes: 0, skippedInvalid: 0, alreadyThere: 0, alreadyBytes: 0, copied: 0, copiedBytes: 0, verified: 0,
  deleted: 0, deletedBytes: 0, failed: 0, errors: [], cursor: null, byFolder: {}, sample: null,
});

/** Read-only report: how much is on the volume, per folder, and (optionally) how much of a sample is already in the bucket. */
async function dryRun({ check = 0 } = {}) {
  const r = fresh('dry-run', {});
  const ready = store.s3Ready();
  let probed = 0; let there = 0;
  const seen = [];
  for (const o of store.localObjects()) {
    if (!store.validKey(o.key)) { r.skippedInvalid++; continue; }
    r.files++; r.bytes += o.size;
    const f = (r.byFolder[top(o.key)] ||= { files: 0, bytes: 0 });
    f.files++; f.bytes += o.size;
    if (check > 0 && ready) seen.push(o); // reservoir below
  }
  if (check > 0 && ready && seen.length) {
    const step = Math.max(1, Math.floor(seen.length / check));
    for (let i = 0; i < seen.length && probed < check; i += step) {
      probed++;
      try { const h = await store.headS3(seen[i].key); if (h.exists && h.size === seen[i].size) there++; } catch { /* counted as not there */ }
    }
    r.sample = { probed, alreadyInBucket: there, estimatedFilesToCopy: Math.round(r.files * (1 - there / probed)) };
  }
  r.state = 'done'; r.finishedAt = new Date().toISOString();
  r.bucket = ready ? store.describe() : { error: 'the bucket is not configured (MEDIA_STORE_*): a copy cannot start' };
  r.mb = Math.round(r.bytes / 1048576);
  save(r);
  return r;
}

async function moveOne(o, st, deleteLocal) {
  let head = await store.headS3(o.key);
  if (head.exists && head.size === o.size) { st.alreadyThere++; st.alreadyBytes += o.size; }
  else {
    await store.putS3(o.key, o.file);
    head = await store.headS3(o.key);
    if (!head.exists || head.size !== o.size) throw new Error(`verify failed for ${o.key}: bucket has ${head.exists ? head.size : 'nothing'}, local ${o.size} bytes`);
    st.copied++; st.copiedBytes += o.size;
  }
  st.verified++;
  if (deleteLocal) {
    let now; try { now = fs.statSync(o.file); } catch { now = null; }
    if (now && now.size === o.size && Math.round(now.mtimeMs) === Math.round(o.mtimeMs)) { fs.unlinkSync(o.file); st.deleted++; st.deletedBytes += o.size; }
    // a file that changed since it was verified is left alone and picked up by the next pass
  }
}

/** Start the copy job in the background. Returns the initial state at once. */
function start({ deleteLocal = false, resume = true } = {}) {
  if (job && !job.done) throw Object.assign(new Error('A store migration is already running'), { status: 409 });
  if (!store.s3Ready()) throw Object.assign(new Error('The bucket is not configured (MEDIA_STORE_*): nothing to copy to'), { status: 400 });
  const prev = resume ? load() : null;
  const st = fresh('copy', { deleteLocal });
  if (prev && prev.mode === 'copy' && prev.state !== 'done' && prev.cursor) { Object.assign(st, prev, { state: 'running', deleteLocal: !!deleteLocal, finishedAt: null }); }
  job = { stop: false, done: false };
  const me = job;
  me.promise = (async () => {
    events.log('INFO', `Store migration started (${deleteLocal ? 'copy + delete verified local copies' : 'copy only'})${st.cursor ? `, resuming after ${st.cursor}` : ''}`);
    const pending = new Set();
    let passed = !st.cursor; let sinceSave = 0;
    const flush = async () => { await Promise.all(pending); };
    try {
      for (const o of store.localObjects()) {
        if (me.stop) break;
        if (!passed) { if (o.key === st.cursor) passed = true; continue; }
        if (!store.validKey(o.key)) { st.skippedInvalid++; continue; }
        st.files++; st.bytes += o.size;
        const p = moveOne(o, st, deleteLocal).catch((e) => { st.failed++; if (st.errors.length < 20) st.errors.push(String(e.message || e).slice(0, 200)); }).finally(() => pending.delete(p));
        pending.add(p);
        if (pending.size >= CONCURRENCY) await Promise.race(pending);
        st.cursor = o.key;
        if (++sinceSave >= 50) { sinceSave = 0; save(st); }
      }
      await flush();
      st.state = me.stop ? 'stopped' : (st.failed ? 'done-with-errors' : 'done');
    } catch (e) {
      await flush().catch(() => {});
      st.state = 'error'; if (st.errors.length < 20) st.errors.push(String(e.message || e).slice(0, 200));
    }
    if (st.state === 'done' || st.state === 'done-with-errors') st.cursor = null; // a finished pass starts over next time
    st.finishedAt = new Date().toISOString(); save(st); me.done = true;
    events.log(st.state === 'done' ? 'OK' : 'WARN', `Store migration ${st.state}: ${st.verified} verified (${st.copied} copied, ${st.alreadyThere} already there), ${st.deleted} local copies deleted, ${st.failed} failed`);
  })();
  job.state = st;
  save(st);
  return st;
}

function stop() { if (job && !job.done) { job.stop = true; return true; } return false; }
function status() { return { running: !!(job && !job.done), ...(job && job.state ? job.state : load() || { state: 'never run' }) }; }
function _reset() { job = null; }

module.exports = { dryRun, start, stop, status, _reset, _wait: () => (job ? job.promise : Promise.resolve()) };
