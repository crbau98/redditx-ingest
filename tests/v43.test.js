'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, prepareEnv } = require('./helpers/mock');

const TG = '123456:ABCDEFGHIJKLMNOPQRSTUVWX';
let server; let base; let mock; let repo; let engine; let backup; let discovery; let settings;
const state = { braveCalls: 0, braveKey: null, braveResults: {}, followsOf: {}, xPages: 0 };
const ADMIN = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };
const adm = async (p, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}/api/admin${p}`, { method, headers: ADMIN, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};

before(async () => {
  mock = await start({
    '/res/v1/web/search': (req, res, url) => {
      state.braveCalls++; state.braveKey = req.headers['x-subscription-token'];
      const q = url.searchParams.get('q');
      const hit = Object.entries(state.braveResults).find(([k]) => q.includes(k));
      return { json: { web: { results: hit ? hit[1] : [] } } };
    },
    '/xrpc/app.bsky.graph.getFollows': (req, res, url) => ({ json: { follows: state.followsOf[url.searchParams.get('actor')] || [] } }),
    '/xrpc/app.bsky.actor.getProfiles': (req, res, url) => ({ json: { profiles: url.searchParams.getAll('actors').map((h) => ({ handle: h, displayName: `Name of ${h}`, description: h.startsWith('safe') ? 'gay muscle model' : '' })) } }),
    [`/bot${TG}/getChat`]: (req, res, url) => (url.searchParams.get('chat_id') === '@realchan'
      ? { json: { ok: true, result: { id: -100, type: 'channel', title: 'Real Channel', username: 'realchan', description: 'Gay fitness model. More: https://x.com/realchanx' } } }
      : url.searchParams.get('chat_id') === '@boom' ? { status: 500, body: 'oops' } : { status: 400, json: { ok: false, description: 'Bad Request: chat not found' } }),
    [`/bot${TG}/getChatMemberCount`]: () => ({ json: { ok: true, result: 4321 } }),
    '/2/users/by/username/budgetguy': () => ({ json: { data: { id: '42', name: 'Budget Guy', description: 'gym' } } }),
    '/2/users/42/tweets': () => { state.xPages++; return { json: { data: [{ id: `t${state.xPages}`, text: 'x', author_id: '42', attachments: { media_keys: [`k${state.xPages}`] }, created_at: '2026-10-01T00:00:00Z' }], includes: { users: [{ id: '42', username: 'budgetguy' }], media: [{ media_key: `k${state.xPages}`, type: 'photo', url: `https://pbs.twimg.com/media/p${state.xPages}.jpg` }] }, meta: { result_count: 100, newest_id: `t${state.xPages}`, next_token: state.xPages < 5 ? 'more' : undefined } } }; },
    '/srv/timeline-profile/screen-name/budgetguy': () => ({ body: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { timeline: { entries: [{ type: 'tweet', content: { tweet: { id_str: 's1', full_text: 'keyless', created_at: 'Wed Oct 01 10:00:00 +0000 2026', user: { screen_name: 'budgetguy' }, extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/s1.jpg' }] } } } }] } } } })}</script>` }),
  });
  prepareEnv({ BRAVE_API_KEY: 'brave-test', BRAVE_BASE_URL: mock.url, BSKY_BASE_URL: mock.url, TELEGRAM_API_KEY: TG, TELEGRAM_BOT_BASE_URL: mock.url, X_BEARER_TOKEN: 'xt', X_BASE_URL: mock.url, X_SYNDICATION_URL: mock.url });
  repo = require('../src/db/repo'); engine = require('../src/engine/engine'); backup = require('../src/engine/backup');
  discovery = require('../src/engine/discovery'); settings = require('../src/settings');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { engine.shutdown(); backup.stop(); discovery.stop(); await mock.close(); await new Promise((r) => server.close(r)); });

let n = 0;
const creatorWithPost = (handle, text, platform = 'x', extra = {}) => {
  const c = repo.creators.create({ handle });
  n++;
  repo.media.insert({ creator_id: c.id, platform, source_id: `d${n}`, source_key: `${platform}:d${n}:0`, post_key: `${platform}:d${n}`, author: handle, title: text, media_type: 'image', media_url: `https://pbs.twimg.com/media/d${n}.jpg`, hash: `v43h${n}`, ...extra }, []);
  repo.creators.refreshStats(c.id);
  return c;
};

describe('discovery scoring', () => {
  test('core handles match across platforms; scores add up per distinct source with caps', () => {
    assert.equal(discovery.coreHandle('Jake_Miller.bsky.social'), 'jakemiller');
    assert.equal(discovery.coreHandle('@jake.miller@mastodon.social'), 'jakemiller');
    assert.equal(discovery.coreHandle('u/JakeMiller'), 'jakemiller');
    assert.equal(discovery.scoreOf({ mention: ['a', 'b'], cofollow: ['c'] }, 'in'), 3 * 2 + 1.5 + 2);
    assert.equal(discovery.scoreOf({ mention: ['1', '2', '3', '4', '5', '6', '7'] }, 'uncertain'), 15, 'mentions are capped');
    assert.ok(discovery.scoreOf({ identity: ['x'] }, 'excluded') < 0, 'female-focused profiles sink');
  });
  test('consider() opens a candidate, merges signals, skips followed/blocked accounts and rejects unsafe ones', () => {
    const { parseProfile } = require('../src/lib/links');
    const a = discovery.consider(parseProfile('https://x.com/leadguy'), 'mention', 'creator-1');
    assert.equal(a.status, 'pending'); assert.equal(a.score, 3);
    discovery.consider(parseProfile('https://x.com/leadguy'), 'mention', 'creator-1');
    const b = discovery.consider(parseProfile('https://x.com/LeadGuy'), 'mention', 'creator-2', { bio: 'gay muscle model' });
    assert.equal(b.id, a.id, 'case-insensitive target');
    assert.equal(b.signals.mention.length, 2, 'the same mentioner counts once');
    assert.equal(b.score, 3 * 2 + 2);
    repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'alreadyfollowed' });
    assert.equal(discovery.consider(parseProfile('https://x.com/alreadyfollowed'), 'mention', 'c'), null);
    repo.blocklist.add('creator', 'x:blockedguy', 'test');
    assert.equal(discovery.consider(parseProfile('https://x.com/blockedguy'), 'mention', 'c'), null);
    const bad = discovery.consider(parseProfile('https://x.com/someguy16'), 'mention', 'c', { bio: 'I am 16 years old' });
    assert.equal(bad.status, 'rejected'); assert.match(bad.reason, /^safety/);
    assert.equal(discovery.consider(parseProfile('https://onlyfans.com/x'), 'mention', 'c'), null, 'paywalled sites are never candidates');
    assert.equal(discovery.consider(parseProfile('https://example.com/page'), 'search', 'q'), null, 'arbitrary web pages are too noisy');
  });
});

describe('mention mining', () => {
  test('collabs and shout-outs in creators\' posts become leads; the cursor makes it incremental', () => {
    creatorWithPost('miner_one', 'Shoot with @collabguy today! Also follow u/redditpal and bsky.app/profile/pal.bsky.social — r/gaybros');
    creatorWithPost('miner_two', 'Round two with @collabguy 🔥');
    creatorWithPost('miner_three', 'cute pic with @alice.bsky.social', 'bluesky');
    const r = discovery.mineMentions();
    assert.ok(r.scanned >= 3 && r.found >= 5, JSON.stringify(r));
    const collab = repo.candidates.find('x', 'user', 'collabguy');
    assert.equal(collab.signals.mention.length, 2, 'two different creators mentioned him');
    assert.ok(repo.candidates.find('reddit', 'user', 'redditpal'));
    assert.ok(repo.candidates.find('bluesky', 'user', 'pal.bsky.social'));
    assert.ok(repo.candidates.find('bluesky', 'user', 'alice.bsky.social'), 'Bluesky @handles with dots');
    assert.equal(repo.candidates.find('reddit', 'community', 'gaybros').kind, 'community');
    assert.equal(discovery.mineMentions().scanned, 0, 'already-mined posts are not re-read');
  });
  test('a creator mentioning their own other account is not a lead', () => {
    const c = creatorWithPost('selfie_guy', 'my backup is @selfie_backup');
    repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'selfie_backup', creatorId: c.id });
    discovery.mineMentions();
    assert.equal(repo.candidates.find('x', 'user', 'selfie_backup'), null);
  });
});

describe('Bluesky follow graph', () => {
  test('accounts followed by creators become leads only when they look like creators', async () => {
    const c = creatorWithPost('graphguy.bsky.social', 'post', 'bluesky');
    repo.feeds.upsert({ platform: 'bluesky', kind: 'user', target: 'graphguy.bsky.social', creatorId: c.id });
    state.followsOf['graphguy.bsky.social'] = [
      { did: 'did:1', handle: 'hunk.bsky.social', displayName: 'Hunk', description: 'gay muscle model · onlyfans link below', avatar: 'https://cdn.bsky.app/a.jpg' },
      { did: 'did:2', handle: 'pizzaplace.bsky.social', displayName: 'Pizza Place', description: 'Best slices in town' },
      { did: 'did:3', handle: 'labelled.bsky.social', displayName: 'L', description: '', labels: [{ val: 'porn' }] },
      { did: 'did:4', handle: 'hidden.bsky.social', displayName: 'H', description: 'model', labels: [{ val: '!no-unauthenticated' }] },
    ];
    const r = await discovery.blueskyGraph({ creators: 10 });
    assert.equal(r.checked >= 1, true);
    const hunk = repo.candidates.find('bluesky', 'user', 'hunk.bsky.social');
    assert.equal(hunk.scope, 'in'); assert.equal(hunk.display_name, 'Hunk'); assert.equal(hunk.avatar_url, 'https://cdn.bsky.app/a.jpg');
    assert.ok(repo.candidates.find('bluesky', 'user', 'labelled.bsky.social'), 'adult labels count as a creator hint');
    assert.equal(repo.candidates.find('bluesky', 'user', 'pizzaplace.bsky.social'), null, 'ordinary accounts are ignored');
    assert.equal(repo.candidates.find('bluesky', 'user', 'hidden.bsky.social'), null, 'logged-out-hidden accounts are respected');
    assert.equal((await discovery.blueskyGraph({ creators: 10 })).checked, 0, 'a creator is re-read at most weekly');
  });
});

describe('web search (Brave)', () => {
  test('topic searches turn profile links into leads; key sent as a header; daily budget enforced', async () => {
    settings.update({ discoveryQueries: 'gay male model bluesky\nsecond topic', braveDailyBudget: 2 });
    state.braveResults['gay male model'] = [
      { url: 'https://x.com/topicguy', title: 'Topic Guy (@topicguy) / X', description: 'gay fitness model' },
      { url: 'https://linktr.ee/topicguy', title: 'topicguy | Linktree', description: 'all my links' },
      { url: 'https://onlyfans.com/topicguy', title: 'OF', description: '' },
      { url: 'https://example.com/blog', title: 'Blog', description: 'see https://bsky.app/profile/blogfound.bsky.social' },
      { url: 'https://www.reddit.com/r/gaybros/', title: 'r/gaybros', description: '' },
    ];
    const r = await discovery.braveTopics({ budget: 2 });
    assert.equal(r.searched, 1); assert.equal(state.braveKey, 'brave-test');
    const t = repo.candidates.find('x', 'user', 'topicguy');
    assert.deepEqual(t.signals.search, ['gay male model bluesky']); assert.equal(t.display_name, 'Topic Guy'); assert.equal(t.scope, 'in');
    assert.ok(repo.candidates.find('linkinbio', 'page', 'https://linktr.ee/topicguy'), 'link-in-bio pages are leads too');
    assert.ok(repo.candidates.find('bluesky', 'user', 'blogfound.bsky.social'), 'links inside result snippets count');
    await discovery.braveTopics({ budget: 2 });
    require('../src/lib/websearch')._clear(); // repeated queries are served from a 10-minute cache; the budget check is about real requests
    const before = state.braveCalls;
    const r3 = await discovery.braveTopics({ budget: 2 });
    assert.equal(r3.searched, 0); assert.equal(state.braveCalls, before, 'no request once the budget is spent');
    assert.equal(require('../src/lib/brave').usage().count, 2);
  });
  test('identity search links a creator\'s other accounts only when the handle matches exactly', async () => {
    repo.settings.set('brave.usage', '{}');
    const c = creatorWithPost('jake_miller', 'a'); creatorWithPost('filler', 'b');
    n++; repo.media.insert({ creator_id: c.id, platform: 'x', source_id: `d${n}`, source_key: `x:d${n}:0`, post_key: `x:d${n}`, title: 'c', media_type: 'image', media_url: 'https://pbs.twimg.com/media/zz1.jpg', hash: 'zz1' });
    n++; repo.media.insert({ creator_id: c.id, platform: 'x', source_id: `d${n}`, source_key: `x:d${n}:0`, post_key: `x:d${n}`, title: 'd', media_type: 'image', media_url: 'https://pbs.twimg.com/media/zz2.jpg', hash: 'zz2' });
    repo.creators.refreshStats(c.id);
    state.braveResults['"jakemiller"'] = [
      { url: 'https://bsky.app/profile/jakemiller.bsky.social', title: 'Jake', description: '' },
      { url: 'https://www.redgifs.com/users/JakeMiller', title: 'Jake on RedGIFs', description: '' },
      { url: 'https://x.com/jakemillerfan', title: 'fan', description: '' },
    ];
    const r = await discovery.braveIdentity({ creators: 20, budget: 10 });
    assert.ok(r.linked >= 2, JSON.stringify(r));
    const bs = repo.candidates.find('bluesky', 'user', 'jakemiller.bsky.social');
    assert.equal(bs.creator_id, c.id); assert.equal(bs.signals.identity[0], c.id);
    assert.equal(repo.candidates.find('x', 'user', 'jakemillerfan'), null, 'similar but different handles are not linked');
    settings.update({ discoveryAutoFollowScore: 6 });
    discovery.promote();
    const feed = repo.feeds.find('bluesky', 'user', 'jakemiller.bsky.social');
    assert.equal(feed.creator_id, c.id, 'the account was attached to the existing creator');
    assert.equal(repo.candidates.find('bluesky', 'user', 'jakemiller.bsky.social').status, 'linked');
    settings.update({ discoveryAutoFollowScore: 8 });
  });
});

describe('auto-follow', () => {
  test('strong, male-focused leads are followed; uncertain ones, communities and borderline bios wait for a human', () => {
    const { parseProfile } = require('../src/lib/links');
    for (const who of ['m1', 'm2', 'm3']) discovery.consider(parseProfile('https://x.com/stronglead'), 'mention', who, { bio: 'gay jock', displayName: 'Strong Lead' });
    for (const who of ['m1', 'm2', 'm3']) discovery.consider(parseProfile('https://x.com/unclearlead'), 'mention', who);
    for (const who of ['m1', 'm2', 'm3']) discovery.consider(parseProfile('r/strongsub'), 'mention', who);
    for (const who of ['m1', 'm2', 'm3']) discovery.consider(parseProfile('https://x.com/borderline'), 'mention', who, { bio: 'gay teen vibes' });
    const r = discovery.promote();
    assert.ok(r.followed >= 1);
    const strong = repo.candidates.find('x', 'user', 'stronglead');
    assert.equal(strong.status, 'followed');
    const feed = repo.feeds.find('x', 'user', 'stronglead');
    assert.equal(feed.origin, 'discovered'); assert.equal(feed.trusted, 1);
    assert.equal(repo.creators.get(feed.creator_id).display_name, 'Strong Lead');
    assert.equal(repo.candidates.find('x', 'user', 'unclearlead').status, 'pending', 'no male signal → human decides');
    assert.equal(repo.candidates.find('reddit', 'community', 'strongsub').status, 'pending', 'communities never auto-follow');
    assert.equal(repo.candidates.find('x', 'user', 'borderline').status, 'pending'); assert.match(repo.candidates.find('x', 'user', 'borderline').reason, /^needs review/);
  });
  test('respects the per-run cap and the auto-follow switch on scheduled runs', async () => {
    const { parseProfile } = require('../src/lib/links');
    for (let i = 0; i < 4; i++) for (const who of ['a', 'b', 'c']) discovery.consider(parseProfile(`https://x.com/capguy${i}`), 'mention', who, { bio: 'gay model' });
    settings.update({ discoveryMaxFollowsPerRun: 2 });
    assert.equal(discovery.promote().followed, 2);
    settings.update({ autoDiscover: false, discoveryGraph: false, braveDailyBudget: 0 });
    const report = await discovery.run();
    assert.equal(report.promote.followed, 0, 'auto-follow off: scheduled runs only collect leads');
    settings.update({ autoDiscover: true, discoveryGraph: true, discoveryMaxFollowsPerRun: 10, braveDailyBudget: 40 });
  });
});

describe('Telegram bot', () => {
  test('channel lookups work; missing channels return null; the token never appears in errors', async () => {
    const bot = require('../src/lib/telegram-bot');
    assert.equal(bot.configured(), true);
    const info = await bot.channelInfo('realchan');
    assert.equal(info.title, 'Real Channel'); assert.equal(info.members, 4321);
    assert.equal(await bot.channelInfo('nosuchchan'), null);
    await assert.rejects(bot.channelInfo('boom'), (e) => !e.message.includes(TG) && !e.message.includes('ABCDEFGHIJ'));
    assert.equal(bot.scrub(`failed https://api.telegram.org/bot${TG}/getChat`), 'failed https://api.telegram.org/bot<token>/getChat');
  });
  test('discovery enriches Telegram leads and drops channels that do not exist', async () => {
    const { parseProfile } = require('../src/lib/links');
    discovery.consider(parseProfile('https://t.me/realchan'), 'mention', 'z');
    discovery.consider(parseProfile('https://t.me/ghostchan'), 'mention', 'z');
    await discovery.enrich();
    const real = repo.candidates.find('telegram', 'user', 'realchan');
    assert.equal(real.display_name, 'Real Channel'); assert.equal(real.scope, 'in');
    assert.equal(repo.candidates.find('telegram', 'user', 'ghostchan').status, 'rejected');
  });
});

describe('X API budget', () => {
  test('reads are counted; past the monthly budget profiles fall back to the keyless route', async () => {
    const x = require('../src/sources/x');
    settings.update({ xMonthlyReadBudget: 150 });
    const r1 = await x.fetch({ kind: 'user', target: 'budgetguy' }, { cursor: {}, aborted: () => false });
    assert.equal(r1.via, 'api');
    assert.ok(x.usage().posts >= 150, String(x.usage().posts));
    const r2 = await x.fetch({ kind: 'user', target: 'budgetguy' }, { cursor: {}, aborted: () => false });
    assert.equal(r2.via, 'syndication'); assert.equal(r2.items[0].mediaUrl, 'https://pbs.twimg.com/media/s1.jpg?name=orig');
    // searches past the budget never touch the API again: they go keyless through web search when one is configured
    const before = x.usage().posts;
    try { const r3 = await x.fetch({ kind: 'search', target: 'gay' }, { cursor: {}, aborted: () => false }); assert.match(r3.via, /^websearch/); } catch (e) { assert.ok(e.skip, e.message); }
    assert.equal(x.usage().posts, before);
    assert.equal(x.isConfigured('search').ok, require('../src/lib/websearch').configured());
  });
});

describe('admin discovery API', () => {
  test('lists the queue with status, follows / rejects / blocks candidates and validates input', async () => {
    const { parseProfile } = require('../src/lib/links');
    const c1 = discovery.consider(parseProfile('https://x.com/apiguy1'), 'mention', 'q', { bio: 'gay' });
    const c2 = discovery.consider(parseProfile('https://x.com/apiguy2'), 'mention', 'q');
    const c3 = discovery.consider(parseProfile('https://x.com/apiguy3'), 'mention', 'q');
    const list = await adm('/discovery?status=pending&q=apiguy');
    assert.equal(list.status, 200);
    assert.equal(list.json.candidates.total, 3); assert.equal(list.json.brave.configured, true); assert.equal(list.json.telegramBot, true); assert.equal(list.json.xApi, true);
    assert.equal((await adm(`/discovery/candidates/${c1.id}`, { method: 'POST', body: { action: 'follow' } })).json.ok, true);
    assert.ok(repo.feeds.find('x', 'user', 'apiguy1'));
    assert.equal((await adm(`/discovery/candidates/${c2.id}`, { method: 'POST', body: { action: 'block' } })).json.status, 'rejected');
    assert.equal(repo.blocklist.has('creator', 'x:apiguy2'), true);
    assert.equal((await adm('/discovery/candidates', { method: 'POST', body: { ids: [c3.id], action: 'reject' } })).json.ok, 1);
    assert.equal((await adm(`/discovery/candidates/${c3.id}`, { method: 'POST', body: { action: 'reset' } })).json.status, 'pending');
    assert.equal((await adm(`/discovery/candidates/${c3.id}`, { method: 'POST', body: { action: 'explode' } })).status, 400);
    assert.equal((await adm('/discovery/candidates/nope', { method: 'POST', body: { action: 'follow' } })).status, 404);
    const audit = repo.audit.list({ targetType: 'candidate' });
    assert.ok(audit.items.some((a) => a.action === 'follow' && a.actor === 'admin'));
    const run = await adm('/discovery/run', { method: 'POST' });
    assert.ok([202, 409].includes(run.status));
    const s = await adm('/settings');
    assert.equal(s.json.credentials.brave, true); assert.equal(s.json.credentials.telegramValid, true);
    assert.ok(s.json.schema.some((d) => d.key === 'discoveryQueries' && d.type === 'text' && d.group === 'discovery'));
  });
});

describe('recommendations', () => {
  const AGE = { cookie: 'prism_age=1' };
  const pub = async (p) => { const res = await fetch(`${base}${p}`, { headers: AGE }); return { status: res.status, json: await res.json() }; };
  test('rank by taste (creators, tags, video share), exclude what was seen, cap two per creator', async () => {
    const fan = repo.creators.create({ handle: 'rec_fav' }); const other = repo.creators.create({ handle: 'rec_other' }); const off = repo.creators.create({ handle: 'rec_off' });
    const ids = [];
    for (let i = 0; i < 4; i++) { n++; ids.push(repo.media.insert({ creator_id: fan.id, platform: 'reddit', source_id: `r${n}`, source_key: `reddit:r${n}:0`, post_key: `reddit:r${n}`, title: 'fav', media_type: 'image', media_url: `https://i.redd.it/r${n}.jpg`, hash: `rech${n}` }, ['beachy'])); }
    n++; const tagged = repo.media.insert({ creator_id: other.id, platform: 'reddit', source_id: `r${n}`, source_key: `reddit:r${n}:0`, post_key: `reddit:r${n}`, title: 'tag match', media_type: 'video', media_url: `https://i.redd.it/r${n}.mp4`, hash: `rech${n}` }, ['beachy', 'surfing']);
    n++; const unrelated = repo.media.insert({ creator_id: off.id, platform: 'reddit', source_id: `r${n}`, source_key: `reddit:r${n}:0`, post_key: `reddit:r${n}`, title: 'nothing', media_type: 'image', media_url: `https://i.redd.it/r${n}.jpg`, hash: `rech${n}` }, ['other-thing']);
    const r = await pub(`/api/recommend?creators=${fan.id}&tags=beachy,surfing&exclude=${ids[0]}&limit=10`);
    assert.equal(r.status, 200); assert.equal(r.json.personalized, true);
    const got = r.json.items.map((x) => x.id);
    assert.ok(!got.includes(ids[0]), 'excluded (already seen)'); assert.ok(!got.includes(unrelated), 'no taste match → not recommended');
    assert.ok(got.includes(tagged));
    assert.ok(got.slice(0, 3).filter((id) => ids.includes(id)).length <= 2, 'no creator takes more than two of the top slots');
    assert.equal((await pub('/api/recommend?tags=beachy&type=video')).json.items.every((x) => x.media_type === 'video'), true);
    const cold = await pub('/api/recommend');
    assert.equal(cold.json.personalized, false, 'no taste yet → trending fallback'); assert.ok(Array.isArray(cold.json.items));
    assert.equal((await pub('/api/recommend?tags=%27;drop&creators=nope&exclude=x')).status, 200, 'hostile input is filtered, not fatal');
  });
  test('later pages can skip the count', async () => {
    const r = await pub('/api/media?page=1&limit=2&nocount=1');
    assert.equal(r.json.total, null);
    assert.equal(typeof (await pub('/api/media?page=0&limit=2&nocount=1')).json.total, 'number', 'first page always counts');
  });
});

describe('adaptive scheduling', () => {
  test('busy feeds are checked sooner, repeatedly empty ones later, capped at 3x', () => {
    const { feed } = repo.feeds.upsert({ platform: 'reddit', kind: 'community', target: 'tempotest', intervalMin: 60 });
    assert.equal(engine.tempo(feed, 12), 0.5); assert.equal(engine.tempo(feed, 4), 0.75); assert.equal(engine.tempo(feed, 1), 1);
    assert.equal(engine.tempo(feed, 0), 1, 'one empty run alone changes nothing');
    for (let i = 0; i < 4; i++) { const id = repo.runs.start(feed.id, 'test'); repo.runs.finish(id, { status: 'empty', added: 0 }); }
    assert.equal(engine.tempo(feed, 0), 2.5);
    settings.update({ adaptiveScheduling: false });
    assert.equal(engine.tempo(feed, 50), 1);
    settings.update({ adaptiveScheduling: true });
    const next = new Date(engine.computeNextRun({ interval_min: 60 }, 0, 0, 0.5)).getTime() - Date.now();
    assert.ok(next > 25 * 60000 && next < 35 * 60000, String(next));
  });
});
