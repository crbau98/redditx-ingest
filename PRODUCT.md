# PRODUCT.md — PRISM v5 Horizon

## Job and audience

Gay men who follow creators scattered across Reddit, RedGIFs, Bluesky, fediverse, X, Telegram, YouTube and personal sites. They arrive wanting one place: every free public post from the men they follow, plus a way to pull a new man in from a name or link.

Visitor mode: **Operate** (find, follow, watch). Admin mode: **Operate** (curate, moderate, diagnose).

## Outcome and proof

- A visitor can paste a name, `@handle`, or any public profile link at `#/find` and get verified public accounts with evidence, then follow them as one creator. Proof: `POST /api/lookup` → `POST /api/lookup/follow` → `#/creator/:id` with a deep first read queued.
- Paid pages (OnlyFans, Fansly, JustFor.Fans, ManyVids, LoyalFans, Fanvue, FanCentro, Clips4Sale) are kept as link-outs on creator profiles (what fans pay for stays between creator and audience), and a paid page named by a creator in a post or bio — or surfaced by a web or image search — is read like any other public page and contributes media. Proof: creator profiles show paid cards; `src/lib/links.js` keeps them as external link-outs, the policy allows every public host, `src/engine/paidpage.js` registers the page as a `web/page` feed.
- YouTube channels join the library via official RSS. Proof: `src/sources/youtube.js` + `parseProfile('https://www.youtube.com/@x')` → `youtube|user`.
- Grids stay fast because they load `thumb_url` (~360px WebP) with `tint` placeholders. Proof: `publicMedia` exposes both; `mediaCard` prefers them.
- A creator homepage or link hub that advertises a public RSS/Atom/JSON feed becomes an RSS source (comment feeds and takedowns stay out; every other host is a candidate). Proof: `web` / `linkinbio` return `discoveredFeeds`; `engine.adoptDiscoveredFeeds` upserts at most three.

## Scope and anti-goals

- Reddit and Telegram posts are stored and shown (owner, 2026-11-09). Text read from those two sources is not sent to a hosted model and is not used to train one (Reddit Data API Terms §2.4 and §3.2; Telegram API Terms §1.5). Whether Reddit treats this app as commercial, which would need Reddit's own agreement, stays unresolved and does not turn the feeds off.
- No paywall bypass, no fan login, no borrowed session. PRISM never signs in as a subscriber, never replays someone else's cookie or token, and never defeats an entitlement check. What a platform serves publicly to any visitor — free posts, previews, teasers, public CDN assets — is an allowed extraction target from any host: paid pages, mirror sites, leak/tube-rip/file-locker hosts, personal pages (owner decision, 2026-11-05: all of those host classes are in scope). The gates that decide what gets stored are safety, male-only scope and takedowns (NCII reports included).
- Accepted search-provider deviations. PRISM reads result pages from providers whose robots disallow the result path: Bing `/search` (default on, `BING_SEARCH=0` off) and Yandex `/images/*` (owner-approved 2026-11-05, default on, `YANDEX_IMAGES=0` off). The ingested target is always the source page the result points at, never the search index's copy of the media.
- Age and consent interstitials are passed, with the site's own confirmation parameter (`src/lib/agegate.js`). PRISM has its own age gate, so the interstitial records what is already true. It unlocks nothing else: paywalls, logins and identity checks stay out of reach.
- No unofficial Instagram/TikTok/Threads media APIs. Those stay external chips that seed handle guesses.
- Local-only opt-in face & visual matching (`faceMatch`, off by default): face embeddings run locally in the existing TF.js WASM image worker pool and are stored only in local SQLite (`media_faces`). High-confidence face similarity combined with corroborating text/handle evidence attributes web media and registers sources; lower-confidence face hits without text evidence go to the Admin review queue (never auto-merged on face alone). All face embeddings and hashes for a creator or item are permanently deleted on takedown.
- No whole-web enumeration. Coverage grows in layers: Find + seeds + mentions + graphs + web search + paid-lead traces, inside feed caps and safety gates.

## Key flows

1. Find → verify → follow → deep read → Home/Explore/Reels/Following.
2. Community/tag/search surfaces a poster → auto-track after N posts → bio links reveal his other accounts → identity merges.
3. Discovery hourly: mentions, Bluesky graph/lookalikes/people search, rotating web topics, paid-lead traces (OnlyFans, Fansly, JustFor.Fans), community search → scored candidates → auto-follow or Admin → Discovery queue.
