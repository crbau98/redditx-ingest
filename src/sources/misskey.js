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
const { toIso, clip, originOf, errorDetail, repostsOn } = require('./util');
const { looksLikeDirectMedia, looksLikeVideo } = require('../lib/mediaurl');
const { extractLinks } = require('../lib/links');

const userCache = new Map();
const softwareCache = new Map();
const MISSKEY_FAMILY = /^(misskey|sharkey|firefish|calckey|foundkey|iceshrimp|catodon|cherrypick|meisskey)/i;

// Optional access token (MISSKEY_ACCESS_TOKEN) for servers that hide notes from signed-out readers. A token only
// works on the server that issued it, so it goes to the first configured instance and nowhere else.
const tokenFor = (host) => {
  const t = config.creds.misskeyToken || process.env.MISSKEY_ACCESS_TOKEN || '';
  return t && String(host).toLowerCase() === String(config.misskeyInstances[0] || '').toLowerCase() ? t : '';
};

async function api(host, endpoint, body) {
  const token = tokenFor(host);
  const payload = JSON.stringify(token ? { ...body, i: token } : body);
  try {
    return await http.json(`${originOf(host)}/api/${endpoint}`, {
      // Explicit length: some reverse proxies in front of Misskey reject chunked request bodies.
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(payload) }, body: payload,
    });
  } catch (e) {
    // 401 CREDENTIAL_REQUIRED / 403 (role or instance policy): the server wants a login even for public reads.
    if (e && (e.status === 401 || e.status === 403)) {
      const err = new Error(`${host} requires sign-in for ${endpoint} (HTTP ${e.status}${errorDetail(e) ? `: ${errorDetail(e)}` : ''}); ${token ? 'the configured MISSKEY_ACCESS_TOKEN was not accepted' : `set MISSKEY_ACCESS_TOKEN (an access token from ${config.misskeyInstances[0] || 'your instance'}) or choose servers that allow signed-out reads`}`);
      err.status = e.status; err.skip = true;
      throw err;
    }
    throw e;
  }
}

/** Total of all emoji reactions (Misskey's equivalent of likes). */
function reactionTotal(note) {
  if (typeof note.reactionCount === 'number') return note.reactionCount;
  return Object.values(note.reactions || {}).reduce((a, n) => a + (Number(n) || 0), 0);
}

/**
 * One note -> media items. A pure renote (no text or files of its own) carries someone else's note: with reposts on it is
 * kept, credited to the original author (`repostOf.via` = the renoter), and ordered by the renote time.
 */
function parseNote(note, host) {
  if (!note || !note.id) return [];
  if (note.renote && !note.text && !(note.files || []).length) {
    if (!repostsOn()) return [];
    const r = note.user || {};
    const via = r.username ? `${r.username}@${(r.host || host).toLowerCase()}` : null;
    const items = parseNote(note.renote, host);
    if (!items.length || !via || items[0].author === via) return [];
    return items.map((it) => ({ ...it, repostOf: { platform: 'misskey', handle: it.author, via }, cursorAt: toIso(note.createdAt) || it.postedAt }));
  }
  // Misskey reports a MIME type per file; very old/odd uploads say application/octet-stream, so fall back to the extension.
  const kindOfFile = (f) => {
    const t = String(f.type || '');
    if (/^video\//i.test(t)) return 'video';
    if (/^image\//i.test(t)) return 'image';
    if (/^application\/octet-stream$/i.test(t) && looksLikeDirectMedia(f.name || f.url)) return looksLikeVideo(f.name || f.url) ? 'video' : 'image';
    return null;
  };
  const files = (note.files || []).filter((f) => f && f.url && kindOfFile(f));
  if (!files.length) return [];
  const u = note.user || {};
  const acct = u.username ? `${u.username}@${(u.host || host).toLowerCase()}` : null;
  const text = String(note.text || note.cw || '').trim();
  const tags = (note.tags || []).concat(text.match(/#[\p{L}\p{N}_]+/gu) || []);
  return files.map((f, i) => {
    const p = f.properties || {};
    const video = kindOfFile(f) === 'video';
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
  const hit = softwareCache.get(host);
  if (hit && (hit.name || hit.until > Date.now())) return hit.name;
  let name = null;
  try {
    const wk = await http.json(`${originOf(host)}/.well-known/nodeinfo`, { retries: 0 });
    const link = (wk.links || []).map((l) => l.href).filter(Boolean).pop();
    // Only follow a NodeInfo link on the same host (it is attacker-controlled data).
    if (link && new URL(link).host.toLowerCase() === String(host).toLowerCase()) {
      const ni = await http.json(link, { retries: 0 });
      name = ni && ni.software && ni.software.name ? String(ni.software.name).toLowerCase() : null;
    }
  } catch { name = null; }
  // Remember a positive answer for good, a failed detection only briefly (a blip must not pin a server to "unknown").
  softwareCache.set(host, { name, until: Date.now() + 10 * 60 * 1000 });
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
      jobs.push({ host, endpoint: 'users/notes', body: { userId: u.id, withFiles: true, includeReplies: false, includeMyRenotes: repostsOn() } });
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
              const at = it.cursorAt || it.postedAt; // a renote is new when it was renoted
              if (at && (!newest || at > newest)) newest = at;
              if (cursor.newestAt && at && at <= cursor.newestAt && !ctx.force) { reachedKnown = true; continue; }
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
