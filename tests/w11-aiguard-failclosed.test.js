'use strict';
/**
 * The Telegram / Reddit text guard fails closed (Crucible wave 11, item 3): once the in-memory cache evicts a string,
 * or after a restart that loads only the newest rows, the persisted provenance tables still refuse it.
 */
const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

let aiguard;
before(() => {
  prepareEnv();
  aiguard = require('../src/lib/aiguard');
  aiguard._reset();
});

describe('aiguard fails closed', () => {
  test('a caption marked first is still refused after MAX_TAINT + 100 later marks', () => {
    const first = 'the very first telegram caption about a sunday morning gym session';
    aiguard.mark(first, 'telegram');
    for (let i = 0; i < aiguard.MAX_TAINT + 100; i++) aiguard.mark(`filler telegram caption number ${i} with enough length`, 'telegram');
    assert.equal(aiguard.tainted(first), true);
    assert.throws(() => aiguard.scrub({ bio: first }, 'triage'), (e) => e.aiGuard && e.source === 'telegram');
  });

  test('after a restart (memory cleared, database kept) old text is refused, alone or as one line of a longer string', () => {
    const caption = 'an older reddit title that a restart would not load back';
    aiguard.mark(caption, 'reddit');
    const { db } = require('../src/db/repo');
    const ins = db.prepare('INSERT OR IGNORE INTO reddit_text (norm) VALUES (?)');
    db.transaction(() => { for (let i = 0; i < aiguard.MAX_TAINT + 100; i++) ins.run(`newer reddit title number ${i} after the old one`); })();
    aiguard._reset({ keepDb: true }); // a restart: load() brings back only the newest MAX_TAINT rows
    assert.equal(aiguard.tainted(caption), true);
    assert.equal(aiguard.tainted(`Summary of accounts\n${caption}\nend`), true);
    assert.throws(() => aiguard.scrub({ q: `${caption} · more` }, 'search'), (e) => e.aiGuard && e.source === 'reddit');
    assert.equal(aiguard.tainted('a bluesky bio that never came from telegram or reddit'), false);
  });

  test('old text embedded in a longer string is refused, even among many stored strings with the same start', () => {
    const { db } = require('../src/db/repo');
    const ins = db.prepare('INSERT OR IGNORE INTO telegram_text (norm) VALUES (?)');
    db.transaction(() => { for (let i = 0; i < 5000; i++) ins.run(`shared opening words of caption ${i} and its tail`); })();
    for (let i = 0; i < aiguard.MAX_TAINT + 100; i++) aiguard.mark(`newest filler caption ${i} pushing the old ones out`, 'telegram');
    aiguard._reset({ keepDb: true });
    const old = 'shared opening words of caption 1234 and its tail';
    for (const v of [`bio: ${old}`, `Hello there. ${old} Thanks.`, `x, ${old}, y`, `{"bio":"${old}"}`, { prompt: `Describe this creator: ${old}` }]) {
      assert.equal(aiguard.tainted(v), true, JSON.stringify(v));
    }
    assert.equal(aiguard.tainted('bio: shared opening words of caption 1234 and its'), false, 'a cut-off copy is not a stored string');
    assert.equal(aiguard.tainted('bio: shared opening words of caption 99999 and its tail'), false, 'never stored');
  });
});
