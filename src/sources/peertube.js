'use strict';
/**
 * PeerTube adapter (the federated video platform). Public API only, no login.
 *
 *   user     target "account@instance.tld"   everything an account (the person) published
 *   channel  target "channel@instance.tld"   one channel
 *   tag      target "tag" (queried on every PEERTUBE_INSTANCES server) or "tag@instance.tld"
 *   search   target "free text"              keyword search over the federated search index
 *                                            (Sepia Search by default, see PEERTUBE_SEARCH_URL)
 *
 * `user`/`channel` are creator-owned (trusted). `tag`/`search` are open searches: untrusted, so every
 * item has to read male-focused (lib/scope) before it is published.
 *
 * The listing endpoints do not carry file URLs, so each new video costs one extra `GET /api/v1/videos/<id>`
 * (capped per run). Videos are returned as a progressive MP4 (largest rendition up to 1080p) when the
 * server offers one, otherwise as the HLS playlist.
 */
const config = require('../config');
const http = require('./http').forPlatform('peertube', 600);
const { toIso, clip, originOf } = require('./util');
const { extractLinks } = require('../lib/links');

const PAGE = 40;
const DETAIL_CONCURRENCY = 4;
const MAX_DETAILS = 60;      // detail lookups (= videos) per run
const MAX_HEIGHT = 1080;

const lc = (s) => String(s || '').toLowerCase();
const hostOfUrl = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return null; } };
const absolute = (host, p) => {
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  return p.startsWith('/') ? `${originOf(host)}${p}` : null;
};

/** "name@host" -> {name, host}. The host is lower-cased; PeerTube handles are case-insensitive. */
function splitHandle(target) {
  const t = String(target || '').trim().replace(/^@/, '');
  const i = t.lastIndexOf('@');
  if (i < 0) return { name: t, host: '' };
  return { name: t.slice(0, i), host: lc(t.slice(i + 1)) };
}

/** Avatars are `avatars: [{width, path}]` on PeerTube >= 6 and `avatar: {path}` before. Prefer ~120px. */
function avatarOf(entity, host) {
  if (!entity) return null;
  const list = Array.isArray(entity.avatars) && entity.avatars.length ? entity.avatars : (entity.avatar ? [entity.avatar] : []);
  if (!list.length) return null;
  const sorted = list.filter((a) => a && (a.path || a.url)).sort((a, b) => (a.width || 0) - (b.width || 0));
  const pick = sorted.find((a) => (a.width || 0) >= 120) || sorted[sorted.length - 1];
  return pick ? absolute(host, pick.url || pick.path) : null;
}

/**
 * Choose what to play from a video's detail document:
 *   1. the largest progressive MP4 up to 1080p (or the smallest above it when nothing smaller exists),
 *   2. otherwise the HLS master playlist.
 * Audio-only renditions (resolution 0) are ignored.
 */
function pickMedia(detail, host) {
  const files = [];
  for (const f of detail.files || []) {
    const h = f && f.resolution ? Number(f.resolution.id) : 0;
    const url = f && absolute(host, f.fileUrl);
    if (url && h > 0) files.push({ url, height: h, width: f.width || null, hasAudio: f.hasAudio !== false });
  }
  const within = files.filter((f) => f.height <= MAX_HEIGHT).sort((a, b) => b.height - a.height);
  const above = files.filter((f) => f.height > MAX_HEIGHT).sort((a, b) => a.height - b.height);
  const best = within[0] || above[0];
  if (best) return { kind: 'mp4', ...best };

  const playlist = (detail.streamingPlaylists || []).find((p) => p && p.playlistUrl);
  if (playlist) {
    const top = (playlist.files || []).map((f) => Number(f && f.resolution && f.resolution.id) || 0).filter((h) => h > 0).sort((a, b) => b - a)[0];
    const widths = (playlist.files || []).find((f) => f && f.resolution && Number(f.resolution.id) === top);
    return { kind: 'hls', url: absolute(host, playlist.playlistUrl), height: top || null, width: (widths && widths.width) || null, hasAudio: true };
  }
  return null;
}

