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

// The browser loads public/js as ES modules, but `node --check` parses with the
// script goal and misses module-only syntax errors (which white-screen the whole
// app, since main.js statically imports every view). Parse with the module goal.
const pub = path.join(__dirname, '..', 'public', 'js');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
for (const f of walk(pub)) {
  test(`public/${path.relative(path.join(__dirname, '..', 'public'), f)} parses as a module`, () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check', f], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  });
}
