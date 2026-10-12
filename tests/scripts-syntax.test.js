'use strict';
// The scripts/ folder is run by hand (and inside the container, see deploy/README.md) but never loaded by other tests,
// so a syntax error there only shows up when someone needs the script. Parse every one of them.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'scripts');
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
  test(`scripts/${f} parses`, () => {
    const r = spawnSync(process.execPath, ['--check', path.join(dir, f)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  });
}
