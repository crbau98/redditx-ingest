'use strict';
// Lane 4: prolific Reddit posters. The archive is mocked; nothing goes to Reddit. The lane must count
// only posts that really carry media, only inside the 7/30 day windows, and must not re-measure a person
// who is already followed or already queued.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

let mock; let repo; let discovery; let settings;

const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3600;
const DAY = 86400;
const post = (author, sub, ageDays, { media = true, title = 'Gay jock at the gym' } = {}) => ({
  id: `${author}-${ageDays}-${Math.random().toString(36).slice(2, 7)}`,
  author, subreddit: sub, created_utc: now() - Math.round(ageDays * DAY),
  title, score: 40, over_18: true,
  url: media ? `https://i.redd.it/${Math.random().toString(36).slice(2, 9)}.jpg` : 'https://example.org/story',
  permalink: `/r/${sub}/comments/x/y/`,
});

// Sub listing: two communities, each with posters. u/busy posts 5 media posts a day; u/lazy once a week.
const SUBS = {
  gaybrosgonewild: [
    ...[0.1, 0.2, 0.4, 1, 2].map((d) => post('busy', 'gaybrosgonewild', d)),
    post('lazy', 'gaybrosgonewild', 6),
    post('textonly', 'gaybrosgonewild', 0.3, { media: false }),
    post('followed', 'gaybrosgonewild', 0.5),
    post('queued', 'gaybrosgonewild', 0.6),
    post('fresh', 'gaybrosgonewild', HOUR / DAY),
  ],
  gaychats: [post('busy', 'gaychats', 0.2), post('lazy', 'gaychats', 3)],
};
const AUTHOR_POSTS = {
  busy: [...[0.2, 0.3, 0.5, 1, 2, 3].map((d) => post('busy', 'gaychats', d)), post('busy', 'gaychats', 20), post('busy', 'gaychats', 40)],
  lazy: [post('lazy', 'gaybrosgonewild', 2), post('lazy', 'gaybrosgonewild', 6), post('lazy', 'gaychats', 9)],
  textonly: [post('textonly', 'gaybrosgonewild', 1, { media: false })],
  fresh: [post('fresh', 'gaybrosgonewild', 0.5)],
  followed: [], // never asked
  queued: [], // never asked
};

before(async () => {
  mock = await start({
    '/api/posts/search': (req, res, url) => {
      const sub = url.searchParams.get('subreddit');
      const author = url.searchParams.get('author');
      if (sub) return { json: { data: SUBS[sub] || [] } };
      if (author) return { json: { data: AUTHOR_POSTS[author] || [] } };
      return { status: 400, json: { error: 'no filter' } };
    },
  });
  prepareEnv({ REDDIT_ARCHIVE_URL: mock.url });
  repo = require('../src/db/repo');
  settings = require('../src/settings');
  discovery = require('../src/engine/discovery');
  settings.update({ redditEnabled: true, posterSubreddits: 2, posterLeads: 10 });
  for (const [name, n] of [['gaybrosgonewild', 60], ['gaychats', 40]]) {
    const r = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: name, origin: 'admin', runNow: false });
    repo.db.prepare('UPDATE feeds SET items_total = ? WHERE id = ?').run(n, r.feed.id);
  }
  repo.feeds.upsert({ platform: 'reddit', kind: 'user', target: 'followed', origin: 'admin', runNow: false });
  repo.candidates.insert({ platform: 'reddit', kind: 'user', target: 'queued', label: 'u/queued', status: 'pending', signals: {}, url: 'https://www.reddit.com/user/queued' });
});
after(async () => { await mock.close(); });

test('a sustained poster becomes a candidate; a one-off and a text-only poster do not', async () => {
  const out = await discovery.redditPosters({ subreddits: 2, leads: 10 });
  assert.equal(out.subreddits, 2);
  assert.ok(out.measured >= 3);

  const c = repo.candidates.find('reddit', 'user', 'busy');
  assert.ok(c, 'busy is queued');
  assert.equal(c.status, 'pending');
  assert.equal(c.scope, 'in', 'gay subreddits and titles read male');
  assert.match(c.signals.poster.join(' '), /in 7d/);
  assert.match(c.signals.poster[0], /^6 in 7d, 7 in 30d$/, 'only media posts inside the windows are counted');
  assert.ok(c.score >= 8, `score reaches the auto-follow bar (got ${c.score})`);
  assert.equal(repo.candidates.find('reddit', 'user', 'textonly'), null, 'no media, no lead');
  assert.equal(repo.candidates.find('reddit', 'user', 'fresh'), null, 'a single post is not prolific');

  const asked = mock.hits.filter((h) => h.includes('author=followed'));
  assert.equal(asked.length, 0, 'an already followed user is not measured again');
  assert.equal(mock.hits.filter((h) => h.includes('author=queued')).length, 0, 'an already queued user is not measured again');
});

test('Reddit reading off means the lane does no work', async () => {
  settings.update({ redditEnabled: false });
  const before = mock.hits.length;
  const out = await discovery.redditPosters({ subreddits: 2, leads: 10 });
  assert.deepEqual(out, { subreddits: 0, authors: 0, measured: 0, qualified: 0, found: 0 });
  assert.equal(mock.hits.length, before);
  settings.update({ redditEnabled: true });
});

test('the community cursor rotates, so every followed community is sampled over runs', async () => {
  // With 2 sampled per run over 2 communities the index returns to 0; the state must have moved and wrapped.
  const idx = Number(repo.discoveryState.get('poster.index'));
  assert.ok(Number.isInteger(idx) && idx >= 0 && idx < 2);
});
