# DESIGN.md — PRISM Lumen + Motion, Spectrum layer (v7)

World: dark cinematic base, brand accent `--accent` pink with `--accent-2` violet and `--accent-3` amber, image-first cards with captions over a static scrim, depth from light (`--hi`, `--raise`, `--ring`, `--scrim`) rather than borders.

## Spectrum layer (v7, `css/aurora.css`, loaded last)

A prism splits light into a spectrum, so the spectrum is the one structural device.

- **Spectrum ring** (`--spectrum`, five hues): a ring around an avatar means "posted in the last 7 days"; a plain hairline ring means quiet. It encodes information, so it is never used as decoration. `components/creator-ring.js` builds the Home strip (people you follow first).
- **Gradients are an accent.** A1 Gallery measured them in about 1 in 5 heroes and 1 in 8 navs. Primary buttons are flat `--accent`, section icons do not glow, the headline does not colour one phrase, and the body wash is one quiet radial instead of two blobs.
- **Phones are content-first.** Left-aligned masthead, one swipeable action row, a ring strip inside the first screen, flat creator rows instead of cover cards, 2-up Browse tiles, one-line section subs, Explore filter labels on the same line as their chips. Measured at 390×844 against the previous build: Home's first media or creator sits at y=477 (was y=1511) and 12 pictures or avatars are fully above the fold (was 0); Creators fits 2 cards in the first screen (was 1); Explore's first card is at y=336 (was y=397); Browse is 24% shorter (2598px vs 3418px).
- **Type** is a 1.25 modular scale in `rem` (`--t-xs` … `--t-5`), so the OS text size applies to anything sized with it; `<meta name="text-scale">` opts in where supported. Space Grotesk + Inter stay.
- **Shape**: media cards keep the measured 16px median radius (`--au-r-media`); panels use 22px (`--au-r-panel`); borders separate, shadows do not.
- **Touch**: every interactive element is at least 44px on coarse pointers, including Browse tag chips (measured with Playwright at 390px: 0 under 44px on Home, Explore, Creators, Reels, Saved, Find, Browse).
- No new infinite animation. The ring only transitions `transform` and is off for reduced motion.

## Phone & install (v7.1, `aurora.css` last block, `components/scroll-chrome.js`, `components/pwa.js`, `sw.js`)

- Budgets, enforced by `node scripts/ui-audit.js <url> --phone --strict` on the demo library at 360x740, 390x844, 430x932 and 768x1024: 0 px of sideways overflow, 0 clipped elements, 0 targets under 44px, 0 text under 12px, 0 form fields under 16px, 0 content under the tab bar, 0 pinned controls under the notch (47px) or home indicator (34px), pinned chrome (app bar + filter bar + tab bar, minus safe areas) at most 22% of the viewport after scrolling.
- The sticky filter bar tucks away while scrolling down and returns on the first scroll up (transform only; instant under reduced motion). While a text field has focus the tab bar is hidden (`html.typing`).
- Every viewport-height rule carries a `dvh` / `svh` line after the `vh` one (guarded by `tests/phone-pwa.test.js`); `content-visibility: auto` always comes with `contain-intrinsic-size`.
- Install: PNG icons incl. a separate maskable one, shortcuts, `theme-color` follows the theme, Install / Add to Home Screen in the phone menu. Offline: shell and hashed files precached; public reads (stale-while-revalidate, 60 s fresh) and pictures (cache-first, 150) are cached ONLY when the person turns on Display > "Keep what I browse for offline use" (off by default: adult content is not kept on the device unasked), never admin / stream / age / HLS / video; a pill says when the device is offline. Bump `VERSION` in `sw.js` when the worker or a precached file changes.

## Admin console (v4.18)

The owner's jobs, in the order they come up: see what is broken in ingestion, clear the review queue, add a source, tune the filters, check throughput. The console is built around them and not around the database tables.

- **Overview is "Needs attention"**: only queues with something in them, worst first (reports, failing feeds, review, feeds the app paused, same-person links, new creators). Failing feeds and auto-paused feeds are expanded in place: the error in plain words (`explainFeedError`), one tap to fix (Retry, Pause, Check keys, Turn back on). Below: items ingested in 24h against the day before, the engine, and a folded "More numbers".
- **Phones**: a bottom tab bar (Overview, Review, Feeds, Settings, More) replaces the public tab bar while the console is open (`body.is-admin`); lists are cards (`.tbl.a-cards`, the same cells laid out by CSS), search is the one sticky row, bulk actions live in a fixed bar above the tab bar, dialogs are sheets, every target is 44px.
- **Settings** are grouped, searchable and each has one plain sentence (`settings-model.js`). The body filter and feed housekeeping come first and open. A changed setting says so and resets to its default. Discovery settings stay on the Discovery page.
- **Destructive actions** ask first and say what they do (approve, remove, block, delete a feed, block a creator). What can be reversed has an 8-second Undo toast instead of a second prompt: hide, approve, remove (back to the review queue), pause or resume a feed, hide a creator, reject candidates, remove a blocklist entry, add a feed. A block cannot be undone from the console and says so.
- **Stylesheets**: `admin.css` (older shared classes) and `admin-console.css` (this layout) load with the console only, from `adminStyles()`; public pages never download them. Tokens only, so light and dark both work. All new classes are `a-*`.
- **Logic is pure** (`logic.js`, `settings-model.js`: no DOM, no imports) so `tests/admin-ui-logic.test.js` pins down the wording, the ordering and the grouping. `scripts/ui-audit.js --admin-key … --only-admin [--strict]` checks every admin screen at 360, 390, 768 and 1280 for cut-off content, scrollers inside the page and touch targets under 44px.

