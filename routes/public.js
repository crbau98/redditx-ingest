const express = require('express');
const https = require('https');
const http = require('http');
const mediaService = require('../services/media');
const creatorsService = require('../services/creators');
const ingestion = require('../services/ingestion');
const db = require('../db');
const { isPrivateHost } = require('../services/fetch');

const router = express.Router();

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Stats
router.get('/stats', (req, res) => {
  const stats = mediaService.getStats();
  const state = ingestion.getState();
  res.json({ ...stats, ingesting: state.ingesting, paused: state.paused, ingest: state.stats });
});

// Media list
router.get('/media', (req, res) => {
  const { page, limit, type, subreddit, creator, tag, sort, q, publishState } = req.query;
  const result = mediaService.list({
    page: parseInt(page) || 0,
    limit: Math.min(parseInt(limit) || 50, 200),
    type, subreddit, creator, tag, sort, q,
    ...(publishState !== undefined ? { publishState } : {})
  });
  res.json(result);
});

// Media detail
router.get('/media/:id', (req, res) => {
  const media = mediaService.get(req.params.id);
  if (!media) return res.status(404).json({ error: 'Not found' });
  res.json(media);
});

// Related media
router.get('/media/:id/related', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 12, 50);
  const related = mediaService.getRelated(req.params.id, limit);
  res.json(related);
});

// Creators list
router.get('/creators', (req, res) => {
  const { page, limit, q } = req.query;
  const result = creatorsService.list({
    page: parseInt(page) || 0,
    limit: Math.min(parseInt(limit) || 50, 200),
    q
  });
  res.json(result);
});

// Creator detail
router.get('/creators/:id', (req, res) => {
  const creator = creatorsService.get(req.params.id);
  if (!creator) return res.status(404).json({ error: 'Not found' });
  res.json(creator);
});

// Creator media
router.get('/creators/:id/media', (req, res) => {
  const { page, limit, sort } = req.query;
  const result = creatorsService.getMedia(req.params.id, {
    page: parseInt(page) || 0,
    limit: Math.min(parseInt(limit) || 50, 200),
    sort
  });
  res.json(result);
});

// Tags
router.get('/tags', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json(mediaService.getTags(limit));
});

// Media by tag
router.get('/tags/:name/media', (req, res) => {
  const { page, limit, sort } = req.query;
  const result = mediaService.getMediaByTag(req.params.name, {
    page: parseInt(page) || 0,
    limit: Math.min(parseInt(limit) || 50, 200),
    sort
  });
  res.json(result);
});

// Subreddits list
router.get('/subreddits', (req, res) => {
  res.json(mediaService.getSubreddits());
});

// Image/video proxy — allow known CDNs and URLs already ingested
router.get('/proxy', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing url parameter' });

  const allowed = [
    'i.redd.it', 'preview.redd.it', 'i.imgur.com', 'imgur.com',
    'external-preview.redd.it', 'b.thumbs.redditmedia.com',
    'v.redd.it', 'redditmedia.com', 'redgifs.com', 'gfycat.com',
    'pbs.twimg.com', 'twimg.com', 'video.twimg.com',
    'media.tumblr.com', 'pinimg.com', 'bing.net', 'bing.com',
    'duckduckgo.com', 'googleusercontent.com', 'ggpht.com',
    'discordsays.com', 'discordapp.com', 'cdninstagram.com',
    'fbcdn.net', 'onlyfans.com', 'xhcdn.com', 'redgifs.com'
  ];

  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'Invalid protocol' });
  }
  if (isPrivateHost(parsed.hostname)) {
    return res.status(403).json({ error: 'Blocked host' });
  }

  const hostOk = allowed.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h));
  if (!hostOk && !db.isKnownMediaUrl(target)) {
    return res.status(403).json({ error: 'Domain not allowed' });
  }

  const mod = parsed.protocol === 'https:' ? https : http;
  const proxyReq = mod.get(target, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: parsed.origin + '/',
      Accept: 'image/avif,image/webp,image/*,*/*;q=0.8'
    }
  }, proxyRes => {
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
      const next = new URL(proxyRes.headers.location, parsed).toString();
      proxyRes.resume();
      return res.redirect('/api/proxy?url=' + encodeURIComponent(next));
    }
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => res.status(502).json({ error: 'Proxy error' }));
  proxyReq.setTimeout(15000, () => { proxyReq.destroy(); res.status(504).json({ error: 'Timeout' }); });
});

module.exports = router;
