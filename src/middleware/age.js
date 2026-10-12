'use strict';
/**
 * Server-side age gate. The previous gate was a client-side overlay: anyone
 * calling the API directly bypassed it. Now content endpoints require a cookie
 * that is only issued by POST /api/age/confirm.
 */
const config = require('../config');

const COOKIE = 'prism_age';
const MAX_AGE_S = 30 * 24 * 3600;

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const isVerified = (req) => !config.ageGateEnforce || readCookie(req, COOKIE) === '1';

function requireAge(req, res, next) {
  if (isVerified(req)) return next();
  return res.status(403).json({ error: 'Age verification required', code: 'age_gate' });
}

function confirm(req, res) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=1; Max-Age=${MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}

module.exports = { requireAge, confirm, isVerified, readCookie };
