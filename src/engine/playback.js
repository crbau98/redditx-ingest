'use strict';
/**
 * Every video plays inside PRISM (v5 A5): stale stream links are refreshed at the source.
 *
 * RedGIFs and X hand out media links that can stop working (expired signatures, rotated CDN paths). When the media proxy
 * gets a 401/403/404/410 for such a link, it asks here for a fresh one: the item is looked up by its stored link, its
 * source is asked again (RedGIFs gif API by id, X post by id), the new link is saved on the item, and the proxy redirects
 * the player to it. The viewer sees the video start a moment later instead of an error.
 *
 * Each link is refreshed at most once per window (a dead item is not hammered), and concurrent requests for the same link
 * share one refresh.
 */
const crypto = require('crypto');
const repo = require('../db/repo');
const registry = require('../sources');
const { canonicalUrl } = require('../lib/mediaurl');
const events = require('./events');

const WINDOW_MS = 10 * 60 * 1000;
const recent = new Map(); // url -> { at, url: freshUrl|null }
const inflight = new Map();
const hostMatches = (h, d) => h === d || h.endsWith(`.${d}`);
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const q = {
  byHash: repo.db.prepare('SELECT id, platform, source_id, source_url, position, media_type, media_url, preview_url FROM media WHERE hash = ?'),
  byUrl: repo.db.prepare('SELECT id, platform, source_id, source_url, position, media_type, media_url, preview_url FROM media WHERE media_url = ? LIMIT 1'),
  save: repo.db.prepare('UPDATE media SET media_url = @media_url, preview_url = COALESCE(@preview_url, preview_url) WHERE id = @id'),
};

/** Hosts whose links we know how to refresh. */
function canRefresh(host) {
  const h = String(host || '').toLowerCase();
  return hostMatches(h, 'redgifs.com') || hostMatches(h, 'twimg.com');
}

/** RedGIFs gif id from a media link (media.redgifs.com/SomeName-mobile.mp4) or a watch page. */
function redgifsId(row) {
  for (const u of [row.source_url, row.media_url]) {
    const m = /redgifs\.com\/(?:watch|ifr)\/([A-Za-z0-9]+)/i.exec(u || '') || /media\.redgifs\.com\/([A-Za-z]+)(?:-[a-z]+)?\.(?:mp4|jpg|webm)/i.exec(u || '');
    if (m) return m[1].toLowerCase();
  }
  const s = /^redgifs-([a-z0-9]+)$/i.exec(row.source_id || '');
  return s ? s[1].toLowerCase() : null;
}

const tweetId = (row) => {
  for (const u of [row.source_url]) { const m = /(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i.exec(u || ''); if (m) return m[1]; }
  return row.platform === 'x' && /^\d+$/.test(row.source_id || '') ? row.source_id : null;
};

/** Ask the item's source for a current link. */
async function fresh(row) {
  const host = (() => { try { return new URL(row.media_url).hostname.toLowerCase(); } catch { return ''; } })();
  if (hostMatches(host, 'redgifs.com')) {
    const id = redgifsId(row);
    if (!id) return null;
    const it = await registry.get('redgifs').resolve(`https://www.redgifs.com/watch/${id}`);
    return it && it.mediaUrl ? { mediaUrl: it.mediaUrl, previewUrl: it.previewUrl || null } : null;
  }
  if (hostMatches(host, 'twimg.com')) {
    const id = tweetId(row);
    if (!id) return null;
    const items = await registry.get('x').fetchTweet(id);
    const same = items.filter((it) => it.mediaType === row.media_type);
    const it = items[row.position || 0] && items[row.position || 0].mediaType === row.media_type ? items[row.position || 0] : same[0];
    return it && it.mediaUrl ? { mediaUrl: it.mediaUrl, previewUrl: it.previewUrl || null } : null;
  }
  return null;
}

/**
 * A fresh link for a stored media link that failed, or null. Never throws.
 * @param {string} url the link the player asked for
 */
async function refresh(url) {
  const now = Date.now();
  const seen = recent.get(url);
  if (seen && now - seen.at < WINDOW_MS) return seen.url;
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    let out = null;
    try {
      const row = q.byHash.get(md5(canonicalUrl(url))) || q.byUrl.get(url);
      // The item already moved on to a newer link (the viewer's page was loaded before an earlier refresh): use that one.
      if (row && row.media_url && canonicalUrl(row.media_url) !== canonicalUrl(url)) out = row.media_url;
      else if (row) {
        const f = await fresh({ ...row, media_url: url });
        if (f && f.mediaUrl && f.mediaUrl !== url) {
          q.save.run({ id: row.id, media_url: f.mediaUrl, preview_url: f.previewUrl });
          repo.hosts.add(f.mediaUrl, f.previewUrl);
          out = f.mediaUrl;
        }
      }
    } catch (e) {
      events.log('INFO', `Playback: could not refresh a ${(() => { try { return new URL(url).hostname; } catch { return 'media'; } })()} link (${String(e.message || e).slice(0, 120)})`);
    }
    recent.set(url, { at: Date.now(), url: out });
    if (recent.size > 5000) for (const k of [...recent.keys()].slice(0, 1000)) recent.delete(k);
    return out;
  })().finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

module.exports = { canRefresh, refresh, redgifsId, _recent: recent };
