'use strict';
/**
 * Physique policy: only fit / athletic bodies are shown.
 *
 *   item     a picture whose heaviness score (lib/physique, 0..100) is at or above `physiqueThreshold` is HIDDEN, not
 *            deleted: the score is stored on the item, so moving the threshold (or switching the filter off) re-applies to
 *            the whole library in both directions (`reapply`).
 *   creator  a creator with at least MIN_MEASURED measured pictures, `physiqueCreatorShare` % or more of them hidden by
 *            this policy, is hidden too (with their feeds paused, so the server stops fetching them). Reversible the same way.
 *   text     "chubby", "superchub", "gainer", "dad bod" ... in an item's own text exclude it at ingest (nothing is stored);
 *            in a creator's handle / name / bio they hide the creator.
 *
 * Every hide this policy makes carries a `physique:` reason (items) or a `physique-hide` moderation action (creators), so it
 * only ever undoes its own decisions, never an admin's.
 */
const repo = require('../db/repo');
const events = require('./events');
const { textCheck } = require('../lib/physique');

const MIN_MEASURED = 3;
const TEXT_SCORE = 101; // stored on items hidden for their words: above any measured score, and never counted as a measured picture
const APPROVED = -1;    // stored when an admin approves an item the body filter hid: no sweep or setting hides it again
const REASON = 'physique:';

const enabled = (s) => !!s && s.physiqueFilter === true;
const DEFAULT_THRESHOLD = 45;
const DEFAULT_SHARE = 30;
const threshold = (s) => (s && Number.isFinite(s.physiqueThreshold) ? s.physiqueThreshold : DEFAULT_THRESHOLD);

/**
 * The body filter's own settings as they are now, for a caller holding a snapshot (`liveBody: true`, e.g. a feed run that
 * started minutes ago): switching the filter off or moving the threshold mid-run applies to the very next decision.
 */
function live(settings) {
  if (!settings || !settings.liveBody) return settings;
  const s = require('../settings').get();
  return { ...settings, physiqueFilter: s.physiqueFilter, physiqueThreshold: s.physiqueThreshold, physiqueCreatorShare: s.physiqueCreatorShare };
}

/** Publish state for a new item with this score (or null to leave the pipeline's own decision alone). */
function stateFor(score, settings) {
  if (!enabled(settings) || !Number.isFinite(score) || score < threshold(settings)) return null;
  return { state: 'hidden', reason: `${REASON}${score}` };
}

function lastCreatorAction(id) {
  return repo.db.prepare("SELECT id, action, reason FROM moderation_actions WHERE target_type = 'creator' AND target_id = ? ORDER BY id DESC LIMIT 1").get(String(id));
}

function hideCreator(creator, why) {
  if (!creator || creator.status !== 'active') return false;
  const feeds = repo.db.prepare('SELECT id FROM feeds WHERE creator_id = ? AND enabled = 1').all(creator.id).map((f) => f.id);
  for (const id of feeds) repo.feeds.update(id, { enabled: false });
  repo.creators.update(creator.id, { status: 'hidden' });
  repo.logAction('creator', creator.id, 'physique-hide', `${why}${feeds.length ? ` [feeds:${feeds.join(',')}]` : ''}`, 'system');
  events.log('INFO', `Creator ${creator.handle} hidden: ${why}`);
  return true;
}

function unhideCreator(creator) {
  const last = lastCreatorAction(creator.id);
  if (creator.status !== 'hidden' || !last || last.action !== 'physique-hide') return false; // not ours to undo
  // a safety report (e.g. underage) waiting for a human keeps the creator hidden whatever the body filter says
  if (repo.db.prepare("SELECT 1 FROM reports WHERE creator_id = ? AND status = 'open' LIMIT 1").get(creator.id)) return false;
  const m = /\[feeds:([^\]]*)\]/.exec(last.reason || '');
  // a feed someone enabled or disabled since the hide keeps that decision
  const touched = repo.db.prepare("SELECT 1 FROM moderation_actions WHERE target_type = 'feed' AND target_id = ? AND id > ? LIMIT 1");
  for (const id of m ? m[1].split(',').filter(Boolean) : []) {
    if (repo.feeds.get(id) && !touched.get(String(id), last.id)) repo.feeds.update(id, { enabled: true });
  }
  repo.creators.update(creator.id, { status: 'active' });
  repo.logAction('creator', creator.id, 'physique-unhide', 'body filter no longer applies', 'system');
  return true;
}

