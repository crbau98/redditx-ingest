# PRISM

**Creator-centric adult media discovery.** PRISM follows male creators across the open web — Reddit, RedGIFs, Bluesky, Mastodon, Lemmy, X, RSS/Atom feeds, personal sites and link-in-bio pages — and presents their photos and videos in one fast, searchable, mobile-first app, with a safety gate, a takedown flow and an admin console.

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
npm test      # 117 tests: safety, SSRF, migration from a real v3 DB, adapters, engine resilience, HTTP API, proxy
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
```

PRISM follows every public account, keeps their media on one profile, and reads their bios/link pages to find more accounts.

### How "all creators across the web" actually works

No system can enumerate "the whole web". PRISM grows its coverage three ways: **(1)** communities, hashtags and searches surface creators; **(2)** a creator who posts ≥ N times (default 2) is auto-followed on that platform; **(3)** their bio / link-in-bio exposes accounts elsewhere, which are followed too. Anything with an RSS/Atom feed can be followed directly, which is the most stable path.

---

## Sources

| Source | Kinds | Needs | Notes |
|---|---|---|---|
| Reddit | community, user | – (optional `REDDIT_CLIENT_ID/SECRET`) | Falls back OAuth → www JSON → old.reddit → RSS → Arctic Shift archive. Galleries, video (+HLS), GIF→MP4, crossposts, RedGIFs links resolved. |
| RedGIFs | user, search, niche | – | Public guest-token API. |
| Bluesky | user, search | search: `BSKY_IDENTIFIER` + `BSKY_APP_PASSWORD` | Media-only author feeds; video via HLS. |
| Mastodon | user, tag | – (optional token) | Any Mastodon-compatible server; some require sign-in for public timelines. |
| Lemmy | community, user | – | API v3 with v4 fallback. |
| X | user, search | `X_BEARER_TOKEN` (search); users work keyless best-effort | Official API when a token is present. |
| RSS / Atom / JSON Feed | feed | – | Creator sites, Tumblr `/rss`, Mastodon `.rss`, Bluesky `/rss`, … |
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

## Admin console (`#/admin`)

Overview (health, activity, queues) · Feeds (schedule, status, run-now, bulk import) · Creators (add, merge, block) · Review queue · Reports · Media (bulk moderation) · Sources (config & breaker state) · Live log (SSE) · Blocklist · Settings.

Set `ADMIN_KEY`. **Without it the admin is disabled in production** (open only in development, or with `ADMIN_OPEN=true`).

---

## Configuration

See [`.env.example`](.env.example) for every variable. Runtime behaviour (concurrency, scope strictness, auto-follow, retention…) lives in **Admin → Settings**.

## Deploy (Railway / Docker)

1. Push to GitHub, create a Railway service from the repo (uses the `Dockerfile`).
2. Add a persistent volume at `/data`.
3. Set `ADMIN_KEY` (required) and optionally the source credentials. `DB_PATH=/data/prism.db` is the image default.
4. Deploy. Health check: `/api/health`. The scheduler starts automatically in production.

Upgrading from v3 is automatic: the database is migrated in place on first boot (media, creators, accounts, tags and moderation history preserved; media re-hashed so new imports dedupe against old ones).

## Architecture

```
server.js                 bootstrap (listen, engine, graceful shutdown)
src/app.js                Express app: CSP, rate limits, age gate, routes
src/config.js             all environment parsing
src/db/                   schema.js (versioned migrations, FTS5) · repo.js (all SQL)
src/lib/                  net (SSRF-safe client) · safety · scope · links · mediaurl · limiter · media-cache
src/sources/              adapters: reddit redgifs bluesky mastodon lemmy x rss web(+linkinbio)
src/engine/               engine (scheduler/runs) · pipeline (per-item gates) · breaker · probe · creators · maintenance · events (SSE)
src/routes/               public · admin · proxy (media + HLS)
src/services/targets.js   add creators / feeds from pasted links
public/                   vanilla ES modules, no build step (css/, js/, js/views/admin/, vendor/hls)
tests/                    node:test suites + fixtures
```

Adding a source = one file in `src/sources/` implementing `{ platform, kinds, isConfigured, fetch(feed, ctx) }` and one line in `src/sources/index.js`.

## API (public)

`GET /api/media` (`q, type, platform, community, creator, tag, sort=recent|trending|top|random|oldest|relevance, since, page, limit, ids`) · `GET /api/media/:id` · `/related` · `POST /api/media/:id/like|view` · `GET /api/discover` · `GET /api/creators` · `/creators/:id` · `/creators/:id/media` · `GET /api/tags|communities|platforms|stats` · `POST /api/report` · `GET /api/proxy?url=` (Range supported) · `GET /api/hls?url=` · `GET /api/stream` (SSE) · `GET /api/health` · `GET /api/meta`.
Content endpoints require the age cookie from `POST /api/age/confirm`. Admin endpoints live under `/api/admin/*` and require `x-admin-key` (or `Authorization: Bearer`).

---

## Verification status (please read)

- **Tested:** 117 automated tests, including a migration from a real v3 schema, SSRF defences, safety rules, the engine's retry/backoff/breaker behaviour, the HTTP API and the media/HLS proxy. The UI was exercised in a real browser (desktop and phone-sized viewports, dark and light themes), including the viewer with keyboard navigation and deep links, WebM video playback, the age gate, creator add flow, and every admin tab. Touch-swipe gestures and HLS playback (hls.js) were not exercised in a browser.
- **Not verified live:** the adapters' *network* behaviour. The development sandbox blocked outbound access to Reddit, RedGIFs, Bluesky, Mastodon, Lemmy and X, so each adapter was built against the platforms' documented response shapes and tested with fixtures and local mock servers — not against the live services. Expect to tune small details (field names, rate limits, headers) on first real run. The **Admin → Live log** and per-feed error text show exactly what each source returned. The keyless X route and unauthenticated Mastodon/Bluesky access depend on those services' current policies, which change.
