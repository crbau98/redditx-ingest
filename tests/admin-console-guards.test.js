'use strict';
/**
 * Admin console redesign guards: the console's stylesheets ship with the console and nowhere else, use only tokens,
 * stay inside their own namespace, and the shell keeps the structure the phone layout depends on.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const read = (...p) => fs.readFileSync(path.join(pub, ...p), 'utf8');
const css = read('css', 'admin-console.css');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

describe('admin console stylesheet', () => {
  test('arrives with the console only: not in the shell, the bundle or the service worker', () => {
    assert.doesNotMatch(read('index.html'), /admin-console\.css/);
    assert.doesNotMatch(read('sw.js'), /admin-console\.css/);
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'assets.js'), 'utf8'), /admin-console/);
    const admin = read('js', 'views', 'admin', 'index.js');
    assert.match(admin, /new URL\('\.\.\/\.\.\/\.\.\/css\/admin-console\.css', import\.meta\.url\)/);
    assert.match(admin, /new URL\('\.\.\/\.\.\/\.\.\/css\/admin\.css', import\.meta\.url\)/);
    assert.match(admin, /await adminStyles\(\)/);
  });
  test('uses tokens only: no colour literals, so light and dark both work', () => {
    const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepEqual(body.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [], 'hex colours');
    assert.deepEqual(body.match(/\brgba?\(/g) || [], [], 'rgb colours');
    assert.deepEqual(body.match(/\bhsla?\(/g) || [], [], 'hsl colours');
  });
  test('no live blur, no infinite animation outside the loading skeleton', () => {
    assert.doesNotMatch(css, /backdrop-filter\s*:\s*(?!none)/);
    const loops = [...css.matchAll(/animation\s*:[^;}]*infinite/g)].map((m) => m[0]);
    assert.deepEqual(loops, ['animation: a-shim 1.4s linear infinite'], 'only the skeleton shimmer loops');
    assert.match(css, /prefers-reduced-motion: reduce\) \{ \.a-skel i \{ animation: none; \} \}/, 'and it stops for reduced motion');
  });
  test('the phone layout has its bottom tab bar, the shared 44px touch rule and no hover-only controls', () => {
    assert.match(css, /\.a-tabbar \{\s*display: grid/);
    assert.match(css, /@media \(pointer: coarse\), \(max-width: 899px\) \{[\s\S]*min-height: 44px/);
    assert.match(css, /body\.is-admin \.bottomnav \{ display: none !important; \}/);
  });
  test('rules that change shared elements are scoped to the console', () => {
    // anything outside `.adm`, `.a-*`, `.review-*`, `.mod-*`, `.report`, `.tbl`, `.toast` or body.is-admin could leak to a public page
    const sel = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}@][^{}]*)\{/gm)].map((m) => m[1].trim()).filter(Boolean);
    const ok = /^(\.adm|\.a-|body\.is-admin|\.review-|\.mod-|\.report|\.tbl|\.toast\.a-undo|details\.a-|\.a-)/;
    const leaks = sel.flatMap((s) => s.split(',').map((x) => x.trim())).filter((s) => s && !ok.test(s) && !/^\d+%|^to$|^from$|^@|^\(/.test(s));
    assert.deepEqual(leaks, []);
  });
});

describe('admin console views', () => {
  const dir = path.join(pub, 'js', 'views', 'admin');
  test('no public view uses a class only the console defines', () => {
    const names = new Set([...css.matchAll(/\.(a-[a-z][\w-]*)/g)].map((m) => m[1]));
    assert.ok(names.size > 40, 'the console has its own a-* classes');
    const publicFiles = walk(path.join(pub, 'js')).filter((f) => !f.startsWith(dir));
    for (const file of publicFiles) {
      const src = fs.readFileSync(file, 'utf8');
      for (const c of names) assert.doesNotMatch(src, new RegExp(`class: ['\`][^'\`]*(?<![\\w-])${c}(?![\\w-])`), `${path.basename(file)} uses .${c}`);
    }
  });
  test('the pure logic modules never touch the DOM, so tests can load them in node', () => {
    for (const f of ['logic.js', 'settings-model.js']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.doesNotMatch(src, /^import /m, `${f} imports nothing`);
      assert.doesNotMatch(src, /\b(document|window|localStorage|sessionStorage)\b/, `${f} has no browser globals`);
    }
  });
  test('every icon-only button names itself', () => {
    // a button that renders only icon() children needs an aria-label (or a title) so a screen reader can say what it does
    const bad = [];
    for (const f of walk(dir).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/h\('button', \{([^}]*)\}, icon\('[a-z-]+'(?:, '[^']*')?\)\)/g)) {
        if (!/aria-label|title/.test(m[1])) bad.push(`${path.basename(f)}: ${m[0].slice(0, 80)}`);
      }
    }
    assert.deepEqual(bad, []);
  });
  test('destructive actions ask first and the undoable ones offer Undo', () => {
    const moderation = fs.readFileSync(path.join(dir, 'moderation.js'), 'utf8');
    assert.match(moderation, /action !== 'hide' && !\(await confirmBatch\(action, items\)\)/, 'approve, remove and block ask; hide does not');
    assert.match(moderation, /undoToast\(`\$\{plan\.verb\}/, 'hide, approve and remove can be undone');
    const creators = fs.readFileSync(path.join(dir, 'creators.js'), 'utf8');
    assert.match(creators, /confirmDialog\([^)]*taken down/, 'blocking a creator asks first and says what it does');
    assert.match(creators, /undoToast\(`\$\{name\} is hidden from the site`/, 'hiding a creator can be undone');
    const feeds = fs.readFileSync(path.join(dir, 'feeds.js'), 'utf8');
    assert.match(feeds, /Delete this feed\?/, 'deleting a feed asks first');
    const reports = fs.readFileSync(path.join(dir, 'reports.js'), 'utf8');
    assert.match(reports, /CONFIRM\[action\]/, 'removing or blocking from a report asks first');
  });
});

test('no admin view retries by calling render(root) again (that appends a second copy of the page head and toolbar)', () => {
  const dir = path.join(__dirname, '..', 'public', 'js', 'views', 'admin');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /errorState\(.*=>\s*render\(root\)/, `${f}: retry must reload into the existing host`);
  }
});
