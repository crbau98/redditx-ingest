# PRISM

**Creator-centric adult media discovery.** PRISM follows male creators across the open web — Reddit, RedGIFs, Bluesky, Mastodon, Misskey/Sharkey, Lemmy, X, Telegram, RSS/Atom feeds, personal sites and link-in-bio pages — and presents their photos and videos in one fast, searchable, mobile-first app, with a safety gate, a takedown flow and an admin console.

> Adults only (18+). The server enforces an age gate on every content endpoint.

---

## What's new in v4

| | v3 | v4 |
|---|---|---|
| **Model** | Source-centric (hard-coded subreddits & queries) | **Creator-centric**: follow a *person* once, PRISM follows all of their public accounts |
| **Sources** | Reddit, X, RedGIFs (+ brittle DDG scraping) | Reddit, RedGIFs, Bluesky, Mastodon, Lemmy, X, **RSS/Atom/JSON Feed**, web pages, link-in-bio crawler |
| **Reliability** | One-shot scans | Scheduler, per-feed intervals, exponential backoff, per-platform **circuit breakers**, politeness limiter, Reddit transport ladder (OAuth → JSON → old → RSS → archive) |
| **Discovery** | Manual | Communities → creators auto-followed after N posts → bios & link-in-bio pages reveal their other accounts |
| **Safety** | None | Minor-safety gate on every item, creator profile check, report/takedown flow, permanent blocklist, retroactive library sweep |
| **Security** | Open admin by default, string-matched SSRF filter, client-side age gate | Admin fails closed, DNS-validated SSRF guard, server-side age gate, strict CSP, no `innerHTML` |
| **Media** | Silent video, no seeking | HTTP **Range** (seeking), **HLS** with audio, on-disk image cache, hover/in-view previews |
| **Data** | Ingest time only, `LIKE` search, galleries truncated | Original post time, **FTS5** search, every gallery image, creators with cross-platform links, versioned migrations |
| **UI** | Basic grid | New design system (dark/light), discover home, filters, creator profiles, immersive viewer, saved & following, full admin console |
| **Discovery** (v4.1) | Search box | Autocomplete (creators · tags · communities), Browse page, *Similar creators*, a *From creators you follow* rail and Following filter |
| **Operations** (v4.1) | – | Nightly SQLite backups with retention, config export/import, audit log, duplicate-creator review, installable offline shell (PWA) |
| **Watching** (v4.2) | Grid only | **Reels** — full-screen vertical swipe feed (keyboard, double-tap to save, one live decoder at a time), *Play as Reels* from any search, profile or smart feed |
| **Personal library** (v4.2) | Saved list | **Collections** (named boards), **smart feeds** (saved searches with “N new since last visit”), **history** with *Hide seen*, one-file library export/import |
| **Navigation** (v4.2) | Search box | **Command palette** (Ctrl/⌘ K), `g`-prefixed jumps, `x` = Surprise me, global `?` help |
| **Insight** (v4.2) | – | Creator **activity heatmap**, source split and usual posting hours; **Rising this week** rail; admin ingest-per-day chart by source |
| **Auto-discovery** (v4.3) | Communities only | A **discovery engine** that finds creators you don't follow yet — who your creators **mention** and **follow** (Bluesky graph), **Brave web search** on rotating topics, and **identity search** that finds a known creator's other accounts — scores every lead, follows strong male-focused ones automatically and queues the rest in **Admin → Discovery** |
| **Personal** (v4.3) | – | **For you**: a taste model learned on the device (views, saves, collections, follows) drives a For you rail, Explore sort and Reels mode; first-visit **interest picker**; Display sheet with **accent colours**, theme, density, previews |
| **Efficiency** (v4.3) | Fixed intervals | **Adaptive scheduling** (busy feeds checked sooner, quiet ones later), X API **monthly read budget** with keyless fallback, Brave daily budget, count-free paging, new indexes |
| **Look & feel** (v4.4) | Flat | **Live WebGL "prism light" hero** (hand-written shader, accent-coloured, adapts to the GPU), a **3D orbit** of trending media (drag to spin), **ambient glow** behind the viewer, the viewer **zooming out of the card** you tapped, **3D tilt + glare** on cards, even rails with arrows and fading edges, scroll-driven reveals, heart bursts, a floating glass tab bar on phones — see [`UI_CHANGELOG.md`](UI_CHANGELOG.md) |
| **Sources** (v4.2) | – | **Misskey/Sharkey/Firefish** adapter (+ auto-detection behind Mastodon-looking links), **Bluesky custom feeds & lists**, **OPML import** from any feed reader |

