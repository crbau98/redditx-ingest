# UI changelog

## 2026-10-12 — v4.7 "Velocity"

**Audit findings** (measured, not guessed): on a generated 60,000-item / 900-creator library, a two-word search took **56 s**; related tags, similar creators and For you took 0.25–0.6 s; plain listings 50–70 ms; topics 2.7 s on a cold cache. In the browser on an emulated 4G link (150 ms RTT) the first visit spent ~3 s discovering 31 ES modules level by level, and every visit revalidated each module.

| Change | Files | Measured |
|---|---|---|
| FTS: count with an IN-subquery, list with FTS-first `CROSS JOIN` (the planner was re-running MATCH per row) | `src/db/repo.js` | search 56 s → 11 ms |
| Broad listings walk the matching sort index (forced only when filters are broad; narrow ones use the planner, rare tags estimated from cached counts) | `repo.js` | recent/top/trending 50–70 → 4–6 ms; tag filters 110–210 → 9–13 ms |
| Library snapshot (tag counts + per-creator tag profiles), rebuilt in the background after writes; serves autocomplete, related tags, similar creators | `repo.js` | similar 500 → 13 ms; related 600 → 2 ms; suggest 185 → 26 ms |
| For you scores a capped pool of the hottest matches | `repo.js` | 280 → 37 ms |
| Totals and small aggregates cached until the next write (`total_changes()`) | `repo.js` | stats/platforms 30–40 → 2–3 ms |
| Planner statistics (`PRAGMA optimize`) + migration v4 indexes (NOCASE community, creator status, creator-card previews/platforms) | `src/db/index.js`, `schema.js` | ids/community/creator lists 25–50 → 2–4 ms |
| Route caches are stale-while-revalidate and warmed at boot | `routes/public.js`, `server.js` | no visitor waits for topics (2.7 s) or graph rebuilds |
| Versioned immutable assets (`/v/<hash>/`), `modulepreload` for the whole static graph, cache-first in the service worker | `src/lib/assets.js`, `app.js`, `sw.js` | Home cold first content 2.87 → 2.20 s (HTTP/1.1 locally; HTTP/2 in production fetches the graph at once); repeat visit 0.93 → 0.23 s |
| Fonts no longer block first paint | `theme-init.js`, `index.html` | |
| In-memory API cache (30 s, de-duplicated, cleared by writes and live "new content"), hover/touch prefetch of creator profiles, first six images eager + high priority | `api.js`, `main.js`, `card.js` | back-navigation and prefetched profiles open with no request |
| **Live search preview**: the first results and a count, while typing, for what was understood; thumbnails open in the viewer with the search behind them | `components/suggest.js` | |
| **"Why" chips** on For you cards ("#beach", "A creator you like") from the on-device taste model | `store.js`, `card.js`, `feed.js` | |
| Discovery: Bluesky lookalikes, Bluesky + RedGIFs people search, "where your creators post" communities, per-signal yield report | `engine/discovery.js`, `sources/{bluesky,redgifs}.js`, admin | |

**Verification**: 202 unit tests (12 new, incl. a search performance guard that fails on the old plan: 1.4 s → 5 ms at 6k rows); 12 new browser checks; v4.2–v4.6 suites re-run (145/145).

## 2026-10-12 — v4.6 "Insight"

**Audit findings**: search only did full-text matching, so “bearded guys at the beach, videos” found nothing even though the library had #beard and #beach videos; a search with no results was a dead end; filters had no notion of “things that go together”; Home had no way in by theme; discovery only found individual accounts, never the subreddits, Lemmy communities and Bluesky feeds where many creators post.

