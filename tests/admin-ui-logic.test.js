'use strict';
/**
 * Admin console logic (public/js/views/admin/logic.js and settings-model.js): the pure rules behind the screens.
 * What a feed error means, which queues need attention first, how throughput compares with yesterday, how settings are
 * grouped and searched, and what can be undone.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { prepareEnv } = require('./helpers/mock');

const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'views', 'admin', f)).href);
let L; let S; let SCHEMA; let settingsStore;
before(async () => {
  prepareEnv({ MEDIA_STORE: 'disk' });
  L = await load('logic.js');
  S = await load('settings-model.js');
  settingsStore = require('../src/settings');
  SCHEMA = settingsStore.describe();
});

describe('review queue', () => {
  test('holdOf reads the gate reason in words', () => {
    assert.deepEqual(L.holdOf('safety: minor-keyword (community)').rule, 'minor-keyword');
    assert.equal(L.holdOf('safety: age-claim').kind, 'safety');
    assert.equal(L.holdOf('scope:unclear').kind, 'scope');
    assert.equal(L.holdOf('physique:heavy').kind, 'other');
    assert.equal(L.holdOf('').label, 'Held for review');
  });
  test('a telegram post with no creator named reads as such, and stays in the other kind', () => {
    const h = L.holdOf('attribution:telegram-ambiguous');
    assert.equal(h.label, 'Creator not named');
    assert.equal(h.kind, 'other');
    assert.equal(L.AMBIGUOUS_REASON, 'attribution:telegram-ambiguous');
  });
  test('a telegram post with no creator is never published by a bulk or whole-hold approve; hide and remove still work', () => {
    const ambig = 'attribution:telegram-ambiguous';
    assert.equal(L.canPublishWithoutCreator(ambig), false);
    assert.equal(L.canPublishWithoutCreator('safety: age-claim'), true);
    assert.equal(L.canPublishWithoutCreator(''), true);
    assert.equal(L.reasonClearBody(ambig, 'approve'), null);
    assert.deepEqual(L.reasonClearBody(ambig, 'hide'), { reason: ambig, action: 'hide' });
    assert.deepEqual(L.reasonClearBody(ambig, 'reject'), { reason: ambig, action: 'reject' });
    assert.deepEqual(L.reasonClearBody('safety: age-claim', 'approve'), { reason: 'safety: age-claim', action: 'approve' });
  });
  test('approve, hide and remove can be undone by sending the item back to review; a block cannot', () => {
    for (const a of ['approve', 'hide', 'reject']) assert.equal(L.undoPlan(a).undoAction, 'flag', a);
    assert.equal(L.undoPlan('block'), null);
    assert.equal(L.undoPlan('nonsense'), null);
    assert.equal(L.undoPlan('approve').verb, 'Published');
  });
  test('undo is ONE request: every item under the hold reason it was waiting under (ids alone, or no reason, fall under "undo")', () => {
    const items = [{ id: 'a', review_reason: 'safety: age-claim' }, { id: 'b', review_reason: 'scope:unclear' }, { id: 'c', review_reason: 'safety: age-claim' }, { id: 'd', review_reason: null }];
    assert.deepEqual(L.sendBackBody(items), { ids: ['a', 'b', 'c', 'd'], action: 'flag', reason: 'undo',
      reasons: { a: 'safety: age-claim', b: 'scope:unclear', c: 'safety: age-claim' } });
    assert.deepEqual(L.sendBackBody(['x', 'y']), { ids: ['x', 'y'], action: 'flag', reason: 'undo', reasons: {} });
    assert.deepEqual(L.sendBackBody([]).ids, []);
    // and the queue words an undone safety hold the way it did before
    assert.equal(L.holdOf(L.sendBackBody(items).reasons.a).rule, 'age-claim');
  });
  test('in the media browser an action is undone by returning the items to the state they were in', () => {
    assert.equal(L.undoActionFor('published'), 'approve');
    assert.equal(L.undoActionFor('review'), 'flag');
    assert.equal(L.undoActionFor('hidden'), 'hide');
    assert.equal(L.undoActionFor('removed'), 'reject');
    assert.equal(L.undoActionFor('all'), null);
  });
  test('selection summary counts the kinds', () => {
    const items = [{ review_reason: 'safety: x' }, { review_reason: 'scope:unclear' }, { review_reason: 'scope:unclear' }, { review_reason: 'physique:heavy' }];
    assert.equal(L.selectionSummary(items), '4 selected · 1 safety · 2 male focus unclear');
    assert.equal(L.selectionSummary([]), '0 selected');
  });
  test('a whole hold is one request body, and block or a blank reason is refused', () => {
    assert.deepEqual(L.reasonClearBody(' scope:unclear ', 'hide'), { reason: 'scope:unclear', action: 'hide' });
    assert.equal(L.reasonClearBody('scope:unclear', 'block'), null);
    assert.equal(L.reasonClearBody('scope:unclear', 'flag'), null);
    assert.equal(L.reasonClearBody('  ', 'approve'), null);
    assert.equal(L.reasonClearBody('x'.repeat(201), 'approve'), null);
    assert.equal(L.REASON_CHUNK, 500);
    assert.equal(L.REASON_ROUNDS, 40);
  });
  test('only a hold with more rows than this page offers a one-action clear', () => {
    const counts = [{ reason: 'scope:unclear', n: 9000 }, { reason: 'safety: age-claim', n: 2 }, { reason: '', n: 4 }, { reason: 'physique:heavy', n: 3 }];
    const onPage = [{ review_reason: 'safety: age-claim' }, { review_reason: 'safety: age-claim' }, { review_reason: 'physique:heavy' }];
    const rows = L.reasonActions(counts, onPage);
    assert.deepEqual(rows.map((r) => r.reason), ['scope:unclear', 'physique:heavy']);
    assert.equal(rows[0].n, 9000);
    assert.equal(rows[0].label, 'Male focus unclear');
    assert.equal(rows[1].kind, 'other');
    assert.deepEqual(L.reasonActions(null, []), []);
  });
  test('the confirm names a safety rule and says the action covers rows that are not on this page', () => {
    const safety = L.reasonClearCopy('safety: age-claim', 'approve', 12);
    assert.match(safety.title, /Publish all 12/);
    assert.match(safety.sub, /not on this page/);
    assert.match(safety.sub, /age-claim/);
    assert.equal(safety.cls, 'good');
    const hide = L.reasonClearCopy('scope:unclear', 'hide', 9000);
    assert.match(hide.title, /Hide all 9000/);
    assert.match(hide.sub, /not on this page/);
    assert.equal(L.reasonClearCopy('scope:unclear', 'block', 3), null);
  });
  test('undo of a whole hold is split into bulk-sized requests, each item under that reason', () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const chunks = L.reasonUndoChunks(ids, 'scope:unclear');
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].ids.length, 500);
    assert.equal(chunks[1].ids.length, 1);
    assert.equal(chunks[0].action, 'flag');
    assert.equal(chunks[0].reasons['id-0'], 'scope:unclear');
    assert.equal(chunks[1].reasons['id-500'], 'scope:unclear');
    assert.deepEqual(L.reasonUndoChunks([null, 4, 'ok'], 'scope:unclear'), [L.sendBackBody([{ id: 'ok', review_reason: 'scope:unclear' }])]);
  });
});

describe('feed errors in plain words', () => {
  const cases = [
    ['HTTP 403 Forbidden (blocked by the host)', 'blocked', 'retry'],
    ['Reddit answered 429 Too Many Requests on all transports', 'rate', 'retry'],
    ['Account not found (renamed or deleted?)', 'gone', 'pause'],
    ['Timeout after 20s reading https://bsky.social', 'network', 'retry'],
    ['RSS parse error: not well-formed XML at line 1', 'format', 'pause'],
    ['X: bearer token rejected (401)', 'credentials', 'credentials'],
    ['something odd', 'unknown', 'retry'],
  ];
  for (const [err, kind, fix] of cases) {
    test(`${err.slice(0, 40)} → ${kind} / ${fix}`, () => {
      const r = L.explainFeedError(err, 3);
      assert.equal(r.kind, kind); assert.equal(r.fix, fix);
      assert.ok(r.plain.endsWith('.') && r.fixLabel);
    });
  }
  test('a source that has failed ten runs in a row is paused, not retried', () => {
    assert.equal(L.explainFeedError('HTTP 403', 30).fix, 'pause');
    assert.equal(L.explainFeedError('Timeout', 12).fix, 'pause');
    assert.equal(L.explainFeedError('HTTP 403', 9).fix, 'retry');
  });
  test('a missing error still says something', () => {
    assert.match(L.explainFeedError('', 1).plain, /without saying why/);
    assert.match(L.explainFeedError(null, 1).plain, /without saying why/);
  });
});

describe('feeds list', () => {
  test('paused is the switched-off feeds; error, ok and never are server statuses', () => {
    assert.deepEqual(L.feedQuery({ status: 'paused', platform: 'x', q: 'a', page: 2 }), { platform: 'x', kind: '', q: 'a', page: 2, enabled: '0' });
    assert.equal(L.feedQuery({ status: 'error' }).status, 'error');
    assert.equal(L.feedQuery({ status: 'never' }).status, 'never');
    assert.equal(L.feedQuery({ status: '' }).status, undefined);
    assert.equal(L.feedQuery({ status: '' }).enabled, undefined);
  });
  test('status labels', () => {
    assert.equal(L.feedStatusLabel({ enabled: 0 }), 'Paused');
    assert.equal(L.feedStatusLabel({ enabled: 1, last_status: 'error', last_run_at: 'x' }), 'Failing');
    assert.equal(L.feedStatusLabel({ enabled: 1, last_status: null, last_run_at: null }), 'Not run yet');
    assert.equal(L.feedStatusLabel({ enabled: 1, last_status: 'ok', last_run_at: 'x' }), 'Healthy');
  });
  test('worstFailing shows the worst first and counts the rest', () => {
    const f = [1, 9, 4, 30, 2, 7, 3].map((failures, i) => ({ id: i, failures }));
    const w = L.worstFailing(f, 3);
    assert.deepEqual(w.shown.map((x) => x.failures), [30, 9, 7]);
    assert.equal(w.more, 4);
    assert.deepEqual(L.worstFailing([], 5), { shown: [], more: 0 });
  });
});

describe('throughput', () => {
  const now = Date.UTC(2026, 10, 5, 15, 30);
  const key = (hoursAgo) => new Date(Math.floor(now / 3600000) * 3600000 - hoursAgo * 3600000).toISOString().slice(0, 13);
  test('compares the last 24 hours with the 24 before', () => {
    const buckets = [
      { hour: key(0), added: 10, runs: 4, errors: 1 }, { hour: key(5), added: 30, runs: 6, errors: 0 }, { hour: key(23), added: 5, runs: 2, errors: 2 },
      { hour: key(24), added: 20, runs: 5, errors: 0 }, { hour: key(40), added: 20, runs: 3, errors: 0 },
    ];
    const t = L.throughput(buckets, now);
    assert.equal(t.slots.length, 48);
    assert.equal(t.added24, 45); assert.equal(t.addedPrev24, 40);
    assert.equal(t.runs24, 12); assert.equal(t.errors24, 3);
    assert.equal(t.trend, 'up'); assert.equal(t.deltaPct, 13);
    assert.deepEqual(t.peak, { key: key(5), added: 30 });
    assert.equal(L.trendText(t), '↑ 13% on the day before');
  });
  test('quiet days read sensibly', () => {
    const none = L.throughput([], now);
    assert.equal(none.added24, 0); assert.equal(none.peak, null); assert.equal(none.trend, 'same');
    assert.equal(L.trendText(none), 'nothing yet');
    const fresh = L.throughput([{ hour: key(1), added: 4, runs: 1, errors: 0 }], now);
    assert.equal(L.trendText(fresh), 'nothing the day before');
    const down = L.throughput([{ hour: key(1), added: 5, runs: 1, errors: 0 }, { hour: key(30), added: 10, runs: 1, errors: 0 }], now);
    assert.equal(L.trendText(down), '↓ 50% on the day before');
    const same = L.throughput([{ hour: key(1), added: 5, runs: 1, errors: 0 }, { hour: key(30), added: 5, runs: 1, errors: 0 }], now);
    assert.equal(L.trendText(same), 'same as the day before');
  });
  test('buckets outside the 48-hour window are ignored', () => {
    assert.equal(L.throughput([{ hour: key(60), added: 99, runs: 1, errors: 0 }], now).addedPrev24, 0);
  });
  test('a source with nothing today and something in the window is quiet, and it sorts first', () => {
    const rows = L.sourceYield([
      { day: '2026-11-05', platform: 'reddit', n: 4 },
      { day: '2026-11-04', platform: 'reddit', n: 9 },
      { day: '2026-11-05', platform: 'bluesky', n: 0 },
      { day: '2026-11-03', platform: 'telegram', n: 2 },
      { day: '2026-11-01', platform: 'x', n: 1 },
    ], Date.UTC(2026, 10, 5, 18));
    assert.equal(rows.find((r) => r.platform === 'reddit').today, 4);
    assert.equal(rows.find((r) => r.platform === 'reddit').yesterday, 9);
    assert.equal(rows.find((r) => r.platform === 'reddit').quiet, false);
    assert.equal(rows.find((r) => r.platform === 'telegram').quiet, true);
    assert.equal(rows.find((r) => r.platform === 'telegram').today, 0);
    assert.equal(rows[0].quiet, true);
    const ov = fs.readFileSync(path.join(__dirname, '../public/js/views/admin/overview.js'), 'utf8');
    assert.match(ov, /sourceCard\(\)/);
    assert.match(ov, /0 today/);
  });
});

describe('needs attention', () => {
  const o = { queues: { review: 26, reports: 3 }, feeds: { failing: 5 }, identity: { pending: 2 }, discovery: { pending: 40 } };
  test('reports first, then broken ingestion, then work waiting, then leads', () => {
    assert.deepEqual(L.attentionItems(o, { retired: 4 }).map((r) => r.key), ['reports', 'failing', 'review', 'retired', 'identities', 'discovery']);
  });
  test('only queues with something in them', () => {
    const rows = L.attentionItems({ queues: { review: 0, reports: 0 }, feeds: { failing: 0 } });
    assert.deepEqual(rows, []);
    assert.deepEqual(L.attentionItems({ queues: { review: 2, reports: 0 }, feeds: { failing: 0 } }).map((r) => r.key), ['review']);
  });
  test('rows link to the screen that handles them, filtered', () => {
    const rows = Object.fromEntries(L.attentionItems(o, { retired: 1 }).map((r) => [r.key, r]));
    assert.deepEqual(rows.failing.query, { status: 'error' });
    assert.deepEqual(rows.retired.query, { status: 'paused' });
    assert.equal(rows.review.to, 'moderation');
    assert.equal(rows.reports.tone, 'bad');
  });
  test('missing or odd numbers never produce a row', () => {
    assert.deepEqual(L.attentionItems({}), []);
    assert.deepEqual(L.attentionItems({ queues: { review: NaN, reports: -1 }, feeds: { failing: undefined } }), []);
  });
  test('body filter line', () => {
    assert.equal(L.physiqueLine(null), '');
    assert.match(L.physiqueLine({ enabled: false }), /off/);
    assert.match(L.physiqueLine({ enabled: true, threshold: 45, hidden: 12, creatorsHidden: 2 }), /45\+ of 100 · 12 pictures and 2 creators/);
  });
  test('the phone keeps four sections one tap away', () => {
    assert.deepEqual(L.PHONE_NAV, ['overview', 'moderation', 'feeds', 'settings']);
  });
});

describe('settings, grouped and searchable', () => {
  const FEATURED = ['physiqueFilter', 'physiqueThreshold', 'physiqueCreatorShare', 'autoRetireFeeds', 'keepRunHistoryDays'];
  const values = () => settingsStore.get();

  test('the five newest settings exist and are described in plain words', () => {
    for (const k of FEATURED) {
      const def = SCHEMA.find((d) => d.key === k);
      assert.ok(def, `${k} is a setting`);
      const d = S.describeSetting(def);
      assert.ok(d.known, `${k} has a description`);
      assert.ok(d.title.length > 5 && d.hint.length > 30, k);
      assert.ok(d.hint.split(/[.!?] /).length <= 2 && d.hint.length <= 200, `${k}: one sentence`);
    }
  });
  test('body filter and feed housekeeping come first and open', () => {
    const m = S.buildSettingsModel(SCHEMA, values());
    assert.deepEqual(m.groups.slice(0, 2).map((g) => g.id), ['body', 'feeds']);
    assert.ok(m.groups[0].open && m.groups[1].open);
    assert.deepEqual(m.groups[0].items.map((i) => i.key), ['physiqueFilter', 'physiqueThreshold', 'physiqueCreatorShare']);
    assert.ok(m.groups[1].items.map((i) => i.key).includes('autoRetireFeeds'));
    assert.ok(m.groups[1].items.map((i) => i.key).includes('keepRunHistoryDays'));
  });
  test('every setting the console shows has a title and a group, listed or not', () => {
    const m = S.buildSettingsModel(SCHEMA, values());
    const ids = new Set(S.GROUPS.map((g) => g.id));
    let n = 0;
    for (const g of m.groups) for (const i of g.items) { n++; assert.ok(ids.has(g.id)); assert.ok(i.title && i.title.length <= 141, i.key); }
    assert.equal(n, m.total);
    assert.equal(m.total, SCHEMA.filter((d) => d.group !== 'discovery').length, 'discovery settings stay on the Discovery page');
    assert.ok(!m.groups.flatMap((g) => g.items).some((i) => i.def.group === 'discovery'));
  });
  test('the catalog covers (almost) every setting, so nothing falls into Other', () => {
    const m = S.buildSettingsModel(SCHEMA, values());
    const other = m.groups.find((g) => g.id === 'other');
    const unknown = other ? other.items.length : 0;
    assert.ok(unknown <= Math.ceil(m.total * 0.1), `${unknown} settings without a description: ${other && other.items.map((i) => i.key)}`);
  });
  test('an unknown setting still shows, with the first sentence of the server label', () => {
    const def = { key: 'brandNewThing', type: 'bool', default: false, label: 'Does a new thing: it is long, and it goes on. And on.', group: 'sources' };
    const d = S.describeSetting(def);
    assert.equal(d.known, false); assert.equal(d.group, 'sources'); assert.equal(d.title, 'Does a new thing');
    const m = S.buildSettingsModel([def], { brandNewThing: false });
    assert.equal(m.groups[0].items[0].key, 'brandNewThing');
    assert.equal(S.firstSentence('x'.repeat(300)).length, 138);
    assert.equal(S.firstSentence(''), '');
  });
  test('search matches the title, the sentence, the key and the group name; every word must match', () => {
    const find = (query) => S.buildSettingsModel(SCHEMA, values(), { query });
    assert.ok(find('physique').groups[0].items.some((i) => i.key === 'physiqueThreshold'), 'by key');
    assert.ok(find('older').groups[0].items.some((i) => i.key === 'physiqueFilter'), 'by sentence');
    assert.ok(find('stricter').shown >= 2);
    assert.ok(find('BACKUP').groups.some((g) => g.items.some((i) => i.key === 'backupEnabled')), 'case-insensitive');
    assert.ok(find('body filter').shown >= 3, 'by group name');
    assert.equal(find('zzzz nothing matches').shown, 0);
    assert.equal(find('zzzz nothing matches').groups.length, 0);
    assert.ok(find('physique stricter').shown <= find('physique').shown, 'more words narrow it');
    assert.equal(find('').shown, find('   ').shown, 'blank query is no filter');
  });
  test('changed-from-default is detected and can be the only thing shown', () => {
    const v = values();
    assert.equal(S.buildSettingsModel(SCHEMA, v).changed, 0, 'defaults are not changes');
    const edited = { ...v, physiqueThreshold: 30, keepRunHistoryDays: 7 };
    const m = S.buildSettingsModel(SCHEMA, edited);
    assert.equal(m.changed, 2);
    const only = S.buildSettingsModel(SCHEMA, edited, { changedOnly: true });
    assert.deepEqual(only.groups.flatMap((g) => g.items.map((i) => i.key)).sort(), ['keepRunHistoryDays', 'physiqueThreshold']);
    assert.equal(S.isChanged({ default: 45 }, '45'), false);
    assert.equal(S.isChanged({ default: true }, false), true);
    assert.equal(S.isChanged({ default: '' }, 'a\r\nb'), true);
    assert.equal(S.isChanged({ default: 1 }, undefined), false);
  });
  test('live sentences for the sliders', () => {
    assert.match(S.liveHint('physiqueThreshold', 30, { physique: { enabled: true, hidden: 12 } }), /30 or more out of 100 \(strict\)\. 12 pictures are hidden right now\./);
    assert.match(S.liveHint('physiqueThreshold', 45), /balanced/);
    assert.match(S.liveHint('physiqueThreshold', 70), /relaxed/);
    assert.equal(S.liveHint('physiqueCreatorShare', 0), 'Never hides a whole creator.');
    assert.match(S.liveHint('physiqueCreatorShare', 30), /30% of his measured pictures/);
    assert.equal(S.liveHint('keepRunHistoryDays', 1), 'Run records older than 1 day are cleared.');
    assert.equal(S.liveHint('somethingElse', 3), '');
  });
});