---

## Quick start

```bash
npm install
cp .env.example .env        # optional
npm start                   # http://localhost:3141
```

First run seeds ~28 curated default feeds and migrates any v3 database in place. Open **Admin** (gear icon, or `#/admin`) → **Sync everything now**.

### Preview the UI offline (no network, no real content)

```bash
DEMO_ART=1 DB_PATH=./data/demo.db node scripts/seed-demo.js     # procedurally generated placeholder art
DEMO_ART=1 DB_PATH=./data/demo.db ADMIN_KEY=dev node server.js
```

### Tests

```bash
npm test      # 164 tests: safety, SSRF, migration from a real v3 DB, adapters, engine resilience, HTTP API, proxy
```

---

## Concepts

- **Feed** – anything PRISM keeps in sync: a subreddit, a hashtag, a search, an RSS URL, or one creator's account. Each has its own interval, health, cursor and backoff.
- **Creator** – a person. Owns many feeds (accounts) and many media. External links (OnlyFans, Throne…) are kept for display.
- **Trusted feed** – an admin-vouched male-focused source. Trusted feeds only drop clearly female-tagged posts; untrusted ones (open searches/hashtags) need a positive male signal or go to the review queue.

### Adding people (the recommended way)

Admin → **Creators → Add creator**, paste any of their public links, one per line:

```
https://x.com/name
https://bsky.app/profile/name.bsky.social
u/name
https://www.redgifs.com/users/name
https://linktr.ee/name          ← crawled for more accounts
https://onlyfans.com/name       ← shown on their profile, never scraped
@name@misskey.io                ← Misskey-family servers get their own adapter
```

PRISM follows every public account, keeps their media on one profile, and reads their bios/link pages to find more accounts.

### How "all creators across the web" actually works

No system can enumerate "the whole web". PRISM grows its coverage in layers:

1. **Communities, hashtags and searches** surface creators; a creator who posts ≥ N times (default 2) is auto-followed on that platform.
2. **Bios and link-in-bio pages** expose a creator's accounts elsewhere, which are followed too (Telegram descriptions are read in full with a bot token).
3. **Discovery** (Admin → Discovery, runs hourly) looks *beyond* what is already followed and scores every lead on independent signals:

   | Signal | Where it comes from | Points |
   |---|---|---|
   | same name | Brave search for a known creator's exact handle finds another account (→ attached to that creator) | 6 |
   | mentioned | a followed creator @-mentions or links the account (collabs, shout-outs) — per distinct creator, max 5 | 3 |
   | followed by | followed Bluesky creators follow the account — per distinct creator, max 8 | 1.5 |
   | web search | a rotating Brave search topic (editable) returns the profile — max 3 | 2 |
   | bio | male-focused name/bio +2 · female-focused −20 · any minor-safety hit rejects permanently, borderline wording waits for a human | |

   At the auto-follow score (default 8) a male-focused lead is followed automatically (capped per run and by the feed cap); everything else waits in the queue with its reasons, where one click follows, rejects or blocks it. Communities are never auto-followed.
4. Anything with an **RSS/Atom feed** (or an OPML list) can be followed directly — the most stable path.

---

## Sources

