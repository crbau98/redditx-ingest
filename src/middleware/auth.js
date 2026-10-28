'use strict';
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const config = require('../config');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Brute-force guard: only *failed* attempts count against the budget.
const failedAttempts = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed admin attempts, try again later' },
});

function adminAuth(req, res, next) {
  return adminCredentialAuth(req, res, next);
}

function adminCredentialAuth(req, res, next) {
  if (!config.adminKey) {
    if (config.adminOpen) return next(); // development convenience only
    return res.status(503).json({ error: 'Admin is disabled. Set the ADMIN_KEY environment variable.' });
  }
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const provided = req.headers['x-admin-key'] || bearer;
  if (provided && safeEqual(provided, config.adminKey)) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid or missing admin key' });
}

module.exports = {
  adminAuth: [failedAttempts, adminAuth],
  adminRateLimit: failedAttempts,
  adminCredentialAuth,
  safeEqual,
};
