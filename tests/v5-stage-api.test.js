'use strict';
/** v5 creator stage: the creator detail API carries what the stage header shows. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let server; let base; let repo; let engine;
const get = async (p) => (await fetch(`${base}${p}`, { headers: { cookie: 'prism_age=1' } })).json();

before(async () => {
  prepareEnv({ AGE_GATE_ENFORCE: 'true' });
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  const { createApp } = require('../src/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); await new Promise((r) => server.close(r)); });

test('"Also goes by" gets his other names as strings, not the name and handle already shown, nor bio claims', async () => {
  const settings = require('../src/settings').get();
  const { applyProfile } = require('../src/engine/creators');
  const c = repo.creators.create({ handle: 'stage_marcus', displayName: 'Stage Marcus', origin: 'admin' });
  const f = repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'stage_marcus', creatorId: c.id, enabled: 1, trusted: 1, origin: 'admin', runNow: false }).feed;
  applyProfile(repo.feeds.get(f.id), { displayName: 'Marcus Steelworks', bio: 'aka @steelworks_bio' }, settings);
  const d = await get(`/api/creators/${c.id}`);
  assert.ok(Array.isArray(d.aliases));
  assert.ok(d.aliases.includes('Marcus Steelworks'), JSON.stringify(d.aliases));
  assert.ok(d.aliases.every((a) => typeof a === 'string'));
  assert.ok(!d.aliases.some((a) => /stage.?marcus/i.test(a)), 'the handle on the page is not repeated');
  assert.ok(!d.aliases.includes('steelworks_bio'), 'bio-claimed names stay out');
});
