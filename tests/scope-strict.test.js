'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classify, femaleCheck } = require('../src/lib/scope');

const excluded = (t, o) => assert.equal(classify(t, o).scope, 'excluded', `should exclude: ${JSON.stringify(t)}`);
const inScope = (t, o) => assert.equal(classify(t, o).scope, 'in', `should accept: ${JSON.stringify(t)}`);
const review = (t, o) => { const c = classify(t, o); assert.equal(c.scope, 'uncertain', `should hold: ${JSON.stringify(t)}`); assert.equal(c.femaleSoft, true); };

describe('male-only scope: hard exclusions win over every male signal and over feed trust', () => {
  const female = [
    'busty milf', 'lesbian couple', '[F] new here', '(f) first post', '[f25] hi', '(25f) hello', 'f4m looking', 'F4F', 'm4f gay bar', 'mf', 'mmf threesome', 'M/F',
    'my wife and I', 'hotwife gay', 'girlfriend gay bf', 'hot girls gay guys', 'woman', 'women of reddit gay men', 'she loves it', 'her gay friend', 'female gay', 'ladies night gay',
    'big boobs gay', 'bbw', 'pawg', 'mommy gay', 'MILF gay daddy', 'vagina gay', 'GirlsGoneWild gay', 'gone_wild_girls gay', 'SexyGirl92', 'xX_girl_Xx gay',
    'shemale', 'she-male gay', 'tranny', 'ladyboy gay', 'tgirl', 't-girl gay', 'trans girl gay', 'trans woman', 'transgender gay', 'transsexual', 'trans gay men', 'ts model gay', 'mtf gay',
    'femboy', 'femboy_uwu gay', 'FemboyUwU', 'femboi gay', 'sissy gay', 'sissification gay', 'feminization gay', 'feminine gay', 'crossdresser gay', 'cross-dressing gay', 'drag queen gay', 'futanari gay', 'bimbo gay', 'girly gay',
    'ニューハーフ ゲイ', '男の娘 ゲイ', '女装 ゲイ', '女 ゲイ', 'おっぱい ゲイ', '人妻 ゲイ', 'ふたなり', '여자 게이', 'ผู้หญิง', 'กะเทย',
    'mujer gay', 'chica gay', 'garota gay', 'mulher gay', 'madchen gay', 'девушка гей', 'женщина гей', 'ftm gay', 'm4t', 't4m', '20 top bottom and fems dm me x', 'looking for fems',
  ];
  for (const t of female) test(`excluded: ${t}`, () => { excluded(t); excluded(t, { trusted: true }); });

  test('rule names the reason', () => {
    assert.match(classify('f4m but also gay', { trusted: true }).rule, /^female:/);
    assert.equal(classify('f4m but also gay', { trusted: true }).female, true);
  });
});

describe('male-only scope: gay-male posts are accepted', () => {
  const male = [
    'hung gay stud', 'Gym selfie gay', 'bear hug', 'bearded daddy', 'muscle jock', 'm4m', '[M] 28 here', '(m) hi', 'twink', 'otter', 'jockstrap bulge', 'big traps and delts gay',
    'trapezius gay men', 'Gladys and the gay bros', 'the shell game gay', 'softmax gay bros', 'gay couple on the beach', 'hairy men', 'ゲイ', 'ガチムチ筋肉', '筋肉', 'гей мужчины', '게이',
    'hombres gay', 'homem gay', 'schwul',
  ];
  for (const t of male) test(`accepted: ${t}`, () => inScope(t));
  test('trusted feeds accept text without any gender wording', () => inScope('sunset beach', { trusted: true }));
  test('untrusted feeds need a male signal', () => { assert.equal(classify('sunset beach').scope, 'uncertain'); inScope('gay sunset'); });
});

describe('male-only scope: ambiguous / feminine-adjacent wording is always held for a human', () => {
  for (const t of ['boy pussy gay', 'man tits gay', 'gay manpussy', 'gay lingerie', 'panties gay men', 'heels gay', 'makeup gay', 'non-binary gay', 'enby gay', 'babe gay', 'trap gay', 'cuck gay'])
    test(`held: ${t}`, () => { review(t); review(t, { trusted: true }); });
});

describe('femaleCheck (creators, handles, bios, feeds)', () => {
  test('hard / soft / none', () => {
    assert.equal(femaleCheck('SexyGirl92').level, 'hard');
    assert.equal(femaleCheck('femboy_uwu', 'UwU').level, 'hard');
    assert.equal(femaleCheck('Just a gay guy', 'he/him').level, null);
    assert.equal(femaleCheck('bio', 'lingerie model').level, 'soft');
    assert.equal(femaleCheck(null, undefined, '').level, null);
  });
  test('camelCase handles are read word by word', () => {
    assert.equal(femaleCheck('CrossDresserDiary').level, 'hard');
    assert.equal(femaleCheck('GayBrosGoneWild').level, null);
  });
});

describe('male evidence: strong vs weak, and the search query never counts', () => {
  test('anatomy / relationship words alone are not enough for an open feed', () => {
    for (const t of ['big cock', 'thick dick blowjob', 'hot bulge', 'my boyfriend and me', 'abs and pecs', 'bros']) assert.equal(classify(t).scope, 'uncertain', t);
    for (const t of ['big cock', 'my boyfriend']) assert.equal(classify(t, { trusted: true }).scope, 'in', 'trusted communities are unaffected');
    assert.equal(classify('big cock gay').scope, 'in');
  });
  test('soft female wording without a male statement of its own is excluded, not queued', () => {
    assert.equal(classify('Amateur Big Tits OnlyFans Tits', { screen: ['gay'] }).scope, 'excluded');
    assert.equal(classify('Amateur Boobs Cute Pussy Solo').scope, 'excluded');
    assert.equal(classify('gay guy in panties').scope, 'uncertain');
  });
  test('the query a feed ran is screened for female words but is never male evidence', () => {
    assert.equal(classify('Amateur Cum Cumshot', { screen: ['gay'] }).scope, 'uncertain');
    assert.equal(classify('Amateur Cum Cumshot', { screen: ['lesbian'] }).scope, 'excluded');
    assert.equal(classify('Amateur Cum Gay', { screen: ['gay'] }).scope, 'in');
  });
});
