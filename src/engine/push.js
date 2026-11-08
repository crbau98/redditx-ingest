'use strict';
/**
 * Push alert poller. Every few minutes it looks at each browser subscription, asks the media table
 * whether a watched creator has published since the last check, and sends ONE summary notification.
 * It stores no media and keeps no per-item queue: the row is the cursor, so a restart loses nothing.
 *
 * The job is deliberately quiet: one notification per subscription per tick, newest creator first,
 * and an endpoint that answers 404/410 is disabled instead of retried forever.
 */
const repo = require('../db/repo');
const webpush = require('../lib/webpush');

const TICK_MS = 3 * 60 * 1000;
const MAX_SUBS = 200;
let timer = null;
let running = false;

const sinceOf = (sub) => sub.last_checked_at || sub.created_at || new Date(Date.now() - 5 * 60 * 1000).toISOString();

function creatorsOf(sub) {
  try {
    const ids = JSON.parse(sub.creator_ids || '[]');
    return Array.isArray(ids) ? [...new Set(ids.map(String).filter(Boolean))].slice(0, 200) : [];
  } catch { return []; }
}

function notificationFor(rows) {
  const newest = rows[0];
  const names = [];
  for (const r of rows) {
    const name = r.display_name || r.handle || 'a creator';
    if (!names.includes(name)) names.push(name);
  }
  const first = names[0] || 'A creator you follow';
  const title = names.length > 1 ? `${first} and ${names.length - 1} more` : first;
  return {
    title: `New from ${title}`,
    body: 'Tap to see the new post.',
    url: `/#/creator/${newest.creator_id}`,
    tag: `prism-${newest.creator_id}`,
    icon: '/icons/icon-192.png',
  };
}

async function tick({ now = new Date().toISOString() } = {}) {
  if (!webpush.available()) return { sent: 0, checked: 0, disabled: 0 };
  if (running) return { sent: 0, checked: 0, disabled: 0, busy: true };
  running = true;
  let sent = 0; let checked = 0; let disabled = 0;
  try {
    const subs = repo.db.prepare('SELECT * FROM push_subscriptions WHERE enabled = 1 ORDER BY updated_at DESC LIMIT ?').all(MAX_SUBS);
    for (const sub of subs) {
      checked++;
      const ids = creatorsOf(sub);
      if (!ids.length) continue;
      const marks = ids.map(() => '?').join(',');
      const rows = repo.db.prepare(`SELECT m.id, m.title, m.creator_id, m.ingested_at, m.author,
          c.handle, c.display_name
        FROM media m JOIN creators c ON c.id = m.creator_id
        WHERE m.publish_state = 'published' AND m.creator_id IN (${marks}) AND m.ingested_at > ?
        ORDER BY m.ingested_at DESC LIMIT 20`).all(...ids, sinceOf(sub));
      if (!rows.length) {
        repo.db.prepare('UPDATE push_subscriptions SET last_checked_at = ?, updated_at = ? WHERE id = ?').run(now, now, sub.id);
        continue;
      }
      const result = await webpush.send(sub, notificationFor(rows));
      if (result.ok) {
        sent++;
        repo.db.prepare('UPDATE push_subscriptions SET last_checked_at = ?, updated_at = ?, last_error = NULL WHERE id = ?')
          .run(rows[0].ingested_at || now, now, sub.id);
      } else if (result.gone) {
        disabled++;
        repo.db.prepare('UPDATE push_subscriptions SET enabled = 0, updated_at = ?, last_error = ? WHERE id = ?')
          .run(now, result.reason || 'gone', sub.id);
      } else {
        repo.db.prepare('UPDATE push_subscriptions SET updated_at = ?, last_error = ? WHERE id = ?')
          .run(now, result.reason || 'send failed', sub.id);
      }
    }
  } catch (e) {
    try { require('./events').log('WARN', `Push tick failed: ${String(e.message || e).slice(0, 160)}`); } catch { /* ignore */ }
  } finally { running = false; }
  return { sent, checked, disabled };
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, TICK_MS, creatorsOf, notificationFor };
