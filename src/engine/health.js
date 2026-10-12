'use strict';
/**
 * Link health: a self-healing library.
 *
 * Media disappears at the source all the time (deleted posts, removed images, closed accounts).
 * Two inputs find it:
 *   - reports: a viewer's browser tells us an item failed to load (cheap, immediate, but untrusted);
 *   - a slow background sweep that re-checks published items, least recently checked first.
 * Either way the server verifies at the source itself. An item is hidden only after TWO "gone"
 * verdicts at least an hour apart — a 404/410, or a tiny placeholder such as imgur's removed.png.
 * Hotlink blocks (403), login walls, timeouts and 5xx are "unknown" and never hide anything, so a
 * flood of fake reports or a CDN outage cannot take content down. Hidden items keep the reason
 * ("Gone at source: http 404") and can be restored from Admin → Media.
 */
const repo = require('../db/repo');
const events = require('./events');
const settingsStore = require('../settings');
const { probeMedia } = require('./probe');

const CONFIRM_AFTER_MS = 60 * 60 * 1000;   // second "gone" verdict must come at least this much later
const REPORT_RECHECK_MS = 30 * 60 * 1000;   // a report re-checks an item at most this often
const now = () => new Date().toISOString();

const q = {
  get: repo.db.prepare('SELECT * FROM media_health WHERE media_id = ?'),
  upsert: repo.db.prepare(`INSERT INTO media_health (media_id, reports, last_report, checked_at, verdict, http_status, gone_streak)
    VALUES (@media_id, @reports, @last_report, @checked_at, @verdict, @http_status, @gone_streak)
    ON CONFLICT(media_id) DO UPDATE SET reports = @reports, last_report = @last_report, checked_at = @checked_at,
      verdict = @verdict, http_status = @http_status, gone_streak = @gone_streak`),
  media: repo.db.prepare('SELECT id, media_url, preview_url, media_type, hls_url, publish_state FROM media WHERE id = ?'),
  // Pending confirmations first (one "gone" verdict, the hour has passed), then never-checked
  // items, then the least recently checked. Never-checked rows have no media_health row, so
  // `h.verdict = 'gone'` is NULL for them; COALESCE keeps them from sorting after stale ones.
  due: repo.db.prepare(`SELECT m.id FROM media m LEFT JOIN media_health h ON h.media_id = m.id
    WHERE m.publish_state = 'published'
      AND (h.checked_at IS NULL OR h.checked_at < @stale OR (h.verdict = 'gone' AND h.checked_at < @confirm))
    ORDER BY COALESCE(h.verdict = 'gone', 0) DESC, h.checked_at IS NOT NULL, h.checked_at ASC, m.hot DESC LIMIT @n`),
  stats: repo.db.prepare(`SELECT COUNT(*) AS checked, SUM(verdict = 'gone') AS gone, SUM(reports) AS reports,
    SUM(CASE WHEN verdict = 'gone' AND checked_at >= ? THEN 1 ELSE 0 END) AS gone7d FROM media_health`),
};

/** Classify a probe result: 'ok', 'gone' (really removed), or 'unknown' (can't tell — never acted on). */
function classify(p) {
  if (p.ok) return { verdict: 'ok', status: 200 };
  const m = /http (\d{3})/.exec(p.reason || '');
  const status = m ? Number(m[1]) : null;
  if (status === 404 || status === 410) return { verdict: 'gone', status };
  if (/too small/.test(p.reason || '')) return { verdict: 'gone', status: status || 200 }; // placeholder image
  return { verdict: 'unknown', status };
}

const isHls = (u) => /\.m3u8(\?|$)/i.test(u || '');
const isHttp = (u) => /^https?:/i.test(u || '');

/**
 * What to probe for an item: the media itself, or for an HLS-only video its playlist. A playlist is
 * a small text file, so the placeholder size rule is off for it (a 404/410 still means gone). The
 * poster is a last resort for images only: a live poster says nothing about a dead stream.
 */
function targetFor(m) {
  if (isHttp(m.media_url) && !isHls(m.media_url)) return { url: m.media_url };
  const playlist = [m.hls_url, m.media_url].find((u) => isHttp(u) && isHls(u));
  if (playlist) return { url: playlist, opts: { minBytes: 1 } };
  if (m.media_type !== 'video' && isHttp(m.preview_url)) return { url: m.preview_url };
  return null;
}

