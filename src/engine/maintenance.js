'use strict';
/**
 * Library-wide maintenance. The important one is `sweep`: it re-applies the
 * current safety / junk rules to content that is already stored, so rule
 * improvements (and anything ingested by an older version with no gate at all)
 * are enforced retroactively.
 */
const repo = require('../db/repo');
const events = require('./events');
const { checkText } = require('../lib/safety');
const { femaleCheck } = require('../lib/scope');
const { hostBlocked, hostOf, isJunkTitle } = require('../lib/mediaurl');
const { probeMedia } = require('./probe');

// Bump whenever the safety or male-only scope rules get stricter: existing libraries are re-swept once.
// v3: male-only scope (female / feminine / trans-feminine content is removed and blocklisted).
const SAFETY_SWEEP_VERSION = '3';

async function sweep({ probe = false, limit = 1_000_000 } = {}) {
  const res = { checked: 0, blocked: 0, review: 0, hidden: 0, dead: 0, female: 0, femaleReview: 0, femaleCreators: 0, femaleFeeds: 0 };
  let after = 0;
  const stmt = repo.db.prepare(`SELECT seq, id, title, description, tags_text, community, author, media_url, media_type, publish_state
    FROM media WHERE publish_state IN ('published','review') AND seq > ? ORDER BY seq LIMIT 500`);
  events.log('INFO', 'Sweeping library against current safety and quality rules…');
  for (;;) {
    const rows = stmt.all(after);
    if (!rows.length || res.checked >= limit) break;
    for (const row of rows) {
      after = row.seq; res.checked++;
      const s = checkText(row.title, row.description, row.tags_text, row.community, row.author);
      if (s.level === 'block') { repo.media.block(row.id, `safety sweep: ${s.rule}`, 'system'); res.blocked++; continue; }
      if (s.level === 'review' && row.publish_state === 'published') { repo.media.setState(row.id, 'review', `safety:${s.rule}`); res.review++; continue; }
      // Male-only scope: hard female / feminine wording removes the item for good (hash + source key are
      // blocklisted so it can never be re-imported); softer wording sends published items back to a human.
      const g = femaleCheck(row.title, row.description, row.tags_text, row.community, row.author);
      if (g.level === 'hard') { repo.media.block(row.id, `scope sweep: ${g.rule}`, 'system'); res.female++; continue; }
      if (g.level === 'soft' && row.publish_state === 'published') { repo.media.setState(row.id, 'review', `scope:${g.rule}`); res.femaleReview++; continue; }
      const host = hostOf(row.media_url); // relative/local URLs have no host: nothing to judge
      if (isJunkTitle(row.title) || (host && hostBlocked(host))) { repo.media.setState(row.id, 'hidden', 'junk'); res.hidden++; continue; }
      if (probe && row.publish_state === 'published' && !/\.m3u8/.test(row.media_url) && /imgur\.com/.test(row.media_url)) {
        const p = await probeMedia(row.media_url, row.media_type);
        if (!p.ok && /http (404|410)|too small/.test(p.reason)) { repo.media.setState(row.id, 'hidden', `dead: ${p.reason}`); res.dead++; }
      }
    }
    await new Promise((r) => setImmediate(r)); // let requests breathe
  }
  const creators = repo.db.prepare("SELECT id, handle, display_name, bio FROM creators WHERE status = 'active'").all();
  for (const c of creators) {
    const s = checkText(c.handle, c.display_name, c.bio);
    if (s.level === 'block') { repo.creators.block(c.id, `safety sweep (creator): ${s.rule}`, 'system'); res.blocked++; continue; }
    const g = femaleCheck(c.handle, c.display_name, c.bio);
    if (g.level === 'hard') { repo.creators.block(c.id, `scope sweep (creator): ${g.rule}`, 'system'); res.femaleCreators++; }
  }
  // Feeds named after women / feminine themes (communities, searches, tags) are switched off and remembered.
  for (const f of repo.db.prepare('SELECT id, platform, kind, target, label FROM feeds WHERE enabled = 1').all()) {
    const g = femaleCheck(f.target, f.label);
    if (g.level !== 'hard') continue;
    repo.feeds.update(f.id, { enabled: false });
    repo.blocklist.add('creator', `${f.platform}:${String(f.target).toLowerCase()}`, `scope sweep (feed): ${g.rule}`);
    res.femaleFeeds++;
  }
  events.log('OK', `Sweep done: checked ${res.checked} · blocked ${res.blocked} · to review ${res.review} · hidden ${res.hidden}${probe ? ` · dead ${res.dead}` : ''} · male-only scope: ${res.female} removed, ${res.femaleReview} to review, ${res.femaleCreators} creators, ${res.femaleFeeds} feeds`);
  return res;
}

/** Run the safety sweep once per rule-set version, in the background after boot. */
function startupSweepIfNeeded() {
  if (repo.settings.get('safety_sweep_version') === SAFETY_SWEEP_VERSION) return;
  setTimeout(async () => {
    try { await sweep(); repo.settings.set('safety_sweep_version', SAFETY_SWEEP_VERSION); }
    catch (e) { events.log('ERR', `startup sweep failed: ${e.message}`); }
  }, 1500).unref();
}

module.exports = { sweep, startupSweepIfNeeded };
