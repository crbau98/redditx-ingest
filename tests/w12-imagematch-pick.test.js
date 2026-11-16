'use strict';
/** pickCreators never runs a per-creator COUNT over media (prod: a 12.7 s loop block on 2026-11-16) and still skips creators with < 2 hashed pictures. */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let im;
before(() => { repo = require('../src/db/repo'); im = require('../src/engine/imagematch'); });

test('the candidate query reads creators.media_count, not a COUNT over media per creator', () => {
  const src = fs.readFileSync(require.resolve('../src/engine/imagematch.js'), 'utf8');
  const body = src.slice(src.indexOf('function pickCreators'), src.indexOf('The discovery pass'));
  assert.match(body, /c\.media_count >= 2/);
  assert.doesNotMatch(body, /SELECT COUNT\(\*\) FROM media m WHERE m\.creator_id = c\.id/);
});

test('a creator counted with media but fewer than two hashed published pictures is skipped', () => {
  const mk = (h) => { const c = repo.creators.create({ handle: h, displayName: h, scope: 'in' }); return c.id || c; };
  const a = mk('w12pick_hashed'); const b = mk('w12pick_unhashed');
  let n = 0;
  const add = (cid, phash) => { n++; return repo.media.insert({ platform: 'web', source_id: `pk${n}`, source_key: `web:pk${n}:0`, post_key: `web:pk${n}`, author: 'x', creator_id: cid, media_type: 'image', media_url: `https://cdn.example/pk${n}.jpg`, hash: `pkh${n}`, phash }, []); };
  add(a, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'); add(a, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2');
  add(b, null); add(b, null); add(b, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1');
  repo.db.prepare('UPDATE creators SET media_count = 3 WHERE id IN (?, ?)').run(a, b);
  const ids = im.pickCreators(50).map((c) => c.id);
  assert.ok(ids.includes(a));
  assert.ok(!ids.includes(b));
});
