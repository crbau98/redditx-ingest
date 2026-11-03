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
const budget = require('../services/budget');
const config = require('../config');
const aiguard = require('../lib/aiguard');

const bg = (style) => { const m = String(style || '').match(/url\((['"]?)(.*?)\1\)/); return m ? m[2] : null; };
const absUrl = (u) => (u && u.startsWith('//') ? `https:${u}` : u || null);

function parseCount(text) {
  const clean = String(text || '').trim().replace(/[\s,\u00a0\u2009\u202f]/g, '');
  const m = clean.match(/^([\d.]+)\s*([KkMm]?)$/);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1));
}

/** Public channel username from a t.me link (https://t.me/name/123), or null for private / user links. */
function forwardHandle(href) {
  const m = /^https?:\/\/(?:www\.)?(?:t|telegram)\.me\/(?!c\/|s\/|joinchat|\+)([A-Za-z][A-Za-z0-9_]{3,31})(?:\/\d+)?\/?(?:\?.*)?$/i.exec(String(href || ''));
  if (m && /(?:_bot|bot)$/i.test(m[1])) return null;
  return m ? m[1] : null;
}

/** Where a joined-channel (MTProto) message was forwarded from: { handle, name } or null. */
function mtForward(msg) {
  const f = msg && msg.fwdFrom;
  if (!f) return null;
  let chat = null;
  try { chat = (msg.forward && (msg.forward.chat || msg.forward.sender)) || null; } catch { chat = null; }
  const handle = (chat && chat.username) || null;
  if (handle && /(?:_bot|bot)$/i.test(handle)) return null;
  const name = (chat && (chat.title || chat.firstName)) || f.fromName || null;
  return handle || name ? { handle, name } : null;
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
      const url = absUrl(bg($(a).attr('style')));
      if (url) media.push({ type: 'image', url, preview: url });
    });
    // Grouped albums render additional photo wraps under a grouped container; the
    // selector above already matches them, but document attachments (GIFs saved
    // as documents, single-image docs) only expose a thumbnail <img>.
    m.find('.tgme_widget_message_document_wrap img, .tgme_widget_message_document_thumb img, a.tgme_widget_message_document_wrap img').each((_, img) => {
      const url = absUrl($(img).attr('src') || $(img).attr('data-src'));
      if (url && /^https?:\/\//i.test(url) && !media.some((x) => x.url === url)) media.push({ type: 'image', url, preview: url });
    });
    m.find('.tgme_widget_message_video_player, .tgme_widget_message_roundvideo_player').each((_, v) => {
      const video = absUrl($(v).find('video').attr('src') || $(v).find('video').attr('data-src') || $(v).find('source').attr('src'));
      const thumb = absUrl(bg($(v).find('.tgme_widget_message_video_thumb, .tgme_widget_message_roundvideo_thumb').attr('style')) || $(v).find('img').attr('src') || null);
      const dur = $(v).find('.message_video_duration').text().trim();
      if (video) media.push({ type: 'video', url: video, preview: thumb, duration: dur ? dur.split(':').reduce((a, n) => a * 60 + Number(n), 0) : null });
      else if (thumb && !media.some((x) => x.url === thumb)) media.push({ type: 'image', url: thumb, preview: thumb });
    });
    if (!media.length) return;
    // "Forwarded from <channel>": the channel the post came from is a lead for discovery (engine followWaysIn)
    const fwd = m.find('.tgme_widget_message_forwarded_from_name').first();
    const fwdHandle = forwardHandle(fwd.attr('href'));
    messages.push({
      forwardFrom: fwd.length ? { handle: fwdHandle, name: fwd.text().trim() || null } : null,
      id, media,
      text: m.find('.tgme_widget_message_text').first().text().trim(),
      date: toIso(m.find('.tgme_widget_message_date time').attr('datetime')),
      views: parseCount(m.find('.tgme_widget_message_views').first().text()),
      link: m.find('.tgme_widget_message_date').attr('href') || `https://t.me/${channel}/${id}`,
    });
  });
  const desc = $('.tgme_channel_info_description').first().text().trim();
  aiguard.mark([desc, $('.tgme_channel_info_header_title').first().text().trim()]);
  const hrefs = $('.tgme_channel_info_description a[href]').map((_, a) => $(a).attr('href')).get().join(' ');
  const profile = {
    displayName: $('.tgme_channel_info_header_title').first().text().trim() || null,
    bio: desc || null,
    avatarUrl: absUrl($('.tgme_page_photo_image img').attr('src') || $('.tgme_channel_info_header img').first().attr('src') || null),
    links: extractLinks(`${desc} ${hrefs}`),
  };
  const hasChannel = $('.tgme_channel_info, .tgme_header_title').length > 0 || messages.length > 0 || $('.tgme_widget_message').length > 0;
  return { messages, profile, hasChannel, minId: Math.min(...$('.tgme_widget_message[data-post]').map((_, e) => Number(($(e).attr('data-post') || '').split('/')[1]) || Infinity).get(), Infinity) };
}

