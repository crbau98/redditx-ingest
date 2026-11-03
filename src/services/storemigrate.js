'use strict';
/**
 * Move the media that was written to the data volume (/data/store) into the bucket, under the same keys, so every stored URL
 * (https://media.prism.invalid/<key>) keeps resolving. Runs inside the container as an admin-started background job.
 *
 *   dry-run   (default) counts files and bytes per top-level folder and, with `check`, asks the bucket about a sample. Changes nothing.
 *   copy      per file: hash the local file, upload it with its SHA-256 as object metadata unless the bucket already holds proof of
 *             the same content, then require that proof from the bucket again. SIZE ALONE IS NEVER PROOF.
 *   delete    a SEPARATE switch on top of copy. A local file is removed only when (1) the bucket holds the same bytes (proof below),
 *             (2) the local bytes are unchanged since they were hashed (hashed again after the upload and again by size/mtime/inode
 *             right before the unlink, so a rewrite that restores the mtime is still caught), and (3) it was verified in this pass.
 *
 * Proof that the bucket holds the same content, in this order:
 *   our own x-amz-meta-sha256            -> compared with the local SHA-256
 *   an MD5 ETag (single-part upload)     -> compared with the local MD5; a mismatch is not final (SSE changes ETags), it is read back
 *   read-back                            -> the object is streamed and hashed (when the bucket reports neither)
 * A bucket object of the same key but DIFFERENT content that we did not write (no metadata of ours) is a CONFLICT: it is never
 * overwritten and the local file is never deleted. An object carrying OUR metadata that no longer matches is our own stale copy of a
 * file that changed locally, and is replaced.
 *
 * Resumable by sort order: files are walked in key order and a resume continues with `key > cursor`, so it does not matter whether the
 * cursor file still exists. A pass ends "done" only when a final check finds nothing left to do (delete mode: no local file left; copy
 * mode: no local file missing from the bucket); otherwise it ends "incomplete" and says how many.
 */
const fs = require('fs');
const crypto = require('crypto');
const repo = require('../db/repo');
const store = require('../lib/objectstore');
const events = require('../engine/events');

const KEY = 'store_migrate';
const CONCURRENCY = 3;
let job = null; // the running job { stop: bool, done: bool, promise, state }

const top = (key) => (key.includes('/') ? key.slice(0, key.indexOf('/')) : '(root)');
const load = () => { try { return JSON.parse(repo.settings.get(KEY) || 'null'); } catch { return null; } };
const save = (st) => { try { repo.settings.set(KEY, JSON.stringify(st)); } catch { /* best effort */ } };

const fresh = (mode, opts) => ({
  mode, deleteLocal: !!opts.deleteLocal, startedAt: new Date().toISOString(), finishedAt: null, state: 'running',
  files: 0, bytes: 0, skippedInvalid: 0, alreadyThere: 0, alreadyBytes: 0, copied: 0, copiedBytes: 0, verified: 0, readBack: 0,
  deleted: 0, deletedBytes: 0, failed: 0, conflicts: 0, changed: 0, remaining: null, errors: [], cursor: null, byFolder: {}, sample: null,
});

/** SHA-256 and MD5 of a file, streamed (a 400 MB video never sits in memory). */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const sha = crypto.createHash('sha256'); const md5 = crypto.createHash('md5'); let size = 0;
    const s = fs.createReadStream(file);
    s.on('data', (c) => { size += c.length; sha.update(c); md5.update(c); });
    s.on('error', reject);
    s.on('end', () => resolve({ sha256: sha.digest('hex'), md5: md5.digest('hex'), size }));
  });
}

/**
 * Does the bucket hold exactly these bytes under this key?
 * @returns {Promise<{state: 'missing'|'equal'|'ours-stale'|'conflict'|'unverifiable', via?: string}>}
 */
