'use strict';
/**
 * Database schema, expressed as ordered migrations tracked by
 * `PRAGMA user_version`.
 *
 *   v1  Legacy -> v4 rebuild (or a fresh install). Creates the final schema
 *       and, when a PRISM v3 database is found, copies its media / creators /
 *       tags across (re-hashing media so new ingests dedupe against old rows).
 *
 * Add future changes as v2, v3, ... — never edit a shipped migration.
 */
const crypto = require('crypto');
const { canonicalUrl } = require('../lib/mediaurl');

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function createCoreTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS creators (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      display_name TEXT,
      bio TEXT,
      avatar_url TEXT,
      banner_url TEXT,
      links TEXT NOT NULL DEFAULT '[]',
      scope TEXT NOT NULL DEFAULT 'in' CHECK(scope IN ('in','uncertain','excluded')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','hidden','blocked')),
      verified INTEGER NOT NULL DEFAULT 0,
      media_count INTEGER NOT NULL DEFAULT 0,
      video_count INTEGER NOT NULL DEFAULT 0,
      total_score INTEGER NOT NULL DEFAULT 0,
      last_media_at TEXT,
      origin TEXT NOT NULL DEFAULT 'ingest',
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      updated_at TEXT NOT NULL DEFAULT (${NOW})
    );
    CREATE INDEX IF NOT EXISTS ix_creators_handle ON creators(handle COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS ix_creators_count ON creators(media_count DESC);
    CREATE INDEX IF NOT EXISTS ix_creators_recent ON creators(last_media_at DESC);

    CREATE TABLE IF NOT EXISTS feeds (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      label TEXT,
      creator_id TEXT REFERENCES creators(id) ON DELETE SET NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      trusted INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL DEFAULT 'admin',
      interval_min INTEGER NOT NULL DEFAULT 180,
      priority INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT,
      last_run_at TEXT,
      last_success_at TEXT,
      last_status TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      cursor TEXT,
      items_total INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      updated_at TEXT NOT NULL DEFAULT (${NOW})
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ix_feeds_unique ON feeds(platform, kind, target COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS ix_feeds_due ON feeds(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS ix_feeds_creator ON feeds(creator_id);

    CREATE TABLE IF NOT EXISTS media (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      creator_id TEXT REFERENCES creators(id) ON DELETE SET NULL,
      feed_id TEXT REFERENCES feeds(id) ON DELETE SET NULL,
      platform TEXT NOT NULL,
      source_id TEXT,
      source_key TEXT UNIQUE,
      post_key TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      source_url TEXT,
      community TEXT,
      author TEXT,
      title TEXT,
      description TEXT,
      ocr_text TEXT,
      ocr_at TEXT,
      face_at TEXT,
      media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
      media_url TEXT NOT NULL,
      preview_url TEXT,
      thumbnail_url TEXT,
      hls_url TEXT,
      has_audio INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      duration REAL,
      mime_type TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      hot REAL NOT NULL DEFAULT 0,
      hash TEXT NOT NULL UNIQUE,
      nsfw_level TEXT NOT NULL DEFAULT 'explicit',
      scope TEXT NOT NULL DEFAULT 'in' CHECK(scope IN ('in','uncertain','excluded')),
      publish_state TEXT NOT NULL DEFAULT 'published' CHECK(publish_state IN ('published','review','hidden','removed')),
      review_reason TEXT,
      tags_text TEXT NOT NULL DEFAULT '',
      posted_at TEXT NOT NULL DEFAULT (${NOW}),
      ingested_at TEXT NOT NULL DEFAULT (${NOW}),
      updated_at TEXT NOT NULL DEFAULT (${NOW})
    );
    CREATE INDEX IF NOT EXISTS ix_media_pub_posted ON media(posted_at DESC, seq DESC) WHERE publish_state = 'published';
    CREATE INDEX IF NOT EXISTS ix_media_pub_score ON media(score DESC, seq DESC) WHERE publish_state = 'published';
    CREATE INDEX IF NOT EXISTS ix_media_pub_hot ON media(hot DESC, seq DESC) WHERE publish_state = 'published';
    CREATE INDEX IF NOT EXISTS ix_media_pub_type ON media(media_type, posted_at DESC) WHERE publish_state = 'published';
    CREATE INDEX IF NOT EXISTS ix_media_creator ON media(creator_id, posted_at DESC);
    CREATE INDEX IF NOT EXISTS ix_media_platform ON media(platform, publish_state);
    CREATE INDEX IF NOT EXISTS ix_media_community ON media(community, publish_state);
    CREATE INDEX IF NOT EXISTS ix_media_state ON media(publish_state, ingested_at DESC);
    CREATE INDEX IF NOT EXISTS ix_media_post ON media(post_key);
    CREATE INDEX IF NOT EXISTS ix_media_feed ON media(feed_id);

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT DEFAULT 'general',
      usage_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS media_tags (
      media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'ingest',
      PRIMARY KEY (media_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS ix_media_tags_tag ON media_tags(tag_id, media_id);

    CREATE TABLE IF NOT EXISTS moderation_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      actor TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL DEFAULT (${NOW})
    );
    CREATE INDEX IF NOT EXISTS ix_modact_target ON moderation_actions(target_id);

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      media_id TEXT,
      creator_id TEXT,
      kind TEXT NOT NULL,
      reason TEXT,
      contact TEXT,
      reporter_hash TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
      resolution TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      resolved_at TEXT,
      resolved_by TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_reports_status ON reports(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS blocklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('source_key','hash','creator','post')),
      value TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      UNIQUE(type, value)
    );

    CREATE TABLE IF NOT EXISTS feed_runs (
      id TEXT PRIMARY KEY,
      feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL DEFAULT 'schedule',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      fetched INTEGER NOT NULL DEFAULT 0,
      added INTEGER NOT NULL DEFAULT 0,
      dupes INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      review INTEGER NOT NULL DEFAULT 0,
      via TEXT,
      error TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_runs_feed ON feed_runs(feed_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS ix_runs_started ON feed_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (${NOW})
    );
  `);
}

function createSearch(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(
      title, author, community, tags_text, description, ocr_text,
      content='media', content_rowid='seq', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS media_fts_ai AFTER INSERT ON media BEGIN
      INSERT INTO media_fts(rowid, title, author, community, tags_text, description, ocr_text)
      VALUES (new.seq, new.title, new.author, new.community, new.tags_text, new.description, new.ocr_text);
    END;
    CREATE TRIGGER IF NOT EXISTS media_fts_ad AFTER DELETE ON media BEGIN
      INSERT INTO media_fts(media_fts, rowid, title, author, community, tags_text, description, ocr_text)
      VALUES ('delete', old.seq, old.title, old.author, old.community, old.tags_text, old.description, old.ocr_text);
    END;
    CREATE TRIGGER IF NOT EXISTS media_fts_au AFTER UPDATE OF title, author, community, tags_text, description, ocr_text ON media BEGIN
      INSERT INTO media_fts(media_fts, rowid, title, author, community, tags_text, description, ocr_text)
      VALUES ('delete', old.seq, old.title, old.author, old.community, old.tags_text, old.description, old.ocr_text);
      INSERT INTO media_fts(rowid, title, author, community, tags_text, description, ocr_text)
      VALUES (new.seq, new.title, new.author, new.community, new.tags_text, new.description, new.ocr_text);
    END;
  `);
}

const hasTable = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);

const isoFromLegacy = (s) => {
  if (!s) return new Date().toISOString();
  const str = String(s);
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(str)) return new Date(str).toISOString();
  const d = new Date(str.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};
const scopeFromLegacy = (s) => (s === 'excluded_straight' ? 'excluded' : s === 'uncertain' ? 'uncertain' : 'in');

/** v1: fresh install or rebuild from the PRISM v3 schema. */
function v1(db) {
  const legacy = hasTable(db, 'media') && db.prepare("PRAGMA table_info('media')").all().some((c) => c.name === 'subreddit');

  if (legacy) {
    for (const t of ['media_tags', 'media', 'creator_sources', 'creators']) {
      if (hasTable(db, t)) db.exec(`ALTER TABLE ${t} RENAME TO ${t}_legacy`);
    }
    // Legacy indexes keep their names after a rename; drop them so ours can be created.
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all()) {
      db.exec(`DROP INDEX IF EXISTS ${row.name}`);
    }
  }

  createCoreTables(db);
  createSearch(db);

  if (!legacy) return;

  const insCreator = db.prepare(`
    INSERT OR IGNORE INTO creators (id, handle, display_name, bio, avatar_url, scope, verified, media_count, total_score, origin, created_at, updated_at)
    VALUES (@id, @handle, @display_name, @bio, @avatar_url, @scope, @verified, @media_count, @total_score, 'ingest', @created_at, @updated_at)`);
  for (const c of db.prepare('SELECT * FROM creators_legacy').all()) {
    insCreator.run({
      id: c.id, handle: c.primary_handle, display_name: c.display_name, bio: c.bio, avatar_url: c.avatar_url,
      scope: scopeFromLegacy(c.orientation_scope), verified: c.verified ? 1 : 0,
      media_count: c.media_count || 0, total_score: c.total_score || 0,
      created_at: isoFromLegacy(c.created_at), updated_at: isoFromLegacy(c.updated_at),
    });
  }

  if (hasTable(db, 'creator_sources_legacy')) {
    const insFeed = db.prepare(`
      INSERT OR IGNORE INTO feeds (id, platform, kind, target, label, creator_id, enabled, trusted, origin, interval_min, last_success_at)
      VALUES (@id, @platform, 'user', @target, @label, @creator_id, 0, 1, 'ingest', 180, @last_success_at)`);
    for (const s of db.prepare('SELECT * FROM creator_sources_legacy WHERE handle IS NOT NULL').all()) {
      insFeed.run({
        id: s.id, platform: s.source_platform || 'reddit', target: s.handle, label: s.handle,
        creator_id: s.creator_id, last_success_at: s.last_synced_at ? isoFromLegacy(s.last_synced_at) : null,
      });
    }
  }

  const tagsByMedia = new Map();
  if (hasTable(db, 'media_tags_legacy')) {
    for (const r of db.prepare('SELECT mt.media_id, t.name FROM media_tags_legacy mt JOIN tags t ON t.id = mt.tag_id').all()) {
      if (!tagsByMedia.has(r.media_id)) tagsByMedia.set(r.media_id, []);
      tagsByMedia.get(r.media_id).push(r.name);
    }
  }

  const insMedia = db.prepare(`
    INSERT OR IGNORE INTO media (id, creator_id, platform, source_id, source_key, post_key, position, source_url, community, author, title, description,
      media_type, media_url, preview_url, thumbnail_url, width, height, duration, mime_type, score, hash, nsfw_level, scope, publish_state, tags_text,
      posted_at, ingested_at, updated_at)
    VALUES (@id, @creator_id, @platform, @source_id, @source_key, @post_key, 0, @source_url, @community, @author, @title, @description,
      @media_type, @media_url, @preview_url, @thumbnail_url, @width, @height, @duration, @mime_type, @score, @hash, @nsfw_level, @scope, @publish_state, @tags_text,
      @posted_at, @ingested_at, @updated_at)`);
  const keyTaken = db.prepare('SELECT 1 FROM media WHERE source_key = ?');
  for (const m of db.prepare('SELECT * FROM media_legacy').all()) {
    const platform = m.source_platform || 'reddit';
    let sourceKey = m.source_id ? `${platform}:${m.source_id}:0` : null;
    if (sourceKey && keyTaken.get(sourceKey)) sourceKey = null;
    insMedia.run({
      id: m.id, creator_id: m.creator_id, platform, source_id: m.source_id, source_key: sourceKey,
      post_key: m.source_id ? `${platform}:${m.source_id}` : null,
      source_url: m.source_url, community: m.subreddit, author: m.author, title: m.title, description: m.description,
      media_type: m.media_type, media_url: m.media_url, preview_url: m.preview_url, thumbnail_url: m.thumbnail_url,
      width: m.width, height: m.height, duration: m.duration_seconds, mime_type: m.mime_type, score: m.score || 0,
      hash: crypto.createHash('md5').update(canonicalUrl(m.media_url)).digest('hex'),
      nsfw_level: m.nsfw_level || 'explicit', scope: scopeFromLegacy(m.orientation_scope),
      publish_state: ['published', 'hidden', 'removed', 'review'].includes(m.publish_state) ? m.publish_state : 'hidden',
      tags_text: (tagsByMedia.get(m.id) || []).join(' '),
      posted_at: isoFromLegacy(m.created_at), ingested_at: isoFromLegacy(m.ingested_at), updated_at: isoFromLegacy(m.updated_at),
    });
  }

  if (hasTable(db, 'media_tags_legacy')) {
    db.exec(`INSERT OR IGNORE INTO media_tags (media_id, tag_id, source)
             SELECT mt.media_id, mt.tag_id, COALESCE(NULLIF(mt.source,'manual'),'ingest')
             FROM media_tags_legacy mt WHERE mt.media_id IN (SELECT id FROM media)`);
  }
  if (hasTable(db, 'moderation_actions')) {
    // legacy CHECK(target_type IN ('media','creator')) table is compatible; leave rows in place.
  }

  db.exec('DROP TABLE IF EXISTS media_tags_legacy; DROP TABLE IF EXISTS media_legacy; DROP TABLE IF EXISTS creator_sources_legacy; DROP TABLE IF EXISTS creators_legacy;');
  db.exec("INSERT INTO media_fts(media_fts) VALUES ('rebuild')");
}

/** v2: hosts that ingestion has accepted media from (lets the proxy allow them without scanning media). */
function v2(db) {
  db.exec('CREATE TABLE IF NOT EXISTS media_hosts (host TEXT PRIMARY KEY, first_seen TEXT NOT NULL DEFAULT (' + NOW + '))');
  const add = db.prepare('INSERT OR IGNORE INTO media_hosts (host) VALUES (?)');
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };
  const seen = new Set();
  const scan = (sql) => { for (const r of db.prepare(sql).all()) for (const v of Object.values(r)) { const h = v && hostOf(v); if (h && !seen.has(h)) { seen.add(h); add.run(h); } } };
  // One representative row per host is enough; DISTINCT on a coarse prefix keeps this fast on large libraries.
  scan("SELECT DISTINCT substr(media_url, 1, instr(substr(media_url, 9), '/') + 8) AS u FROM media");
  scan("SELECT DISTINCT substr(preview_url, 1, instr(substr(preview_url, 9), '/') + 8) AS u FROM media WHERE preview_url IS NOT NULL");
  scan("SELECT DISTINCT substr(avatar_url, 1, instr(substr(avatar_url, 9), '/') + 8) AS u FROM creators WHERE avatar_url IS NOT NULL");
}

/**
 * v3 (PRISM 4.3): the discovery queue and its bookkeeping, plus indexes for the
 * newer read paths (ingest-time filters, rising creators, recommendations).
 */
function v3(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL COLLATE NOCASE,
      label TEXT,
      url TEXT,
      display_name TEXT,
      avatar_url TEXT,
      bio TEXT,
      score REAL NOT NULL DEFAULT 0,
      signals TEXT NOT NULL DEFAULT '{}',
      scope TEXT NOT NULL DEFAULT 'uncertain',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','followed','rejected','linked')),
      reason TEXT,
      creator_id TEXT REFERENCES creators(id) ON DELETE SET NULL,
      first_seen TEXT NOT NULL DEFAULT (${NOW}),
      last_seen TEXT NOT NULL DEFAULT (${NOW}),
      decided_at TEXT,
      UNIQUE (platform, kind, target)
    );
    CREATE INDEX IF NOT EXISTS ix_candidates_queue ON candidates(status, score DESC);
    CREATE TABLE IF NOT EXISTS discovery_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (${NOW})
    );
    CREATE INDEX IF NOT EXISTS ix_media_ingested ON media(ingested_at DESC) WHERE publish_state = 'published';
    CREATE INDEX IF NOT EXISTS ix_media_creator_pub ON media(creator_id, publish_state, posted_at DESC);
  `);
}

/**
 * v4 (PRISM 4.7): read paths measured on a 60k-item library.
 * - community filters compare case-insensitively, which the BINARY community index cannot serve;
 * - "not from a hidden/blocked creator" runs on every public query and scanned all creators;
 * - creator cards re-read every post of a creator for 3 previews and the platform list.
 */
function v4(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_media_pub_community ON media(community COLLATE NOCASE, posted_at DESC) WHERE publish_state = 'published';
    CREATE INDEX IF NOT EXISTS ix_creators_status ON creators(status);
    -- creator cards: top previews and the set of platforms, without sorting/scanning all of a creator's posts
    CREATE INDEX IF NOT EXISTS ix_media_creator_top ON media(creator_id, score DESC, seq DESC) WHERE publish_state = 'published';
    CREATE INDEX IF NOT EXISTS ix_media_creator_platform ON media(creator_id, platform) WHERE publish_state = 'published';
  `);
}