| Change | Files | Notes |
|---|---|---|
| **Plain-language search**: text is read into tags, creator, photos/videos, time window, source and sort using the library's own vocabulary (synonyms, plurals, descriptive forms like “bearded”→#beard, multi-word tags, typo correction by bounded edit distance); unplaced words stay as full-text | `src/lib/query.js`, `routes/public.js` (`/api/understand`), `public/js/smart.js` | Pure function of (text, vocabulary); vocabulary cached 60 s. Header, hero and palette searches all use it. |
| **“Understood as” banner** with removable, colour-coded chips, spelling fixes, and a “Search the exact words” escape hatch | `views/explore.js`, `app.css` | |
| **Live preview** of what Enter will search, at the top of the search dropdown (header and hero) | `components/suggest.js` | Shown only when the words were read as more than one plain match. |
| **Relaxed results**: when nothing matches everything, a smart search drops the least important filter(s) (time → source → type → extra tags → community → words → creator) and says what it dropped, with “Show exact matches”; hand-picked filters get a “Try without …” button instead | `smart.js`, `views/explore.js` | Probes with `limit=1` counts, stops at the first that returns results. |
| **Narrow with** related tags: tags that co-occur with the current ones more than chance (lift), click to add | `src/db/repo.js` (`tagIntel.related`), `/api/tags/related` | Community-name and platform tags excluded. |
| **Topics**: clusters of tags that travel together (cosine of co-occurrence, greedy grouping), as preview-mosaic cards on Home and Browse | `tagIntel.topics`, `/api/topics`, `components/topics.js` | Cached 10 min; opens Explore with `anytags=`. |
| **“Because you watch #tag”** rails from the device taste model, best of the month you haven't opened | `components/topics.js`, `views/home.js` | |
| `tags=` (all of) and `anytags=` (any of) filters across Explore, Reels, smart feeds | `repo.js`, `explore.js`, `reels.js`, `store.js` | Saved feeds keep the new keys; old saved feeds still match. |
| Discovery reaches **communities and custom feeds** (Reddit subreddit search, Lemmy community lists, Bluesky feed search), **X profile lookups**, and **audience size** in the score; admin shows reach chips and the new switches/keywords | `engine/discovery.js`, `sources/{reddit,lemmy,bluesky,x}.js`, `settings.js`, `views/admin/discovery.js` | Communities: stricter safety (borderline wording dropped), auto-follow only male-focused ones and only as untrusted feeds. |

**Verification**: 182 unit tests (15 new: parser, tag intelligence, filters, API, discovery strategies against mock servers); 24 new browser checks (desktop + phone, no console errors); v4.2–v4.5 browser suites re-run clean. The v4.1 script's duplicate-creator step needs seed data that the current demo seed does not create (fails identically on v4.5).

## 2026-10-12 — v4.5 "Constellation"

**Audit findings**: creator discovery was list-shaped (grids and rails) with no sense of how creators relate; the viewer could not zoom beyond a single toggle and had no overview of the sequence; every page looked the same regardless of whose page it was.

| Change | Files | Notes |
|---|---|---|
| **Creator galaxy** (`#/galaxy`): 3D force-directed map of creators linked by tag similarity; glowing avatar sprites, starfield, depth-sorted rendering, drag/pinch/wheel/keyboard, hover/tap cards, search-and-fly camera, style legend | `views/galaxy.js`, `src/db/repo.js` (`creators.graph`), `routes/public.js` (`/api/graph`) | Canvas 2D with pre-rendered sprites (one `drawImage` per star); layout computed once (~O(n²), < 50 ms for 160 stars); animation only while moving; every other frame on software rendering. |
| Viewer zoom & pan: wheel/trackpad around the cursor, click 2.5×, pinch, drag-pan, + / − / 0; double-click still saves | `components/zoom.js`, `lightbox.js` | Transform-only, clamped to the image; single clicks wait 230 ms so a double-click never flickers the zoom. |
| Viewer filmstrip of the surrounding sequence | `lightbox.js`, `app.css` | Desktop / tall screens only. |
| Chameleon profiles: accent palette sampled from the creator's banner/preview/avatar (saturation-weighted, clamped for legibility), scoped to the page | `components/fx.js` (`dominantColor`), `views/creator.js`, `app.css` | Same-origin proxy keeps the canvas untainted; removed on leaving the page. |
| Haptic tap on save (Android Chrome) | `components/fx.js` | |
| Entry points: Creators page button, palette command, footer link, `g m` | `main.js`, `creators.js`, `palette.js` | |

