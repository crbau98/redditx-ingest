const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const DEFAULT_SUBS = [
  'gaybrosgonemild', 'boyswithabs', 'vlinesabsanddick',
  'gaynsfw', 'twinks', 'massivecocks', 'hardbodies', 'gaymuscle',
  'totallystraight', 'broslikeus', 'malepubes', 'cock',
  'gaybrosgonewild', 'bulges', 'jockstraps'
];

// Runtime state
let ingesting = false;
let paused = false;
let currentJobId = null;
let sseClients = [];
let stats = { total: 0, images: 0, videos: 0, dupes: 0, errors: 0 };
let logs = [];

function getState() {
  return { ingesting, paused, stats, currentJobId };
}

function setSseClients(clients) { sseClients = clients; }
function getSseClients() { return sseClients; }

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  sseClients = sseClients.filter(c => {
    try { c.write(data); return true; } catch { return false; }
  });
}

function log(level, msg) {
  const entry = { ts: new Date().toISOString(), level, msg };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  broadcast({ type: 'log', data: entry });
}

function getLogs() { return logs; }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'PRISM-Ingest/2.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractMedia(post) {
  const d = post.data;
  const result = {
    id: d.id, title: d.title, author: d.author, subreddit: d.subreddit,
    score: d.score, url: d.url, permalink: 'https://reddit.com' + d.permalink,
    created: d.created_utc, nsfw: d.over_18, mediaType: null, mediaUrl: null,
    previewUrl: null, thumbnail: d.thumbnail
  };

  // Preview
  if (d.preview && d.preview.images && d.preview.images[0]) {
    const src = d.preview.images[0].source;
    if (src) result.previewUrl = src.url.replace(/&amp;/g, '&');
  }

  // Direct image
  if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(d.url)) {
    result.mediaType = 'image'; result.mediaUrl = d.url;
  }
  // Imgur
  else if (/imgur\.com\/\w+$/i.test(d.url) && !/\/a\//i.test(d.url)) {
    result.mediaType = 'image'; result.mediaUrl = d.url + '.jpg';
  }
  // Reddit gallery
  else if (d.is_gallery && d.media_metadata) {
    const first = Object.values(d.media_metadata)[0];
    if (first && first.s) {
      result.mediaType = 'image'; result.mediaUrl = (first.s.u || first.s.gif || '').replace(/&amp;/g, '&');
    }
  }
  // Reddit video
  else if (d.is_video && d.media && d.media.reddit_video) {
    result.mediaType = 'video'; result.mediaUrl = d.media.reddit_video.fallback_url;
  }
  // Redgifs
  else if (/redgifs\.com/i.test(d.url)) {
    result.mediaType = 'video'; result.mediaUrl = d.url;
    if (result.previewUrl) { result.mediaType = 'image'; result.mediaUrl = result.previewUrl; }
  }
  // Fallback to preview
  else if (result.previewUrl) {
    result.mediaType = 'image'; result.mediaUrl = result.previewUrl;
  }

  return result;
}

// Gay-focused subreddits get 'gay' scope, others get 'uncertain'
const GAY_SUBS = new Set(DEFAULT_SUBS.map(s => s.toLowerCase()));

function getOrientationScope(subreddit) {
  if (!subreddit) return 'uncertain';
  return GAY_SUBS.has(subreddit.toLowerCase()) ? 'gay' : 'uncertain';
}

function getOrCreateCreator(author) {
  if (!author || author === '[deleted]' || author === 'AutoModerator') return null;

  let creator = db.getCreatorByHandle(author);
  if (creator) return creator;

  const id = uuidv4();
  db.insertCreator({
    id,
    primary_handle: author,
    display_name: author,
    orientation_scope: 'gay'
  });

  db.insertCreatorSource({
    id: uuidv4(),
    creator_id: id,
    source_platform: 'reddit',
    source_creator_id: author,
    handle: author,
    profile_url: `https://reddit.com/u/${author}`
  });

  return db.getCreator(id);
}

