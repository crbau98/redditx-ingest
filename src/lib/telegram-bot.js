'use strict';
/**
 * Telegram Bot API (token from @BotFather). A bot cannot read a channel's history
 * unless it is a member, but it can look up any *public* channel: title,
 * description (with the creator's other links) and subscriber count. PRISM uses
 * that to verify channels, enrich profiles and score discovery candidates.
 *
 * The token is part of every Bot API URL, so errors are scrubbed before they can
 * reach logs, the admin UI or the database.
 */
const config = require('../config');
const http = require('../sources/http').forPlatform('telegram-bot', 350);

const token = () => config.creds.telegramBot;
const configured = () => /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token() || '');
const scrub = (msg) => String(msg || '').split(token() || '\u0000').join('<token>').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>');

async function call(method, params) {
  if (!configured()) throw Object.assign(new Error('TELEGRAM_API_KEY is not a Bot API token (expected 123456:ABC…)'), { skip: true });
  const qs = new URLSearchParams(params).toString();
  try {
    const json = await http.json(`${config.baseUrls.telegramBot}/bot${token()}/${method}?${qs}`, { retries: 1 });
    if (!json.ok) throw new Error(json.description || 'Telegram API error');
    return json.result;
  } catch (e) {
    let detail = e.message;
    try { const b = e.body && JSON.parse(e.body); if (b && b.description) detail = b.description; } catch { /* ignore */ }
    throw Object.assign(new Error(scrub(`Telegram: ${detail}`)), { status: e.status || 0 });
  }
}

/** Public channel/group info, or null if it does not exist / is private. */
async function channelInfo(username) {
  const name = String(username).replace(/^@/, '');
  try {
    const chat = await call('getChat', { chat_id: `@${name}` });
    let members = null;
    try { members = await call('getChatMemberCount', { chat_id: `@${name}` }); } catch { /* optional */ }
    return { id: chat.id, type: chat.type, title: chat.title || null, username: chat.username || name, description: chat.description || chat.bio || null, members };
  } catch (e) {
    if (e.status === 400 || /not found|chat not found/i.test(e.message)) return null;
    throw e;
  }
}

module.exports = { configured, channelInfo, scrub, call };
