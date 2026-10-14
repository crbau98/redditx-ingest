# UI changelog

## 2026-10-13 — v4.16 "Lumen"

**Design direction**: depth from light, not borders. Every raised surface (buttons, chips, inputs, panels, the tab bar, dialogs) is lit from above: a hairline of light on its top edge, a faint top-down sheen and a soft two-layer shadow beneath. Media gets the room: cards lose their frame and their caption block, and the caption sits over the bottom of the image instead. Type is tighter at display sizes, headings balance their lines (no one-word orphans on phones) and paragraphs wrap "pretty". Motion uses the v4.13 spring for buttons, chips, the tab-bar highlight, toasts and dialogs.

**Audit findings** (same `scripts/perf-audit.js` conditions as v4.13: phone 390×844 @2x, 4× CPU slowdown, 150 ms / 12 Mbps link, demo library, median of 3 runs; the old build was measured twice, back to back with the new one): the web fonts came from Google (two extra origins, 70 KB) and the admin console's stylesheet loaded on every public page. On a phone, a creator's header stacked a 112 px avatar, name, four buttons and two rows of wrapping chips before any content. Opening Reels or the Galaxy shifted the whole layer by the app bar's height (the page-enter animation put a transform on `<main>`, which made it the containing block of their fixed layer until the animation ended).

| Change | Files | Measured (old → new) |
|---|---|---|
| **Fonts self-hosted** and subset: Inter variable 400–700 and Space Grotesk variable 500–700, Latin-1 + common punctuation, preloaded from the shell; Google Fonts dropped from the CSP | `public/fonts/*` (OFL licence included), `index.html`, `theme-init.js`, `src/app.js`, `app.css` | fonts 70.4 → 44.7 KB, two fewer origins; Explore LCP 2.76–3.08 → 2.24–2.28 s; Reels LCP 2.23–2.29 → 2.12–2.15 s |
| **admin.css loads with the console only** (resolved from the admin module's own versioned URL, awaited before the console renders); `.chart-axis`, the one rule a public page shared, moved to app.css | `views/admin/index.js`, `index.html`, `sw.js`, `app.css`, `admin.css` | stylesheet bytes on every public page 25.8 → 23.8 KB, one request fewer |
| **Image-first cards**: no frame, caption over the image on a static scrim (no blur), a ring of light drawn above the image, platform as a tinted tag; dense grid stays picture-only; masonry gaps (12 / 6 / 18 px, 8 / 4 px on phones) are mirrored in `masonry.js` so its placement estimate matches what renders; the keyboard focus ring is an outline, so the lit shadows on buttons, chips and cards can't hide it; tighter gutters on phones | `app.css`, `components/card.js` ("why" chip moves into the caption), `components/masonry.js` (a card's height is now exactly its media) | feed fling 27.4–27.5 → 28.3–29.7 fps, long tasks 2.1–2.3 → 1.0–1.7 s; the same 158 cards take 24% less scrolling |
| Lit controls: buttons, chips, segmented controls, inputs, nav pill, link chips, tabs, modals, toasts, empty states | `app.css` | |
| New tokens: `--hi`, `--raise`, `--ring`, `--scrim`; deeper neutrals; softer two-layer shadows; light theme retuned to match | `app.css` | |
| Phones: creator header in two rows (80 px avatar beside the name, actions full width), account links and tags in one sideways-scrolling row each; a shorter home hero | `app.css` | |
| Keyboard focus: a two-tone ring that reads on any background; on cards it is drawn inside the media | `app.css` | |
| Reels and Galaxy no longer run the page-enter animation (it caused the layout shift above) | `app.css` | Reels CLS 0.039 → 0 under throttling |

**Tried and dropped**: `:has()` selectors for the card focus ring and the creator tag row. They made style recalculation during a feed fling ~45% more expensive (339 → 494 ms), so both use plain selectors now.

