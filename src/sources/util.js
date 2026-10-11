'use strict';
const cheerio = require('cheerio');

/** Epoch seconds / epoch ms / ISO / RFC-822 -> ISO string (or null). */
function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  let ms;
  if (typeof v === 'number') ms = v < 1e11 ? v * 1000 : v;
  else if (/^\d+(\.\d+)?$/.test(String(v))) { const n = Number(v); ms = n < 1e11 ? n * 1000 : n; }
  else ms = Date.parse(String(v));
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

module.exports = { toIso, decodeHtml, htmlToText, absUrl, clip, uniq, pickWidth, stripQuery };
