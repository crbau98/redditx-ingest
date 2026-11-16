'use strict';
/** Every DOM built in src/ goes through lib/markup-guard (guard, then cheerio). A direct cheerio.load would bypass the limits. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const WRAPPER = path.join(SRC, 'lib', 'markup-guard.js');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
// comments are not code: strip them before looking for a call
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('no file in src/ requires cheerio or calls cheerio.load outside lib/markup-guard.js', () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    if (file === WRAPPER) continue;
    const text = code(fs.readFileSync(file, 'utf8'));
    if (/require\(\s*['"]cheerio['"]\s*\)/.test(text) || /\bcheerio\s*\.\s*load\s*\(/.test(text) || /\bfrom\s+['"]cheerio['"]/.test(text)) offenders.push(path.relative(SRC, file));
  }
  assert.deepEqual(offenders, [], `use markupGuard.load(html, kind) instead: ${offenders.join(', ')}`);
});

test('the wrapper exists and is the only place that loads cheerio', () => {
  const text = fs.readFileSync(WRAPPER, 'utf8');
  assert.match(text, /require\('cheerio'\)/);
  assert.match(text, /function load\(/);
});

test('the wrapper refuses hostile input, loads ordinary input, and builds fragments and feeds', () => {
  const g = require('../src/lib/markup-guard');
  assert.throws(() => g.load('<div>'.repeat(500), 'html'), (e) => e.markupGuard);
  assert.equal(g.load('<html><body><p id="a">x</p></body></html>')('#a').text(), 'x');
  assert.equal(g.load('<b>hi</b>', 'fragment').root().text(), 'hi');
  assert.equal(g.load('<rss><channel><item><title>t</title></item></channel></rss>', 'xml')('item title').text(), 't');
  assert.equal(g.tryLoadFragment('<div>'.repeat(500)), null);
});