/** Re-judge one creator from their measured pictures (and their own profile text). */
function reviewCreator(creatorId, settings) {
  const c = creatorId && repo.creators.get(creatorId);
  if (!c) return null;
  const share = settings && Number.isFinite(settings.physiqueCreatorShare) ? settings.physiqueCreatorShare : DEFAULT_SHARE;
  const r = repo.db.prepare(`SELECT COUNT(*) AS measured, SUM(CASE WHEN physique >= ? THEN 1 ELSE 0 END) AS heavy FROM media
    WHERE creator_id = ? AND physique BETWEEN 0 AND 100 AND publish_state IN ('published','hidden','review')`).get(threshold(settings), c.id);
  const text = textCheck(c.handle, c.display_name, c.bio);
  let why = null;
  if (enabled(settings) && text.heavy) why = `body filter: profile says "${text.rule.slice(REASON.length)}"`;
  else if (enabled(settings) && share > 0 && r.measured >= MIN_MEASURED && (100 * (r.heavy || 0)) / r.measured >= share) why = `body filter: ${r.heavy} of ${r.measured} measured pictures are heavy`;
  if (why) return hideCreator(c, why) ? 'hidden' : null;
  return unhideCreator(c) ? 'restored' : null;
}

/**
 * Apply the current settings to everything already stored: hide what is now over the line, show again what this policy
 * hid and no longer would, then re-judge every creator with measured pictures. Cheap: indexed, scores are not recomputed.
 */
function reapply(settings) {
  const on = enabled(settings); const thr = threshold(settings);
  const res = { hidden: 0, restored: 0, creatorsHidden: 0, creatorsRestored: 0 };
  const toHide = on ? repo.db.prepare("SELECT id, physique FROM media WHERE publish_state = 'published' AND physique >= ?").all(thr) : [];
  const toShow = repo.db.prepare(`SELECT id FROM media WHERE publish_state = 'hidden' AND review_reason LIKE '${REASON}%'
    AND (? = 0 OR physique IS NULL OR physique < ?)`).all(on ? 1 : 0, thr);
  repo.db.transaction(() => {
    for (const r of toHide) { repo.media.setState(r.id, 'hidden', `${REASON}${r.physique}`, { exact: true }); res.hidden++; }
    for (const r of toShow) { repo.media.setState(r.id, 'published', null, { exact: true }); res.restored++; }
  })();
  const creators = repo.db.prepare(`SELECT DISTINCT creator_id AS id FROM media WHERE creator_id IS NOT NULL AND physique IS NOT NULL
    UNION SELECT target_id FROM moderation_actions WHERE target_type = 'creator' AND action = 'physique-hide'`).all();
  for (const { id } of creators) {
    const v = reviewCreator(id, settings);
    if (v === 'hidden') res.creatorsHidden++; else if (v === 'restored') res.creatorsRestored++;
  }
  if (!on) {
    // switched off: feeds this policy paused run again (unless someone changed them since)
    for (const f of repo.db.prepare(`SELECT f.id FROM feeds f WHERE f.enabled = 0 AND (SELECT action FROM moderation_actions a
      WHERE a.target_type = 'feed' AND a.target_id = CAST(f.id AS TEXT) ORDER BY a.id DESC LIMIT 1) = 'physique-feed-off'`).all()) {
      repo.feeds.update(f.id, { enabled: true });
      repo.logAction('feed', f.id, 'physique-feed-on', 'body filter switched off', 'system');
    }
    repo.settings.set('physique_text_sweep_version', ''); // switching it back on re-reads the words
  }
  if (res.hidden || res.restored || res.creatorsHidden || res.creatorsRestored) {
    events.log('OK', `Body filter re-applied: ${res.hidden} hidden, ${res.restored} shown again · creators: ${res.creatorsHidden} hidden, ${res.creatorsRestored} shown again`);
  }
  return res;
}

/**
 * A feed just created by any path (a linked profile, an import, a discovered account): one named in chub wording starts
 * paused, the same reversible way the word sweep pauses one. Pass `repo.feeds.upsert`'s result.
 */
function screenFeed(r) {
  const f = r && r.created && r.feed;
  if (!f || !f.enabled || !enabled(require('../settings').get())) return false;
  const t = textCheck(f.target, f.label);
  if (!t.heavy) return false;
  repo.feeds.update(f.id, { enabled: false });
  repo.logAction('feed', f.id, 'physique-feed-off', `body filter: "${t.rule.slice(REASON.length)}"`, 'system');
  return true;
}

/**
 * Publish a stored item (a report dismissed, a restore): its stored body score still applies, unless an admin approved it
 * over the body filter.
 */
function publish(id, settings) {
  const m = repo.media.get(id);
  if (!m) return null;
  const v = stateFor(m.physique, settings);
  if (v) repo.media.setState(id, v.state, v.reason, { exact: true }); else repo.media.setState(id, 'published');
  return repo.media.get(id).publish_state;
}

const TEXT_SWEEP_VERSION = '2'; // 2: bears, cubs, stocky, burly, ガチムチ ... // bump when the word list grows: stored items, creators and feeds are re-read once

/**
 * Read stored items, creators and feeds against the physique word list. Items are hidden with TEXT_SCORE (so `reapply` can
 * show them again when the filter is switched off), creators hidden, feeds paused. Runs once per word-list version and
 * whenever the filter is switched on.
 */
