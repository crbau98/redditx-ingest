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
const { hostBlocked, hostOf, isJunkTitle } = require('../lib/mediaurl');
const { probeMedia } = require('./probe');

const SAFETY_SWEEP_VERSION = '2'; // bump whenever the safety rules get stricter: existing libraries are re-swept once

async function sweep({ probe = false, limit = 1_000_000 } = {}) {
  const res = { checked: 0, blocked: 0, review: 0, hidden: 0, dead: 0 };
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
    if (s.level === 'block') { repo.creators.block(c.id, `safety sweep (creator): ${s.rule}`, 'system'); res.blocked++; }
  }
  events.log('OK', `Sweep done: checked ${res.checked} · blocked ${res.blocked} · to review ${res.review} · hidden ${res.hidden}${probe ? ` · dead ${res.dead}` : ''}`);
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