**Verification**: 167 unit tests (3 new for the graph); 25 new browser checks; v4.1–v4.4 suites re-run.

## 2026-10-12 — v4.4 "Spectrum"

**Audit findings** (desktop 1440 / phone 390, dark + light): flat text-only hero that showed no media above the fold; ragged rails (cards sized by each item's aspect ratio); no affordance that rails scroll; dead dark space around media in the viewer; cards felt flat on hover; platform colours missing (fixed in 4.3); no sense of motion while scrolling.

**Changes**
| Change | Files | Notes |
|---|---|---|
| Hero rebuilt: two-column layout, live WebGL "prism light" shader backdrop (accent-coloured, pointer-reactive), 3D orbit of trending media (drag to spin with momentum, tap to open), count-up stats, live kicker | `components/prism-bg.js`, `components/orbit.js`, `views/home.js`, `app.css` | Shader: ~3 KB, half-resolution, pauses off-screen / hidden tab, one still frame under reduced motion, CSS fallback without WebGL. Orbit: pure CSS 3D, one ring transform per frame. |
| Viewer ambient mode: blurred, saturated copy of the current media glows behind it; glassy details panel | `components/lightbox.js`, `app.css` | Two crossfading layers. |
| Shared-element zoom: the viewer grows out of the card you clicked | `components/fx.js`, `card.js`, `lightbox.js` | WAAPI, one-shot, skipped under reduced motion. |
| 3D tilt + glare on cards, creator cards, collections and browse tiles | `components/fx.js`, `app.css` | One delegated listener, rAF-throttled CSS variables; mouse only. |
| Rails: even 3:4 cards, fading edges, hover arrows | `components/fx.js`, `app.css` | Enhances any `.rail`, including ones added later. |
| Scroll-driven reveals for sections, cards and grids | `app.css` | `animation-timeline: view()` behind `@supports` + reduced-motion guard; uses `translate`/`scale` so it never fights the tilt transform. |
| Heart bursts on save (cards, viewer, Reels) | `components/fx.js` | |
| Scroll-progress hairline under the app bar | `main.js`, `app.css` | CSS `scroll()` timeline. |
| Floating glass tab bar on phones with a sliding active indicator; Reels overlays clear it | `main.js`, `app.css` | |
| "Posted recently" animated ring on creator avatars | `views/creator.js`, `app.css` | `@property --spin`. |
| Film-grain texture behind the UI; glowing section icons; gradient stat numerals | `app.css` | |
| Fixes: Reels title now names the active sort; video badges on cards facing away in the orbit fade out | `views/reels.js`, `app.css` | |

| Performance guardrails: shared GPU-tier detection (`data-gpu` on `<html>`); the shader steps resolution down on slow frames and holds a still frame on software rendering; the orbit stops auto-turning there and only animates while it moves; depth shading moved from CSS `filter` to an opacity overlay; costly backdrop blurs trimmed on software rendering | `components/fx.js`, `prism-bg.js`, `orbit.js`, `app.css` | Measured in headless Chromium (SwiftShader): Home went from 23 → 53 fps. |
| Fix: after a drag, taps on the orbit hit the 3D stage plane instead of the card | `app.css` | stage ignores pointer events; cards opt back in. |

**Verification**: 164 unit tests; 26 new browser checks for v4.4 (shader, orbit auto-turn/hover/drag/tap, ambient, FLIP, tilt, rails, heart burst, reduced motion, phone tab bar, no overflow, no console errors); v4.1, v4.2 and v4.3 browser suites re-run clean.

**Trade-offs / follow-ups**: the shader costs a little GPU on the Home page only (paused elsewhere); a three.js scene was considered and rejected (~680 KB) in favour of the hand-written shader. Scroll reveals are skipped in Firefox until it ships `animation-timeline`.
