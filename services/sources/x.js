const { fetchJSON } = require('../fetch');
const { searchWeb } = require('./ddg');

const DEFAULT_QUERIES = [
  'site:x.com/status gay muscle',
  'site:x.com gay muscle nsfw',
  'site:x.com/status gay twink',
  'site:x.com gay jock nsfw',
  'site:twitter.com gay male nsfw',
  'site:twitter.com gay otter',
  'site:x.com onlyfans gay male',
  'site:x.com onlyfans twink gay',
  'site:twitter.com onlyfans gay nsfw',
];

function tweetIdFromUrl(url) {
  const m = String(url).match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i);
  return m ? m[1] : null;
}

function handleFromUrl(url) {
  const m = String(url).match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)/i);
  if (!m) return null;
  const skip = new Set(['i', 'intent', 'share', 'search', 'hashtag', 'home', 'explore']);
  return skip.has(m[1].toLowerCase()) ? null : m[1];
}

async function officialSearch(query, limit) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return [];
  const url = `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query + ' has:media -is:retweet')}&max_results=${Math.min(Math.max(limit, 10), 100)}&expansions=attachments.media_keys,author_id&media.fields=url,preview_image_url,type,variants&user.fields=username,name`;
  const json = await fetchJSON(url, { headers: { Authorization: `Bearer ${token}` } });
  const users = {};
  (json.includes && json.includes.users || []).forEach(u => { users[u.id] = u; });
  const media = {};
  (json.includes && json.includes.media || []).forEach(m => { media[m.media_key] = m; });
  const items = [];
  for (const t of json.data || []) {
    const keys = (t.attachments && t.attachments.media_keys) || [];
    const user = users[t.author_id] || {};
    for (const key of keys) {
      const m = media[key];
      if (!m) continue;
      let mediaUrl = m.url;
      if (m.type === 'video' || m.type === 'animated_gif') {
        const vars = m.variants || [];
        const mp4 = vars.filter(v => v.content_type === 'video/mp4').sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
        mediaUrl = mp4 ? mp4.url : m.preview_image_url;
      }
      if (!mediaUrl) continue;
      items.push({
        sourceId: t.id + '-' + key,
        title: t.text || `@${user.username}`,
        author: user.username || 'x',
        score: 0,
        permalink: `https://x.com/${user.username || 'i'}/status/${t.id}`,
        mediaType: m.type === 'video' || m.type === 'animated_gif' ? 'video' : 'image',
        mediaUrl,
        previewUrl: m.preview_image_url || mediaUrl,
        query
      });
    }
  }
  return items;
}

async function fetchTweet(id) {
  const json = await fetchJSON('https://api.fxtwitter.com/status/' + id);
  const t = json.tweet;
  if (!t) return [];
  const author = (t.author && (t.author.screen_name || t.author.name)) || 'x';
  const mediaList = (t.media && (t.media.all || t.media.photos || t.media.videos)) || [];
  return mediaList.map((m, i) => {
    const mediaUrl = m.url || m.thumbnail_url;
    if (!mediaUrl) return null;
    const isVideo = m.type === 'video' || m.type === 'gif';
    return {
      sourceId: `x-${t.id}-${i}`,
      title: (t.text || '').slice(0, 160) || `@${author} on X`,
      author,
      score: t.likes || 0,
      permalink: t.url || `https://x.com/${author}/status/${t.id}`,
      mediaType: isVideo ? 'video' : 'image',
      mediaUrl,
      previewUrl: m.thumbnail_url || mediaUrl,
      query: 'x'
    };
  }).filter(Boolean);
}

async function harvestQuery(query, { limit = 20 } = {}) {
  const items = [];
  try {
    const official = await officialSearch(query.replace(/^site:\S+\s*/i, ''), limit);
    items.push(...official);
  } catch (e) {
    items._officialError = e.message;
  }

  let pages = [];
  try { pages = await searchWeb(query, limit); }
  catch (e) { items._webError = e.message; }

  const seen = new Set();
  for (const page of pages) {
    const id = tweetIdFromUrl(page);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    try {
      items.push(...await fetchTweet(id));
    } catch { /* tweet may be private / deleted */ }
  }

  return { items, pages, officialError: items._officialError, webError: items._webError };
}

module.exports = { DEFAULT_QUERIES, harvestQuery, tweetIdFromUrl, handleFromUrl };