| Source | Kinds | Needs | Notes |
|---|---|---|---|
| Reddit | community, user | – (optional `REDDIT_CLIENT_ID/SECRET`) | Falls back OAuth → www JSON → old.reddit → RSS → Arctic Shift archive. Galleries, video (+HLS), GIF→MP4, crossposts, RedGIFs links resolved. |
| RedGIFs | user, search, niche | – | Public guest-token API. |
| Bluesky | user, search, feedgen, list | search: `BSKY_IDENTIFIER` + `BSKY_APP_PASSWORD` | Media-only author feeds; video via HLS. Paste a custom feed (`bsky.app/profile/…/feed/…`) or list (`…/lists/…`) link to follow a curated stream; its posters become creators like any community. |
| Mastodon | user, tag | – (optional token) | Any Mastodon-compatible server; some require sign-in for public timelines. If a server turns out to run Misskey-family software (detected via NodeInfo), the feed is read through the Misskey API automatically. |
| Misskey | user, tag | – | Misskey, Sharkey, Firefish, Iceshrimp, Catodon… Hashtags are searched on `MISSKEY_INSTANCES` (default `misskey.io`) or `tag@instance`. Paste `@name@host`, a `https://host/@name` link, or `misskey:name@host`. |
| Lemmy | community, user | – | API v3 with v4 fallback. |
| X | user, search | `X_BEARER_TOKEN` (search); users work keyless best-effort | Official API when a token is present. |
| Telegram | user (public channel) | – | Public web preview (`t.me/s/<channel>`); channels that disable it report an error. |
| RSS / Atom / JSON Feed | feed | – | Creator sites, Tumblr `/rss`, Mastodon `.rss`, Bluesky `/rss`, … Bulk import accepts **OPML** exported from any feed reader. |
| Web page | page | – | OpenGraph, `<video>`, linked images; honours `robots.txt`. |
| Link-in-bio | page | – | Discovers a creator's other accounts; never yields media itself. |

**Deliberately not supported:** paywalled/subscription platforms (OnlyFans, Fansly, Patreon…). Reading them means circumventing access control and republishing paid content. PRISM keeps those links on a creator's profile so fans can support them directly.

---

## Safety & takedowns

- **Safety gate** (`src/lib/safety.js`) runs on every item (title, tags, community, handle, bio, alt text): explicit minor terms and any stated age under 18 (`16yo`, `I'm 15`, `[M17]`, "sixteen"…) are **dropped, never stored**; borderline wording (`teen`, `high school`…) goes to the **review queue**. It errs on the side of dropping. A creator whose bio indicates a minor is blocked immediately, and their other accounts are never followed.
- **Report button** on every item and creator, plus a footer takedown form (works without the age gate). Reports about minors or consent **hide the item instantly**; admins then remove-and-blocklist, block the creator, restore, or dismiss.
- **Blocklist**: removed media, blocked creators and takedowns are remembered by content hash, source key and account — they are never re-imported.
- **Sweep**: Admin → Settings re-applies today's rules to everything already stored; it also runs automatically once after upgrades (so content ingested by v3, which had no gate, is checked retroactively).
- Saved lists re-validate against the server, so a takedown also disappears from people's saved items.

---

## Using PRISM

