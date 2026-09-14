const { fetchText, fetchJSON, request } = require('../fetch');
const { URL } = require('url');

const DEFAULT_QUERIES = [
  'gay muscle men',
  'gay male model nsfw',
  'gay twink men',
  'onlyfans gay male',
  'gay bodybuilder men'
];

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractDdgLinks(html) {
  const links = [];
  const seen = new Set();
  const re = /uddg=([^&"]+)/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const href = decodeURIComponent(m[1]);
      if (!/^https?:/i.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      links.push(href);
    } catch { /* skip */ }
  }
  return links;
}

async function searchWeb(query, limit = 20) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url, { headers: { Accept: 'text/html' } });
  return extractDdgLinks(html).slice(0, limit);
}

function extractBingImageUrls(html, limit = 40) {
  const urls = [];
  const seen = new Set();
  const re = /murl&quot;:&quot;([^&]+)&quot;/g;
  let m;
  while ((m = re.exec(html)) && urls.length < limit) {
    try {
      const href = decodeHtml(m[1]);
      if (!/^https?:/i.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      urls.push(href);
    } catch { /* skip */ }
  }
  return urls;
}

async function searchImages(query, limit = 30) {
  // DDG image JSON (i.js) is blocked from datacenter IPs. DDG images are
  // backed by Bing's index — use that public HTML endpoint for image URLs.
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
  const html = await fetchText(url, { headers: { Accept: 'text/html' } });
  return extractBingImageUrls(html, limit);
}

function guessType(url) {
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return 'video';
  return 'image';
}

async function harvestQuery(query, { webLimit = 12, imageLimit = 24 } = {}) {
  const out = [];
  try {
    const images = await searchImages(query, imageLimit);
    images.forEach((mediaUrl, i) => {
      out.push({
        sourceId: 'ddg-img-' + Buffer.from(mediaUrl).toString('base64url').slice(0, 24),
        title: `${query} (${i + 1})`,
        author: 'web',
        score: Math.max(1, imageLimit - i),
        permalink: mediaUrl,
        mediaType: guessType(mediaUrl),
        mediaUrl,
        previewUrl: mediaUrl,
        query
      });
    });
  } catch (e) {
    out._imageError = e.message;
  }

  let pages = [];
  try { pages = await searchWeb(query, webLimit); }
  catch (e) { out._webError = e.message; }

  return { items: out, pages, imageError: out._imageError, webError: out._webError };
}

function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}

module.exports = { DEFAULT_QUERIES, searchWeb, searchImages, harvestQuery, hostOf };