async function proveRemote(key, local) {
  const head = await store.headS3(key);
  if (!head.exists) return { state: 'missing' };
  if (head.size !== local.size) return head.sha256 ? { state: 'ours-stale', via: 'size' } : { state: 'conflict', via: 'size' };
  if (head.sha256) return head.sha256 === local.sha256 ? { state: 'equal', via: 'metadata' } : { state: 'ours-stale', via: 'metadata' };
  if (head.etag && /^[0-9a-f]{32}$/.test(head.etag) && head.etag === local.md5) return { state: 'equal', via: 'etag' };
  const back = await store.hashS3(key); // no metadata, no matching MD5: read it back
  if (!back.exists) return { state: 'unverifiable' };
  return back.size === local.size && back.sha256 === local.sha256 ? { state: 'equal', via: 'read-back' } : { state: 'conflict', via: 'read-back' };
}

/** Read-only report: how much is on the volume, per folder, and (optionally) how much of a sample is already in the bucket. */
async function dryRun({ check = 0 } = {}) {
  const r = fresh('dry-run', {});
  const ready = store.s3Ready();
  const seen = [];
  for (const o of store.localObjects()) {
    if (!store.validKey(o.key)) { r.skippedInvalid++; continue; }
    r.files++; r.bytes += o.size;
    const f = (r.byFolder[top(o.key)] ||= { files: 0, bytes: 0 });
    f.files++; f.bytes += o.size;
    if (check > 0 && ready) seen.push(o);
  }
  if (check > 0 && ready && seen.length) {
    const step = Math.max(1, Math.floor(seen.length / check));
    let probed = 0; let there = 0;
    for (let i = 0; i < seen.length && probed < check; i += step) {
      probed++;
      try { const h = await store.headS3(seen[i].key); if (h.exists && h.size === seen[i].size) there++; } catch { /* counted as not there */ }
    }
    // size only: this is an estimate of the work, not a verification (a real pass proves content before anything is deleted)
    r.sample = { probed, alreadyInBucketBySize: there, estimatedFilesToCopy: Math.round(r.files * (1 - there / probed)) };
  }
  r.state = 'done'; r.finishedAt = new Date().toISOString();
  r.bucket = ready ? store.describe() : { error: 'the bucket is not configured (MEDIA_STORE_*): a copy cannot start' };
  r.mb = Math.round(r.bytes / 1048576);
  save(r);
  return r;
}

const sameFile = (a, b) => a && b && a.size === b.size && Math.round(a.mtimeMs) === Math.round(b.mtimeMs) && a.ino === b.ino;

async function moveOne(o, st, deleteLocal) {
  const stat0 = fs.statSync(o.file);
  const h1 = await hashFile(o.file); // hashed BEFORE anything is uploaded
  if (h1.size !== o.size || stat0.size !== o.size) { st.changed++; return; } // changed since the walk saw it: the next pass takes it
  let uploaded = false;
  let proof = await proveRemote(o.key, h1);
  if (proof.state === 'equal') { st.alreadyThere++; st.alreadyBytes += o.size; if (proof.via === 'read-back') st.readBack++; }
  else if (proof.state === 'conflict') {
    st.conflicts++;
    throw new Error(`conflict: ${o.key} is in the bucket with different content (${proof.via}); the bucket object was not overwritten and the local file was kept`);
  } else {
    // missing, our own stale copy, or unreadable: (re)upload with the hash in the metadata, then ask the bucket for proof again
    await store.putS3(o.key, o.file, undefined, { sha256: h1.sha256 });
    uploaded = true;
    proof = await proveRemote(o.key, h1);
    if (proof.state !== 'equal') throw new Error(`verify failed for ${o.key}: the bucket copy could not be proven identical (${proof.state}${proof.via ? `/${proof.via}` : ''})`);
    if (proof.via === 'read-back') st.readBack++;
    st.copied++; st.copiedBytes += o.size;
  }
  if (uploaded || deleteLocal) {
    // Did the local bytes stay what they were while we uploaded / verified? (A same-size rewrite that restores the mtime is caught here.)
    const h2 = await hashFile(o.file);
    if (h2.sha256 !== h1.sha256) { st.changed++; throw new Error(`${o.key} changed while it was being copied: left in place, the next pass copies the new content`); }
  }
  st.verified++;
  if (deleteLocal) {
    let now; try { now = fs.statSync(o.file); } catch { now = null; }
    if (sameFile(now, stat0)) { fs.unlinkSync(o.file); st.deleted++; st.deletedBytes += o.size; }
    else st.changed++; // touched after it was verified: left alone
  }
}

