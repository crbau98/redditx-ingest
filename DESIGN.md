# DESIGN.md — PRISM Lumen + Motion

World: dark cinematic base, gradient brand (`--accent` pink, `--accent-2` violet, `--accent-3` amber), image-first cards with captions over a static scrim, depth from light (`--hi`, `--raise`, `--ring`, `--scrim`) rather than borders.

## Tokens

- Type: Inter (UI) + Space Grotesk (display), self-hosted, Latin-1 subset, preloaded.
- Motion: three springs (`--spring-snap`, `--spring-glide`, `--spring-settle`) + three durations (`--dur-quick` 140ms, `--dur-base` 260ms, `--dur-slow` 440ms). Presses/chips snap, pages/fades glide, sheets/dialogs/toasts settle.
- Shared elements via `components/transitions.js` ghosts (card→viewer, viewer→card, avatar→profile). Never the View Transitions API (async fetches would freeze the page).
- Compositor-only loops: infinite animations may touch only transform/opacity. No `:has()` on cards. No live blur behind chips/Reels controls. Guarded by `tests/v413.test.js` + `tests/v5-motion.test.js`.

## Surfaces

- Home: static accent wash first; WebGL prism (`prism-bg.js`) + 3D orbit (`orbit.js`) mount after first paint via `requestIdleCallback`. Reduced-motion and software-GPU get still equivalents.
- Grids: shortest-column masonry from metadata aspect ratios (batched per-column `DocumentFragment` appends, width-gated `ResizeObserver`), `content-visibility: auto` with `containIntrinsicSize` estimates, `thumb_url` as card 1x `src` + `preview_url` as 2x `srcset`, `tint` as placeholder, eager + `fetchpriority=high` for first ~6 cards, off-screen bitmap & video relief (>2400px via shared `IntersectionObserver`), max 2 live preview videos with hover-intent delay.
- Find (`#/find`): specular search bar, example chips, verified-account evidence cards with platform badges and samples, brand-tinted paid link-out pills (OnlyFans, Fansly, JFF; kept on the new profile when followed), empty/error/rate-limit states, avatar→profile flight on follow.
- Creators: quick paid-platform pills (OnlyFans, Fansly, JFF) + paid-page select (all eight paid hosts) + platform select + search + sort; distinct `.badge.of`, `.badge.fansly`, `.badge.jff` (and `.free`) pills on creator cards; Find CTA beside Galaxy CTA.
- Creator profile: stage header (best picture full-bleed, color wash, scroll drift via CSS only, brand-tinted OF/Fansly/JFF CTAs), platform switcher pills + brand-tinted paid link-out cards, feed tabs.
- Reels: full-viewport slides, one playing video, buffer-ahead (not on data-saver/2G/3G), baked ambient backdrop, compositor progress bar.
- Accessibility: visible two-tone focus ring (inside media on cards), named controls, alt text, reduced-motion collapses durations and disables orbit/shader/reveals.

## What not to do

- No new visual language, no React, no card frames or caption blocks, no scale-on-load, no per-card save listeners, no galaxy/admin preload on public pages.
