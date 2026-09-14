const { fetchJSON } = require('../fetch');

const DEFAULT_QUERIES = [
  'gay',
  'twink',
  'muscle',
  'jock',
  'otter',
];

let cachedToken = null;
let tokenExpires = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpires) return cachedToken;
  const json = await fetchJSON('https://api.redgifs.com/v2/auth/temporary', {
    headers: { Origin: 'https://www.redgifs.com' },
  });
  cachedToken = json.token;
  tokenExpires = Date.now() + 50 * 60 * 1000;
  if (!cachedToken) throw new Error('RedGIFs auth failed');
  return cachedToken;
}

async function redgifsJSON(path) {
  const token = await getToken();
  return fetchJSON(`https://api.redgifs.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Origin: 'https://www.redgifs.com' },
  });
}

function gifIdFromUrl(url) {
  const m = String(url).match(/redgifs\.com\/(?:watch\/|ifr\/|embed\/)?([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

const SKIP_TAGS = /pussy|boobs|busty|lesbian|milf|\bfemale\b|\bwomen\b|\bgirl\b|\btits\b|\bbreasts\b/i;
const KEEP_TAGS = /gay|twink|jock|cock|male|man|boy|otter|bear|muscle|onlyfans.?male|dl|bro/i;

function gifLooksMale(gif, query) {
  const blob = `${(gif.tags || []).join(' ')} ${gif.userName || ''} ${query || ''}`;
  if (SKIP_TAGS.test(blob) && !KEEP_TAGS.test(blob)) return false;
  if (SKIP_TAGS.test(blob) && /busty|pussy|lesbian|milf|boobs/.test(blob) && !/gay|cock|twink|male/.test(blob)) return false;
  return true;
}

function itemFromGif(gif, query) {
  if (!gif || !gif.urls) return null;
  if (!gifLooksMale(gif, query)) return null;
  const mediaUrl = gif.urls.hd || gif.urls.sd || gif.urls.silent;
  if (!mediaUrl) return null;
  return {
    sourceId: `redgifs-${gif.id}`,
    title: (gif.tags && gif.tags.slice(0, 4).join(' ')) || query || gif.id,
    author: gif.userName || 'redgifs',
    score: gif.likes || 0,
    permalink: `https://www.redgifs.com/watch/${gif.id}`,
    mediaType: 'video',
    mediaUrl,
    previewUrl: gif.urls.poster || gif.urls.thumbnail || null,
    query,
  };
}

async function resolveUrl(url) {
  const id = gifIdFromUrl(url);
  if (!id) return null;
  try {
    const json = await redgifsJSON(`/v2/gifs/${encodeURIComponent(id)}`);
    return itemFromGif(json.gif || json, id);
  } catch {
    return null;
  }
}

async function harvestQuery(query, { limit = 24 } = {}) {
  const json = await redgifsJSON(
    `/v2/gifs/search?search_text=${encodeURIComponent(query)}&count=${Math.min(limit, 80)}&order=trending`,
  );
  const gifs = json.gifs || [];
  return {
    items: gifs.map((gif) => itemFromGif(gif, query)).filter(Boolean),
  };
}

module.exports = { DEFAULT_QUERIES, harvestQuery, resolveUrl, gifIdFromUrl };
