# PRISM

**Creator-centric adult media discovery.** PRISM follows male creators across the open web — Reddit, RedGIFs, Bluesky, Mastodon, Misskey/Sharkey, Lemmy, X, Telegram, RSS/Atom feeds, personal sites and link-in-bio pages — and presents their photos and videos in one fast, searchable, mobile-first app, with a safety gate, a takedown flow and an admin console.

> Adults only (18+). The server enforces an age gate on every content endpoint.

---

## What's new in v4

| | v3 | v4 |
|---|---|---|
| **Model** | Source-centric (hard-coded subreddits & queries) | **Creator-centric**: follow a *person* once, PRISM follows all of their public accounts |
| **Sources** | Reddit, X, RedGIFs (+ brittle DDG scraping) | Reddit, RedGIFs, Bluesky, Mastodon, Lemmy, X, **RSS/Atom/JSON Feed**, web pages, link-in-bio crawler |
| **Reliability** | One-shot scans | Scheduler, per-feed intervals, exponential backoff, per-platform **circuit breakers**, politeness limiter, Reddit transport ladder (OAuth → JSON → old → RSS → archive) |
| **Discovery** | Manual | Communities → creators auto-followed after N posts → bios & link-in-bio pages reveal their other accounts |
| **Safety** | None | Minor-safety gate on every item, creator profile check, report/takedown flow, permanent blocklist, retroactive library sweep |
| **Security** | Open admin by default, string-matched SSRF filter, client-side age gate | Admin fails closed, DNS-validated SSRF guard, server-side age gate, strict CSP, no `innerHTML` |
| **Media** | Silent video, no seeking | HTTP **Range** (seeking), **HLS** with audio, on-disk image cache, hover/in-view previews |
| **Data** | Ingest time only, `LIKE` search, galleries truncated | Original post time, **FTS5** search, every gallery image, creators with cross-platform links, versioned migrations |
| **UI** | Basic grid | New design system (dark/light), discover home, filters, creator profiles, immersive viewer, saved & following, full admin console |
| **Discovery** (v4.1) | Search box | Autocomplete (creators · tags · communities), Browse page, *Similar creators*, a *From creators you follow* rail and Following filter |
| **Operations** (v4.1) | – | Nightly SQLite backups with retention, config export/import, audit log, duplicate-creator review, installable offline shell (PWA) |
| **Watching** (v4.2) | Grid only | **Reels** — full-screen vertical swipe feed (keyboard, double-tap to save, one playing video at a time — v4.8 buffers the next one), *Play as Reels* from any search, profile or smart feed |
| **Personal library** (v4.2) | Saved list | **Collections** (named boards), **smart feeds** (saved searches with “N new since last visit”), **history** with *Hide seen*, one-file library export/import |
| **Navigation** (v4.2) | Search box | **Command palette** (Ctrl/⌘ K), `g`-prefixed jumps, `x` = Surprise me, global `?` help |
| **Insight** (v4.2) | – | Creator **activity heatmap**, source split and usual posting hours; **Rising this week** rail; admin ingest-per-day chart by source |
| **Auto-discovery** (v4.3) | Communities only | A **discovery engine** that finds creators you don't follow yet — who your creators **mention** and **follow** (Bluesky graph), **Brave web search** on rotating topics, and **identity search** that finds a known creator's other accounts — scores every lead, follows strong male-focused ones automatically and queues the rest in **Admin → Discovery** |
| **Personal** (v4.3) | – | **For you**: a taste model learned on the device (views, saves, collections, follows) drives a For you rail, Explore sort and Reels mode; first-visit **interest picker**; Display sheet with **accent colours**, theme, density, previews |
| **Efficiency** (v4.3) | Fixed intervals | **Adaptive scheduling** (busy feeds checked sooner, quiet ones later), X API **monthly read budget** with keyless fallback, Brave daily budget, count-free paging, new indexes |
| **Look & feel** (v4.4) | Flat | **Live WebGL "prism light" hero** (hand-written shader, accent-coloured, adapts to the GPU), a **3D orbit** of trending media (drag to spin), **ambient glow** behind the viewer, the viewer **zooming out of the card** you tapped, **3D tilt + glare** on cards, even rails with arrows and fading edges, scroll-driven reveals, heart bursts, a floating glass tab bar on phones — see [`UI_CHANGELOG.md`](UI_CHANGELOG.md) |
| **Constellation** (v4.5) | – | **Creator galaxy** (`#/galaxy`): every active creator as a glowing star in a 3D map, linked to the creators whose posts they most resemble — drag/pinch/scroll, search to fly, colour-coded styles. **Viewer zoom & pan** (wheel, click, pinch, drag, + / − / 0) and a **filmstrip**. **Chameleon profiles** that take their colours from the creator's own art. Haptic tap on save (Android). |
| **Insight** (v4.6) | Keyword search | **Plain-language search**: type “bearded guys at the beach, videos this week” and it is read into filters (tags, creator, photos/videos, time, source, sort) from the library's own vocabulary — plurals, “bearded”→#beard, typo fixes (“musscle”→#muscle), multi-word tags — with an **“Understood as” banner** of removable chips and a live preview in the search dropdown. When nothing matches everything, it **drops the least important filter and says so**. **Related tags** (“Narrow with”) from co-occurrence lift, automatic **Topics** (clusters of tags that travel together) on Home and Browse, and **“Because you watch #tag”** rails. Discovery now **reaches communities and custom feeds**: NSFW subreddit search, Lemmy community lists and popular Bluesky feeds by keyword, X profile lookups for bios and follower counts, and **audience size** counts toward a lead's score |
| **Velocity** (v4.7) | – | **Fast at any size**: measured on a generated 60,000-item library, every public endpoint now answers in single-digit to low-double-digit milliseconds (search was 56 s → 11 ms; related tags, similar creators, For you, listings 10–200× faster). The app shell ships **versioned, permanently cached** code with **parallel module preloading**, fonts no longer block the first paint, back-navigation re-uses data instantly, and hovering a creator pre-loads their profile. **Search shows live results while you type.** **For you** cards say *why* they were picked. Discovery finds more people on its own: **Bluesky lookalikes** of your creators, **people search** on Bluesky and RedGIFs, and **communities where your creators already post** — with a per-signal "followed creators now posting" report |
| **Self-healing** (v4.8) | – | **Link health**: when media is deleted at its source, PRISM notices and takes it down by itself — viewers' browsers report items that fail to load, a slow background sweep re-checks the library, and the server verifies every report at the source (an item is hidden only after two "gone" verdicts an hour apart; hotlink blocks and outages never hide anything). **Since your last visit** on Home: what is new from creators you follow, across the library and among newly discovered creators, each one tap from a filtered view. **Reels buffer the next video** while the current one plays (not on data-saver or slow links), so swiping is instant. Accessibility audit of every page and the viewer in both themes: no unnamed controls, no images without alt text, visible focus everywhere |
| **Male-only & reach** (v4.9) | Soft scope check | A **strict male-only policy**: female, feminine and trans-feminine wording (women, wife, f4m/`[F]` tags, she/her, femboy, sissy, crossdresser, trans, shemale/ladyboy and the same words in other languages) now excludes an item **even on a trusted feed**, and ambiguous wording (lingerie, panties, “pussy”, non-binary…) always goes to the review queue. The same check runs on creator handles/names/bios, admin adds, discovery leads and config import; a female/feminine creator is **blocked as a person** (media removed, accounts remembered). A one-time **retroactive sweep** removes existing content, blocks creators and switches off feeds named for women. **New sources**: Tumblr (blogs + tags), PeerTube (accounts, channels, tags, federated keyword search); wider default Mastodon / Misskey / Lemmy instance lists; ~70 seed feeds incl. hashtag feeds on many servers; far more discovery topics. Reddit/fediverse audit fixes and `scripts/diagnose-sources.js` (a live self-test for your own deployment) |
| **OnlyFans creators** (v4.14) | OnlyFans links kept as plain chips | **OnlyFans awareness without touching the paywall**: every OnlyFans page named in a bio, a post (including bare `onlyfans.com/name` and "OnlyFans: @name"), or a web search result is recorded. A page a creator names under his own handle is put on his profile; pages that others promote (shout-outs, promo channels) become **leads** that discovery traces to the same man's **free public accounts** on RedGIFs, Bluesky, X, Telegram and link pages. An account whose profile links that exact page is *proven* (+6) and, when followed creators promoted the page, auto-follows; a same-handle match is a weaker +2. Creators who already have a page get the same search, and what it finds is linked to them, so their content from around the web lands on one profile. In the app: an **OF badge** on creator cards (green when the page says it is free), a **Free OnlyFans / OnlyFans** button on profiles, an **OnlyFans** filter on Creators, and a **"More OnlyFans creators like him"** rail. Admin → Discovery has an **OnlyFans creators** panel (paste pages to trace, see what each was traced to). **Creators to find by name** (`creatorSeeds`, seeded with Christian Hogue, Jakipz, Michael Yerger, Chase Stobbe and HotAlex): discovery runs the full creator lookup on two names per run, follows each man's strong verified accounts as one creator, puts his OnlyFans page on his profile, re-checks monthly, and turns pages that come up next to his name ("creators like him") into leads. `onlyfans.com` is never fetched; paywalled or leaked content is never ingested. Setting: `discoveryOnlyFans`. |
| **Fluid** (v4.13) | – | **Smoother everywhere, measured**: a finished feed no longer repaints itself (idle Explore did ~2.4 s of rendering work every 3 s), flinging through a long feed on a phone went from 9 to 31 fps in the audit, Reels swipes do a fifth of the raster work (backdrops baked once, no blur over playing video), and the Reels progress bar runs smoothly on the compositor. Spring-physics press and save feedback, a staged caption reveal in Reels, and `scripts/perf-audit.js` to re-measure load, feed scrolling and Reels. See `UI_CHANGELOG.md`. |
| **Telegram, whole account** (v4.12) | Public channels only, short window | Log in once (`scripts/telegram-login.js`) and PRISM follows **every channel and group your account has joined**, public or private, via MTProto: new posts, plus history back-filled gradually. Files are copied to a private S3-compatible bucket (Cloudflare R2 / Backblaze B2 / MinIO; no SigV4 SDK, nothing on the server) **only after** the text gates and duplicate check accept a post, and removed again if the picture filter rejects it; PRISM streams them back through its media proxy with Range support. A sync adds channels you join and retires the ones you leave; female-named channels are never followed. See `deploy/README.md` §3c. |
| **Duplicates** (v4.11) | Same picture re-posted everywhere | **Perceptual-hash duplicate detection**: every picture (or video poster) gets a 128-bit fingerprint (DCT pHash + dHash) that survives resizing, re-compression and small edits. A look-alike of something already in the library is not stored twice: it is listed on the original as **Also on …** (platform, author, link). Removing a picture (or excluding it for showing a woman) also blocks its look-alikes from coming back. Lookups use an in-memory multi-index (about 13 ms at 500k pictures, ~47 MB at 100k); a background hash sweep fingerprints and collapses the existing library. Settings: `dedupe`, `dedupeDistance` (0–7, default 6). The face model now runs in a worker-thread pool (`IMAGE_WORKERS`, default min(3, cpus−1), 0 = in-process) so a busy filter no longer freezes the server. |
| **Pictures & people** (v4.10) | Text-only scope | An **image filter** that looks at the picture itself: an on-device face + gender model (no cloud, nothing leaves the server) excludes any photo or video poster in which a woman's face is detected, remembers it by hash, and blocks accounts after three offences; a background sweep re-checks the existing library. **Find a creator** (Admin → Creators): type a name, performer name, @handle or link and PRISM probes the handle on every platform, searches Bluesky/RedGIFs/the web (Brave or SearXNG), reads bios and link-in-bio pages for the rest, verifies each account through its real adapter, shows the evidence and confidence, and follows the chosen accounts as **one creator** with a deep first read. **Faster ingestion**: 4 feeds at once (was 2), 4 items of a run processed in parallel, web search with provider fallback and caching |
| **Sources** (v4.2) | – | **Misskey/Sharkey/Firefish** adapter (+ auto-detection behind Mastodon-looking links), **Bluesky custom feeds & lists**, **OPML import** from any feed reader |

