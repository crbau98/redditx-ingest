'use strict';
/**
 * OCR for pictures, using the system `tesseract` binary. Tesseract is deliberately not an npm
 * dependency: the Docker image installs it (one package), and a development machine without it
 * simply reports OCR as unavailable instead of failing ingestion. Only the recognized TEXT is kept
 * (`media.ocr_text`); the picture is not copied.
 */
const { spawn } = require('child_process');

let probed = null; // null = not checked, true/false = usable
let reason = null;
let customRecognize = null;

const binary = () => process.env.TESSERACT_PATH || process.env.TESSERACT_BIN || 'tesseract';

/** Collapse the whitespace and control characters a scan leaves behind. */
function normalize(text) {
  const s = String(text || '')
    .replace(/\u0000/g, ' ')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.slice(0, 1200);
}

/**
 * Is the OCR binary available? Cached for the process: a missing package does not cost a spawn per
 * picture. `false` is not fatal; the background job just leaves OCR text null.
 */
async function available() {
  if (probed !== null) return probed;
  if (customRecognize) { probed = true; return true; }
  probed = await new Promise((resolve) => {
    let settled = false;
    const done = (ok, why) => { if (settled) return; settled = true; reason = why || null; resolve(ok); };
    let p;
    try { p = spawn(binary(), ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] }); }
    catch (e) { return done(false, String(e.message || e)); }
    p.on('error', (e) => done(false, String(e.message || e)));
    p.on('exit', (code) => done(code === 0, code === 0 ? null : `tesseract exited ${code}`));
    setTimeout(() => { try { p.kill(); } catch { /* ignore */ } done(false, 'tesseract did not answer'); }, 4000).unref();
  });
  return probed;
}

/** Read text from an image Buffer. Never throws; returns { status, text, reason }. */
async function recognize(buffer, { lang = 'eng', timeout = 20000 } = {}) {
  if (customRecognize) {
    try { return { status: 'ok', text: normalize(await customRecognize(buffer, { lang })) }; }
    catch (e) { return { status: 'error', text: '', reason: String(e.message || e) }; }
  }
  if (!buffer || !buffer.length) return { status: 'empty', text: '', reason: 'no image' };
  if (!(await available())) return { status: 'unavailable', text: '', reason: reason || 'tesseract is not installed' };
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(binary(), ['stdin', 'stdout', '-l', lang || 'eng', '--psm', '6'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, OMP_THREAD_LIMIT: '1' },
      });
    } catch (e) { return resolve({ status: 'error', text: '', reason: String(e.message || e) }); }
    let out = ''; let err = ''; let settled = false;
    const done = (r) => { if (settled) return; settled = true; resolve(r); };
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } done({ status: 'error', text: '', reason: 'tesseract timed out' }); }, timeout);
    p.stdout.on('data', (d) => { if (out.length < 20000) out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { if (err.length < 2000) err += d.toString('utf8'); });
    p.on('error', (e) => { clearTimeout(timer); done({ status: 'error', text: '', reason: String(e.message || e) }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done({ status: 'ok', text: normalize(out) });
      else done({ status: 'error', text: '', reason: `tesseract exited ${code}${err ? `: ${err.trim().slice(0, 160)}` : ''}` });
    });
    try { p.stdin.end(buffer); } catch (e) { clearTimeout(timer); done({ status: 'error', text: '', reason: String(e.message || e) }); }
  });
}

/** Test seam: replace the CLI call and make `available()` true. */
function _setRecognize(fn) { customRecognize = fn || null; probed = fn ? true : null; reason = null; }
function _reset() { customRecognize = null; probed = null; reason = null; }

module.exports = { available, recognize, normalize, _setRecognize, _reset, status: () => ({ available: probed, reason }) };
