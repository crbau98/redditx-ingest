# UI changelog

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
