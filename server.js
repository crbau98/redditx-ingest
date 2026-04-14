require('dotenv').config();

const express = require('express');
const path = require('path');

// Initialize DB (runs migrations)
require('./db');

const cors = require('./middleware/cors');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const streamRoutes = require('./routes/stream');

const app = express();
const PORT = process.env.PORT || 3141;

// Middleware
app.use(express.json());
app.use(cors);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/stream', streamRoutes);

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PRISM server running on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Admin:   Set ADMIN_KEY env var to protect admin routes`);
});