---

## Quick start

```bash
npm install
cp .env.example .env        # optional
npm start                   # http://localhost:3141
```

First run seeds 55+ curated default feeds and migrates any v3 database in place. Open **Admin** (gear icon, or `#/admin`) → **Sync everything now**. Visitors can also pull a creator in directly at `#/find` (name, @handle, or any public link).

### Preview the UI offline (no network, no real content)

```bash
DEMO_ART=1 DB_PATH=./data/demo.db node scripts/seed-demo.js     # procedurally generated placeholder art
DEMO_ART=1 DB_PATH=./data/demo.db ADMIN_KEY=dev node server.js
```

### Tests

```bash
npm test      # full suite (safety, SSRF, migration from a real v3 DB, adapters, engine resilience, HTTP API, proxy)
```

---

## Concepts

- **Feed** – anything PRISM keeps in sync: a subreddit, a hashtag, a search, an RSS URL, or one creator's account. Each has its own interval, health, cursor and backoff.
- **Creator** – a person. Owns many feeds (accounts) and many media. External links (OnlyFans, Throne…) are kept for display.
- **Trusted feed** – an admin-vouched male-focused source. Trusted feeds only drop clearly female-tagged posts; untrusted ones (open searches/hashtags) need a positive male signal or go to the review queue.

