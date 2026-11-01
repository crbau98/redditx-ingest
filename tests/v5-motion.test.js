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
// Tokens live in tokens.css now (P0-1 consolidation): the motion vocabulary guards read the whole shipped stylesheet.
const css = ['tokens.css', 'app.css'].map((f) => fs.readFileSync(path.join(pub, 'css', f), 'utf8')).join('\n');
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
    const allowed = lines.filter((l) => /--spring-(snap|glide|settle):/.test(l) || /--ease-out:/.test(l) || /\.live-dot::after/.test(l));
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

describe('v5 creator stage (phase 2)', () => {
  const cr = js('views/creator.js');

  test('the stage shows his best picture (highest-scored preview first) and tints from the same one', () => {
    assert.match(cr, /const art = \(c\.previews && c\.previews\[0\]\) \|\| c\.banner_url;/);
    assert.match(cr, /const tintFrom = art \|\| c\.avatar_url;/);
  });

  test('the wash is drawn above the colour tint, so the stage always ends on plain background', () => {
    assert.ok(cr.indexOf("class: 'stage-tint'") < cr.indexOf("class: 'stage-wash'"));
  });

  test('the scroll drift is compositor-only, scroll-driven, and off for reduced motion', () => {
    const kf = css.match(/@keyframes stage-drift \{([^}]*)\}/)[1];
    assert.doesNotMatch(kf.replace(/transform/g, ''), /[a-z-]+\s*:/);
    assert.match(css, /@supports \(animation-timeline: scroll\(\)\) \{\s*@media \(prefers-reduced-motion: no-preference\) \{\s*\.stage-img \{ animation: stage-drift/);
  });

  test('the tint arrives as an opacity fade, never an animated gradient', () => {
    assert.match(css, /\.stage-tint \{ opacity: 0; transition: opacity var\(--dur-slow\)/);
  });

  test('stats count up once per creator per visit, and Free on lists his free accounts', () => {
    assert.match(cr, /if \(!counted\.has\(c\.id\)\) countUp\(/);
    assert.match(cr, /class: 'free-on'/);
    assert.match(cr, /c\.onlyfans && c\.onlyfans\.free\) freeOn\.unshift/);
  });

  test('no :has() in the stage styles (it made feed style work ~45% worse in v4.16)', () => {
    const v5 = css.slice(css.indexOf('the creator stage'));
    assert.doesNotMatch(v5, /:has\(/);
  });
});

test('morphs scale about the centre even though the viewer image keeps a 0 0 origin for pinch-zoom', () => {
  const tr = js('components/transitions.js');
  assert.match(tr, /const moveA = \{ transform: [^\n]*, transformOrigin: '50% 50%' \};/);
  assert.match(tr, /const moveB = \{ transform: [^\n]*, transformOrigin: '50% 50%' \};/);
});