/**
 * v5 (PRISM 4.8): link health. Viewers' browsers report media that fails to load; the server
 * verifies at the source and hides what is really gone. One row per media item ever checked.
 */
function v5(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_health (
      media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
      reports INTEGER NOT NULL DEFAULT 0,
      last_report TEXT,
      checked_at TEXT,
      verdict TEXT,
      http_status INTEGER,
      gone_streak INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ix_media_health_checked ON media_health(checked_at);
  `);
}

/**
 * v6 (PRISM 4.11): perceptual duplicates. `phash` is the picture's perceptual hash (32 hex chars, lib/phash);
 * `media_alt_sources` remembers every other place the SAME picture was posted (so duplicates collapse into one item that
 * says "also on Reddit · X"); `phash_blocklist` makes a removed picture stay removed even when it is re-uploaded.
 */
function v6(db) {
  const cols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  if (!cols.includes('phash')) db.exec('ALTER TABLE media ADD COLUMN phash TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_alt_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      source_url TEXT NOT NULL,
      author TEXT,
      community TEXT,
      posted_at TEXT,
      added_at TEXT NOT NULL DEFAULT (${NOW}),
      UNIQUE (media_id, source_url)
    );
    CREATE INDEX IF NOT EXISTS ix_alt_sources_media ON media_alt_sources(media_id);
    CREATE TABLE IF NOT EXISTS phash_blocklist (
      phash TEXT PRIMARY KEY,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW})
    );
  `);
}

