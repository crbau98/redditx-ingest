#!/usr/bin/env node
'use strict';
/**
 * Read pages in a real browser (Browser4) and ingest what they hold - the demo and the bulk tool.
 *
 *   node scripts/browser4-ingest.js [options] <url> [<url> ...]
 *
 *   --headed           show the browser window (needs a display; without one Browser4 itself runs headless)
 *   --expand           also add each page's same-site links as feeds and read those too
 *   --depth N          with --expand: 1 = the page's links (default), 2 = the links of those pages as well
 *   --limit N          with --expand: most feeds one page may add (default 25, max 100)
 *   --mode M           browser4Mode for this database: off | fallback | always (stored; default: leave as is)
 *   --scrolls N        scrolls to the bottom per page (stored as the browser4Scrolls setting)
 *   --pages N          "next page" links followed per page (stored as the browser4Pages setting)
 *   --db PATH          database to ingest into (default: DB_PATH or ./data/prism.db - the real library)
 *   --trusted          treat the starting pages as trusted (an admin vouches they are male-focused)
 *   --json             machine-readable report
 *
 * Everything goes through the same engine and the same gates as a scheduled run (robots.txt, opt-outs, takedowns, the
 * safety / male-only / picture filters, duplicates). Browser4 only changes HOW the page is read.
 * Needs: npm i -g browser4-cli && browser4-cli install, plus Chrome or Chromium on this machine.
 */
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const VALUE_OPTS = new Set(['depth', 'limit', 'mode', 'scrolls', 'pages', 'db']);
const urls = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && VALUE_OPTS.has(argv[i - 1].slice(2))));

if (!urls.length || flag('help')) {
  const src = require('fs').readFileSync(__filename, 'utf8').split('\n');
  console.log(src.slice(src.indexOf('/**') + 1, src.indexOf(' */')).map((l) => l.replace(/^ ?\* ?/, '')).join('\n'));
  process.exit(urls.length ? 0 : 1);
}

// Set before any module reads the config.
process.env.BROWSER4_ENABLED = '1';
if (flag('headed')) process.env.BROWSER4_HEADED = '1';
if (opt('db')) process.env.DB_PATH = require('path').resolve(opt('db'));
process.env.SCHEDULER_ENABLED = 'false';

const config = require('../src/config');
const registry = require('../src/sources');
const repo = require('../src/db/repo');
const settingsStore = require('../src/settings');
const engine = require('../src/engine/engine');
const expand = require('../src/engine/expand');
const browser4 = require('../src/lib/browser4');

const json = flag('json');
const say = (...a) => { if (!json) console.log(...a); };

(async () => {
  const avail = await browser4.available({ force: true });
  if (!avail.ok) {
    console.error(`Browser4 is not usable: ${avail.reason}\nInstall it with:  npm i -g browser4-cli && browser4-cli install   (needs Chrome or Chromium on this machine)`);
    process.exit(2);
  }
  say(`Browser4 ${avail.version} · ${config.browser4.headed ? 'headed (visible window)' : 'headless'} · session "${config.browser4.session}" · database ${config.dbPath}`);

  const patch = {};
  if (opt('mode')) patch.browser4Mode = opt('mode');
  if (opt('scrolls')) patch.browser4Scrolls = opt('scrolls');
  if (opt('pages')) patch.browser4Pages = opt('pages');
  if (Object.keys(patch).length) { const s = settingsStore.update(patch); say(`Settings stored: ${Object.keys(patch).map((k) => `${k}=${s[k]}`).join(', ')}`); }
  const cfg = settingsStore.get();
  if (cfg.browser4Mode === 'off') say('Note: browser4Mode is "off" in this database, so pages are read by plain download only. Use --mode fallback|always.');

  const report = { feeds: [], expansions: [], totals: { fetched: 0, added: 0, dupes: 0, skipped: 0, blocked: 0 } };
  const feeds = new Map();
  const addFeed = (f) => { if (f && !feeds.has(f.id)) feeds.set(f.id, f); };

  for (const url of urls) {
    const spec = registry.parseInput(url);
    if (!spec || !spec.ingestable) { say(`✗ ${url}: not a page PRISM can read`); continue; }
    if (flag('expand') && spec.platform === 'web') {
      say(`⇢ expanding ${url} (depth ${opt('depth') || 1}, up to ${opt('limit') || 25} feeds) ...`);
      try {
        const r = await expand.run(url, { depth: opt('depth'), limit: opt('limit'), trustSeed: flag('trusted') });
        report.expansions.push({ seed: r.seed, visited: r.visited.length, created: r.created, skipped: r.skipped, notes: r.notes });
        say(`  read ${r.visited.length} page(s), added ${r.created} feed(s)${r.skipped.policy ? `, ${r.skipped.policy} refused by policy` : ''}${r.notes.length ? `, ${r.notes.length} problem(s)` : ''}`);
        for (const note of r.notes) say(`  ! ${note}`);
        addFeed(repo.feeds.find('web', 'page', r.seed));
        for (const u of r.urls) addFeed(repo.feeds.find('web', 'page', u));
        continue;
      } catch (e) { say(`✗ ${url}: ${e.message}`); continue; }
    }
    const { feed } = repo.feeds.upsert({ platform: spec.platform, kind: spec.kind, target: spec.target, trusted: flag('trusted') ? 1 : 0, origin: 'admin', intervalMin: 720 });
    addFeed(feed);
  }

  say(`\nReading ${feeds.size} feed(s) ...`);
  for (const feed of feeds.values()) {
    const r = await engine.runFeed(feed.id, 'manual', { force: true });
    const row = { target: feed.target, status: r.status, via: r.via || null, fetched: r.fetched || 0, added: r.added || 0, dupes: r.dupes || 0, skipped: r.skipped || 0, blocked: r.blocked || 0, error: r.error || null, why: r.why || null };
    report.feeds.push(row);
    for (const k of Object.keys(report.totals)) report.totals[k] += row[k];
    say(`${row.status === 'ok' || row.status === 'empty' ? '✓' : row.status === 'skipped' ? '–' : '✗'} ${feed.target}\n    ${row.status} via ${row.via || 'n/a'} · fetched ${row.fetched} · +${row.added} new · ${row.dupes} dupes · ${row.skipped} filtered${row.blocked ? ` · ${row.blocked} blocked` : ''}${row.error ? ` · ${row.error}` : ''}`);
  }

  const t = report.totals;
  say(`\nDone: ${t.added} new item(s) from ${report.feeds.length} feed(s) (${t.fetched} fetched, ${t.dupes} already stored, ${t.skipped} filtered, ${t.blocked} blocked).`);
  if (json) console.log(JSON.stringify(report, null, 2));
  await browser4.close();
  say('Browser session closed. The Browser4 backend stays resident; stop it with: browser4-cli stop');
  process.exit(0);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
