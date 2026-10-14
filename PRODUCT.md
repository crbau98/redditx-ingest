# PRODUCT.md — PRISM v5 Horizon

## Job and audience

Gay men who follow creators scattered across Reddit, RedGIFs, Bluesky, fediverse, X, Telegram, YouTube and personal sites. They arrive wanting one place: every free public post from the men they follow, plus a way to pull a new man in from a name or link.

Visitor mode: **Operate** (find, follow, watch). Admin mode: **Operate** (curate, moderate, diagnose).

## Outcome and proof

- A visitor can paste a name, `@handle`, or any public profile link at `#/find` and get verified public accounts with evidence, then follow them as one creator. Proof: `POST /api/lookup` → `POST /api/lookup/follow` → `#/creator/:id` with a deep first read queued.
- Paid pages (OnlyFans, Fansly, JustFor.Fans, others) are link-outs only. Proof: creator profiles show paid cards; `onlyfans.com` and siblings are never fetched (`src/lib/leaks.js`, `src/lib/links.js` EXTERNAL).
- YouTube channels join the library via official RSS. Proof: `src/sources/youtube.js` + `parseProfile('https://www.youtube.com/@x')` → `youtube|user`.
- Grids stay fast because they load `thumb_url` (~360px WebP) with `tint` placeholders. Proof: `publicMedia` exposes both; `mediaCard` prefers them.

## Scope and anti-goals

- No paywall scraping or proxying. No leak/tube-rip/file-locker ingestion (blocked in `src/lib/leaks.js` + pipeline).
- No unofficial Instagram/TikTok/Threads media APIs. Those stay external chips that seed handle guesses.
- No biometric face-match identity. Merges use only self-published evidence (bio links, same paid page, same link page + shared name).
- No whole-web enumeration. Coverage grows in layers: Find + seeds + mentions + graphs + web search + paid-lead traces, inside feed caps and safety gates.

## Key flows

1. Find → verify → follow → deep read → Home/Explore/Reels/Following.
2. Community/tag/search surfaces a poster → auto-track after N posts → bio links reveal his other accounts → identity merges.
3. Discovery hourly: mentions, Bluesky graph/lookalikes/people search, rotating web topics, OnlyFans-lead traces, community search → scored candidates → auto-follow or Admin → Discovery queue.
