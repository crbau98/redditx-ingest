'use strict';
/** public/js/guard.js: the shared "left this page" flag and cleanup the views use. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const load = () => import('../public/js/guard.js');

test('cleanup flips isLeft and alive, and runs the view teardown once', async () => {
  const { makeGuard } = await load();
  let torn = 0;
  const life = makeGuard(() => { torn++; });
  assert.equal(life.isLeft(), false);
  assert.equal(life.alive(), true);
  life.cleanup();
  assert.equal(life.isLeft(), true);
  assert.equal(life.alive(), false);
  assert.equal(torn, 1);
  life.cleanup();
  assert.equal(torn, 1, 'a second cleanup does nothing');
});

test('a guard without teardown is safe to clean up, and alive works detached (as smart.js calls it)', async () => {
  const { makeGuard } = await load();
  const life = makeGuard();
  const { alive } = life;
  assert.equal(alive(), true);
  life.cleanup(); life.cleanup();
  assert.equal(alive(), false);
});

test('the converted views use the helper and no longer keep their own flag', () => {
  const dir = path.join(__dirname, '..', 'public', 'js', 'views');
  for (const f of ['home.js', 'browse.js', 'explore.js', 'following.js', 'find.js', 'creator.js', 'saved.js', 'admin/moderation.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(src, /import \{ makeGuard \} from '\.\.\/(\.\.\/)?guard\.js';/, f);
    assert.match(src, /makeGuard\(/, f);
    assert.doesNotMatch(src, /let left = false|left = true|let alive = true|alive = false/, f);
  }
});
