# DESIGN.md — PRISM Lumen + Motion

World: dark cinematic base, gradient brand (`--accent` pink, `--accent-2` violet, `--accent-3` amber), image-first cards with captions over a static scrim, depth from light (`--hi`, `--raise`, `--ring`, `--scrim`) rather than borders.

## Tokens

- Type: Inter (UI) + Space Grotesk (display), self-hosted, Latin-1 subset, preloaded.
- Motion: three springs (`--spring-snap`, `--spring-glide`, `--spring-settle`) + three durations (`--dur-quick` 140ms, `--dur-base` 260ms, `--dur-slow` 440ms). Presses/chips snap, pages/fades glide, sheets/dialogs/toasts settle.
- Shared elements via `components/transitions.js` ghosts (card→viewer, viewer→card, avatar→profile). Never the View Transitions API (async fetches would freeze the page).
- Compositor-only loops: infinite animations may touch only transform/opacity. No `:has()` on cards. No live blur behind chips/Reels controls. Guarded by `tests/v413.test.js` + `tests/v5-motion.test.js`.

## Surfaces

- Home: static accent wash first; WebGL prism (`prism-bg.js`) + 3D orbit (`orbit.js`) mount after first paint via `requestIdleCallback`. Reduced-motion and software-GPU get still equivalents.
- Grids: shortest-column masonry from metadata aspect ratios, `content-visibility: auto` with `containIntrinsicSize` estimates, `thumb_url` as card src, `tint` as placeholder, eager + `fetchpriority=high` for first ~6 cards, max 2 live preview videos.
- Find (`#/find`): large name field, example chips, verified-account evidence cards with samples, paid link-outs, empty/error/rate-limit states, avatar→profile flight on follow.
- Creators: paid-page select (OF/Fansly/JFF/ManyVids/LoyalFans) + platform select + search + sort; Find CTA beside Galaxy CTA.
- Creator profile: stage header (best picture full-bleed, color wash, scroll drift via CSS only), platform switcher pills + paid link-outs, feed tabs.
- Reels: full-viewport slides, one playing video, buffer-ahead (not on data-saver/2G/3G), baked ambient backdrop, compositor progress bar.
- Accessibility: visible two-tone focus ring (inside media on cards), named controls, alt text, reduced-motion collapses durations and disables orbit/shader/reveals.

## What not to do

- No new visual language, no React, no card frames or caption blocks, no scale-on-load, no per-card save listeners, no galaxy/admin preload on public pages.
