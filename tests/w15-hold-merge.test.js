'use strict';
/** Crucible v4.23.1 gate MAJOR 2: a creator under a safety hold (or with an open underage / nonconsensual report) is never merged, even with force. */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let identity;
before(() => { repo = require('../src/db/repo'); identity = require('../src/engine/identity'); });
const mk = (h) => { const c = repo.creators.create({ handle: h, displayName: h, scope: 'in' }); return c.id || c; };

test('a held creator cannot be folded in or kept, with or without force; after the human restore and a resolved report, it can', () => {
  const k = mk('holdkeep1'); const e = mk('holdgone1');
  repo.creators.update(e, { status: 'hidden' });
  repo.logAction('creator', e, 'safety-hold', 'web:page under-18 wording', 'system');
  repo.db.prepare("INSERT INTO reports (kind, creator_id, reason, status) VALUES ('underage', ?, 'safety-hold', 'open')").run(e);
  for (const force of [false, true]) {
    const out = identity.mergeCreators(k, e, { force });
    assert.equal(out && out.status, 409, JSON.stringify(out));
    const out2 = identity.mergeCreators(e, k, { force });
    assert.equal(out2 && out2.status, 409);
  }
  assert.ok(repo.creators.get(e), 'the held row still exists');
  repo.db.prepare("UPDATE reports SET status = 'resolved' WHERE creator_id = ?").run(e);
  repo.creators.update(e, { status: 'active' });
  repo.logAction('creator', e, 'restore', 'human review done', 'admin');
  const ok = identity.mergeCreators(k, e, {});
  assert.ok(ok && !ok.error, JSON.stringify(ok));
});
