'use strict';
// The age/consent interstitial in front of an adult site (owner decision 2026-11-05): PRISM passes it with
// the site's own confirmation parameter and reads the page behind it. This is not a paywall bypass: the site
// records that the visitor is an adult and accepts its terms, nothing else is unlocked.
//
// Covered: a page that redirects to the interstitial and then yields media once confirmed; a page without a
// gate is read as it is; a gate that is already confirmed is not confirmed twice; the confirmation uses the
// site's own parameter.
const test = require('node:test');
const assert = require('node:assert/strict');
const mock = require('./helpers/mock');

mock.prepareEnv();
const agegate = require('../src/lib/agegate');

const GATE_HTML = `<html><head><title>Age</title></head><body>
  <div class="cookieAcceptBar">Before using this site, please verify you are 18 or older
  <button id="cookieAcceptBarConfirm">Accept and Close</button></div></body></html>`;

const CONTENT_HTML = `<html><head><title>Reno</title>
  <meta property="og:video" content="https://cdn.example.com/reno.mp4">
  <meta property="og:title" content="Reno Gold"></head><body>page</body></html>`;

test('the confirmation uses the site\'s own parameter', () => {
  const u = agegate.confirmFor('https://justfor.fans/renogold', 'https://justfor.fans/ageverify.php', GATE_HTML);
  assert.equal(u, 'https://justfor.fans/ageverify.php?TermsAgree=yes');
  assert.equal(agegate.confirmFor('https://example.com/p', 'https://example.com/p', '<html>hi</html>'), null);
  assert.equal(agegate.confirmFor('https://justfor.fans/ageverify.php?TermsAgree=yes', 'https://justfor.fans/ageverify.php?TermsAgree=yes', GATE_HTML), null);
});

test('a page behind an age/consent interstitial is read once it is confirmed', async () => {
  const srv = await mock.start({
    '/robots.txt': () => ({ status: 200, body: 'User-agent: *\nAllow: /\n' }),
    '/creator': (req, res) => { res.writeHead(302, { Location: '/ageverify.php' }); res.end(); return null; },
    '/ageverify.php': (req, res, url) => (url.searchParams.get('TermsAgree') === 'yes'
      ? { status: 200, body: CONTENT_HTML }
      : { status: 200, body: GATE_HTML }),
  });
  try {
    const { webAdapter } = require('../src/sources/web');
    const out = await webAdapter.fetch({ target: `${srv.url}/creator`, platform: 'web', kind: 'page' });
    assert.ok(out.info.some((i) => /age\/consent interstitial/.test(i)), `the run says it passed the gate: ${JSON.stringify(out.info)}`);
    assert.equal(out.items.length, 1, 'the media behind the gate is ingested');
    assert.equal(out.items[0].mediaUrl, 'https://cdn.example.com/reno.mp4');
    assert.ok(srv.hits.some((h) => h.includes('TermsAgree=yes')), `the confirmation was requested: ${JSON.stringify(srv.hits)}`);
  } finally {
    await srv.close();
  }
});

test('a page without a gate is read as it is', async () => {
  const srv = await mock.start({
    '/robots.txt': () => ({ status: 200, body: 'User-agent: *\nAllow: /\n' }),
    '/plain': () => ({ status: 200, body: CONTENT_HTML }),
  });
  try {
    const { webAdapter } = require('../src/sources/web');
    const out = await webAdapter.fetch({ target: `${srv.url}/plain`, platform: 'web', kind: 'page' });
    assert.equal(out.items.length, 1);
    assert.equal(out.info.filter((i) => /interstitial/.test(i)).length, 0, 'no gate, no confirmation');
    assert.equal(srv.hits.filter((h) => h.includes('TermsAgree')).length, 0);
  } finally {
    await srv.close();
  }
});