- **Reels** (`#/reels`): one item at a time, full screen. Swipe or use ↑/↓ (J/K), Space to pause, M for sound, F to save, C to collect, Enter for details, double-tap to save. Filters: videos/all/photos and trending/shuffle/newest/top; every Explore search, smart feed, profile and the Following list has a *Play as Reels* button.
- **Collections**: press C (or the bookmark) in the viewer or Reels to file anything into named boards; *Your library → Collections* shows covers and plays a board start to finish.
- **Smart feeds**: in Explore, *Save as feed* stores the exact filter set. Home shows each one with how many items arrived since you last opened it.
- **History & Hide seen**: everything opened in the viewer or Reels is remembered on the device (pause or clear it any time); *Hide seen* filters it out of Explore and Reels.
- **For you**: on first visit pick a few interests; after that PRISM learns from what you open, save, collect and follow (on the device — the server only ever sees a short list of top tags/creators in the request). The rail on Home shows what it is tuned to; remove a tag or reset any time. Also available as an Explore sort and as Reels' default mode.
- **Graphics adapt to the device**: the hero shader steps its resolution down when frames come in slow and holds a still frame on software rendering (VMs, blocklisted GPUs), where the 3D orbit also stops turning on its own and costly blur effects are trimmed. Reduced-motion settings turn every animation into a static equivalent.
- **Display** (palette icon): theme, six accent colours, grid density, video previews, sound, hide-seen, and pausing history/learning.
- **Command palette**: Ctrl/⌘ K jumps to any page, creator, tag, community, collection or smart feed, and runs actions (theme, shuffle, surprise me). `g h/e/r/c/s` jump to Home/Explore/Reels/Creators/Saved; `x` opens something random; `?` lists every shortcut.
- Everything personal (saved, collections, smart feeds, follows, history) stays in the browser; *Your library → Export* writes it to one file that *Import* merges back on any device.

## Admin console (`#/admin`)

Overview (health, activity, **ingest per day by source**, queues) · **Discovery** (lead queue with scores and reasons, bulk follow/reject/block, tuning, search topics, key status) · Feeds (schedule, status, run-now, bulk import) · Creators (add, merge, block, **possible-duplicate review**) · Review queue · Reports · Media (bulk moderation) · Sources (config & breaker state) · Live log (SSE) · Blocklist · **Audit log** · Settings (**backups, config export/import**, maintenance).

Set `ADMIN_KEY`. **Without it the admin is disabled in production** (open only in development, or with `ADMIN_OPEN=true`).

---

## Operations

- **Backups**: a consistent copy of the database (`VACUUM INTO`, safe while serving) is written nightly to `<db dir>/backups/` and the newest *N* are kept (Admin → Settings; on by default in production). *Back up now* is one click. Put the volume under your host's own snapshots too.
- **Config export / import**: creators, feeds and the blocklist as JSON — no media, no secrets. Import is additive and idempotent (people are matched by their accounts, then by handle) and re-applies the safety gate.
- **Audit log**: every moderation decision — manual or automatic — with actor, target and reason.
- **Offline shell**: the app installs as a PWA and opens offline. The service worker caches only its own static files; API responses and media are never cached.
- **Retroactive safety**: raising the safety rules bumps a sweep version, so existing libraries are re-checked once on the next boot.

## Configuration

See [`.env.example`](.env.example) for every variable. Runtime behaviour (concurrency, scope strictness, auto-follow, retention…) lives in **Admin → Settings**.

## Deploy (Railway / Docker)

1. Push to GitHub, create a Railway service from the repo (uses the `Dockerfile`).
2. Add a persistent volume at `/data`.
3. Set `ADMIN_KEY` (required) and optionally the source credentials — `X_BEARER_TOKEN`, `BRAVE_API_KEY` (discovery), `TELEGRAM_API_KEY` (a @BotFather bot token), `REDDIT_CLIENT_ID/SECRET`, `BSKY_IDENTIFIER/APP_PASSWORD`. The boot log prints which keys are active. `DB_PATH=/data/prism.db` is the image default.
4. Deploy. Health check: `/api/health`. The scheduler starts automatically in production.

Upgrading from v3 is automatic: the database is migrated in place on first boot (media, creators, accounts, tags and moderation history preserved; media re-hashed so new imports dedupe against old ones).

## Architecture

