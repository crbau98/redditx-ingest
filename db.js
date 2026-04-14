const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'prism.db');

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// --- Schema Migration ---
db.exec(`
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
`);

// --- Prepared Statements ---

// Media
const insertMedia = db.prepare(`
  INSERT OR IGNORE INTO media (id, title, description, media_type, media_url, preview_url, thumbnail_url,
    source_platform, source_url, source_id, subreddit, author, score, hash, width, height,
    orientation_scope, publish_state, creator_id)
  VALUES (@id, @title, @description, @media_type, @media_url, @preview_url, @thumbnail_url,
    @source_platform, @source_url, @source_id, @subreddit, @author, @score, @hash, @width, @height,
    @orientation_scope, @publish_state, @creator_id)
`);

const getMediaById = db.prepare('SELECT * FROM media WHERE id = ?');

const updateMedia = db.prepare(`
  UPDATE media SET title=coalesce(@title,title), description=coalesce(@description,description),
    publish_state=coalesce(@publish_state,publish_state), orientation_scope=coalesce(@orientation_scope,orientation_scope),
    ai_description=coalesce(@ai_description,ai_description), ai_tags=coalesce(@ai_tags,ai_tags),
    nsfw_level=coalesce(@nsfw_level,nsfw_level), updated_at=datetime('now')
  WHERE id = @id
`);

const deleteMedia = db.prepare("UPDATE media SET publish_state = 'removed', updated_at = datetime('now') WHERE id = ?");

const countMedia = db.prepare("SELECT COUNT(*) as count FROM media WHERE publish_state != 'removed'");
const countMediaByType = db.prepare("SELECT media_type, COUNT(*) as count FROM media WHERE publish_state != 'removed' GROUP BY media_type");

// Creators
const insertCreator = db.prepare(`
  INSERT OR IGNORE INTO creators (id, primary_handle, display_name, orientation_scope)
  VALUES (@id, @primary_handle, @display_name, @orientation_scope)
`);

const getCreatorById = db.prepare('SELECT * FROM creators WHERE id = ?');
const getCreatorByHandle = db.prepare('SELECT * FROM creators WHERE primary_handle = ?');

const updateCreator = db.prepare(`
  UPDATE creators SET display_name=coalesce(@display_name,display_name), bio=coalesce(@bio,bio),
    avatar_url=coalesce(@avatar_url,avatar_url), orientation_scope=coalesce(@orientation_scope,orientation_scope),
    verified=coalesce(@verified,verified), updated_at=datetime('now')
  WHERE id = @id
`);

const updateCreatorStats = db.prepare(`
  UPDATE creators SET
    media_count = (SELECT COUNT(*) FROM media WHERE creator_id = @id AND publish_state = 'published'),
    total_score = (SELECT COALESCE(SUM(score),0) FROM media WHERE creator_id = @id AND publish_state = 'published'),
    updated_at = datetime('now')
  WHERE id = @id
`);

// Creator Sources
const insertCreatorSource = db.prepare(`
  INSERT OR IGNORE INTO creator_sources (id, creator_id, source_platform, source_creator_id, handle, profile_url)
  VALUES (@id, @creator_id, @source_platform, @source_creator_id, @handle, @profile_url)
`);

const getCreatorSources = db.prepare('SELECT * FROM creator_sources WHERE creator_id = ?');

// Tags
const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name, category) VALUES (@name, @category)');
const getTagByName = db.prepare('SELECT * FROM tags WHERE name = ?');
const incrementTagCount = db.prepare('UPDATE tags SET usage_count = usage_count + 1 WHERE id = ?');
const decrementTagCount = db.prepare('UPDATE tags SET usage_count = MAX(0, usage_count - 1) WHERE id = ?');

// Media Tags
const insertMediaTag = db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id, source) VALUES (@media_id, @tag_id, @source)');
const getMediaTags = db.prepare(`
  SELECT t.* FROM tags t JOIN media_tags mt ON t.id = mt.tag_id WHERE mt.media_id = ?
`);

// Moderation
const insertModerationAction = db.prepare(`
  INSERT INTO moderation_actions (target_type, target_id, action, reason, actor)
  VALUES (@target_type, @target_id, @action, @reason, @actor)
`);

// Ingestion Jobs
const insertJob = db.prepare(`
  INSERT INTO ingestion_jobs (id, status, config, started_at)
  VALUES (@id, @status, @config, @started_at)
`);

const updateJob = db.prepare(`
  UPDATE ingestion_jobs SET status=coalesce(@status,status), stats=coalesce(@stats,stats),
    completed_at=coalesce(@completed_at,completed_at), error=coalesce(@error,error)
  WHERE id = @id
`);

const getJob = db.prepare('SELECT * FROM ingestion_jobs WHERE id = ?');
const getJobs = db.prepare('SELECT * FROM ingestion_jobs ORDER BY created_at DESC LIMIT ?');