/** Verify one item at its source and act on the verdict. */
async function check(id, { probe = probeMedia } = {}) {
  const m = q.media.get(id);
  if (!m) return null;
  const prev = q.get.get(id) || { media_id: id, reports: 0, last_report: null, checked_at: null, verdict: null, http_status: null, gone_streak: 0 };
  const target = targetFor(m);
  if (!target) {
    // Nothing we can probe: record the attempt so the item rotates to the back of the sweep and
    // reports are throttled like any other, instead of staying "never checked" forever.
    q.upsert.run({ ...prev, checked_at: now(), verdict: 'unknown', http_status: null });
    return { verdict: 'unknown', skipped: true };
  }
  const { verdict, status } = classify(await probe(target.url, m.media_type, target.opts));
  let streak = prev.gone_streak;
  if (verdict === 'gone') {
    // only a verdict at least an hour after the previous "gone" confirms it
    const spaced = !prev.checked_at || Date.now() - new Date(prev.checked_at).getTime() >= CONFIRM_AFTER_MS;
    if (prev.verdict !== 'gone') streak = 1; else if (spaced) streak += 1;
  } else if (verdict === 'ok') streak = 0;
  // unknown keeps the streak as it was: it neither confirms nor clears
  const row = { ...prev, checked_at: verdict === 'gone' && prev.verdict === 'gone' && streak === prev.gone_streak ? prev.checked_at : now(), verdict, http_status: status, gone_streak: streak };
  if (verdict === 'ok') { row.reports = 0; }
  q.upsert.run(row);
  let hidden = false;
  if (verdict === 'gone' && streak >= 2 && m.publish_state === 'published') {
    repo.media.setState(id, 'hidden', `Gone at source${status ? ` (http ${status})` : ''}`);
    events.log('OK', `Link health: hid ${id} — gone at source${status ? ` (http ${status})` : ''}`);
    hidden = true;
  }
  return { verdict, status, streak, hidden };
}

/** A viewer's browser could not load this item. Untrusted: it only schedules a verification. */
function report(id) {
  const m = q.media.get(id);
  if (!m || m.publish_state !== 'published') return { ok: false };
  const prev = q.get.get(id) || { media_id: id, reports: 0, last_report: null, checked_at: null, verdict: null, http_status: null, gone_streak: 0 };
  q.upsert.run({ ...prev, reports: prev.reports + 1, last_report: now() });
  const s = settingsStore.get();
  const recent = prev.checked_at && Date.now() - new Date(prev.checked_at).getTime() < REPORT_RECHECK_MS;
  // A pending confirmation (one "gone" already) is re-checked once the hour has passed.
  const confirmDue = prev.verdict === 'gone' && prev.checked_at && Date.now() - new Date(prev.checked_at).getTime() >= CONFIRM_AFTER_MS;
  const willCheck = s.linkHealth && (!recent || confirmDue);
  if (willCheck) setImmediate(() => check(id).catch((e) => events.log('WARN', `Link health: ${e.message}`)));
  return { ok: true, checking: !!willCheck };
}

/** Background pass: re-check the least recently checked items, a few at a time. */
async function sweep({ limit, maxAgeDays = 14, probe = probeMedia, aborted = () => false } = {}) {
  const s = settingsStore.get();
  const n = limit || s.linkHealthPerSweep;
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  const out = { checked: 0, gone: 0, hidden: 0, unknown: 0 };
  const confirm = new Date(Date.now() - CONFIRM_AFTER_MS).toISOString();
  for (const { id } of q.due.all({ stale: cutoff, confirm, n })) {
    if (aborted()) break;
    const r = await check(id, { probe });
    if (!r) continue;
    out.checked++;
    if (r.verdict === 'gone') out.gone++;
    if (r.verdict === 'unknown') out.unknown++;
    if (r.hidden) out.hidden++;
  }
  if (out.hidden) events.log('INFO', `Link health: checked ${out.checked}, hid ${out.hidden} gone at source`);
  return out;
}

function stats() {
  const r = q.stats.get(new Date(Date.now() - 7 * 86400000).toISOString());
  return { checked: r.checked || 0, gone: r.gone || 0, reports: r.reports || 0, gone7d: r.gone7d || 0 };
}

let timer = null; let running = false; let stopFlag = false;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    const s = settingsStore.get();
    if (!s.schedulerEnabled || !s.linkHealth || running) return;
    running = true; stopFlag = false;
    sweep({ aborted: () => stopFlag }).catch((e) => events.log('WARN', `Link health sweep: ${e.message}`)).finally(() => { running = false; });
  }, 10 * 60 * 1000);
  timer.unref();
}
function stop() { stopFlag = true; clearInterval(timer); timer = null; }

module.exports = { check, report, sweep, stats, classify, start, stop, CONFIRM_AFTER_MS };