### Adding people (the recommended way)

Admin → **Creators → Add creator**, paste any of their public links, one per line:

```
https://x.com/name
https://bsky.app/profile/name.bsky.social
u/name
https://www.redgifs.com/users/name
https://linktr.ee/name          ← crawled for more accounts
https://onlyfans.com/name       ← shown on their profile, never scraped
@name@misskey.io                ← Misskey-family servers get their own adapter
```

PRISM follows every public account, keeps their media on one profile, and reads their bios/link pages to find more accounts.

### How "all creators across the web" actually works

No system can enumerate "the whole web". PRISM grows its coverage in layers:

1. **Communities, hashtags and searches** surface creators; a creator who posts ≥ N times (default 2) is auto-followed on that platform.
2. **Bios and link-in-bio pages** expose a creator's accounts elsewhere, which are followed too (Telegram descriptions are read in full with a bot token).
3. **Discovery** (Admin → Discovery, runs hourly) looks *beyond* what is already followed and scores every lead on independent signals:

   | Signal | Where it comes from | Points |
   |---|---|---|
   | same name | Brave search for a known creator's exact handle finds another account (→ attached to that creator) | 6 |
   | mentioned | a followed creator @-mentions or links the account (collabs, shout-outs) — per distinct creator, max 5 | 3 |
   | followed by | followed Bluesky creators follow the account — per distinct creator, max 8 | 1.5 |
   | web search | a rotating Brave search topic (editable) returns the profile, or a community keyword search finds the subreddit / Lemmy community / Bluesky feed — max 3 | 2 |
   | looks like | Bluesky lists the account among those most similar to a followed creator — per creator, max 4 (v4.7) | 2 |
   | creators post here | a subreddit / Lemmy community where several followed creators already post — per creator, max 6 (v4.7) | 1.5 |
   | audience | subscribers, followers or feed likes (Reddit, Lemmy, Bluesky, X, RedGIFs) — log-scaled: 100 → +1, 1k → +2, 10k+ → +3 | ≤ 3 |
   | bio | male-focused name/bio +2 · female-focused −20 · any minor-safety hit rejects permanently, borderline wording waits for a human | |

   At the auto-follow score (default 8) a male-focused lead is followed automatically (capped per run and by the feed cap); everything else waits in the queue with its reasons, where one click follows, rejects or blocks it.

   **Communities and custom feeds** (v4.6): two keywords per run (editable, rotating) are searched on Reddit (NSFW subreddits only) and Bluesky (custom feeds whose name/description reads adult), and the busiest NSFW communities on each `LEMMY_INSTANCES` server are listed once a day. They are held to a stricter bar than people — borderline wording such as “teen” drops them outright instead of queueing them — and a strong, male-focused one is auto-followed only while *Auto-follow strong communities* is on, as an **untrusted** feed: every post from it still passes the scope and safety checks one by one. A community you follow by hand is trusted, as before.

   **People search** (v4.7): one rotating keyword per run is searched on Bluesky (account search) and RedGIFs (the creators behind the top results, with follower counts). Only accounts with unmistakable creator wording (OnlyFans, 18+, NSFW, creator/model, link-in-bio…) or an adult label become leads. X leads get their bio, avatar and follower count from one batched users lookup per run (counts against the monthly X read budget; skipped when it is spent).
