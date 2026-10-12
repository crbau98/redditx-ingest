'use strict';
/**
 * Telegram as a logged-in user (MTProto, via GramJS): reads every channel / group the account has joined, public or private,
 * with full history and full-size photos and videos. The public web preview (sources/telegram.js, kind "user") only sees
 * public channels that allow it, shows a short window, and hands out CDN links.
 *
 * Credentials: api_id + api_hash (my.telegram.org -> API development tools) and a login SESSION created once with
 * `node scripts/telegram-login.js` (phone number + the code Telegram sends + the 2FA password if set). The session is kept in
 * the data volume (mode 600) or in TELEGRAM_SESSION; it is as powerful as the account, so it never goes into the database or git.
 *
 * `telegram` (GramJS) is an optional dependency: without it, or without credentials, this module reports "not configured".
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const SESSION_FILE = () => path.join(config.dataDir, 'telegram.session');
let factory = null;          // test hook: async () => fake client
let clientPromise = null;
let warmed = false;
const entities = new Map();  // target -> entity

function sessionString() {
  if (config.telegram.session) return config.telegram.session;
  try { return fs.readFileSync(SESSION_FILE(), 'utf8').trim(); } catch { return ''; }
}
function saveSession(str) {
  fs.mkdirSync(path.dirname(SESSION_FILE()), { recursive: true });
  fs.writeFileSync(SESSION_FILE(), str, { mode: 0o600 });
  try { fs.chmodSync(SESSION_FILE(), 0o600); } catch { /* best effort */ }
}
function haveLibrary() { try { require.resolve('telegram'); return true; } catch { return false; } }

/** { ok, note } in the shape adapters use. */
function configured() {
  if (factory) return { ok: true, note: 'MTProto (test)' };
  const t = config.telegram;
  if (!t.apiId || !t.apiHash) return { ok: false, note: 'Set TELEGRAM_API_ID and TELEGRAM_API_HASH (my.telegram.org) to read the channels your account has joined' };
  if (!haveLibrary()) return { ok: false, note: 'The "telegram" package is not installed (npm install)' };
  if (!sessionString()) return { ok: false, note: 'Telegram login missing: run `node scripts/telegram-login.js` once (phone number, code, 2FA password)' };
  return { ok: true, note: 'logged-in account (MTProto)' };
}

const authError = (e) => /AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_UNREGISTERED/i.test(String((e && (e.errorMessage || e.message)) || ''));
const floodSeconds = (e) => (e && /FLOOD/i.test(String(e.errorMessage || e.message || '')) ? Number(e.seconds) || 60 : 0);

/** Normalise any Telegram error into one PRISM understands (status, retryAfter, skip for dead logins). */
function wrap(e) {
  if (!e || e.prism) return e;
  const msg = String(e.errorMessage || e.message || e);
  if (authError(e)) { clientPromise = null; return Object.assign(new Error('Telegram session is no longer valid: run `node scripts/telegram-login.js` again'), { skip: true, prism: true }); }
  const wait = floodSeconds(e);
  if (wait) return Object.assign(new Error(`Telegram rate limit: wait ${wait}s`), { status: 429, retryAfter: wait * 1000, prism: true });
  if (/CHANNEL_PRIVATE|CHANNEL_INVALID|USERNAME_NOT_OCCUPIED|USERNAME_INVALID|PEER_ID_INVALID/i.test(msg)) return Object.assign(new Error(`Telegram: ${msg} (channel not found, or the account is no longer a member)`), { status: 404, prism: true });
  return Object.assign(new Error(`Telegram: ${msg}`.slice(0, 240)), { prism: true });
}

async function client() {
  if (!clientPromise) {
    clientPromise = (async () => {
      if (factory) return factory();
      const conf = configured();
      if (!conf.ok) throw Object.assign(new Error(conf.note), { skip: true, prism: true });
      const { TelegramClient } = require('telegram');
      const { StringSession } = require('telegram/sessions');
      const c = new TelegramClient(new StringSession(sessionString()), config.telegram.apiId, config.telegram.apiHash, {
        connectionRetries: 3, floodSleepThreshold: 30, deviceModel: 'PRISM', appVersion: config.version, useWSS: false,
      });
      c.setLogLevel('error');
      await c.connect();
      if (!(await c.checkAuthorization())) { try { await c.disconnect(); } catch { /* ignore */ } throw Object.assign(new Error('Telegram session is not logged in: run `node scripts/telegram-login.js`'), { skip: true, prism: true }); }
      return c;
    })().catch((e) => { clientPromise = null; throw wrap(e); });
  }
  return clientPromise;
}