/**
 * v7 (PRISM 4.14): physique. `physique` is the picture's heaviness score (0 = lean / athletic .. 100 = very large; NULL =
 * not measured: no torso in view, or not checked yet). Items at or above the admin threshold are hidden, not deleted, so
 * moving the threshold re-applies to the whole library in both directions.
 */
function v7(db) {
  const cols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  if (!cols.includes('physique')) db.exec('ALTER TABLE media ADD COLUMN physique INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS ix_media_physique ON media(creator_id, physique) WHERE physique IS NOT NULL');
}

/**
 * v8 (PRISM 4.14): OnlyFans leads. Every OnlyFans handle PRISM sees named in a bio, a post or a web
 * search result, whether or not we follow that person yet. A lead is
 * worked by finding the same person's free public accounts elsewhere (RedGIFs, Bluesky, X, Reddit...).
 *   status   pending (not looked for yet) | searching (looked, nothing yet) | found (accounts queued in
 *            discovery) | claimed (a followed creator links to this page) | rejected (safety / scope)
 *   sources  JSON array of creator ids whose posts named it (shout-outs, promo channels)
 */
function v8(db) {
 const cols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
 if (!cols.includes('physique')) db.exec('ALTER TABLE media ADD COLUMN physique INTEGER');
 db.exec('CREATE INDEX IF NOT EXISTS ix_media_physique ON media(creator_id, physique) WHERE physique IS NOT NULL');
 db.exec(`
   CREATE TABLE IF NOT EXISTS onlyfans_leads (
     handle TEXT PRIMARY KEY COLLATE NOCASE,
      creator_id TEXT REFERENCES creators(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','searching','found','claimed','rejected')),
      mentions INTEGER NOT NULL DEFAULT 0,
      sources TEXT NOT NULL DEFAULT '[]',
      origin TEXT,
      display_name TEXT,
      bio TEXT,
      free INTEGER NOT NULL DEFAULT 0,
      accounts TEXT NOT NULL DEFAULT '[]',
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL DEFAULT (${NOW}),
      last_seen TEXT NOT NULL DEFAULT (${NOW}),
      checked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_of_leads_queue ON onlyfans_leads(status, mentions DESC);
    CREATE INDEX IF NOT EXISTS ix_of_leads_creator ON onlyfans_leads(creator_id);
  `);
}

