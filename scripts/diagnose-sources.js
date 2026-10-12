#!/usr/bin/env node
'use strict';
/**
 * Source self-test. Run it on the machine that runs PRISM (it needs the network):
 *
 *   node scripts/diagnose-sources.js                       every platform, 1-2 sample feeds each
 *   node scripts/diagnose-sources.js --platform reddit,redgifs
 *   node scripts/diagnose-sources.js --target reddit:community:gaybrosgonewild --limit 10
 *   node scripts/diagnose-sources.js --json                machine-readable
 *
 * It uses the real adapters and the real safety + male-only scope gates, but writes nothing: a throwaway
 * database is used and no item is inserted. Per platform it reports whether the source answered, how many
 * items came back, how many would be published / excluded / blocked, whether the first media URL really
 * loads, and, when something fails, what to do about it. Exit code 1 if a configured platform returned
 * nothing usable.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const optAll = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));

// A throwaway DB, set before any module reads the config. Production data is never touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-diag-'));
process.env.DB_PATH = path.join(tmp, 'diag.db');
process.env.SCHEDULER_ENABLED = 'false';

const registry = require('../src/sources');
const { checkItem } = require('../src/lib/safety');
const { classify } = require('../src/lib/scope');
const { hostOf, hostBlocked, hostTrusted, normalizeMediaUrl } = require('../src/lib/mediaurl');
const { probeMedia } = require('../src/engine/probe');

const LIMIT = parseInt(opt('limit'), 10) || 15;
const TIMEOUT_MS = (parseInt(opt('timeout'), 10) || 60) * 1000;
const wanted = (opt('platform') || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Representative feeds: explicit --target, otherwise 1-2 seeds per platform (different kinds first). */
function plan() {
  const out = [];
  for (const t of optAll('target')) {
    const [platform, kind, ...rest] = t.split(':');
    out.push({ platform, kind, target: rest.join(':'), trusted: kind !== 'search' && kind !== 'tag' });
  }
  if (out.length) return out;
  for (const a of registry.list()) {
    if (wanted.length && !wanted.includes(a.platform)) continue;
    const seeds = registry.SEEDS.filter((s) => s.platform === a.platform);
    const picked = [];
    for (const kind of a.kinds) { const s = seeds.find((x) => x.kind === kind); if (s) picked.push(s); if (picked.length === 2) break; }
    if (!picked.length && seeds.length) picked.push(seeds[0]);
    if (picked.length) picked.forEach((s) => out.push({ platform: a.platform, kind: s.kind, target: s.target, trusted: s.trusted !== false }));
    else out.push({ platform: a.platform, kind: a.kinds[0], target: null, trusted: true });
  }
  return out;
}

function hint(platform, e) {
  const msg = String((e && e.message) || e);
  const st = e && e.status;
  if (platform === 'reddit' && (st === 403 || st === 429 || (/every transport/.test(msg) && !/ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(msg)))) return 'Reddit blocks datacenter IPs. Create a "script" app at reddit.com/prefs/apps and set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET (OAuth is the reliable route).';
  if (platform === 'bluesky' && /BSKY_|app password|auth/i.test(msg)) return 'Bluesky search needs an app password: set BSKY_IDENTIFIER and BSKY_APP_PASSWORD.';
  if (platform === 'x') return 'Set X_BEARER_TOKEN for reliable X reads (keyless mode is best effort).';
  if (platform === 'mastodon' && (st === 401 || st === 403 || st === 422)) return 'This server requires sign-in for public timelines: set MASTODON_ACCESS_TOKEN or change MASTODON_INSTANCES.';
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|Timeout|EBLOCKED|fetch failed/i.test(msg) || st === 0) return 'No network route to this host: check outbound access / egress allow-list.';
  if (st === 404) return 'The target does not exist (or was removed). Try another feed.';
  if (st === 429) return 'Rate limited: wait and retry, or lower the feed frequency.';
  return null;
}

async function withTimeout(promise, ms) {
  let t;
  try { return await Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`timed out after ${ms / 1000}s`), { status: 0 })), ms); })]); }
  finally { clearTimeout(t); }
}

