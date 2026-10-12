'use strict';
/**
 * Telegram, two ways:
 *
 *   user     a PUBLIC channel through its web preview (https://t.me/s/<name>): no login, no key, but only channels that allow
 *            the preview and only its recent window. Media stays on Telegram's CDN.
 *   channel  a channel / group the logged-in ACCOUNT has joined, public or private, read over MTProto (lib/telegram-mtproto):
 *            full history (back-filled gradually), original-size photos and videos. Telegram files cannot be hotlinked, so each
 *            kept file is copied into the object store (lib/objectstore: R2 / B2 / S3, nothing on the server) AFTER the text
 *            gates have accepted the post. Feeds for these are created by services/telegram-sync from the account's dialog list.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cheerio = require('cheerio');
const http = require('./http').forPlatform('telegram', 1500);
const { toIso, clip } = require('./util');
const { extractLinks } = require('../lib/links');
const bot = require('../lib/telegram-bot');
const mt = require('../lib/telegram-mtproto');
const store = require('../lib/objectstore');
const config = require('../config');

const bg = (style) => { const m = String(style || '').match(/url\((['"]?)(.*?)\1\)/); return m ? m[2] : null; };

function parseCount(text) {
  const m = String(text || '').trim().match(/^([\d.]+)\s*([KkMm]?)$/);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1));
}

/** HTML of one preview page -> {messages, profile}. Pure, so it is easy to test. */
function parsePage(html, channel) {
  const $ = cheerio.load(html);
  const messages = [];
  $('.tgme_widget_message[data-post]').each((_, el) => {
    const m = $(el);
    const post = m.attr('data-post') || '';
    const id = Number(post.split('/')[1]);
    if (!id) return;
    const media = [];
    m.find('.tgme_widget_message_photo_wrap').each((_, a) => {
      const url = bg($(a).attr('style'));
      if (url) media.push({ type: 'image', url, preview: url });
    });
    m.find('.tgme_widget_message_video_player, .tgme_widget_message_roundvideo_player').each((_, v) => {
      const video = $(v).find('video').attr('src');
      const thumb = bg($(v).find('.tgme_widget_message_video_thumb, .tgme_widget_message_roundvideo_thumb').attr('style'));
      const dur = $(v).find('.message_video_duration').text().trim();
      if (video) media.push({ type: 'video', url: video, preview: thumb, duration: dur ? dur.split(':').reduce((a, n) => a * 60 + Number(n), 0) : null });
    });
    if (!media.length) return;
    messages.push({
      id, media,
      text: m.find('.tgme_widget_message_text').first().text().trim(),
      date: toIso(m.find('.tgme_widget_message_date time').attr('datetime')),
      views: parseCount(m.find('.tgme_widget_message_views').first().text()),
      link: m.find('.tgme_widget_message_date').attr('href') || `https://t.me/${channel}/${id}`,
    });
  });
  const desc = $('.tgme_channel_info_description').first().text().trim();
  const hrefs = $('.tgme_channel_info_description a[href]').map((_, a) => $(a).attr('href')).get().join(' ');
  const profile = {
    displayName: $('.tgme_channel_info_header_title').first().text().trim() || null,
    bio: desc || null,
    avatarUrl: $('.tgme_page_photo_image img').attr('src') || $('.tgme_channel_info_header img').first().attr('src') || null,
    links: extractLinks(`${desc} ${hrefs}`),
  };
  const hasChannel = $('.tgme_channel_info, .tgme_header_title').length > 0 || messages.length > 0 || $('.tgme_widget_message').length > 0;
  return { messages, profile, hasChannel, minId: Math.min(...$('.tgme_widget_message[data-post]').map((_, e) => Number(($(e).attr('data-post') || '').split('/')[1]) || Infinity).get(), Infinity) };
}

function toItems(msg, channel) {
  return msg.media.map((m, i) => ({
    sourceId: `${channel}/${msg.id}`,
    position: i,
    title: clip(msg.text, 300),
    text: clip(msg.text, 400),
    author: channel,
    score: msg.views ? Math.round(msg.views / 20) : 0,
    postedAt: msg.date,
    permalink: msg.link,
    mediaType: m.type,
    mediaUrl: m.url,
    previewUrl: m.preview,
    duration: m.duration || null,
    nsfw: 'explicit',
    trusted: true,
  }));
}

/* ------------------------------------------------------------------ joined channels (MTProto) */
const chanKey = (target) => String(target).replace(/^@/, '');
const isPrivateTarget = (target) => /^id:/i.test(String(target));

/** Where a message lives on t.me. */
function permalinkOf(target, chanId, username, msgId) {
  return username ? `https://t.me/${username}/${msgId}` : `https://t.me/c/${chanId}/${msgId}`;
}

