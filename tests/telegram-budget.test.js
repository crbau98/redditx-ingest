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

/* ---- 7. every downloaded byte is charged, and photo batches are sized from the real sizes ---- */
const photo = (id, bytes) => ({ id, message: `pic ${id}`, date: 1700000000 + id, views: 1, media: { className: 'MessageMediaPhoto', photo: { className: 'Photo', sizes: [{ className: 'PhotoSize', w: 320, h: 240, size: 9000 }, { className: 'PhotoSize', w: 1280, h: 960, size: bytes }] } } });

function counting(messages) {
  const c = client(messages);
  c.downloadProfilePhoto = async () => Buffer.alloc(3000, 5);
  c.downloadMedia = async (msg, o = {}) => {
    if (o.thumb !== undefined) return Buffer.alloc(700, 9); // GramJS: the thumb option is an index, 0 is valid
    if (o.outputFile) { require('fs').writeFileSync(o.outputFile, Buffer.alloc(20000, 7)); return o.outputFile; }
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4996, 3)]);
  };
  return c;
}

test('describeMedia reports the real byte size of the largest photo rendition (also a progressive JPEG\'s largest step)', () => {
  assert.equal(mt.describeMedia(photo(1, 400000)).size, 400000);
  const prog = { id: 2, media: { className: 'MessageMediaPhoto', photo: { className: 'Photo', sizes: [{ className: 'PhotoSizeProgressive', w: 1280, h: 960, sizes: [1000, 5000, 250000] }] } } };
  assert.equal(mt.describeMedia(prog).size, 250000);
});

test('a photo batch is cut by the real sizes: three 400 KB photos with 1 MB left give two, not a count based on an assumed 1.5 MB', async () => {
  mt._setFactory(async () => counting([1, 2, 3].map((i) => photo(i, 400 * 1024))));
  const realLeft = budget.bytesLeft; budget.bytesLeft = () => 1048576;
  try {
    const r = await tg.fetchChannel({ target: 'gymbros', trusted: 1, label: 'Gym Bros' }, { cursor: {}, aborted: () => false, limit: 40, needProfile: false });
    assert.equal(r.items.length, 2);
  } finally { budget.bytesLeft = realLeft; }
});

test('downloaded bytes are charged when they are downloaded: a rejected photo, a video and its poster, and the channel avatar', async () => {
  require('../src/db/repo').settings.set('budget_runs', ''); budget._reset(); // the day's counter is persisted: start clean
  const fs = require('fs');
  mt._setFactory(async () => counting([photo(1, 5000), { ...video(2, 20000) }]));
  const r = await tg.fetchChannel({ target: 'gymbros', trusted: 1, label: 'Gym Bros' }, { cursor: {}, aborted: () => false, limit: 40, needProfile: true });
  const charged = () => (budget.status().bytes || {}).telegram || 0;
  assert.equal(charged(), 3000, 'the avatar');
  const [img, vid] = [r.items.find((i) => i.mediaType === 'image'), r.items.find((i) => i.mediaType === 'video')];
  await img.stage(img);                      // the picture the gates look at
  assert.equal(charged(), 3000 + 5000);
  await img.discard();                       // ... and the gates reject it: the bytes were still downloaded
  assert.equal(charged(), 3000 + 5000, 'a rejected item stays charged');
  await vid.stage(vid);                      // a video's poster frame
  assert.equal(charged(), 3000 + 5000 + 700);
  await vid.materialize(vid);                // the video file itself; the poster is reused, not charged twice
  assert.equal(charged(), 3000 + 5000 + 700 + 20000);
  assert.equal(fs.readdirSync(require('os').tmpdir()).filter((f) => f.startsWith(`prism-tg-${process.pid}`)).length, 0, 'no temp file is left behind');
  require('../src/db/repo').settings.set('budget_runs', ''); budget._reset();
});
