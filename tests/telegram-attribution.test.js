'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');
prepareEnv({ MEDIA_STORE: 'disk' });
const repo = require('../src/db/repo');
const tg = require('../src/sources/telegram');
const pipeline = require('../src/engine/pipeline');

test('MTProto preserves group sender and forward identifiers', () => {
  const msg = { id: 5, message: 'gym', fromId: { userId: 123 }, fwdFrom: { fromId: { channelId: 456 }, channelPost: 9 } };
  const item = tg.messageToItem(msg, { ext: 'jpg', type: 'image' }, { id: '42', username: 'owner', megagroup: true });
  assert.deepEqual(item.attributionEvidence.sender, { type: 'userId', id: '123' });
  assert.deepEqual(item.attributionEvidence.forward.from, { type: 'channelId', id: '456' });
  assert.equal(item.attributionEvidence.forward.messageId, '9');
  assert.ok(item.repostOf);
});

test('ambiguous group and forwarded posts enter review without an attributed creator', async () => {
  const c = repo.creators.create({ handle: 'testowner', origin: 'admin' });
  const feed = repo.feeds.upsert({ platform: 'telegram', kind: 'channel', target: 'testowner', creatorId: c.id, trusted: 1, origin: 'admin' }).feed;
  for (const [id, evidence, repostOf] of [
    ['group', { channelId: '42', megagroup: true, sender: { type: 'userId', id: '123' } }, undefined],
    ['forward', { channelId: '42', broadcast: true, sender: { type: 'channelId', id: '42' }, forward: { from: { type: 'channelId', id: '456' } } }, { platform: 'telegram' }],
  ]) {
    const result = await pipeline.processItem({ sourceId: id, author: 'testowner', title: 'male gym jock', mediaType: 'image', mediaUrl: `https://i.redd.it/${id}.jpg`, trusted: true, attributionEvidence: evidence, repostOf }, feed, null, { scopeMode: 'open', probeUnknownHosts: false });
    assert.equal(result.outcome, 'review');
    const row = repo.db.prepare('SELECT creator_id, attribution_evidence FROM media WHERE id = ?').get(result.mediaId);
    assert.equal(row.creator_id, null);
    assert.deepEqual(JSON.parse(row.attribution_evidence), evidence);
  }
  const ownEvidence = { channelId: '42', broadcast: true, sender: { type: 'channelId', id: '42' } };
  const own = await pipeline.processItem({ sourceId: 'own', author: 'testowner', title: 'male gym jock', mediaType: 'image', mediaUrl: 'https://i.redd.it/own-attribution.jpg', trusted: true, attributionEvidence: ownEvidence }, feed, null, { scopeMode: 'open', probeUnknownHosts: false });
  assert.equal(own.outcome, 'added');
  assert.equal(own.creatorId, c.id);
  const tagged = await pipeline.processItem({ sourceId: 'tagged', author: 'testowner', title: 'male gym jock @differentperson', mediaType: 'image', mediaUrl: 'https://i.redd.it/tagged-attribution.jpg', trusted: true, attributionEvidence: ownEvidence }, feed, null, { scopeMode: 'open', probeUnknownHosts: false });
  assert.equal(tagged.outcome, 'review');
  assert.equal(tagged.creatorId, null);
});

test('bare handles do not match creators on a different platform', () => {
  const c = repo.creators.create({ handle: 'collisionunique', origin: 'admin', bio: 'male' });
  repo.feeds.upsert({ platform: 'x', kind: 'user', target: 'collisionunique', creatorId: c.id, origin: 'admin' });
  assert.equal(pipeline.mentionedKnownCreator({ author: 'other', text: '@collisionunique' }, { platform: 'telegram' }), null);
});