const str = (v) => (v === undefined || v === null ? '' : String(v));
const num = (v) => { const n = Number(str(v)); return Number.isFinite(n) ? n : 0; };
const clsOf = (o) => (o && (o.className || (o.constructor && o.constructor.name))) || '';

/** Joined channels and supergroups (not private chats, not small groups): [{id, username, title, members, kind}] */
async function dialogs() {
  try {
    const c = await client();
    const out = [];
    for (const d of await c.getDialogs({ limit: 800 })) {
      const e = d.entity;
      if (!e || clsOf(e) !== 'Channel') continue;
      const id = str(e.id);
      entities.set(`id:${id}`, e);
      if (e.username) entities.set(String(e.username).toLowerCase(), e);
      out.push({ id, username: e.username || null, title: d.title || e.title || e.username || id, members: num(e.participantsCount), kind: e.broadcast ? 'channel' : 'group' });
    }
    warmed = true;
    return out;
  } catch (e) { throw wrap(e); }
}

async function entityOf(target) {
  const key = String(target).replace(/^@/, '').toLowerCase();
  if (entities.has(key)) return entities.get(key);
  const c = await client();
  if (!warmed && /^id:/.test(key)) await dialogs(); // private channels are only resolvable once the dialog list has been read
  if (entities.has(key)) return entities.get(key);
  try {
    const e = await c.getEntity(/^id:/.test(key) ? key.slice(3) : String(target).replace(/^@/, ''));
    entities.set(key, e);
    return e;
  } catch (e) { throw wrap(e); }
}

/**
 * Photo / video / GIF messages of a channel, as { list, exhausted }.
 *   { reverse: true, minId }   ascending, strictly newer than minId (so a long gap is read in order, never skipped)
 *   { offsetId }               descending, older than offsetId (back-filling history)
 *   {}                         the newest ones
 * Telegram filters photos+videos and GIFs separately, so each filter is paged on its own; when one of them returned a full
 * page, only the id range every filter covered is kept (the rest is read next run), so no message is ever skipped.
 * `exhausted`: nothing more lies beyond this page in the direction read.
 */
async function messages(target, { minId = 0, offsetId = 0, reverse = false, limit = 50 } = {}) {
  try {
    const c = await client();
    const entity = await entityOf(target);
    const filters = factory ? [null] : (() => { const { Api } = require('telegram'); return [new Api.InputMessagesFilterPhotoVideo(), new Api.InputMessagesFilterGif()]; })();
    const batches = [];
    for (const filter of filters) {
      const opts = { limit, ...(minId ? { minId } : {}), ...(offsetId ? { offsetId } : {}), ...(reverse ? { reverse: true } : {}), ...(filter ? { filter } : {}) };
      batches.push((await c.getMessages(entity, opts)).filter((m) => m && m.id));
    }
    const saturated = batches.filter((b) => b.length >= limit);
    const byId = new Map();
    for (const b of batches) for (const m of b) byId.set(m.id, m);
    let list = [...byId.values()];
    if (reverse) {
      const edge = saturated.length ? Math.min(...saturated.map((b) => Math.max(...b.map((m) => m.id)))) : Infinity;
      list = list.filter((m) => m.id <= edge).sort((a, b) => a.id - b.id);
    } else {
      const edge = saturated.length ? Math.max(...saturated.map((b) => Math.min(...b.map((m) => m.id)))) : 0;
      list = list.filter((m) => m.id >= edge).sort((a, b) => b.id - a.id);
    }
    return { list, exhausted: saturated.length === 0 };
  } catch (e) { throw wrap(e); }
}

const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const MIME_FOR_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };

/**
 * What a message carries, or null: { type: 'image'|'video', ext, mime, size, width, height, duration, thumb }.
 * `skip` explains why a message with media was passed over (too big, sticker, unsupported format ...).
 */