async function runIngestion(config = {}) {
  if (ingesting) return { ok: false, msg: 'Already running' };

  ingesting = true;
  paused = false;
  stats = { total: 0, images: 0, videos: 0, dupes: 0, errors: 0 };
  logs = [];

  const subs = (config.subs && config.subs.length) ? config.subs : DEFAULT_SUBS;
  const sort = config.sort || 'hot';
  const limit = config.limit || 50;
  const minScore = config.minScore || 0;

  const jobId = uuidv4();
  currentJobId = jobId;
  db.insertJob({
    id: jobId,
    status: 'running',
    config: JSON.stringify({ subs, sort, limit, minScore }),
    started_at: new Date().toISOString()
  });

  log('INFO', `Starting ingestion: ${subs.length} subs, sort=${sort}, limit=${limit}`);
  broadcast({ type: 'status', data: 'running' });

  try {
    for (const sub of subs) {
      if (!ingesting) break;
      while (paused) { await sleep(500); if (!ingesting) break; }
      if (!ingesting) break;

      log('INFO', `Fetching r/${sub}/${sort}...`);
      try {
        const url = `https://www.reddit.com/r/${sub}/${sort}.json?limit=${limit}&raw_json=1`;
        const json = await fetchJSON(url);
        if (!json || !json.data || !json.data.children) {
          log('WARN', `No data from r/${sub}`);
          continue;
        }

        let count = 0;
        for (const post of json.data.children) {
          if (!ingesting) break;
          while (paused) { await sleep(500); }

          const item = extractMedia(post);
          if (!item.mediaUrl) continue;

          const hash = crypto.createHash('md5').update(item.mediaUrl).digest('hex');
          if (db.getMediaByHash(hash)) {
            stats.dupes++;
            broadcast({ type: 'stats', data: stats });
            continue;
          }

          if (item.score < minScore) continue;

          const creator = getOrCreateCreator(item.author);
          const mediaId = uuidv4();
          const orientation = getOrientationScope(item.subreddit);

          db.insertMedia({
            id: mediaId,
            title: item.title || null,
            description: null,
            media_type: item.mediaType,
            media_url: item.mediaUrl,
            preview_url: item.previewUrl || null,
            thumbnail_url: (item.thumbnail && item.thumbnail.startsWith('http')) ? item.thumbnail : null,
            source_platform: 'reddit',
            source_url: item.permalink,
            source_id: item.id,
            subreddit: item.subreddit,
            author: item.author,
            score: item.score || 0,
            hash,
            width: null,
            height: null,
            orientation_scope: orientation,
            publish_state: 'published',
            creator_id: creator ? creator.id : null
          });

          if (creator) db.updateCreatorStats(creator.id);

          // Add subreddit as a tag
          if (item.subreddit) {
            db.addTagToMedia(mediaId, item.subreddit.toLowerCase(), 'ingest');
          }

          stats.total++;
          if (item.mediaType === 'image') stats.images++;
          else if (item.mediaType === 'video') stats.videos++;

          const mediaData = db.getMedia(mediaId);
          broadcast({ type: 'item', data: mediaData });
          broadcast({ type: 'stats', data: stats });
          log('OK', `[${item.mediaType}] r/${sub}: ${(item.title || '').substring(0, 60)}`);
          count++;
          await sleep(100);
        }
        log('OK', `r/${sub}: ${count} items ingested`);
      } catch (e) {
        stats.errors++;
        log('ERR', `r/${sub}: ${e.message}`);
        broadcast({ type: 'stats', data: stats });
      }
      await sleep(300 + Math.random() * 400);
    }

    db.updateJob({
      id: jobId,
      status: 'completed',
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
  }

  ingesting = false;
  currentJobId = null;
  log('INFO', `Ingestion complete. Total: ${stats.total}`);
  broadcast({ type: 'status', data: 'idle' });
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
  getState,
  setSseClients,
  getSseClients,
  broadcast,
  getLogs,
  runIngestion,
  stopIngestion,
  pauseIngestion,
  resumeIngestion
};
