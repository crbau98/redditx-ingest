'use strict';
/**
 * End-to-end: PRISM's own UI driven in a real Chromium (Playwright), on the offline demo library (scripts/seed-demo.js),
 * with Claude answered by a mock of the Messages API. Every page is also checked for console errors, failed requests
 * and horizontal overflow on a phone. Skipped where Playwright or its Chromium is not installed (CI runs it in the e2e
 * job: `npx playwright install --with-deps chromium`). Screenshots go to E2E_SHOTS when set.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { prepareEnv, start } = require('./helpers/mock');

let pw = null;
try { pw = require('playwright'); } catch { pw = null; }
const exe = (() => { try { return pw && pw.chromium.executablePath(); } catch { return ''; } })();
if (!pw || !exe || !fs.existsSync(exe)) {
  // E2E_REQUIRED (the CI e2e job): a missing browser is a failure there, not a silent skip.
  test('E2E UI tests need Playwright and its Chromium (npx playwright install chromium)', { skip: process.env.E2E_REQUIRED !== '1' }, () => assert.fail('Playwright Chromium is not installed'));
  return;
}

let anthropic; let server; let base; let browser; let engine;
const shots = process.env.E2E_SHOTS || '';
const aiState = { requests: 0 };

before(async () => {
  anthropic = await start({
    '/v1/messages': (req) => {
      aiState.requests++;
      const body = JSON.parse(req.bodyText);
      const answer = { tags: ['beard'], type: 'video', sort: '', since: '', platform: '', paid: '', athletic: false, creator: '', text: '', note: 'Bearded men, videos' };
      return { json: { id: 'msg_e2e', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify(answer) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 50, output_tokens: 20 } } };
    },
  });
  const dir = prepareEnv({ DEMO_ART: '1', AGE_GATE_ENFORCE: 'true', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-e2e', ANTHROPIC_BASE_URL: anthropic.url });
  // The demo library: 160 generated items from 20 creators (no network, no real content).
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-demo.js')], { env: { ...process.env, DB_PATH: path.join(dir, 'test.db') }, stdio: 'ignore' });
  engine = require('../src/engine/engine');
  server = require('../src/app').createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch();
});
after(async () => { if (browser) await browser.close(); engine.shutdown(); await new Promise((r) => server.close(r)); await anthropic.close(); });

/** A fresh visitor: console errors and failed same-origin requests are collected for the end-of-test check. */
async function visit(t, { viewport = { width: 1440, height: 900 }, colorScheme = 'light', enterAge = true, serviceWorkers = 'allow' } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme, serviceWorkers }); // 'block' when a test stubs requests with page.route: it cannot see fetches a service worker answers
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/401 \(Unauthorized\)/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => { if (r.url().startsWith(base) && !/abort/i.test(r.failure()?.errorText || '')) problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`); });
  page.on('response', (r) => { if (r.url().startsWith(base) && r.status() >= 500) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  t.after(async () => { await ctx.close(); });
  await page.goto(`${base}/`);
  if (enterAge) { await page.getByRole('button', { name: /18 or older/ }).click(); await page.locator('main .card').first().waitFor(); }
  return { page, problems, shot: async (name) => {
    if (!shots) return;
    // page transitions fade content in: capture once they have finished
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { timeout: 3000 }).catch(() => {});
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, `${name}.png`) });
  } };
}
const noProblems = (problems) => assert.deepEqual(problems, [], problems.join('\n'));
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

describe('PRISM in a real browser', { timeout: 300000 }, () => {
  test('the age gate comes first; entering shows the library', async (t) => {
    const { page, problems, shot } = await visit(t, { enterAge: false });
    await assert.doesNotReject(page.getByRole('dialog', { name: 'Age verification' }).waitFor());
    await page.getByRole('button', { name: /18 or older/ }).click();
    await page.locator('main .card').first().waitFor();
    assert.ok(await page.locator('main .card').count() >= 10);
    await shot('home');
    noProblems(problems);
  });

  test('smart search reads plain language into filters', async (t) => {
    const { page, problems, shot } = await visit(t);
    await page.fill('#global-search', 'bearded guys at the beach, videos');
    await page.press('#global-search', 'Enter');
    await page.waitForURL(/#\/explore\?/);
    const url = decodeURIComponent(page.url());
    assert.match(url, /tags=beard,beach/);
    assert.match(url, /type=video/);
    await assert.doesNotReject(page.getByText('Understood as').waitFor());
    await shot('smart-search');
    noProblems(problems);
  });

  test('Find a creator: accounts are "found", grouped as one person only on evidence, and name matches are followed one by one', async (t) => {
    // The shape of a real "Christian Hogue" lookup: six accounts that share a name, two of which link to each other.
    const acct = (platform, target, extra = {}) => ({ platform, kind: 'user', target, label: target, url: `https://example.test/${platform}/${target}`, displayName: 'Christian Hogue', bio: null, avatarUrl: null, followers: 10, sampleCount: 0, samples: [], sample: null, evidence: ['Bluesky people search'], male: true, confidence: 0.5, tier: 'likely', status: 'new', feedId: null, creatorId: null, found: true, groupId: null, sameAs: [], externalLinks: [], ...extra });
    const linked = [
      acct('bluesky', 'christianhogue9.bsky.social', { groupId: 'g1', confidence: 0.8, tier: 'strong' }),
      acct('telegram', 'christian_hogue', { groupId: 'g1', confidence: 0.7, evidence: ['handle “christian_hogue” on Telegram'] }),
    ];
    const names = [acct('bluesky', 'hogueblog.bsky.social'), acct('bluesky', 'hogue38.bsky.social'), acct('bluesky', 'christianhogue912.bsky.social'),
      acct('redgifs', 'alphabottom', { displayName: 'Christian', externalLinks: [{ service: 'OnlyFans', label: 'OnlyFans', url: 'https://onlyfans.com/alphabottom', handle: 'alphabottom' }] })];
    const lookupBody = { query: 'Christian Hogue', name: 'Christian Hogue', handles: [], candidates: [...linked, ...names], accounts: [...linked, ...names], lookupId: 'lk-e2e', queryLinks: [], externalLinks: [], mediaHits: [], webLinks: [], hidden: { safety: 0, notMale: 0, unverified: 0 }, notes: [], searched: [], ms: 5,
      groups: [{ id: 'g1', members: ['bluesky:user:christianhogue9.bsky.social', 'telegram:user:christian_hogue'], evidence: [{ type: 'profile-link', detail: 'christianhogue9.bsky.social links to christian_hogue', a: 'bluesky:user:christianhogue9.bsky.social', b: 'telegram:user:christian_hogue' }] }] };
    const { page, problems, shot } = await visit(t, { serviceWorkers: 'block' });
    const follows = [];
    await page.route('**/api/lookup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lookupBody) }));
    await page.route('**/api/lookup/follow', (route) => { follows.push(JSON.parse(route.request().postData())); return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'stub: not followed' }) }); });
    await page.evaluate(() => { location.hash = '#/find?q=Christian%20Hogue'; });
    await page.getByText('6 accounts found').waitFor();
    const main = page.locator('main');
    // "found" says the account exists; nothing here claims "verified" or "same person" for a name match
    assert.equal(await main.getByText('Account found', { exact: true }).count(), 6);
    assert.doesNotMatch(await main.innerText(), /\bverified\b/i);
    assert.equal(await main.getByText('Follow all as one creator').count(), 0);
    // one evidence group: the two accounts that link to each other, with the evidence shown
    const group = main.locator('.find-group');
    assert.equal(await group.count(), 1);
    const groupText = await group.innerText();
    assert.match(groupText, /2 linked accounts/);
    assert.match(groupText, /christianhogue9\.bsky\.social/);
    assert.match(groupText, /christian_hogue/);
    assert.match(groupText, /christianhogue9\.bsky\.social links to christian_hogue/);
    assert.doesNotMatch(groupText, /hogue38|hogueblog|alphabottom/);
    // everything else is a separate possible match, followed one by one
    await main.getByText('Other accounts: possible matches').waitFor();
    const cards = main.locator('.find-cand');
    assert.equal(await cards.count(), 4);
    assert.equal(await main.getByText('Name match only', { exact: false }).count(), 4);
    assert.equal(await main.getByRole('button', { name: 'Follow this account' }).count(), 4);
    assert.equal(await main.getByRole('button', { name: /Follow these 2 as one creator/ }).count(), 1);
    await shot('find-grouping');
    // following a name match sends ONE account, with the lookup it came from
    await cards.filter({ hasText: 'hogue38.bsky.social' }).getByRole('button', { name: 'Follow this account' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('stub: not followed'));
    assert.equal(follows.length, 1);
    assert.deepEqual(follows[0].selections, [{ platform: 'bluesky', kind: 'user', target: 'hogue38.bsky.social' }]);
    assert.equal(follows[0].lookupId, 'lk-e2e');
    // following the group sends exactly its two accounts
    await main.getByRole('button', { name: /Follow these 2 as one creator/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.notice.warn').length > 0);
    await page.waitForTimeout(100);
    assert.equal(follows.length, 2);
    assert.deepEqual(follows[1].selections.map((x) => `${x.platform}:${x.target}`).sort(), ['bluesky:christianhogue9.bsky.social', 'telegram:christian_hogue']);
    noProblems(problems.filter((p) => !/status of 400|400 \(Bad Request\)/.test(p)));
  });

  test('words the rules cannot place are read by Claude, and Explore says so', async (t) => {
    const { page, problems, shot } = await visit(t);
    const before = aiState.requests;
    await page.fill('#global-search', 'scruffy chin fuzz clips');
    await page.press('#global-search', 'Enter');
    await page.waitForURL(/#\/explore\?.*ai=/);
    assert.equal(aiState.requests, before + 1, 'one request, on Enter only');
    await assert.doesNotReject(page.getByText('Read by AI: Bearded men, videos').waitFor());
    assert.match(decodeURIComponent(page.url()), /tags=beard/);
    await shot('ai-search');
    noProblems(problems);
  });

  test('the viewer opens from a card and closes with Escape', async (t) => {
    const { page, problems, shot } = await visit(t);
    await page.locator('main .card .card-media').first().click();
    const viewer = page.getByRole('dialog', { name: 'Media viewer' });
    await viewer.waitFor();
    assert.match(page.url(), /[?&]m=/);
    await shot('viewer');
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'detached' });
    assert.doesNotMatch(page.url(), /[?&]m=/);
    noProblems(problems);
  });

  test('creators: the list, then a profile', async (t) => {
    const { page, problems } = await visit(t);
    await page.goto(`${base}/#/creators`);
    const first = page.locator('main a[href*="#/creator/"]').first();
    await first.waitFor();
    await first.click();
    await page.waitForURL(/#\/creator\//);
    await page.locator('main h1').first().waitFor();
    noProblems(problems);
  });

  test('a takedown request can be sent from the footer, with every field labelled', async (t) => {
    const { page, problems } = await visit(t);
    // the link to report: an item's address, as a visitor would copy it from the viewer
    await page.locator('main .card .card-media').first().click();
    await page.getByRole('dialog', { name: 'Media viewer' }).waitFor();
    const itemUrl = page.url();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Report content / takedown' }).click();
    const dialog = page.getByRole('dialog', { name: /takedown request/ });
    await dialog.waitFor();
    // a link without an item or creator id is refused before anything is sent
    await dialog.getByLabel('Link').fill(`${base}/#/explore`);
    await dialog.getByRole('button', { name: 'Send request' }).click();
    await page.getByText('That link does not contain an item or creator id').waitFor();
    await dialog.getByLabel('Link').fill(itemUrl);
    await dialog.getByLabel('What is this about?').selectOption('other');
    await dialog.getByLabel('Details').fill('E2E test report');
    const sent = page.waitForResponse((r) => r.url().endsWith('/api/report') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Send request' }).click();
    assert.ok((await sent).ok());
    noProblems(problems);
  });

  test('admin: a wrong key is refused; the right one opens the console; Sources shows the engines', async (t) => {
    const { page, problems, shot } = await visit(t);
    await page.goto(`${base}/#/admin/sources`);
    await page.getByLabel('Admin key').fill('wrong');
    await page.keyboard.press('Enter');
    await page.getByText('That key was not accepted.').waitFor(); // asked again, and told why
    await page.getByLabel('Admin key').fill('test-key');
    await page.keyboard.press('Enter');
    await page.getByText('Engines: browsers and AI').waitFor();
    const text = await page.locator('main').innerText();
    assert.match(text, /Claude: claude-haiku-5-5/);
    await shot('admin-sources');
    noProblems(problems.filter((p) => !/HTTP 401|status of 401/.test(p)));
  });

  test('admin: a slow "wrong key" answer does not undo the right key typed after it', async (t) => {
    const { page, problems } = await visit(t);
    // the answer for the wrong key arrives late, after the right key was already sent
    await page.route('**/api/admin/overview', async (route) => {
      if (route.request().headers()['x-admin-key'] === 'wrong') await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto(`${base}/#/admin/sources`);
    await page.getByLabel('Admin key').fill('wrong');
    await page.keyboard.press('Enter');
    await page.getByLabel('Admin key').fill('test-key');
    await page.keyboard.press('Enter');
    await page.getByText('Engines: browsers and AI').waitFor();
    await page.waitForTimeout(2000); // past the late answer
    assert.equal(await page.getByText('This section failed to load').count(), 0);
    assert.equal(await page.getByLabel('Admin key').count(), 0, 'the console stays open');
    noProblems(problems.filter((p) => !/HTTP 401|status of 401/.test(p)));
  });

  test('on a phone: no sideways scrolling on Home, Explore or Creators', async (t) => {
    const { page, problems, shot } = await visit(t, { viewport: { width: 390, height: 844 } });
    for (const route of ['/', '/explore', '/creators']) {
      await page.goto(`${base}/#${route}`);
      await page.waitForLoadState('networkidle');
      assert.ok(await overflowX(page) <= 1, `${route} overflows by ${await overflowX(page)}px`);
    }
    await shot('phone-creators');
    noProblems(problems);
  });

  test('the theme toggle switches between light and dark', async (t) => {
    const { page, problems } = await visit(t, { colorScheme: 'dark' });
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const startTheme = await theme();
    await page.getByRole('button', { name: 'Toggle theme' }).click();
    // The flip runs inside a view transition (async by design): wait for the state instead of racing it.
    await page.waitForFunction((from) => document.documentElement.dataset.theme !== from, startTheme, { timeout: 4000 });
    assert.notEqual(await theme(), startTheme);
    noProblems(problems);
  });
});
