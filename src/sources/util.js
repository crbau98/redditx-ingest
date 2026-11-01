'use strict';
const cheerio = require('cheerio');
const config = require('../config');

/** Epoch seconds / epoch ms / ISO / RFC-822 -> ISO string (or null). */
function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  let ms;
  if (typeof v === 'number') ms = v < 1e11 ? v * 1000 : v;
  else if (/^\d+(\.\d+)?$/.test(String(v))) { const n = Number(v); ms = n < 1e11 ? n * 1000 : n; }
  else {
    let str = String(v).trim();
    // ISO date-times with no zone designator (Lemmy < 0.19.4, some CMSs) are UTC; Date.parse would
    // read them in the server's local zone and shift every timestamp (and the "newest seen" cursor).
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(str)) str = `${str.replace(' ', 'T')}Z`;
    ms = Date.parse(str);
  }
  if (!Number.isFinite(ms)) return null;
  // Clamp absurd future dates (broken feeds) to now.
  return new Date(Math.min(ms, Date.now())).toISOString();
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/g, '/');
}

function htmlToText(html, max = 500) {
  if (!html) return '';
  const $ = cheerio.load(`<div>${html}</div>`, null, false);
  $('script,style').remove();
  $('br').replaceWith('\n');
  $('p').each((_, el) => { $(el).append('\n'); });
  return $.root().text().replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function absUrl(href, base) {
  if (!href) return null;
  try { return new URL(String(href).trim(), base).toString(); } catch { return null; }
}

function clip(s, n) { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

/** Pick the smallest candidate whose width >= target (fallback: largest). */
function pickWidth(cands, target = 640) {
  const list = (cands || []).filter((c) => c && c.url && c.width);
  if (!list.length) return null;
  list.sort((a, b) => a.width - b.width);
  return (list.find((c) => c.width >= target) || list[list.length - 1]).url;
}

function stripQuery(url, keys) {
  try { const u = new URL(url); keys.forEach((k) => u.searchParams.delete(k)); return u.toString(); } catch { return url; }
}

/** Best (widest) URL of an <img srcset>. */
function bestSrcset(srcset, base) {
  const cands = String(srcset || '').split(',').map((s) => s.trim().split(/\s+/)).filter((p) => p[0])
    .map((p) => ({ url: absUrl(p[0], base), w: parseInt(p[1], 10) || 0 }));
  cands.sort((a, b) => b.w - a.w);
  return (cands[0] && cands[0].url) || null;
}

/**
 * Origin for a federated-instance host name. Always https, except that tests may talk to a loopback
 * mock ("127.0.0.1:4567") when ALLOW_PRIVATE_HOSTS is on (never true in production).
 */
function originOf(host) {
  const h = String(host || '');
  return config.allowPrivateHosts && /^(127\.|localhost)/i.test(h) ? `http://${h}` : `https://${h}`;
}

/** Message body of a failed request (Mastodon/Lemmy/Misskey/Bluesky all return a JSON error object). */
function errorDetail(e) {
  if (!e || !e.body) return '';
  try {
    const b = JSON.parse(e.body);
    const inner = b && typeof b.error === 'object' ? b.error : null;
    return String((inner && (inner.message || inner.code)) || b.message || b.error || '').slice(0, 200);
  } catch { return ''; }
}

/** Keep reposts (credited to the original poster)? Admin setting "reposts", on by default. */
function repostsOn() { try { return require('../settings').get().reposts !== false; } catch { return true; } }

/**
 * Body of a bot-protection interstitial page (Cloudflare managed challenge, "Just a moment...",
 * an access-denied wall). Used to tell "the site is blocking us" apart from "this page is broken" —
 * we report it, we do not solve it or route around it.
 */
function isChallengeText(body) {
  return /challenge-platform|cf_chl|Just a moment|Attention Required|checking-your-browser/i.test(String(body || '').slice(0, 8192));
}

module.exports = { repostsOn, toIso, decodeHtml, htmlToText, absUrl, clip, uniq, pickWidth, stripQuery, bestSrcset, originOf, errorDetail, isChallengeText };
