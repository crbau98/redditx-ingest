# PRISM architecture map

One Node server (`server.js` → `src/app.js`), one SQLite database, one background engine.
Everything else is a module with one job. Start reading in this order.

## Request path

```
browser ──> server.js ──> src/app.js ──> src/routes/public.js   (the app the visitor sees)
                                      └> src/routes/admin.js    (Admin console + every admin API)
```

## The pipeline (how one post becomes a row)

```
src/sources/*  (one adapter per platform: coomer, redgifs, bluesky, x, tumblr, tiktok, youtube,
                pornhub, xhamster, boyfriendtv, reddit, lemmy, mastodon, misskey, peertube, rss,
                telegram, web pages — registry in src/sources/index.js)
      │  raw items
      ▼
src/engine/pipeline.js   THE ordered gates, one place:
      resolve → safety (lib/safety) → blocklist → scope (lib/scope, male-only)
      → physique text check → media checks → dedupe (services/dedupe, pHash)
      → image pass (faces lib/face-match, build score, OCR lib/ocr)
      → creator match → insert (db/repo.js) → tags
      ▼
src/db/repo.js           data access: settings, tags, hosts, blocklist and shared helpers; each domain in src/db/repos/*; schema in src/db/schema.js
      ▼
media / creators / feeds tables ──> src/routes/public.js serves them
```

## Background engine (`src/engine/engine.js` owns the clocks)

| Module | Job |
|---|---|
| `engine.js` | feed scheduler, engine start/stop, health |
| `discovery.js` | finds NEW creators: Coomer index, scout queries, image-keyword search, link hubs (`crawlLinkHubs`), paid-page leads (`services/targets.js`) |
| `deepsearch.js` | whole-web sweep for ONE creator (text/video/image/reverse-image), cooldowns, `rotate()` = universal hourly rotation |
| `lookup.js` | "who is this name?" — resolves a query to accounts/creators |
| `identity.js` | same-man merges: duplicate creator rows, aliases |
| `maintenance.js` | sweeps: physique measure, image sweep, hash sweep, face enrolment, lean-bias backfill, dead feeds, thumbnails; runs sweeps every minute, bounded per tick |
| `backup-worker.js` | trending-score refresh + nightly backup OFF the serving thread |
| `imagematch.js` | same-picture + face matching of search results to creators |
| `blockwatch.js` (lib) | tags event-loop stalls to the job that caused them (`/api/health`) |

## Settings, safety, config

- `src/config.js` reads env. `src/middleware` is request middleware. `src/services` is budgets, store migration, and the other helpers the engine calls. `src/lib` is shared mechanics (disk guard, AI guard, object store).
- `src/settings.js` — every toggle with a plain-language label; groups render in Admin → Settings.
- Safety gates in one pipeline place (above); takedowns `lib/takedowns.js`, robots honoured per fetch tier.
- Reader tiers for refused pages (`src/sources/web.js`): plain HTTP → local Chrome (raw CDP, `lib/chrome.js`) → Jina reader (`lib/jina.js`) → paid unlockers last, never on a paid platform.
- Host policy: all public hosts are ingest candidates now: paid subscription pages, leak / tube-rip / file-locker mirrors and every other public gay creator content source are treated like any other public page. The admin's safety, takedown and male-only scope gates decide what actually publishes downstream.
- Owner decisions with teeth: physique filter OFF (ranking nudge `lib/buildbias.js` instead), leak/mirror hosts in scope when publicly served, Yandex Images on.

## Where to change what

- New platform source → `src/sources/<name>.js` + registry entry; kinds in `adapter.kinds`.
- New ranking behaviour → `db/functions.js` (hot_score and the one HOT_UPDATE statement that `repo.media.recomputeHot*` and `engine/backup-worker.js` both use).
- New toggle → `src/settings.js` (+ its group), consumed via `settingsStore.get()`.
- New gate → `engine/pipeline.js` only, ordered with the others.
- Admin API → `src/routes/admin.js`; public API → `src/routes/public.js`.

## Ops

- Deploys: GitHub `main` → Railway auto-deploy. DB on a Railway volume (`/data`). Disk guard pauses ingestion at 80% (`src/lib/diskguard.js`, on `main` since `33925ba`).
- Reddit and Telegram posts are stored and shown. Their text never goes to a hosted model (`src/lib/aiguard.js`). Migration v30 turns Reddit reads on once outside tests. Kill switches, each already a setting: `redditEnabled`, `faceMatch`, `faceSweepPerMinute` (0 stops the sweep), `deepPullPerHour` (0 stops the rotation). Physique (`src/lib/physique.js`, `src/engine/physique.js`) does not read faces. Corroborated auto-alias is not shipped.
- Health: `GET /api/health` (loop p99, stall attribution). Bench: `stall-bench` (dev-only) reproduces prod-scale stalls locally.
- Tests: `npm test` (~1900). Node 22 (shared runtime: `OpenBot/Shared/node22/.../bin/node`).