/** The final check of a pass: what is still not done? */
async function remainingAfter(deleteLocal) {
  let n = 0;
  for (const o of store.localObjects()) {
    if (!store.validKey(o.key)) continue;
    if (deleteLocal) { n++; continue; }
    const h = await store.headS3(o.key).catch(() => ({ exists: false }));
    if (!h.exists || h.size !== o.size) n++;
  }
  return n;
}

/** Start the copy job in the background. Returns the initial state at once. */
function start({ deleteLocal = false, resume = true } = {}) {
  if (job && !job.done) throw Object.assign(new Error('A store migration is already running'), { status: 409 });
  if (!store.s3Ready()) throw Object.assign(new Error('The bucket is not configured (MEDIA_STORE_*): nothing to copy to'), { status: 400 });
  const prev = resume ? load() : null;
  const st = fresh('copy', { deleteLocal });
  if (prev && prev.mode === 'copy' && (prev.state === 'stopped' || prev.state === 'error' || prev.state === 'running') && prev.cursor) {
    Object.assign(st, prev, { state: 'running', deleteLocal: !!deleteLocal, finishedAt: null, remaining: null });
  }
  job = { stop: false, done: false, state: st };
  const me = job;
  me.promise = (async () => {
    const after = st.cursor;
    events.log('INFO', `Store migration started (${deleteLocal ? 'copy + delete verified local copies' : 'copy only'})${after ? `, resuming after ${after}` : ''}`);
    const pending = new Set();
    let sinceSave = 0;
    try {
      for (const o of store.localObjects({ after })) {
        if (me.stop) break;
        if (after && o.key <= after) continue; // resume by sort order: the cursor file may be gone
        if (!store.validKey(o.key)) { st.skippedInvalid++; continue; }
        st.files++; st.bytes += o.size;
        const p = moveOne(o, st, deleteLocal).catch((e) => { st.failed++; if (st.errors.length < 20) st.errors.push(String(e.message || e).slice(0, 240)); }).finally(() => pending.delete(p));
        pending.add(p);
        if (pending.size >= CONCURRENCY) await Promise.race(pending);
        st.cursor = o.key;
        if (++sinceSave >= 50) { sinceSave = 0; save(st); }
      }
      await Promise.all(pending);
      if (me.stop) st.state = 'stopped';
      else {
        // A pass is "done" only when a final look finds nothing left to do.
        st.remaining = await remainingAfter(deleteLocal);
        st.state = st.failed ? 'done-with-errors' : st.remaining > 0 ? 'incomplete' : 'done';
        st.cursor = null; // a finished pass starts from the top next time
      }
    } catch (e) {
      await Promise.all(pending).catch(() => {});
      st.state = 'error'; if (st.errors.length < 20) st.errors.push(String(e.message || e).slice(0, 240));
    }
    st.finishedAt = new Date().toISOString(); save(st); me.done = true;
    events.log(st.state === 'done' ? 'OK' : 'WARN', `Store migration ${st.state}: ${st.verified} verified (${st.copied} copied, ${st.alreadyThere} already there), ${st.deleted} local copies deleted, ${st.failed} failed, ${st.conflicts} conflicts${st.remaining ? `, ${st.remaining} left` : ''}`);
  })();
  save(st);
  return st;
}

function stop() { if (job && !job.done) { job.stop = true; return true; } return false; }
function status() { return { running: !!(job && !job.done), ...(job && job.state ? job.state : load() || { state: 'never run' }) }; }
function _reset() { job = null; }

module.exports = { dryRun, start, stop, status, _reset, hashFile, proveRemote, _wait: () => (job ? job.promise : Promise.resolve()) };
