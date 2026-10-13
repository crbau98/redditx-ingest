'use strict';
// The deploy/ files only run on a server, so mistakes there surface during a move or a recovery. Catch the cheap ones here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'deploy');

for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sh'))) {
  test(`deploy/${f} parses`, () => {
    const r = spawnSync('bash', ['-n', path.join(dir, f)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  });
}

test('every compose service caps its log size', () => {
  const yml = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  const services = yml.split(/^services:\n/m)[1].split(/^\S/m)[0];
  const blocks = services.split(/^  (?=[a-z][\w-]*:\s*$)/m).filter((b) => /^[a-z]/.test(b));
  assert.ok(blocks.length >= 5, `found ${blocks.length} services`);
  for (const b of blocks) assert.match(b, /^\s+logging: \*logging$/m, `${b.split(':')[0]} has no logging cap`);
});