/**
 * v9 (PRISM 5.0): creator identity. One person, many accounts and names.
 *   creator_aliases  every name / handle a creator goes by: his own handles on each platform, display names, and
 *                    "backup / new / old account" handles he names in his own bio. `norm` is the comparison key
 *                    (lower case, letters and digits only), so "Jake.Fit" and "jakefit" meet.
 *   identity_links   evidence that two creator rows are the same man, collected only from what the creators publish
 *                    about themselves (bio links, link-in-bio pages, a shared OnlyFans page) or set by the admin.
 *                    pending = waiting for the admin, merged = folded together, rejected = different people (never
 *                    suggested again). `a_id` < `b_id` so a pair is stored once. No foreign keys: a merge deletes one of
 *                    the two creators, and the decision (with the handles at the time, a_label / b_label, and the
 *                    survivor, kept_id) is kept as history.
 */
function v9(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS creator_aliases (
      creator_id TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      norm TEXT NOT NULL,
      alias TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'handle' CHECK (kind IN ('handle','name')),
      platform TEXT,
      source TEXT NOT NULL DEFAULT 'account' CHECK (source IN ('account','profile','bio','admin','lookup','merge')),
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      PRIMARY KEY (creator_id, norm)
    );
    CREATE INDEX IF NOT EXISTS ix_creator_aliases_norm ON creator_aliases(norm);
    CREATE TABLE IF NOT EXISTS identity_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      a_id TEXT NOT NULL,
      b_id TEXT NOT NULL,
      a_label TEXT,
      b_label TEXT,
      kept_id TEXT,
      evidence TEXT NOT NULL DEFAULT '[]',
      strength INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','rejected')),
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      updated_at TEXT NOT NULL DEFAULT (${NOW}),
      decided_by TEXT,
      UNIQUE (a_id, b_id),
      CHECK (a_id < b_id)
    );
    CREATE INDEX IF NOT EXISTS ix_identity_links_queue ON identity_links(status, strength DESC);
    CREATE INDEX IF NOT EXISTS ix_identity_links_b ON identity_links(b_id);
  `);
  // Every account PRISM already follows, and every display name, is an alias of its creator.
  const { normAlias } = require('../lib/alias');
  const ins = db.prepare('INSERT OR IGNORE INTO creator_aliases (creator_id, norm, alias, kind, platform, source) VALUES (?, ?, ?, ?, ?, ?)');
  for (const f of db.prepare("SELECT creator_id, platform, target FROM feeds WHERE creator_id IS NOT NULL AND kind = 'user'").all()) {
    const n = normAlias(f.target); if (n) ins.run(f.creator_id, n, f.target, 'handle', f.platform, 'account');
  }
  for (const c of db.prepare('SELECT id, handle, display_name FROM creators').all()) {
    const h = normAlias(c.handle); if (h) ins.run(c.id, h, c.handle, 'handle', null, 'account');
    const d = normAlias(c.display_name); if (d) ins.run(c.id, d, c.display_name, 'name', null, 'profile');
  }
}

/**
 * v10 (PRISM v5 sources): small thumbnails and a tint per picture. `thumb_url` is a ~360px WebP of the picture (or a
 * video's poster) kept in the object store, so grids load small files instead of full-size originals; `tint` is the
 * picture's dominant colour ('#rrggbb') shown while it loads. Filled in the background by engine/thumbs.js, newest first;
 * an empty `tint` means "tried, no picture to read".
 */
function v10(db) {
  const cols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  if (!cols.includes('thumb_url')) db.exec('ALTER TABLE media ADD COLUMN thumb_url TEXT');
  if (!cols.includes('tint')) db.exec('ALTER TABLE media ADD COLUMN tint TEXT');
  db.exec("CREATE INDEX IF NOT EXISTS ix_media_tint_todo ON media(seq DESC) WHERE tint IS NULL AND publish_state = 'published'");
}

/**
 * v11 (PRISM v5 iteration): paid leads go beyond OnlyFans. The leads table gains a `service`
 * ('OnlyFans', 'Fansly', 'JustFor.Fans') so a Fansly or JFF page named in posts, bios and web
 * search results is traced to the same man's free public accounts exactly like an OnlyFans page.
 * The paid hosts are worked like any other public page; the trace looks for the person's free public
 * accounts. Rebuilt with a composite key because one handle can exist on several services at once.
 */
function v11(db) {
  const cols = db.prepare('PRAGMA table_info(onlyfans_leads)').all().map((c) => c.name);
  if (cols.includes('service')) return;
  db.exec(`
  CREATE TABLE paid_leads_new (
    service TEXT NOT NULL DEFAULT 'OnlyFans',
    handle TEXT NOT NULL COLLATE NOCASE,
    creator_id TEXT REFERENCES creators(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','searching','found','claimed','rejected')),
    mentions INTEGER NOT NULL DEFAULT 0,
    sources TEXT NOT NULL DEFAULT '[]',
    origin TEXT,
    display_name TEXT,
    bio TEXT,
    free INTEGER NOT NULL DEFAULT 0,
    accounts TEXT NOT NULL DEFAULT '[]',
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL DEFAULT (${NOW}),
    last_seen TEXT NOT NULL DEFAULT (${NOW}),
    checked_at TEXT,
    PRIMARY KEY (service, handle)
  );
  INSERT INTO paid_leads_new (service, handle, creator_id, status, mentions, sources, origin, display_name, bio, free, accounts, reason, attempts, first_seen, last_seen, checked_at)
    SELECT 'OnlyFans', handle, creator_id, status, mentions, sources, origin, display_name, bio, free, accounts, reason, attempts, first_seen, last_seen, checked_at FROM onlyfans_leads;
  DROP TABLE onlyfans_leads;
  ALTER TABLE paid_leads_new RENAME TO onlyfans_leads;
  CREATE INDEX IF NOT EXISTS ix_of_leads_queue ON onlyfans_leads(status, mentions DESC);
  CREATE INDEX IF NOT EXISTS ix_of_leads_creator ON onlyfans_leads(creator_id);
  CREATE INDEX IF NOT EXISTS ix_of_leads_service ON onlyfans_leads(service, status);
  `);
}

/**
 * v12: Creator takedowns & opt-out honoring. Stores creator, handle, URL and domain
 * takedown entries so content that a creator has requested be removed or opted out of
 * indexing is purged retroactively and blocked prospectively across all pipelines.
 */
function v12(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS takedowns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK(kind IN ('creator','handle','url','domain')),
      value TEXT NOT NULL COLLATE NOCASE,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      UNIQUE(kind, value)
    );
    CREATE INDEX IF NOT EXISTS ix_takedowns_kind_val ON takedowns(kind, value COLLATE NOCASE);
  `);
}

