'use strict';
/**
 * Misskey-family adapter: Misskey, Sharkey, Firefish, Iceshrimp, Catodon...
 * These servers federate with Mastodon but speak their own API (POST + JSON
 * bodies), and plain Misskey has no Mastodon-compatible API at all, so they
 * need their own adapter.
 *
 *   user  target "name@instance.tld"
 *   tag   target "hashtag" (queried on each configured instance) or "hashtag@instance.tld"
 *
 * Public endpoints only. Instances may require sign-in for some endpoints;
 * that is reported as an error on the feed.
 */
const config = require('../config');
const http = require('./http').forPlatform('misskey', 700);
const { toIso, clip } = require('./util');
const { extractLinks } = require('../lib/links');

const userCache = new Map();
const softwareCache = new Map();
const MISSKEY_FAMILY = /^(misskey|sharkey|firefish|calckey|foundkey|iceshrimp|catodon|cherrypick|meisskey)/i;

function api(host, endpoint, body) {
  return http.json(`https://${host}/api/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
  });
}

/** Total of all emoji reactions (Misskey's equivalent of likes). */
function reactionTotal(note) {
  if (typeof note.reactionCount === 'number') return note.reactionCount;
  return Object.values(note.reactions || {}).reduce((a, n) => a + (Number(n) || 0), 0);
}

/** One note -> media items. Pure renotes are skipped (the original author owns them). */
function parseNote(note, host) {
  if (!note || !note.id) return [];
  if (note.renote && !note.text && !(note.files || []).length) return [];
  const files = (note.files || []).filter((f) => f && f.url && /^(image|video)\//.test(f.type || ''));
  if (!files.length) return [];
  const u = note.user || {};
  const acct = u.username ? `${u.username}@${(u.host || host).toLowerCase()}` : null;
  const text = String(note.text || note.cw || '').trim();
  const tags = (note.tags || []).concat(text.match(/#[\p{L}\p{N}_]+/gu) || []);
  return files.map((f, i) => {
    const p = f.properties || {};
    const video = f.type.startsWith('video/');
    return {
      sourceId: `${host}:${note.id}`,
      position: i,
      title: clip(text, 300),
      text: clip(text, 400),
      author: acct,
      authorName: u.name || u.username,
      authorAvatar: u.avatarUrl || null,
      score: reactionTotal(note) + (note.renoteCount || 0) * 2,
      postedAt: toIso(note.createdAt),
      permalink: note.uri || note.url || `https://${host}/notes/${note.id}`,
      mediaType: video ? 'video' : 'image',
      mediaUrl: f.url,
      previewUrl: f.thumbnailUrl || null,
      width: p.width || null,
      height: p.height || null,
      altText: f.comment || null,
      tags,
      nsfw: f.isSensitive || note.cw ? 'explicit' : 'suggestive',
      hasAudio: video,
      trusted: true,
    };
  });
}

function splitTarget(target) {
  const [name, host] = String(target).replace(/^@/, '').split('@');
  return { name, host: (host || '').toLowerCase() };
}

async function showUser(host, username) {
  const key = `${username}@${host}`;
  if (userCache.has(key)) return userCache.get(key);
  const u = await api(host, 'users/show', { username, host: null });
  if (!u || !u.id) throw Object.assign(new Error('User not found'), { status: 404 });
  userCache.set(key, u);
  return u;
}

/** What server software runs on a host (via NodeInfo). Cached; null when unknown. */
async function detectSoftware(host) {
  if (softwareCache.has(host)) return softwareCache.get(host);
  let name = null;
  try {
    const wk = await http.json(`https://${host}/.well-known/nodeinfo`, { retries: 0 });
    const link = (wk.links || []).map((l) => l.href).filter(Boolean).pop();
    if (link && new URL(link).hostname === host) {
      const ni = await http.json(link, { retries: 0 });
      name = ni && ni.software && ni.software.name ? String(ni.software.name).toLowerCase() : null;
    }
  } catch { name = null; }
  softwareCache.set(host, name);
  return name;
}
const isMisskeyFamily = (software) => !!software && MISSKEY_FAMILY.test(software);

function profileOf(u) {
  const fieldText = (u.fields || []).map((f) => `${f.name || ''} ${f.value || ''}`).join(' ');
  return {
    displayName: u.name || u.username, bio: u.description || null, avatarUrl: u.avatarUrl || null, bannerUrl: u.bannerUrl || null,
    links: extractLinks(`${u.description || ''} ${fieldText}`),
  };
}

module.exports = {
  platform: 'misskey',
  label: 'Misskey',
  color: '#86b300',
  kinds: ['user', 'tag'],
  intervalMin: { user: 180, tag: 120 },
  parseNote, detectSoftware, isMisskeyFamily, splitTarget,
  isConfigured: () => ({ ok: true, note: `Instances: ${config.misskeyInstances.join(', ')}` }),

  async fetch(feed, ctx) {
    const cursor = ctx.cursor || {};
    const items = [];
    let newest = cursor.newestAt || null;
    let profile;
    const jobs = [];

    if (feed.kind === 'user') {
      const { name, host } = splitTarget(feed.target);
      if (!name || !host) throw new Error('Misskey user target must look like name@instance.tld');
      const u = await showUser(host, name);
      jobs.push({ host, endpoint: 'users/notes', body: { userId: u.id, withFiles: true, includeReplies: false, includeMyRenotes: false } });
      if (ctx.needProfile || !cursor.newestAt) profile = profileOf(u);
    } else {
      const { name, host } = splitTarget(feed.target);
      for (const h of host ? [host] : config.misskeyInstances) jobs.push({ host: h, endpoint: 'notes/search-by-tag', body: { tag: name, withFiles: true, reply: false } });
    }

    const errors = [];
    for (const job of jobs) {
      let untilId = null;
      try {
        for (let page = 0; page < (cursor.newestAt ? 2 : 4); page++) {
          if (ctx.aborted()) break;
          const notes = await api(job.host, job.endpoint, { ...job.body, limit: 40, ...(untilId ? { untilId } : {}) });
          if (!Array.isArray(notes) || !notes.length) break;
          let reachedKnown = false;
          for (const n of notes) {
            for (const it of parseNote(n, job.host)) {
              if (it.postedAt && (!newest || it.postedAt > newest)) newest = it.postedAt;
              if (cursor.newestAt && it.postedAt && it.postedAt <= cursor.newestAt && !ctx.force) { reachedKnown = true; continue; }
              items.push({ ...it, query: feed.kind === 'tag' ? feed.target : null });
            }
          }
          untilId = notes[notes.length - 1].id;
          if (reachedKnown) break;
        }
      } catch (e) { errors.push(`${job.host}: ${e.message}`); }
    }
    if (errors.length && errors.length === jobs.length) throw new Error(errors.join('; '));
    return { items, cursor: newest ? { newestAt: newest } : undefined, profile, via: 'api', notes: errors };
  },
};
