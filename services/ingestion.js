const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { sleep } = require('./fetch');
const { itemPassesQuality, shouldHideExisting, probeMedia } = require('./media-quality');
const reddit = require('./sources/reddit');
const ddg = require('./sources/ddg');
const x = require('./sources/x');
const web = require('./sources/web');
const redgifs = require('./sources/redgifs');
const catalog = require('./ingest-catalog');

const DEFAULT_SUBS = reddit.DEFAULT_SUBS;
const GAY_SUBS = new Set(DEFAULT_SUBS.map(s => s.toLowerCase()));
const DEFAULT_SOURCES = ['reddit', 'x', 'redgifs'];

let ingesting = false;
let paused = false;
let currentJobId = null;
let sseClients = [];
let stats = emptyStats();
let logs = [];
let lastOutcome = null;

function emptyStats() {
  return { total: 0, images: 0, videos: 0, dupes: 0, skipped: 0, errors: 0, swept: 0, bySource: {} };
}

function getState() {
  return { ingesting, paused, stats, currentJobId, lastOutcome };
}
function setSseClients(clients) { sseClients = clients; }
function getSseClients() { return sseClients; }
function getLogs() { return logs; }

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  sseClients = sseClients.filter(c => {
    try { c.write(data); return true; } catch { return false; }
  });
}

function log(level, msg) {
  const entry = { ts: new Date().toISOString(), level, msg };
  logs.push(entry);
  if (logs.length > 800) logs.shift();
  broadcast({ type: 'log', data: entry });
}

function bumpSource(source, field) {
  if (!stats.bySource[source]) stats.bySource[source] = { total: 0, dupes: 0, skipped: 0, errors: 0 };
  stats.bySource[source][field] = (stats.bySource[source][field] || 0) + 1;
}

function getOrientationScope(subreddit, source) {
  if (source !== 'reddit') return 'gay';
  if (!subreddit) return 'uncertain';
  return GAY_SUBS.has(subreddit.toLowerCase()) ? 'gay' : 'uncertain';
}

function getOrCreateCreator(author, platform, profileUrl) {
  if (!author || author === '[deleted]' || author === 'AutoModerator' || author === 'web') return null;
  const handle = String(author).replace(/^@/, '').slice(0, 80);
  let creator = db.getCreatorByHandle(handle);
  if (creator) return creator;

  const id = uuidv4();
  db.insertCreator({
    id,
    primary_handle: handle,
    display_name: handle,
    orientation_scope: 'gay'
  });
  db.insertCreatorSource({
    id: uuidv4(),
    creator_id: id,
    source_platform: platform,
    source_creator_id: handle,
    handle,
    profile_url: profileUrl || null
  });
  return db.getCreator(id);
}

async function waitIfPaused() {
  while (paused && ingesting) await sleep(250);
}

