'use strict';
/**
 * Jina Reader (https://r.jina.ai): a free, keyless page reader run by a third party.
 *
 *   GET https://r.jina.ai/<page>            x-respond-with: html -> the page after its JavaScript ran
 *                                            x-respond-with: markdown -> the page as text
 *
 * Why it exists here: it renders in Jina's own browser from their own addresses, so a page that refuses PRISM on both
 * counts often still answers. Measured on 2026-11-06: justthegays.com came back as 832 KB of real HTML with 514 media
 * URLs (PRISM's plain read gets the same page, so this is a render path, not a rescue); TikTok's profile came back with
 * 47 video links. It does NOT beat a Cloudflare firewall rule (gayforfans.com answers "Just a moment...") - that is what
 * the paid tiers are for.
 *
 * Rules, enforced here:
 *   - the URL is checked by the caller (takedowns, private addresses, robots.txt) before it is handed over: this module
 *     never decides content policy, it only reads;
 *   - a page on a PAID platform is never sent (the paid tiers are the only ones allowed to spend on those);
 *   - a daily request budget (setting jinaDailyBudget) caps the use, because the free tier is rate limited per address;
 *   - the free tier needs no key; a JINA_API_KEY raises the limit when one is set.
 */
const config = require('../config');
const repo = require('../db/repo');
const net = require('./net');
const limiter = require('./limiter');
const paid = require('./paid');

const today = () => new Date().toISOString().slice(0, 10);

function usage() {
  let u = {};
  try { u = JSON.parse(repo.settings.get('jina.usage') || '{}'); } catch { u = {}; }
  return u.day === today() ? { day: u.day, count: u.count || 0, total: u.total || 0 } : { day: today(), count: 0, total: u.total || 0 };
}
function record() {
  const u = usage();
  repo.settings.set('jina.usage', JSON.stringify({ day: u.day, count: u.count + 1, total: u.total + 1 }));
}

const configured = () => !!config.jina.base;

/** Remaining requests today, given the setting. */
function remaining(budget) {
  return Math.max(0, Number(budget || 0) - usage().count);
}

/**
 * Read a page through Jina Reader.
 * @param {string} url
 * @param {{format?: 'html'|'markdown', budget?: number, timeout?: number}} opts
 * @returns {Promise<{html: string, text: string, status: number, bytes: number, blocked: boolean, ms: number}>}
 */
async function read(url, opts = {}) {
  if (!configured()) throw Object.assign(new Error('Jina Reader is not configured'), { skip: true });
  if (paid.isPaidPlatform(url)) throw Object.assign(new Error('paid platform: the reader is not used on a paid page'), { skip: true });
  const budget = Number(opts.budget ?? 0);
  if (budget && remaining(budget) <= 0) throw Object.assign(new Error(`Jina Reader daily budget reached (${budget}/day)`), { budget: true });
  const format = opts.format === 'markdown' ? 'markdown' : 'html';
  const headers = { accept: 'text/plain', 'x-respond-with': format, 'x-timeout': '25' };
  if (config.jina.key) headers.authorization = `Bearer ${config.jina.key}`;
  const started = Date.now();
  const res = await limiter.schedule(`jina:${new URL(url).hostname}`, 2500, () => net.request(`${config.jina.base}${url}`, {
    headers, retries: 1, timeout: opts.timeout || config.jina.timeoutMs, maxBytes: 6_000_000,
  }));
  record();
  const body = String(res.body || '');
  // The reader answers 200 with a short "Just a moment..." page when the target still refused it: not an error to throw,
  // an answer the caller must ignore.
  const blocked = body.length < 2500
    && /^Title: Just a moment\.\.\.|Warning: This page maybe requiring CAPTCHA|Performing security verification/i.test(body);
  return {
    html: format === 'html' ? body : '',
    text: format === 'markdown' ? body : '',
    status: res.status,
    bytes: body.length,
    blocked,
    ms: Date.now() - started,
  };
}

module.exports = { configured, read, usage, remaining, _reset: () => repo.settings.set('jina.usage', '{}') };
