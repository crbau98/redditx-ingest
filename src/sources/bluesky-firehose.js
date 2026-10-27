'use strict';
/**
 * Bluesky Jetstream consumer -> discovery LEADS ONLY. Never writes media rows.
 *
 * Why: polling a seed list structurally cannot surface a creator nobody you
 * already follow has ever mentioned. Jetstream is the whole network, keyless,
 * no API budget.
 *
 * Gate: an adult SELF-LABEL and a real media embed. Self-labels are the only
 * reliable signal; we never infer adultness from post text.
 *
 * Cursor is `time_us`, advanced on EVERY event including discarded ones — it
 * tracks stream position, not interest. Reconnect rewinds by CURSOR_OVERLAP_US
 * so the gap is replayed rather than lost.
 *
 * Steady-state memory at defaults: ~10 MB.
 *   event ring 2000 x ~1.2 KB = 2.4 MB | seen LRU 50k x ~130 B = 6.5 MB
 *   profile LRU 20k x ~60 B = 1.2 MB   | WS frames bounded by MAX_FRAME
 * Nothing grows with uptime. Verified by construction, not by live soak.
 *
 * Fixture-tested against a local mock WS server. NOT live-verified.
 */

const policy = require('./_policy');
const {
  RingBuffer, LruSet, TokenBucket, Backoff,
  sleep, safeJson, envNum, envBool, envList, resolveWebSocket,
} = require('../engine/netutil');

const ID = 'bluesky-firehose';
const COLLECTION = 'app.bsky.feed.post';
const MAX_FRAME = 256 * 1024;
const PUBLIC_API = 'https://public.api.bsky.app';

const DEFAULT_ENDPOINTS = [
  'wss://jetstream1.us-east.bsky.network/subscribe',
  'wss://jetstream2.us-east.bsky.network/subscribe',
  'wss://jetstream1.us-west.bsky.network/subscribe',
  'wss://jetstream2.us-west.bsky.network/subscribe',
];

const ADULT = new Set(['porn', 'sexual', 'nudity', 'graphic-media']);

// ------------------------------------------------------------ record gates ---

function selfLabels(record) {
  const out = [];
  const vals = record && record.labels && Array.isArray(record.labels.values)
    ? record.labels.values : [];
  for (const v of vals) if (v && typeof v.val === 'string') out.push(v.val.toLowerCase());
  return out;
}

function hasMediaEmbed(record) {
  const e = record && record.embed;
  if (!e || typeof e.$type !== 'string') return false;
  const t = e.$type;
  if (t === 'app.bsky.embed.images') return Array.isArray(e.images) && e.images.length > 0;
  if (t === 'app.bsky.embed.video') return Boolean(e.video);
  if (t === 'app.bsky.embed.recordWithMedia') {
    const m = e.media;
    if (!m || typeof m.$type !== 'string') return false;
    if (m.$type === 'app.bsky.embed.images') return Array.isArray(m.images) && m.images.length > 0;
    return m.$type === 'app.bsky.embed.video' ? Boolean(m.video) : false;
  }
  if (t === 'app.bsky.embed.external') {
    // Bare link card only counts with a thumbnail and an allowed host.
    const ext = e.external;
    if (!ext || !ext.thumb || typeof ext.uri !== 'string') return false;
    return !policy.isDenied(ext.uri);
  }
  return false;
}

function embedKind(record) {
  const e = record && record.embed;
  if (!e) return null;
  if (e.$type === 'app.bsky.embed.recordWithMedia' && e.media) return e.media.$type;
  return e.$type;
}

function externalUrls(record) {
  const urls = [];
  for (const f of (Array.isArray(record.facets) ? record.facets : [])) {
    for (const feat of (Array.isArray(f && f.features) ? f.features : [])) {
      if (feat && feat.$type === 'app.bsky.richtext.facet#link' && typeof feat.uri === 'string') {
        urls.push(feat.uri);
      }
    }
  }
  const e = record && record.embed;
  if (e && e.$type === 'app.bsky.embed.external' && e.external && typeof e.external.uri === 'string') {
    urls.push(e.external.uri);
  }
  return urls.slice(0, 8);
}