async function persistItem(item, source) {
  if (!item || !item.mediaUrl) return false;

  if (/redgifs\.com/i.test(item.mediaUrl) && !/\.(mp4|webm)(\?|$)/i.test(item.mediaUrl)) {
    const resolved = await redgifs.resolveUrl(item.mediaUrl);
    if (!resolved) {
      stats.skipped++;
      bumpSource(source, 'skipped');
      return false;
    }
    item.mediaUrl = resolved.mediaUrl;
    item.previewUrl = resolved.previewUrl || item.previewUrl;
    item.mediaType = resolved.mediaType;
    if (!item.author || item.author === 'web') item.author = resolved.author;
  }

  const quality = await itemPassesQuality(item);
  if (!quality.ok) {
    stats.skipped++;
    bumpSource(source, 'skipped');
    return false;
  }
  if (quality.url) item.mediaUrl = quality.url;

  const hash = crypto.createHash('md5').update(item.mediaUrl).digest('hex');
  if (db.getMediaByHash(hash)) {
    stats.dupes++;
    bumpSource(source, 'dupes');
    broadcast({ type: 'stats', data: stats });
    return false;
  }

  const creator = getOrCreateCreator(
    item.author,
    source,
    item.permalink && item.author ? item.permalink : null
  );
  const mediaId = uuidv4();
  db.insertMedia({
    id: mediaId,
    title: item.title || null,
    description: item.query ? `Found via ${source}: ${item.query}` : null,
    media_type: item.mediaType === 'video' ? 'video' : 'image',
    media_url: item.mediaUrl,
    preview_url: item.previewUrl || null,
    thumbnail_url: (item.thumbnail && String(item.thumbnail).startsWith('http')) ? item.thumbnail : null,
    source_platform: source,
    source_url: item.permalink || item.mediaUrl,
    source_id: String(item.sourceId || hash).slice(0, 80),
    subreddit: item.subreddit || source,
    author: item.author || null,
    score: item.score || 0,
    hash,
    width: null,
    height: null,
    orientation_scope: getOrientationScope(item.subreddit, source),
    publish_state: 'published',
    creator_id: creator ? creator.id : null
  });

  if (creator) db.updateCreatorStats(creator.id);
  const tag = (item.subreddit || item.query || source).toLowerCase().replace(/\s+/g, '-').slice(0, 40);
  if (tag) db.addTagToMedia(mediaId, tag, 'ingest');
  db.addTagToMedia(mediaId, source, 'ingest');

  stats.total++;
  bumpSource(source, 'total');
  if (item.mediaType === 'video') stats.videos++;
  else stats.images++;

  broadcast({ type: 'item', data: db.getMedia(mediaId) });
  broadcast({ type: 'stats', data: stats });
  return true;
}

async function runReddit(config) {
  const subs = (config.subs && config.subs.length) ? config.subs : DEFAULT_SUBS;
  const sort = config.sort || 'hot';
  const limit = config.limit || 40;
  const minScore = config.minScore || 0;
  log('INFO', `Reddit: ${subs.length} communities, sort=${sort}, limit=${limit}`);

  for (const sub of subs) {
    if (!ingesting) break;
    await waitIfPaused();
    if (!ingesting) break;
    log('INFO', `Fetching r/${sub}...`);
    try {
      const items = await reddit.fetchSub(sub, { sort, limit });
      if (items._officialError) {
        log('WARN', `r/${sub}: official API ${items._officialError} — using archive`);
      }
      let count = 0;
      for (const item of items) {
        if (!ingesting) break;
        await waitIfPaused();
        if ((item.score || 0) < minScore) continue;
        if (await persistItem(item, 'reddit')) {
          count++;
          log('OK', `[reddit ${item.mediaType}] r/${sub}: ${(item.title || '').slice(0, 70)}`);
        }
        await sleep(40);
      }
      log('OK', `r/${sub}: ${count} new items`);
    } catch (e) {
      stats.errors++;
      bumpSource('reddit', 'errors');
      log('ERR', `r/${sub}: ${e.message}`);
      broadcast({ type: 'stats', data: stats });
    }
    await sleep(200);
  }
}

async function runRedgifsUsers(users, limit) {
  log('INFO', `RedGIFs creators: ${users.length} public usernames`);
  for (const username of users) {
    if (!ingesting) break;
    await waitIfPaused();
    log('INFO', `RedGIFs user: ${username}`);
    try {
      const result = await redgifs.harvestUser(username, { limit });
      if (result.officialError) log('WARN', `RedGIFs @${username}: ${result.officialError}`);
      let count = 0;
      for (const item of result.items || []) {
        if (!ingesting) break;
        await waitIfPaused();
        if (await persistItem(item, 'redgifs')) {
          count++;
          log('OK', `[redgifs ${item.mediaType}] @${username}: ${(item.title || '').slice(0, 70)}`);
        }
        await sleep(30);
      }
      log('OK', `RedGIFs @${username}: ${count} new items`);
    } catch (e) {
      stats.errors++;
      bumpSource('redgifs', 'errors');
      log('ERR', `RedGIFs @${username}: ${e.message}`);
      broadcast({ type: 'stats', data: stats });
    }
    await sleep(250);
  }
}