let sharpMod; // optional: small previews for photos keep the gallery light
function sharp() { if (sharpMod === undefined) { try { sharpMod = require('sharp'); } catch { sharpMod = null; } } return sharpMod; }

/**
 * One message -> an ingest item whose file is NOT downloaded yet: `materialize()` does that once the post passed the text gates,
 * `discard()` removes it again if the post is rejected later (image filter, duplicate, ...).
 */
function messageToItem(msg, d, ch) {
  const base = `tg/${ch.id}/${msg.id}`;
  const key = `${base}.${d.ext}`;
  const posterKey = `${base}-t.jpg`;
  const stored = [];
  const text = String(msg.message || '').trim();
  const item = {
    sourceId: `${ch.username || `id${ch.id}`}/${msg.id}`,
    position: 0,
    title: clip(text, 300),
    text: clip(text, 400),
    author: ch.username || `c${ch.id}`,
    authorName: ch.title || null,
    authorBio: ch.about || null,
    score: Math.round(((Number(msg.views) || 0) / 20) + (Number(msg.forwards) || 0)),
    postedAt: msg.date ? new Date(Number(msg.date) * 1000).toISOString() : null,
    permalink: permalinkOf(ch.target, ch.id, ch.username, msg.id),
    mediaType: d.type,
    mediaUrl: store.urlFor(key),
    previewUrl: null,
    width: d.width, height: d.height, duration: d.duration,
    nsfw: 'explicit',
    trusted: !!ch.trusted,
    community: ch.username || ch.title || null,
    hasAudio: d.type === 'video',
  };
  item.materialize = async (it) => {
    if (!(await store.has(key))) {
      if (d.type === 'image') {
        const buf = await mt.download(msg);
        if (!buf || !buf.length) throw new Error('empty download');
        await store.put(key, buf, d.mime); stored.push(key);
        const sh = sharp();
        if (sh) {
          try { const t = await sh(buf).rotate().resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer(); await store.put(posterKey, t, 'image/jpeg'); stored.push(posterKey); it.previewUrl = store.urlFor(posterKey); } catch { /* the original is used */ }
        }
      } else {
        const tmp = path.join(os.tmpdir(), `prism-tg-${process.pid}-${ch.id}-${msg.id}.${d.ext}`);
        try {
          await mt.download(msg, { file: tmp });
          if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error('empty download');
          await store.put(key, tmp, d.mime); stored.push(key);
        } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
        if (d.thumb) {
          try { const t = await mt.download(msg, { thumb: true }); if (Buffer.isBuffer(t) && t.length) { await store.put(posterKey, t, 'image/jpeg'); stored.push(posterKey); it.previewUrl = store.urlFor(posterKey); } } catch { /* no poster */ }
        }
      }
    } else if (await store.has(posterKey)) it.previewUrl = store.urlFor(posterKey);
    if (!it.previewUrl && d.type === 'video') it.previewUrl = null;
  };
  item.discard = async () => { while (stored.length) { try { await store.remove(stored.pop()); } catch { /* orphan: harmless */ } } };
  return item;
}

async function fetchChannel(feed, ctx) {
  const target = chanKey(feed.target);
  const cur = ctx.cursor || {};
  // Never more than the engine keeps (itemsPerRun x 4): new posts + back-fill, each at most twice `perRun` (two media filters).
  // Listing more would move the cursor past messages that are then dropped unseen.
  const perRun = Math.min(ctx.limit || 40, 200);
  const maxBackfill = config.telegram.backfillMax;
  const entity = await mt.entityOf(target);
  const ch = {
    id: String(entity.id), username: entity.username || null, title: entity.title || feed.label || target, target,
    trusted: !!feed.trusted, about: null,
  };
  let profile;
  if (ctx.needProfile || !cur.profiled) {
    try {
      const p = await mt.profile(target);
      ch.about = p.about;
      let avatarUrl = null;
      if (p.avatar) { try { const k = `tg/${ch.id}/avatar.jpg`; await store.put(k, p.avatar, 'image/jpeg'); avatarUrl = store.urlFor(k); } catch { /* no avatar */ } }
      profile = { displayName: p.title, bio: p.about, avatarUrl, links: extractLinks(p.about || '') };
    } catch (e) { if (e.skip || e.status) throw e; }
  }

  let newestId = cur.newestId || 0; let oldestId = cur.oldestId || 0; let done = !!cur.done; let backfilled = cur.backfilled || 0;
  const msgs = [];
  if (!newestId) {
    const r = await mt.messages(target, { limit: perRun });
    msgs.push(...r.list);
    if (r.list.length) { newestId = r.list[0].id; oldestId = r.list[r.list.length - 1].id; }
    done = r.exhausted;
    backfilled = r.list.length;
  } else {
    const r = await mt.messages(target, { reverse: true, minId: newestId, limit: perRun });
    msgs.push(...r.list);
    if (r.list.length) newestId = r.list[r.list.length - 1].id;
    if (!done && !ctx.aborted() && backfilled < maxBackfill) {
      const o = await mt.messages(target, { offsetId: oldestId, limit: Math.min(perRun, maxBackfill - backfilled) });
      msgs.push(...o.list);
      if (o.list.length) { oldestId = o.list[o.list.length - 1].id; backfilled += o.list.length; }
      done = o.exhausted;
    }
  }
  if (backfilled >= maxBackfill) done = true;

  const items = [];
  const skipped = {};
  for (const msg of msgs) {
    const d = mt.describeMedia(msg);
    if (!d) continue;
    if (d.skip) { skipped[d.skip] = (skipped[d.skip] || 0) + 1; continue; }
    items.push(messageToItem(msg, d, ch));
  }
  return {
    items, profile, via: 'mtproto',
    cursor: { newestId, oldestId, done, backfilled, profiled: true },
    notes: [],
    skipped,
  };
}

