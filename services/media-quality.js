const { fetchBuffer, hostnameOf } = require('./fetch');

const BLOCKED_HOSTS = new Set([
  'shutterstock.com',
  'image.shutterstock.com',
  'gettyimages.com',
  'media.gettyimages.com',
  'istockphoto.com',
  'unsplash.com',
  'images.unsplash.com',
  'pexels.com',
  'images.pexels.com',
  'pixabay.com',
  'cdn.pixabay.com',
  'wikimedia.org',
  'upload.wikimedia.org',
  'wikipedia.org',
  'flickr.com',
  'live.staticflickr.com',
  'alamy.com',
  'c8.alamy.com',
  'dreamstime.com',
  'thumbs.dreamstime.com',
  'depositphotos.com',
  'st2.depositphotos.com',
  'adobe.com',
  'stock.adobe.com',
  'freepik.com',
  'img.freepik.com',
  'vectorstock.com',
  '123rf.com',
  'previews.123rf.com',
  'giphy.com',
  'media.giphy.com',
  'tenor.com',
  'media.tenor.com',
  'youtube.com',
  'youtu.be',
  'i.ytimg.com',
  'img.youtube.com',
  'vimeo.com',
  'i.vimeocdn.com',
  'tiktok.com',
  'google.com',
  'gstatic.com',
  'encrypted-tbn0.gstatic.com',
  'encrypted-tbn1.gstatic.com',
  'encrypted-tbn2.gstatic.com',
  'encrypted-tbn3.gstatic.com',
  'bing.com',
  'tse1.mm.bing.net',
  'tse2.mm.bing.net',
  'tse3.mm.bing.net',
  'tse4.mm.bing.net',
  'duckduckgo.com',
  'external-content.duckduckgo.com',
  'placeholder.com',
  'via.placeholder.com',
  'placehold.co',
  'placekitten.com',
  'loremflickr.com',
  'picsum.photos',
]);

const TRUSTED_HOST_SUFFIXES = [
  'i.redd.it',
  'preview.redd.it',
  'external-preview.redd.it',
  'v.redd.it',
  'redditmedia.com',
  'imgur.com',
  'redgifs.com',
  'gfycat.com',
  'twimg.com',
  'erome.com',
];

const IMAGE_MAGIC = [
  [0xff, 0xd8, 0xff],
  [0x89, 0x50, 0x4e, 0x47],
  [0x47, 0x49, 0x46, 0x38],
  [0x52, 0x49, 0x46, 0x46],
];

function hostOf(url) {
  return hostnameOf(url).replace(/^www\./, '');
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function hostBlocked(host) {
  if (!host) return true;
  for (const blocked of BLOCKED_HOSTS) {
    if (hostMatches(host, blocked.replace(/^www\./, ''))) return true;
  }
  return false;
}

function hostTrusted(host) {
  if (!host) return false;
  return TRUSTED_HOST_SUFFIXES.some((domain) => hostMatches(host, domain));
}

function looksLikeDirectMedia(url) {
  return /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4v)(\?|#|$)/i.test(url);
}

function normalizeImgur(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)imgur\.com$/i.test(parsed.hostname)) return url;
    const parts = parsed.pathname.replace(/^\/+/, '').split('/');
    const first = parts[0] || '';
    if (/^(a|gallery|t|user|r)$/i.test(first)) return null;
    const id = first.replace(/\.(gifv|mp4|webm)$/i, '');
    if (!id) return null;
    if (/\.(gifv|mp4|webm)$/i.test(parsed.pathname)) {
      return `https://i.imgur.com/${id.replace(/\.[^.]+$/, '')}.mp4`;
    }
    if (id.includes('.')) return `https://i.imgur.com/${id}`;
    return `https://i.imgur.com/${id}.jpg`;
  } catch {
    return url;
  }
}

function normalizeMediaUrl(url, type) {
  if (!url) return null;
  const imgur = normalizeImgur(url);
  if (imgur === null) return null;
  return imgur;
}

function isJunkTitle(title = '') {
  return /image you are requesting does not exist|no longer available|probably deleted|shutterstock|getty images|stock photo|royalty.?free/i.test(
    String(title),
  );
}

