'use strict';
/**
 * Quarantine an automatic feed and the account behind it: off, the account blocklisted, the items it already published held for review.
 * The creator it was attached to is NOT touched. Shared by every place where female evidence comes from an account or a page PRISM
 * attached on its own: the item pipeline, and the profile refresh in engine/creators (where a web page's "profile" is its meta
 * description: thefap's says "leaked girls", which blocked 36 of the 43 creators that had one of its pages).
 *
 * Every automatic feed reading this account goes off, not only the one that saw her (a second, discovered feed on the same account
 * kept publishing her items); a feed a person chose stays on, because that is a decision about it. Whatever she posted that came in
 * through any other feed of the platform (a search, a hashtag) is held too.
 */
const repo = require('../db/repo');
const events = require('../engine/events');
const { isAutomaticOrigin } = require('./feed-origins');

/**
 * @param {object} feed the feed that supplied the evidence
 * @param {string} reason audited and written on the blocklist entries
 * @param {{author?: string|null}} opts the poster's handle, when the item named one
 */
function quarantineFeed(feed, reason, { author = null } = {}) {
  const her = author ? String(author).toLowerCase() : null;
  const accounts = [...new Set([String(feed.target).toLowerCase(), ...(her ? [her] : [])])];
  for (const a of accounts) repo.blocklist.add('creator', `${feed.platform}:${a}`, reason);
  const marks = accounts.map(() => '?').join(',');
  const offFeeds = repo.db.prepare(`SELECT id, origin FROM feeds WHERE platform = ? AND lower(target) IN (${marks})`).all(feed.platform, ...accounts)
    .filter((f) => f.id === feed.id || isAutomaticOrigin(f.origin));
  if (!offFeeds.some((f) => f.id === feed.id)) offFeeds.push({ id: feed.id });
  let held = 0;
  const hold = (id) => { repo.media.setState(id, 'review', `${reason} (feed account)`); held++; };
  for (const f of offFeeds) {
    repo.feeds.update(f.id, { enabled: false });
    try { repo.logAction('feed', f.id, 'scope-feed-off', reason, 'system'); } catch { /* an old audit table cannot take feed rows */ }
    for (const row of repo.db.prepare("SELECT id FROM media WHERE feed_id = ? AND publish_state = 'published' LIMIT 5000").all(f.id)) hold(row.id);
  }
  if (her) {
    try {
      const rows = repo.db.prepare(`SELECT m.id FROM media_fts JOIN media m ON m.seq = media_fts.rowid
        WHERE media_fts MATCH ? AND m.platform = ? AND lower(m.author) = ? AND m.publish_state = 'published' LIMIT 5000`)
        .all(`author:"${her.replace(/"/g, '""')}"`, feed.platform, her);
      for (const r of rows) hold(r.id);
    } catch { /* no search index (very old database): the feed sweep above still ran */ }
  }
  events.log('WARN', `Feed ${feed.platform}:${feed.target} switched off (${reason}); ${offFeeds.length} feed(s) on the account off, ${held} item(s) held for review; creator left alone`);
  return held;
}

module.exports = { quarantineFeed };
