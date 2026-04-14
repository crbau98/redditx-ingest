const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3141;

// --- State ---
let items = [];
let logs = [];
let seenUrls = new Set();
let ingesting = false;
let paused = false;
let sseClients = [];
let stats = { total: 0, images: 0, videos: 0, dupes: 0, errors: 0 };

const DEFAULT_SUBS = [
  'gaybrosgonemild', 'boyswithabs', 'vlinesabsanddick',
  'gaynsfw', 'twinks', 'massivecocks', 'hardbodies', 'gaymuscle',
  'totallystraight', 'broslikeus', 'malepubes', 'cock',
  'gaybrosgonewild', 'bulges', 'jockstraps'
];

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// --- Helpers ---
function log(level, msg) {
  const entry = { ts: new Date().toISOString(), level, msg };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  broadcast({ type: 'log', data: entry });
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  sseClients = sseClients.filter(c => { try { c.write(data); return true; } catch { return false; } });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'RedditX-Ingest/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractMedia(post) {
  const d = post.data;
  const result = { id: d.id, title: d.title, author: d.author, subreddit: d.subreddit,
    score: d.score, url: d.url, permalink: 'https://reddit.com' + d.permalink,
    created: d.created_utc, nsfw: d.over_18, mediaType: null, mediaUrl: null,
    previewUrl: null, thumbnail: d.thumbnail };

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

// --- Ingestion ---
async function runIngestion(config) {
  ingesting = true; paused = false;
  const subs = (config && config.subs && config.subs.length) ? config.subs : DEFAULT_SUBS;
  const sort = (config && config.sort) || 'hot';
  const limit = (config && config.limit) || 50;
  const minScore = (config && config.minScore) || 0;

  log('INFO', `Starting ingestion: ${subs.length} subs, sort=${sort}, limit=${limit}`);
  broadcast({ type: 'status', data: 'running' });

  for (const sub of subs) {
    if (!ingesting) break;
    while (paused) { await sleep(500); if (!ingesting) break; }
    if (!ingesting) break;

    log('INFO', `Fetching r/${sub}/${sort}...`);
    try {
      const url = `https://www.reddit.com/r/${sub}/${sort}.json?limit=${limit}&raw_json=1`;
      const json = await fetchJSON(url);
      if (!json || !json.data || !json.data.children) {
        log('WARN', `No data from r/${sub}`); continue;
      }

      let count = 0;
      for (const post of json.data.children) {
        if (!ingesting) break;
        while (paused) { await sleep(500); }
        const item = extractMedia(post);
        if (!item.mediaUrl) continue;

        const hash = crypto.createHash('md5').update(item.mediaUrl).digest('hex');
        if (seenUrls.has(hash)) { stats.dupes++; broadcast({ type: 'stats', data: stats }); continue; }
        seenUrls.add(hash);

        if (item.score < minScore) continue;

        item.hash = hash;
        items.push(item);
        stats.total++;
        if (item.mediaType === 'image') stats.images++;
        else if (item.mediaType === 'video') stats.videos++;

        broadcast({ type: 'item', data: item });
        broadcast({ type: 'stats', data: stats });
        log('OK', `[${item.mediaType}] r/${sub}: ${item.title.substring(0, 60)}`);
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

  ingesting = false;
  log('INFO', `Ingestion complete. Total: ${stats.total}`);
  broadcast({ type: 'status', data: 'idle' });
}

// --- API Routes ---
app.get('/api/status', (req, res) => res.json({ ingesting, paused, stats, itemCount: items.length }));
app.get('/api/items', (req, res) => {
  const page = parseInt(req.query.page) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const sub = req.query.sub || '';
  const type = req.query.type || '';
  let filtered = items;
  if (sub) filtered = filtered.filter(i => i.subreddit.toLowerCase() === sub.toLowerCase());
  if (type) filtered = filtered.filter(i => i.mediaType === type);
  res.json({ items: filtered.slice(page * limit, (page + 1) * limit), total: filtered.length, page });
});

app.post('/api/ingest/start', (req, res) => {
  if (ingesting) return res.json({ ok: false, msg: 'Already running' });
  items = []; seenUrls.clear(); stats = { total: 0, images: 0, videos: 0, dupes: 0, errors: 0 }; logs = [];
  runIngestion(req.body);
  res.json({ ok: true });
});

app.post('/api/ingest/pause', (req, res) => { paused = true; broadcast({ type: 'status', data: 'paused' }); res.json({ ok: true }); });
app.post('/api/ingest/resume', (req, res) => { paused = false; broadcast({ type: 'status', data: 'running' }); res.json({ ok: true }); });
app.post('/api/ingest/stop', (req, res) => { ingesting = false; paused = false; broadcast({ type: 'status', data: 'idle' }); res.json({ ok: true }); });

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

// --- Image proxy ---
app.get('/api/proxy', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url');
  const allowed = ['i.redd.it', 'preview.redd.it', 'i.imgur.com', 'external-preview.redd.it', 'b.thumbs.redditmedia.com'];
  let hostname;
  try { hostname = new URL(target).hostname; } catch { return res.status(400).send('Bad url'); }
  if (!allowed.some(h => hostname.endsWith(h))) return res.status(403).send('Domain not allowed');

  const mod = target.startsWith('https') ? https : http;
  const proxyReq = mod.get(target, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.reddit.com/' } }, proxyRes => {
    if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302) {
      return res.redirect(proxyRes.headers.location);
    }
    res.writeHead(proxyRes.statusCode, { 'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => res.status(502).send('Proxy error'));
  proxyReq.setTimeout(10000, () => { proxyReq.destroy(); res.status(504).send('Timeout'); });
});

app.get('/api/subs', (req, res) => res.json(DEFAULT_SUBS));

app.listen(PORT, () => console.log(`RedditX server running on port ${PORT}`));
