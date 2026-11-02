'use strict';
/**
 * Claude reading creators' own bios and link-in-bio links (engine/ai.readProfiles) against a mock of the Messages API.
 * What matters: a claim only counts when its quote is really in the creator's own text; names are stored as weak
 * aliases with their evidence (signal + source URL); other accounts and communities only become ordinary discovery
 * candidates behind the safety gate; an account that belongs to another creator is queued for the admin and never merged;
 * a refusal changes nothing. Nothing here reaches the real API, and nothing reads a picture.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start, prepareEnv } = require('./helpers/mock');

let api; let repo; let engine; let claude; let ai; let identity; let settingsStore;
const state = { requests: [], stop: 'end_turn', answer: () => ({ profiles: [] }) };
const message = (content, extra = {}) => ({ id: `msg_${state.requests.length}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason: state.stop, stop_sequence: null, usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...extra });

before(async () => {
  api = await start({
    '/v1/messages': (req) => {
      const body = JSON.parse(req.bodyText);
      state.requests.push(body);
      if (state.stop === 'refusal') return { json: message([], { stop_details: { type: 'refusal', category: 'general_harms', explanation: 'x' } }) };
      return { json: message([{ type: 'text', text: JSON.stringify(state.answer(body)) }]) };
    },
  });
  prepareEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: api.url });
  repo = require('../src/db/repo');
  engine = require('../src/engine/engine');
  claude = require('../src/lib/claude');
  ai = require('../src/engine/ai');
  identity = require('../src/engine/identity');
  settingsStore = require('../src/settings');
});
after(async () => { engine.shutdown(); await api.close(); });
beforeEach(() => {
  state.requests.length = 0; state.stop = 'end_turn'; state.answer = () => ({ profiles: [] });
  claude._reset();
  repo.settings.set('ai.usage', '{}');
  settingsStore.update({ aiSearch: true, aiDiscovery: true, aiDailyBudget: 300 });
  repo.db.prepare("DELETE FROM discovery_state WHERE key LIKE 'ai.profile.%'").run();
});

let seq = 0;
/** A followed creator with a bio and link-in-bio links; media_count rises with each call so the newest is read first. */
function creator(handle, { bio = '', links = [], platform = 'bluesky', media = 5000 + (seq++) } = {}) {
  const c = repo.creators.create({ handle, origin: 'admin' });
  repo.feeds.upsert({ platform, kind: 'user', target: handle, creatorId: c.id, enabled: 1, trusted: 1, origin: 'admin', runNow: false });
  repo.db.prepare('UPDATE creators SET bio = ?, links = ?, media_count = ?, display_name = NULL WHERE id = ?').run(bio, JSON.stringify(links), media, c.id);
  return c;
}
const answer = (...profiles) => { state.answer = () => ({ profiles }); };
const empty = (n) => ({ n, stage_name: '', stage_name_quote: '', accounts: [], communities: [] });

