# PRISM v4.20.0 Task Checklist

- [x] Wave 1–5 (`v4.19.0`): Shipped and pushed to `origin/main` (`21caa98`), live on Railway (`1,061,163` published items)
- [x] Wave 6 (`Blueprint` + `Forge`): Scheduler Resilience (`engine.js`) & 1.07M-Row Sweep / Idle Stall Elimination (`maintenance.js`, `sourcehealth.js`, `discovery/social.js`)
- [x] Wave 7 (`Halyard` + `Forge`): BoyfriendTV Timeout Fix (`boyfriendtv.js`), Dead/Wrong-Platform Host Guards (`deadhosts.js`), SearXNG Partial-Coherence Fallback (`websearch.js`), & Live Prod Failing Feed Triage
- [x] Wave 8 (`Blueprint`): Modularize `src/routes/admin.js` (699 lines) into domain route modules under `src/routes/admin/*` with contract tests
- [x] Wave 9 (`Velocity` + `Pixel`): Explicit Match Provenance (`exact`, `alias`, `backlink`, `directory`, `web`) in `src/engine/lookup.js` and `#/find` (`public/js/views/find.js`)
- [x] Wave 10 (`Crucible`): Full Regression & Adversarial Verification Gate + Bump & Push `v4.20.0` to `origin/main`
