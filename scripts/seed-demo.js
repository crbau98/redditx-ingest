'use strict';
/**
 * Fills a DEVELOPMENT database with abstract, generated placeholder content so
 * the UI can be explored offline:
 *
 *     DEMO_ART=1 DB_PATH=./data/demo.db node scripts/seed-demo.js
 *     DEMO_ART=1 DB_PATH=./data/demo.db ADMIN_KEY=dev node server.js
 *
 * Nothing here is real content; images are procedurally generated gradients.
 * Refuses to run in production.
 */
require('dotenv').config();
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (process.env.NODE_ENV === 'production') { console.error('Refusing to seed demo data in production.'); process.exit(1); }
process.env.DEMO_ART = '1';

const config = require('../src/config');
const repo = require('../src/db/repo');

const demoDir = path.join(config.dataDir, 'demo');
fs.mkdirSync(demoDir, { recursive: true });
const videoPath = path.join(demoDir, 'video.webm');
if (!fs.existsSync(videoPath)) {
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=24', '-t', '4', '-c:v', 'libvpx', '-b:v', '600k', '-an', videoPath]);
    console.log('generated demo video');
  } catch { console.log('ffmpeg not available — demo videos will show posters only'); }
}

let n = 7;
const rand = () => { n = (n * 1103515245 + 12345) & 0x7fffffff; return n / 0x7fffffff; };
const pick = (a) => a[Math.floor(rand() * a.length)];

const platforms = ['reddit', 'redgifs', 'bluesky', 'mastodon', 'x'];
const communities = { reddit: ['gaybrosgonewild', 'boyswithabs', 'gaymuscle', 'twinks', 'bearsgonewild', 'jockstraps'], redgifs: ['muscle', 'jock'], bluesky: [null], mastodon: ['mastodon.social'], x: [null] };
const tagPool = ['muscle', 'gym', 'beach', 'bear', 'twink', 'jock', 'bulge', 'selfie', 'outdoors', 'mirror', 'tattoo', 'beard', 'abs', 'shower', 'locker-room', 'swim'];
const names = ['Atlas', 'Cade', 'Dante', 'Everett', 'Felix', 'Gray', 'Hollis', 'Ivo', 'Jules', 'Knox', 'Lennox', 'Milo', 'Nico', 'Orion', 'Pax', 'Quill', 'Reid', 'Soren', 'Theo', 'Uri'];
const ratios = [[4, 5], [3, 4], [1, 1], [9, 16], [2, 3], [5, 4], [16, 9]];
const bios = ['Fitness, travel and the occasional bad decision.', 'Coach by day. Lifting, lakes, and good lighting.', 'Photographer + model. Based between two cities.', 'Here for the pump and the playlists.', 'Dad-bod energy, boy-next-door smile.'];

const creators = names.map((name, i) => {
  const handle = `${name.toLowerCase()}_${pick(['fit', 'xo', 'lifts', 'nyc', 'bear', 'sun'])}`;
  const plats = [pick(platforms), pick(platforms)].filter((v, idx, a) => a.indexOf(v) === idx);
  const c = repo.creators.create({ handle, displayName: name, bio: pick(bios), avatarUrl: `/demo/art/av${i}/200/200.svg`, bannerUrl: `/demo/art/bn${i}/1200/360.svg`, origin: 'admin' });
  repo.creators.update(c.id, { verified: rand() > 0.6, links: rand() > 0.5 ? [{ platform: 'external', service: 'OnlyFans', label: `OnlyFans · ${handle}`, url: 'https://onlyfans.com/' } , { platform: 'external', service: 'Throne', label: 'Throne wishlist', url: 'https://throne.com/' }] : [] });
  for (const p of plats) {
    const a = require('../src/sources').get(p);
    if (a && a.kinds.includes('user')) repo.feeds.upsert({ platform: p, kind: 'user', target: p === 'mastodon' ? `${handle}@mastodon.social` : handle, creatorId: c.id, origin: 'admin', enabled: rand() > 0.3 ? 1 : 0, runNow: false });
  }
  return { ...c, plats };
});

const now = Date.now();
let added = 0;
for (let i = 0; i < 160; i++) {
  const c = pick(creators);
  const platform = pick(c.plats.length ? c.plats : platforms);
  const [rw, rh] = pick(ratios);
  const w = 1080; const h = Math.round((1080 * rh) / rw);
  const isVideo = rand() > 0.72;
  const seed = `m${i}`;
  const art = `/demo/art/${seed}/${w}/${h}.svg`;
  const community = pick(communities[platform] || [null]);
  const tags = [pick(tagPool), pick(tagPool), pick(tagPool), platform].concat(community ? [community] : []);
  const posted = new Date(now - Math.floor(rand() * 40 * 86400000)).toISOString();
  const id = repo.media.insert({
    creator_id: c.id, platform, source_id: `demo-${i}`, source_key: `${platform}:demo-${i}:0`, post_key: `${platform}:demo-${i}`,
    source_url: 'https://example.com/', community, author: c.handle,
    title: pick(['Morning light', 'Post-workout', 'Weekend away', 'New set', 'Golden hour', 'Pool day', 'Back at it', 'Throwback', 'Mirror check', 'Trail run']) + (rand() > 0.7 ? ' ☀️' : ''),
    media_type: isVideo ? 'video' : 'image', media_url: isVideo && fs.existsSync(videoPath) ? '/demo/video.webm' : art,
    preview_url: art, width: w, height: h, duration: isVideo ? 4 : null, has_audio: 0,
    score: Math.floor(rand() * rand() * 5000), likes: Math.floor(rand() * 40), views: Math.floor(rand() * 900),
    hash: crypto.createHash('md5').update(`demo-${i}`).digest('hex'), nsfw_level: rand() > 0.15 ? 'explicit' : 'suggestive', posted_at: posted,
  }, tags);
  if (id) added++;
}
for (const c of creators) repo.creators.refreshStats(c.id);
repo.media.recomputeHot();
repo.settings.set('seed_version', '999'); // don't add the real default feeds to a demo DB

// A few review items + a report so the admin queues have something in them.
const some = repo.media.list({ limit: 3, sort: 'random', seed: 3 }).items;
some.slice(0, 2).forEach((m) => repo.media.setState(m.id, 'review', 'scope:unclear'));
if (some[2]) repo.reports.create({ mediaId: some[2].id, kind: 'takedown', reason: 'Demo report: owner requests removal', contact: 'owner@example.com' });

console.log(`Seeded ${added} demo items, ${creators.length} creators → ${config.dbPath}`);
