// Pure helpers for the admin console. No DOM, no network: these decide what the screens say, so tests can pin them down.

/** Sections that stay one tap away on a phone; every other section lives behind "More". */
export const PHONE_NAV = ['overview', 'moderation', 'feeds', 'settings'];

/* ------------------------------------------------------------------ review queue */

/** What the gate wrote in `review_reason`, in words a reviewer can act on. */
export function holdOf(reason) {
  const r = String(reason || '').trim();
  const safety = r.match(/^safety:\s*(.+?)(?:\s*\(community\))?$/);
  if (safety) {
    const rule = safety[1].trim();
    return { kind: 'safety', rule, label: `Safety: ${rule}`, group: 'Safety rule matched', why: `The safety gate matched “${rule}”. Approving publishes it.` };
  }
  if (r === 'scope:unclear' || r === 'scope') {
    return { kind: 'scope', rule: null, label: 'Male focus unclear', group: 'Male focus unclear', why: 'The gate could not confirm a male creator. Check the creator and the post before you approve.' };
  }
  return { kind: 'other', rule: null, label: r || 'Held for review', group: 'Other holds', why: 'Held by the gate for a decision. Nothing here is public until you approve it.' };
}

/**
 * How to take back a bulk moderation action. Approve, hide and remove all go back to the review queue ("flag");
 * a block adds the item to the blocklist for good, so it has no undo and always asks first.
 */
/**
 * The request body that sends items back to the review queue in ONE request: each item under the hold reason it was waiting under
 * (`reasons`, by id), so the queue still groups them and an approval still names the safety rule it overrides, and one transaction
 * on the server, so a failure leaves nothing half undone. Ids alone, or items without a reason, fall under 'undo'.
 */
export function sendBackBody(items) {
  const ids = []; const reasons = {};
  for (const it of items || []) {
    const obj = it && typeof it === 'object';
    const id = obj ? it.id : it;
    ids.push(id);
    if (obj && it.review_reason) reasons[id] = it.review_reason;
  }
  return { ids, action: 'flag', reason: 'undo', reasons };
}

export function undoPlan(action) {
  if (action === 'approve' || action === 'hide' || action === 'reject') return { undoAction: 'flag', verb: { approve: 'Published', hide: 'Hidden', reject: 'Removed' }[action] };
  return null;
}

/**
 * In the media browser every selected item is in the same library state, so undoing a bulk action means sending the items back
 * to that state: published → approve, review → flag, hidden → hide, removed → reject. Unknown states cannot be undone.
 */
export function undoActionFor(priorState) {
  return { published: 'approve', review: 'flag', hidden: 'hide', removed: 'reject' }[priorState] || null;
}

/** "3 selected · 2 safety · 1 male focus unclear" for the bulk bar. */
export function selectionSummary(items) {
  const n = items.length;
  const kinds = { safety: 0, scope: 0, other: 0 };
  for (const m of items) kinds[holdOf(m.review_reason).kind]++;
  const bits = [`${n} selected`];
  if (kinds.safety) bits.push(`${kinds.safety} safety`);
  if (kinds.scope) bits.push(`${kinds.scope} male focus unclear`);
  return bits.join(' · ');
}

/* ------------------------------------------------------------------ feeds */

/**
 * A feed error in plain words, with the one fix worth offering. `failures` is how many runs in a row failed:
 * a blip deserves a retry, a feed that has failed for weeks deserves a pause.
 * @returns {{kind: string, plain: string, fix: 'retry'|'pause'|'credentials', fixLabel: string}}
 */