/** v13: resume position per firehose/stream source, so restarts pick up where they left off. */
function v13(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS firehose_cursor (
      source TEXT PRIMARY KEY,
      cursor TEXT,
      updated_at INTEGER
    );
  `);
}

/** v14: leads discovered by firehose/stream sources, deduped on (platform, external_id). */
function v14(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_leads (
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      handle TEXT,
      payload TEXT,
      first_seen_at INTEGER,
      last_seen_at INTEGER,
      PRIMARY KEY (platform, external_id)
    );
  `);
}

/**
 * v15: what PRISM has learned about HOW to read each host (engine/hoststrategy.js): whether a plain download is enough,
 * whether a browser render ever found more, and when to leave a host alone (empty renders back off, a bot-challenge rests it).
 */
function v15(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS host_strategy (
      host TEXT PRIMARY KEY,
      plain_runs INTEGER NOT NULL DEFAULT 0,
      plain_media INTEGER NOT NULL DEFAULT 0,
      render_runs INTEGER NOT NULL DEFAULT 0,
      render_media INTEGER NOT NULL DEFAULT 0,
      render_wins INTEGER NOT NULL DEFAULT 0,
      empty_streak INTEGER NOT NULL DEFAULT 0,
      challenges INTEGER NOT NULL DEFAULT 0,
      render_after TEXT,
      challenged_until TEXT,
      last_render_at TEXT,
      unlock_runs INTEGER NOT NULL DEFAULT 0,
      unlock_wins INTEGER NOT NULL DEFAULT 0,
      unlock_empty_streak INTEGER NOT NULL DEFAULT 0,
      unlock_after TEXT,
      updated_at TEXT NOT NULL DEFAULT (${NOW})
    );
  `);
}

/**
 * v16: every name attribution says where it came from. `signal` is the kind of self-declared evidence
 * ('own-account', 'own-profile', 'bio-line', 'self-declared-name', 'merge', 'admin', 'lookup') and `evidence_url` the
 * public page that shows it (his own profile or link-in-bio page). Nothing here is inferred from anyone else's posts.
 */
function v16(db) {
  const cols = db.prepare('PRAGMA table_info(creator_aliases)').all().map((c) => c.name);
  if (!cols.includes('signal')) db.exec('ALTER TABLE creator_aliases ADD COLUMN signal TEXT');
  if (!cols.includes('evidence_url')) db.exec('ALTER TABLE creator_aliases ADD COLUMN evidence_url TEXT');
}

/**
 * v17: provenance for Telegram content, so the "no AI on Telegram content" guard survives a restart. `telegram_text` keeps every
 * piece of text read from Telegram (normalised), `creators.bio_source` says which platform a stored bio came from.
 */
function v17(db) {
  db.exec('CREATE TABLE IF NOT EXISTS telegram_text (norm TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (' + NOW + '))');
  const cols = db.prepare('PRAGMA table_info(creators)').all().map((c) => c.name);
  if (!cols.includes('bio_source')) db.exec('ALTER TABLE creators ADD COLUMN bio_source TEXT');
}

/**
 * v18 (Phase 0): no look-alike attribution. Until now image match could register a web page as a creator's feed because a
 * picture on it LOOKED like his (visual-embedding similarity; the audit log says "look-alike (NN%) -> <page>"). That path is
 * gone, and what it produced is retracted here: each such feed is disabled and the items it brought in are hidden (not
 * deleted, so an admin can restore any of them), with one audit entry per feed ("imagematch-retract").
 *
 * What is NOT retracted ("imagematch-keep", audited): a feed the creator names himself. The look-alike path could land on an
 * account that really is his; when his own links list or bio names it, an alias he claimed (source bio / admin) matches it, or
 * an identity link that is not "different people" mentions it, it stays. A bio is not counted when `creators.bio_source` says it
 * was read from this feed's own platform (it may have been filled from this very feed's profile).
 *
 * Re-running it changes nothing: a creator + page that already has a retract or keep entry is skipped, so a feed an admin
 * re-enabled is never disabled again. A feed that was already disabled for another reason still has its look-alike items hidden
 * (unless self-declared). Same-picture (pHash) matches are untouched.
 */
function v18(db) {
  const { parseProfile } = require('../lib/links');
  const { normAlias } = require('../lib/alias');
  const hasBioSource = db.prepare('PRAGMA table_info(creators)').all().some((c) => c.name === 'bio_source');
  const rows = db.prepare("SELECT target_id AS creator_id, reason FROM moderation_actions WHERE action = 'image-match' AND target_type = 'creator' AND reason LIKE 'look-alike%'").all();
  const find = db.prepare("SELECT id, platform, kind, target FROM feeds WHERE creator_id = ? AND platform = ? AND kind = ? AND lower(target) = lower(?) AND origin = 'discovered'");
  const handled = db.prepare("SELECT 1 FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action IN ('imagematch-retract', 'imagematch-keep') AND instr(reason, ?) > 0");
  const creatorOf = db.prepare(`SELECT bio, links${hasBioSource ? ', bio_source' : ''} FROM creators WHERE id = ?`);
  const alias = db.prepare("SELECT 1 FROM creator_aliases WHERE creator_id = ? AND norm = ? AND source IN ('bio', 'admin')");
  const ident = db.prepare("SELECT evidence FROM identity_links WHERE (a_id = ? OR b_id = ?) AND status != 'rejected'");
  const off = db.prepare('UPDATE feeds SET enabled = 0 WHERE id = ?');
  const hide = db.prepare("UPDATE media SET publish_state = 'hidden', review_reason = 'look-alike attribution retracted' WHERE feed_id = ? AND publish_state IN ('published', 'review')");
  const log = db.prepare("INSERT INTO moderation_actions (target_type, target_id, action, reason, actor) VALUES ('creator', ?, ?, ?, 'migration')");

  const bare = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** How the creator himself names this feed: 'links' | 'bio' | 'alias' | 'identity' | null. */
  const selfDeclared = (creatorId, f) => {
    const c = creatorOf.get(creatorId);
    if (!c) return null;
    const t = String(f.target).toLowerCase(); const tb = bare(t);
    const handle = t.length >= 3 && !/^https?:/.test(t);
    let links = []; try { links = JSON.parse(c.links || '[]'); } catch { links = []; }
    for (const l of links) {
      if (!l) continue;
      const lt = String(l.target || l.handle || '').toLowerCase(); const lu = bare(l.url);
      if ((l.platform === f.platform && lt === t) || (lu && lu === tb) || (handle && lu && lu.includes(`/${t}`)) || (handle && lt === t)) return 'links';
    }
    const bioFromThisPlatform = hasBioSource && c.bio_source && c.bio_source === f.platform;
    if (!bioFromThisPlatform && c.bio) {
      const bio = String(c.bio).toLowerCase();
      if (handle ? new RegExp(`(^|[^a-z0-9_])${esc(t)}($|[^a-z0-9_])`).test(bio) : tb.length > 8 && bio.includes(tb)) return 'bio';
    }
    if (handle && alias.get(creatorId, normAlias(t))) return 'alias';
    for (const r of ident.all(creatorId, creatorId)) if (handle && String(r.evidence || '').toLowerCase().includes(t)) return 'identity';
    return null;
  };

  const done = new Set();
  for (const r of rows) {
    const url = String(r.reason || '').split(' → ')[1];
    if (!url) continue;
    let spec = null;
    try { spec = parseProfile(url); } catch { spec = null; }
    for (const c of [spec, { platform: 'web', kind: 'page', target: url }].filter((x) => x && x.platform && x.target)) {
      const f = find.get(r.creator_id, c.platform, c.kind || 'user', String(c.target));
      if (!f || done.has(f.id) || handled.get(r.creator_id, url)) continue;
      done.add(f.id);
      const own = selfDeclared(r.creator_id, f);
      if (own) { log.run(r.creator_id, 'imagematch-keep', `kept: self-declared (${own}); not retracted → ${url}`.slice(0, 400)); continue; }
      off.run(f.id);
      const hidden = hide.run(f.id).changes;
      log.run(r.creator_id, 'imagematch-retract', `look-alike attribution removed: feed disabled, ${hidden} item(s) hidden → ${url}`.slice(0, 400));
    }
  }
}

function v19(db) {
  db.prepare("UPDATE feeds SET enabled = 0 WHERE platform = 'lemmy'").run();
}

function v20(db) { db.exec('ALTER TABLE media ADD COLUMN attribution_evidence TEXT'); }

function v21(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_faces (
      media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      face_idx INTEGER NOT NULL DEFAULT 0,
      gender TEXT,
      confidence REAL,
      box TEXT,
      vec BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (media_id, face_idx)
    );
    CREATE INDEX IF NOT EXISTS idx_media_faces_media ON media_faces(media_id);

    CREATE TABLE IF NOT EXISTS creator_web_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id TEXT NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
      page_url TEXT NOT NULL,
      image_url TEXT,
      title TEXT,
      platform TEXT NOT NULL DEFAULT 'web',
      match_kind TEXT NOT NULL DEFAULT 'phash',
      similarity REAL,
      phash_distance INTEGER,
      evidence TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(creator_id, page_url)
    );
    CREATE INDEX IF NOT EXISTS idx_creator_web_matches_creator ON creator_web_matches(creator_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_creator_web_matches_status ON creator_web_matches(status, created_at DESC);
  `);
  const cols = new Set(db.pragma('table_info(creators)').map((c) => c.name));
  if (!cols.has('last_monitored_at')) {
    db.exec('ALTER TABLE creators ADD COLUMN last_monitored_at TEXT');
  }
}

