const { fetchText } = require('../fetch');
const { hostTrusted, hostBlocked, normalizeMediaUrl, looksLikeDirectMedia } = require('../media-quality');

const DEFAULT_QUERIES = [
  'site:imgur.com gay male nsfw',
  'site:redgifs.com gay muscle',
  'site:redgifs.com twink',
  'site:i.redd.it gay',
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

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function usableCreatorUrl(url) {
  const host = hostOf(url);
  if (!host || hostBlocked(host)) return false;
  if (hostTrusted(host)) return true;
  return looksLikeDirectMedia(url);
}

function guessType(url) {
  if (/\.(mp4|webm|mov|gifv)(\?|$)/i.test(url) || /redgifs\.com/i.test(url)) return 'video';
  return 'image';
}

async function harvestQuery(query, { webLimit = 12 } = {}) {
  const out = [];
  let pages = [];
  try { pages = await searchWeb(query, webLimit); }
  catch (e) { out._webError = e.message; }

  pages.filter(usableCreatorUrl).forEach((pageUrl, i) => {
    const mediaType = guessType(pageUrl);
    const mediaUrl = normalizeMediaUrl(pageUrl, mediaType) || pageUrl;
    out.push({
      sourceId: 'ddg-' + Buffer.from(pageUrl).toString('base64url').slice(0, 24),
      title: `${query} (${i + 1})`,
      author: hostOf(pageUrl).split('.')[0] || 'web',
      score: Math.max(1, webLimit - i),
      permalink: pageUrl,
      mediaType,
      mediaUrl,
      previewUrl: mediaType === 'image' ? mediaUrl : null,
      query
    });
  });

  return { items: out, pages, webError: out._webError };
}

module.exports = { DEFAULT_QUERIES, searchWeb, harvestQuery, hostOf, usableCreatorUrl };