function classifyUrl(url) {
  const host = hostOf(url);
  if (hostBlocked(host)) return { ok: false, reason: `blocked host ${host}`, host };
  return { ok: true, host, trusted: hostTrusted(host) };
}

function magicLooksLikeMedia(buf) {
  if (!buf || buf.length < 12) return false;
  return IMAGE_MAGIC.some((sig) => sig.every((byte, i) => buf[i] === byte))
    || buf.slice(4, 8).toString('ascii') === 'ftyp';
}

function looksLikeRemovedImgur(buf) {
  if (!buf || !buf.length) return true;
  const sample = buf.toString('utf8', 0, Math.min(buf.length, 500));
  if (/image you are requesting does not exist|no longer available|probably deleted/i.test(sample)) return true;
  if (buf.length > 0 && buf.length < 2500 && !magicLooksLikeMedia(buf)) return true;
  return false;
}

function sourceNeedsProbe(url, type) {
  const host = hostOf(url);
  if (hostMatches(host, 'imgur.com')) return true;
  if (type === 'video' && (hostMatches(host, 'v.redd.it') || hostMatches(host, 'redgifs.com') || hostMatches(host, 'twimg.com'))) {
    return false;
  }
  if (hostTrusted(host) && looksLikeDirectMedia(url)) return false;
  return true;
}

async function probeMedia(url, type) {
  const normalized = normalizeMediaUrl(url, type);
  if (!normalized) return { ok: false, reason: 'unusable url' };
  const classified = classifyUrl(normalized);
  if (!classified.ok) return classified;

  if (!sourceNeedsProbe(normalized, type)) {
    return { ok: true, url: normalized };
  }

  try {
    const { buffer, status, contentType } = await fetchBuffer(normalized, {
      timeout: 12000,
      maxBytes: 2_000_000,
    });
    if (status === 404 || status === 410) return { ok: false, reason: `http ${status}` };
    if (status >= 400) return { ok: false, reason: `http ${status}` };
    const typeHeader = String(contentType || '').toLowerCase();
    if (typeHeader.includes('text/html')) return { ok: false, reason: 'html page, not media' };
    if (hostMatches(classified.host, 'imgur.com') && looksLikeRemovedImgur(buffer)) {
      return { ok: false, reason: 'deleted placeholder' };
    }
    const isVideo = type === 'video' || /video|mp4|webm/.test(typeHeader);
    if (!isVideo && !magicLooksLikeMedia(buffer) && !/image\//.test(typeHeader)) {
      return { ok: false, reason: 'not image/video bytes' };
    }
    if (!isVideo && buffer.length < 6000 && !classified.trusted) {
      return { ok: false, reason: 'file too small' };
    }
    return { ok: true, url: normalized, contentType: typeHeader };
  } catch (error) {
    if (classified.trusted && looksLikeDirectMedia(normalized)) {
      return { ok: true, url: normalized };
    }
    return { ok: false, reason: error.message };
  }
}

async function itemPassesQuality(item) {
  if (!item?.mediaUrl) return { ok: false, reason: 'missing media url' };
  if (isJunkTitle(item.title)) return { ok: false, reason: 'junk title' };
  const type = item.mediaType || item.type || 'image';
  const host = hostOf(item.mediaUrl);
  if (!hostTrusted(host) && !looksLikeDirectMedia(item.mediaUrl)) {
    return { ok: false, reason: `untrusted host ${host}` };
  }
  return probeMedia(item.mediaUrl, type);
}

function shouldHideExisting(row) {
  if (isJunkTitle(row.title)) return { hide: true, reason: 'junk title' };
  const url = row.media_url || '';
  const classified = classifyUrl(url);
  if (!classified.ok) return { hide: true, reason: classified.reason };
  const source = String(row.source_platform || '');
  if ((source === 'ddg' || source === 'web') && !classified.trusted) {
    return { hide: true, reason: 'generic web image' };
  }
  return { hide: false };
}

module.exports = {
  hostBlocked,
  hostTrusted,
  hostOf,
  normalizeMediaUrl,
  classifyUrl,
  probeMedia,
  itemPassesQuality,
  isJunkTitle,
  shouldHideExisting,
  looksLikeDirectMedia,
};
