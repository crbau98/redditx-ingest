# PRISM v4.19 — 8-Hour Execution Checklist (`tasks/todo.md`)

- [x] **Wave 1: Kill 34s–118s Event-Loop Stalls (Performance)** — *Completed in `a6bde53`*
  - [x] **1.1** `faceSweep` index fix (`src/engine/maintenance.js:469-473`): use `INDEXED BY ix_media_face_todo` + `ORDER BY seq DESC LIMIT ?` + `EXPLAIN QUERY PLAN` test
  - [x] **1.2** `ocr.pick` partial index migration `v37` (`ix_media_ocr_todo`) in `src/db/schema.js` + `src/engine/ocr.js` + remove main-thread `PRAGMA optimize` interval in `src/db/index.js:51`
  - [x] **1.3** `visual.pending` bounded `seq` scan (`src/engine/visual.js`) + `PhashIndex` pre-parsed `Uint8Array(8)` chunk cache (`src/lib/phash-index.js`)

- [x] **Wave 2: Usable End-to-End Deep Search (Backend + Live UX)** — *Completed*
  - [x] **2.1** Alias-aware `buildQueries()` & `samePerson()` in `src/engine/deepsearch.js` (include `creator_aliases` + claimed `onlyfans_leads`, suffix normalization, edit-distance 1 for 7+ char handles)
  - [x] **2.2** Immediate `engine.enqueue()` for newly added deep-search feeds + live `postsAdded` tracking + public rate-limited `GET/POST /api/creators/:id/pull` in `src/routes/public.js`
  - [x] **2.3** Public live Deep Search banner & auto-refreshing media grid on `public/js/views/creator.js` (`public/js/components/deep-pull.js`) + progressive stage feedback & provenance badges on `public/js/views/find.js`

- [x] **Wave 3: Feed Ingestion & Discovery Hardening** — *Completed*
  - [x] **3.1** Bluesky actor normalization & batch resilience in `src/engine/discovery.js` & `src/lib/bsky-actor.js` (`getProfiles` & `getSuggestedFollowsByActor` HTTP 400 fix)
  - [x] **3.2** Misskey `/api/users/search` 404 fix, Reddit subreddit search Arctic Shift fallback (404 fix), Discovery Arctic Shift 422 rate-limit guard, and GayForFans `justthegays.tv` mirror fallback (403 fix)
  - [x] **3.3** Library health & foreign-feed audit verification (`Halyard`)

- [x] **Wave 4: Codebase Organization & Modularity** — *Completed (`f9f4a4d`, `5b4a33c`)*
  - [x] **4.1** Extract `feeds`, `runs`, `candidates`, `onlyfans`, `reports`, `library`, `graph`, `tags`, and `analytics` repositories from `src/db/repo.js` into `src/db/repos/` (`1,160 -> 178` lines, commit `f9f4a4d`) and remove dead `src/sources/_policy.js`
  - [x] **4.2** Extract discovery sub-modules (`core.js`, `social.js`, `paid.js`, `performers.js`, `decisions.js` under `src/engine/discovery/`) from `src/engine/discovery.js` (`2,064 -> 154` lines, commit `5b4a33c`)

- [x] **Wave 5: Design Polish & Crucible Pre-Release Gate**
  - [x] **5.1** Responsive CSS polish & stylesheet deduplication (`public/css/*`, `-157` net lines, `134/134` CSS contract checks passing)
  - [x] **5.2** Full verification: `npm test` (212+ test files), query-plan checks, and `Crucible` adversarial edge-case gate (`f8bcfb6`)
