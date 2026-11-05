'use strict';
/**
 * Builds a SCALED synthetic development database, to measure the backend on a library of production size
 * (hundreds of thousands of media rows, ten thousand creators), which scripts/seed-demo.js (160 items) cannot show.
 *
 *     DB_PATH=/tmp/scale.db node scripts/seed-scale.js
 *     SCALE_MEDIA=300000 SCALE_CREATORS=10000 SCALE_SEED=7 DB_PATH=/tmp/scale.db node scripts/seed-scale.js
 *
 * - Dev only: refuses to run when NODE_ENV=production, and refuses to touch a database that already has rows.
 * - Deterministic: one seeded PRNG drives every choice; the same SCALE_* values give the same rows. Timestamps are
 *   offsets from SCALE_ANCHOR (an ISO time, default: now), so "posted this week" stays true whenever it is generated.
 * - No network, no real content: handles are `creator_00042`, titles are `Post 123456`, URLs are on the reserved
 *   `.invalid` TLD, vectors are random bytes. The shape (distributions, states, links, tags, embeddings) is what matters.
 * - Writes the database only (DB_PATH). Nothing generated is meant to be committed (data/ and *.db are gitignored).
 *
 * Distributions (all heavy-tailed, as on the real library): creators' post counts and communities follow a Zipf law;
 * ~88% of media is published (review / hidden / removed make up the rest); ~3% is scope 'excluded'; ~2% of creators are
 * hidden or blocked; ~19% of creators carry an OnlyFans link (a few more Fansly or other links); tags follow a Zipf law
 * over a vocabulary of ~700; embeddings cover the newest ~40% of published rows (the backfill runs newest first) plus
 * a few 'fail' rows.
 */
const crypto = require('crypto');
const fs = require('fs');

if (process.env.NODE_ENV === 'production') { console.error('Refusing to generate scale data in production.'); process.exit(1); }
if (!process.env.DB_PATH) { console.error('Set DB_PATH to the database file to create, e.g. DB_PATH=/tmp/scale.db'); process.exit(2); }
if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) { console.error('Refusing to generate scale data on a hosted environment.'); process.exit(1); }

const N_MEDIA = Math.max(1000, parseInt(process.env.SCALE_MEDIA || '300000', 10));
const N_CREATORS = Math.max(50, parseInt(process.env.SCALE_CREATORS || '10000', 10));
const SEED = parseInt(process.env.SCALE_SEED || '7', 10);
const ANCHOR = Date.parse(process.env.SCALE_ANCHOR || '') || Date.now();

const { db } = require('../src/db');
const emb = require('../src/lib/embeddings');
// Bulk load: random-key unique indexes (id, hash, source_key) thrash a small page cache once the table is large.
db.pragma('cache_size = -600000');
db.pragma('synchronous = OFF');

if (db.prepare('SELECT COUNT(*) AS n FROM media').get().n > 0 || db.prepare('SELECT COUNT(*) AS n FROM creators').get().n > 0) {
  console.error('Refusing to seed: the database already has rows. Point DB_PATH at a new file.');
  process.exit(1);
}

