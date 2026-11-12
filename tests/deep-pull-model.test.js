'use strict';
/**
 * The deep-pull progress model (public/js/components/deep-pull-model.js): stages, pills, the live-refresh trigger and
 * the "why it matched" pills. Pure functions, so these run under node with no browser.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../public/js/components/deep-pull-model.js');

test('the new job shape maps straight onto the four stages', async () => {
  const M = await load();
  const job = M.normalizeJob({ job: { phase: 'videos', status: 'running', found: { feeds: 2, postsAdded: 0 }, queriesRun: 4, queriesTotal: 12, elapsedMs: 8100 } });
  assert.equal(job.running, true);
  assert.equal(job.phase, 'videos');
  assert.equal(job.found.feeds, 2);
  assert.equal(job.found.videos, undefined, 'a count the server did not send stays unknown');
  assert.equal(job.queriesRun, 4);
  assert.deepEqual(M.stageStates(job).map((s) => s.state), ['done', 'active', 'todo', 'todo']);
});

test('the older flat answer is read as the same job, phases mapped onto the stages', async () => {
  const M = await load();
  const job = M.normalizeJob({ running: true, phase: 'image', found: { feeds: 1, pictures: 3, results: 14 } });
  assert.equal(job.phase, 'images');
  assert.equal(job.found.feeds, 1);
  assert.equal(job.found.candidates, 14);
  assert.deepEqual(M.stageStates(job).map((s) => s.state), ['done', 'done', 'active', 'todo']);
});

test('no job at all is null, so nothing is shown and nothing is polled for', async () => {
  const M = await load();
  assert.equal(M.normalizeJob({ running: false, done: false }), null);
  assert.equal(M.normalizeJob(null), null);
  assert.equal(M.normalizeJob({}), null);
});

test('a finished job has every stage done; a failed one stops on the stage it was in', async () => {
  const M = await load();
  const done = M.normalizeJob({ job: { phase: 'done', status: 'done', found: { feeds: 3, postsAdded: 9 } } });
  assert.deepEqual(M.stageStates(done).map((s) => s.state), ['done', 'done', 'done', 'done']);
  const failed = M.normalizeJob({ job: { phase: 'videos', status: 'failed', error: 'search quota', found: {} } });
  assert.deepEqual(M.stageStates(failed).map((s) => s.state), ['done', 'failed', 'todo', 'todo']);
  assert.match(M.statusLine(failed), /Stopped: search quota/);
});

test('counter pills show the four live counts, and a count the server has not sent is a dash', async () => {
  const M = await load();
  const pills = M.counterPills({ feeds: 2, postsAdded: 0, videos: 5 });
  assert.deepEqual(pills.map((p) => [p.label, p.text]), [
    ['Accounts linked', '2'],
    ['New posts pulled', '0'],
    ['Videos matched', '5'],
    ['Paid leads', '—'],
  ]);
});

test('a poll tick triggers a live refresh only when accounts, videos or posts went up', async () => {
  const M = await load();
  assert.equal(M.grew({ feeds: 1, postsAdded: 0 }, { feeds: 1, postsAdded: 0 }), false);
  assert.equal(M.grew({ feeds: 1, postsAdded: 0 }, { feeds: 2, postsAdded: 0 }), true, 'a new account');
  assert.equal(M.grew({ postsAdded: 3 }, { postsAdded: 9 }), true, 'new posts');
  assert.equal(M.grew({ videos: 1 }, { videos: 4 }), true, 'new videos');
  assert.equal(M.grew({ leads: 0 }, { leads: 5 }), false, 'leads alone do not reload the grid');
  assert.equal(M.grew(undefined, { postsAdded: 2 }), true, 'the first sample counts from zero');
});

test('the match pills come from the evidence lines lookup.js writes, and from the server kinds when it sends them', async () => {
  const M = await load();
  const kinds = (c) => M.provenanceOf(c).map((p) => p.label);
  assert.deepEqual(kinds({ evidence: ['handle “jakipz” on Reddit'] }), ['Exact handle']);
  assert.deepEqual(kinds({ evidence: ['linked from Instagram profile Jak'] }), ['Bio backlink']);
  assert.deepEqual(kinds({ evidence: ['link-in-bio on Jak'] }), ['Bio backlink']);
  assert.deepEqual(kinds({ evidence: ['web search: some page'] }), ['Web search']);
  assert.deepEqual(kinds({ evidence: ['Bluesky people search'] }), ['Directory match']);
  assert.deepEqual(kinds({ evidence: ['performer directory: Jak on example.com'] }), ['Directory match']);
  // alias and visual matches only appear when the server says so; they are never guessed from text
  assert.deepEqual(kinds({ evidence: ['some other line'] }), []);
  assert.deepEqual(kinds({ provenance: [{ kind: 'alias' }, 'visual', 'nonsense'] }), ['Alias match', 'Visual match']);
  // a result with two reasons gets two pills, once each
  assert.deepEqual(kinds({ evidence: ['handle “a” on Reddit', 'handle “a” on Reddit', 'link-in-bio on X'] }), ['Exact handle', 'Bio backlink']);
});

test('the evidence patterns match the strings lookup.js actually writes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'lookup.js'), 'utf8');
  assert.match(src, /evidence: `handle “/, 'exact-handle line');
  assert.match(src, /evidence: `linked from /, 'backlink line');
  assert.match(src, /evidence: `link-in-bio on /, 'link-in-bio line');
  assert.match(src, /evidence: `web search: /, 'web line');
  assert.match(src, /evidence: 'Bluesky people search'/, 'people search line');
  assert.match(src, /evidence: `performer directory: /, 'directory line');
});

test('elapsed time reads as seconds, then minutes', async () => {
  const M = await load();
  assert.equal(M.fmtElapsed(42000), '42s');
  assert.equal(M.fmtElapsed(65000), '1m 05s');
  assert.equal(M.fmtElapsed(undefined), '0s');
});

test('the server as it answers today maps onto the same stages: older phase names, posts counted at the top, done as a flag', async () => {
  const M = await load();
  const running = M.normalizeJob({ job: { running: true, phase: 'text', postsAdded: 3, found: { feeds: 1, results: 9 } } });
  assert.equal(running.phase, 'profiles');
  assert.equal(running.found.postsAdded, 3, 'posts counted at the top of the job');
  assert.equal(running.found.candidates, 9, 'results read as candidates');
  assert.deepEqual(M.stageStates(running).map((s) => s.state), ['active', 'todo', 'todo', 'todo']);
  const pulling = M.normalizeJob({ job: { running: true, phase: 'pulling', found: {} } });
  assert.deepEqual(M.stageStates(pulling).map((s) => s.state), ['done', 'done', 'done', 'active']);
  const finished = M.normalizeJob({ job: { running: false, done: true, phase: 'done', postsAdded: 4, found: { feeds: 2 } } });
  assert.equal(finished.status, 'done');
  assert.equal(finished.found.postsAdded, 4);
  assert.equal(M.statusLine(finished), 'Done: 2 linked accounts, 4 new posts pulled');
});

test('an idle answer is no job at all, so nothing is shown from an old run', async () => {
  const M = await load();
  assert.equal(M.normalizeJob({ job: { running: false, done: false, phase: null, found: {} } }), null);
  assert.equal(M.normalizeJob({ job: { running: false, done: false, phase: 'text' } }), null);
});

test('a refused start says why, in words a visitor can act on', async () => {
  const M = await load();
  assert.equal(M.refusalText({ started: false, reason: 'cooldown', until: 'not-a-date' }), 'Searched recently. Try again in a few minutes.');
  const until = new Date(Date.UTC(2026, 10, 12, 15, 30)).toISOString();
  assert.match(M.refusalText({ started: false, reason: 'cooldown', until }), /^Searched recently\. Try again after \d{1,2}:\d{2}/);
  assert.equal(M.refusalText({ started: false, reason: 'off in Settings' }), 'Deep search is switched off right now.');
  assert.equal(M.refusalText({ started: false, error: 'Creator not found' }), 'Creator not found');
  assert.equal(M.refusalText(null), 'Could not start a search.');
});

test('the status sentence names the stage and the step', async () => {
  const M = await load();
  assert.equal(M.statusLine(M.normalizeJob({ job: { phase: 'images', status: 'running' } })), 'Visual & Face Match, step 3 of 4');
  assert.equal(M.statusLine(M.normalizeJob({ job: { phase: 'done', status: 'done', found: { feeds: 1, postsAdded: 1 } } })), 'Done: 1 linked account, 1 new post pulled');
  assert.equal(M.statusLine(null), '');
});