// Removed media kept its embeddings, hashes and URLs. Keep each removed item's hashes in the blocklists
// (they are what stops a re-upload), then clear the identifiers. Only publish_state = 'removed' rows change.
function v22(db) {
  db.exec(`INSERT OR IGNORE INTO phash_blocklist (phash, reason)
    SELECT phash, COALESCE(review_reason, 'removed') FROM media WHERE publish_state = 'removed' AND phash IS NOT NULL`);
  db.exec(`INSERT OR IGNORE INTO blocklist (type, value, reason)
    SELECT 'hash', lower(hash), review_reason FROM media
    WHERE publish_state = 'removed' AND hash NOT LIKE 'purged:%'`);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_embeddings'").get()) {
    db.exec("DELETE FROM media_embeddings WHERE media_id IN (SELECT id FROM media WHERE publish_state = 'removed')");
  }
  db.exec(`UPDATE media SET phash = NULL, hash = 'purged:' || id, media_url = '', preview_url = NULL,
    thumbnail_url = NULL, thumb_url = NULL, hls_url = NULL, tint = NULL
    WHERE publish_state = 'removed' AND hash NOT LIKE 'purged:%'`);
}

// Counters drifted: creators.media_count and friends were only refreshed by some writers, and tags.usage_count
// was bumped by hand. Keep tags.usage_count equal to its media_tags rows with triggers (so every writer,
// including cascades, is covered), then recompute both once for rows that are already wrong.
function v23(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_media_tags_insert AFTER INSERT ON media_tags
    BEGIN UPDATE tags SET usage_count = usage_count + 1 WHERE id = NEW.tag_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_media_tags_delete AFTER DELETE ON media_tags
    BEGIN UPDATE tags SET usage_count = usage_count - 1 WHERE id = OLD.tag_id; END;
  `);
  db.exec('UPDATE tags SET usage_count = (SELECT COUNT(*) FROM media_tags mt WHERE mt.tag_id = tags.id)');
  db.exec(`UPDATE creators SET
      media_count = (SELECT COUNT(*) FROM media m WHERE m.creator_id = creators.id AND m.publish_state = 'published'),
      video_count = (SELECT COUNT(*) FROM media m WHERE m.creator_id = creators.id AND m.publish_state = 'published' AND m.media_type = 'video'),
      total_score = (SELECT COALESCE(SUM(m.score), 0) FROM media m WHERE m.creator_id = creators.id AND m.publish_state = 'published'),
      last_media_at = (SELECT MAX(m.posted_at) FROM media m WHERE m.creator_id = creators.id AND m.publish_state = 'published')`);
}

/**
 * v24: covering indexes for the read paths that scan the whole published library, measured on a 300k-media / 10k-creator copy.
 * SQLite answers "COUNT(*) of the published library" (the list total, /api/stats, the per-platform counts) from
 * ix_media_state, which holds no other column, so every one of the 260k rows costs a table lookup (~1 s). These two partial
 * indexes hold exactly the columns those queries read, so they are index-only scans (~20-80 ms):
 *   ix_media_pub_count  (platform, media_type, creator_id): list totals by type / platform, stats, platform counts;
 *   ix_media_pub_comm   (community NOCASE, platform): community counts and the autocomplete's community prefix.
 * Both are partial (published and not excluded: what every public query asks for), so they stay small, and
 * CREATE INDEX IF NOT EXISTS adds them in place without rewriting the table (about 2 s for 400k rows). The queries
 * name them with INDEXED BY: sqlite_stat1 makes the planner believe "publish_state = 'published'" is selective.
 */
function v24(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_media_pub_count ON media(platform, media_type, creator_id) WHERE publish_state = 'published' AND scope != 'excluded';
    CREATE INDEX IF NOT EXISTS ix_media_pub_comm ON media(community COLLATE NOCASE, platform) WHERE publish_state = 'published' AND scope != 'excluded' AND community IS NOT NULL;
  `);
}

