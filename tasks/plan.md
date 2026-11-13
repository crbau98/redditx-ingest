# PRISM v4.20.0 Multi-Wave Upgrade Plan (2026-11-13)

## Live Production Baseline (`v4.19.0` deployed at `2026-11-13T13:03:36Z`)
- **Published Media:** `1,061,163` (`total`: `1,073,331`, `review`: `10,794`)
- **Creators:** `10,748` (`active`: `10,187`)
- **Feeds:** `17,324` (`enabled`: `10,047`)
- **Memory & Disk:** `3,157 MB` RSS, `1,042 MB` heap, `17%` disk (`75.9 GB` free)

---

## Wave 6 (`Blueprint` + `Forge`): Scheduler Resilience & 1.07M-Row Sweep Optimization
### 6.1 Engine Watchdog & Scheduler Self-Healing (`src/engine/engine.js`)
- **Root Cause Found:** When a feed run exceeds `RUN_HARD_MS` (15 minutes) or when `tick()`'s watchdog (`repo.runs.timeoutStale(RUN_HARD_MS)`) marks stale DB runs as `'error'`:
  1. `hardStop` in `runFeed` calls `finish('error')` which deletes `feed.id` from `state.running`, **but does NOT trigger `setImmediate(tick)`** (because the promise `.finally()` in `tick()` is still waiting on the hung promise!). If all `maxConcurrentFeeds` slots timed out via `hardStop` without their promises settling, nothing called `tick()` until the 30s interval timer—or if `state.ticking` ever threw synchronously or a feed hung in `state.running` past `RUN_HARD_MS`, `state.running` was not reconciled against `RUN_HARD_MS` inside `tick()`.
  2. Add a belt-and-suspenders `state.running` watchdog inside `tick()` that evicts any in-memory `state.running` entry older than `RUN_HARD_MS + 10_000` (calling `entry.forceFinish?.()` or cleaning up `state.running`), and ensure `hardStop` triggers `setImmediate(tick)`.

### 6.2 Eliminate 1.07M-Row Event-Loop Stalls in `maintenance.js`, `discovery/social.js`, and `server.js`
- **`retireDeadFeeds()` in `src/engine/maintenance.js:531`:** Currently runs inside `startImageSweep()`'s 60-second `setInterval` **before** any `blockwatch.around(...)` wrapper! `sourcehealth.retireDead()` runs a `JOIN feed_runs` + `GROUP BY f.id` query over 30 days of runs (~50,000+ rows), causing the `1,670–2,976 ms during idle` event-loop stalls in production logs.
  - Wrap `retireDeadFeeds()` in `blockwatch.around('retireDeadFeeds', ...)` and optimize `sourcehealth.report()` when called from `retireDead()` so it ONLY runs the `dead` query (skipping `failing`, `stale`, `top`, `disabledRows`, `reviewQueue`, and `runCauses`, which are not used by `retireDead()`!).
- **`hashSweep` & `imageSweep` in `src/engine/maintenance.js`:**
  - Change `imageSweep` (`line 108`) and `physiqueSweep` (`line 149`) from `setImmediate` to `setTimeout(res2, 0)` between items so pending HTTP/health probes are serviced between model checks, matching `hashSweep`.
  - In `src/engine/discovery/social.js` (`imageKeywordDiscovery`), move `await dedupe.loadChunked()` **outside** the `for (const hit of rows)` loop and yield with `setTimeout(r, 0)` every 5 items so a 40-image discovery pass never holds the event loop for 1.67 seconds.
- **Label all remaining background timers (`src/engine/engine.js` `hotTimer` `runs.prune`, `src/services/telegram-sync.js`, `src/engine/push.js`):** Wrap periodic SQLite work in `blockwatch.around(...)` so no background timer ever hides behind `"during idle"`.

---

## Wave 7 (`Halyard` + `Forge`): Source Adapter & Search Resilience
### 7.1 `boyfriendtv` 150s Timeout Fix (`src/sources/boyfriendtv.js`)
- **Root Cause Found:** `DEFAULT_PER_RUN = 40` in `src/sources/boyfriendtv.js:44`. Each video requires 2 sequential requests (`videoPage` + `embed`), i.e., `80` requests spaced by `forPlatform('boyfriendtv', 1200)` (`80 * 1.2s = 96s` minimum spacing + network latency = `> 150s`), guaranteed to hit `RUN_TIMEOUT_MS = 150_000`!
- **Fix:** Lower `DEFAULT_PER_RUN` from `40` to `18` (at most 36 HTTP requests per run, completing comfortably in ~45–60s while still hitting the 200/day cap across scheduled runs) AND add a soft per-run time budget (`const runDeadline = Date.now() + 95_000`) inside `fetchFeed()` so `boyfriendtv` saves its sitemap cursor and returns cleanly before the 150s hard timeout ever fires!