function toItems(msg, channel, profile) {
  aiguard.mark([msg.text, profile && profile.displayName, profile && profile.bio]);
  return msg.media.map((m, i) => ({
    sourceId: `${channel}/${msg.id}`,
    position: i,
    title: clip(msg.text, 300),
    text: clip(msg.text, 400),
    author: channel,
    authorName: (profile && profile.displayName) || null,
    authorBio: (profile && profile.bio) || null,
    community: channel,
    score: msg.views ? Math.round(msg.views / 20) : 0,
    postedAt: msg.date,
    permalink: msg.link,
    mediaType: m.type,
    mediaUrl: m.url,
    previewUrl: m.preview,
    duration: m.duration || null,
    nsfw: 'explicit',
    trusted: true,
    forwardFrom: msg.forwardFrom || null,
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
  aiguard.mark([text, ch.title, ch.about]);
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
    forwardFrom: mtForward(msg),
  };
  // stage(): fetch only the picture the image filter needs (the photo, or a video's thumbnail) and keep it in memory, so a post
  // the filter or the duplicate check rejects never costs an upload, a delete, or (for a video) the video download at all.
  let photo = null; let thumb; let staged = false;
  item.stage = async (it) => {
    if (await store.has(key)) return false; // stored by an earlier run: materialize() first, then check the stored copy
    staged = true;
    if (d.type === 'image') {
      photo = await mt.download(msg);
      if (!photo || !photo.length) throw new Error('empty download');
      it.localImage = photo;
    } else if (d.thumb) {
      // A failed thumbnail fetch leaves `thumb` undefined (not null) so materialize()
      // retries it later instead of silently dropping the poster frame forever.
      try { const t = await mt.download(msg, { thumb: true }); thumb = Buffer.isBuffer(t) && t.length ? t : undefined; } catch { thumb = undefined; }
      it.localImage = thumb;
    }
    return true;
  };
  item.materialize = async (it) => {
    if (staged || !(await store.has(key))) {
      if (d.type === 'image') {
        const buf = photo || await mt.download(msg);
        if (!buf || !buf.length) throw new Error('empty download');
        { const put = await store.put(key, buf, d.mime); stored.push(key); budget.chargeBytes('telegram', put.bytes); }
        const sh = sharp();
        if (sh) {
          try { const t = await sh(buf).rotate().resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer(); await store.put(posterKey, t, 'image/jpeg'); stored.push(posterKey); it.previewUrl = store.urlFor(posterKey); } catch { /* the original is used */ }
        }
      } else {
        const tmp = path.join(os.tmpdir(), `prism-tg-${process.pid}-${ch.id}-${msg.id}.${d.ext}`);
        try {
          await mt.download(msg, { file: tmp });
          if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) throw new Error('empty download');
          { const put = await store.put(key, tmp, d.mime); stored.push(key); budget.chargeBytes('telegram', put.bytes); }
        } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
        if (d.thumb) {
          try { const t = (thumb && thumb.length ? thumb : await mt.download(msg, { thumb: true })); if (Buffer.isBuffer(t) && t.length) { await store.put(posterKey, t, 'image/jpeg'); stored.push(posterKey); it.previewUrl = store.urlFor(posterKey); } } catch { /* no poster */ }
        }
      }
    } else if (await store.has(posterKey)) it.previewUrl = store.urlFor(posterKey);
    if (!it.previewUrl && d.type === 'video') it.previewUrl = null;
    photo = null; thumb = undefined; it.localImage = null; // a run holds all its items: do not keep their pictures alive
  };
  item.discard = async () => { photo = null; thumb = undefined; item.localImage = null; while (stored.length) { try { await store.remove(stored.pop()); } catch { /* orphan: harmless */ } } };
  return item;
}

async function fetchChannel(feed, ctx) {
  const target = chanKey(feed.target);
  const cur = ctx.cursor || {};
  const perRun = Math.min(Math.max(ctx.limit || 40, 40), 200);
  const maxBackfill = config.telegram.backfillMax;
  const entity = await mt.entityOf(target);
  const ch = {
    id: String(entity.id), username: entity.username || null, title: entity.title || feed.label || target, target,
    trusted: !!feed.trusted, about: cur.about || null,
  };
  let profile;
  if (ctx.needProfile || !cur.profiled) {
    try {
      const p = await mt.profile(target);
      ch.about = p.about || ch.about;
      aiguard.mark([p.title, p.about]);
      let avatarUrl = null;
      if (p.avatar) { try { const k = `tg/${ch.id}/avatar.jpg`; await store.put(k, p.avatar, 'image/jpeg'); avatarUrl = store.urlFor(k); } catch { /* no avatar */ } }
      profile = { displayName: p.title, bio: p.about, avatarUrl, links: extractLinks(p.about || '') };
    } catch (e) { if (e.skip || e.status) throw e; }
  }

  let newestId = cur.newestId || 0; let oldestId = cur.oldestId || 0; let done = !!cur.done; let backfilled = cur.backfilled || 0;
  const msgs = [];
  // The day's download budget (settings platformDailyMb). A batch is cut to what is left and the cursors stop at the last message
  // kept, so the rest is read on a later day instead of being skipped. Nothing is even listed once the budget is spent.
  const room = { left: budget.bytesLeft('telegram') };
  if (room.left <= 0) {
    return { items: [], profile, via: 'mtproto', cursor: { ...cur, profiled: true, ...(ch.about ? { about: String(ch.about).slice(0, 500) } : {}) }, notes: ['Telegram daily download budget reached: resumes tomorrow (Admin → Settings → platformDailyMb)'], skipped: {} };
  }
  const fit = (list) => {
    const out = [];
    for (const m of list) {
      const d = mt.describeMedia(m);
      // a photo's size is not declared in the message: assume 1.5 MB (the charge after the download uses the real size)
      const size = d && !d.skip ? (d.type === 'image' ? Math.max(Number(d.size) || 0, 1.5 * 1048576) : Number(d.size) || 0) : 0;
      if (out.length && size > room.left) break;
      if (!out.length && room.left <= 0) break;
      room.left -= size; out.push(m);
    }
    return out;
  };
  if (!newestId) {
    const r = await mt.messages(target, { limit: perRun });
    const list = fit(r.list);
    msgs.push(...list);
    if (list.length) { newestId = list[0].id; oldestId = list[list.length - 1].id; }
    done = r.exhausted && list.length === r.list.length;
    backfilled = list.length;
  } else {
    const r = await mt.messages(target, { reverse: true, minId: newestId, limit: perRun });
    const list = fit(r.list);
    msgs.push(...list);
    if (list.length) newestId = list[list.length - 1].id;
    if (!done && !ctx.aborted() && backfilled < maxBackfill && list.length === r.list.length && room.left > 0) {
      const o = await mt.messages(target, { offsetId: oldestId, limit: Math.min(perRun, maxBackfill - backfilled) });
      const older = fit(o.list);
      msgs.push(...older);
      if (older.length) { oldestId = older[older.length - 1].id; backfilled += older.length; }
      done = o.exhausted && older.length === o.list.length;
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
  // Surface skip reasons in the feed's notes (the engine stores notes[0] as
  // last_error): silently dropping oversized videos otherwise looks like success.
  const notes = Object.entries(skipped).map(([reason, n]) => `skipped ${n} ${reason}`);
  if (!done && backfilled < maxBackfill) notes.unshift(`backfilling history (${backfilled}/${maxBackfill} older messages read)`);
  return {
    items, profile, via: 'mtproto',
    cursor: { newestId, oldestId, done, backfilled, profiled: true, ...(ch.about ? { about: String(ch.about).slice(0, 500) } : {}) },
    notes,
    skipped,
  };
}

async function lookupChannel(target) {
  const channel = String(target || '').replace(/^@/, '');
  if (!channel || /(?:_bot|bot)$/i.test(channel)) return null;
  let info = null;
  if (bot.configured()) {
    info = await bot.channelInfo(channel).catch(() => null);
    if (!info) return null;
    if (info.type && info.type !== 'channel') return null;
  }
  const canCheckPreview = !config.isTest || !!process.env.TELEGRAM_WEB_BASE_URL;
  if (canCheckPreview) {
    const webBase = (config.baseUrls && config.baseUrls.telegramWeb) || 'https://t.me';
    try {
      const html = await http.text(`${webBase}/s/${encodeURIComponent(channel)}`, { headers: { accept: 'text/html' }, maxBytes: 3_000_000 });
      const parsed = parsePage(html, channel);
      if (!parsed.hasChannel || (!parsed.messages.length && !/tgme_widget_message/.test(html))) return null;
      if (!info) {
        info = {
          username: channel,
          title: (parsed.profile && parsed.profile.displayName) || channel,
          description: (parsed.profile && parsed.profile.bio) || '',
          members: 0,
        };
      }
    } catch {
      return null;
    }
  } else if (!info) {
    return null;
  }
  return info;
}

module.exports = {
  platform: 'telegram',
  label: 'Telegram',
  color: '#26a5e4',
  kinds: ['user', 'channel'], // user: a public channel through its web preview; channel: a channel the logged-in account joined (MTProto)
  intervalMin: { user: 240, channel: 120 },
  parsePage, toItems, parseCount, messageToItem, fetchChannel, forwardHandle, mtForward, lookupChannel,
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
    const webBase = (config.baseUrls && config.baseUrls.telegramWeb) || 'https://t.me';
    const cursor = ctx.cursor || {};
    const items = [];
    let newestId = cursor.newestId || 0;
    let oldestId = cursor.oldestId || 0;
    let done = !!cursor.done;
    let before = null;
    let profile;
    let pageProfile = null;
    const maxPages = cursor.newestId ? 5 : 3;
    let reachedKnown = false;
    // Incremental runs keep paging until they reach a known post: the first page
    // only holds ~20 messages, so a busy channel can publish more than a page
    // between runs (240 min interval) and the excess would otherwise be skipped.
    for (let page = 0; page < maxPages; page++) {
      if (ctx.aborted()) break;
      const html = await http.text(`${webBase}/s/${encodeURIComponent(channel)}${before ? `?before=${before}` : ''}`, { headers: { accept: 'text/html' }, maxBytes: 3_000_000 });
      const parsed = parsePage(html, channel);
      if (!parsed.hasChannel || (!parsed.messages.length && page === 0 && !/tgme_widget_message/.test(html))) {
        // With a bot token we can at least tell "doesn't exist" from "exists but hides its preview".
        let why = 'Channel preview unavailable (web preview disabled, restricted or not found): Telegram hides the public web preview of adult channels, so only a joined account (TELEGRAM_API_ID + TELEGRAM_API_HASH + login session) can read it';
        if (bot.configured()) {
          const info = await bot.channelInfo(channel).catch(() => undefined);
          if (info === null) why = 'Telegram says this channel does not exist (or is private)';
          else if (info) why = `“${info.title || channel}” exists${info.members ? ` (${info.members.toLocaleString('en')} subscribers)` : ''} but has its public web preview turned off, so its posts cannot be read without joining`;
        }
        throw Object.assign(new Error(why), { status: 404 });
      }
      if (page === 0) {
        pageProfile = parsed.profile;
        if (ctx.needProfile || !cursor.newestId) {
          profile = parsed.profile;
          // The bot API returns the full channel description (the preview truncates it) — more links to follow.
          if (bot.configured()) {
            const info = await bot.channelInfo(channel).catch(() => null);
            if (info && info.description) profile = { ...profile, bio: profile.bio || info.description, displayName: profile.displayName || info.title, links: [...(profile.links || []), ...extractLinks(info.description)] };
          }
          pageProfile = profile;
        }
      }
      let addedOnPage = 0;
      for (const msg of parsed.messages.sort((a, b) => b.id - a.id)) {
        if (before !== null && msg.id >= before) continue;
        if (msg.id > newestId) newestId = msg.id;
        if (cursor.newestId && msg.id <= cursor.newestId && !ctx.force) { reachedKnown = true; continue; }
        items.push(...toItems(msg, channel, pageProfile));
        addedOnPage++;
      }
      if (Number.isFinite(parsed.minId) && (!oldestId || parsed.minId < oldestId)) {
        oldestId = parsed.minId;
      }
      if (parsed.messages.length < 5) done = true;
      if (reachedKnown || !addedOnPage || !Number.isFinite(parsed.minId) || (before !== null && parsed.minId >= before)) break;
      before = parsed.minId;
    }

    // Backfill older history on incremental runs if channel has more messages
    if (!done && oldestId && !ctx.aborted() && cursor.newestId) {
      const backfillPages = 2;
      let bBefore = oldestId;
      for (let p = 0; p < backfillPages; p++) {
        if (ctx.aborted()) break;
        const bHtml = await http.text(`${webBase}/s/${encodeURIComponent(channel)}?before=${bBefore}`, { headers: { accept: 'text/html' }, maxBytes: 3_000_000 });
        const bParsed = parsePage(bHtml, channel);
        if (!bParsed.messages.length || !Number.isFinite(bParsed.minId) || bParsed.minId >= bBefore) {
          done = true;
          break;
        }
        for (const msg of bParsed.messages.sort((a, b) => b.id - a.id)) {
          if (msg.id >= bBefore) continue;
          items.push(...toItems(msg, channel, pageProfile));
        }
        bBefore = bParsed.minId;
        oldestId = bParsed.minId;
        if (bParsed.messages.length < 5) {
          done = true;
          break;
        }
      }
    }

    const nextCursor = newestId ? { newestId, ...(oldestId ? { oldestId } : {}), ...(done ? { done: true } : {}) } : undefined;
    return { items, cursor: nextCursor, profile, via: 'web-preview' };
  },
};