async function check(spec) {
  const adapter = registry.get(spec.platform);
  const row = { platform: spec.platform, kind: spec.kind, target: spec.target, reachable: false, fetched: 0, usable: 0, would: { publish: 0, review: 0, excluded: 0, blocked: 0, skipped: 0 }, skipReasons: {}, probe: null, error: null, hint: null, note: null, ms: 0 };
  if (!adapter) { row.error = 'unknown platform'; return row; }
  if (!spec.target) { row.note = 'no sample target: pass --target platform:kind:target'; row.skipped = true; return row; }
  const conf = adapter.isConfigured(spec.kind);
  if (conf && conf.ok === false) { row.note = `not configured: ${conf.note || conf.reason || 'missing credentials'}`; row.skipped = true; return row; }
  const t0 = Date.now();
  try {
    const feed = { id: 'diag', platform: spec.platform, kind: spec.kind, target: spec.target, trusted: spec.trusted ? 1 : 0, label: spec.target };
    const res = await withTimeout(adapter.fetch(feed, { cursor: {}, limit: LIMIT, aborted: () => false, force: true }), TIMEOUT_MS);
    row.reachable = true;
    row.via = res.via || null;
    const items = (res.items || []).slice(0, LIMIT * 3);
    row.fetched = items.length;
    row.notes = res.notes || undefined;
    let firstOk = null;
    const skip = (why) => { row.would.skipped++; row.skipReasons[why] = (row.skipReasons[why] || 0) + 1; };
    for (const it of items) {
      if (!it.mediaUrl || !/^https?:\/\//i.test(it.mediaUrl)) { skip('no media url'); continue; }
      if (it.mediaType !== 'image' && it.mediaType !== 'video') { skip('unknown type'); continue; }
      row.usable++;
      const safety = checkItem(it);
      if (safety.level === 'block') { row.would.blocked++; continue; }
      const sc = classify([it.title, it.text, it.altText, it.community, it.author, it.authorName, it.authorBio, it.tags, it.labels, it.query], { trusted: !!spec.trusted });
      if (sc.scope === 'excluded') { row.would.excluded++; continue; }
      const host = hostOf(normalizeMediaUrl(it.mediaUrl));
      if (hostBlocked(host)) { skip(`blocked host ${host}`); continue; }
      if (safety.level === 'review' || sc.femaleSoft || sc.scope === 'uncertain') { row.would.review++; continue; }
      row.would.publish++;
      if (!firstOk && !it.resolve && !/redgifs\.com\/(?:watch|ifr)\//i.test(it.mediaUrl)) firstOk = it;
    }
    if (firstOk && !/\.m3u8(\?|$)/i.test(firstOk.mediaUrl)) {
      const p = await probeMedia(firstOk.mediaUrl, firstOk.mediaType);
      row.probe = p.ok ? `loads (${p.contentType || 'media'}${p.bytes ? `, ${p.bytes} B` : ''})` : `FAILED: ${p.reason}${hostTrusted(hostOf(firstOk.mediaUrl)) ? ' (hotlink protection? the app serves media through its proxy with a Referer)' : ''}`;
    } else if (firstOk) row.probe = 'HLS playlist (not probed)';
    if (!row.fetched) row.note = 'reachable but returned no items';
  } catch (e) {
    row.error = String(e.message || e).slice(0, 240);
    row.status = e.status || null;
    row.hint = hint(spec.platform, e);
  }
  row.ms = Date.now() - t0;
  return row;
}

(async () => {
  const ws = require('../src/lib/websearch').status();
  const imagefilter = require('../src/lib/imagefilter');
  const imgReady = await imagefilter.available();
  const imgErr = imagefilter.status().failed;
  const rows = [];
  for (const spec of plan()) {
    if (!flag('json')) process.stderr.write(`· ${spec.platform}:${spec.kind}:${spec.target || '-'} … `);
    const r = await check(spec);
    rows.push(r);
    if (!flag('json')) process.stderr.write(`${r.skipped ? 'skipped' : r.error ? 'ERROR' : `${r.fetched} items`} (${r.ms} ms)\n`);
  }
  const bad = rows.filter((r) => !r.skipped && (r.error || r.would.publish + r.would.review === 0));
  if (flag('json')) console.log(JSON.stringify({ ok: !bad.length, results: rows, webSearch: ws, imageFilter: { ready: imgReady, error: imgErr } }, null, 2));
  else {
    console.log('\nPRISM source self-test\n');
    for (const r of rows) {
      const state = r.skipped ? 'SKIP' : r.error ? 'FAIL' : r.would.publish + r.would.review > 0 ? ' OK ' : 'EMPTY';
      console.log(`[${state}] ${r.platform}:${r.kind}:${r.target || '-'}${r.via ? `  via ${r.via}` : ''}`);
      if (r.error) console.log(`        error: ${r.error}`);
      if (r.hint) console.log(`        fix:   ${r.hint}`);
      if (r.note) console.log(`        note:  ${r.note}`);
      if (!r.skipped && !r.error) {
        console.log(`        ${r.fetched} fetched · ${r.usable} with usable media · would publish ${r.would.publish}, review ${r.would.review}, excluded (not male-only) ${r.would.excluded}, blocked (safety) ${r.would.blocked}, skipped ${r.would.skipped}`);
        const reasons = Object.entries(r.skipReasons).map(([k, v]) => `${k} ×${v}`).join(', ');
        if (reasons) console.log(`        skip reasons: ${reasons}`);
        if (r.probe) console.log(`        first media: ${r.probe}`);
        for (const n of (r.notes || []).slice(0, 3)) console.log(`        note: ${n}`);
      }
    }
    console.log('\nSupporting services');
    console.log(`  web search : ${ws.configured ? ws.providers.filter((p) => p.configured).map((p) => p.name).join(' → ') : 'NOT CONFIGURED (set BRAVE_API_KEY or SEARXNG_URL; discovery and creator lookup need it)'}`);
    console.log(`  image filter: ${imgReady ? 'ready (on-device face + gender model)' : `UNAVAILABLE${imgErr ? ` (${imgErr})` : ''} — run npm install so the optional ML packages are present`}`);
    console.log(`\n${bad.length ? `${bad.length} source(s) need attention.` : 'All checked sources returned usable content.'}`);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