### 7.2 Non-Fediverse / Non-PeerTube Host Guards (`src/lib/deadhosts.js` & `src/lib/links.js`)
- **Root Cause Found:** Deep search and link extraction matched `user@host` patterns or URLs on `fanhub.com`, `theb.co` (as Mastodon) and `xxxerome.com`, `onlyfaphouse.com` (as PeerTube). None of those 4 domains are Mastodon or PeerTube instances (`fanhub.com` and `theb.co` return HTML `Invalid JSON`, while `xxxerome.com` and `onlyfaphouse.com` return `429`).
- **Fix:** Add `fanhub.com` and `theb.co` to `WRONG_PLATFORM` for `mastodon`/`misskey`, and `xxxerome.com` and `onlyfaphouse.com` to `WRONG_PLATFORM` for `peertube` in `src/lib/deadhosts.js` (and prevent `src/lib/links.js` / `deepsearch` from treating non-PeerTube tube sites as PeerTube instances).
- Also clean up the live production failing feeds via Admin API (`tumblr/namelessennes`, `tumblr/juicetrump2`, `mastodon/itapapixxl@fanhub.com`, `mastodon/dukelondonxig@theb.co`, `peertube/onlyfans@xxxerome.com`, `peertube/onlyfans@onlyfaphouse.com`, `rss/https://arekore.co/feed`, `web/https://vk.com/video862117019_456245284`).

### 7.3 SearXNG Incoherent Results Resilience (`src/lib/websearch.js`)
- **Root Cause Found:** In `src/lib/websearch.js:419-427`, when SearXNG is the only configured/un-cooled provider in `keylessTier` and returns noisy multi-engine results that fail `coherent(a.results, q)` (which requires `>= 25%` of all returned results to contain query tokens), the entire `a.results` array is dropped and `websearch.search()` throws `web search: incoherent results from searxng` (`502`), even when 2–4 results in the SearXNG response *did* match the query!
- **Fix:** In `keylessTier` (`src/lib/websearch.js`), if a provider (`searxng`) fails whole-set `coherent(a.results, q)`, filter its results to the individual items that match `coherent([r], q, { minShare: 1 })` if at least 1 result matches (for `searxng`, which aggregates multiple engines where one engine may return noise while another returns exact hits), while still rejecting Bing decoy pages when 0 items match or when Bing is returning bot-mitigation decoys.

---

## Wave 8 (`Blueprint` + `Forge`): Route & Engine Modularization
- Split `src/routes/admin.js` (699 lines) and `src/routes/public.js` (691 lines) or `src/engine/maintenance.js` (613 lines) into focused sub-modules while keeping all existing exports and route mounts 100% backward-compatible.

---

## Wave 9 (`Velocity` + `Pixel`): Explicit Match Provenance in `lookup.js` & `#/find` UI Polish
- **`src/engine/lookup.js` → `public/js/views/find.js`:**
  - Populate explicit `provenance: string[]` (`['exact']`, `['backlink']`, `['alias']`, `['directory']`, `['web']`) on each candidate returned by `src/engine/lookup.js` (including `'alias'` when a candidate matched a creator's known alias or secondary handle variant, and `'backlink'` when expanded from bio/link-in-bio or grouped via `sameAs`), so `#/find`'s `provenanceRow(c)` displays rich, accurate provenance pills on both `possibleCard` and `memberRow` inside `groupCard`.
  - Add `provenanceRow(c)` to `memberRow(c)` in `public/js/views/find.js` so grouped accounts also show why each account was found/linked.

---

## Wave 10 (`Crucible`): Pre-Release Verification, Adversarial Gate & Push `v4.20.0` to `main`
- Full unit + integration + contract test suite, adversarial probing of all Wave 6–9 changes, version bump to `v4.20.0`, and `git push origin main`.