// Index-only: adds no rows and changes none, so it cannot leave a foreign key dangling. migrate() skips the post-migration
// foreign_key_check for it, which on a 400k-row library is a few seconds of boot time before the listener is up.
v24.ddlOnly = true;


/**
 * v25: creator popularity (src/engine/popularity.js). One stored number per creator, so "popular"
 * sorts and Home rails are an index read instead of an aggregate over the whole media table.
 *   popularity    0-100, from engagement / breadth / volume / freshness (see the engine).
 *   popularity_at when the number was last computed (the UI only speaks about freshness, never
 *                 presents a stale rank as current).
 *   ix_creators_popularity  (popularity DESC, last_media_at DESC): the default "popular" order,
 *                 freshest among equals.
 *   ix_media_platform_score  (platform, score DESC) partial: the per-platform 95th percentile the
 *                 rank normalises by, answered index-only instead of scanning each platform.
 */
function v25(db) {
  const cols = db.prepare('PRAGMA table_info(creators)').all().map((c) => c.name);
  if (!cols.includes('popularity')) db.exec('ALTER TABLE creators ADD COLUMN popularity REAL NOT NULL DEFAULT 0');
  if (!cols.includes('popularity_at')) db.exec('ALTER TABLE creators ADD COLUMN popularity_at TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_creators_popularity ON creators(popularity DESC, last_media_at DESC);
    CREATE INDEX IF NOT EXISTS ix_media_platform_score ON media(platform, score DESC) WHERE publish_state = 'published' AND score > 0;
  `);
}
v25.ddlOnly = true;

/**
 * v26: web push alerts. One row per browser endpoint, with the creators that browser asked to watch.
 * Media itself is not copied: the push job reads the existing media table and notifies, then moves
 * last_checked_at forward. A dead endpoint (404/410) is disabled, not deleted, so a re-subscribe
 * from the same browser simply turns it back on.
 */
function v26(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      creator_ids TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (${NOW}),
      updated_at TEXT NOT NULL DEFAULT (${NOW}),
      last_checked_at TEXT,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_push_enabled ON push_subscriptions(enabled, last_checked_at);
  `);
}
v26.ddlOnly = true;

/**
 * v27: OCR text. `ocr_text` is the words read out of a picture (never copied media), indexed in FTS
 * so an image-only post becomes searchable. `ocr_at` marks an attempt, successful or not, so a dead
 * image is not retried forever. The FTS table gains the same column and its triggers are rebuilt.
 */