// ------------------------------------------------------------------ source ---

function create(opts = {}) {
  const I = opts.integration || require('../engine/integration');

  const cfg = {
    enabled: opts.enabled != null ? opts.enabled : envBool('BLUESKY_FIREHOSE_ENABLED', false),
    endpoints: opts.endpoints || envList('BLUESKY_JETSTREAM_ENDPOINTS', DEFAULT_ENDPOINTS),
    leadsPerMinute: opts.leadsPerMinute != null ? opts.leadsPerMinute : envNum('BLUESKY_FIREHOSE_LEADS_PER_MIN', 60),
    queueSize: opts.queueSize != null ? opts.queueSize : envNum('BLUESKY_FIREHOSE_QUEUE', 2000),
    seenSize: opts.seenSize != null ? opts.seenSize : envNum('BLUESKY_FIREHOSE_SEEN', 50000),
    profileCacheSize: envNum('BLUESKY_PROFILE_CACHE', 20000),
    cursorOverlapUs: opts.cursorOverlapUs != null ? opts.cursorOverlapUs : envNum('BLUESKY_CURSOR_OVERLAP_US', 5_000_000),
    cursorFlushMs: envNum('BLUESKY_CURSOR_FLUSH_MS', 5000),
    maxCursorAgeUs: envNum('BLUESKY_MAX_CURSOR_AGE_US', 6 * 3600 * 1_000_000),
    resolveBatch: 25,
    resolveIntervalMs: opts.resolveIntervalMs != null ? opts.resolveIntervalMs : 1200,
    minFollowers: envNum('BLUESKY_MIN_FOLLOWERS', 0),
    requireAdultLabel: opts.requireAdultLabel != null ? opts.requireAdultLabel : true,
    publicApi: opts.publicApi || process.env.BLUESKY_PUBLIC_API || PUBLIC_API,
    idleMs: envNum('BLUESKY_IDLE_MS', 90000),
  };

  const WS = resolveWebSocket(opts.WebSocketImpl);
  const log = (lvl, msg, meta) => { try { I.log(lvl, `[${ID}] ${msg}`, meta); } catch { /* never throw */ } };

  const cursorStore = opts.cursorStore || {
    load: () => I.loadCursor(ID),
    save: (v) => I.saveCursor(ID, v),
  };

  const pending = new RingBuffer(cfg.queueSize);
  const seenDid = new LruSet(cfg.seenSize);
  const queuedDid = new LruSet(Math.min(cfg.queueSize * 4, 20000));
  const profileMiss = new LruSet(cfg.profileCacheSize);
  const bucket = opts.bucket || new TokenBucket({
    capacity: Math.max(1, cfg.leadsPerMinute),
    refillPerSec: Math.max(1, cfg.leadsPerMinute) / 60,
  });
  const backoff = opts.backoff || new Backoff({ baseMs: 500, maxMs: 60000, jitter: 'full' });

  const stats = {
    id: ID, running: false, connects: 0, disconnects: 0, messages: 0, commits: 0,
    adultPosts: 0, queued: 0, dropsQueueFull: 0, dropsRateCap: 0, dropsDenied: 0,
    leads: 0, resolveCalls: 0, resolveErrors: 0, wsErrors: 0,
    endpointIndex: 0, cursorUs: null, lastEventAt: null,
  };

  let running = false;
  let socket = null;
  let endpointIdx = 0;
  let cursorUs = null;
  let lastSaved = null;
  let cursorTimer = null;
  let resolveTimer = null;
  let loopPromise = null;
  const ac = new AbortController();

  // ------------------------------------------------------------- cursor ---
  async function loadCursor() {
    try {
      const raw = await cursorStore.load();
      const n = Number(raw);
      if (!raw || !Number.isFinite(n) || n <= 0) return null;
      const ageUs = Date.now() * 1000 - n;
      if (cfg.maxCursorAgeUs > 0 && ageUs > cfg.maxCursorAgeUs) {
        log('info', 'cursor older than replay window, starting live', { ageSec: Math.round(ageUs / 1e6) });
        return null;
      }
      return n;
    } catch (e) { log('warn', 'cursor load failed', { err: e.message }); return null; }
  }

  async function flushCursor(force) {
    if (cursorUs == null || (!force && cursorUs === lastSaved)) return;
    try { await cursorStore.save(String(cursorUs)); lastSaved = cursorUs; }
    catch (e) { log('warn', 'cursor save failed', { err: e.message }); }
  }

  // ---------------------------------------------------------- connection ---
  function buildUrl(base) {
    const u = new URL(base);
    u.searchParams.set('wantedCollections', COLLECTION);
    if (cursorUs != null) {
      u.searchParams.set('cursor', String(Math.floor(Math.max(1, cursorUs - cfg.cursorOverlapUs))));
    }
    return u.toString();
  }

  function closeSocket(sock, code = 1000, reason = 'shutdown') {
    if (!sock) return;
    try {
      if (sock.readyState === 0 || sock.readyState === 1) sock.close(code, reason);
      else if (typeof sock.terminate === 'function') sock.terminate();
    } catch { /* ignore */ }
  }

  function connectOnce(url) {
    return new Promise((resolve) => {
      let settled = false;
      let sock;
      let idle;

      const done = (why, meta) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        stats.disconnects++;
        if (socket === sock) socket = null;
        closeSocket(sock, 1000, 'cycle');
        resolve({ why, meta });
      };

      try { sock = new WS(url); }
      catch (err) { stats.wsErrors++; return resolve({ why: 'construct', meta: err.message }); }

      socket = sock;
      try { if ('binaryType' in sock) sock.binaryType = 'arraybuffer'; } catch { /* lib differs */ }

      const bump = () => { clearTimeout(idle); idle = setTimeout(() => done('idle'), cfg.idleMs); };
      bump();

      const onOpen = () => {
        stats.connects++;
        backoff.reset();
        log('info', 'connected', { url: url.split('?')[0], cursor: cursorUs });
      };
      const onMessage = (ev) => {
        bump();
        let data = ev && ev.data !== undefined ? ev.data : ev;
        if (data instanceof ArrayBuffer) data = Buffer.from(data);
        if (Buffer.isBuffer(data)) {
          if (data.length > MAX_FRAME) return;
          data = data.toString('utf8');
        }
        if (typeof data !== 'string' || data.length > MAX_FRAME) return;
        handleMessage(data);
      };
      const onError = (err) => { stats.wsErrors++; done('error', (err && (err.message || err.type)) || 'ws error'); };
      const onClose = (ev) => done('close', ev && ev.code);

      if (typeof sock.addEventListener === 'function') {
        sock.addEventListener('open', onOpen);
        sock.addEventListener('message', onMessage);
        sock.addEventListener('error', onError);
        sock.addEventListener('close', onClose);
      } else {
        sock.on('open', onOpen);
        sock.on('message', (d) => onMessage({ data: d }));
        sock.on('error', onError);
        sock.on('close', onClose);
      }
    });
  }

  function handleMessage(text) {
    stats.messages++;
    const evt = safeJson(text, MAX_FRAME);
    if (!evt || typeof evt !== 'object') return;

    // Cursor advances on EVERY event, kept or discarded.
    if (typeof evt.time_us === 'number' && evt.time_us > 0) {
      if (cursorUs == null || evt.time_us > cursorUs) { cursorUs = evt.time_us; stats.cursorUs = cursorUs; }
      stats.lastEventAt = Date.now();
    }

    if (evt.kind !== 'commit') return;
    const c = evt.commit;
    if (!c || c.operation !== 'create' || c.collection !== COLLECTION) return;
    stats.commits++;

    const record = c.record;
    if (!record || typeof record !== 'object') return;

    const labels = selfLabels(record);
    if (cfg.requireAdultLabel && !labels.some((l) => ADULT.has(l))) return;
    if (!hasMediaEmbed(record)) return;
    stats.adultPosts++;

    const did = typeof evt.did === 'string' ? evt.did : null;
    if (
