'use strict';
/**
 * What PRISM has learned about how to read each host: the "intelligence" behind Browser4 use.
 *
 * A browser render is slow (10-60 s) and heavy, so it should be spent where it pays. Per host this remembers how often a
 * plain download showed media, how often a render found MORE, and decides - before the browser is started - whether a
 * render is worth it this time:
 *
 *   fallback   render only when the plain download showed nothing (as before), unless the host has taught us it is a waste
 *   always     "adaptive": render until the host has had a fair try (EXPLORE renders) and keep doing it while it helps
 *              (renders beat the plain read often enough); stop when it never has, and look again after RECHECK_DAYS
 *   back-off   a render that finds nothing rests the host: 6 h, 12 h, 24 h ... up to 3 days, reset by the first win
 *   unlock     (opt-in, paid) an unlock that finds nothing backs off 12 h, 24 h ... 3 days, so credit is not burned
 *   challenge  a bot-challenge page rests the host for 1 day, doubling to 7 days. Nothing is solved or bypassed: the host
 *              is simply left alone, which is also kinder to it
 *
 * Everything is a per-host row in `host_strategy`; no setting needs tuning for it to work.
 */
const repo = require('../db/repo');

const EXPLORE = 3;               // renders a host always gets before the numbers decide
const MIN_WIN_RATE = 0.2;        // 'always' keeps rendering a host while at least this share of renders beat the plain read
const RECHECK_DAYS = 14;         // a host written off is tried again after this long
const HOUR = 3600_000;

const now = () => new Date().toISOString();
const later = (ms) => new Date(Date.now() + ms).toISOString();
const q = () => repo.db;

function get(host) { return host ? q().prepare('SELECT * FROM host_strategy WHERE host = ?').get(host) || null : null; }

/**
 * Should the browser be used for this page?
 * @param {string} host
 * @param {{mode: 'fallback'|'always', found: number}} o  `found` = how many media/links the plain download showed
 * @returns {{render: boolean, why: string}}
 */
function decide(host, { mode, found }) {
  const row = get(host);
  if (row && row.challenged_until && row.challenged_until > now()) return { render: false, why: `${host} answered with a bot-challenge; resting it until ${row.challenged_until.slice(0, 16).replace('T', ' ')} UTC` };
  if (row && row.render_after && row.render_after > now()) return { render: false, why: `rendering ${host} found nothing ${row.empty_streak}x in a row; next try after ${row.render_after.slice(0, 16).replace('T', ' ')} UTC` };
  if (mode !== 'always') return found === 0 ? { render: true, why: 'the plain download showed nothing' } : { render: false, why: 'the plain download already shows media' };
  // adaptive "always"
  if (found === 0) return { render: true, why: 'the plain download showed nothing' };
  if (!row || row.render_runs < EXPLORE) return { render: true, why: `exploring ${host} (${row ? row.render_runs : 0}/${EXPLORE} renders so far)` };
  const rate = row.render_wins / row.render_runs;
  const stale = row.last_render_at && Date.parse(row.last_render_at) < Date.now() - RECHECK_DAYS * 24 * HOUR;
  if (rate >= MIN_WIN_RATE) return { render: true, why: `rendering ${host} has beaten the plain read in ${row.render_wins}/${row.render_runs} runs` };
  if (stale) return { render: true, why: `looking at ${host} again (last render was over ${RECHECK_DAYS} days ago)` };
  return { render: false, why: `rendering ${host} beat the plain read in only ${row.render_wins}/${row.render_runs} runs` };
}

/**
 * Remember what a read taught us. Call once per page read.
 * @param {string} host
 * @param {{found: number, rendered?: number|null, challenge?: boolean}} o
 *   found     media/links the plain download showed
 *   rendered  media/links the render found (null/undefined = no render happened)
 *   challenge the site answered the browser with a bot-challenge page
 */