4. Anything with an **RSS/Atom feed** (or an OPML list) can be followed directly — the most stable path.

---

## Sources

| Source | Kinds | Needs | Notes |
|---|---|---|---|
| Reddit | community, user | – (optional `REDDIT_CLIENT_ID/SECRET`) | Falls back OAuth → www JSON → old.reddit → RSS → Arctic Shift archive. Galleries, video (+HLS), GIF→MP4, crossposts, RedGIFs links resolved. |
| RedGIFs | user, search, niche | – | Public guest-token API. |
| Bluesky | user, search, feedgen, list | search: `BSKY_IDENTIFIER` + `BSKY_APP_PASSWORD` | Media-only author feeds; video via HLS. Paste a custom feed (`bsky.app/profile/…/feed/…`) or list (`…/lists/…`) link to follow a curated stream; its posters become creators like any community. |
| Mastodon | user, tag | – (optional token) | Any Mastodon-compatible server; some require sign-in for public timelines. If a server turns out to run Misskey-family software (detected via NodeInfo), the feed is read through the Misskey API automatically. |
| Misskey | user, tag | – | Misskey, Sharkey, Firefish, Iceshrimp, Catodon… Hashtags are searched on `MISSKEY_INSTANCES` (default `misskey.io`) or `tag@instance`. Paste `@name@host`, a `https://host/@name` link, or `misskey:name@host`. |
| Lemmy | community, user | – | API v3 with v4 fallback. |
| X | user, search | `X_BEARER_TOKEN` (search); users work keyless best-effort | Official API when a token is present. |
| Tumblr | user (blog), tag | – | Public RSS. Reblogs skipped (`TUMBLR_REBLOGS=true` to include), images upgraded to the largest size. |
| PeerTube | user, channel, tag, search | – | Documented public API; keyword search through Sepia Search (`PEERTUBE_SEARCH_URL`), tags across `PEERTUBE_INSTANCES`. MP4 up to 1080p, else HLS. |
| YouTube | user, channel | – | Official channel RSS only (no key). Paste `@handle`, channel URL, or `UC…` channel_id. Videos appear as thumbnail cards linking out to YouTube. No search feeds. |
| Telegram | user (public channel) | – | Public web preview (`t.me/s/<channel>`); channels that disable it report an error. |
| Telegram | channel (joined by your account) | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, a one-time login (`scripts/telegram-login.js`), `MEDIA_STORE_*` | Every channel/group your account has joined, public or private (MTProto via GramJS): full history back-filled gradually, original photos and videos copied into your R2/B2 bucket (Telegram files cannot be hotlinked). Feeds are created and retired by the sync. |
| RSS / Atom / JSON Feed | feed | – | Creator sites, Tumblr `/rss`, Mastodon `.rss`, Bluesky `/rss`, … Bulk import accepts **OPML** exported from any feed reader. |
| Web page | page | – (optional Browser4) | OpenGraph, `<video>`, linked images; honours `robots.txt`. JavaScript-built pages (SPAs, infinite scroll, lazy galleries) are read in a real browser when [Browser4](#browser4-rendering-javascript-built-pages) is enabled. |
| Link-in-bio | page | – (optional Browser4) | Discovers a creator's other accounts; never yields media itself. Hubs built by JavaScript are read in the browser. |

**Deliberately not supported:** paywalled/subscription platforms (OnlyFans, Fansly, Patreon…). Reading them means circumventing access control and republishing paid content. PRISM keeps those links on a creator's profile so fans can support them directly.

---

## Browser4 rendering (JavaScript-built pages)

Many sites ship an empty HTML shell and build their pictures, "next page" link and lists of galleries with JavaScript, and load more as you scroll. A plain download sees nothing. With [Browser4](https://browser4.io) (`browser4-cli`: a real Chrome driven over CDP) PRISM loads the page, scrolls it, and hands the **finished DOM** to the same parser the plain path uses, so everything downstream (robots.txt, `noindex`/`nopin` opt-outs, takedowns, leak and paywall hosts, the safety, male-only, picture and duplicate gates) behaves exactly as before. Browser4 changes *how a page is read*, never *what is allowed*.

**Set it up** (on the machine that runs PRISM; it is **not** in the default Docker image, which has no Chrome):

```bash
npm i -g browser4-cli && browser4-cli install      # the CLI + its runtime (bundles its own JRE)
# needs Chrome or Chromium on the host. Use version <= 153 for now: Browser4 4.15.1 rejects the
# "File-Path-Style" field Chrome 156+ adds to /json/version and fails with "createDevTools".
BROWSER4_ENABLED=1 npm start                        # BROWSER4_HEADED=1 shows the window (needs a display)
```

**How it is used** (Admin → Settings → Sources, all runtime-editable):

| Setting | Default | |
|---|---|---|
| `browser4Mode` | `fallback` | `off` · `fallback` = only when the plain download **succeeded but showed no media** · `always` = every web page (the richer of the two reads wins) |
| `browser4Scrolls` | 8 | scrolls to the bottom per page (stops early once the page stops growing) |
| `browser4Pages` | 3 | "next page" links followed per run (same site only, `robots.txt` honoured) |
| `browser4AutoExpand` | off | follow a page's same-site links as new **untrusted** web feeds; feeds made this way never expand again |
| `browser4ExpandPerRun` | 5 | new feeds one run may add (also bounded by *Cap on enabled feeds*) |

**What it will not do:**

- **Get around a refusal.** A `403`/`429` is never retried through the browser, and a page that answers with a bot-challenge (Cloudflare, CAPTCHA…) ends the render. Nothing is solved or evaded.
- **Go where PRISM does not go.** A browser bypasses `lib/net.js`'s connect-time DNS guard, so there are three layers:
  1. *Before navigation* (the start URL and every "next page" / expansion URL): non-http(s) schemes, URLs with credentials, private/loopback/link-local/metadata addresses **including what the name resolves to**, leak sites, paywalled hosts and takedown matches are refused.
  2. *Inside the browser* (on whenever private hosts are refused, i.e. production; `BROWSER4_BLOCK_PRIVATE` overrides): requests to literal private, loopback and link-local addresses and local names (`127.*`, `10.*`, `172.16–31.*`, `192.168.*`, `169.254.*`, `localhost`, `*.local`, `*.internal`, IPv6 loopback/ULA/link-local) are **aborted before they are sent**, via CDP request interception. That covers redirect hops, images, scripts and XHR. If the routes cannot be registered, no page is loaded.
  3. *Afterwards*: where the browser ended up is checked again.

  *Limits, stated plainly:* the browser-level block matches URL patterns, not resolved addresses, so a public-looking **name** that resolves to a private address inside a redirect or sub-request is not stopped; redirect hops to leak/paywalled hosts are noticed only afterwards (the page is discarded, but the request was made); and carrier-grade NAT (`100.64.0.0/10`) is not in the pattern list. On a shared network also firewall the Browser4 host away from private ranges.
- **Run a shell.** The CLI is started with an argument array; URLs are only ever arguments.

**Growing the library.** Besides per-run pagination and scrolling:

```bash
# a human-facing run: visible browser, read a page, follow its links, ingest everything through the real engine
node scripts/browser4-ingest.js --headed --expand --depth 1 --limit 25 https://example.com/gallery
# or from the admin API (runs in the background; poll GET /api/admin/browser4)
curl -X POST -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' \
     -d '{"url":"https://example.com/gallery","depth":1,"limit":25}' http://localhost:3141/api/admin/browser4/expand
```

Expansion is bounded on purpose (same site only, depth ≤ 2, ≤ 100 feeds per call, never past the feed cap, login/cart/legal pages and files skipped) and every feed it creates is untrusted: each item still needs a male-focus signal before the other gates apply.

**Tests.** `npm test` includes the Browser4 suites against a fake `browser4-cli` (no Chrome needed). The real browser is exercised by an opt-in suite against a JavaScript-built fixture site: `BROWSER4_LIVE=1 node --test tests/browser4.live.test.js` (with a `DISPLAY`, the window is shown).

---

## Verifying the sources

**Verified live (v4.10.1)** from a datacenter IP through the real engine, filters and image model: Reddit (via the archive fallback — Reddit blocks anonymous datacenter reads, set `REDDIT_CLIENT_ID/SECRET`), RedGIFs niches, Lemmy, Mastodon, Misskey, PeerTube, Telegram, Bluesky user feeds, Tumblr blogs and RSS all returned content that passed the gates and whose media loads. Needing credentials or a better IP: Reddit OAuth, Bluesky search (app password), X (token), `lemmynsfw.com` images (Cloudflare challenges some datacenter IPs — such items are skipped and logged instead of being published unloadable), Brave/SearXNG web search. Findings that changed the code: RedGIFs free-text search returns ~75% female-tagged results (replaced by curated niches), Tumblr removed site-wide tag feeds, Reddit's edge answers blocked requests with bare 404s (a community is now "gone" only when every transport agrees).

Sources depend on the open web, so check them from the machine that runs PRISM (a sandbox without outbound network cannot):

```bash
node scripts/diagnose-sources.js                  # every platform, 1-2 sample feeds each
node scripts/diagnose-sources.js --platform reddit,redgifs --limit 10
node scripts/diagnose-sources.js --target reddit:community:gaybrosgonewild
node scripts/diagnose-sources.js --json
```

It uses the real adapters and the real safety + male-only gates but writes nothing (throwaway database). Per source it prints whether it answered, how many items came back, how many would be published / reviewed / excluded / blocked, whether the first media URL actually loads, and a fix hint when it fails (e.g. Reddit blocking datacenter IPs → set `REDDIT_CLIENT_ID/SECRET`). Exit code 1 if a configured source returned nothing usable. Runs that add nothing also log *why* (`No new items: fetched 25 · 25 already stored`).

## Safety & takedowns

- **Safety gate** (`src/lib/safety.js`) runs on every item (title, tags, community, handle, bio, alt text): explicit minor terms and any stated age under 18 (`16yo`, `I'm 15`, `[M17]`, "sixteen"…) are **dropped, never stored**; borderline wording (`teen`, `high school`…) goes to the **review queue**. It errs on the side of dropping. A creator whose bio indicates a minor is blocked immediately, and their other accounts are never followed.
- **Report button** on every item and creator, plus a footer takedown form (works without the age gate). Reports about minors or consent **hide the item instantly**; admins then remove-and-blocklist, block the creator, restore, or dismiss.
- **Male-only scope** (`src/lib/scope.js`): HARD female / feminine / trans-feminine terms exclude an item whatever else the text says and however much the feed is trusted; SOFT terms (also used in gay-male posts, or merely feminine-adjacent) always wait in the review queue, even when *Unclear male-focus items* is set to open. Creators whose handle, name or bio reads female are blocked as people. The sweep (Admin → Settings → Maintenance, and once on upgrade) applies it to everything stored.
- **Image filter** (`src/lib/imagefilter.js`, v4.10): every candidate picture (a photo, or a video's poster frame) goes through an on-device face detector + gender classifier ([Human](https://github.com/vladmandic/human): BlazeFace + FaceRes on the TensorFlow.js WebAssembly backend; the weights ship inside the npm package, nothing is downloaded and no image is sent anywhere). A face classified female at or above the threshold (Admin → Settings, default 50 %, lower = stricter) excludes the item, remembers it by hash, and counts against the account (three strikes block it). **No face (torso / body shots, art) = no verdict**: the text gates decide. The packages are `optionalDependencies`; if they are missing the filter reports itself unavailable (Admin → Overview shows it) and the text gates continue alone. A slow background sweep (12 items a minute by default) re-checks what is already stored; `POST /api/admin/maintenance/image-sweep` runs a batch on demand and `GET /api/admin/maintenance/image-filter` shows progress. It is a probabilistic model: expect misses and false positives, review the *Women filtered by picture* count.
- **Body filter** (`src/lib/physique.js` + `src/engine/physique.js`, v4.14): only fit / athletic bodies are shown. In the same worker pass as the face model, MoveNet-Lightning finds the shoulders and hips and a MediaPipe selfie-segmentation model (weights vendored in `models/`, ~300 KB) draws the silhouette of just the torso; the belly is measured across the torso axis and compared with the shoulder span and torso length, giving a **heaviness score 0–100** (0 = V-shaped / lean, 100 = belly as wide as or wider than the shoulders). Arms hanging against the belly are recognised from the elbow / wrist keypoints and that side is not used. **No frontal torso in view (close-ups, crops above the hips, side shots) = no verdict.** Words such as *chubby, superchub, chub, gainer, feeder, dad bod, beer belly, bbm* in an item's own text exclude it before anything is downloaded ("fat cock", "fat load" are slang and do not count); the same words in a creator's handle, name or bio hide the creator, and feeds / Telegram channels / discovery leads named that way are paused or skipped. Pictures at or above the threshold (Admin → Settings, default **60**, lower = stricter) are **hidden, not deleted**, with their score stored: moving the threshold or switching the filter off re-applies to the whole library at once, in both directions. A creator with ≥ 4 measured pictures of which ≥ 50 % (setting) are hidden is hidden too and their feeds paused (reversible the same way). An admin "approve" on a hidden item clears its score so it is never re-hidden. A background sweep measures the existing library (`POST /api/admin/maintenance/physique-sweep` runs a batch; `GET /api/admin/maintenance/image-filter` → `physique` shows counts and a score histogram). It is a geometric heuristic, not a trained judge of attractiveness: baggy clothes, odd angles and group shots can mislead it, so check *Hidden by body filter* on the overview and tune the threshold.
- **Blocklist**: removed media, blocked creators and takedowns are remembered by content hash, source key and account — they are never re-imported.
- **Sweep**: Admin → Settings re-applies today's rules to everything already stored; it also runs automatically once after upgrades (so content ingested by v3, which had no gate, is checked retroactively).
- Saved lists re-validate against the server, so a takedown also disappears from people's saved items.

---

## Finding a creator

`#/find` (also Admin → Creators → **Find a creator**, and *Find more accounts* inside a creator): type a **name, performer name, @handle or profile link**. The public route is age-gated and rate-limited (`POST /api/lookup`, `/lookup/follow`, `/lookup/auto`); admin keeps `POST /api/admin/lookup*`.

1. the handle (and name-derived variants such as `jaxstone`, `jax_stone`) is probed on Reddit, RedGIFs, Bluesky, Mastodon, Misskey, X, Telegram, Tumblr, YouTube, PeerTube and Lemmy through the real adapters, so “found” means *exists and has posts*;
2. Bluesky people search, RedGIFs creator search and a web search of the name (Keenable, Brave and/or a SearXNG instance, tried in that order with fallback and caching — `KEENABLE_API_KEY`, `BRAVE_API_KEY`, `SEARXNG_URL`; site-restricted searches on linktr.ee, bsky.app and x.com find the profile pages themselves) add accounts the handle guess missed;
3. bios and link-in-bio pages (Linktree, Beacons, AllMyLinks…) of what was found reveal the person's other accounts, which are verified the same way; paywalled links (OnlyFans, Throne…) are kept on the profile and never read;
4. every candidate is scored (name similarity, exact handle, cross-links, independent sources, has content) and shown with its evidence; female / feminine candidates, minors and avatars showing a woman are hidden;
5. **Follow selected** creates one creator with all chosen accounts and queues a deep first read (up to 300 posts per account); **Find & follow strong matches** does both steps at once. API: `POST /api/admin/lookup`, `/lookup/follow`, `/lookup/auto`.

## Using PRISM

- **Reels** (`#/reels`): one item at a time, full screen. Swipe or use ↑/↓ (J/K), Space to pause, M for sound, F to save, C to collect, Enter for details, double-tap to save. The next video buffers while the current one plays and the previous one keeps its buffer, so swiping either way starts instantly (skipped on data-saver and 2G/3G connections). Filters: videos/all/photos and trending/shuffle/newest/top; every Explore search, smart feed, profile and the Following list has a *Play as Reels* button.
- **Collections**: press C (or the bookmark) in the viewer or Reels to file anything into named boards; *Your library → Collections* shows covers and plays a board start to finish.
- **Since your last visit** (v4.8): after a break of an hour or more, Home opens with what is new since then — from creators you follow, across the library, and newly discovered creators — each a tap away from Explore filtered to exactly that (a *New since …* chip removes the time filter). A visit is 30 minutes of activity; the time is kept on the device only, and pausing history turns it off.
- **Smart feeds**: in Explore, *Save as feed* stores the exact filter set. Home shows each one with how many items arrived since you last opened it.
- **History & Hide seen**: everything opened in the viewer or Reels is remembered on the device (pause or clear it any time); *Hide seen* filters it out of Explore and Reels.
- **For you**: on first visit pick a few interests; after that PRISM learns from what you open, save, collect and follow (on the device — the server only ever sees a short list of top tags/creators in the request). The rail on Home shows what it is tuned to; remove a tag or reset any time. Also available as an Explore sort and as Reels' default mode.
- **Creator galaxy** (`#/galaxy`, *Creators → Explore as a 3D galaxy*, `g m`): stars are creators, sized by how much they post and coloured by their dominant style; lines join creators whose posts are alike (tf-idf cosine similarity of their tags). Drag to turn, scroll or pinch to zoom, hover/tap a star for its card, click to open; type in the search box and press Enter to fly to someone; tap a style to light up its creators.
- **Graphics adapt to the device**: the hero shader steps its resolution down when frames come in slow and holds a still frame on software rendering (VMs, blocklisted GPUs), where the 3D orbit also stops turning on its own and costly blur effects are trimmed. Reduced-motion settings turn every animation into a static equivalent.
- **Display** (palette icon): theme, six accent colours, grid density, video previews, sound, hide-seen, and pausing history/learning.
- **Command palette**: Ctrl/⌘ K jumps to any page, creator, tag, community, collection or smart feed, and runs actions (theme, shuffle, surprise me). `g h/e/r/c/s` jump to Home/Explore/Reels/Creators/Saved; `x` opens something random; `?` lists every shortcut.
- Everything personal (saved, collections, smart feeds, follows, history) stays in the browser; *Your library → Export* writes it to one file that *Import* merges back on any device.

## Admin console (`#/admin`)

Overview (health, activity, **ingest per day by source**, queues) · **Discovery** (lead queue with scores and reasons, bulk follow/reject/block, tuning, search topics, key status) · Feeds (schedule, status, run-now, bulk import) · Creators (add, merge, block, **possible-duplicate review**) · Review queue · Reports · Media (bulk moderation) · Sources (config & breaker state) · Live log (SSE) · Blocklist · **Audit log** · Settings (**backups, config export/import**, maintenance).

Set `ADMIN_KEY`. **Without it the admin is disabled in production** (open only in development, or with `ADMIN_OPEN=true`).

---

## Operations

- **Backups**: a consistent copy of the database (`VACUUM INTO`, safe while serving) is written nightly to `<db dir>/backups/` and the newest *N* are kept (Admin → Settings; on by default in production). *Back up now* is one click. Put the volume under your host's own snapshots too.
- **Config export / import**: creators, feeds and the blocklist as JSON — no media, no secrets. Import is additive and idempotent (people are matched by their accounts, then by handle) and re-applies the safety gate.
- **Audit log**: every moderation decision — manual or automatic — with actor, target and reason.
- **Offline shell**: the app installs as a PWA and opens offline. The service worker caches only its own static files; API responses and media are never cached.
- **Link health** (v4.8): media that has been deleted at its source is hidden automatically. Two inputs find it — a viewer's browser reporting that an item failed to load (`POST /api/media/:id/broken`, rate-limited, verified at most every 30 minutes per item) and a background sweep every 10 minutes that re-checks the least recently checked published items (40 per sweep by default). The **server** always verifies at the source itself; only a 404/410 or a tiny placeholder image (e.g. imgur's *removed.png*) counts as gone, and an item is hidden only after **two** such verdicts **at least an hour apart**. Hotlink blocks (403), login walls, 5xx and timeouts are "unknown" and never hide anything, so fake reports or a CDN outage cannot take content down. Hidden items carry the reason (*Gone at source (http 404)*) and can be restored from Admin → Media; Admin → Overview shows how many were removed in the last 7 days. Both switches are in Admin → Settings → Maintenance.
- **Retroactive safety**: raising the safety rules bumps a sweep version, so existing libraries are re-checked once on the next boot.

## Configuration

See [`.env.example`](.env.example) for every variable. Runtime behaviour (concurrency, scope strictness, auto-follow, retention…) lives in **Admin → Settings**.

## Deploy (Railway / Docker)

1. Push to GitHub, create a Railway service from the repo (uses the `Dockerfile`).
2. Add a persistent volume at `/data`.
3. Set `ADMIN_KEY` (required) and optionally the source credentials — `X_BEARER_TOKEN`, `BRAVE_API_KEY` (discovery), `TELEGRAM_API_KEY` (a @BotFather bot token), `REDDIT_CLIENT_ID/SECRET`, `BSKY_IDENTIFIER/APP_PASSWORD`. The boot log prints which keys are active. `DB_PATH=/data/prism.db` is the image default.
4. Deploy. Health check: `/api/health`. The scheduler starts automatically in production.

Upgrading from v3 is automatic: the database is migrated in place on first boot (media, creators, accounts, tags and moderation history preserved; media re-hashed so new imports dedupe against old ones).

## Architecture

```
server.js                 bootstrap (listen, engine, graceful shutdown)
src/app.js                Express app: CSP, rate limits, age gate, routes
src/config.js             all environment parsing
src/db/                   schema.js (versioned migrations, FTS5) · repo.js (all SQL)
src/lib/                  net (SSRF-safe client) · safety · scope · links · mediaurl · limiter · media-cache · brave · telegram-bot · telegram-mtproto · objectstore (S3/R2/B2) · sigv4
src/sources/              adapters: reddit redgifs bluesky mastodon misskey lemmy x telegram rss web(+linkinbio)
src/engine/               engine (scheduler/runs, adaptive tempo) · pipeline (per-item gates) · discovery · breaker · probe · health (link health) · creators · maintenance · backup · events (SSE)
src/routes/               public · admin · proxy (media + HLS)
src/services/targets.js   add creators / feeds from pasted links
public/                   vanilla ES modules, no build step (css/, js/, js/views/admin/, vendor/hls)
tests/                    node:test suites + fixtures
```

Adding a source = one file in `src/sources/` implementing `{ platform, kinds, isConfigured, fetch(feed, ctx) }` and one line in `src/sources/index.js`.

## API (public)

`GET /api/media` (`q, type, platform, community, creator, creators, tag, tags=<a,b> (all of), anytags=<a,b> (any of), sort=recent|trending|top|random|oldest|relevance, since, after=<ISO time ingested>, page, limit, ids`) · `GET /api/media/:id` · `/related` · `POST /api/media/:id/like|view|broken` · `GET /api/discover` · `GET /api/creators` · `/creators/:id` · `/creators/:id/media` · `GET /api/suggest?q=` · `GET /api/creators/:id/similar` · `GET /api/creators/:id/activity` · `GET /api/graph` (creator constellation: nodes + similarity links, cached 5 min) · `GET /api/understand?q=` (plain language → filters, chips, spelling fixes) · `GET /api/tags/related?tags=` (co-occurrence lift) · `GET /api/topics` (tag clusters with previews, cached 10 min) · `GET /api/recommend` (`tags, creators, platforms, video, type, exclude, seed, page, limit`) · `GET /api/tags|communities|platforms|stats` · `POST /api/report` · `GET /api/proxy?url=` (Range supported) · `GET /api/hls?url=` · `GET /api/stream` (SSE) · `GET /api/health` · `GET /api/meta`.
Content endpoints require the age cookie from `POST /api/age/confirm`. Admin endpoints live under `/api/admin/*` and require `x-admin-key` (or `Authorization: Bearer`).

---

## Verification status (please read)

- **Tested:** 210 automated tests, including a migration from a real v3 schema, SSRF defences, safety rules, the engine's retry/backoff/breaker behaviour, the HTTP API and the media/HLS proxy. The UI was exercised in a real browser (desktop and phone-sized viewports, dark and light themes), including the viewer with keyboard navigation and deep links, WebM video playback, the age gate, creator add flow, and every admin tab. v4.2's Reels, collections, smart feeds, history/hide-seen, command palette, keyboard shortcuts, creator activity and admin charts were exercised end-to-end in Chromium (39 scripted checks, desktop and phone-sized, no console errors), and the v4.1 browser checks were re-run without regressions. v4.8's link health is covered by 8 tests against a mock origin (404, 410, placeholder, hotlink 403, recovery, report throttling, sweep order, the switch); its browser checks (since-your-last-visit tiles, counts and click-through, the *New since* chip, history-off, a failing card image reporting itself, Reels buffering the next video while only one plays, the admin KPI and settings, phone layout) are 23, and the accessibility audit (6 pages + the viewer, dark and light) is clean. v4.7's versioned shell, live search preview, API cache and hover prefetch, "why" chips and the new discovery settings have 12 browser checks, and v4.2–v4.6 suites (145 checks) were re-run clean; a 60,000-item benchmark and an emulated-4G page-load benchmark are described in UI_CHANGELOG.md. v4.6's smart search (dropdown preview, Enter → filters, chips, spelling fixes, chip removal, related tags, automatic and suggested relaxation, plain-words fallback, hero search), Topics, “Because you watch” rails, smart-feed saving and the new discovery settings have 24 browser checks (desktop + phone, no console errors), with the v4.2–v4.5 suites re-run clean. v4.5's galaxy (drawing, drag, zoom, legend, search-and-fly, card, open profile, cleanup), viewer zoom/pan/filmstrip, double-click save and chameleon profiles have 25 browser checks; v4.4's hero shader, 3D orbit (auto-turn, hover pause, drag, tap-to-open), ambient viewer, card-to-viewer zoom, tilt/glare, rails, heart bursts, reduced-motion and software-rendering fallbacks and the phone tab bar have 26 browser checks of their own. v4.3's interest picker, For you (Home, Explore, Reels), Display/accent settings, Seen markers, Reels hint and the admin Discovery page were checked the same way (32 checks), with the v4.1 and v4.2 suites re-run clean. The discovery engine, Brave/Telegram/X clients, budgets and recommendations are covered by mock-server tests. Touch-swipe gestures and HLS playback (hls.js) were not exercised in a browser.
- **Not verified live:** the adapters' *network* behaviour. The development sandbox blocked outbound access to Reddit, RedGIFs, Bluesky, Mastodon, Misskey, Lemmy, Telegram and X, so each adapter was built against the platforms' documented response shapes and tested with fixtures and local mock servers — not against the live services. Expect to tune small details (field names, rate limits, headers) on first real run. The same applies to v4.3's Brave Search, Telegram Bot API and X API v2 calls, the Bluesky follow-graph reads v4.6's subreddit search, Lemmy community lists, Bluesky feed search and X users lookup, and v4.7's Bluesky account search / similar-accounts and RedGIFs creator search: they follow the documented APIs and are exercised against mock servers, not the live services. The **Admin → Live log**, per-feed error text and **Admin → Discovery** (last run summary, key status) show exactly what each source returned. The keyless X route and unauthenticated Mastodon/Bluesky access depend on those services' current policies, which change.
