const { fetchJSON } = require('../fetch');

const DEFAULT_SUBS = [
  'gaybrosgonemild', 'boyswithabs', 'vlinesabsanddick',
  'gaynsfw', 'twinks', 'massivecocks', 'hardbodies', 'gaymuscle',
  'totallystraight', 'broslikeus', 'malepubes', 'cock',
  'gaybrosgonewild', 'bulges', 'jockstraps', 'gayporn',
  'ladybonersgw', 'mangonewild', 'otters', 'bearsgonewild'
];

function decodeAmp(s) {
  return String(s || '').replace(/&amp;/g, '&');
}

function extractFromListingPost(post) {
  const d = post.data || post;
  const item = {
    sourceId: d.id,
    title: d.title,
    author: d.author,
    subreddit: d.subreddit,
    score: d.score || 0,
    permalink: d.permalink ? ('https://reddit.com' + d.permalink) : null,
    nsfw: !!d.over_18,
    mediaType: null,
    mediaUrl: null,
    previewUrl: null,
    thumbnail: d.thumbnail
  };

  if (d.preview && d.preview.images && d.preview.images[0] && d.preview.images[0].source) {
    item.previewUrl = decodeAmp(d.preview.images[0].source.url);
  }

  const url = decodeAmp(d.url || '');

  if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url) || /i\.redd\.it\//i.test(url)) {
    item.mediaType = 'image';
    item.mediaUrl = url;
  } else if (/imgur\.com\/\w+$/i.test(url) && !/\/a\//i.test(url)) {
    item.mediaType = 'image';
    item.mediaUrl = url.replace(/\/+$/, '') + '.jpg';
  } else if (d.is_gallery && d.media_metadata) {
    const first = Object.values(d.media_metadata)[0];
    if (first && first.s) {
      item.mediaType = 'image';
      item.mediaUrl = decodeAmp(first.s.u || first.s.gif || '');
    }
  } else if (d.is_video && d.media && d.media.reddit_video) {
    item.mediaType = 'video';
    item.mediaUrl = d.media.reddit_video.fallback_url;
  } else if (/redgifs\.com|gfycat\.com/i.test(url)) {
    item.mediaType = item.previewUrl ? 'image' : 'video';
    item.mediaUrl = item.previewUrl || url;
  } else if (item.previewUrl) {
    item.mediaType = 'image';
    item.mediaUrl = item.previewUrl;
  }

  if (item.thumbnail && !String(item.thumbnail).startsWith('http')) item.thumbnail = null;
  return item;
}

async function fetchOfficial(sub, sort, limit) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/${sort}.json?limit=${limit}&raw_json=1`;
  const json = await fetchJSON(url, {
    headers: { Accept: 'application/json' }
  });
  const children = json && json.data && json.data.children;
  if (!children) return [];
  return children.map(extractFromListingPost).filter(i => i.mediaUrl);
}

async function fetchArchive(sub, limit) {
  const url = `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${encodeURIComponent(sub)}&limit=${Math.min(limit, 100)}`;
  const json = await fetchJSON(url);
  const rows = json.data || json || [];
  return rows.map(extractFromListingPost).filter(i => i.mediaUrl);
}

async function fetchSub(sub, { sort = 'hot', limit = 50 } = {}) {
  try {
    return await fetchOfficial(sub, sort, limit);
  } catch (e) {
    // Reddit's public JSON API is routinely 403 without OAuth — archive is the working path.
    const items = await fetchArchive(sub, limit);
    items._via = 'arctic-shift';
    items._officialError = e.message;
    return items;
  }
}

async function* iterateSubs(subs, opts) {
  for (const sub of subs) {
    const items = await fetchSub(sub, opts);
    yield { sub, items, via: items._via || 'reddit', officialError: items._officialError };
  }
}

module.exports = { DEFAULT_SUBS, fetchSub, iterateSubs, extractFromListingPost };
