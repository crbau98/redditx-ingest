'use strict';
/**
 * grounded() (engine/ai.js) on the bio shapes found in the wild: a platform label counts only at the start of its segment
 * (segments end at | • · , . ! ? or a newline), so "IG: @x" is his own account and "photographer: IG @x", "video by IG @x" or
 * "boyfriend's IG: @x" are someone else's. Bare "of" / "x" are labels only before ":" or an emoji. Role words ("husband",
 * "fan", "manager", "feat.", ...) and "my <anything that is not a platform>" mark a third party. Own-links entries count,
 * unless their label names someone else. The cases are Crucible's grounded3 table plus a few more.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/mock').prepareEnv();
const ai = require('../src/engine/ai');

const lc = (x) => String(x).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
const g = (line, value, links = []) => ai.grounded(lc(line), line, value, links);

// [bio line, value, accepted?]
const OWN = [
  ['LA | IG: @zed_la | 28', 'zed_la'], ['X: @antoniogambinox', 'antoniogambinox'], ['Insta: @antonioxgambino', 'antonioxgambino'],
  ['Zed. Bluesky: zedfit.bsky.social', 'zedfit.bsky.social'], ['OF 👉 zedof', 'zedof'], ['📸 IG @zedpix', 'zedpix'], ['TikTok | @zedtt', 'zedtt'],
  ['follow me! @zedx', 'zedx'], ['backup: @zed_alt', 'zed_alt'], ['I post on r/malefitness', 'malefitness'],
  ['OF: zedof', 'zedof'], ['IG: @jake_fit', 'jake_fit'], ['Twitter: @jake_fit', 'jake_fit'], ['TG: @jake_fit', 'jake_fit'],
  ['gym rat, coffee, IG: @jake_fit, OF: jake_vip', 'jake_vip'], ['Fitness model. IG: @jake_fit', 'jake_fit'], ['🔥 OnlyFans 👉 jake_fit', 'jake_fit'],
  ['Photographer. IG: @lensman', 'lensman'], // he is the photographer: the account after the full stop is his
  ['Bluesky⚣Snap⚣Telegram⚣Vero⚣Discord⚣Reddit: @ShyNudistGuy', 'ShyNudistGuy'], ['IG / TikTok: @zed', 'zed'],
  ['IG: @zedok | no DMs on my IG', 'zedok'], ['IG: @zedok2 | not into politics', 'zedok2'], ['IG: @zedok3 (official)', 'zedok3'],
  ['Twitter/X: @zedlifts', 'zedlifts'], ['X/Twitter: @zedlifts', 'zedlifts'], ['Reddit: u/zedred', 'zedred'], ['reddit - u/zedred', 'zedred'],
  ['Photographer | IG: @lensman', 'lensman'], // an occupation in the segment before is not a third party
];
const THIRD = [
  ['my ex is jake_fit', 'jake_fit'], ['photo by IG: @pixguy', 'pixguy'], ['shout out @bro', 'bro'], ['collab with IG: @bro', 'bro'],
  ["boyfriend's IG: @bf_handle", 'bf_handle'], ['taken by @him | bf: IG @him', 'him'], ["Dad's IG: @dadhandle", 'dadhandle'],
  ['Photographer: IG @lensman', 'lensman'], ['Booking & mgmt: IG @agentx', 'agentx'], ['video by IG @editor1', 'editor1'],
  ['edits by X: @editor2', 'editor2'], ['Fan of @lakersfan', 'lakersfan'], ['Proud of @sonname', 'sonname'], ['photos of @somebody', 'somebody'],
  ['sponsored by OF @brandx', 'brandx'], ['husband of @spouse', 'spouse'], ['married to IG: @spouse2', 'spouse2'],
  ['shoot w/ model IG @modelx', 'modelx'], ['feat. IG: @featx', 'featx'], ['thx IG @helper', 'helper'], ['roommate IG @roomie', 'roomie'],
  ['my boy IG @homie', 'homie'], ['Ex-boyfriend X @exguy', 'exguy'], ['my friend IG: @pal', 'pal'], ['manager: X: @mgr', 'mgr'],
  ['x @notalabel', 'notalabel'], ['top fan of @star', 'star'], ['Photographer ⚣ Reddit: @lensman2', 'lensman2'], ['Taking care of @pig', 'pig'],
  ['ig: @notme (not me)', 'notme'], ['Not my account: IG @nope', 'nope'], ['IG: @zed2 - isn\'t me', 'zed2'], ['IG: @zedfan fan page', 'zedfan'], ['unofficial IG: @zed3', 'zed3'], ['Parody of IG: @par', 'par'], ['IG: @zed4 (not affiliated)', 'zed4'],
  ['bf | IG @bfhandle', 'bfhandle'], ['bf. IG: @bfhandle', 'bfhandle'], ['husband | IG: @hubby', 'hubby'], ['my boyfriend • X: @bfx', 'bfx'], // a relationship word right before the label
];

describe('platform labels at the start of a segment are his own account', () => {
  for (const [line, value] of OWN) test(`accepts: ${line}`, () => assert.equal(g(line, value), true));
});
describe('third-person lines are never his, label or not', () => {
  for (const [line, value] of THIRD) test(`rejects: ${line}`, () => assert.equal(g(line, value), false));
});

describe('bare "of" and "x" are labels only with a colon or an emoji', () => {
  test('"OF: x", "X: x" and "OF 👉 x" pass; "of @x" and "x @y" do not', () => {
    assert.equal(g('OF: zedof', 'zedof'), true);
    assert.equal(g('X: zedx', 'zedx'), true);
    assert.equal(g('OF 👉 zedof', 'zedof'), true);
    assert.equal(g('of @zedof', 'zedof'), false);
    assert.equal(g('x @zedx', 'zedx'), false);
  });
});

describe('own links list', () => {
  const links = [{ label: 'Bluesky', url: 'https://bsky.app/profile/zed.bsky.social' }, { label: 'Collab with Bob', url: 'https://linktr.ee/bobsburgers' }, { label: "Friend's page", url: 'https://example.com/pal' }];
  const hay = lc(links.map((l) => `${l.label} ${l.url}`).join('\n'));
  test('an entry labelled with a platform is his', () => {
    assert.equal(ai.grounded(hay, 'Bluesky https://bsky.app/profile/zed.bsky.social', 'zed.bsky.social', links), true);
  });
  test('an entry whose label names someone else does not count', () => {
    assert.equal(ai.grounded(hay, 'Collab with Bob https://linktr.ee/bobsburgers', 'bobsburgers', links), false);
    assert.equal(ai.grounded(hay, "Friend's page https://example.com/pal", 'pal', links), false);
  });
});
