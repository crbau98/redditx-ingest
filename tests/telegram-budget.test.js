'use strict';
/** A channel read is cut to the day's download budget and the cursors stop at the last message kept (nothing is skipped, it waits). */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepareEnv } = require('./helpers/mock');
const { s3Server, ACCESS, SECRET, BUCKET } = require('./helpers/s3');

let s3; let mt; let tg; let budget;
before(async () => {
  s3 = await s3Server();
  prepareEnv({ MEDIA_STORE_ENDPOINT: s3.url, MEDIA_STORE_BUCKET: BUCKET, MEDIA_STORE_ACCESS_KEY_ID: ACCESS, MEDIA_STORE_SECRET_ACCESS_KEY: SECRET });
  mt = require('../src/lib/telegram-mtproto'); tg = require('../src/sources/telegram'); budget = require('../src/services/budget');
});
after(async () => { mt._setFactory(null); await s3.close(); });

const MB = 1048576;
const video = (id, size = 10 * MB) => ({ id, message: `clip ${id}`, date: 1700000000 + id, views: 1, media: { className: 'MessageMediaDocument', document: { className: 'Document', mimeType: 'video/mp4', size, thumbs: [{ className: 'PhotoSize', w: 90, h: 90, size: 500 }], attributes: [{ className: 'DocumentAttributeVideo', duration: 5, w: 640, h: 480 }] } } });
function client(messages) {
  return {
    async connect() {}, async checkAuthorization() { return true; }, async disconnect() {},
    async getDialogs() { return []; },
    async getEntity() { return { className: 'Channel', id: 100, username: 'gymbros', title: 'Gym Bros', broadcast: true }; },
    async getMessages(entity, o = {}) {
      let list = messages.slice();
      if (o.minId) list = list.filter((m) => m.id > o.minId);
      if (o.offsetId) list = list.filter((m) => m.id < o.offsetId);
      list.sort((a, b) => (o.reverse ? a.id - b.id : b.id - a.id));
      return list.slice(0, o.limit || 100);
    },
    async invoke() { return { fullChat: { about: '' } }; }, async downloadProfilePhoto() { return null; },
  };
}

test('five 10 MB videos with 25 MB left: two now, none while the budget is spent, the rest on a later day, no message skipped', async () => {
  mt._setFactory(async () => client([1, 2, 3, 4, 5].map((i) => video(i))));
  const feed = { target: 'gymbros', trusted: 1, label: 'Gym Bros' };
  const realLeft = budget.bytesLeft;
  try {
    budget.bytesLeft = () => 25 * MB;
    const a = await tg.fetchChannel(feed, { cursor: {}, aborted: () => false, limit: 40, needProfile: false });
    assert.deepEqual(a.items.map((i) => i.sourceId.split(':').pop()).length, 2, 'two videos fit in 25 MB');
    assert.equal(a.cursor.newestId, 5); assert.equal(a.cursor.oldestId, 4); assert.equal(a.cursor.done, false, 'older messages are still waiting');

    budget.bytesLeft = () => 0;
    const b = await tg.fetchChannel(feed, { cursor: a.cursor, aborted: () => false, limit: 40, needProfile: false });
    assert.equal(b.items.length, 0); assert.deepEqual(b.cursor.newestId, 5); assert.equal(b.cursor.oldestId, 4);
    assert.match(b.notes[0], /daily download budget reached/);

    budget.bytesLeft = () => Infinity; // tomorrow
    const c = await tg.fetchChannel(feed, { cursor: b.cursor, aborted: () => false, limit: 40, needProfile: false });
    assert.equal(c.items.length, 3, 'messages 3, 2 and 1 are read now');
    assert.equal(c.cursor.done, true); assert.equal(c.cursor.oldestId, 1);
  } finally { budget.bytesLeft = realLeft; }
});