async function runQueries(sourceName, harvest, queries, limit) {
  log('INFO', `${sourceName}: ${queries.length} queries`);
  for (const query of queries) {
    if (!ingesting) break;
    await waitIfPaused();
    log('INFO', `${sourceName} search: ${query}`);
    try {
      const result = await harvest(query, { limit, webLimit: limit, imageLimit: limit });
      if (result.officialError) log('WARN', `${sourceName}: ${result.officialError}`);
      if (result.imageError) log('WARN', `${sourceName} images: ${result.imageError}`);
      if (result.webError) log('WARN', `${sourceName} web: ${result.webError}`);
      let count = 0;
      for (const item of result.items || []) {
        if (!ingesting) break;
        await waitIfPaused();
        if (await persistItem(item, sourceName)) {
          count++;
          log('OK', `[${sourceName} ${item.mediaType}] ${(item.title || query).slice(0, 70)}`);
        }
        await sleep(30);
      }
      log('OK', `${sourceName} "${query}": ${count} new items`);
    } catch (e) {
      stats.errors++;
      bumpSource(sourceName, 'errors');
      log('ERR', `${sourceName} "${query}": ${e.message}`);
      broadcast({ type: 'stats', data: stats });
    }
    await sleep(250);
  }
}

function parseList(value, fallback) {
  if (Array.isArray(value) && value.length) return value.map(s => String(s).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(/\n|,/).map(s => s.trim()).filter(Boolean);
  }
  return fallback;
}

async function sweepJunkMedia({ probeImgur = true, limit = 400 } = {}) {
  let hidden = 0;
  let checked = 0;
  let offset = 0;
  log('INFO', 'Sweeping previously ingested junk (stock, dead Imgur, generic web)...');

  while (checked < limit) {
    const batch = db.listPublishedMediaPage(offset, 100);
    if (!batch.length) break;
    for (const row of batch) {
      checked++;
      const quick = shouldHideExisting(row);
      if (quick.hide) {
        db.hideMedia(row.id, quick.reason);
        hidden++;
        continue;
      }
      if (probeImgur && /imgur\.com/i.test(row.media_url || '')) {
        const probe = await probeMedia(row.media_url, 'image');
        if (!probe.ok) {
          db.hideMedia(row.id, probe.reason || 'dead imgur');
          hidden++;
        }
      }
    }
    offset += batch.length;
    if (batch.length < 100) break;
  }

  log('OK', `Sweep complete: hid ${hidden} of ${checked} items`);
  if (ingesting) {
    stats.swept = (stats.swept || 0) + hidden;
    broadcast({ type: 'stats', data: stats });
  }
  return { hidden, checked };
}

