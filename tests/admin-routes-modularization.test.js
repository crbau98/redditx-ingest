'use strict';
/**
 * v4.20 admin split: src/routes/admin.js stays the assembler. Every method and path that lived
 * on the monolith is still registered on the exported router, and the assembler stays under 120 lines.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();

const ADMIN = path.join(__dirname, '../src/routes/admin.js');
const EXPECTED = `
GET /overview
GET /stream
GET /engine
GET /logs
DELETE /logs
POST /engine/run
POST /engine/stop
POST /engine/pause
POST /engine/resume
POST /engine/breakers/reset
GET /runs
GET /sources
GET /sources/health
GET /sources/retired
GET /browser4
POST /browser4/expand
GET /ai
POST /ai/plan
POST /ai/triage
POST /maintenance/purge-removed-residue
GET /library-health
GET /feeds/idle
GET /feeds/foreign
GET /feeds
POST /feeds
POST /feeds/import
GET /subreddits
PATCH /feeds/:id
POST /feeds/:id/media/reassign
DELETE /feeds/:id
POST /feeds/:id/run
GET /creators
GET /creators/same-handle
POST /creators/same-handle/dismiss
GET /creators/:id
POST /creators
PATCH /creators/:id
POST /creators/merge
POST /creators/:id/block
POST /creators/:id/restore
GET /profiles
GET /profiles/:name
GET /identities
POST /identities/scan
POST /identities/:id
GET /creators/:id/aliases
POST /creators/:id/aliases
DELETE /creators/:id/aliases/:alias
GET /media
PATCH /media/:id
POST /media/:id/assign
POST /media/:id/moderate
POST /media/bulk
GET /moderation/queue
POST /moderation/by-reason
GET /reports
POST /reports/:id/resolve
GET /blocklist
POST /blocklist
DELETE /blocklist/:id
GET /settings
PUT /settings
GET /discovery
POST /discovery/web-matches/:id
POST /discovery/face-purge
POST /discovery/run
POST /discovery/candidates/:id
POST /discovery/candidates
GET /discovery/onlyfans
POST /discovery/onlyfans
POST /discovery/onlyfans/:handle
POST /creators/:id/pull
GET /creators/:id/pull
POST /lookup
POST /lookup/follow
POST /lookup/auto
POST /maintenance/sweep
GET /maintenance/image-filter
POST /maintenance/physique-sweep
POST /maintenance/image-sweep
POST /maintenance/face-sweep
GET /telegram
POST /telegram/sync
GET /disk
GET /maintenance/store-migrate
POST /maintenance/store-migrate
POST /maintenance/store-migrate/stop
POST /maintenance/recompute
GET /takedowns
POST /takedowns
DELETE /takedowns/:id
GET /audit
GET /creators-duplicates
GET /backups
POST /backups
GET /export
POST /import
POST /ingest/start
POST /ingest/stop
POST /ingest/pause
POST /ingest/resume
GET /ingest/status
GET /ingest/logs
POST /ingest/sweep
`.trim().split('\n');

function registered(router) {
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (on && method !== 'head') out.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return out;
}

test('admin.js is the thin assembler', () => {
  const src = fs.readFileSync(ADMIN, 'utf8');
  const lines = src.split('\n').filter((line, i, all) => !(i === all.length - 1 && line === '')).length;
  assert.ok(lines < 120, `admin.js is ${lines} lines`);
  assert.match(src, /req\.path === '\/stream' && adminKeyValid\(req\)/);
  assert.match(src, /adminCredentialAuth/);
  assert.match(src, /registerEngine\(router, helpers\)/);
  assert.match(src, /registerFeeds\(router, helpers\)/);
  assert.match(src, /registerCreators\(router, helpers\)/);
  assert.match(src, /registerModeration\(router, helpers\)/);
  assert.match(src, /registerOps\(router, helpers\)/);
});

test('every previous admin route is still registered', () => {
  const router = require('../src/routes/admin');
  const got = registered(router);
  assert.deepEqual([...got].sort(), [...EXPECTED].sort());
  const at = (method, routePath) => got.findIndex((row) => row === `${method} ${routePath}`);
  assert.ok(at('GET', '/creators/same-handle') < at('GET', '/creators/:id'), 'same-handle must stay ahead of :id');
  assert.ok(at('GET', '/feeds/idle') < at('GET', '/feeds/:id') || at('GET', '/feeds/:id') === -1);
  assert.ok(at('GET', '/feeds/foreign') >= 0);
});
