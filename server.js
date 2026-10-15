'use strict';
require('dotenv').config();

const config = require('./src/config');
const { createApp } = require('./src/app');
const engine = require('./src/engine/engine');
const maintenance = require('./src/engine/maintenance');
const backup = require('./src/engine/backup');
const discovery = require('./src/engine/discovery');
const health = require('./src/engine/health');
const { migration } = require('./src/db');

const app = createApp();
const server = app.listen(config.port, () => {
  const line = '='.repeat(46);
  console.log(`\n  ${line}\n   PRISM v${config.version}`);
  console.log(`   Port:      ${config.port}`);
  console.log(`   Database:  ${config.dbPath}${migration.from !== migration.to ? `  (migrated v${migration.from} → v${migration.to})` : ''}`);
  console.log(`   Admin:     ${config.adminKey ? 'protected by ADMIN_KEY' : config.adminOpen ? 'OPEN (no ADMIN_KEY — fine for local dev only)' : 'DISABLED — set ADMIN_KEY'}`);
  console.log(`   Age gate:  ${config.ageGateEnforce ? 'enforced server-side' : 'off'}`);
  console.log(`   Scheduler: ${config.schedulerEnabled ? 'on' : 'off (toggle in Admin → Settings)'}`);
  console.log(`   Keys:      X ${config.creds.xBearer ? '✓' : '–'} · Brave ${config.creds.braveKey ? '✓' : '–'} · Telegram ${config.creds.telegramBot ? '✓' : '–'} · Reddit ${config.creds.redditClientId ? '✓' : '–'} · Bluesky ${config.creds.bskyIdentifier ? '✓' : '–'}`);
  console.log(`  ${line}\n`);
});

engine.start();
maintenance.startupSweepIfNeeded();
setTimeout(() => require('./src/routes/public').warm(), 1500).unref(); // pre-build the big caches (topics, graph, home)
backup.start();
discovery.start();
health.start();
maintenance.startImageSweep();
require('./src/engine/visual').start(); // "More like this": embeds the library in the background
require('./src/services/telegram-sync').start();
require('./src/engine/memwatch').start({ onCritical: () => shutdown('memory') });
require('./src/engine/thumbs').start(); // small thumbnails and a tint per picture, newest first

function shutdown(signal) {
  console.log(`\n[${signal}] shutting down…`);
  engine.shutdown();
  backup.stop();
  discovery.stop();
  health.stop();
  maintenance.stopImageSweep();
  require('./src/engine/visual').stop();
  require('./src/services/telegram-sync').stop();
  require('./src/engine/thumbs').stop();
  require('./src/engine/memwatch').stop();
  require('./src/lib/imagefilter').shutdown().catch(() => {});
  const code = signal === 'memory' ? 1 : 0; // a memory restart is not a clean stop: Docker brings PRISM straight back
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
/*
 * A stray error in one background job (a source, the Telegram client, a socket callback) used to take the whole site down:
 * Node exits on an uncaught exception, Docker restarts the container, and the app is gone while it boots again. Now it is
 * logged in full, kept in /data/crash.log (survives the restart, so it can be read later) and the server keeps going. Only a
 * burst of them (something truly broken) still exits, so Docker gives the process a clean start.
 */
const crashLog = require('path').join(config.dataDir, 'crash.log');
function noteCrash(kind, e) {
  const stack = e && e.stack ? e.stack : String(e);
  console.error(`[${kind}]`, stack);
  try {
    const fs = require('fs');
    try { if (fs.statSync(crashLog).size > 2 * 1024 * 1024) fs.renameSync(crashLog, `${crashLog}.1`); } catch { /* none yet */ }
    const mem = process.memoryUsage();
    fs.appendFileSync(crashLog, `${new Date().toISOString()} ${kind} rss=${Math.round(mem.rss / 1048576)}MB heap=${Math.round(mem.heapUsed / 1048576)}MB\n${stack}\n\n`);
  } catch { /* disk full or read-only: the console line is enough */ }
  try { require('./src/engine/events').log('ERR', `${kind}: ${String((e && e.message) || e).slice(0, 200)}`); } catch { /* ignore */ }
}
let recentCrashes = [];
process.on('uncaughtException', (e) => {
  noteCrash('uncaughtException', e);
  const now = Date.now();
  recentCrashes = recentCrashes.filter((t) => now - t < 60000).concat(now);
  if (recentCrashes.length >= 10) { console.error('[fatal] 10 uncaught errors in a minute: restarting'); process.exit(1); }
});
process.on('unhandledRejection', (e) => noteCrash('unhandledRejection', e));
