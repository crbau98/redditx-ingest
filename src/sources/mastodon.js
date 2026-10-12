'use strict';
/**
 * Mastodon / fediverse adapter (works with any Mastodon-API-compatible server:
 * Mastodon, Pixelfed, Akkoma, GoToSocial...). Public endpoints only.
 *
 *   user  target "name@instance.tld"
 *   tag   target "hashtag" (queried on each configured instance) or "hashtag@instance.tld"
 *
 * Many instances disable unauthenticated public timelines; those answer 401/422
 * and are reported as an error on that feed rather than silently skipped.
 */
const config = require('../config');
const http = require('./http').forPlatform('mastodon', 600);
const { toIso, htmlToText, clip } = require('./util');
const { extractLinks } = require('../lib/links');

const accountCache = new Map();

function authHeaders(host) {
  const t = config.creds.mastodonToken;
  return t && host === config.mastodonInstances[0] ? { authorization: `Bearer ${t}` } : {};
}

function parseStatus(status, host) {
  if (!status || status.reblog) return [];
  const acct = status.account && (status.account.acct.includes('@') ? status.account.acct : `${status.account.acct}@${host}`);
  const text = htmlToText(status.content, 500);
  const media = (status.media_attachments || []).filter((m) => ['image', 'video', 'gifv'].includes(m.type) && m.url);
  const nsfw = status.sensitive || status.spoiler_text ? 'explicit' : 'suggestive';
  return media.map((m, i) => {
    const o = (m.meta && m.meta.original) || {};
    return {
      sourceId: `${host}:${status.id}`,
      position: i,
      title: clip(text || status.spoiler_text || '', 300),
      text,
      author: acct,
      authorName: status.account && status.account.display_name,
      authorAvatar: status.account && status.account.avatar,
      score: (status.favourites_count || 0) + (status.reblogs_count || 0) * 2,
      postedAt: toIso(status.created_at),
      permalink: status.url || status.uri,
      mediaType: m.type === 'image' ? 'image' : 'video',
      mediaUrl: m.url,
      previewUrl: m.preview_url || null,
      width: o.width || null,
      height: o.height || null,
      duration: o.duration || null,
      altText: m.description || null,
      tags: (status.tags || []).map((t) => t.name),
      nsfw,
      hasAudio: m.type === 'video',
      trusted: true,
    };
  });
}

async function lookup(host, name) {
  const key = `${name}@${host}`;
  if (accountCache.has(key)) return accountCache.get(key);
  const acct = await http.json(`https://${host}/api/v1/accounts/lookup?acct=${encodeURIComponent(name)}`, { headers: authHeaders(host) });
  accountCache.set(key, acct);
  return acct;
}

function splitTarget(target) {
  const [name, host] = String(target).split('@');
  return { name, host: (host || '').toLowerCase() };
}

async function pageTimeline(host, path, maxId) {
  const sep = path.includes('?') ? '&' : '?';
  return http.json(`https://${host}${path}${sep}limit=40${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''}`, { headers: authHeaders(host) });
}

module.exports = {
  platform: 'mastodon',
  label: 'Mastodon',
  color: '#6364ff',
  kinds: ['user', 'tag'],
  intervalMin: { user: 180, tag: 120 },
  parseStatus,
  isConfigured: () => ({ ok: true, note: `Instances: ${config.mastodonInstances.join(', ')}` }),

  async fetch(feed, ctx) {
    const cursor = ctx.cursor || {};
    const items = [];
    let newest = cursor.newestAt || null;
    let profile;

    const targets = [];
    if (feed.kind === 'user') {
      const { name, host } = splitTarget(feed.target);
      if (!name || !host) throw new Error('Mastodon user target must look like name@instance.tld');
      let acct;
      try { acct = await lookup(host, name); } catch (e) {
        // Misskey-family servers (Misskey, Sharkey, Firefish...) look like Mastodon from the outside but
        // have their own API. Read them through it instead of failing the feed.
        const misskey = require('./misskey');
        if (misskey.isMisskeyFamily(await misskey.detectSoftware(host))) {
          const r = await misskey.fetch(feed, ctx);
          return { ...r, via: 'misskey-api', notes: [...(r.notes || []), `${host} runs Misskey-family software; read through its own API`] };
        }
        throw e;
      }
      targets.push({ host, path: `/api/v1/accounts/${acct.id}/statuses?only_media=true&exclude_reblogs=true&exclude_replies=true` });
      if (ctx.needProfile || !cursor.newestAt) {
        const note = htmlToText(acct.note || '', 500);
        const fieldLinks = (acct.fields || []).flatMap((f) => extractLinks(`${htmlToText(f.value || '', 300)} ${(String(f.value).match(/href="([^"]+)"/g) || []).join(' ').replace(/href="|"/g, ' ')}`));
        profile = {
          displayName: acct.display_name || acct.username, bio: note, avatarUrl: acct.avatar, bannerUrl: acct.header,
          links: [...extractLinks(`${note} ${(String(acct.note).match(/href="([^"]+)"/g) || []).join(' ').replace(/href="|"/g, ' ')}`), ...fieldLinks],
        };
      }
    } else {
      const { name, host } = splitTarget(feed.target);
      const hosts = host ? [host] : config.mastodonInstances;
      for (const h of hosts) targets.push({ host: h, path: `/api/v1/timelines/tag/${encodeURIComponent(name)}?only_media=true` });
    }

    const errors = [];
    for (const t of targets) {
      let maxId = null;
      try {
        for (let page = 0; page < (cursor.newestAt ? 2 : 4); page++) {
          if (ctx.aborted()) break;
          const statuses = await pageTimeline(t.host, t.path, maxId);
          if (!Array.isArray(statuses) || !statuses.length) break;
          let reachedKnown = false;
          for (const s of statuses) {
            for (const it of parseStatus(s, t.host)) {
              if (it.postedAt && (!newest || it.postedAt > newest)) newest = it.postedAt;
              if (cursor.newestAt && it.postedAt && it.postedAt <= cursor.newestAt && !ctx.force) { reachedKnown = true; continue; }
              items.push({ ...it, query: feed.kind === 'tag' ? feed.target : null });
            }
          }
          maxId = statuses[statuses.length - 1].id;
          if (reachedKnown) break;
        }
      } catch (e) { errors.push(`${t.host}: ${e.message}`); }
    }
    if (errors.length && errors.length === targets.length) throw new Error(errors.join('; '));
    return { items, cursor: newest ? { newestAt: newest } : undefined, profile, via: 'api', notes: errors };
  },
};
