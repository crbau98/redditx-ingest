'use strict';
/**
 * What every AI provider (lib/claude.js, lib/openai.js) shares: today's request/token count and the daily budget
 * (setting aiDailyBudget, one budget across providers), and the answer cache.
 */
const crypto = require('crypto');
const repo = require('../db/repo');

const today = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ budget */
function usage() {
  let u = {};
  try { u = JSON.parse(repo.settings.get('ai.usage') || '{}'); } catch { u = {}; }
  const t = u.total || { calls: 0, input: 0, output: 0 };
  return u.day === today()
    ? { day: u.day, calls: u.calls || 0, input: u.input || 0, output: u.output || 0, refusals: u.refusals || 0, total: t }
    : { day: today(), calls: 0, input: 0, output: 0, refusals: 0, total: t };
}
/** Count one request: tokens in and out, and whether the model declined it. */
function record(inTok, outTok, { refusal = false } = {}) {
  const u = usage();
  repo.settings.set('ai.usage', JSON.stringify({
    day: u.day, calls: u.calls + 1, input: u.input + inTok, output: u.output + outTok, refusals: u.refusals + (refusal ? 1 : 0),
    total: { calls: u.total.calls + 1, input: u.total.input + inTok, output: u.total.output + outTok },
  }));
}
function budgetLeft() {
  const s = require('../settings').get();
  return Math.max(0, s.aiDailyBudget - usage().calls);
}

/* ------------------------------------------------------------------- cache */
const cache = new Map(); // key -> {at, value}
const CACHE_MAX = 500;
const keyOf = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function cached(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit;
  if (hit) cache.delete(key);
  return null;
}
function remember(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

const skipErr = (msg, extra = {}) => Object.assign(new Error(msg), { skip: true, ...extra });
const budgetErr = (msg, extra = {}) => Object.assign(new Error(msg), { budget: true, ...extra });

module.exports = { usage, record, budgetLeft, cached, remember, keyOf, skipErr, budgetErr, cacheSize: () => cache.size, clearCache: () => cache.clear() };
