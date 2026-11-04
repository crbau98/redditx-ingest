# DESIGN.md — PRISM Lumen + Motion

World: dark cinematic base, gradient brand (`--accent` pink, `--accent-2` violet, `--accent-3` amber), image-first cards with captions over a static scrim, depth from light (`--hi`, `--raise`, `--ring`, `--scrim`) rather than borders.

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
