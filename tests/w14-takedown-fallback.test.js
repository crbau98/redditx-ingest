'use strict';
/** Crucible v4.23 gate M5: a takedown also clears media.fallback_url (v39), and the residue purge finds removed rows that kept one. */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let db;
before(() => { repo = require('../src/db/repo'); db = repo.db; });

let n = 0;
const add = (author) => { n++; const id = repo.media.insert({ platform: 'reddit', source_id: `fb${n}`, source_key: `reddit:fb${n}:0`, post_key: `reddit:fb${n}`, author, media_type: 'image', media_url: `https://i.redd.it/fb${n}.jpg`, hash: `fbh${n}` }, []); db.prepare('UPDATE media SET fallback_url = ? WHERE id = ?').run(`https://preview.redd.it/fb${n}.jpg?width=2000&s=SIG${n}`, id); return id; };

test('a takedown clears fallback_url with the other identifiers', () => {
  const id = add('fallbackgone');
  repo.takedowns.add({ kind: 'handle', value: 'fallbackgone', reason: 'request', actor: 'test' });
  const row = db.prepare('SELECT publish_state, fallback_url, media_url FROM media WHERE id = ?').get(id);
  assert.deepEqual(row, { publish_state: 'removed', fallback_url: null, media_url: '' });
});

test('the residue purge finds and clears removed rows that kept a fallback_url', async () => {
  const id = add('olderremoval');
  db.prepare("UPDATE media SET publish_state = 'removed', review_reason = 'takedown' WHERE id = ?").run(id); // removed before v39's column was purged
  const residue = require('../src/engine/residue-purge');
  const dry = await residue.purgeResidue({ dryRun: true });
  assert.ok(dry.found >= 1);
  await residue.purgeResidue();
  assert.equal(db.prepare('SELECT fallback_url FROM media WHERE id = ?').get(id).fallback_url, null);
  assert.equal((await residue.purgeResidue({ dryRun: true })).found, 0);
});
