'use strict';
/**
 * v4.16 "Lumen": guards for the redesign's performance promises. Like v413.test.js these read the
 * shipped files directly (no browser).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const read = (...p) => fs.readFileSync(path.join(pub, ...p), 'utf8');
const css = read('css', 'app.css');
const lumen = css.slice(css.indexOf('v4.16 "Lumen"'));

describe('v4.16 fonts are self-hosted and small', () => {
  test('no Google Fonts request anywhere in the shell', () => {
    for (const f of [read('index.html'), read('js', 'theme-init.js'), css]) assert.doesNotMatch(f, /fonts\.(googleapis|gstatic)\.com/);
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8'), /fonts\.(googleapis|gstatic)\.com/, 'CSP no longer allows them');
  });
  test('both families are declared, preloaded and under 30 KB each', () => {
    for (const file of ['inter-var-latin.woff2', 'space-grotesk-var-latin.woff2']) {
      assert.match(css, new RegExp(`@font-face[^}]*url\\('/fonts/${file}'\\)`));
      assert.match(read('index.html'), new RegExp(`<link rel="preload" href="/fonts/${file}" as="font" type="font/woff2" crossorigin>`));
      const size = fs.statSync(path.join(pub, 'fonts', file)).size;
      assert.ok(size > 5000 && size < 30 * 1024, `${file} is ${size} bytes`);
    }
    assert.ok(fs.existsSync(path.join(pub, 'fonts', 'LICENSE.txt')), 'OFL licence ships with the fonts');
  });
});

describe('v4.16 admin styles load with the admin console only', () => {
  test('the shell does not link admin.css; the admin view loads it before rendering', () => {
    assert.doesNotMatch(read('index.html'), /admin\.css/);
    assert.doesNotMatch(read('sw.js'), /admin\.css/);
    const admin = read('js', 'views', 'admin', 'index.js');
    assert.match(admin, /new URL\('\.\.\/\.\.\/\.\.\/css\/admin\.css', import\.meta\.url\)/);
    assert.match(admin, /await adminStyles\(\)/);
  });
  test('no public view depends on a class that only admin.css defines', () => {
    const adminOnly = new Set([...read('css', 'admin.css').matchAll(/^\.([a-z][\w-]*)/gm)].map((m) => m[1]));
    for (const c of [...adminOnly]) if (new RegExp(`\\.${c}(?![\\w-])`).test(css)) adminOnly.delete(c); // defined in app.css too
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'admin' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    for (const file of walk(path.join(pub, 'js'))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const c of adminOnly) assert.doesNotMatch(src, new RegExp(`class: ['\`][^'\`]*(?<![\\w-])${c}(?![\\w-])`), `${path.basename(file)} uses .${c}`);
    }
  });
});

describe('v4.16 image-first cards stay cheap', () => {
  test('captions sit over the image and the masonry estimate is the media height alone', () => {
    assert.match(lumen, /\.card-foot \{ position: absolute;/);
    assert.match(read('js', 'components', 'masonry.js'), /return colWidth \* r;/);
  });
  test('the redesign adds no live blur to card chips, captions or Reels controls', () => {
    for (const m of lumen.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/backdrop-filter:\s*(?!\s|none)/.test(m[2])) continue;
      assert.doesNotMatch(m[1], /card|pill|reel|why/, `live blur on ${m[1].trim()}`);
    }
  });
});

describe('v4.16 review fixes', () => {
  test('masonry gap maps match the rendered --gap values', () => {
    const css = read('css', 'app.css');
    const js = read('js', 'components', 'masonry.js');
    const map = (name) => Object.fromEntries([...js.match(new RegExp(`const ${name} = \\{([^}]*)\\}`))[1].matchAll(/(\w): (\d+)/g)].map((m) => [m[1], +m[2]]));
    const last = (src, sel) => { const all = [...src.matchAll(new RegExp(`^\\s*\\${sel} \\{ --gap: (\\d+)px; \\}`, 'gm'))]; return all.length ? +all.at(-1)[1] : null; };
    const at = css.indexOf('@media (max-width: 639px) {\n  .masonry { --gap:');
    assert.ok(at > 0, 'phone gap block');
    const desk = css.slice(0, at), phone = css.slice(at, css.indexOf('\n}', at));
    const d = { m: last(desk, '.masonry'), s: last(desk, '.density-s'), l: last(desk, '.density-l') };
    const p = { m: last(phone, '.masonry') ?? d.m, s: last(phone, '.density-s') ?? d.s, l: last(phone, '.density-l') ?? last(phone, '.masonry') };
    assert.deepEqual(map('GAP'), d);
    assert.deepEqual(map('GAP_PHONE'), p);
  });
  test('wide media gets the slim caption so it never overflows a short image', () => {
    assert.match(read('js', 'components', 'card.js'), /ratio > 1\.3 \? ' wide' : ''/);
    assert.match(lumen, /\.masonry \.card\.wide \.card-title \{ -webkit-line-clamp: 1; \}/);
    assert.match(lumen, /\.masonry \.card\.wide \.card-why ~ \.card-title \{ display: none; \}/);
  });
  test('the keyboard focus ring is an outline, so component shadows cannot hide it', () => {
    assert.match(lumen, /^:focus-visible \{ outline: 2px solid var\(--accent\);/m);
    assert.doesNotMatch(lumen, /^:focus-visible \{[^}]*outline: none/m);
  });
});
