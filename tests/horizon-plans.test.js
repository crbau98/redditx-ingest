'use strict';
/**
 * The two public sorts that used to build a temporary table: popular creators (COALESCE hid the
 * popularity index) and ingested media (the index stopped before seq). Server-Timing is on both routes.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv();
const repo = require('../src/db/repo');
const { db } = repo;

const plans = [];
const orig = db.prepare.bind(db);
db.prepare = (sql) => {
  const stmt = orig(sql);
  if (!/^\s*SELECT /.test(sql) || /COUNT\(\*\)/.test(sql)) return stmt;
  const all = stmt.all.bind(stmt);
  stmt.all = (...args) => {
    if (/ORDER BY c\.popularity DESC/.test(sql) || /INDEXED BY ix_media_pub_ingested/.test(sql)) {
      plans.push(orig(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(' | '));
    }
    return all(...args);
  };
  return stmt;
};

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

before(() => {
  for (let i = 0; i < 40; i++) {
    const c = repo.creators.create({ handle: `plan_${i}`, displayName: `Plan ${i}` });
    repo.db.prepare('UPDATE creators SET popularity = ?, last_media_at = ?, media_count = ?, total_score = ?, status = \'active\', scope = \'in\' WHERE id = ?')
      .run(i, daysAgo(i % 30), 5 + (i % 7), i * 10, c.id);
    repo.media.insert({
      creator_id: c.id, platform: 'reddit', source_id: `plan${i}`, source_key: `reddit:plan${i}:0`, post_key: `reddit:plan${i}`,
      author: c.handle, title: `plan post ${i}`, media_type: 'image', media_url: `https://i.redd.it/plan${i}.jpg`, hash: `planh${i}`,
      posted_at: daysAgo(i), ingested_at: daysAgo(i), score: i,
    });
  }
});

test('popular creators walk the popularity index and do not sort the table', () => {
  plans.length = 0;
  const page = repo.creators.list({ sort: 'popular', limit: 8 });
  assert.equal(page.items.length, 8);
  assert.ok(page.items[0].popularity >= page.items[1].popularity);
  const plan = plans.find((p) => /ix_creators_popular_active/.test(p));
  assert.ok(plan, plans.join('\n'));
  assert.match(plan, /(?:SCAN|SEARCH) c USING INDEX ix_creators_popular_active/);
});

test('ingested media walks ingested_at, seq and does not sort', () => {
  plans.length = 0;
  const page = repo.media.list({ sort: 'ingested', limit: 8 });
  assert.equal(page.items.length, 8);
  const plan = plans.find((p) => /ix_media_pub_ingested/.test(p));
  assert.ok(plan, plans.join('\n'));
  assert.doesNotMatch(plan, /TEMP B-TREE FOR ORDER BY/);
});

test('media and creator lists report Server-Timing', async () => {
  const { createApp } = require('../src/app');
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/api/media?sort=recent&limit=5', '/api/creators?sort=popular&limit=5']) {
      const res = await fetch(base + path, { headers: { cookie: 'prism_age=1' } });
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('server-timing') || '', /^app;dur=\d+(\.\d+)?$/, path);
      const body = await res.json();
      assert.ok(body.items.length > 0, path);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('creator cards ask for the 360px thumb before the platform preview', () => {
  assert.match(repo.SELECT_CREATOR_CARD, /COALESCE\(m\.thumb_url, m\.preview_url, m\.thumbnail_url/);
  assert.match(repo.SELECT_CREATOR_CARD, /json_object\(\s*'u'/);
  assert.match(repo.SELECT_CREATOR_CARD, /'f'/);
});

test('topic mosaics prefer the 360px thumb and keep the next still', () => {
  const c = repo.creators.create({ handle: 'topic_still', displayName: 'Topic' });
  const id = repo.media.insert({
    creator_id: c.id, platform: 'reddit', source_id: 'ts1', source_key: 'reddit:ts1:0', post_key: 'reddit:ts1',
    author: 'topic_still', title: 'still', media_type: 'image', media_url: 'https://i.redd.it/ts.jpg',
    preview_url: 'https://i.redd.it/ts-preview.jpg', hash: 'tsh1', posted_at: daysAgo(1), score: 50,
  }, ['kettlebell', 'barbell', 'plates']);
  assert.ok(id);
  db.prepare('UPDATE media SET thumb_url = ? WHERE id = ?').run('https://store/ts.webp', id);
  const topics = repo.tagIntel.topics({ minCount: 1 });
  const hit = topics.find((t) => t.tags.includes('kettlebell'));
  assert.ok(hit, topics.map((t) => t.tags.join('+')).join(' | '));
  assert.equal(hit.previews[0], 'https://store/ts.webp');
  assert.equal(hit.previewFalls[0], 'https://i.redd.it/ts-preview.jpg');
});

test('a dead creator-card thumb can step to the platform preview', () => {
  const c = repo.creators.create({ handle: 'fall_one', displayName: 'Fall' });
  const withThumb = repo.media.insert({
    creator_id: c.id, platform: 'reddit', source_id: 'fall1', source_key: 'reddit:fall1:0', post_key: 'reddit:fall1',
    author: 'fall_one', title: 'fall', media_type: 'image', media_url: 'https://i.redd.it/fall.jpg',
    preview_url: 'https://i.redd.it/fall-preview.jpg', hash: 'fallh1', posted_at: daysAgo(1), score: 3,
  });
  assert.ok(withThumb);
  db.prepare('UPDATE media SET thumb_url = ? WHERE id = ?').run('https://store/fall.webp', withThumb);
  const card = repo.creators.detail(c.id);
  assert.equal(card.previews[0], 'https://store/fall.webp');
  assert.equal(card.previewFalls[0], 'https://i.redd.it/fall-preview.jpg');
  const previewOnly = repo.media.insert({
    creator_id: c.id, platform: 'reddit', source_id: 'fall2', source_key: 'reddit:fall2:0', post_key: 'reddit:fall2',
    author: 'fall_one', title: 'preview only', media_type: 'image', media_url: 'https://i.redd.it/fall2.jpg',
    preview_url: 'https://i.redd.it/fall2-preview.jpg', hash: 'fallh2', posted_at: daysAgo(0), score: 9,
  });
  assert.ok(previewOnly);
  const again = repo.creators.detail(c.id);
  assert.equal(again.previews[0], 'https://i.redd.it/fall2-preview.jpg');
  assert.equal(again.previewFalls[0], null);
  assert.equal(again.previews[1], 'https://store/fall.webp');
  assert.equal(again.previewFalls[1], 'https://i.redd.it/fall-preview.jpg');
  const { publicCreator } = require('../src/routes/public');
  const pub = publicCreator(again);
  assert.deepEqual(pub.previews, again.previews);
  assert.deepEqual(pub.previewFalls, again.previewFalls);
});
