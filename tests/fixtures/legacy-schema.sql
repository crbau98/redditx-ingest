  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    media_type TEXT NOT NULL CHECK(media_type IN ('image', 'video')),
    media_url TEXT NOT NULL,
    preview_url TEXT,
    thumbnail_url TEXT,
    source_platform TEXT NOT NULL DEFAULT 'reddit',
    source_url TEXT,
    source_id TEXT,
    subreddit TEXT,
    author TEXT,
    score INTEGER DEFAULT 0,
    hash TEXT UNIQUE,
    width INTEGER,
    height INTEGER,
    duration_seconds REAL,
    mime_type TEXT,
    file_size_bytes INTEGER,
    orientation_scope TEXT NOT NULL DEFAULT 'gay' CHECK(orientation_scope IN ('gay', 'uncertain', 'excluded_straight')),
    orientation_review_note TEXT,
    publish_state TEXT NOT NULL DEFAULT 'published' CHECK(publish_state IN ('draft', 'review', 'published', 'hidden', 'removed')),
    ai_description TEXT,
    ai_tags TEXT,
    ai_confidence REAL,
    ai_review_state TEXT DEFAULT 'pending' CHECK(ai_review_state IN ('pending', 'approved', 'rejected', 'edited')),
    nsfw_level TEXT DEFAULT 'explicit' CHECK(nsfw_level IN ('suggestive', 'explicit', 'extreme')),
    creator_id TEXT REFERENCES creators(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_media_creator ON media(creator_id);
  CREATE INDEX IF NOT EXISTS idx_media_source ON media(source_platform, source_id);
  CREATE INDEX IF NOT EXISTS idx_media_orientation ON media(orientation_scope);
  CREATE INDEX IF NOT EXISTS idx_media_publish ON media(publish_state);
  CREATE INDEX IF NOT EXISTS idx_media_score ON media(score DESC);
  CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_media_subreddit ON media(subreddit);
  CREATE INDEX IF NOT EXISTS idx_media_hash ON media(hash);

  CREATE TABLE IF NOT EXISTS creators (
    id TEXT PRIMARY KEY,
    primary_handle TEXT NOT NULL,
    display_name TEXT,
    bio TEXT,
    avatar_url TEXT,
    orientation_scope TEXT NOT NULL DEFAULT 'gay' CHECK(orientation_scope IN ('gay', 'uncertain', 'excluded_straight')),
    identity_confidence REAL DEFAULT 1.0,
    merge_state TEXT DEFAULT 'auto_merged' CHECK(merge_state IN ('auto_merged', 'review_required', 'manually_locked')),
    verified INTEGER DEFAULT 0,
    media_count INTEGER DEFAULT 0,
    total_score INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_creators_handle ON creators(primary_handle);

  CREATE TABLE IF NOT EXISTS creator_sources (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL REFERENCES creators(id),
    source_platform TEXT NOT NULL,
    source_creator_id TEXT,
    handle TEXT,
    profile_url TEXT,
    verification_state TEXT DEFAULT 'unverified',
    last_synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_csource_creator ON creator_sources(creator_id);

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    category TEXT DEFAULT 'general',
    usage_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS media_tags (
    media_id TEXT NOT NULL REFERENCES media(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    source TEXT DEFAULT 'manual' CHECK(source IN ('manual', 'ai', 'ingest')),
    PRIMARY KEY (media_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS moderation_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL CHECK(target_type IN ('media', 'creator')),
    target_id TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    actor TEXT DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ingestion_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    config TEXT,
    stats TEXT,
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