async function runIngestion(config = {}) {
  if (ingesting) return { ok: false, msg: 'Already running' };

  ingesting = true;
  paused = false;
  stats = emptyStats();
  logs = [];

  const pack = config.queryPack ? catalog.packById(config.queryPack) : null;
  const sources = parseList(config.sources, DEFAULT_SOURCES).map(s => s.toLowerCase());
  const enabled = new Set(sources);
  const queries = parseList(config.queries, pack ? pack.ddg : ddg.DEFAULT_QUERIES);
  const creatorQueries = parseList(
    config.creatorQueries,
    parseList(db.getSetting('creator_queries'), catalog.DEFAULT_CREATOR_QUERIES),
  );
  const xQueries = uniqueList(
    parseList(config.xQueries, pack ? pack.x : x.DEFAULT_QUERIES),
    creatorQueries.map((q) => `site:x.com ${q}`),
  );
  const webQueries = parseList(config.webQueries, pack ? pack.web : web.DEFAULT_QUERIES);
  const redgifsQueries = uniqueList(
    parseList(config.redgifsQueries, pack ? pack.redgifs : redgifs.DEFAULT_QUERIES),
    creatorQueries,
  );
  const redgifsUsers = parseList(
    config.redgifsUsers,
    parseList(db.getSetting('redgifs_users'), redgifs.DEFAULT_USERS),
  );
  if (pack && (!config.subs || !config.subs.length)) config.subs = pack.reddit;

  const jobId = uuidv4();
  currentJobId = jobId;
  const jobConfig = {
    ...config,
    sources: [...enabled],
    queries,
    xQueries,
    webQueries,
    redgifsQueries,
    redgifsUsers,
    creatorQueries,
    queryPack: config.queryPack || null,
  };
  db.insertJob({
    id: jobId,
    status: 'running',
    config: JSON.stringify(jobConfig),
    started_at: new Date().toISOString()
  });

  log('INFO', `Starting creator scan: ${[...enabled].join(', ')}${config.queryPack ? ` · pack=${config.queryPack}` : ''}`);
  broadcast({ type: 'status', data: 'running' });
  broadcast({ type: 'stats', data: stats });

  try {
    if (config.sweep !== false) await sweepJunkMedia({ probeImgur: true, limit: 500 });
    if (enabled.has('reddit')) await runReddit(config);
    if (enabled.has('redgifs') && ingesting) {
      await runQueries('redgifs', redgifs.harvestQuery, redgifsQueries, config.limit || 24);
      if (redgifsUsers.length && ingesting) await runRedgifsUsers(redgifsUsers, config.limit || 24);
    }
    if (enabled.has('x') && ingesting) await runQueries('x', x.harvestQuery, xQueries, config.limit || 20);
    if (enabled.has('ddg') && ingesting) await runQueries('ddg', ddg.harvestQuery, queries, config.limit || 24);
    if (enabled.has('web') && ingesting) await runQueries('web', web.harvestQuery, webQueries, Math.min(config.limit || 12, 20));

    db.updateJob({
      id: jobId,
      status: ingesting ? 'completed' : 'cancelled',
      stats: JSON.stringify(stats),
      completed_at: new Date().toISOString()
    });
  } catch (e) {
    db.updateJob({
      id: jobId,
      status: 'failed',
      stats: JSON.stringify(stats),
      error: e.message,
      completed_at: new Date().toISOString()
    });
    log('ERR', e.message);
  }

  ingesting = false;
  currentJobId = null;
  lastOutcome = {
    jobId,
    at: new Date().toISOString(),
    newItems: stats.total,
    skipped: stats.skipped,
    dupes: stats.dupes,
    errors: stats.errors,
    swept: stats.swept || 0,
    bySource: stats.bySource,
  };
  log('INFO', `Scan complete. New: ${stats.total} · skipped: ${stats.skipped} · dupes: ${stats.dupes} · junk swept: ${stats.swept || 0} · errors: ${stats.errors}`);
  broadcast({ type: 'status', data: 'idle' });
  broadcast({ type: 'stats', data: stats });
  broadcast({ type: 'outcome', data: lastOutcome });
}

function uniqueList(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const raw of list || []) {
      const value = String(raw).trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

function stopIngestion() {
  ingesting = false;
  paused = false;
  if (currentJobId) {
    db.updateJob({ id: currentJobId, status: 'cancelled', stats: JSON.stringify(stats), completed_at: new Date().toISOString() });
    currentJobId = null;
  }
  broadcast({ type: 'status', data: 'idle' });
}

function pauseIngestion() {
  paused = true;
  broadcast({ type: 'status', data: 'paused' });
}

function resumeIngestion() {
  paused = false;
  broadcast({ type: 'status', data: 'running' });
}

module.exports = {
  DEFAULT_SUBS,
  DEFAULT_SOURCES,
  catalog,
  getState,
  setSseClients,
  getSseClients,
  broadcast,
  getLogs,
  runIngestion,
  stopIngestion,
  pauseIngestion,
  resumeIngestion,
  sweepJunkMedia
};
