'use strict';
require('dotenv').config();

const config = require('./src/config');
const { createApp } = require('./src/app');
const engine = require('./src/engine/engine');
const maintenance = require('./src/engine/maintenance');
const backup = require('./src/engine/backup');
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
  console.log(`  ${line}\n`);
});

engine.start();
maintenance.startupSweepIfNeeded();
backup.start();

function shutdown(signal) {
  console.log(`\n[${signal}] shutting down…`);
  engine.shutdown();
  backup.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
