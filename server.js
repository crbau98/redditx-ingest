require('dotenv').config();

const express = require('express');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

// Initialize DB (runs migrations)
require('./db');

const cors = require('./middleware/cors');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const streamRoutes = require('./routes/stream');
const ingestion = require('./services/ingestion');

const app = express();
const PORT = process.env.PORT || 3141;

// Security & Performance Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(morgan('tiny'));
app.use(express.json({ limit: '10mb' }));
app.use(cors);

// Rate limiting for API
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' }
});
app.use('/api', apiLimiter);

// Static files with caching
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true
}));

// API routes
app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/stream', streamRoutes);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// Scheduled ingestion (every 6 hours if enabled)
if (process.env.CRON_ENABLED === 'true') {
  const schedule = process.env.CRON_SCHEDULE || '0 */6 * * *';
  cron.schedule(schedule, () => {
    console.log('[CRON] Starting scheduled ingestion...');
    const state = ingestion.getState();
    if (!state.ingesting) {
      ingestion.runIngestion({});
    }
  });
  console.log(`[CRON] Scheduled ingestion: ${process.env.CRON_SCHEDULE || '0 */6 * * *'}`);
}

app.listen(PORT, () => {
  console.log(`\n  ==============================`);
  console.log(`   PRISM v3.0 Server`);
  console.log(`  ==============================`);
  console.log(`   Port:  ${PORT}`);
  console.log(`   Local: http://localhost:${PORT}`);
  console.log(`   Admin: Set ADMIN_KEY env var`);
  console.log(`   Cron:  ${process.env.CRON_ENABLED === 'true' ? 'Enabled' : 'Disabled'}`);
  console.log(`  ==============================\n`);
});
