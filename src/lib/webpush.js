'use strict';
/**
 * Web Push sender. The VAPID key pair is generated on first use and kept in the data volume
 * (`vapid.json`, mode 600); no key belongs in the environment or the database, and the file is
 * small enough to stay out of every media path. `web-push` is a pure-JS sender: the server keeps
 * one long-lived subscription row per browser, not one per creator.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

let webpush = null;
let keys = null;
let configured = false;
let loadError = null;

try { webpush = require('web-push'); } catch { webpush = null; }

const keyFile = () => path.join(config.dataDir, 'vapid.json');

function valid(k) {
  return k && typeof k.publicKey === 'string' && typeof k.privateKey === 'string' && k.publicKey.length > 20 && k.privateKey.length > 20;
}

function loadKeys() {
  if (keys) return keys;
  try {
    const file = keyFile();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (valid(parsed)) { keys = parsed; return keys; }
    }
  } catch (e) { loadError = `cannot read ${keyFile()}: ${e.message}`; }
  if (!webpush) throw new Error('web-push is not installed');
  const generated = webpush.generateVAPIDKeys();
  keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  try {
    fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
    fs.writeFileSync(keyFile(), JSON.stringify(keys, null, 2), { mode: 0o600 });
  } catch (e) {
    // An unwritable data volume still lets this process send; the key pair just changes after a restart.
    loadError = `cannot write ${keyFile()}: ${e.message}`;
  }
  return keys;
}

/** True when alerts can be sent: the flag is on and the optional sender is installed. */
function available() {
  return !!(config.pushEnabled && webpush);
}

function publicKey() {
  if (!available()) return null;
  try { return loadKeys().publicKey; } catch (e) { loadError = e.message; return null; }
}

function configure() {
  if (configured) return true;
  if (!available()) return false;
  const k = loadKeys();
  webpush.setVapidDetails(config.vapidSubject, k.publicKey, k.privateKey);
  configured = true;
  return true;
}

/**
 * Send one notification to a stored subscription. `payload` is plain JSON:
 * { title, body, url, tag, icon }.
 * Returns { ok: true } or { ok: false, gone: true } for an endpoint that should be disabled.
 */
async function send(subscription, payload) {
  if (!configure()) return { ok: false, reason: 'push disabled' };
  const sub = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  };
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: 'normal' });
    return { ok: true };
  } catch (e) {
    const status = Number(e && e.statusCode);
    if (status === 404 || status === 410) return { ok: false, gone: true, reason: `endpoint gone (${status})` };
    return { ok: false, reason: String((e && e.body) || (e && e.message) || e).slice(0, 200), status };
  }
}

/** The public half only, for `/api/push/key`. */
function descriptor() {
  const key = publicKey();
  return { enabled: !!key, publicKey: key, error: loadError };
}

module.exports = { available, publicKey, descriptor, send, configure, _keyFile: keyFile, _reset: () => { keys = null; configured = false; loadError = null; } };