async function textSweep(settings, { force = false } = {}) {
  const res = { items: 0, creators: 0, feeds: 0 };
  if (!enabled(settings)) return res;
  if (!force && repo.settings.get('physique_text_sweep_version') === TEXT_SWEEP_VERSION) return res;
  // It yields between batches: if an admin switches the filter off meanwhile (that request already re-showed everything),
  // stop instead of hiding more with the settings captured at the start.
  const stillOn = () => require('../settings').get().physiqueFilter === true;
  let after = 0;
  // Only published items: one waiting in the review queue keeps its own state and reason, so switching the filter off later
  // can never publish something a human has not looked at.
  const stmt = repo.db.prepare(`SELECT seq, id, title, description, tags_text, community, author FROM media
    WHERE publish_state = 'published' AND (physique IS NULL OR physique >= 0) AND seq > ? ORDER BY seq LIMIT 500`);
  for (;;) {
    if (!stillOn()) return res;
    const rows = stmt.all(after);
    if (!rows.length) break;
    repo.db.transaction(() => {
      for (const r of rows) {
        after = r.seq;
        const t = textCheck(r.title, r.description, r.tags_text, r.community, r.author);
        if (!t.heavy) continue;
        repo.media.setPhysique(r.id, TEXT_SCORE);
        repo.media.setState(r.id, 'hidden', `${REASON}text:${t.rule.slice(REASON.length)}`, { exact: true });
        res.items++;
      }
    })();
    await new Promise((r) => setImmediate(r)); // let requests breathe
  }
  if (!stillOn()) return res;
  for (const c of repo.db.prepare("SELECT id FROM creators WHERE status = 'active'").all()) {
    if (reviewCreator(c.id, settings) === 'hidden') res.creators++;
  }
  for (const f of repo.db.prepare('SELECT id, target, label FROM feeds WHERE enabled = 1').all()) {
    const t = textCheck(f.target, f.label);
    if (!t.heavy) continue;
    repo.feeds.update(f.id, { enabled: false });
    repo.logAction('feed', f.id, 'physique-feed-off', `body filter: "${t.rule.slice(REASON.length)}"`, 'system');
    res.feeds++;
  }
  repo.settings.set('physique_text_sweep_version', TEXT_SWEEP_VERSION);
  if (res.items || res.creators || res.feeds) events.log('OK', `Body filter (words): ${res.items} item(s) hidden, ${res.creators} creator(s) hidden, ${res.feeds} feed(s) paused`);
  return res;
}

const DEFAULTS_VERSION = '2';
/**
 * v5 made the body filter stricter (heaviness 60 -> 45, creator share 50% -> 30%). The admin console stores every setting
 * when it is saved, so an install still on the old defaults is moved to the new ones once; a value an admin chose
 * themselves (anything but the old default) is kept. Returns true when something changed (the caller re-applies).
 */
function migrateDefaults() {
  if (repo.settings.get('physique_defaults_version') === DEFAULTS_VERSION) return false;
  let changed = false;
  for (const [key, from, to] of [['physiqueThreshold', '60', DEFAULT_THRESHOLD], ['physiqueCreatorShare', '50', DEFAULT_SHARE]]) {
    const v = repo.settings.get(key);
    if (v === from) { repo.settings.set(key, String(to)); changed = true; }
  }
  repo.settings.set('physique_defaults_version', DEFAULTS_VERSION);
  if (changed) events.log('INFO', `Body filter: stricter defaults (heaviness ${DEFAULT_THRESHOLD}, creator share ${DEFAULT_SHARE}%)`);
  return changed;
}

/** Library numbers for the admin console. */
function stats(settings) {
  const thr = threshold(settings);
  const r = repo.db.prepare(`SELECT SUM(CASE WHEN physique BETWEEN 0 AND 100 THEN 1 ELSE 0 END) AS measured,
    SUM(CASE WHEN physique <= 100 AND physique >= ? THEN 1 ELSE 0 END) AS overThreshold,
    SUM(CASE WHEN publish_state = 'hidden' AND review_reason LIKE '${REASON}%' THEN 1 ELSE 0 END) AS hidden FROM media WHERE physique IS NOT NULL`).get(thr);
  const buckets = repo.db.prepare(`SELECT (physique / 10) * 10 AS b, COUNT(*) AS n FROM media WHERE physique BETWEEN 0 AND 100 AND publish_state != 'removed' GROUP BY b ORDER BY b`).all();
  const creators = repo.db.prepare("SELECT COUNT(*) AS n FROM creators c WHERE c.status = 'hidden' AND (SELECT action FROM moderation_actions a WHERE a.target_type = 'creator' AND a.target_id = c.id ORDER BY a.id DESC LIMIT 1) = 'physique-hide'").get().n;
  return { enabled: enabled(settings), threshold: thr, creatorShare: settings ? settings.physiqueCreatorShare : null, measured: r.measured || 0, overThreshold: r.overThreshold || 0, hidden: r.hidden || 0, creatorsHidden: creators, histogram: buckets };
}

module.exports = { migrateDefaults, DEFAULT_THRESHOLD, DEFAULT_SHARE, live, screenFeed, publish, stateFor, reviewCreator, reapply, textSweep, stats, hideCreator, textCheck, enabled, threshold, REASON, MIN_MEASURED, APPROVED };
