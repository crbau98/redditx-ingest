'use strict';
/**
 * v5 "Motion": guards for the motion vocabulary and shared-element transitions. Like the v4.13
 * guards these read the shipped CSS/JS directly, with no browser.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { staticGraph } = require('../src/lib/assets');

const pub = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(pub, 'css', 'app.css'), 'utf8');
const js = (f) => fs.readFileSync(path.join(pub, 'js', f), 'utf8');

describe('v5 motion vocabulary', () => {
  test('three springs and three durations are defined, with linear() springs behind @supports', () => {
    for (const t of ['--spring-snap', '--spring-glide', '--spring-settle', '--dur-quick', '--dur-base', '--dur-slow']) assert.match(css, new RegExp(`${t}:`), t);
    const sup = css.match(/@supports \(transition-timing-function: linear\(0, 1\)\) \{([\s\S]*?)\n\}/);
    assert.ok(sup, 'linear() springs are gated on support');
    for (const t of ['snap', 'glide', 'settle']) assert.match(sup[1], new RegExp(`--spring-${t}: linear\\(0, [^;]+, 1\\);`));
  });

  test('no component hard-codes a cubic-bezier: only the token fallbacks and the ambient live-dot loop', () => {
    const lines = css.split('\n').filter((l) => /cubic-bezier\(/.test(l) && !/^\s*\*/.test(l));
    const allowed = lines.filter((l) => /--spring-(snap|glide|settle):/.test(l) || /\.live-dot::after/.test(l));
    assert.deepEqual(lines.filter((l) => !allowed.includes(l)), []);
  });

  test('short transitions use duration tokens, not literal seconds', () => {
    const literal = [];
    for (const m of css.matchAll(/(?<![\w-])(?:transition|animation)\s*:([^;}]+)/g)) {
      if (/infinite/.test(m[1])) continue;
      for (const t of m[1].matchAll(/(?<![\w.-])\.(\d+)s\b/g)) if (Number(`0.${t[1]}`) < 0.6) literal.push(m[0].trim());
    }
    assert.deepEqual(literal, []);
  });

  test('reduced motion still collapses every duration', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation-duration: \.001ms !important;[^}]*transition-duration: \.001ms !important/);
  });
});

describe('v5 shared-element transitions', () => {
  const tr = js('components/transitions.js');

  test('transitions.js is part of the preloaded shell graph (through fx.js)', () => {
    const graph = staticGraph(path.join(pub, 'js'), 'main.js').map((f) => path.basename(f));
    assert.ok(graph.includes('transitions.js'));
    assert.match(js('components/fx.js'), /export \{ rememberFlip, playFlip \} from '\.\/transitions\.js'/);
  });

  test('every animation it runs is transform, opacity or clip-path, and it bails out on reduced motion', () => {
    const props = new Set();
    for (const m of tr.matchAll(/\{\s*(transform|opacity|clipPath)\s*:/g)) props.add(m[1]);
    for (const m of tr.matchAll(/\banimate\(\[\s*\{\s*([a-zA-Z]+)\s*:/g)) props.add(m[1]);
    assert.deepEqual([...props].filter((p) => !['transform', 'opacity', 'clipPath'].includes(p)), []);
    for (const fn of ['playFlip', 'viewerExit', 'initAvatarFlights']) {
      const body = tr.slice(tr.indexOf(`export function ${fn}`));
      assert.match(body.slice(0, 600), /reduced\(\)/, `${fn} checks reduced motion`);
    }
  });

  test('timings come from the CSS tokens, not literals', () => {
    assert.match(tr, /getPropertyValue\(name\)/);
    assert.doesNotMatch(tr.replace(/^.*readTokens[\s\S]*?return tokens;\n\}/m, ''), /duration:\s*\d/);
  });

  test('flights are held on their first frame so a long build task cannot swallow them', () => {
    assert.match(tr, /function holdForFirstFrame\(anims\)[\s\S]*?x\.pause\(\)[\s\S]*?requestAnimationFrame/);
  });

  test('the viewer flies back into its card on close, but not when leaving through a link', () => {
    const lb = js('components/lightbox.js');
    assert.match(lb, /if \(!S\.silent\) viewerExit\(/);
    assert.match(lb, /function closeSilently\(\) \{ if \(S\) \{ S\.pushed = false; S\.silent = true; destroy\(\); \} \}/);
  });

  test('the creator page lands the avatar that was tapped', () => {
    assert.match(js('views/creator.js'), /landAvatar\(headAvatar, c\.id\)/);
  });

  test('ghosts never take a pointer', () => {
    assert.match(css, /\.fx-ghost, \.fx-ghost-avatar \{[^}]*pointer-events: none/);
    assert.match(css, /\.fx-scrim \{[^}]*pointer-events: none/);
  });
});