```
server.js                 bootstrap (listen, engine, graceful shutdown)
src/app.js                Express app: CSP, rate limits, age gate, routes
src/config.js             all environment parsing
src/db/                   schema.js (versioned migrations, FTS5) · repo.js (all SQL)
src/lib/                  net (SSRF-safe client) · safety · scope · links · mediaurl · limiter · media-cache · brave · telegram-bot
src/sources/              adapters: reddit redgifs bluesky mastodon misskey lemmy x telegram rss web(+linkinbio)
src/engine/               engine (scheduler/runs, adaptive tempo) · pipeline (per-item gates) · discovery · breaker · probe · creators · maintenance · backup · events (SSE)
src/routes/               public · admin · proxy (media + HLS)
src/services/targets.js   add creators / feeds from pasted links
public/                   vanilla ES modules, no build step (css/, js/, js/views/admin/, vendor/hls)
tests/                    node:test suites + fixtures
```

Adding a source = one file in `src/sources/` implementing `{ platform, kinds, isConfigured, fetch(feed, ctx) }` and one line in `src/sources/index.js`.

## API (public)

`GET /api/media` (`q, type, platform, community, creator, creators, tag, sort=recent|trending|top|random|oldest|relevance, since, after=<ISO time ingested>, page, limit, ids`) · `GET /api/media/:id` · `/related` · `POST /api/media/:id/like|view` · `GET /api/discover` · `GET /api/creators` · `/creators/:id` · `/creators/:id/media` · `GET /api/suggest?q=` · `GET /api/creators/:id/similar` · `GET /api/creators/:id/activity` · `GET /api/recommend` (`tags, creators, platforms, video, type, exclude, seed, page, limit`) · `GET /api/tags|communities|platforms|stats` · `POST /api/report` · `GET /api/proxy?url=` (Range supported) · `GET /api/hls?url=` · `GET /api/stream` (SSE) · `GET /api/health` · `GET /api/meta`.
Content endpoints require the age cookie from `POST /api/age/confirm`. Admin endpoints live under `/api/admin/*` and require `x-admin-key` (or `Authorization: Bearer`).

---

## Verification status (please read)

- **Tested:** 164 automated tests, including a migration from a real v3 schema, SSRF defences, safety rules, the engine's retry/backoff/breaker behaviour, the HTTP API and the media/HLS proxy. The UI was exercised in a real browser (desktop and phone-sized viewports, dark and light themes), including the viewer with keyboard navigation and deep links, WebM video playback, the age gate, creator add flow, and every admin tab. v4.2's Reels, collections, smart feeds, history/hide-seen, command palette, keyboard shortcuts, creator activity and admin charts were exercised end-to-end in Chromium (39 scripted checks, desktop and phone-sized, no console errors), and the v4.1 browser checks were re-run without regressions. v4.4's hero shader, 3D orbit (auto-turn, hover pause, drag, tap-to-open), ambient viewer, card-to-viewer zoom, tilt/glare, rails, heart bursts, reduced-motion and software-rendering fallbacks and the phone tab bar have 26 browser checks of their own. v4.3's interest picker, For you (Home, Explore, Reels), Display/accent settings, Seen markers, Reels hint and the admin Discovery page were checked the same way (32 checks), with the v4.1 and v4.2 suites re-run clean. The discovery engine, Brave/Telegram/X clients, budgets and recommendations are covered by mock-server tests. Touch-swipe gestures and HLS playback (hls.js) were not exercised in a browser.
- **Not verified live:** the adapters' *network* behaviour. The development sandbox blocked outbound access to Reddit, RedGIFs, Bluesky, Mastodon, Misskey, Lemmy, Telegram and X, so each adapter was built against the platforms' documented response shapes and tested with fixtures and local mock servers — not against the live services. Expect to tune small details (field names, rate limits, headers) on first real run. The same applies to v4.3's Brave Search, Telegram Bot API and X API v2 calls and to the Bluesky follow-graph reads: they follow the documented APIs and are exercised against mock servers, not the live services. The **Admin → Live log**, per-feed error text and **Admin → Discovery** (last run summary, key status) show exactly what each source returned. The keyless X route and unauthenticated Mastodon/Bluesky access depend on those services' current policies, which change.