// Settings
const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value=@value, updated_at=datetime('now')
`);
const getAllSettings = db.prepare('SELECT * FROM settings');

// --- Exported API ---
module.exports = {
  db,

  // Media
  insertMedia(data) { return insertMedia.run(data); },
  getMedia(id) { return getMediaById.get(id); },
  updateMedia(data) { return updateMedia.run(data); },
  deleteMedia(id) { return deleteMedia.run(id); },

  listMedia({ page = 0, limit = 50, type, subreddit, creator, tag, sort = 'recent', q, publishState = 'published' } = {}) {
    let where = ['publish_state = ?'];
    let params = [publishState];

    if (type) { where.push('media_type = ?'); params.push(type); }
    if (subreddit) { where.push('subreddit = ?'); params.push(subreddit); }
    if (creator) { where.push('creator_id = ?'); params.push(creator); }
    if (q) { where.push('(title LIKE ? OR author LIKE ? OR subreddit LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (tag) {
      where.push('id IN (SELECT media_id FROM media_tags mt JOIN tags t ON mt.tag_id = t.id WHERE t.name = ?)');
      params.push(tag);
    }

    let orderBy = 'created_at DESC';
    if (sort === 'score') orderBy = 'score DESC';
    else if (sort === 'random') orderBy = 'RANDOM()';
    else if (sort === 'oldest') orderBy = 'created_at ASC';

    const countSql = `SELECT COUNT(*) as total FROM media WHERE ${where.join(' AND ')}`;
    const total = db.prepare(countSql).get(...params).total;

    const dataSql = `SELECT * FROM media WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params.push(limit, page * limit);
    const items = db.prepare(dataSql).all(...params);

    return { items, total, page, limit };
  },

  getRelatedMedia(id, limit = 12) {
    const media = getMediaById.get(id);
    if (!media) return [];
    return db.prepare(`
      SELECT * FROM media
      WHERE id != ? AND publish_state = 'published' AND subreddit = ?
      ORDER BY score DESC LIMIT ?
    `).all(id, media.subreddit, limit);
  },

  getSubreddits() {
    return db.prepare("SELECT DISTINCT subreddit FROM media WHERE publish_state = 'published' AND subreddit IS NOT NULL ORDER BY subreddit").all().map(r => r.subreddit);
  },

  getMediaByHash(hash) {
    return db.prepare('SELECT * FROM media WHERE hash = ?').get(hash);
  },

  getStats() {
    const total = countMedia.get().count;
    const byType = {};
    countMediaByType.all().forEach(r => { byType[r.media_type] = r.count; });
    const creators = db.prepare('SELECT COUNT(*) as count FROM creators').get().count;
    const jobs = db.prepare('SELECT COUNT(*) as count FROM ingestion_jobs').get().count;
    const modQueue = db.prepare("SELECT COUNT(*) as count FROM media WHERE orientation_scope = 'uncertain' OR publish_state = 'review'").get().count;
    return { total, images: byType.image || 0, videos: byType.video || 0, creators, jobs, moderationQueue: modQueue };
  },

  // Creators
  insertCreator(data) { return insertCreator.run(data); },
  getCreator(id) { return getCreatorById.get(id); },
  getCreatorByHandle(handle) { return getCreatorByHandle.get(handle); },
  updateCreator(data) { return updateCreator.run(data); },
  updateCreatorStats(id) { return updateCreatorStats.run({ id }); },

  listCreators({ page = 0, limit = 50, q } = {}) {
    let where = ['1=1'];
    let params = [];
    if (q) { where.push('(primary_handle LIKE ? OR display_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

    const total = db.prepare(`SELECT COUNT(*) as total FROM creators WHERE ${where.join(' AND ')}`).get(...params).total;
    params.push(limit, page * limit);
    const items = db.prepare(`SELECT * FROM creators WHERE ${where.join(' AND ')} ORDER BY media_count DESC LIMIT ? OFFSET ?`).all(...params);
    return { items, total, page, limit };
  },

  mergeCreators(keepId, mergeId) {
    const keep = getCreatorById.get(keepId);
    const merge = getCreatorById.get(mergeId);
    if (!keep || !merge) return null;

    db.prepare('UPDATE media SET creator_id = ?, updated_at = datetime(\'now\') WHERE creator_id = ?').run(keepId, mergeId);
    db.prepare('UPDATE creator_sources SET creator_id = ? WHERE creator_id = ?').run(keepId, mergeId);
    db.prepare('DELETE FROM creators WHERE id = ?').run(mergeId);
    updateCreatorStats.run({ id: keepId });
    return getCreatorById.get(keepId);
  },

  // Creator Sources
  insertCreatorSource(data) { return insertCreatorSource.run(data); },
  getCreatorSources(creatorId) { return getCreatorSources.all(creatorId); },

  // Tags
  insertTag(data) { return insertTag.run(data); },
  getTag(name) { return getTagByName.get(name); },
  listTags(limit = 100) {
    return db.prepare('SELECT * FROM tags ORDER BY usage_count DESC LIMIT ?').all(limit);
  },
  addTagToMedia(mediaId, tagName, source = 'manual') {
    insertTag.run({ name: tagName, category: 'general' });
    const tag = getTagByName.get(tagName);
    if (tag) {
      insertMediaTag.run({ media_id: mediaId, tag_id: tag.id, source });
      incrementTagCount.run(tag.id);
    }
  },
  getMediaTags(mediaId) { return getMediaTags.all(mediaId); },

  // Moderation
  insertModerationAction(data) { return insertModerationAction.run(data); },
  getModerationQueue({ page = 0, limit = 50 } = {}) {
    const where = "(orientation_scope = 'uncertain' OR publish_state = 'review')";
    const total = db.prepare(`SELECT COUNT(*) as total FROM media WHERE ${where}`).get().total;
    const items = db.prepare(`SELECT * FROM media WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(limit, page * limit);
    return { items, total, page, limit };
  },
  getModerationActions(targetId) {
    return db.prepare('SELECT * FROM moderation_actions WHERE target_id = ? ORDER BY created_at DESC').all(targetId);
  },

  // Jobs
  insertJob(data) { return insertJob.run(data); },
  updateJob(data) { return updateJob.run(data); },
  getJob(id) { return getJob.get(id); },
  getJobs(limit = 50) { return getJobs.all(limit); },

  // Settings
  getSetting(key) { const r = getSetting.get(key); return r ? r.value : null; },
  setSetting(key, value) { return upsertSetting.run({ key, value }); },
  getAllSettings() { const s = {}; getAllSettings.all().forEach(r => { s[r.key] = r.value; }); return s; },
};
