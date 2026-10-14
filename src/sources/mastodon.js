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
const { toIso, htmlToText, clip, originOf, errorDetail } = require('./util');
const { extractLinks } = require('../lib/links');

const accountCache = new Map();

// A token only works on the server that issued it, so it is sent to the first configured instance and nowhere else
// (never leak it to arbitrary hosts named in feed targets).
function authHeaders(host) {
  const t = config.creds.mastodonToken;
  return t && String(host).toLowerCase() === String(config.mastodonInstances[0] || '').toLowerCase() ? { authorization: `Bearer ${t}` } : {};
}

const AUTH_WALL = new Set([401, 403, 422]);

/**
 * Servers can require sign-in even for public timelines/lookups (401/403/422). Say so, and say what to do,
 * instead of a bare "HTTP 401 for https://...". The result is flagged so a feed that can never work is rested
 * (skipped, retried in hours) rather than counted against the whole platform's circuit breaker.
 */
function explain(e, host) {
  if (!e || !AUTH_WALL.has(e.status)) return e;
  const first = config.mastodonInstances[0] || 'your instance';
  const hint = authHeaders(host).authorization
    ? 'the configured MASTODON_ACCESS_TOKEN was not accepted'
    : `set MASTODON_ACCESS_TOKEN (a token from an account on ${first}) and list ${first} first in MASTODON_INSTANCES, or follow servers that allow logged-out reads`;
  const err = new Error(`${host} requires sign-in for this request (HTTP ${e.status}${errorDetail(e) ? `: ${errorDetail(e)}` : ''}); ${hint}`);
  err.status = e.status; err.authWall = true;
  return err;
}

function parseStatus(status, host) {
  if (!status || status.reblog) return [];
  const acct = status.account && (status.account.acct.includes('@') ? status.account.acct : `${status.account.acct}@${host}`);
  const text = htmlToText(status.content, 500);
  // every link in the post (anchor text can hide where it points): the leak gate checks them (lib/leaks)
  const links = [...new Set([...String(status.content || '').matchAll(/href="(https?:\/\/[^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, '&')))];
  const media = (status.media_attachments || []).filter((m) => ['image', 'video', 'gifv'].includes(m.type) && m.url);
  const nsfw = status.sensitive || status.spoiler_text ? 'explicit' : 'suggestive';
  return media.map((m, i) => {
    const o = (m.meta && m.meta.original) || {};
    return {
      sourceId: `${host}:${status.id}`,
      position: i,
      links,
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
  const acct = await http.json(`${originOf(host)}/api/v1/accounts/lookup?acct=${encodeURIComponent(name)}`, { headers: authHeaders(host) });
  if (!acct || !acct.id) throw Object.assign(new Error(`Mastodon account not found: ${name}@${host}`), { status: 404 });
  accountCache.set(key, acct);
  return acct;
}

function splitTarget(target) {
  const [name, host] = String(target).split('@');
  return { name, host: (host || '').toLowerCase() };
}

async function pageTimeline(host, path, maxId) {
  const sep = path.includes('?') ? '&' : '?';
  return http.json(`${originOf(host)}${path}${sep}limit=40${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''}`, { headers: authHeaders(host) });
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
        const x = explain(e, host);
        if (x.authWall) x.skip = true; // can never work without a token: rest the feed instead of failing the platform
        throw x;
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
      const { name: rawName, host } = splitTarget(feed.target);
      const name = String(rawName || '').replace(/^#/, '');
      if (!name) throw new Error('Mastodon tag target is empty');
      // "tag@instance" pins one server; a bare tag is read from EVERY configured instance.
      const hosts = host ? [host] : config.mastodonInstances;
      for (const h of hosts) targets.push({ host: h.toLowerCase(), tag: name, path: `/api/v1/timelines/tag/${encodeURIComponent(name)}?only_media=true` });
    }

    const errors = [];
    const failed = [];
    const notes = [];
    const fail = (e, host) => { const x = explain(e, host); failed.push(x); errors.push(`${host}: ${x.message}`); };
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
      } catch (e) {
        // A Misskey-family server named as a "Mastodon" instance has no Mastodon timeline API: read its tag through its own.
        if (t.tag && e && e.status >= 400 && e.status < 500 && e.status !== 429) {
          const misskey = require('./misskey');
          let viaMisskey = null;
          if (misskey.isMisskeyFamily(await misskey.detectSoftware(t.host))) {
            try { viaMisskey = await misskey.fetch({ ...feed, platform: 'misskey', target: `${t.tag}@${t.host}` }, ctx); } catch (e2) { fail(e2, t.host); continue; }
          }
          if (viaMisskey) {
            for (const it of viaMisskey.items) items.push({ ...it, query: feed.target });
            if (viaMisskey.cursor && viaMisskey.cursor.newestAt && (!newest || viaMisskey.cursor.newestAt > newest)) newest = viaMisskey.cursor.newestAt;
            notes.push(`${t.host} runs Misskey-family software; read through its own API`);
            continue;
          }
        }
        fail(e, t.host);
      }
    }
    if (errors.length && errors.length === targets.length) {
      // Every server refused. If all of them want a login the feed is rested (skip), otherwise it counts as a failure.
      throw Object.assign(new Error(errors.join('; ')), failed.every((x) => x.authWall) ? { skip: true } : { status: targets.length === 1 ? failed[0].status : undefined });
    }
    return { items, cursor: newest ? { newestAt: newest } : undefined, profile, via: 'api', notes: [...notes, ...errors] };
  },
};
