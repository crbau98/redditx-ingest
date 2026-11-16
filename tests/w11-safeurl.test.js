'use strict';
/** Only http(s) links leave the server (Crucible wave 11, item 11). */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');

prepareEnv({ ADMIN_KEY: 'test-key' });
let repo; let safe;
before(() => { repo = require('../src/db/repo'); safe = require('../src/lib/safeurl'); });

test('httpUrl and safeLinks keep http(s) only', () => {
  assert.equal(safe.httpUrl(' https://a.example/x '), 'https://a.example/x');
  for (const bad of ['javascript:alert(1)', '  JaVaScRiPt:alert(2)', 'data:text/html;base64,AAAA', 'vbscript:x', '//evil.example', '', null, 5]) assert.equal(safe.httpUrl(bad), null);
  assert.deepEqual(safe.safeLinks([
    { url: 'javascript:alert(1)', label: 'x' },
    { url: 'data:text/html,hi', handle: 'kept_handle', service: 'OnlyFans' },
    { url: 'https://onlyfans.com/ok', label: 'ok' },
    { handle: 'only_handle' },
  ]), [{ handle: 'kept_handle', service: 'OnlyFans' }, { url: 'https://onlyfans.com/ok', label: 'ok' }, { handle: 'only_handle' }]);
});

test('stored javascript: links and source URLs are not served', () => {
  const c = repo.creators.create({ handle: 'w11safeurl', displayName: 'W', scope: 'in' });
  const id = c.id || c;
  repo.db.prepare("UPDATE creators SET links = ? WHERE id = ?").run(JSON.stringify([{ url: 'javascript:alert(1)' }, { url: 'https://x.example/ok' }]), id);
  assert.deepEqual(repo.creators.get(id).links.map((l) => l.url), ['https://x.example/ok']);
  repo.creators.enrich(id, { links: [{ url: 'data:text/html,hi', label: 'd' }, { url: 'https://y.example/ok', label: 'y' }] });
  assert.ok(!repo.db.prepare('SELECT links FROM creators WHERE id = ?').get(id).links.includes('data:'), 'not stored on enrich');
  const mid = repo.media.insert({ platform: 'web', source_id: 'su1', source_key: 'web:su1:0', post_key: 'web:su1', author: 'a', creator_id: id,
    source_url: 'javascript:alert(3)', media_type: 'image', media_url: 'https://cdn.example/su1.jpg', hash: 'suh1' }, []);
  assert.equal(repo.media.get(mid).source_url, null);
});

test('web matches serve only http(s) page and image URLs; a javascript: page is dropped', () => {
  const c = repo.creators.create({ handle: 'w11webmatch', displayName: 'WM', scope: 'in' });
  const id = c.id || c;
  const ins = repo.db.prepare('INSERT INTO creator_web_matches (creator_id,page_url,image_url,title,platform,match_kind,similarity,status) VALUES (?,?,?,?,?,?,?,?)');
  ins.run(id, 'javascript:alert(document.cookie)', 'https://img.example/a.jpg', 't', 'web', 'same-image', 0.99, 'confirmed');
  ins.run(id, 'https://page.example/ok', 'data:image/svg+xml;base64,AAAA', 't', 'web', 'same-image', 0.98, 'confirmed');
  const rows = require('../src/lib/face-match').listWebMatches({ creatorId: id, status: 'confirmed' });
  assert.deepEqual(rows.map((r) => [r.page_url, r.image_url]), [['https://page.example/ok', null]]);
});