function record(host, { found, rendered = null, challenge = false }) {
  if (!host) return;
  const row = get(host) || {};
  const next = {
    host,
    plain_runs: (row.plain_runs || 0) + 1,
    plain_media: (row.plain_media || 0) + Math.max(0, found || 0),
    render_runs: row.render_runs || 0,
    render_media: row.render_media || 0,
    render_wins: row.render_wins || 0,
    empty_streak: row.empty_streak || 0,
    challenges: row.challenges || 0,
    render_after: row.render_after || null,
    challenged_until: row.challenged_until || null,
    last_render_at: row.last_render_at || null,
  };
  if (challenge) {
    next.challenges++;
    next.challenged_until = later(Math.min(7, 2 ** (next.challenges - 1)) * 24 * HOUR);
    next.last_render_at = now();
  } else if (rendered !== null && rendered !== undefined) {
    next.render_runs++;
    next.render_media += rendered;
    next.last_render_at = now();
    next.challenged_until = null;
    if (rendered > (found || 0)) { next.render_wins++; next.empty_streak = 0; next.render_after = null; } // a win: render freely again
    else if (rendered === 0) { next.empty_streak++; next.render_after = later(Math.min(72, 6 * 2 ** (next.empty_streak - 1)) * HOUR); }
    else { next.empty_streak = 0; next.render_after = null; } // found something, just not more than the plain read
  }
  q().prepare(`INSERT INTO host_strategy (host, plain_runs, plain_media, render_runs, render_media, render_wins, empty_streak, challenges, render_after, challenged_until, last_render_at, updated_at)
    VALUES (@host, @plain_runs, @plain_media, @render_runs, @render_media, @render_wins, @empty_streak, @challenges, @render_after, @challenged_until, @last_render_at, @updated_at)
    ON CONFLICT(host) DO UPDATE SET plain_runs=@plain_runs, plain_media=@plain_media, render_runs=@render_runs, render_media=@render_media, render_wins=@render_wins,
      empty_streak=@empty_streak, challenges=@challenges, render_after=@render_after, challenged_until=@challenged_until, last_render_at=@last_render_at, updated_at=@updated_at`)
    .run({ ...next, updated_at: now() });
}

/**
 * Is it worth spending an unlock (a paid request through Bright Data) on this host right now? A host where unlocking
 * keeps coming back empty is backed off (12 h, 24 h, 48 h, up to 3 days), so credit is not burned on pages that hold nothing.
 */
function decideUnlock(host) {
  const row = get(host);
  if (row && row.unlock_after && row.unlock_after > now()) return { unlock: false, why: `unlocking ${host} found nothing ${row.unlock_empty_streak}x in a row; next try after ${row.unlock_after.slice(0, 16).replace('T', ' ')} UTC` };
  return { unlock: true, why: row && row.unlock_runs ? `unlocking ${host} has paid off in ${row.unlock_wins}/${row.unlock_runs} runs` : `first unlock for ${host}` };
}

/** Remember the outcome of an unlock: `found` = media/links in what came back. */
function recordUnlock(host, { found }) {
  if (!host) return;
  const row = get(host) || {};
  const runs = (row.unlock_runs || 0) + 1;
  const wins = (row.unlock_wins || 0) + (found > 0 ? 1 : 0);
  const streak = found > 0 ? 0 : (row.unlock_empty_streak || 0) + 1;
  const after = found > 0 ? null : later(Math.min(72, 12 * 2 ** (streak - 1)) * HOUR);
  q().prepare(`INSERT INTO host_strategy (host, unlock_runs, unlock_wins, unlock_empty_streak, unlock_after, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(host) DO UPDATE SET unlock_runs=excluded.unlock_runs, unlock_wins=excluded.unlock_wins, unlock_empty_streak=excluded.unlock_empty_streak, unlock_after=excluded.unlock_after, updated_at=excluded.updated_at`)
    .run(host, runs, wins, streak, after, now());
}

/** For the admin console: how many hosts are known, and the ones where the browser pays or is resting. */
function summary(limit = 10) {
  const t = now();
  const c = q().prepare(`SELECT COUNT(*) AS hosts,
      SUM(CASE WHEN render_wins > 0 THEN 1 ELSE 0 END) AS render_helps,
      SUM(CASE WHEN (render_after > ? OR challenged_until > ?) THEN 1 ELSE 0 END) AS resting
    FROM host_strategy`).get(t, t);
  const top = q().prepare('SELECT host, render_runs, render_wins, render_media, plain_media, empty_streak, challenges, render_after, challenged_until FROM host_strategy WHERE render_runs > 0 OR challenges > 0 ORDER BY render_wins DESC, render_runs DESC LIMIT ?').all(limit);
  return { hosts: c.hosts || 0, renderHelps: c.render_helps || 0, resting: c.resting || 0, top };
}

const _reset = () => q().prepare('DELETE FROM host_strategy').run();

module.exports = { decide, record, decideUnlock, recordUnlock, summary, get, EXPLORE, MIN_WIN_RATE, RECHECK_DAYS, _reset };
