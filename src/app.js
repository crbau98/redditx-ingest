'use strict';
const path = require('path');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const config = require('./config');

require('./db'); // runs migrations

const publicRoutes = require('./routes/public');
const proxyRoutes = require('./routes/proxy');
const adminRoutes = require('./routes/admin');
const age = require('./middleware/age');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        // Every remote asset is served through our own proxy, so 'self' is enough.
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'connect-src': ["'self'"],
        'worker-src': ["'self'", 'blob:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use(compression({ filter: (req, res) => (req.path.startsWith('/api/stream') || req.path.startsWith('/api/admin/stream') || req.path === '/api/proxy' ? false : compression.filter(req, res)) }));
  if (!config.isTest) app.use(morgan(config.isProd ? 'tiny' : 'dev', { skip: (req) => req.path === '/api/health' || req.path === '/api/proxy' }));
  app.use('/api/admin/import', express.json({ limit: '12mb' })); // curated configs can be large; everything else stays at 1mb
  app.use(express.json({ limit: '1mb' }));

  // Generous limiter for the JSON API; the media proxy has its own, much higher ceiling
  // (a single page of results legitimately fires dozens of image requests).
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000, max: 400, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, slow down' },
    skip: (req) => req.path === '/proxy' || req.path === '/hls' || req.path === '/stream' || req.path === '/health' || req.path.startsWith('/admin'),
  });
  const mediaLimiter = rateLimit({ windowMs: 60 * 1000, max: 4000, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many media requests' } });

  if (process.env.DEMO_ART === '1' && !config.isProd) app.use('/demo', require('./routes/demo'));
  app.use('/api/admin', adminRoutes);
  app.use('/api/proxy', mediaLimiter);
  app.use('/api/hls', mediaLimiter);
  app.use('/api', apiLimiter);
  // Proxy + HLS sit behind the age gate too (they serve the content itself).
  app.use('/api', (req, res, next) => (['/proxy', '/hls'].includes(req.path) ? age.requireAge(req, res, next) : next()));
  app.use('/api', proxyRoutes);
  app.use('/api', publicRoutes);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  const pub = path.join(config.root, 'public');
  // App shell with versioned, immutable asset URLs + modulepreload (see lib/assets.js).
  // Production builds it once; development rebuilds per request so edits show up without a restart.
  const assets = require('./lib/assets');
  let built = null;
  const shell = () => (config.isProd && built ? built : (built = assets.build(pub)));
  const sendShell = (req, res) => res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }).send(shell().html);
  app.get(['/', '/index.html'], sendShell);
  app.use('/v/:ver', (req, res, next) => {
    // Current version: cache forever. An older version (a tab open across a deploy) still loads,
    // but must revalidate, since the files on disk are now the new ones.
    const current = req.params.ver === shell().version;
    express.static(pub, { etag: true, index: false, setHeaders: (r) => r.setHeader('Cache-Control', current ? 'public, max-age=31536000, immutable' : 'no-cache') })(req, res, next);
  });
  app.use(express.static(pub, {
    etag: true,
    setHeaders(res, file) {
      if (/\/vendor\//.test(file) || /\.(woff2?|png|svg|webp|ico)$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=604800');
      else res.setHeader('Cache-Control', 'no-cache'); // html/js/css: always revalidate (ETag makes it cheap)
    },
  }));
  app.get('*', sendShell);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (!config.isTest) console.error('[ERROR]', req.method, req.path, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
    res.status((err && err.status) || 500).json({ error: config.isProd ? 'Internal server error' : String((err && err.message) || err) });
  });

  return app;
}

module.exports = { createApp };
