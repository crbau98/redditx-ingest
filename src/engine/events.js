'use strict';
/**
 * Server-sent events hub. Two channels:
 *   public - lightweight "new content" and stats pings (safe for anyone)
 *   admin  - ingestion logs, run start/finish and engine state
 */
const clients = { public: new Set(), admin: new Set() };
const logs = [];
const MAX_LOGS = 600;
let pendingNew = 0;
let newTimer = null;

function write(res, msg) {
  try { res.write(`data: ${JSON.stringify(msg)}\n\n`); return true; } catch { return false; }
}

function subscribe(channel, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 4000\n\n');
  write(res, { type: 'connected' });
  clients[channel].add(res);
  const ping = setInterval(() => { if (!res.write(': ping\n\n')) { /* backpressure: drop silently */ } }, 25000);
  ping.unref();
  req.on('close', () => { clearInterval(ping); clients[channel].delete(res); });
  return res;
}

function broadcast(channel, msg) {
  for (const res of clients[channel]) if (!write(res, msg)) clients[channel].delete(res);
}

function log(level, msg, meta) {
  const entry = { ts: new Date().toISOString(), level, msg, ...(meta || {}) };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  broadcast('admin', { type: 'log', data: entry });
  if (level === 'ERR' && process.env.NODE_ENV !== 'test') console.error(`[ingest] ${msg}`);
}

/** Coalesce bursts of new items into one public ping every few seconds. */
function newItems(count = 1) {
  pendingNew += count;
  if (newTimer) return;
  newTimer = setTimeout(() => {
    broadcast('public', { type: 'new', count: pendingNew });
    pendingNew = 0; newTimer = null;
  }, 4000);
  newTimer.unref();
}

const admin = (type, data) => broadcast('admin', { type, data });
const getLogs = (n = 200) => logs.slice(-n);
const clearLogs = () => { logs.length = 0; };
const counts = () => ({ public: clients.public.size, admin: clients.admin.size });

module.exports = { subscribe, broadcast, log, newItems, admin, getLogs, clearLogs, counts };