export function explainFeedError(error, failures = 0) {
  const e = String(error || '');
  const long = failures >= 10;
  if (/\b401\b|unauthori[sz]ed|bearer|api key|token (was )?(rejected|invalid|expired)|invalid_grant|oauth/i.test(e)) {
    return { kind: 'credentials', plain: 'The login or key for this source was rejected.', fix: 'credentials', fixLabel: 'Check keys' };
  }
  if (/\b404\b|\b410\b|not found|no such|does not exist|doesn.t exist|suspended|deleted|renamed|account.*(gone|removed)/i.test(e)) {
    return { kind: 'gone', plain: 'The account or page looks gone (renamed, deleted or suspended).', fix: 'pause', fixLabel: 'Pause' };
  }
  if (/\b429\b|too many requests|rate.?limit|slow down/i.test(e)) {
    return { kind: 'rate', plain: 'The site is rate-limiting this server.', fix: long ? 'pause' : 'retry', fixLabel: long ? 'Pause' : 'Retry' };
  }
  if (/\b403\b|forbidden|blocked|cloudflare|challenge|captcha|refus/i.test(e)) {
    return { kind: 'blocked', plain: 'The site is refusing this server.', fix: long ? 'pause' : 'retry', fixLabel: long ? 'Pause' : 'Retry' };
  }
  if (/timeout|timed out|etimedout|econn|enotfound|network|socket|\b50[234]\b|unreachable|dns/i.test(e)) {
    return { kind: 'network', plain: 'The site did not answer in time.', fix: long ? 'pause' : 'retry', fixLabel: long ? 'Pause' : 'Retry' };
  }
  if (/parse|xml|json|unexpected token|not well-formed|invalid (feed|response)|malformed/i.test(e)) {
    return { kind: 'format', plain: 'The page came back in a format PRISM could not read.', fix: 'pause', fixLabel: 'Pause' };
  }
  return { kind: 'unknown', plain: e ? 'It failed with an error PRISM does not recognise.' : 'It failed without saying why.', fix: long ? 'pause' : 'retry', fixLabel: long ? 'Pause' : 'Retry' };
}

/** The server-side query for a feeds filter. "paused" is the switched-off feeds, which is where auto-retired ones live. */
export function feedQuery(f) {
  const q = { platform: f.platform || '', kind: f.kind || '', q: f.q || '', page: f.page || 0 };
  if (f.status === 'paused') q.enabled = '0';
  else if (f.status === 'error' || f.status === 'ok' || f.status === 'never') q.status = f.status;
  return q;
}

/** Which one-liner to show above a feed list ("12 failing"): kept here so the wording is tested. */
export function feedStatusLabel(feed) {
  if (!feed.enabled) return 'Paused';
  if (feed.last_status === 'error') return 'Failing';
  if (!feed.last_run_at) return 'Not run yet';
  return 'Healthy';
}

/** Group feeds that are failing for the overview: worst first, at most `limit`, with the remainder counted. */
export function worstFailing(failing, limit = 5) {
  const sorted = [...failing].sort((a, b) => (b.failures || 0) - (a.failures || 0));
  return { shown: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) };
}

/* ------------------------------------------------------------------ overview */

const HOUR = 3600000;

/**
 * Items added in the last 24 hours against the 24 before them, from the hourly buckets the overview already returns.
 * @param {Array<{hour: string, added: number, runs: number, errors: number}>} buckets hour is "YYYY-MM-DDTHH" in UTC.
 */
export function throughput(buckets = [], now = Date.now()) {
  const map = new Map(buckets.map((b) => [b.hour, b]));
  const d = new Date(now); d.setUTCMinutes(0, 0, 0);
  const slots = [];
  for (let i = 47; i >= 0; i--) {
    const t = new Date(d.getTime() - i * HOUR);
    const key = t.toISOString().slice(0, 13);
    const b = map.get(key) || {};
    slots.push({ key, t, added: b.added || 0, runs: b.runs || 0, errors: b.errors || 0 });
  }
  const sum = (a, f) => a.reduce((n, s) => n + s[f], 0);
  const last = slots.slice(24); const prev = slots.slice(0, 24);
  const added24 = sum(last, 'added'); const addedPrev24 = sum(prev, 'added');
  const peak = last.reduce((p, s) => (s.added > p.added ? s : p), { added: 0, key: null });
  let trend = 'same';
  if (added24 > addedPrev24) trend = 'up'; else if (added24 < addedPrev24) trend = 'down';
  return {
    slots, added24, addedPrev24, runs24: sum(last, 'runs'), errors24: sum(last, 'errors'),
    peak: peak.added ? { key: peak.key, added: peak.added } : null,
    trend, deltaPct: addedPrev24 ? Math.round(((added24 - addedPrev24) / addedPrev24) * 100) : null,
  };
}