/* ------------------------------------------------------------------ random */
let s = (SEED * 2654435761) >>> 0;
const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (n) => Math.floor(rand() * n);
const chance = (p) => rand() < p;
/** Sampler over weights, O(log n) per draw. */
function sampler(weights) {
  const cum = []; let tot = 0;
  for (const w of weights) { tot += w; cum.push(tot); }
  return () => { const x = rand() * tot; let lo = 0; let hi = cum.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
}
const zipf = (n, a) => Array.from({ length: n }, (_, i) => 1 / Math.pow(i + 1, a));
const uuidOf = (kind, i) => { const h = crypto.createHash('md5').update(`${SEED}:${kind}:${i}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;

/* ------------------------------------------------------------- vocabularies */
const PLATFORMS = ['reddit', 'redgifs', 'bluesky', 'mastodon', 'x', 'tumblr', 'telegram', 'peertube', 'rss'];
const PLATFORM_W = [45, 25, 8, 6, 6, 4, 3, 1.5, 1.5];
const pickPlatform = sampler(PLATFORM_W);
const BASE_TAGS = ['gay', 'nsfw', 'video', 'photo', 'muscle', 'gym', 'beach', 'bear', 'twink', 'jock', 'selfie', 'outdoors', 'mirror', 'tattoo', 'beard', 'abs', 'swim', 'shower', 'locker-room', 'travel', 'fitness', 'athletic', 'cosplay', 'party', 'hiking', 'pool', 'sunset', 'portrait', 'couple', 'solo'];
const TAGS = [...BASE_TAGS, ...Array.from({ length: 700 - BASE_TAGS.length }, (_, i) => `tag-${String(i).padStart(3, '0')}`)];
const pickTag = sampler(zipf(TAGS.length, 0.95));
const N_COMM = 600;
const COMMUNITIES = Array.from({ length: N_COMM }, (_, i) => `community_${String(i).padStart(3, '0')}`);
const pickCommunity = sampler(zipf(N_COMM, 1.0));
const INSTANCES = ['mastodon.example', 'social.example', 'fedi.example', 'town.example'];

/* ----------------------------------------------------------------- creators */
console.log(`[seed-scale] ${N_MEDIA} media, ${N_CREATORS} creators, seed ${SEED}, anchor ${iso(ANCHOR)} -> ${process.env.DB_PATH}`);
const t0 = Date.now();
const creatorRows = [];
for (let i = 0; i < N_CREATORS; i++) {
  const id = uuidOf('creator', i);
  const handle = `creator_${String(i).padStart(5, '0')}`;
  const r = rand();
  const status = r < 0.95 ? 'active' : r < 0.975 ? 'hidden' : 'blocked';
  const scope = chance(0.9) ? 'in' : chance(0.7) ? 'uncertain' : 'excluded';
  const links = [];
  const lr = rand();
  if (lr < 0.19) links.push({ platform: 'external', service: 'OnlyFans', label: `OnlyFans · ${handle}`, url: `https://onlyfans.com/${handle}`, handle, ...(chance(0.15) ? { free: true } : {}) });
  else if (lr < 0.24) links.push({ platform: 'external', service: 'Fansly', label: `Fansly · ${handle}`, url: `https://fansly.com/${handle}`, handle });
  else if (lr < 0.27) links.push({ platform: 'external', service: 'JustFor.Fans', label: `JFF · ${handle}`, url: `https://justfor.fans/${handle}`, handle });
  if (chance(0.3)) links.push({ platform: 'external', service: 'Throne', label: 'Wishlist', url: `https://throne.example/${handle}` });
  if (chance(0.4)) links.push({ platform: 'external', label: 'Link in bio', url: `https://linktr.example/${handle}` });
  const created = ANCHOR - Math.floor(rand() * 730) * DAY - ri(DAY);
  creatorRows.push({
    id, handle, display_name: chance(0.7) ? `Creator ${i}` : handle, bio: chance(0.6) ? `Synthetic profile ${i}. ${chance(0.2) ? 'Free trial available.' : ''}`.trim() : null,
    avatar_url: `https://cdn.example.invalid/avatars/${i}.jpg`, banner_url: chance(0.3) ? `https://cdn.example.invalid/banners/${i}.jpg` : null,
    links: JSON.stringify(links), scope, status, verified: chance(0.08) ? 1 : 0, origin: chance(0.03) ? 'admin' : chance(0.02) ? 'lookup' : 'ingest',
    created_at: iso(created), updated_at: iso(created),
  });
}
const insCreator = db.prepare(`INSERT INTO creators (id, handle, display_name, bio, avatar_url, banner_url, links, scope, status, verified, origin, created_at, updated_at)
  VALUES (@id, @handle, @display_name, @bio, @avatar_url, @banner_url, @links, @scope, @status, @verified, @origin, @created_at, @updated_at)`);
const insAlias = db.prepare("INSERT OR IGNORE INTO creator_aliases (creator_id, norm, alias, kind, platform, source) VALUES (?, ?, ?, ?, ?, 'account')");
const insFeed = db.prepare('INSERT OR IGNORE INTO feeds (id, platform, kind, target, label, creator_id, enabled, origin, interval_min, last_success_at, items_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 180, ?, ?)');
db.transaction(() => {
  creatorRows.forEach((c, i) => {
    insCreator.run(c);
    insAlias.run(c.id, c.handle.replace(/[^a-z0-9]/g, ''), c.handle, 'handle', null);
    if (c.display_name !== c.handle) insAlias.run(c.id, c.display_name.toLowerCase().replace(/[^a-z0-9]/g, ''), c.display_name, 'name', null);
    const nFeeds = 1 + (chance(0.4) ? 1 : 0) + (chance(0.15) ? 1 : 0);
    for (let k = 0; k < nFeeds; k++) {
      const p = PLATFORMS[pickPlatform()];
      insFeed.run(uuidOf('feed', i * 4 + k), p, 'user', `${c.handle}_${p}`, c.handle, c.id, chance(0.7) ? 1 : 0, 'discovered', iso(ANCHOR - ri(5) * DAY), 0);
    }
  });
  // subreddit-style community feeds that have no creator
  for (let k = 0; k < 80; k++) insFeed.run(uuidOf('cfeed', k), 'reddit', 'subreddit', COMMUNITIES[k], COMMUNITIES[k], null, 1, 'seed', iso(ANCHOR - ri(2) * DAY), 0);
})();
const feedByCreator = new Map(db.prepare('SELECT creator_id, id FROM feeds WHERE creator_id IS NOT NULL').all().map((r) => [r.creator_id, r.id]));
console.log(`[seed-scale] creators + feeds in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* ---------------------------------------------------------------- tags table */
const insTag = db.prepare('INSERT OR IGNORE INTO tags (name, category) VALUES (?, ?)');
db.transaction(() => {
  for (const t of [...PLATFORMS, ...TAGS]) insTag.run(t, 'general');
  for (const c of COMMUNITIES) insTag.run(c.replace(/_/g, '-'), 'general');
})();
const tagId = new Map(db.prepare('SELECT id, name FROM tags').all().map((t) => [t.name, t.id]));
const tagUse = new Map();

/* -------------------------------------------------------------------- media */
// Posting volume per creator is Zipf: a few prolific creators, a long tail with a handful of posts.
const pickCreator = sampler(zipf(N_CREATORS, 0.85));
// Creators' ranks are shuffled against their ids so the prolific ones are not simply the first rows.
const rankToCreator = Array.from({ length: N_CREATORS }, (_, i) => i);
for (let i = rankToCreator.length - 1; i > 0; i--) { const j = ri(i + 1); [rankToCreator[i], rankToCreator[j]] = [rankToCreator[j], rankToCreator[i]]; }

const insMedia = db.prepare(`INSERT INTO media (id, creator_id, feed_id, platform, source_id, source_key, post_key, position, source_url, community, author, title, description,
    media_type, media_url, preview_url, thumbnail_url, hls_url, has_audio, width, height, duration, mime_type, score, likes, views, hot, hash, nsfw_level, scope, publish_state,
    tags_text, posted_at, ingested_at, updated_at, phash, physique, thumb_url, tint)
  VALUES (@id, @creator_id, @feed_id, @platform, @source_id, @source_key, @post_key, @position, @source_url, @community, @author, @title, @description,
    @media_type, @media_url, @preview_url, @thumbnail_url, @hls_url, @has_audio, @width, @height, @duration, @mime_type, @score, @likes, @views, @hot, @hash, @nsfw_level, @scope, @publish_state,
    @tags_text, @posted_at, @ingested_at, @updated_at, @phash, @physique, @thumb_url, @tint)`);
const insMT = db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id, source) VALUES (?, ?, ?)');
const hotScore = (score, likes, views, postedMs, nowMs) => {
  const ageDays = Math.max(0, (nowMs - postedMs) / DAY);
  const pop = Math.log1p(Math.max(0, score || 0)) + 1.5 * Math.log1p((likes || 0) * 5 + (views || 0) * 0.2) + 1;
  return pop / Math.pow(ageDays + 1.5, 0.9);
};
const RATIOS = [[1080, 1350], [1080, 1080], [1080, 1920], [1920, 1080], [720, 1280], [1024, 768]];
const hex = (n) => { let o = ''; for (let i = 0; i < n; i++) o += '0123456789abcdef'[ri(16)]; return o; };

const mediaMeta = []; // [seq-ordered] id, state, scope for the embeddings pass
const BATCH = 5000;
let postN = 0; let curPost = null; let posLeft = 0;
let made = 0;
for (let from = 0; from < N_MEDIA; from += BATCH) {
  const to = Math.min(N_MEDIA, from + BATCH);
  db.transaction(() => {
    for (let i = from; i < to; i++) {
      // a post carries 1-4 pictures (same post_key, position 0..n)
      if (posLeft <= 0) {
        postN++; posLeft = chance(0.75) ? 1 : 2 + ri(3);
        const cr = chance(0.97) ? creatorRows[rankToCreator[pickCreator()]] : null;
        const platform = PLATFORMS[pickPlatform()];
        const posted = ANCHOR - Math.min(1100, -Math.log(1 - rand()) * 240) * DAY - ri(DAY);
        const community = platform === 'reddit' || platform === 'redgifs' ? COMMUNITIES[pickCommunity()] : platform === 'mastodon' ? INSTANCES[ri(INSTANCES.length)] : null;
        const tags = new Set([platform]);
        if (community) tags.add(community.replace(/_/g, '-'));
        if (chance(0.62)) tags.add('gay');
        if (chance(0.5)) tags.add('nsfw');
        const nT = 1 + ri(4);
        for (let k = 0; k < nT; k++) tags.add(TAGS[pickTag()]);
        const stateR = rand();
        const score = Math.floor(Math.exp(rand() * rand() * 11) - 1); // heavy tail, most small
        curPost = {
          id: postN, cr, platform, posted, community, tags: [...tags],
          state: stateR < 0.88 ? 'published' : stateR < 0.93 ? 'review' : stateR < 0.98 ? 'hidden' : 'removed',
          scope: chance(0.93) ? 'in' : chance(0.7) ? 'uncertain' : 'excluded',
          score, ratio: RATIOS[ri(RATIOS.length)], title: `Post ${postN}`, level: chance(0.85) ? 'explicit' : 'suggestive',
        };
      }
      const p = curPost; const position = p.n || 0; p.n = position + 1; posLeft--;
      const isVideo = chance(0.38);
      const id = uuidOf('media', i);
      const likes = Math.floor(p.score * rand() * 0.3); const views = Math.floor(p.score * (2 + rand() * 20));
      const tags = [...p.tags, isVideo ? 'video' : 'photo'];
      const postedAt = p.posted + position * 1000;
      const tagsText = tags.join(' ');
      const cr = p.cr;
      insMedia.run({
        id, creator_id: cr ? cr.id : null, feed_id: cr ? feedByCreator.get(cr.id) || null : null, platform: p.platform,
        source_id: `${p.platform}${p.id}`, source_key: `${p.platform}:${p.id}:${position}`, post_key: `${p.platform}:${p.id}`, position,
        source_url: `https://${p.platform}.example.invalid/post/${p.id}`, community: p.community, author: cr ? cr.handle : null,
        title: p.title, description: chance(0.3) ? `Synthetic description for post ${p.id}` : null,
        media_type: isVideo ? 'video' : 'image', media_url: `https://cdn.example.invalid/m/${i}.${isVideo ? 'mp4' : 'jpg'}`,
        preview_url: chance(0.8) ? `https://cdn.example.invalid/p/${i}.jpg` : null, thumbnail_url: chance(0.5) ? `https://cdn.example.invalid/t/${i}.jpg` : null,
        hls_url: isVideo && chance(0.3) ? `https://cdn.example.invalid/h/${i}.m3u8` : null, has_audio: isVideo && chance(0.5) ? 1 : 0,
        width: p.ratio[0], height: p.ratio[1], duration: isVideo ? Math.round((3 + rand() * 120) * 10) / 10 : null, mime_type: isVideo ? 'video/mp4' : 'image/jpeg',
        score: p.score, likes, views, hot: hotScore(p.score, likes, views, postedAt, ANCHOR), hash: crypto.createHash('md5').update(`${SEED}:h:${i}`).digest('hex'),
        nsfw_level: p.level, scope: p.scope, publish_state: p.state, tags_text: tagsText, posted_at: iso(postedAt), ingested_at: iso(postedAt + ri(3600000)), updated_at: iso(postedAt),
        // physique stays at or under 30 (or NULL): a score over the body filter's line would make the first boot hide thousands of rows, a one-off a settled library has long since done
        phash: chance(0.6) ? hex(32) : null, physique: chance(0.15) ? ri(31) : null,
        thumb_url: chance(0.55) ? `https://cdn.example.invalid/s/${i}.webp` : null, tint: chance(0.55) ? `#${hex(6)}` : null,
      });
      for (const t of tags) { const tid = tagId.get(t); if (tid) { insMT.run(id, tid, 'ingest'); tagUse.set(tid, (tagUse.get(tid) || 0) + 1); } }
      mediaMeta.push({ id, state: p.state, scope: p.scope, creator: cr ? cr.id : null });
      made++;
    }
  })();
  if ((from / BATCH) % 10 === 0) console.log(`[seed-scale] media ${to}/${N_MEDIA} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

/* ------------------------------------------------------------- aggregates */
db.transaction(() => {
  const up = db.prepare('UPDATE tags SET usage_count = ? WHERE id = ?');
  for (const [tid, n] of tagUse) up.run(n, tid);
  db.exec(`UPDATE creators SET
      media_count = (SELECT COUNT(*) FROM media WHERE creator_id = creators.id AND publish_state = 'published'),
      video_count = (SELECT COUNT(*) FROM media WHERE creator_id = creators.id AND publish_state = 'published' AND media_type = 'video'),
      total_score = COALESCE((SELECT SUM(score) FROM media WHERE creator_id = creators.id AND publish_state = 'published'), 0),
      last_media_at = (SELECT MAX(posted_at) FROM media WHERE creator_id = creators.id AND publish_state = 'published')`);
  db.exec(`UPDATE feeds SET items_total = (SELECT COUNT(*) FROM media WHERE feed_id = feeds.id)`);
  db.prepare('INSERT OR IGNORE INTO media_hosts (host) VALUES (?)').run('cdn.example.invalid');
})();
console.log(`[seed-scale] aggregates in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

/* --------------------------------------------------------------- embeddings */
// Same table as src/engine/visual.js (created lazily there). The backfill walks newest-first, so the embedded rows are
// the newest ~40% of published items, plus some 'fail' rows (pictures that could not be fetched).
db.exec(`CREATE TABLE IF NOT EXISTS media_embeddings (
    media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    vec BLOB,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
const insEmb = db.prepare('INSERT OR IGNORE INTO media_embeddings (media_id, model, vec) VALUES (?, ?, ?)');
const bySeq = db.prepare("SELECT id FROM media WHERE publish_state = 'published' AND scope != 'excluded' ORDER BY seq DESC").all();
const embN = Math.floor(bySeq.length * 0.4);
db.transaction(() => {
  const buf = Buffer.alloc(emb.DIM + 4);
  bySeq.forEach((r, k) => {
    if (k < embN) {
      buf.writeFloatLE(0.01 + rand() * 0.02, 0);
      for (let j = 0; j < emb.DIM; j++) buf.writeInt8(ri(255) - 127, 4 + j);
      insEmb.run(r.id, emb.MODEL_ID, Buffer.from(buf));
    } else if (chance(0.03)) insEmb.run(r.id, 'fail', null);
  });
})();
console.log(`[seed-scale] embeddings: ${embN} vectors in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

/* ----------------------------------------------------------------- settings */
// A real library has been through the one-off boot jobs; set their markers so a measurement is not about those.
const setSet = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
const registry = require('../src/sources');
for (const [k, v] of [['seed_version', String(registry.SEED_VERSION)], ['safety_sweep_version', '3'], ['image_sweep_version', '1'], ['physique_text_sweep_version', '2'], ['physique_defaults_version', '2']]) setSet.run(k, v);

// Planner statistics, as a long-lived database has (src/db/index.js runs this at every open; here the tables were empty then).
db.exec('PRAGMA analysis_limit = 400; PRAGMA optimize = 0x10002;');
db.pragma('wal_checkpoint(TRUNCATE)');
const c = (sql) => db.prepare(sql).get().n;
console.log(JSON.stringify({
  file: process.env.DB_PATH, bytes: fs.statSync(process.env.DB_PATH).size, seconds: Math.round((Date.now() - t0) / 1000),
  media: c('SELECT COUNT(*) AS n FROM media'), published: c("SELECT COUNT(*) AS n FROM media WHERE publish_state = 'published'"), creators: c('SELECT COUNT(*) AS n FROM creators'),
  activeCreators: c("SELECT COUNT(*) AS n FROM creators WHERE status = 'active' AND media_count > 0"), onlyfansCreators: c("SELECT COUNT(*) AS n FROM creators WHERE links GLOB '*onlyfans.com/[A-Za-z0-9]*'"),
  mediaTags: c('SELECT COUNT(*) AS n FROM media_tags'), tags: c('SELECT COUNT(*) AS n FROM tags'), embeddings: c('SELECT COUNT(*) AS n FROM media_embeddings'), feeds: c('SELECT COUNT(*) AS n FROM feeds'),
}, null, 2));
