'use strict';
/** Retired modules stay gone: the adapter registry has no lemmy or bluesky-firehose, and nothing loads the deleted files. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const ROOT = path.join(__dirname, '..');
const GONE = ['src/sources/lemmy.js', 'src/sources/bluesky-firehose.js', 'src/engine/integration.js'];

test('the deleted files are gone', () => {
  for (const f of GONE) assert.equal(fs.existsSync(path.join(ROOT, f)), false, f);
});

test('the adapter registry lists neither lemmy nor bluesky-firehose', () => {
  const registry = require('../src/sources');
  const platforms = registry.list().map((a) => a.platform);
  assert.ok(platforms.length > 5);
  assert.ok(!platforms.includes('lemmy'));
  assert.ok(!platforms.includes('bluesky-firehose'));
});

test('nothing under src/ or scripts/ requires or imports the deleted files', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : /\.(c|m)?js$/.test(e.name) ? [path.join(d, e.name)] : []));
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))];
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:require\(|import\(|from\s+)['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('.')) continue;
      const target = path.relative(ROOT, path.resolve(path.dirname(f), m[1])).replace(/\.js$/, '');
      if (GONE.some((g) => g.replace(/\.js$/, '') === target)) bad.push(`${path.relative(ROOT, f)} -> ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});