/**
 * One listing entry (+ its detail document) -> an ingest item, or null when it cannot be played.
 * `listHost` is the server the listing came from (used to resolve relative paths).
 */
function parseVideo(video, detail, listHost) {
  if (!video || !detail || video.isLive || detail.isLive) return null;
  const uuid = video.uuid || detail.uuid;
  if (!uuid) return null;
  const detailHost = lc(detail.__host || listHost);
  const media = pickMedia(detail, detailHost);
  if (!media || !media.url) return null;

  const acc = video.account || detail.account || {};
  const chan = video.channel || detail.channel || {};
  const accHost = lc(acc.host || listHost);
  const author = acc.name ? `${lc(acc.name)}@${accHost}` : null;
  const watchUrl = video.url && /^https?:/i.test(video.url) ? video.url : `https://${accHost}/videos/watch/${uuid}`;
  const title = String(video.name || detail.name || '').trim();
  const description = String(detail.description || video.description || '').trim();
  // The channel title is part of what a viewer reads (and what the safety gate must see); the default
  // "<account>_channel" name only repeats the account.
  const community = chan.displayName && chan.displayName !== acc.displayName ? clip(chan.displayName, 80) : null;
  const aspect = Number(detail.aspectRatio) || null;
  const height = media.height || null;
  const width = media.width || (height && aspect ? Math.round(height * aspect) : null);
  const views = Number(video.views || detail.views) || 0;
  const likes = Number(video.likes || detail.likes) || 0;

  return {
    sourceId: String(uuid),
    position: 0,
    title: clip(title, 300),
    text: clip(description, 400),
    author,
    authorName: acc.displayName || acc.name || null,
    authorAvatar: avatarOf(acc, accHost) || avatarOf(video.account, listHost),
    community,
    score: likes + Math.round(views / 50),
    postedAt: toIso(video.publishedAt || detail.publishedAt),
    permalink: watchUrl,
    mediaType: 'video',
    mediaUrl: media.url,
    hlsUrl: media.kind === 'hls' ? media.url : null,
    previewUrl: absolute(detailHost, video.previewPath || detail.previewPath) || video.previewUrl || video.thumbnailUrl || absolute(detailHost, video.thumbnailPath) || null,
    thumbnailUrl: video.thumbnailUrl || absolute(detailHost, video.thumbnailPath || detail.thumbnailPath) || null,
    width,
    height,
    duration: Number(video.duration || detail.duration) || null,
    hasAudio: media.hasAudio,
    tags: (detail.tags || video.tags || []).map(String),
    nsfw: video.nsfw || detail.nsfw ? 'explicit' : 'suggestive',
    trusted: true, // the file URL comes from the server's own API
  };
}