## Information architecture (top first)

The job is to find the top OnlyFans creators fast. Home is, in order: masthead, ring strip, Top OnlyFans creators, follows, trending, For you, latest uploads. Creators opens on **Top** (OnlyFans-linked first), with **OnlyFans only**, **Following** and **New** beside it; other sorts live in Filters. A section earns its place only if it answers a different question from another one; the rest were cut. No number on a page may be typed in by hand: Browse tiles are live counts or absent.

## Tokens

- Type: Inter (UI) + Space Grotesk (display), self-hosted, Latin-1 subset, preloaded.
- Motion: three springs (`--spring-snap`, `--spring-glide`, `--spring-settle`) + three durations (`--dur-quick` 140ms, `--dur-base` 260ms, `--dur-slow` 440ms). Presses/chips snap, pages/fades glide, sheets/dialogs/toasts settle.
- Shared elements via `components/transitions.js` ghosts (card→viewer, viewer→card, avatar→profile). Never the View Transitions API (async fetches would freeze the page).
- Compositor-only loops: infinite animations may touch only transform/opacity. No `:has()` on cards. No live blur behind chips/Reels controls. Guarded by `tests/v413.test.js` + `tests/v5-motion.test.js`.

## Surfaces

- Home: one calm hero (kicker with counts, headline, one search box, three actions, one line of safety/male-only copy) over a static accent wash. The WebGL prism, 3D orbit, pointer card tilt/glare, the 3D galaxy map and the `prefs.ambientFx` opt-in are deleted, not gated. Cards get one hover lift (`translateY`). `/galaxy` links redirect to Creators.
- Grids: shortest-column masonry from metadata aspect ratios (batched per-column `DocumentFragment` appends, width-gated `ResizeObserver`), `content-visibility: auto` with `containIntrinsicSize` estimates, `thumb_url` as card 1x `src` + `preview_url` as 2x `srcset`, `tint` as placeholder, `decoding=async`, `fetchpriority=high` only on the first viewport row, off-screen bitmap & video relief (>2400px), and DOM windowing past ~3600px (a height-preserving parked shell, restored on approach, still in the tab order), staggered first paint of a new page (opacity/transform, capped, off for reduced motion and Data Saver), max 2 live preview videos with hover-intent delay.
- Routes: a short enter/exit on `<main>` (opacity + small translate, `--dur-base` / `--dur-quick` and `--spring-glide`). Reduced motion is instant. Reels, Galaxy, and an in-flight shared-element flight skip it so they do not fight `transitions.js`.
- Explore: display type on the page title, a specular hairline on the filter bar, and a loading count.
- Find (`#/find`): specular search bar, example chips, verified-account evidence cards with platform badges and samples, brand-tinted paid link-out pills (OnlyFans, Fansly, JFF; kept on the new profile when followed), empty/error/rate-limit states, avatar→profile flight on follow.
- Navigation & Creators: 5 primary tabs across desktop and mobile (`Home`, `Explore`, `Reels`, `Creators`, `Saved`). `Creators` consolidates local search, `Following` filter, and inline open-web lookup (`POST /api/lookup`), while keeping `#/find` and on-demand `#/galaxy` routes intact.
- Creator profile & Visual Intelligence: stage header, platform switcher pills, paid link-out cards. A **Connected** strip (Accounts, Paid pages, On the web, Co-stars, Similar style) jumps to each part of his graph; Co-stars and Similar style only appear once their rail has loaded. "Also on the web" is a horizontal rail: each card names its match kind, says in one sentence what was compared, and shows up to three evidence chips (+N).
- "Why this" chips speak in the user's terms ("You follow Jules", "You often open Jules", "You like #beach", "Similar to @x") and the tooltip says it comes from this device's history.
- Creator profile: stage header (best picture full-bleed, color wash, scroll drift via CSS only, brand-tinted OF/Fansly/JFF CTAs), platform switcher pills + brand-tinted paid link-out cards, feed tabs.
- Reels: full-viewport slides, one playing video, buffer-ahead (not on data-saver/2G/3G), baked ambient backdrop, compositor progress bar.
- Accessibility: visible two-tone focus ring (inside media on cards), named controls, alt text, reduced-motion collapses durations and disables reveals. On touch, every chip, pill and "see all" link is at least 44px tall.

## What not to do

- No new visual language, no React, no card frames or caption blocks, no scale-on-load, no per-card save listeners, no galaxy/admin preload on public pages.
