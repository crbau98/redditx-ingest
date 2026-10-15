'use strict';
/**
 * Every browser module must parse. main.js imports the views statically, so one syntax error in any
 * of them stops the whole app from starting (v5 Horizon shipped browse.js with two stray parens).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', 'public', 'js');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));

test('every public/js module parses as an ES module', () => {
  const files = walk(root);
  assert.ok(files.length > 20, 'found the front-end modules');
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: fs.readFileSync(f) });
    if (r.status !== 0) bad.push(`${path.relative(root, f)}: ${String(r.stderr).split('\n').find((l) => /Error/.test(l)) || 'syntax error'}`);
  }
  assert.deepEqual(bad, []);
});