function listUrl(base, path, params) {
  const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${base}${path}?${q}`;
}

/** The server-side jobs a feed expands to: one per instance for tags, one for the search index, one for a handle. */
function jobsFor(feed) {
  const kind = feed.kind === 'account' ? 'user' : feed.kind;
  const target = String(feed.target || '').trim();
  if (kind === 'search') {
    if (!target) throw new Error('PeerTube search needs some text');
    return [{ base: config.peertubeSearchUrl, path: '/api/v1/search/videos', params: { search: target, nsfw: 'true' }, index: true }];
  }
  if (kind === 'tag') {
    const { name, host } = splitHandle(target.replace(/^#/, ''));
    if (!name) throw new Error('PeerTube tag feed needs a tag');
    return (host ? [host] : config.peertubeInstances).map((h) => ({ base: originOf(h), host: h, path: '/api/v1/videos', params: { tagsOneOf: name, nsfw: 'true' } }));
  }
  const { name, host } = splitHandle(target);
  if (!name || !host) throw new Error(`PeerTube ${kind} target must look like name@instance.tld`);
  const root = kind === 'channel' ? 'video-channels' : 'accounts';
  return [{ base: originOf(host), host, path: `/api/v1/${root}/${encodeURIComponent(`${name}@${host}`)}/videos`, params: { nsfw: 'both' }, owner: { root, name, host } }];
}

async function profileOf(job) {
  const o = job.owner;
  const d = await http.json(`${job.base}/api/v1/${o.root}/${encodeURIComponent(`${o.name}@${o.host}`)}`);
  const banner = Array.isArray(d.banners) && d.banners.length ? d.banners[d.banners.length - 1] : d.banner;
  const text = `${d.description || ''} ${d.support || ''}`;
  return {
    displayName: d.displayName || d.name, bio: d.description ? clip(d.description, 500) : null, avatarUrl: avatarOf(d, o.host),
    bannerUrl: banner ? absolute(o.host, banner.path || banner.url) : null, links: extractLinks(text),
  };
}

module.exports = {
  platform: 'peertube',
  label: 'PeerTube',
  color: '#f1680d',
  kinds: ['user', 'channel', 'tag', 'search'],
  intervalMin: { user: 240, channel: 240, tag: 180, search: 180 },
  parseVideo, pickMedia, splitHandle, jobsFor,
  isConfigured: () => ({ ok: true, note: `Instances: ${config.peertubeInstances.join(', ')} · search: ${config.peertubeSearchUrl}` }),

  async fetch(feed, ctx) {
    const cursor = ctx.cursor || {};
    const jobs = jobsFor(feed);
    const open = feed.kind === 'tag' || feed.kind === 'search';
    const errors = [];
    const fresh = new Map(); // uuid -> {video, host}
    let newest = cursor.newestAt || null;
    let profile;

    for (const job of jobs) {
      try {
        for (let page = 0; page < (cursor.newestAt ? 2 : 3); page++) {
          if (ctx.aborted()) break;
          const json = await http.json(listUrl(job.base, job.path, { ...job.params, sort: '-publishedAt', count: PAGE, start: page * PAGE }));
          const rows = Array.isArray(json && json.data) ? json.data : [];
          if (!rows.length) break;
          let reachedKnown = false;
          for (const v of rows) {
            if (!v || !v.uuid) continue;
            const at = toIso(v.publishedAt);
            if (at && (!newest || at > newest)) newest = at;
            if (cursor.newestAt && at && at <= cursor.newestAt && !ctx.force) { reachedKnown = true; continue; }
            if (!fresh.has(v.uuid)) fresh.set(v.uuid, { video: v, host: job.index ? (hostOfUrl(v.url) || lc(v.account && v.account.host)) : job.host });
          }
          if (reachedKnown || rows.length < PAGE) break;
        }
        if (job.owner && (ctx.needProfile || !cursor.newestAt) && !profile) {
          try { profile = await profileOf(job); } catch { /* the profile is a bonus */ }
        }
      } catch (e) { errors.push(`${job.host || hostOfUrl(job.base)}: ${e.message}`); }
    }
    if (errors.length && errors.length === jobs.length) throw new Error(errors.join('; '));

    const items = [];
    const cap = Math.min(ctx.limit || 40, MAX_DETAILS);
    const queue = [];
    for (const entry of fresh.values()) { if (queue.length >= cap) break; if (entry.host) queue.push(entry); }
    // detail documents are independent requests: a few at a time (net.js still spaces calls per host)
    let next = 0;
    const lookup = async () => {
      while (next < queue.length && !ctx.aborted()) {
        const { video, host } = queue[next++];
        try {
          const detail = await http.json(`${originOf(host)}/api/v1/videos/${encodeURIComponent(video.uuid)}`, { minIntervalMs: 250 });
          const it = parseVideo(video, { ...detail, __host: host }, host);
          if (it) items.push({ ...it, query: open ? feed.target : null });
        } catch (e) { if (errors.length < 5) errors.push(`${host}/${video.uuid}: ${e.message}`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, queue.length) }, lookup));
    return { items, cursor: newest ? { newestAt: newest } : undefined, profile, via: 'api', notes: errors };
  },
};
