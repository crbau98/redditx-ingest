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
      title, author, community, tags_text, description,
      content='media', content_rowid='seq', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS media_fts_ai AFTER INSERT ON media BEGIN
      INSERT INTO media_fts(rowid, title, author, community, tags_text, description)
      VALUES (new.seq, new.title, new.author, new.community, new.tags_text, new.description);
    END;
    CREATE TRIGGER IF NOT EXISTS media_fts_ad AFTER DELETE ON media BEGIN
      INSERT INTO media_fts(media_fts, rowid, title, author, community, tags_text, description)
      VALUES ('delete', old.seq, old.title, old.author, old.community, old.tags_text, old.description);
    END;
    CREATE TRIGGER IF NOT EXISTS media_fts_au AFTER UPDATE OF title, author, community, tags_text, description ON media BEGIN
      INSERT INTO media_fts(media_fts, rowid, title, author, community, tags_text, description)
      VALUES ('delete', old.seq, old.title, old.author, old.community, old.tags_text, old.description);
      INSERT INTO media_fts(rowid, title, author, community, tags_text, description)
      VALUES (new.seq, new.title, new.author, new.community, new.tags_text, new.description);
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

const MIGRATIONS = [v1, v2, v3, v4, v5];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= MIGRATIONS.length) return { from: current, to: current };

  // Table rebuilds need foreign keys off; the pragma is a no-op inside a transaction.
  db.pragma('foreign_keys = OFF');
  try {
    for (let i = current; i < MIGRATIONS.length; i++) {
      const run = db.transaction(() => {
        MIGRATIONS[i](db);
        const issues = db.pragma('foreign_key_check');
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