function v27(db) {
  const mediaCols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  if (!mediaCols.includes('ocr_text')) db.exec('ALTER TABLE media ADD COLUMN ocr_text TEXT');
  if (!mediaCols.includes('ocr_at')) db.exec('ALTER TABLE media ADD COLUMN ocr_at TEXT');
  const ftsCols = db.prepare('PRAGMA table_info(media_fts)').all().map((c) => c.name);
  if (!ftsCols.includes('ocr_text')) {
    // SQLite cannot ALTER an FTS5 virtual table: drop the triggers and rebuild the index with the
    // extra column. It is an index only — the media rows are untouched.
    db.exec(`
      DROP TRIGGER IF EXISTS media_fts_ai;
      DROP TRIGGER IF EXISTS media_fts_ad;
      DROP TRIGGER IF EXISTS media_fts_au;
      DROP TABLE IF EXISTS media_fts;
      CREATE VIRTUAL TABLE media_fts USING fts5(
        title, author, community, tags_text, description, ocr_text,
        content='media', content_rowid='seq', tokenize='unicode61 remove_diacritics 2'
      );
    `);
  }
  db.exec(`
    DROP TRIGGER IF EXISTS media_fts_ai;
    DROP TRIGGER IF EXISTS media_fts_ad;
    DROP TRIGGER IF EXISTS media_fts_au;
    CREATE TRIGGER media_fts_ai AFTER INSERT ON media BEGIN
      INSERT INTO media_fts(rowid, title, author, community, tags_text, description, ocr_text)
      VALUES (new.seq, new.title, new.author, new.community, new.tags_text, new.description, new.ocr_text);
    END;
    CREATE TRIGGER media_fts_ad AFTER DELETE ON media BEGIN
      INSERT INTO media_fts(media_fts, rowid, title, author, community, tags_text, description, ocr_text)
      VALUES ('delete', old.seq, old.title, old.author, old.community, old.tags_text, old.description, old.ocr_text);
    END;
    CREATE TRIGGER media_fts_au AFTER UPDATE OF title, author, community, tags_text, description, ocr_text ON media BEGIN
      INSERT INTO media_fts(media_fts, rowid, title, author, community, tags_text, description, ocr_text)
      VALUES ('delete', old.seq, old.title, old.author, old.community, old.tags_text, old.description, old.ocr_text);
      INSERT INTO media_fts(rowid, title, author, community, tags_text, description, ocr_text)
      VALUES (new.seq, new.title, new.author, new.community, new.tags_text, new.description, new.ocr_text);
    END;
    INSERT INTO media_fts(media_fts) VALUES ('rebuild');
  `);
}
v27.ddlOnly = true;

/**
 * v28: face-enrolment marker. `face_at` records that a picture was looked at for male face descriptors,
 * successful or not, so the newest-first face sweep does not retry dead pictures forever. It stores no
 * biometric data itself; the vectors live in `media_faces` and are purged on takedown.
 */
function v28(db) {
  const cols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  if (!cols.includes('face_at')) db.exec('ALTER TABLE media ADD COLUMN face_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS ix_media_face_todo ON media(seq DESC) WHERE face_at IS NULL AND publish_state = \'published\'');
}
v28.ddlOnly = true;

/**
 * v29 (PRISM 4.19): lean preference. A per-row multiplier on the trending score (NULL =
 * neutral) so lean / athletic men rank a little higher and heavy / bear content a little
 * lower without anything being hidden — the body filter itself stays off (owner decision
 * of 2026-11-02). Written by the ingest pipeline and the maintenance bias sweep.
 */
function v29(db) {
  const cols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  if (!cols.includes('lean_bias')) db.exec('ALTER TABLE media ADD COLUMN lean_bias REAL');
}
v29.ddlOnly = true;

/**
 * v30 (owner, 2026-11-09): Reddit posts stay in the library. `reddit_text` is the restart-safe
 * copy of text read from Reddit, so lib/aiguard can keep it off hosted models. The stored
 * `redditEnabled` flag is set on once here. An admin can switch it off afterwards and this
 * migration will not turn it on again.
 */
function v30(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS reddit_text (norm TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (${NOW}))`);
  // Tests keep the off default so a suite that never asked for Reddit does not hit the network.
  // Every other database (the production volume included) is switched on once. An admin can turn it off later.
  if (process.env.NODE_ENV === 'test') return;
  db.prepare(`INSERT INTO settings (key, value) VALUES ('redditEnabled', 'true')
    ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = ${NOW}`).run();
}

/**
 * v31: the two public sorts that still built a temporary table.
 * Popular creators ordered by COALESCE(popularity), which cannot use ix_creators_popularity.
 * The partial index stops at the two predicates the query writes as literals. media_count and
 * last_media_at are parameters, and SQLite refuses INDEXED BY when a partial predicate is a parameter.
 * Ingested media ordered by ingested_at, seq while the index stopped at ingested_at.
 */
function v31(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_creators_popular_active
      ON creators(popularity DESC, last_media_at DESC, media_count DESC, total_score DESC, id)
      WHERE status = 'active' AND scope != 'excluded';
    CREATE INDEX IF NOT EXISTS ix_media_pub_ingested
      ON media(ingested_at DESC, seq DESC)
      WHERE publish_state = 'published';
  `);
}
v31.ddlOnly = true;

/**
 * v32: the review queue clears a hold by exact reason. The partial index covers "how many
 * are waiting under this reason" and "the next chunk of those rows" without a table scan.
 */
function v32(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_media_review_reason
      ON media(review_reason, seq)
      WHERE publish_state = 'review';
  `);
}
v32.ddlOnly = true;

/**
 * v33: a row that becomes published (approved from review, restored, re-attributed, any path) with no face vectors stored
 * goes back to face enrolment: `face_at` is cleared, so the face sweep reads it at its own pace. Before this, a row stamped
 * while it sat in review (no vectors are saved for review rows) was never enrolled once published.
 */
function v33(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS media_face_reenrol AFTER UPDATE OF publish_state ON media
    WHEN NEW.publish_state = 'published' AND OLD.publish_state != 'published' AND NEW.face_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM media_faces WHERE media_id = NEW.id)
    BEGIN
      UPDATE media SET face_at = NULL WHERE id = NEW.id;
    END;
  `);
}
v33.ddlOnly = true;

const MIGRATIONS = [v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, v16, v17, v18, v19, v20, v21, v22, v23, v24, v25, v26, v27, v28, v29, v30, v31, v32, v33];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= MIGRATIONS.length) return { from: current, to: current };

  // Table rebuilds need foreign keys off; the pragma is a no-op inside a transaction.
  db.pragma('foreign_keys = OFF');
  try {
    for (let i = current; i < MIGRATIONS.length; i++) {
      const run = db.transaction(() => {
        MIGRATIONS[i](db);
        const issues = MIGRATIONS[i].ddlOnly ? [] : db.pragma('foreign_key_check');
        if (issues.length) throw new Error(`Migration ${i + 1} left ${issues.length} foreign-key violations`);
        db.pragma(`user_version = ${i + 1}`);
      });
      run();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return { from: current, to: MIGRATIONS.length };
}

module.exports = { migrate, MIGRATIONS, NOW };
