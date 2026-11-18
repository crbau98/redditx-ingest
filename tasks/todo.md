# PRISM v4.20.0 Task Checklist

- [x] Wave 1–5 (`v4.19.0`): Shipped and pushed to `origin/main` (`21caa98`), live on Railway (`1,061,163` published items)
- [x] Wave 6 (`Blueprint` + `Forge`): Scheduler Resilience (`engine.js`) & 1.07M-Row Sweep / Idle Stall Elimination (`maintenance.js`, `sourcehealth.js`, `discovery/social.js`)
- [x] Wave 7 (`Halyard` + `Forge`): BoyfriendTV Timeout Fix (`boyfriendtv.js`), Dead/Wrong-Platform Host Guards (`deadhosts.js`), SearXNG Partial-Coherence Fallback (`websearch.js`), & Live Prod Failing Feed Triage
- [x] Wave 8 (`Blueprint`): Modularize `src/routes/admin.js` (699 lines) into domain route modules under `src/routes/admin/*` with contract tests
- [x] Wave 9 (`Velocity` + `Pixel`): Explicit Match Provenance (`exact`, `alias`, `backlink`, `directory`, `web`) in `src/engine/lookup.js` and `#/find` (`public/js/views/find.js`)
- [x] Wave 10 (`Crucible`): Full Regression & Adversarial Verification Gate + Bump & Push `v4.20.0` to `origin/main`

# PRISM v4.21.0: Wave 11 (2026-11-16): full review + Railway cost cut
Baseline (prod /api/health 16:11Z, uptime 391 s): rss 3865 MB, heap 1063 MB; loop blocks 9.7 s / 5.2 s (warm:dedupe, faceSweep, embed); about 15.8k feed runs by 16:09Z, 158 runs after the restart added 20 items.
- [x] Forge `w11-cost-forge`: SQLite cache/mmap env + lean worker defaults, idle shutdown for the image/ML workers, sweep duty cycle, Chromium idle close, proxy egress counters
- [x] Blueprint `w11-stalls-blueprint`: warm:dedupe / phash index packed memory and stall fix, 104 s idle stall root cause, accurate blockwatch labels
- [x] Halyard `w11-ingest-halyard`: disable 9 dead feeds (approved), yield-based backoff for all-dupe feeds, handle validation, redgifs 429 cooldown
- [x] Velocity `w11-ux-velocity`: full UX/perf/a11y pass on every view, cut /proxy bytes per session
- [x] Crucible: whole-app security and integrity review (read-only), findings routed to owners
- [x] Merge (w11-integrate), 3 Crucible gates (blocker fixed with a worker-thread parser preflight), user approved; pushed 25b393e to origin/main 2026-11-16
- [ ] Post-deploy: verify version/memory/loop blocks, egress counter, Chrome sandbox status, feed yield after a few days

# PRISM v4.22.0: Wave 12 (2026-11-16/17), shipped 208ce54, live 2026-11-17 16:35Z
- [x] v4.21.0 verified on prod: rss 1.32 GB at ~400 s (was 3.87 GB), p99 53-83 ms; 24 removed-media residue rows purged
- [x] Forge: hash retry (v38), repair-no-image (dry by default), windowed library-health
- [x] Blueprint: chunked resumable takedowns, WAL checkpoints off-thread (busy-safe RESTART), dedupe/MEDIA_SELECT/follow stalls
- [x] Velocity: preview.redd.it direct, i.redd.it stub fallback, stored media via presigned bucket redirect (14/14 prod checks PASS)
- [x] Owner: imagematch.pickCreators 12.7 s block, Following Earlier tab fix
- [ ] Wave 13 (Forge): video tiles with no poster stay published and get a first-frame poster (user decision 2026-11-17); repair-no-image only reviews images; time-sized library-health window (prod chunk 1,494 ms)
- [ ] Check tomorrow: redditPhash pending falling from 24,325; egress counter split; Chrome sandbox status after first launch; Halyard feed-yield numbers

# PRISM v4.22.1: Wave 13 (2026-11-17), shipped 8cf127e, live 18:41Z
- [x] Videos with no thumbnail stay published, first-frame canvas tiles (Forge + Velocity), ~0.33 MB per tile
- [x] repair-no-image: prod dry run 1,175 videos / 0 images, nothing to apply
- [x] library-health windows: prod maxChunkMs 19 (was 1,494)
- [x] Proxy aborts the upstream when the viewer leaves before headers (owner fix, Crucible P1)
- [ ] Wave 14 (Blueprint): boot-time freeze during warm:visualIndex (2.0 s and 4.8 s after the last two deploys)
- [ ] Watch: redditPhash pending 22,971 (falling), unhashable 1,427; egress split; Chrome sandbox status

# PRISM v4.23.0: Wave 14 (2026-11-17), shipped 61a33d7, live 21:30Z (user pre-approved deploy after Crucible SHIP)
- [x] Identity: junk handle rejection, aggregator guard, corroborated auto-merge with snapshots + unmerge, link/feed repairs (dry-run first), hidden report/unhide
- [x] Ingestion: per-feed block logging, feed-revive, coverage (OFF by default), reddit archive paging, fallback_url (v39)
- [x] Safety: automatic-origin feeds are quarantined (whole account), never the creator; only admin/seed/ingest/import/telegram-sync are "own"
- [x] Viewer: original is an upgrade; fallback_url -> preview -> thumbs; "Preview quality" chip
- [x] Prod applied: 20 junk identity pairs rejected; 2 coomer feeds re-filed (576 media); 5 merges (snapshots); 8 body-filter creators unhidden (user approved)
- [ ] URGENT (Halyard w15): Bigggwild 041388c6 blocked + purged at 19:22Z by the OLD v4.22.1 blockFemaleCreator after my manual feed re-enable; build recover-block (dry run/apply) + candidates list
- [ ] Halyard: feeds/revive dry run scans only 50
- [ ] Blueprint: 'Patreon:cw' junk handle; 14 historical mergedOnJunk; repair/links same-person owners to review; physique.unhideCreator last-status-action bug + re-enable paused feeds for the 8
- [ ] Coverage stays off until revive/recovery are settled; then a per-creator dry run

# PRISM v4.23.2: Wave 16 thumbs (2026-11-18)
- [x] Coomer: never use profile banner as video poster; video-only → null still (first-frame UI)
- [x] UI: skip coomer/kemono /banners|/icons in stillChain/cardImage
- [x] Admin: POST /maintenance/heal-banner-previews (dry default) clears banner previews + store thumbs
- [x] Prod: disabled Bigggwild aggregator feeds; unassigned LPSG rss (65) + pornone (15) media
- [ ] Post-deploy: heal-banner-previews apply app-wide; verify Bigggwild tiles
