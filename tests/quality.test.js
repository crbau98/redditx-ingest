const assert = require('assert');
const {
  hostBlocked,
  classifyUrl,
  looksFemaleTagged,
  itemPassesQuality,
  isJunkTitle,
} = require('../services/media-quality');
const catalog = require('../services/ingest-catalog');

assert.ok(hostBlocked('images.unsplash.com'), 'unsplash blocked');
assert.ok(hostBlocked('onlyfans.com'), 'onlyfans.com blocked');
assert.ok(hostBlocked('cdn.onlyfans.com'), 'OF CDN blocked');
assert.ok(hostBlocked('coomer.su'), 'leaked vault blocked');
assert.strictEqual(classifyUrl('https://images.unsplash.com/photo-1').ok, false);
assert.strictEqual(classifyUrl('https://onlyfans.com/user/photo.jpg').ok, false);

assert.ok(isJunkTitle('The image you are requesting does not exist'));
assert.ok(looksFemaleTagged('busty milf onlyfans'));
assert.ok(looksFemaleTagged('lesbian amateur'));
assert.ok(looksFemaleTagged('hot girl nudes'));
assert.ok(looksFemaleTagged('pussy closeup gay')); // hard female still drops
assert.ok(!looksFemaleTagged('gay twink cock'));
assert.ok(!looksFemaleTagged('muscle jock onlyfans male'));
assert.ok(!looksFemaleTagged('good girl', { gayContext: true }));
assert.ok(looksFemaleTagged('solo female'));

const pack = catalog.packById('onlyfans');
const blob = JSON.stringify(pack);
assert.ok(pack.x.some((q) => /site:x\.com/i.test(q)));
assert.ok(!/https?:\/\/(www\.)?onlyfans\.com/i.test(blob), 'no onlyfans.com URLs in query pack');

async function main() {
  const unsplash = await itemPassesQuality({
    title: 'gay muscle',
    mediaUrl: 'https://images.unsplash.com/photo.jpg',
  });
  assert.strictEqual(unsplash.ok, false, 'unsplash rejected');

  const ofPaid = await itemPassesQuality({
    title: 'gay onlyfans',
    mediaUrl: 'https://cdn.onlyfans.com/files/abc.mp4',
  });
  assert.strictEqual(ofPaid.ok, false, 'onlyfans CDN rejected');

  const female = await itemPassesQuality({
    title: 'busty lesbian milf',
    mediaUrl: 'https://i.redd.it/abc.jpg',
  });
  assert.strictEqual(female.ok, false, 'female title rejected');

  console.log('quality.test.js ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
