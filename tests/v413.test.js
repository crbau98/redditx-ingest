'use strict';
/**
 * v4.13 "Fluid": guards for the front-end performance work. These read the shipped CSS/JS directly
 * (no browser): they fail if a change brings back a known per-frame cost.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { staticGraph } = require('../src/lib/assets');

const pub = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(pub, 'css', 'app.css'), 'utf8') + fs.readFileSync(path.join(pub, 'css', 'admin.css'), 'utf8');

/** keyframes name → set of animated properties */
function keyframes(src) {
  const out = new Map();
  const re = /@keyframes\s+([\w-]+)\s*\{/g; let m;
  while ((m = re.exec(src))) {
    let depth = 1; let i = re.lastIndex;
    while (depth && i < src.length) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
    const body = src.slice(re.lastIndex, i - 1);
    const props = new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((x) => x[1]));
    out.set(m[1], props);
  }
  return out;
}

describe('v4.13 compositor-only looping animations', () => {
  test('every infinite animation animates only transform/opacity (no per-frame repaint)', () => {
    const kf = keyframes(css);
    const cheap = new Set(['transform', 'opacity', 'translate', 'scale', 'rotate']);
    const infinite = new Set();
    for (const m of css.matchAll(/animation:\s*([^;}]+)/g)) {
      if (!/\binfinite\b/.test(m[1])) continue;
      const name = m[1].split(/[\s,]+/).find((t) => kf.has(t));
      if (name) infinite.add(name);
    }
    assert.ok(infinite.has('shimmer') && infinite.has('live'), 'found the looping animations');
    for (const name of infinite) {
      const bad = [...kf.get(name)].filter((p) => !cheap.has(p));
      assert.deepEqual(bad, [], `@keyframes ${name} loops forever but animates ${bad.join(', ')}`);
    }
  });

  test('the card placeholder shimmer is switched off once the image has loaded', () => {
    assert.match(css, /\.card-media \.ph\.done::after\s*\{\s*content:\s*none/);
    const card = fs.readFileSync(path.join(pub, 'js', 'components', 'card.js'), 'utf8');
    assert.match(card, /addEventListener\('load',[^\n]*ph\.classList\.add\('done'\)/);
  });

  test('no live blur behind Reels or on the chips every card carries', () => {
    assert.doesNotMatch(css.match(/\.reel-bg\s*\{[^}]*\}/)[0], /filter/);
    assert.match(css, /\.pill, \.card-fav, \.card-why \{ backdrop-filter: none/);
    assert.doesNotMatch(css.match(/\.reel-act svg \{[^}]*\}/)[0], /backdrop-filter/);
  });
});

describe('v4.13 shell', () => {
  test('the galaxy view is loaded on demand, not preloaded with the shell', () => {
    const graph = staticGraph(path.join(pub, 'js'), 'main.js').map((f) => path.relative(pub, f).split(path.sep).join('/'));
    assert.ok(graph.includes('js/views/home.js'));
    assert.ok(!graph.includes('js/views/galaxy.js'));
  });
});
