'use strict';
/**
 * Keeps one feed per channel / group the logged-in Telegram account has joined (platform "telegram", kind "channel").
 *
 *   join a channel in the Telegram app  ->  the next sync (every TELEGRAM_SYNC_HOURS, or "Sync now" in Admin) follows it
 *   leave it                            ->  its feed is switched off (history already stored stays)
 *
 * Channels whose name or handle reads female / feminine are never followed (male-only library); with the body filter on, neither
 * are chub / gainer / dad-bod channels (skippedBody). Feeds an admin switched off or
 * edited are left alone; only brand-new channels are created.
 */
const repo = require('../db/repo');
const config = require('../config');
const events = require('../engine/events');
const mt = require('../lib/telegram-mtproto');
const { femaleCheck } = require('../lib/scope');
const physique = require('../lib/physique');
const settingsStore = require('../settings');

const KEY = 'telegram_sync';
let timer = null; let busy = false;

const targetOf = (d) => (d.username ? d.username : `id:${d.id}`);

function last() { try { return JSON.parse(repo.settings.get(KEY) || 'null'); } catch { return null; } }

/** @returns {Promise<{channels:number, created:number, switchedOff:number, skippedFemale:string[], at:string}>} */
async function sync({ autoFollow = config.telegram.autoFollow } = {}) {
  if (busy) throw Object.assign(new Error('A Telegram sync is already running'), { status: 409 });
  const conf = mt.configured();
  if (!conf.ok) throw Object.assign(new Error(conf.note), { skip: true });
  busy = true;
  try {
    const list = await mt.dialogs();
    const res = { channels: list.length, created: 0, switchedOff: 0, skippedFemale: [], skippedBody: [], at: new Date().toISOString() };
    const bodyFilter = settingsStore.get().physiqueFilter === true;
    const joined = new Set();
    for (const d of list) {
      const target = targetOf(d);
      joined.add(target.toLowerCase());
      const g = femaleCheck(d.title, d.username);
      if (g.level === 'hard') { res.skippedFemale.push(d.title); continue; }
      if (bodyFilter && physique.textCheck(d.title, d.username).heavy) { res.skippedBody.push(d.title); continue; }
      if (!autoFollow) continue;
      if (repo.blocklist.has('creator', `telegram:${target.toLowerCase()}`)) continue;
      const { created } = repo.feeds.upsert({
        platform: 'telegram', kind: 'channel', target, label: d.title, trusted: config.telegram.trustJoined ? 1 : 0,
        origin: 'telegram-sync', intervalMin: 120,
      });
      if (created) res.created++;
    }
    // channels the account left: stop polling them
    for (const f of repo.db.prepare("SELECT id, target FROM feeds WHERE platform = 'telegram' AND kind = 'channel' AND origin = 'telegram-sync' AND enabled = 1").all()) {
      if (!joined.has(String(f.target).toLowerCase())) { repo.feeds.update(f.id, { enabled: false }); res.switchedOff++; }
    }
    repo.settings.set(KEY, JSON.stringify({ ...res, skippedFemale: res.skippedFemale.slice(0, 50), skippedBody: res.skippedBody.slice(0, 50) }));
    events.log(res.created ? 'OK' : 'INFO', `Telegram sync: ${res.channels} joined channel(s), ${res.created} new feed(s)${res.switchedOff ? `, ${res.switchedOff} left` : ''}${res.skippedFemale.length ? `, ${res.skippedFemale.length} skipped (male-only)` : ''}${res.skippedBody.length ? `, ${res.skippedBody.length} skipped (body filter)` : ''}`);
    return res;
  } finally { busy = false; }
}

function status() {
  const conf = mt.configured();
  const feeds = repo.db.prepare("SELECT COUNT(*) AS n, SUM(enabled) AS on_ FROM feeds WHERE platform = 'telegram' AND kind = 'channel'").get();
  return { configured: conf.ok, note: conf.note, feeds: feeds.n || 0, enabled: feeds.on_ || 0, last: last() };
}

function start() {
  if (timer || !config.telegram.syncHours) return;
  const run = () => { if (mt.configured().ok) sync().catch((e) => events.log('WARN', `Telegram sync: ${e.message}`)); };
  setTimeout(run, 20 * 1000).unref();
  timer = setInterval(run, config.telegram.syncHours * 3600 * 1000);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; mt.shutdown().catch(() => {}); }

module.exports = { sync, status, start, stop };
