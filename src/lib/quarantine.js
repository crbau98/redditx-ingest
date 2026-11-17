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

/**
 * SAFETY HOLD (decision of the safety-gate owner, v4.23.1): under-18 wording in the profile of a feed PRISM attached on its own is
 * evidence about THAT page or account, but a minor is the one thing PRISM must never publish, so the creator is not left running:
 * he goes HIDDEN, every feed of his is paused, and a review entry (an 'underage' report, which every unhide path already honours)
 * puts the decision in front of a human. Nothing is removed, purged or blocklisted for him: if the page was the problem, nothing is
 * lost; if he was, a person decides. Stays until a human acts: recover-block, the body-filter unhide and the identity-repair unhide
 * all refuse it. Returns false when there is nothing to do (blocked already, or held already).
 */
function safetyHold(creator, feed, rule) {
  if (!creator || creator.status === 'blocked') return false;
  const held = repo.db.prepare("SELECT 1 AS ok FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? AND action = 'safety-hold' LIMIT 1").get(creator.id);
  if (held && creator.status === 'hidden') return false;
  const feeds = repo.db.prepare('SELECT id FROM feeds WHERE creator_id = ? AND enabled = 1').all(creator.id).map((f) => f.id);
  for (const id of feeds) repo.feeds.update(id, { enabled: false });
  repo.creators.update(creator.id, { status: 'hidden' });
  const page = `${feed.platform}:${feed.target}`;
  repo.logAction('creator', creator.id, 'safety-hold', `${String(page).slice(0, 160)} matched ${rule}${feeds.length ? ` [feeds:${feeds.join(',')}]` : ''}`.slice(0, 480), 'system');
  repo.reports.create({ creatorId: creator.id, kind: 'underage', reason: `safety-hold (system): the profile of ${page} matched ${rule}; creator hidden and his feeds paused, nothing removed. A human decides.`, reporterHash: 'system' });
  events.log('WARN', `Creator ${creator.handle} put on safety hold: ${page} matched ${rule}`);
  return true;
}

module.exports = { quarantineFeed, safetyHold };