/** "↑ 12% on the day before", "↓ 40% on the day before", "same as the day before", "nothing the day before". */
export function trendText(t) {
  if (t.addedPrev24 === 0) return t.added24 ? 'nothing the day before' : 'nothing yet';
  if (t.trend === 'same') return 'same as the day before';
  return `${t.trend === 'up' ? '↑' : '↓'} ${Math.abs(t.deltaPct)}% on the day before`;
}

/**
 * Per-source yield from the overview's daily rows: today against the day before.
 * `quiet` is a source that added nothing today but did add something across the previous 14 days.
 * @param {Array<{day: string, platform: string, n: number}>} rows day is YYYY-MM-DD UTC.
 */
export function sourceYield(rows = [], now = Date.now()) {
  const day = (offset) => {
    const d = new Date(now);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset)).toISOString().slice(0, 10);
  };
  const today = day(0);
  const yesterday = day(1);
  const map = new Map();
  for (const r of rows || []) {
    if (!r || !r.platform || !r.day) continue;
    const row = map.get(r.platform) || { platform: r.platform, today: 0, yesterday: 0, earlier: 0 };
    const n = Number(r.n) || 0;
    if (r.day === today) row.today += n;
    else if (r.day === yesterday) row.yesterday += n;
    else row.earlier += n;
    map.set(r.platform, row);
  }
  return [...map.values()]
    .map((r) => ({ platform: r.platform, today: r.today, yesterday: r.yesterday, quiet: r.today === 0 && (r.yesterday > 0 || r.earlier > 0) }))
    .sort((a, b) => Number(b.quiet) - Number(a.quiet) || b.today - a.today || a.platform.localeCompare(b.platform));
}

/**
 * The rows of "Needs attention": only queues with something in them, worst first.
 * Reports about minors come before everything, then ingestion that is broken, then work waiting for a decision.
 * @returns {Array<{key: string, n: number, tone: 'bad'|'warn'|'info', title: string, sub: string, to: string, query?: object}>}
 */
export function attentionItems(o, { retired = 0 } = {}) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const rows = [
    { key: 'reports', n: n(o.queues && o.queues.reports), tone: 'bad', title: 'Open reports', sub: 'takedowns and safety reports from viewers', to: 'reports' },
    { key: 'failing', n: n(o.feeds && o.feeds.failing), tone: 'bad', title: 'Failing feeds', sub: 'repeated errors or a resting source', to: 'feeds', query: { status: 'error' } },
    { key: 'review', n: n(o.queues && o.queues.review), tone: 'warn', title: 'Waiting for review', sub: 'held back by the gate, not public yet', to: 'moderation' },
    { key: 'retired', n: n(retired), tone: 'info', title: 'Paused by the app', sub: 'feeds that stopped working, one tap to turn back on', to: 'feeds', query: { status: 'paused' } },
    { key: 'identities', n: n(o.identity && o.identity.pending), tone: 'info', title: 'Same person?', sub: 'two creators that may be one man', to: 'identities' },
    { key: 'discovery', n: n(o.discovery && o.discovery.pending), tone: 'info', title: 'New creators found', sub: 'scored leads you have not followed', to: 'discovery' },
  ];
  return rows.filter((r) => r.n > 0);
}

/** One plain line about the body filter, for the overview and the settings card. */
export function physiqueLine(p) {
  if (!p) return '';
  if (!p.enabled) return 'Body filter is off: every picture is shown.';
  return `Hiding pictures scoring ${p.threshold}+ of 100 · ${p.hidden} pictures and ${p.creatorsHidden} creators hidden so far.`;
}
