const { fetchText } = require('../fetch');
const { searchWeb } = require('./ddg');
const { hostTrusted, hostBlocked, normalizeMediaUrl } = require('../media-quality');

const DEFAULT_QUERIES = [
  'site:imgur.com gay male creator',
  'site:redgifs.com gay',
  'site:erome.com gay male',
];

function meta(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1].replace(/&amp;/g, '&');
  }
  return null;
}

function titleOf(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim().slice(0, 180) : null;
}

function guessType(url) {
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url) || /video|redgifs/i.test(url)) return 'video';
  return 'image';
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

async function extractMediaFromPage(pageUrl) {
  if (hostBlocked(hostOf(pageUrl)) && !hostTrusted(hostOf(pageUrl))) return null;
  const html = await fetchText(pageUrl, { maxBytes: 800_000, headers: { Accept: 'text/html' } });
  const image = meta(html, 'og:image') || meta(html, 'twitter:image') || meta(html, 'og:image:url');
  const video = meta(html, 'og:video') || meta(html, 'og:video:url') || meta(html, 'twitter:player:stream');
  const mediaUrl = video || image;
  if (!mediaUrl || !/^https?:/i.test(mediaUrl)) return null;
  const host = hostOf(mediaUrl);
  if (hostBlocked(host) || !hostTrusted(host)) return null;
  const mediaType = video ? 'video' : guessType(mediaUrl);
  return {
    title: meta(html, 'og:title') || titleOf(html),
    mediaUrl: normalizeMediaUrl(mediaUrl, mediaType) || mediaUrl,
    previewUrl: image || mediaUrl,
    mediaType,
    author: meta(html, 'og:site_name') || host.split('.')[0] || 'web'
  };
}

async function harvestQuery(query, { limit = 15 } = {}) {
  const pages = await searchWeb(query, limit);
  const items = [];
  for (const page of pages) {
    try {
      const extracted = await extractMediaFromPage(page);
      if (!extracted) continue;
      items.push({
        sourceId: 'web-' + Buffer.from(page).toString('base64url').slice(0, 28),
        title: extracted.title || query,
        author: extracted.author,
        score: 0,
        permalink: page,
        mediaType: extracted.mediaType,
        mediaUrl: extracted.mediaUrl,
        previewUrl: extracted.previewUrl,
        query
      });
    } catch { /* skip pages that block fetch */ }
  }
  return { items, pages };
}

module.exports = { DEFAULT_QUERIES, harvestQuery, extractMediaFromPage };
