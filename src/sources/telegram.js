'use strict';
/**
 * Telegram public channels via the public web preview (https://t.me/s/<name>).
 * No login, no API key. Works only for channels that allow the web preview;
 * others return an error that is reported on the feed (and is not treated as a
 * platform-wide failure).
 */
const cheerio = require('cheerio');
const http = require('./http').forPlatform('telegram', 1500);
const { toIso, clip } = require('./util');
const { extractLinks } = require('../lib/links');

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

module.exports = {
  platform: 'telegram',
  label: 'Telegram',
  color: '#26a5e4',
  kinds: ['user'], // a channel is the account
  intervalMin: { user: 240 },
  parsePage, toItems, parseCount,
  isConfigured: () => ({ ok: true, note: 'Public channels with web preview enabled' }),

  async fetch(feed, ctx) {
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
        throw Object.assign(new Error('Channel preview unavailable (web preview disabled, restricted or not found)'), { status: 404 });
      }
      if (page === 0 && (ctx.needProfile || !cursor.newestId)) profile = parsed.profile;
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