**Left to the usability thread's PR**: the phone layouts of Reels (full screen, the order picker in a sheet) and of the Explore filters (one swipeable row, `.filter-scroll`). This release only fades the edge of that row.

**Unchanged, for the record**: first paint ~0.53 s and Home LCP ~3.4 s are within run-to-run noise (Home's largest paint is the hero orbit). Reels swipe-to-first-frame stays ~0.39 s.

**OnlyFans UI (v4.14) in the same language**: the "Free OnlyFans" button, the OF badge on cards and the OnlyFans filter chip get the lit edge, glow and ring of the other controls. On a phone the creator header's buttons now wrap instead of squeezing, so the OnlyFans button is never clipped. Rebased onto the merged OnlyFans, body-filter, ranking and usability PRs (#29–#32, #34, #35).

**Verification**: 562 unit tests (9 new in `tests/v416-lumen.test.js`: no Google Fonts anywhere, both fonts declared, preloaded and under 30 KB, licence present; admin.css not in the shell and loaded by the console; no public view using an admin-only class; captions over the image with the matching masonry estimate; no new live blur on cards, chips or Reels controls; masonry gaps in sync with the CSS; focus ring is an outline; wide media gets a one-line caption). The v4.13 compositor-only guard still passes. Before/after screenshots on a phone and on desktop (dark and light) of Home, Explore, Creators, a creator page, Saved and the admin console, with no console errors.
## 2026-10-13 — "Intuitive": phone flows, gestures, getting back

**Audit findings** (demo seed, Chromium at 390×844 touch and 1440×900): on a phone the viewer's top bar held seven buttons in 390 px, squeezing the title to one letter and running the counter over the meta line; swipes only acted on release with no feedback, and a vertical drag was usually claimed by the browser (`touch-action: pan-y`) so drag-to-close rarely fired; the details sheet was laid out as a squeezed grid column instead of a sheet. Browse, the galaxy map, display settings, report and admin were reachable on a phone only from the footer, which an endless feed never lets you reach. Back from a creator put Explore at the top of a freshly fetched list. Explore's filters took ~360 px of a phone screen before the first card. Reels on a phone lost its type switch, repeated the order as its title ("Trending" next to a "Trending" select), and kept the app bar over the video.

| Change | Files |
|---|---|
| **Viewer on phones**: compact top bar (close, title, position) and a thumb dock for save, collect, share, download and details; details open as a real bottom sheet | `components/lightbox.js`, `css/ux.css` |
| **Viewer gestures follow the finger**: swipe left/right (rubber-band at the ends, flick-aware, next item glides in from that side), drag down to close with the viewer fading as you pull, swipe up for details, tap to hide/show the controls, a tap outside the details sheet closes it; pinch still zooms and a zoomed image pans | `components/lightbox.js`, `css/ux.css` |
| **Phone "More" sheet** in the app bar: Browse, Creator galaxy, Collections, History, Surprise me, Find anything (palette), Display, Report content, Admin | `components/menu.js`, `main.js`, `css/ux.css` |
| **Back returns you to where you were**: feeds stash what they loaded per page (15 min) and rebuild synchronously, so Explore, Home and creator pages restore their scroll position; a primary tab is a fresh start, and tapping the tab you are on scrolls to the top | `components/feed.js`, `main.js` |
| Explore on phones: filters are one swipeable row; active filters get a "Clear all" when there are two or more | `views/explore.js`, `css/ux.css` |
| Reels on phones: full-height (no app bar over the video); a "What plays" button opens type and order; the title names the context, never the order | `views/reels.js`, `css/ux.css` |
| Phone search placeholder no longer cut mid-word | `main.js` |

**Perf** (`scripts/perf-audit.js`, median of 3): unchanged within noise. Two more requests on load (`ux.css`, `menu.js`, +8 KB); feed fling 59.6 → 60 fps; Reels swipe-to-play 344 → 358 ms (noise: Reels playback code is untouched).

**Verification**: 4 new guards in `tests/ux-flows.test.js`; every gesture above driven with CDP touch events on a phone viewport, desktop viewer/backdrop-close/keyboard re-checked, no console errors.

## 2026-10-12 — v4.13 "Fluid"

**Audit findings** (measured with the new `scripts/perf-audit.js`: phone 390×844 @2x with touch, 4× CPU slowdown, 150 ms / 12 Mbps link for loads, demo library, median of 3 runs): an **untouched** Explore page spent ~2.4 s of main-thread and raster work in every 3 s, because every card's loading shimmer kept animating `background-position` under the finished image, forever. Flinging through the whole 158-card feed ran at **9 fps** with 12.6 s of long tasks. On Home, each rail's arrow/fade update forced a layout for the next rail (≈0.5 s at 4× slowdown). In Reels, the full-screen `blur(38px)` backdrop and the backdrop-blurred action buttons were re-rendered on every frame of a swipe (≈1.9 s of raster in 8 swipes), and the progress bar stepped ~4×/s via `timeupdate` + `width`. Smaller things: a growing `box-shadow` pulse and an animated conic-gradient ring repainted every frame; every card subscribed its own save listener that was only dropped at the next save; touch video previews started the moment Explore loaded; the galaxy view (the heaviest) was preloaded on every visit; on narrow cards the "Seen" badge ran under the save button.

| Change | Files | Measured (before → after) |
|---|---|---|
| Card placeholder shimmer is transform-only and switched off once the image loads (or fails); skeleton shimmer likewise | `components/card.js`, `app.css` | idle Explore, work per 3 s: paint 2,081 → 8 ms, raster 275 → 0, style 267 → 0 |
| Every looping animation is compositor-only: live-dot pulse is a scaling ring, the profile "posted recently" ring rotates as a layer, the hero glow is its own layer, the headline sheen sweeps once and rests | `app.css` | guarded by a new test: no `infinite` animation may animate anything but transform/opacity |
| No live blur on the chips every card carries (video pill, save button, "why" chip): dense tint + hairline instead | `app.css` | whole-feed fling: **9.3 → 31 fps**, dropped frames 85% → 48%, long tasks 12.6 s → 0.6 s, paint 6.1 s → 0.13 s, raster 2.6 s → 0 |
| Phones: off-screen feed cards skip style/layout/paint (`content-visibility: auto`), each carrying its estimated height from the masonry so nothing jumps | `components/masonry.js`, `app.css` | (part of the fling numbers above); estimates are within ~5 px of the real height |
| Rails measure all, then write only what changed, once per frame on scroll | `components/fx.js` | Home load: total blocking time 996 → 734 ms (together with the shimmer fix) |
| One save-button listener for the whole page instead of one per card | `components/card.js` | flat cost over long sessions |
| Touch previews start 1.2 s after the page has loaded, never on data saver / 2G / 3G | `components/card.js` | first screen of images no longer competes with clips |
| Galaxy view is loaded on first visit instead of preloaded | `main.js` | JS transferred on first load 124 → 118 KB; 29 modules preloaded instead of 30 |
| **Reels backdrop baked once** into a tiny bitmap (same look as the live blur, no per-frame cost); live blur kept only as a fallback | `components/fx.js` (`ambientBackdrop`), `views/reels.js`, `app.css` | 8 swipes: raster 1,936 → 363 ms, composite 789 → 241 ms, worst frame 150 → 83 ms |
| Reels action buttons and tags drop their backdrop blur (it was recomputed for every video frame behind them) | `app.css` | (in the swipe numbers above) |
| **Reels progress bar** is a compositor animation synced to the video clock (play, seek, loop, rate, pause, stall): smooth instead of 4 steps a second | `views/reels.js`, `app.css` | no per-frame JavaScript |
| HLS: start at a level that fits the player; a warmed (next) video buffers ~6 s instead of 30 s until it becomes the one on screen | `components/video.js`, `views/reels.js` | less bandwidth taken from the playing video |
| **Motion polish**: spring easing token (`linear()` where supported); save heart pops on a spring (cards and Reels); cards give under the finger on touch; Reels caption and action rail rise in for the slide on screen (rail a beat later); progress bar shows only on the active slide; softer image fade-in | `app.css`, `views/reels.js` | reduced-motion users get none of it (global rule) |
| Card badges wrap instead of running under the save button | `app.css` | |

**Tried and dropped**: a scale-settle on card images as they load. It delayed Explore's largest paint by ~250 ms (2.64 → 2.86 s), so only the fade stayed.

**Unchanged, for the record**: first paint ~0.47 s and LCP (Home 2.81 → 2.68 s, Explore 2.66 → 2.67 s, Reels 2.10 → 1.97 s) are within run-to-run noise; Reels swipe-to-first-frame stays ~350 ms (it is the length of the smooth-scroll animation; the next video is already buffered). The Reels style/paint totals went up a little (style 82 → 476 ms over 8 swipes at 4× slowdown) from the caption/rail transitions; the raster and composite savings are several times larger.

**Verification**: 468 unit tests (4 new in `tests/v413.test.js`: compositor-only loops, shimmer stops on load, no live blur behind Reels or on card chips, galaxy not preloaded; the loop guard fails on the v4.12 CSS). Screenshots of Reels (at rest and mid-swipe), Explore, Home and a creator page compared against v4.12 on a phone viewport with no console errors. Re-run the numbers with `NODE_PATH=$(npm root -g) node scripts/perf-audit.js http://localhost:3999 3` against the demo seed.

## 2026-10-12 — v4.8 "Self-healing"

**Audit findings**: when a post was deleted at its source, its card stayed in every feed forever, showing a broken image or a dead video. Nothing told the server, and nothing ever re-checked old items. Returning visitors had no quick way to see what had arrived while they were away; the "N new" counts existed only per smart feed. In Reels, each swipe started a fresh download, so every new video opened on a spinner. An automated accessibility pass (6 pages plus the viewer, dark and light) found one unnamed link: the viewer's creator avatar.

| Change | Files | Notes |
|---|---|---|
| **Link health**: viewers' browsers report media that fails to load; the server verifies at the source and hides only real removals (404/410 or a placeholder image, twice, at least an hour apart). 403/5xx/timeouts are "unknown" and never hide anything | `src/engine/health.js`, `routes/public.js`, migration v5 (`media_health`), `api.js`, `card.js`, `lightbox.js`, `reels.js`, `video.js` | each item is reported at most once per page session; the server probes a reported item at most every 30 min |
| Background sweep every 10 minutes. Order: pending confirmations, then never-checked items, then the least recently checked. Budget is configurable | `health.js`, `settings.js`, `server.js` | Admin → Settings → Maintenance |
| "Gone at source (7d)" KPI; hidden items keep their reason and can be restored | `routes/admin.js`, `views/admin/overview.js` | |
| **Since your last visit**: Home tiles for new posts from creators you follow, new posts in the library, and newly discovered creators; each opens a filtered Explore | `store.js` (`visits`), `views/home.js`, `views/explore.js` (`after` filter + *New since* chip), `app.css` | shown after a gap of an hour or more; on-device only; off when history is paused |
| **Reels buffer ahead**: the next video loads while the current one plays and the previous one keeps its buffer. Never on data-saver or 2G/3G. A buffered video never starts playing off-screen, even when its stream falls back to MP4 | `views/reels.js`, `components/video.js` | still only one playing video |
| Viewer: the creator avatar link duplicated the name link beside it. It is now removed from the tab order and the accessibility tree | `components/lightbox.js` | the audit now reports 0 issues |

**Verification**:
- Unit tests: 210 (8 new, run against a mock origin).
- Browser checks: 23 new.
- Regression: the v4.2–v4.7 suites were re-run. The v4.2 Reels check "at most one video with a source" became "at most one playing, at most three buffered" to match the new behaviour.
- Accessibility audit: clean.

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