module.exports = {
  platform: 'telegram',
  label: 'Telegram',
  color: '#26a5e4',
  kinds: ['user', 'channel'], // user: a public channel through its web preview; channel: a channel the logged-in account joined (MTProto)
  intervalMin: { user: 240, channel: 120 },
  parsePage, toItems, parseCount, messageToItem, fetchChannel,
  isConfigured: (kind) => {
    if (kind === 'channel') {
      const c = mt.configured();
      if (!c.ok) return c;
      if (!store.kind()) return { ok: false, note: store.describe().error };
      return { ok: true, note: `${c.note} · media stored in ${store.describe().kind === 's3' ? `bucket ${store.describe().where}` : 'the data volume (set MEDIA_STORE_* for R2/B2)'}` };
    }
    return { ok: true, note: bot.configured() ? 'Public channels with web preview · bot token set (channel checks & full descriptions)' : 'Public channels with web preview enabled' };
  },

  async fetch(feed, ctx) {
    if (feed.kind === 'channel') return fetchChannel(feed, ctx);
    const channel = String(feed.target).replace(/^@/, '');
    const cursor = ctx.cursor || {};
    const items = [];
    let newestId = cursor.newestId || 0;
    let before = null;
    let profile;
    const maxPages = cursor.newestId ? 1 : 3;
    for (let page = 0; page < maxPages; page++) {
      if (ctx.aborted()) break;
      const html = await http.text(`https://t.me/s/${encodeURIComponent(channel)}${before ? `?before=${before}` : ''}`, { headers: { accept: 'text/html' }, maxBytes: 3_000_000 });
      const parsed = parsePage(html, channel);
      if (!parsed.hasChannel || (!parsed.messages.length && page === 0 && !/tgme_widget_message/.test(html))) {
        // With a bot token we can at least tell "doesn't exist" from "exists but hides its preview".
        let why = 'Channel preview unavailable (web preview disabled, restricted or not found)';
        if (bot.configured()) {
          const info = await bot.channelInfo(channel).catch(() => undefined);
          if (info === null) why = 'Telegram says this channel does not exist (or is private)';
          else if (info) why = `“${info.title || channel}” exists${info.members ? ` (${info.members.toLocaleString('en')} subscribers)` : ''} but has its public web preview turned off, so its posts cannot be read without joining`;
        }
        throw Object.assign(new Error(why), { status: 404 });
      }
      if (page === 0 && (ctx.needProfile || !cursor.newestId)) {
        profile = parsed.profile;
        // The bot API returns the full channel description (the preview truncates it) — more links to follow.
        if (bot.configured()) {
          const info = await bot.channelInfo(channel).catch(() => null);
          if (info && info.description) profile = { ...profile, bio: profile.bio || info.description, displayName: profile.displayName || info.title, links: [...(profile.links || []), ...extractLinks(info.description)] };
        }
      }
      let reachedKnown = false;
      for (const msg of parsed.messages.sort((a, b) => b.id - a.id)) {
        if (msg.id > newestId) newestId = msg.id;
        if (cursor.newestId && msg.id <= cursor.newestId && !ctx.force) { reachedKnown = true; continue; }
        items.push(...toItems(msg, channel));
      }
      if (reachedKnown || !Number.isFinite(parsed.minId)) break;
      before = parsed.minId;
    }
    return { items, cursor: newestId ? { newestId } : undefined, profile, via: 'web-preview' };
  },
};