function describeMedia(msg, { maxBytes = config.telegram.maxMb * 1024 * 1024 } = {}) {
  const m = msg && msg.media;
  if (!m) return null;
  const cls = clsOf(m);
  if (m.ttlSeconds) return { skip: 'self-destructing' };
  if (cls === 'MessageMediaPhoto') {
    if (!m.photo || clsOf(m.photo) === 'PhotoEmpty') return null;
    let w = 0; let h = 0;
    for (const s of m.photo.sizes || []) if ((s.w || 0) * (s.h || 0) > w * h) { w = s.w; h = s.h; }
    return { type: 'image', ext: 'jpg', mime: 'image/jpeg', size: 0, width: w || null, height: h || null, duration: null, thumb: false };
  }
  if (cls === 'MessageMediaDocument') {
    const d = m.document;
    if (!d || clsOf(d) !== 'Document') return null;
    const attrs = d.attributes || [];
    const has = (name) => attrs.find((a) => clsOf(a) === name);
    if (has('DocumentAttributeSticker') || has('DocumentAttributeAudio') || has('DocumentAttributeCustomEmoji')) return null;
    const mime = String(d.mimeType || '').toLowerCase();
    const size = num(d.size);
    const v = has('DocumentAttributeVideo'); const img = has('DocumentAttributeImageSize');
    if (VIDEO_EXT[mime]) {
      if (maxBytes && size > maxBytes) return { skip: `video larger than ${Math.round(maxBytes / 1048576)} MB` };
      return { type: 'video', ext: VIDEO_EXT[mime], mime, size, width: (v && v.w) || null, height: (v && v.h) || null, duration: (v && v.duration) ? Math.round(v.duration) : null, thumb: !!(d.thumbs && d.thumbs.length) };
    }
    if (IMAGE_EXT[mime]) {
      if (maxBytes && size > maxBytes) return { skip: 'image too large' };
      return { type: 'image', ext: IMAGE_EXT[mime], mime, size, width: (img && img.w) || null, height: (img && img.h) || null, duration: null, thumb: false };
    }
    return null;
  }
  return null;
}

/** Download a message's media to `file`, or return a Buffer when `file` is omitted. `thumb` fetches the poster frame of a video. */
async function download(msg, { file, thumb = false } = {}) {
  try {
    const c = await client();
    const opts = {};
    if (file) opts.outputFile = file;
    if (thumb) {
      const thumbs = (msg.media && msg.media.document && msg.media.document.thumbs) || [];
      let best = -1; let area = -1;
      thumbs.forEach((t, i) => { const a = (t.w || 0) * (t.h || 0); if (clsOf(t) !== 'PhotoStrippedSize' && a > area) { area = a; best = i; } });
      opts.thumb = best >= 0 ? best : undefined;
    }
    const out = await c.downloadMedia(msg, opts);
    return file ? file : out;
  } catch (e) { throw wrap(e); }
}

/** { title, about, members, avatar: Buffer|null } for a channel. */
async function profile(target, { avatar = true } = {}) {
  try {
    const c = await client();
    const entity = await entityOf(target);
    let about = null; let members = num(entity.participantsCount);
    try {
      const { Api } = require('telegram');
      const full = await c.invoke(new Api.channels.GetFullChannel({ channel: entity }));
      about = (full && full.fullChat && full.fullChat.about) || null;
      members = num(full && full.fullChat && full.fullChat.participantsCount) || members;
    } catch { /* the description is a bonus */ }
    let pic = null;
    if (avatar) { try { pic = await c.downloadProfilePhoto(entity, { isBig: false }); } catch { /* none */ } }
    return { title: entity.title || null, about, members, avatar: Buffer.isBuffer(pic) && pic.length ? pic : null, username: entity.username || null, id: str(entity.id) };
  } catch (e) { throw wrap(e); }
}

async function shutdown() {
  const p = clientPromise; clientPromise = null; warmed = false; entities.clear();
  if (p) { try { const c = await p; if (c && c.disconnect) await c.disconnect(); if (c && c.destroy) await c.destroy(); } catch { /* ignore */ } }
}

module.exports = {
  configured, dialogs, messages, describeMedia, download, profile, entityOf, shutdown, wrap,
  sessionString, saveSession, SESSION_FILE, MIME_FOR_EXT,
  _setFactory(fn) { factory = fn; clientPromise = null; warmed = false; entities.clear(); },
};