describe('Claude reads a creator\'s own text', () => {
  test('a self-declared name is stored as a weak alias with its signal and the page that shows it', async () => {
    const c = creator('zed_runs', { bio: 'Hi, I\'m Zed Calloway. Runner, lifter.', links: [{ url: 'https://linktr.ee/zedcalloway', label: 'All my links' }] });
    answer({ ...empty(1), stage_name: 'Zed Calloway', stage_name_quote: 'I\'m Zed Calloway' });
    const r = await ai.readProfiles({ limit: 1 });
    assert.equal(r.read, 1);
    assert.equal(r.names, 1);
    const a = identity.aliasesOf(c.id).find((x) => x.alias === 'Zed Calloway');
    assert.ok(a, 'the alias exists');
    assert.equal(a.source, 'bio', 'weak: only his bio claims it, so it never counts toward an auto-merge');
    assert.equal(a.signal, 'self-declared-name');
    assert.ok(a.evidence_url && /^https?:\/\//.test(a.evidence_url), `evidence url recorded (${a.evidence_url})`);
    assert.ok(identity.findByAlias('Zed Calloway').some((x) => x.id === c.id), 'search finds him by it');
    assert.ok(!repo.creators.detail(c.id).aliases.some((x) => x.alias === 'Zed Calloway'), 'but it is not shown as a confirmed name');
  });

  test('the evidence URL is the link that holds the quote when there is one', async () => {
    const c = creator('ivo_lifts', { bio: '', links: [{ url: 'https://beacons.ai/ivo-kessler', label: 'Ivo Kessler official' }] });
    answer({ ...empty(1), stage_name: 'Ivo Kessler', stage_name_quote: 'Ivo Kessler official' });
    await ai.readProfiles({ limit: 1 });
    assert.equal(identity.aliasesOf(c.id).find((x) => x.alias === 'Ivo Kessler').evidence_url, 'https://beacons.ai/ivo-kessler');
  });

  test('a claim whose quote is not in his text is dropped, however plausible', async () => {
    const c = creator('abe_trains', { bio: 'lifting and tacos' });
    answer({ ...empty(1), stage_name: 'Abe Lincoln', stage_name_quote: 'my name is Abe Lincoln', accounts: [{ platform: 'x', handle: 'abe_alt_9', quote: 'backup: @abe_alt_9' }], communities: [{ platform: 'reddit', name: 'gaybrosgonewild', quote: 'I post on r/gaybrosgonewild' }] });
    const r = await ai.readProfiles({ limit: 1 });
    assert.equal(r.names + r.proposed + r.queued, 0);
    assert.equal(r.dropped, 3);
    assert.ok(!identity.aliasesOf(c.id).some((x) => /Lincoln|abe_alt_9/.test(x.alias)));
    assert.ok(!repo.candidates.find('x', 'user', 'abe_alt_9'));
  });

  test('a quote that is in his text but does not contain the claimed name is dropped too', async () => {
    const c = creator('kai_swims', { bio: 'swimmer. based in Lisbon. backup: @kai_swims2' });
    answer({ ...empty(1), stage_name: 'Kai Mercer', stage_name_quote: 'swimmer. based in Lisbon' });
    const r = await ai.readProfiles({ limit: 1 });
    assert.equal(r.names, 0);
    assert.ok(!identity.aliasesOf(c.id).some((x) => x.alias === 'Kai Mercer'));
  });

  test('his own handle or display name is not a new attribution', async () => {
    const c = creator('lou_fit', { bio: 'Lou Fit - coach' });
    answer({ ...empty(1), stage_name: 'Lou Fit', stage_name_quote: 'Lou Fit - coach' });
    const r = await ai.readProfiles({ limit: 1 });
    assert.equal(r.names, 0);
    assert.equal(identity.aliasesOf(c.id).filter((x) => x.kind === 'name').length, 0);
  });
});

describe('proposals go through the normal pipeline', () => {
  test('an unknown account he names becomes a pending candidate, not a follow', async () => {
    creator('moe_lifts', { bio: 'also on X: @moe_lifts_alt' });
    answer({ ...empty(1), accounts: [{ platform: 'x', handle: '@moe_lifts_alt', quote: 'also on X: @moe_lifts_alt' }] });
    const r = await ai.readProfiles({ limit: 1 });
    assert.equal(r.proposed, 1);
    const cand = repo.candidates.find('x', 'user', 'moe_lifts_alt');
    assert.equal(cand.status, 'pending');
    assert.ok((cand.signals.ai || []).some((v) => /moe_lifts/.test(v)), 'the signal says whose bio it came from');
    assert.ok(!repo.feeds.find('x', 'user', 'moe_lifts_alt'), 'not followed');
  });

  test('the safety gate still runs: a proposal the gate blocks is rejected, never queued', async () => {
    creator('nat_runs', { bio: 'backup: @under-18-lifts' });
    answer({ ...empty(1), accounts: [{ platform: 'x', handle: 'under-18-lifts', quote: 'backup: @under-18-lifts' }] });
    const r = await ai.readProfiles({ limit: 1 });
    assert.equal(r.proposed, 0);
    const cand = repo.candidates.find('x', 'user', 'under-18-lifts');
    assert.equal(cand.status, 'rejected');
    assert.match(cand.reason, /^safety:/);
  });

  test('communities he says he posts in become candidates; malformed names are dropped', async () => {
    creator('pip_posts', { bio: 'posts on r/malefitness and r/bad name!' });
    answer({ ...empty(1), communities: [
      { platform: 'reddit', name: 'r/malefitness', quote: 'posts on r/malefitness' },
      { platform: 'reddit', name: 'bad name!', quote: 'r/bad name!' },
    ] });
    const r = await ai.readProfiles({ limit: 1 });
    assert.equal(r.proposed, 1);
    assert.equal(repo.candidates.find('reddit', 'community', 'malefitness').status, 'pending');
    assert.equal(r.dropped, 1);
  });

  test('an account that already belongs to another creator is queued for the admin, even with a shared name: never auto-merged', async () => {
    const a = creator('rex_one', { bio: 'my other account: @rex_two on Bluesky', platform: 'bluesky' });
    const b = creator('rex_two', { bio: '', platform: 'bluesky', media: 10 });
    identity.addAlias(a.id, 'Rex Dallas', { kind: 'name', source: 'profile' });
    identity.addAlias(b.id, 'Rex Dallas', { kind: 'name', source: 'profile' }); // same name on both: the strongest case for a merge
    answer({ ...empty(1), accounts: [{ platform: 'bluesky', handle: 'rex_two', quote: 'my other account: @rex_two' }] });
    const r = await ai.readProfiles({ limit: 1 });
    assert.equal(r.queued, 1);
    assert.ok(repo.creators.get(a.id) && repo.creators.get(b.id), 'both creators still exist');
    const q = identity.queue({ status: 'pending' }).items.find((x) => [x.a.id, x.b.id].includes(a.id) && [x.a.id, x.b.id].includes(b.id));
    assert.ok(q, 'waiting in the review queue');
    assert.equal(q.status, 'pending');
    assert.ok(q.evidence.some((e) => e.type === 'bio-alias' && e.url), 'the evidence keeps the page it came from');
    assert.equal(identity.queue({ status: 'merged' }).items.filter((x) => [x.a.id, x.b.id].includes(a.id)).length, 0);
  });
});

describe('cost, refusals and what is sent', () => {
  test('one request per batch: Haiku 5.5, medium effort, no fallback, text only; each creator is read once a month', async () => {
    creator('sol_reads', { bio: 'Hello there, nothing to see' });
    answer(empty(1));
    await ai.readProfiles({ limit: 1 });
    const body = state.requests[0];
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.equal(body.output_config.effort, 'medium');
    assert.equal(body.fallbacks, undefined);
    const sent = JSON.parse(body.messages[0].content);
    assert.deepEqual(Object.keys(sent.creators[0]).sort(), ['handle', 'n', 'name', 'text'], 'only handle, name and his own text are sent');
    state.requests.length = 0;
    answer(empty(1));
    await ai.readProfiles({ limit: 1 }); // the next call moves on to a creator nobody has read yet
    const next = state.requests.length ? JSON.parse(state.requests[0].messages[0].content).creators.map((x) => x.handle) : [];
    assert.ok(!next.includes('sol_reads'), 'sol_reads is not asked about again within the month');
  });

  test('a refusal changes nothing and the creator is asked about again later', async () => {
    const c = creator('tay_refused', { bio: 'I\'m Tay Refused, hello' });
    state.stop = 'refusal';
    assert.equal(await ai.readProfiles({ limit: 1 }), null);
    assert.equal(identity.aliasesOf(c.id).filter((x) => x.kind === 'name').length, 0);
    assert.equal(repo.discoveryState.touchedAt(`ai.profile.${c.id}`), null);
  });

  test('switched off: no request at all', async () => {
    creator('uma_off', { bio: 'whatever' });
    settingsStore.update({ aiDiscovery: false });
    assert.equal(await ai.readProfiles({ limit: 1 }), null);
    assert.equal(state.requests.length, 0);
  });
});

describe('hard limits', () => {
  test('profile reading never touches the picture models: no face, body or image matching', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'ai.js'), 'utf8');
    for (const banned of ['imagefilter', 'imagematch', 'phash', 'embeddings', 'physique', 'visual', 'thumbs', 'image/', 'base64']) {
      assert.ok(!src.includes(banned), `ai.js does not reference ${banned}`);
    }
  });

  test('the on-device filter stays a filter: it does not call Claude and nothing in the identity code reads pictures', () => {
    const root = path.join(__dirname, '..', 'src');
    assert.ok(!/require\(['"]\.\/claude['"]\)|anthropic/i.test(fs.readFileSync(path.join(root, 'lib', 'imagefilter.js'), 'utf8')), 'the filter does not call Claude');
    const identitySrc = fs.readFileSync(path.join(root, 'engine', 'identity.js'), 'utf8');
    for (const banned of ['imagefilter', 'phash', 'embeddings', 'imagematch']) assert.ok(!identitySrc.includes(banned), `identity.js does not reference ${banned}`);
  });
});
