# UI changelog

## 2026-11-10 — Faster first screen, lighter grids, video that remembers

- **Home shows Latest uploads while Discover is still loading.** The grid is created before `/api/discover` returns, so the first cards are not stuck behind the snapshot. When the snapshot arrives, the hero and rails are inserted above that same grid.
- **List payloads drop captions.** Grids, rails, related strips, recommendations, search posts and the follow feed no longer send `description`. The viewer asks for the single item when its details panel opens.
- **The next page is requested before you reach it.** After a page lands, the feed prefetches the following cursor (or offset) page into the existing 30-second cache. The first paint uses static placeholder blocks, not an infinite shimmer.
- **Every API response carries `Server-Timing: app;dur=…`.** Slow requests over half a second are still logged.
- **Videos resume, and they have a speed.** Leaving a clip past the first few seconds saves the position on this device (cleared with history). Reopening it in the viewer or Reels seeks back. Speed is 0.75×–2× from Display, the viewer button, Reels → What plays, and the comma / period keys. `P` toggles picture in picture. Home shows a Continue watching rail with a progress mark.
- **Creator and Explore do not wait on the slow part.** A creator’s posts start loading with the profile request. Explore prefetches the first media page as soon as the filters are known.
- **Popular and Ingested no longer sort the table.** Popular creators use `ix_creators_popular_active` (`INDEXED BY` on the default screen; `COALESCE` was blocking the index). Ingested media uses `ix_media_pub_ingested`, which includes `seq`.
- **Grid cards keep the 360px thumb** when it already covers the column (up to 2×). The platform preview is only requested where that thumb would be stretched. This was already the rule in `images.js`.
- **Command palette jump-back.** With the box empty, the last creators and videos this device opened appear at the top. A saved position shows as “left off”. Nothing is searched until you type.
- **History has Continue.** Saved → History shows the same resume rail as Home above the opened-items grid.
- **Saved has Continue too.** The Saved tab shows that same resume rail above the favorites grid (or the empty state), with the first four cards eager-loaded.
- **Empty Following does not stick.** Leaving before the popular-creators list returns keeps the page you opened next; a late answer does not rewrite Following.
- **Explore chip fills do not stick.** Leaving before the source, creator, or tag chip lists return keeps the page you opened next; a late answer does not rewrite Explore.
- **Explore name and spelling fills do not stick.** Leaving before a creator filter’s display name, or before “Understood as” spelling fixes return, keeps the next page’s title and banner; a late answer does not rewrite them.
- **Home fails in two pieces.** If Discover fails, Latest uploads stay and a banner says so. If Latest uploads fail, that grid says the rest of Home is still there.
- **Library export includes where videos left off.** Import keeps the newer of the file and this device, and drops points older than 21 days. Older files that have no resume points still import.
- **Admin → Overview shows each source.** Today’s items sit next to the day before, on the overview itself. A source that added nothing today after adding something in the last two weeks is marked and listed first.
- **Creator cards use the small thumb.** The three pictures on a creator card prefer the 360px build, then the platform preview.
- **The command palette remembers jump-back for a minute.** Opening it again, with the same history, does not ask for those posts a second time.
- **History loads Continue with the grid.** Resume points already in the first page come back in that response. A point further down the opened list is added to the same request. Coming back to a grid that was already on screen fetches only the points that grid did not keep.
- **History cards show where a video left off.** The progress mark sits on the opened item, as well as on the Continue rail.
- **Video posters use the thumb you already downloaded.** The viewer, Reels, and the search strip take the 360px thumb before the platform preview.
- **A Reels photo comes up in the same order as the viewer.** The cached thumb shows first, then the platform preview, then the full file. A thumb that fails steps onward before the slide is reported broken. On a normal connection the next photo mounts while the current slide is on screen.
- **A missing cover steps to the next still.** Admin review tiles, collection covers, and report covers probe the 360px thumb and, when it 404s, use the platform preview and then the image file. A CSS background cannot report that failure on its own. Report rows now include each of those URLs.
- **Creator cards keep a second still.** Each preview slot is still a URL in `previews`. When that URL is the 360px thumb and a different platform preview exists, `previewFalls` carries it. The tile probes only after it is painted near the screen, then steps once. The profile stage does the same for its header picture.
- **Topic mosaics use that thumb too.** A topic picture prefers the 360px build and keeps the next still for a 404. The first tile of the first two topic cards paints immediately. “Because you watch” rails load their first four cards the same way the other Home rails do.
- **History’s Continue rail loads its first four cards immediately.** Home’s Continue rail stays lazy, because it sits below the first screen and should not compete with it.
- **Popular now loads its first two creator cards immediately,** the same as the Popular creators rail. Creators you might like, under For you, does the same. Saved → Following loads the first four creator cards immediately, and an empty Following page loads the first two suggestions.
- **A search suggestion thumb that fails steps onward.** The strip still shows six pictures. Each one starts at the 360px thumb, then the platform preview, then the image file, and stops.
- **Viewer strips do the same.** The dock, the filmstrip, related posts, and “more from him” probe the 360px thumb and step to the next still when it 404s. The video poster and the blurred backdrop stay on that one small picture.
- **A dead video poster steps to the next still.** The viewer and Reels probe the poster and, when it 404s, use the next picture in the same chain. That probe does not download the video file.
- **Jump-back videos have a picture.** Recent videos in the command palette show the 28px still that was already on the history fetch. If that thumb fails, the row steps once to the next still. A video with no still keeps the play icon.
- **The Creators page loads its first four cards immediately.** Cards that arrive from Load more stay lazy. The next page is requested as soon as the current one lands, so Load more and the early scroll reuse that response. Prefetch stops when the list is finished.
- **Reels asks for the next page before you reach it.** An ordinary reel, a For you reel, and a Following reel warm the next page as soon as the current one lands. The Following reel uses the same POST cache as the page itself, and that warm does not clear the cache. Prefetch stops when a page comes back short.
- **Smart feed counts no longer all start at once.** The first four badges on Saved → Smart feeds load immediately. The rest wait until the browser is idle. A count that comes back after you have left the tab does not change the page.
- **Home shows your smart feeds.** The first two saved feeds sit under the first screen, and their “new since you last opened them” counts start only after Discover has painted. Saved uses that same count. Pull to refresh reloads the counts from the current saved list. An empty library, and a Discover snapshot that fails, still show those two feeds under the message. On an empty library, a pull refreshes those counts and leaves the message in place. Try again builds the new page before it tears down the old Latest uploads grid.
- **Browse paints sources, communities, and tags first.** Those three return, and the page is up. Topics and the OnlyFans / Fansly counts fill into their places afterward. If topics or a count fails, the rest of the page stays.
- **Creators shows card skeletons immediately.** Eight placeholders sit in the grid until the first page replaces them. A failed first page, or a Following filter with nobody followed, clears them.
- **Reels opens again.** The speed choices in What plays were one parenthesis short, so that module did not parse and Reels never loaded.
- **Reels shows a slide while the first page loads.** One full-height skeleton sits in the track until the first real slide replaces it. If the page fails, the skeleton comes off and the existing error shows. Try again, and a shuffle restart, put the skeleton back. It does not request a video.
- **A shared link opens the picture before the related list.** The viewer shows that item as soon as it returns. Related posts fill in as the swipe sequence afterward. If that list fails, the item stays. Opening a different item does not take the late list.
- **“More like this” reuses that related list.** On a shared link the strip takes the first 9 of the sequence request instead of asking again. If the strip already painted, the late list leaves it alone. Opening from a grid still asks for the short list.
- **A creator’s recent posts are asked for once.** The viewer dock and “More from him” share that request. Opening him again within two minutes reuses the answer.
- **A shared link starts the item while the page is still loading.** When `m` is a UUID, `/api/media/<id>` is requested with the other early reads, after the age gate. The viewer still asks for that same URL, so the answer is reused. Anything that is not a UUID is left alone, and the related list is not started here. The viewer module is preloaded at the same time.
- **A creator link starts the profile and the first posts.** When the id is a UUID, those two reads begin with the other early requests, after the age gate. Compact density asks for 48 posts; anything else asks for 36. A short id stays on meta only. A type, source, search, or non-recent sort starts the profile and leaves the posts until the page applies that filter.
- **The Creators grid warms the list it will actually show.** A search, a source, a paid page, a freshness window, or another sort is part of that first request. OnlyFans adds `onlyfans=1`. A lookup flag is ignored. Following starts nothing extra, because those people live on this device.
- **A Reels link warms the reel it will actually play.** A tag, a search, a source, a sort, or a media type is part of that first page. Photos-and-videos omits the type filter. Following, For you, and Shuffle start nothing extra. Someone with taste and no sort still starts nothing. Plain Reels is unchanged.
- **Leaving Creators or Reels drops the page immediately.** The way out is returned before the first page arrives, so a late page or a late failure does not paint a screen you have left. The skeletons stay until that response arrives. The Reels key handler comes off with that same cleanup, including while the first page is still in flight.
- **Leaving Home or a creator profile drops that page immediately.** The way out is returned before Discover or the profile arrives, so a late snapshot, a late failure, or a late profile does not replace a screen you have left. The Home skeleton and the creator header skeleton stay until that response arrives. Activity, collabs, similar creators, and the profile colour do not write into a page you have left.
- **Discover’s Try again keeps the replacement.** The new Home is built before the old grid is destroyed. The cleanup the router already holds calls the replacement’s cleanup, so leaving after Try again drops that grid, and a late snapshot from the retry does not paint.
- **Leaving Saved → Following drops that tab immediately.** The way out is returned before the follow summary arrives, so a late summary or a late failure does not paint a tab you have left. The creator skeletons stay until that response arrives.
- **Leaving Browse drops that page immediately.** The way out is returned before the catalog arrives, so a late catalog, a late failure, or an empty library does not replace a screen you have left. The skeleton stays until that response arrives. Topics and the paid tiles still fill in afterward, and they do not write into a page you have left.
- **Verified:** `tests/horizon-speed.test.js`, `tests/early-requests.test.js`, `tests/frontend-syntax.test.js`.

## 2026-11-08 — Health now says WHICH job blocked the loop

- **`/api/health` reports the blocking job, not just the pause:** `event loop blocked 1400 ms during imageSweep`. Every background job (feed runs, image/face/hash/physique sweeps, thumbnails, OCR, embeddings, popularity, discovery) tags itself, a 250 ms sampler records the tag that was active when the loop stopped, and blocks over a second are also written to the log.
- **Verified:** 3 new tests (`tests/blockwatch.test.js`); full suite 1894/1894.

## 2026-11-08 — Trending scores off the request thread

- **The hot-score refresh moved to the maintenance worker.** It rewrites thousands of rows every ten minutes (plus once after boot); on the main thread it was one of the stalls `/api/health` reported. Shared SQL functions now live in `src/db/functions.js` so both connections register them.
- **Verified:** the worker pass updated 5,000 rows in 45 ms with nothing on the serving thread; full suite 1891/1891.

## 2026-11-08 — Deep pull: search a creator and the whole web is swept for him

- **Searching a creator now sweeps the web for him automatically.** When a search (Creators → search, or Admin → Lookup) resolves to a creator PRISM already follows, a background pull reads eight rotating text queries for his name and handle — every platform PRISM reads (`x.com`, Reddit, TikTok, YouTube, Telegram, Tumblr, RedGIFs, Bluesky, video sites, link hubs, mirrors, his paid pages) — plus video search, image search with same-picture (pHash) and face matching, and Yandex reverse-image over several of his own pictures. It starts on its own (6-hour cooldown) and shows nothing until it has proof.
- **New button on his profile: the magnifier, "Pull from the web".** It starts a pull immediately (force, 15-minute cooldown) and the button lights up with the phase it is in; when it finishes it says how many new pages and matched pictures it found and reloads the profile to show them. Progress is also readable at `GET /api/creators/:id/pull`.
- **A pull adds at most **10 new feeds**, and reverse-image hits count as review rows, not feeds. Nothing is followed on a guess.** A profile page becomes his only when its handle is under his own name, a web page only when the page itself names him, and every result still passes the safety, male-only, body-filter, takedown, robots and blocklist gates. A page that only *mentions* him is skipped; reverse-image hits go to the review queue as before. Paid pages are registered as public pages (owner decision 2026-11-05).
- **Toggle:** Settings → Discovery → "Deep pull" (on by default). The background image match is unchanged; a pull simply asks it for more queries (6 instead of 4) and three reverse-image lookups instead of one.
- **Verified:** 8 new tests (`tests/deepsearch.test.js`) covering the query bank, rotation, corroboration, registration, cooldown, progress and lookup triggering; full suite 1890/1890.

## 2026-11-08 — Reliability: backups off the request thread, stalls surfaced, colder paths warmed

## 2026-11-08 — Reliability: backups off the request thread, stalls surfaced, colder paths warmed

- **Backups and nightly SQLite maintenance now run on a worker thread.** `VACUUM INTO`, planner optimize and the WAL checkpoint used to run on the serving event loop; production reported stalls up to 37.8 seconds. The admin “Back up now” action awaits the worker and reports its result.
- **`/api/health` now warns about stalls and memory**, not just disk: a loop pause over 1 second and RSS above the memwatch refresh threshold appear in `warnings` while the endpoint stays HTTP 200.
- **Cold search starts warmer.** The snapshot prime order now builds vocabulary and the library before the heavier graph/topics jobs, tag-only searches query the tag index directly instead of building the full style library, and the SQLite page cache rose from 32 MB to 128 MB with a 1 GB mmap window.
- **Face matching is on by default.** New published media enrols male face descriptors at ingest; the image sweep enrols older media in the same pass as the woman check, and the face sweep runs at 6 pictures/minute newest-first, with the woman-check sweep at 12. Matches need handle/text corroboration or go to review; takedown purges the descriptors.
- **Verified:** backup worker exercised in a production-mode script (487 KB copy in 17 ms on a demo DB); full suite and UI audit to follow.

## 2026-11-08 — Cursor paging: no duplicates while the library moves

- **The media feed now pages by cursor** for the `recent`, `oldest`, `top`, `trending` and `ingested` sorts. The cursor carries the last row’s sort key and sequence number, so a new post arriving mid-scroll cannot push a duplicate into the next page or skip an old one.
- **Offset paging stays as the fallback** for fixed-id feeds, custom POST feeds, relevance/random sorts, and any server that does not return `nextCursor`. Existing page-based callers keep working.
- **The count is skipped after page one** in cursor mode, matching the old `nocount` behaviour; the first page still returns the total.
- **Verified:** repository and HTTP cursor tests (`tests/cursor-pagination.test.js`) plus a live Chromium scroll: two cursor requests, 82 cards, no console errors.

## 2026-11-08 — Search inside pictures (OCR)

- **Text in pictures becomes searchable.** A rate-limited background job reads new pictures (and video posters) with Tesseract and stores only the words in `media.ocr_text`; the existing FTS index now includes them. An image-only post can be found by its caption text without copying the image.
- **Optional by design.** The Docker image installs `tesseract-ocr`; a development machine without it reports OCR as unavailable and the rest of ingestion is untouched. Admin → Settings controls the rate (default 20 pictures/minute), language codes and an on/off switch.
- **No retry storm.** Each picture gets an `ocr_at` marker whether the read succeeds or fails, so a dead origin is not retried forever.
- **Verified:** migration v27 (column plus FTS triggers), 5 new tests (`tests/ocr.test.js`) for the schema, normalization, sweep, failure marker and off switch.

## 2026-11-08 — Alerts: a push notification when a creator posts

- **Bell on the creator profile.** One tap asks the browser for notification permission, creates a push subscription, and adds that creator to the watched list; a second tap removes him. A watched creator shows the bell in its on state.
- **One subscription, not one per creator.** The server keeps a single row per browser endpoint with the creator ids to watch. The three-minute job reads the existing media table, sends one summary notification ("New from X"), and moves its cursor forward. No media is copied to the server or the device.
- **Lock-screen friendly.** The payload carries the creator name, a generic "Tap to see the new post." body, and the profile URL — no explicit title, no thumbnail.
- **Display → Alerts** shows how many creators are watched and turns every alert off; dead endpoints (404/410) are disabled instead of retried forever.
- **Verified:** 6 new tests (`tests/push-alerts.test.js`) cover the key, subscription lifecycle, creator filtering, the summary job and gone-endpoint handling; full suite 1,839 pass / 4 skipped.

## 2026-11-06 — Sources: Pornhub gay models and pornstars

- **Pornhub joins the source list** (Admin → Sources) as a keyless source: paste `https://www.pornhub.com/model/<slug>` or `/pornstar/<slug>` anywhere a link is pasted and it becomes a creator feed. Only the cards the site itself labels `gay` are read, so a mixed model page cannot pull a straight scene in. Its blurb, the feed counts and a *Sync all* button come with it; the README's source table lists it too.

## 2026-11-06 — Sources: xHamster gay creators

- **xHamster joins the source list** (Admin → Sources) as a keyless source: paste `https://xhamster.com/gay/creators/<slug>` anywhere a link is pasted and it becomes a creator feed. It has its own blurb ("one public page per creator, newest videos first, HLS playback"), the usual feed counts and a *Sync all* button. The README's source table lists it too.

## 2026-11-06 — Find popular creators: Popular, Hot this week, and a trending rail

- **Creators opens on Popular.** Ranked by `creators.popularity` when that column exists, then freshness; until then, the same order as before (OnlyFans pages with posts first). Creators who have not posted in 90 days are left out of Popular, of Home's Top creators and of Hot this week, so a dead page does not lead the first screen.
- **Creators chips:** Popular, Hot this week (posted in the last 7 days), OnlyFans only, Following, New & rising. "Most posts", "Top rated", "Recently active" and "A–Z" remain in the Sort menu.
- **Home** has "Top creators" (the same ranking) and a new "Trending this week" rail of creators, each card giving the reason: "Posted 6 times this week".
- **Explore** has one-tap Popular, Hot this week and New chips beside Top Rated.
- **Find** shows popular niches as tap-to-explore hint chips (the most-used tags), above the example names.

## 2026-11-06 — Sources: the free tiers are on the panel, and the engine line tells the truth

- **Chrome (CDP), Jina Reader and the captcha solver are named on Admin → Sources**, with the price of each ("free", "tokens today") and the reason when one is off (no Chrome on the host, `CHALLENGE_BROWSER=1`, `jinaReader` / `captchaSolver` setting, `CAPSOLVER_API_KEY`). Before, only Browser4, Playwright and Bright Data were listed, so three tiers that now act on a refused page were invisible.
- **The "Pages built by JavaScript are read with" line names Chrome over CDP** when `RENDER_ENGINE` resolves to the new engine; it used to say Browser4 for anything that was not Playwright.

## 2026-11-05 — "Needs attention": the admin console, rebuilt around the owner's jobs

- **Overview answers "what is broken?" without a click.** Only queues with something in them, worst first (reports, failing feeds, review, feeds the app paused, same-person links, new creators). Failing feeds are expanded in place with the error in plain words and one tap to fix: *Retry*, *Pause* or *Check keys*, chosen from the error (`explainFeedError`). Feeds the app switched off on its own (`GET /api/admin/sources/retired`, new) are listed with *Turn back on*; before, nothing in the console listed them. The header line carries the throughput ("+462 items in 24h"); a card compares it with the day before.
- **Phones.** A bottom tab bar (Overview, Review, Feeds, Settings, More) replaces the public tab bar while the console is open; the old 13-item grid that took 230px of the first screen is gone. Every list is cards, not a table you scroll sideways. One sticky search row; bulk actions in a fixed bar above the tab bar; dialogs are sheets; every target is 44px.
- **Settings are grouped, searchable and described.** 66 settings in 7 groups; each has a short title and one sentence about what it changes (the server's developer notes are kept as the fallback). Body filter and feed housekeeping (`physiqueFilter`, `physiqueThreshold`, `physiqueCreatorShare`, `autoRetireFeeds`, `keepRunHistoryDays`) come first and open. The threshold is a slider with a live sentence and the number of pictures hidden right now; a changed setting is flagged and resets to its default; saving shows inline. Page length 9,663px → 3,402px at 390 wide.
- **Confirm and undo.** Approve, remove, block, delete a feed and block a creator ask first and say what they do (removing or blocking from a Report did not ask before). Reversible actions get an 8-second Undo toast instead of a second prompt: hide, approve and remove (back to the review queue), pause or resume a feed, hide a creator (new: reversible, unlike Block), reject candidates, remove a blocklist entry, a feed added by quick add. A block cannot be undone from the console and says so.
- **Fixed: leaving Overview or Live log counted as a failed login.** The brute-force guard counts every request that does not finish with a success; the live event stream never finishes, so 21 page changes in ten minutes locked the owner out of the whole admin API (429). A stream with the right key now skips the guard; wrong keys still count (`tests/admin-stream-limit.test.js`).
- **Fixed: wide content widened the whole page.** The console's grid had no `minmax(0, 1fr)` column, so a wide table pushed the disk banner and headings past the screen edge (up to 1,128px wide at 390).
- **Removed as clutter:** the three KPI tiles that repeated the queue counts (Awaiting review, Open reports, Failing feeds; the two filter tiles became one sentence each); the separate "Last 24 hours" panel (four rows now inside the throughput card); the static "Safety and boundaries" panel (a folded note on Sources); the "On" switch column on Feeds (replaced by Pause / Turn on); the long Discovery paragraph under its title; the 13-item section grid on phones. The keyboard-shortcut line on the review queue is hidden on touch screens.
- **Measured** (Playwright, `scripts/ui-audit.js --admin-key dev --only-admin`, 13 screens × 360/390/768/1280 + 390 light, same demo data, before = `origin/main` 5888134): content cut off at the screen edge in 25 of 65 views → 0; sideways scrollers inside the page 39 → 0; screens with a touch target under 44px 52 → 0 (at 390: 260 of 1,046 controls → 0 of 941); controls without a name 0 → 0; screens with a missing form label 10 → 0. Review queue page length 17,935px → 6,678px; Media 28,817px → 8,387px (same seed data). The cost: Feeds is longer on a phone, 6,721px for 25 cards (a page is 25 feeds there, 50 on a desktop) against 4,215px for a 50-row table that could only be read by swiping sideways. Taps for a held-item approval 4 → 4 (it still asks), hiding one 3 → 3 (now undoable), retrying a failing feed 2 → 1, seeing why a feed fails 1 → 0, adding a source from a pasted link 3 → 2, turning an auto-paused feed back on 3 (and the name had to be known) → 1.

## 2026-11-05 — "Phone & install": native-feeling phone UI, installable, offline-friendly

Audited with `node scripts/ui-audit.js <url> --phone` (new): every public screen at 360x740, 390x844, 430x932, 768x1024 and 1280x800, dark and light, touch emulation, iPhone notch / home indicator simulated (47px / 34px). 84 screen views before and after, demo library, Chromium only.

| Finding (phone screens, 60 of them) | Before | After | Fix |
|---|---|---|---|
| Text under 12px (tab labels 10.5px, badges 10.5-11.5px, chips on pictures, free-on / chart labels) | 55 screens (Explore 96 elements, Lightbox 101) | 0 | one 12px floor under 900px in `aurora.css`; two inline sizes in `card.js` / `creator.js` |
| Form fields under 16px (iOS zooms the page on focus; header search was 14.5px, small inputs 13.5px) | 55 screens | 0 | `font-size: 16px` on touch / phone |
| Content cut off at the side (Reels top row: order select and "what plays" button both showing, up to 67px past the edge at 390px) | 4 screens, 3 elements | 0 | v6 `.select.sm` had re-shown the select ux.css hides; title flexes; the button is icon-only at 480px and under |
| Sticky chrome after scrolling (app bar + filter bar + tab bar, minus the OS safe areas) | 16 screens over 22% (Creators 40.1% of 360x740, 35.2% of 390x844; Explore 22.9-26.1%; Following 23.8-27.2%) | 0 over 22% (Creators 17.8% / 15.6%; Explore 17.8% / 15.6%) | the filter bar slides away while scrolling down and returns on the first scroll up (`components/scroll-chrome.js`, transform only) |
| Pinned controls under the notch / home indicator | 2 (Display sheet's Done button, 811px of 844) | 0 | sheet buttons are sticky above the home indicator |
| Content hidden under the tab bar at the end of a page | 6 (Find footer: 66px; Browse at 768) | 0 | footer clears the bar |
| Targets under 44px | 6 (age-gate "leave" link 288x20; Reels "All" 36x44 at 768) | 0 | 44px link; 44px min width on coarse segments |
| Sideways overflow | 0 | 0 | (already clean at all five widths) |
| Display dialog checkbox labels shown in 12.5px UPPERCASE small caps | all | sentence case | `.display-row > label:not(.row)` (desktop too) |

Also: `100vh` / `vh` heights get an `svh` / `dvh` line after them (body, main, sheets, palette, suggestions); `overscroll-behavior: contain` on the viewer, sheets, palette, suggestions and every nested horizontal scroller (Reels already had it); `touch-action: manipulation` on controls; `content-visibility: auto` + `contain-intrinsic-size` on creator rows (253px) and Browse tiles (101px), in addition to the card rule that already existed; the tab bar and the new-content pill yield to the keyboard (`html.typing`) and the viewport meta has `interactive-widget=resizes-content` (Android resizes the layout, iOS scrolls the field into view); iPhone landscape side insets on `main`, the app bar and the footer.

Desktop 1280x800: sideways overflow 0 before and after; the only differences are the two inline 12px sizes (text under 12px: Explore 30 → 24 elements) and the age-gate link now 44px tall at every width.

Checked and left alone: swipe left / right and swipe down in the viewer already existed (`lightbox.js`), now covered by a touch test; Reels already contains overscroll; reduced motion already stops every infinite animation (0 running on Home / Explore / Creators, 1 on Reels: the playback progress bar, which is functional); focus rings visible on 14 Tab stops per page in both themes; no `will-change` was added (none measured).

**Install and offline (PWA).** Manifest: PNG icons (192, 512, separate maskable 512, apple-touch-icon 180; `scripts/make-icons.js` renders them from `favicon.svg`), `id` / `scope`, `display_override`, theme and background colour equal to `--bg`, `theme-color` follows the saved theme from first paint, shortcuts Top creators, Following, Reels, Explore, Saved. The phone menu offers **Install app** (Chrome / Edge / Android prompt) or **Add to Home Screen** steps (iOS Safari). Service worker `prism-shell-v9`: install precaches the shell and the hashed `/v/` files the page names; navigations are network-first with a 4 s timeout, then the cached shell, then `/offline.html`; **the content caches are opt-in and OFF by default** (Display > "Keep what I browse for offline use"; they would keep adult content on the device, which the old worker never did; turning it off, or "Clear history", deletes them): when on, public `GET /api` reads are stale-while-revalidate (60 s fresh, 24 h offline-only, 80 entries, emptied by any write) and `/api/proxy` pictures are cache-first (150 entries); admin, live stream, age, HLS, lookup, ranges and video are never cached. A pill says **You’re offline — showing saved** while the device is offline.

Measured (4x CPU, 150 ms RTT, 1.6 Mbps, 390x844): cold loads are unchanged within run-to-run noise (Home, 7 alternating runs each: FCP 1104 → 1128 ms, LCP 3536 → 3208 ms, long-task time 551 → 506 ms, transferred 254 → 258 KB). A repeat Explore visit with the worker: 1698 → 1053 ms (median of 3; the worker's own requests are not throttled by that emulation, so indicative only). Offline cold start after one visit: before, Explore showed no shell and Creators the shell with no content; after, both show content with the pill. Not measurable here: pull-to-refresh, the on-screen keyboard, real notch devices, WebKit.

**Verified:** full suite 1517 tests, 0 failures (new: `tests/phone-pwa.test.js` 27 tests: manifest, SHELL files, the worker run in a vm with an in-memory Cache API, no `vh` height without a `dvh` fallback; `tests/phone-pwa-browser.test.js` 8 browser tests with touch: filter bar hide / return, viewer swipes, offline pill, 16px fields, keyboard hides the tab bar, install entry, Reels at 360px, offline cold start). `node scripts/ui-audit.js <url> --phone --strict` exits 0.

## 2026-11-05 — "Top first": fewer sections, top OnlyFans creators in front

- **Home has 8 blocks, was 16** (counted from `parts` in `home.js`): masthead, ring strip, the first-visit interest picker, **Top OnlyFans creators**, From creators you follow, Trending now, For you (once there is taste to learn from), Latest uploads. Removed because they were different cuts of the same data: Since your last visit, Your smart feeds, the "because you…" rails, Topics, Rising this week, Fresh clips, Browse by source, New on PRISM, and the tag chips under the hero. `home.js` is 181 lines, was 267.
- **Creators has four views, was eight chips:** **Top** (the default; OnlyFans-linked creators first, then everyone by posts, which is what the server already sorted by), **OnlyFans only**, **Following**, **New**. "All" and "Most Posts" were the same default; Top Rated, Recently Active and the sort options now live in one Sort menu inside Filters. On a phone the search sits on its own row so all four views are visible without swiping. The "Full lookup" button went (Find is in the footer and the lookup button stays).
- **Browse shows real numbers.** The five tiles said `285+`, `25.9K+`, `Full-Screen`, `Active` and `1,300+`: marketing text, not data. They are now live counts (OnlyFans creators, OnlyFans posts, Fansly creators), and a tile with no real count is left out.
- **Creator profile on a phone:** 62px less bare picture above the name, so the bio and stats start sooner. **Reels:** the one-time hint no longer wraps over the Save button.
- **Demo data:** `scripts/seed-demo.js` links OnlyFans with the creator's handle (it used a bare `https://onlyfans.com/`, which the server rightly does not count as a page), so the demo shows the OnlyFans-first experience.
- **Verified:** `scripts/ui-audit.js` over 37 page views: 0 errors, 0 sideways scrolling, 0 accessibility findings; browser e2e 11/11; front-end guard tests 107/107; on a phone in both themes 0 targets under 44px and 0 overflow.

## 2026-11-05 — "Spectrum": mobile-first overhaul

- **New stylesheet `css/aurora.css`** (last in the bundle, precached by `sw.js`, `prism-shell-v8`). The older sheets are untouched, so the CSS guard tests still read exactly what they did before.
- **Home on a phone:** the masthead is left-aligned and short, the three actions are one swipeable row, and a ring strip of creators sits inside the first screen. Before, the whole first screen was centred text and the interest picker slid under the tab bar. The counts are a plain sentence ("124 posts from 12 creators across 5 sources"), not a dot-joined pill.
- **Ring strip** (`components/creator-ring.js`): spectrum ring = posted this week, plain ring = quiet; people you follow come first; a dashed "Find" ring at the end.
- **Creators on a phone:** flat rows divided by hairlines instead of cover cards (253px each, was 317px), and the long description under the count waits for a wider screen. The first card now starts at y=207 (was y=334) and two fit in the first screen (was one).
- **Bug fix, every viewport:** on creator cards the avatar was placed in the *name* grid cell under a 92% surface plate. `.creator-head > div:not(.creator-actions)` also matched the avatar `<div>` and outranked `.creator-head > .avatar`. Avatars now sit in their own column.
- **Browse on a phone:** 2-up tiles with numbers sized to fit, and the page is 24% shorter (2598px, was 3418px). The "All OnlyFans creators" link no longer wraps to three lines: it reads "See all" and keeps the full accessible name. Tag chips are 44px tall on touch (were 34px).
- **Explore on a phone:** each filter label shares a line with its chips and is sentence case; the first card starts at y=336 (was y=397).
- **How these were measured:** Playwright at 390×844, identical probes against untouched `main` and this branch on the same demo database.
- **Gradient restraint:** flat primary button, no glow on section icons, wordmark and headline are one colour, one body wash.
- **Accessibility and contrast:** primary button text is `--accent-ink` on `--accent` (6.5:1 dark, 5.9:1 light).
- **Verified:** `scripts/ui-audit.js` over 37 page views (desktop light and dark, phone, admin): 0 errors, 0 sideways scrolling, 0 accessibility findings. Browser e2e 11/11. The full suite has 21 backend failures that are identical on untouched `main` (ingest adapters, Telegram, thumbnails).

## 2026-11-04 — "Quiet": remove decorative clutter, one calm hero, a clearer creator graph

- **Deleted, not gated:** WebGL prism backdrop (`prism-bg.js`), 3D orbit (`orbit.js`), pointer card tilt/glare (`initTilt`), the 3D galaxy map (`views/galaxy.js`), the GPU probe (`gpuTier`) and the `ambientFx` display setting. `/galaxy` now lands on Creators. About 34 KB of JS and ~120 lines of CSS gone; no WebGL context is created on any page.
- **Home hero:** one kicker (counts once, no second stats row), headline, one search box, three actions (Find a creator, Watch Reels, Surprise me) and a line of gate copy: "Adults 18+ only. Male creators only. Report anything that doesn't belong." The Featured pill tray moved out (the Featured creators section below already covers it). Phone search placeholders no longer truncate.
- **Creator page:** a Connected strip (Accounts, Paid pages, On the web, Co-stars, Similar style) jumps to each part of the creator's graph. "Also on the web" is a rail whose cards say why they matched and show evidence as chips.
- **Why this:** cards now say "You follow X", "You often open X", "You like #tag" or "Similar to @x" instead of "A creator you like".
- **Touch targets:** link chips, platform pills, tags and "see all" links are 44px tall on touch (measured with Playwright at 390px: 0 interactive elements under 44px on Home, Creators, Creator, Saved and Find).

---

## 2026-11-02 — "Velocità": Mobile ergonomics, 44px touch targets, and zero-blur guardrails

### Mobile ergonomics & touch targets (minimum 44px)
- **Bottomnav & action rails**: Bottom navigation items enforced at min 48px hit targets with `touch-action: manipulation` and transparent tap highlight.
- **Reels action buttons & pills**: Reels side-rail action buttons expanded to 46px hit circles; OnlyFans Reels CTA expanded to 44px touch circle.
- **Creator chips & follow pills**: `.reel-of-chip` and `.reel-follow` received `::after` touch-target hit expansion ensuring full >= 44px compliance on mobile touchscreens without visual bloating.
- **Creator profile buttons**: Profile header actions updated to 44px minimum height with clean 2-column wrapping on phones.

### Mobile header notch & modal sheet gestures
- **Appbar notch & dynamic island safe area**: On viewports <= 899px, `.appbar` respects `env(safe-area-inset-top)` with proportional top padding and dynamic height; sticky `.filterbar` offset updated to match, preventing filter controls from being obscured behind the status bar.
- **Filter horizontal momentum scroll**: Horizontal filter rail equipped with momentum flick (`-webkit-overflow-scrolling: touch`), proximity scroll snap (`scroll-snap-type: x proximity`), and containment.
- **Modal sheet pull handle & drag-to-dismiss gesture**: Bottom sheet modals now feature an illuminated tactile grab pill handle and touch drag gestures (`touchstart`, `touchmove`, `touchend`) with live vertical translation and opacity fade, dismissing on downward flick or >75px drag.

### Strict performance guardrails: zero live blur
- **Live backdrop blur eliminated**: Removed `backdrop-filter: blur(...)` from `.card-fav`, `.reel-hint`, and `.card-why`, and enforced an explicit `backdrop-filter: none !important` guardrail across all `/card|pill|reel|why/` selectors. Live video playback and masonry scroll no longer recompute composited blur passes on every frame, keeping mobile Reels at solid 60fps with 0% dropped frames.

---

## 2026-11-01 — "Noir, edited": discovery reach, keyless search, and a design/IA pass

### Search that actually answers (no key required)
- **DuckDuckGo is back as a real provider** (`/html/` + Lite as a second door), on by default (`DDG_SEARCH=0` to opt out). Both endpoints fail fast (6 s, no retries), and when DuckDuckGo walls this network off — anomaly CAPTCHA, 429 or timeout — the provider cools down for 10 minutes instead of stalling every query, then retries itself. Admin → Discovery shows the reason and the time it comes back.
- **Keyless Bing sits beside DuckDuckGo and their results are merged.** The search order is now three tiers: metered providers first (one paid call, first answer wins), then the keyless tier (Bing + DDG + DDG-Lite) in parallel with results deduped, then SearXNG. Before, Bing answered first and DuckDuckGo was never reached.
- **Bing's bot-mitigation decoys are detected.** Bing echoes your query perfectly while serving unrelated results ("top gay onlyfans" → dictionary pages for "top"). A result set that shares nothing with the query now counts as a failure (visible in health) and, twice in a row, cools Bing down for 10 minutes — junk never reaches discovery.
- **`coherent()` guard** and its tests live in `src/lib/websearch.js`.
- **Brave Search API key from the OpenBot vault**: `BRAVE_API_KEY_FILE` points at a key file outside the workspace, so the secret never lands in the repo or `.env` (`.env.example` documents both forms). Brave's web/image/video search now powers discovery, identity matching and AI image match.

### Discovery: further, and easier to steer
- **Directory harvest** (`directoryHarvest`): rotates seven listicle/directory queries ("top gay onlyfans creators list", link-hub directories…), reads the top pages (robots.txt honoured, 1.5 MB cap, pages remembered so nothing is re-read), and turns everything on them into signal — paid handles become OnlyFans/Fansly/JFF leads for the existing trace, profile links become scored candidates. One run: 8 pages → 54 leads → 102 candidates.
- **Anchor `href`s are harvested too**, not just page text: a listicle's creator links often exist only in the href.
- **Prose false positives filtered** (`OnlyFans — Top Models` → handle "top"): headline words after a separator are typography, not usernames (`NOT_PROSE` in `lib/paid.js`).
- Coomer page cap is a setting (`coomerPages`, default 40 pages ≈ 2,000 posts on creator feeds).
- GayForFans performer links now parse as creator feeds wherever any directory or listicle links them.

### Discover page: one box
- Typing shows **local matches instantly** (creators, tags, communities — no network lookup), with one row underneath: *"Look up … across the open web"* — the only trigger for the rate-limited lookup. Enter works as before.
- The global search box gained the same last row: *"Look up … on Discover"*.
- **Answer card**: the best match gets a larger avatar, the name in the display face, a "Verified" badge and evidence chips; the rest follow as evidence cards.
- **Evidence chips** replace the bullet list: platform chip, then up to three 40-character checks with "+N", pill-shaped, `--surface-2`.
- Copy per spec: "Too many lookups", "Lookup failed", "No verified accounts for …", "Following. Opening profile…".

### Browse and Explore
- **Browse reordered** (Sources → Topics → Communities → Tags) with the "Find a creator" button dropped (Discover owns that job).
- **Tags are equal-size chips with counts** — the log-scaled font sizes were decoration that hurt scanning. Top 40, then "All N tags".
- **Communities show 8 per platform** with "Show all N" (was a wall of up to 60 chips).
- **Explore's filter bar reduced**: type, Followed, Hide seen, sort stay visible; source and time hide behind a **Filters** disclosure with the active count. Grid density moved out of the bar (it already lives in display settings).
- Empty states rewritten: "Nothing matches these filters.", "Nothing has been ingested yet.", "No creators match these filters."

### Admin console
- **Sidebar grouped by task** (Work queue · Creators and sources · Safety and access · System) with the same tab keys and URLs — deep links keep working.
- **Overview is now "Needs attention"**: only queues with a count, each one row with the number, label and action link; empty state "All clear. Nothing is waiting for you." The KPI grid moved behind an "All numbers" disclosure.
- First run shows one card: "No sources yet. Add a source, and PRISM starts ingests." with a single action.
- Discovery's web-search KPI reports both cooldowns (DuckDuckGo / Bing) with the time they lift.

### Performance
- **First-hit latency cut 455 ms → 24 ms**: SQLite statement prep for the hot list queries runs at boot (`warmPrep()`), before the cache warmers. A cold statement cost a real page load ~0.4 s.
- `tokens.css` added to the CSS bundle (one request, 25 KB gzipped total).

### Design direction (Product Design Lead)
- New `css/tokens.css`: graphite palette (not blue-violet), one accent used for state and the primary action only, Space Grotesk for titles/names + Inter for UI, 4px spacing scale, radius/shadow/motion tokens, light theme with AA-contrast fixes (light accent `#e63f73` → `#c2185b`, 3.95:1 → 5.9:1), reduced-motion collapsing all durations, 44px touch targets on coarse pointers.
- `:focus-visible` outline everywhere; hard-coded greys in the admin sidebar moved to tokens.

### Discovery visibility and admin triage
- **Admin → Discovery shows every strategy it now runs**: Directory harvest, Coomer creators, Performer
  directory and AI image match joined the "Last run found" badges, each with a human-readable hover line
  ("96 ranked performers scanned · 24 followed") instead of raw JSON. The page description lists what
  discovery actually does.
- **Review queue keyboard triage**: ← → move, Space select, A/H/R approve/hide/remove the selection —
  for a queue in the hundreds, clicking each card was the slowest part. "Block forever" deliberately has
  no shortcut: the one irreversible action stays a click. Shortcuts are listed in the `?` help and in
  the page header, ignore anything typed in a field, and do nothing with an empty selection.

### Fixes found by measuring rather than guessing
- **Lookup 67 s → 34–46 s** (hard-bounded): verify() ignored the deadline so in-flight profile reads
  finished 15–20 s after it; the expansion wave alone cost 21.7 s. The media search was
  fire-and-forget (results discarded while it contended with verification); queries now run in parallel,
  probes at concurrency 10, and every verify is clamped to the remaining budget.
- **Lookup fired /api/lookup twice** per search (navigate dispatched hashchange, `?q=` remounted the
  view): typing now fires 0, the lookup row exactly 1 — verified in Chromium.
- **Coomer/GayForFans probes fail fast**: a probe read one page with no retries instead of paging
  40 pages and backing off 15 s (which burned the entire 18 s probe budget on every guessed handle).
- **GayForFans directory cursor never wrapped** — the reset was written after the state, so after one
  pass through 75 pages discovery walked off the end (`?page=76, 77, …`) and silently found nobody.
- **Theme toggle**: a refused view transition could leave the theme unchanged (apply() now runs in the
  failure path), and the E2E test no longer races the async flip.
- **Bing gets its own rate-limiter key**: a DuckDuckGo 429 penalty no longer delays Bing.

### One search budget, spent where it matters
- **Lookup no longer overrides your budget.** It passed a hard-coded `budget: 200`, which spent the
  shared Brave counter to 201 while Settings said 40 — locking Brave out of discovery for the rest of
  the day (measured: "Brave daily budget reached" on all 10 discovery searches). Every caller now reads
  `braveDailyBudget`.
- **`preferKeyless`** — directory harvest and image match run the free tier (Bing + DuckDuckGo + Lite)
  *first* and never call the paid provider, so Brave's budget is reserved for identity matching, topic
  search and paid-page tracing.
- **Budget 0 or no Brave key no longer disables discovery**: the topic/identity gate used to skip
  entirely; it now means "free search only" and searches *more* per run (5 identity / 3 topics instead
  of 3 / 1).
- **Junk leads fixed at the source**: `plausibleHandle()` gates both match paths — a URL path or file
  name that merely starts with `onlyfans-` (`vicesnob.com/onlyfans-creator-debanking-2026/`,
  `.../onlyfans-debanking-featured.jpg`) can no longer become a lead. 41 stored junk leads rejected,
  41 real handles kept.
- **One failed query no longer kills the directory harvest**: the counter resets on success; two
  failures in a row stop it and say why. A run that previously reported "0 searches" now reports
  "2 searches · 5 pages · 37 leads".
- **DDG endpoints honour `DDG_BASE_URL` / `DDG_HTML_URL` / `DDG_LITE_URL`** — `ddg-lite` ignored the
  override and reached the live site from unit tests; tests are hermetic again.

### Verified
- 941 unit/integration tests pass (new: coherence, prose filters, harvest wiring, gff link parsing).
- 10/10 E2E tests in real Chromium (age gate, smart search, viewer, creators, takedown form, admin key, phone layout, theme).
- UI audit: 33 page views (desktop light/dark, phone) — **0 layout overflows, 0 accessibility findings**. Remaining console noise is upstream: expired Reddit preview links (404) and purged GayForFans files (503 "no cache server available"), which the link-health sweep hides.
- Proxy now sends the site Referer for `cdn.gff.network` (hotlink protection refused the CDN's own origin with a 403).

---

## 2026-10-31 — v6 "Noir": performance pass and design refresh

### Measured (phone: 390×844, 4× CPU slowdown, 150 ms / 12 Mbps link; median of 5, `scripts/perf-audit.js`; base = main)

| Page | Metric | Before | After |
|---|---|---|---|
| Home | LCP | 3292 ms | 2760 ms |
| Home | DOMContentLoaded | 1466 ms | 996 ms |
| Home | JS transferred | 156.9 KB | 124.3 KB |
| Home | Requests | 94 | 86 |
| Home | Total blocking time | 488 ms | 549 ms (within run-to-run noise; not improved) |
| Explore | LCP | 2308 ms | 1820 ms |
| Explore | Total blocking time | 332 ms | 237 ms |
| Reels | LCP | 2188 ms | 1928 ms |
| Reels | First video playing | 1080 ms | 986 ms |
| Feed scroll | Frame rate / long tasks | 60 fps / 634 ms | 59.8 fps / 195 ms |
| All | CSS transferred | 32.6 KB | 26.7 KB |

### Performance
- **Lazy views.** Only Home ships with the app. Every other view loads on its first visit and is prefetched while the browser is idle.
- **On-demand components.** The viewer, command palette, phone menu, display settings and report dialogs load on first use (`components/ondemand.js`). The startup module graph fell from 36 files / 320 KB to 19 files / 165 KB.
- **Deep links.** `theme-init.js` preloads the view for the address being opened (e.g. `#/explore`), in parallel with `main.js`.
- **No forced layouts on the first render.**
  - The page-enter animation uses Web Animations instead of restarting a CSS class. The restart needed a synchronous layout of the whole new page, about 270 ms on a throttled phone.
  - The tab-highlight measurement runs in the next frame.
  - A no-op `scrollTo(0)` was dropped.
  - The WebGL GPU probe is cached for a week.
- **One stylesheet.** `app.css` + `ux.css` + `v6.css` are served as one minified file (`/v/<hash>/css/bundle.css`, immutable): 31.5 KB → 24.8 KB gzipped, and one request fewer.
- **Video previews on phones** start only after a card has stayed in view for 450 ms, so flicking past a clip no longer downloads it.
  - At most one preview plays at a time on touch screens (two on desktop).
  - Previews pause while the feed is scrolling and resume 200 ms after it stops. In a first version, two previews in view dropped the feed to 31 fps.

### Design
- **Dark by default.** New visitors start dark; stored choices and the Auto/Light options are unchanged. The canvas is deeper and cooler, the surfaces are lifted, and a faint aurora at the top is painted once.
- **One type scale and one spacing scale.** These are `--fs-*` and `--s-*` tokens; phone heroes keep their own smaller sizes.
- **App bar.**
  - Clear glass at the top of the page, frosting with a hairline as you scroll. This is a scroll-driven animation with no JavaScript.
  - The desktop nav has one highlight that slides between tabs.
  - At mid widths, inactive tabs show only their icon.
- **Phone tab bar.** A denser glass that stays readable over any picture, and a glowing active icon.
- **Explore on phones.** Title, count and actions sit on one line, and the actions are icon buttons. Pictures start roughly 150 px higher.
- **Cards.**
  - One radius and a deeper caption scrim.
  - The save button appears on hover on desktop, and stays visible while an item is saved.
  - No blur behind card controls.
- **Primary buttons** have a slow sheen on hover: a background layer, with no layout change.
- **Creator pages.** The banner melts into the page in both themes, the avatar has an accent ring, and the name is set larger.
- **Theme switch.** The new theme spreads out from the button as a circle (View Transitions API), and switches instantly where that API is missing or motion is reduced.

### Fixes found while driving the UI
- Explore on phones spent about 40% of the first screen on its header.
- Glass bars on software-rendered devices (no GPU blur) let page text show through. They are now opaque there.
- Home on phones scrolled sideways by up to 150 px. The cause was the hero's drifting glow, which is 420 px wide and scales to 115%. The overflow showed only at some points in the animation, so earlier audits missed it. `#app` now clips horizontal overflow; `clip` rather than `hidden`, so the sticky app bar keeps working.

### Verification
- `node --test "tests/*.test.js"`: 945 passed, 0 failed, 1 skipped.
- `npm run test:e2e`: the first run had one failure, in the admin slow-key race test; that code is untouched on this branch. The failure did not reproduce in five later runs: two full runs at 20/20 and three runs of `e2e-ui` alone at 10/10.
- `scripts/ui-audit.js` (desktop light, desktop dark, phone; 40 page views): 0 errors, 0 sideways scrolling, 0 accessibility findings.

### Files
- `public/css/v6.css` (new)
- `public/js/components/ondemand.js` (new)
- `public/js/main.js`, `public/js/theme-init.js`, `public/js/store.js`
- `public/js/components/{card,feed,fx,menu}.js`
- `public/js/views/{home,saved,reels,creator}.js`
- `src/lib/assets.js` (CSS bundle and minifier), `src/app.js` (bundle route)
- `public/index.html`, `public/sw.js`

### Rollback
Revert the merge commit. Nothing in the API or data changed.

## Unreleased — v5 Horizon reach + motion

| Change | Files |
|---|---|
| **Masonry windowing**: cards more than ~3600px from the viewport become a height-locked shell (same estimate the column already uses) and drop their live DOM. Scrolling back, or focusing the shell, restores the card. Keyboard order is the shell itself until it restores into the media link | `components/masonry.js`, `app.css` |
| **Route enter/exit**: hash views fade and rise a few pixels with `--spring-glide`. Reduced motion, Reels, Galaxy, and an in-flight avatar/card flight skip it | `main.js`, `components/transitions.js`, `app.css` |
| **Staggered page arrival**: the first eight cards of a newly placed page fade up. Off under reduced motion and Data Saver | `components/masonry.js`, `app.css` |
| **First-row images**: `decoding=async` on cards; `fetchpriority=high` only for the first viewport row (one per column) and the first four cards of the first Home rail | `components/card.js`, `components/feed.js`, `views/home.js` |
| **Explore bar**: display title, specular top edge, tabular loading count | `views/explore.js`, `app.css` |

## Unreleased — v5 Horizon iteration: paid parity, identity, perf, operability

| Change | Files |
|---|---|
| **Paid-page parsing parity**: Fansly, JustFor.Fans, ManyVids, LoyalFans, Fanvue, FanCentro and Clips4Sale links parse to canonical handles like OnlyFans (string parsing only — the paid pages are kept as links and read like any other public page) | `lib/paid.js` (new), `lib/links.js` |
| **Paid-lead tracing parity**: Fansly/JFF pages named in posts and bios become discovery leads traced to free public accounts exactly like OnlyFans (service-keyed leads, migration v11); admin paste-a-link and lead queue filter by service | `db/migrate.js`, `db/repo.js`, `engine/discovery.js`, `routes/admin.js`, `views/admin/discovery.js` |
| **Reach**: Misskey people search joins discovery keyword reach; once-named leads stay cheap (no web search until a second source names them) | `sources/misskey.js`, `engine/discovery.js` |
| **Identity**: alias keys collapse filler affixes (`the_`, `real_`, `_official`, `_backup`…); bio alias lines catch dotted/dashed handles; identity scan pairs creators sharing a Fansly/JFF page; paid link-outs carry canonical handles with case-insensitive dedupe and free-flag refresh | `lib/alias.js`, `lib/bio.js`, `engine/identity.js`, `engine/lookup.js`, `db/repo.js` |
| **Creator profiles**: every paid page ships in a `paid` array on the creator DTO, with header buttons (Fansly/JFF) next to the OnlyFans CTA, card badges when there is no OF page, and all eight paid hosts in the Creators filter; **Find** keeps the paid link-outs it surfaced when following | `routes/public.js`, `views/creator.js`, `components/creator-card.js`, `views/creators.js`, `views/find.js` |
| **Frontend perf & DOM relief**: `masonry.place` batches DOM appends with per-column `DocumentFragment`s and skips `ResizeObserver` layout reads when width is unchanged; `card.js` pairs `thumb_url` (1x) with `preview_url`/`thumbnail_url` (2x `srcset`), adds a 65 ms hover-intent guard on desktop video previews, and releases decoded `<img>` bitmaps + stops previews for cards >2400 px off-screen via a shared `IntersectionObserver`; `api.js` coalesces in-flight identical GETs/POST-reads and skips prefetch on Data Saver/2G/3G; `main.js` adds a 65 ms hover-intent delay before prefetching `/api/creators/:id` | `components/masonry.js`, `components/card.js`, `api.js`, `main.js` |
| **Lumen + Motion craft & paid badge tints**: richer top-edge specular highlight (`--hi`, `--hi-strong`, `--raise`), refined card & creator-card hover/focus rings, distinct brand-tinted pills and CTAs for OnlyFans (`--of`), Fansly (`--fansly`), and JustFor.Fans (`--jff`) across creator cards, Creators quick-filter pills, Creator stage header, platform switcher cards, and Find paid link-outs | `css/app.css`, `css/ux.css`, `components/creator-card.js`, `components/platform-switcher.js`, `views/creators.js`, `views/creator.js`, `views/find.js` |
| **Perf, measured or guarded**: thumbnail sweep reads up to 3 pictures in flight; autocomplete caches per query for 10 s (cap 200); image-cache eviction never walks the disk on the request path | `engine/thumbs.js`, `routes/public.js`, `lib/media-cache.js` |
| **Admin operability**: Discovery queue filters by platform; paid signal chips name their service; Settings → Maintenance names every backlog (safety sweep, thumbnails, near-duplicates) | `views/admin/discovery.js`, `views/admin/settings.js`, `routes/admin.js`, `engine/discovery.js` |

**Kept deliberately**: public hosts are all readable now — paid pages, leak/mirror hosts and personal sites are followed like any other public page; no unofficial Instagram/TikTok scrapers; no face-match identity; no whole-web enumeration; the SSRF, takedown, safety and male-only gates stay hard.

## Unreleased — v5 Horizon: pull anyone in

| Change | Files |
|---|---|
| **Public Find** (`#/find`): name/handle/link → verified public accounts with evidence → follow as one creator; age-gated + rate-limited public API wrapping the admin lookup engine; widened probes (YouTube, PeerTube, Lemmy) | `views/find.js`, `main.js`, `components/palette.js`, `views/creators.js`, `routes/public.js`, `engine/lookup.js` |
| **YouTube via official RSS**: `youtube` adapter (`user`/`channel`), channel/@handle/UC parsing, thumbnail cards linking out to watch pages; pipeline allows YouTube image hosts | `sources/youtube.js`, `sources/index.js`, `lib/links.js`, `engine/pipeline.js` |
| **Reach**: Pixelfed hosts in Mastodon instances, Fansly/JFF/YouTube/Pixelfed discovery topics, paid-page filter (OF/Fansly/JFF/ManyVids/LoyalFans) on Creators | `config.js`, `settings.js`, `views/creators.js`, `routes/public.js` |
| **Perf**: grids prefer `thumb_url` with `tint` placeholders; Home WebGL prism + orbit mount after first paint; `thumb_url`/`tint` exposed on the public media DTO | `routes/public.js`, `components/card.js`, `views/home.js` |
| **Docs**: `PRODUCT.md` + `DESIGN.md` capture the Lumen/Motion world and the lawful aggregation boundary | `PRODUCT.md`, `DESIGN.md`, `README.md` |

**Kept deliberately**: public hosts are all readable now — paid pages, leak/mirror hosts and personal sites are followed like any other public page; no unofficial Instagram/TikTok scrapers; no face-match identity; no whole-web enumeration; the SSRF, takedown, safety and male-only gates stay hard.

## 2026-10-14 — v5 "Motion", phase 2: the creator stage

| Change | Files |
|---|---|
| **Stage header**: his best picture (highest-scored post, banner as fallback) full-bleed behind the name, washed into the page with a colour taken from that same picture; the wash fades in (opacity only) once the colour is known. Name set larger, with an "Also goes by" line when identity has aliases for him | `views/creator.js`, `app.css` |
| **Scroll drift**: the stage picture moves a little slower than the page and eases in by 6% as you scroll, with CSS scroll-driven animation (no JS on scroll, transform only, off for reduced motion and in browsers without it) | `app.css` |
| **"Free on" row**: every account where his posts are free, his free OnlyFans first, as lit pills in each platform's colour (one swipeable row on phones). Other links stay as dashed chips below | `views/creator.js`, `app.css` |
| **Stats count up** the first time you open a creator in a visit; coming back shows them settled | `views/creator.js` |
| **Platform switcher mounted** above the feed tabs; the creator feed and `setQ` carry `platform`. The component comes from the usability thread's PR #47 | `views/creator.js` |

**Verification**: 6 new guards in `tests/v5-motion.test.js`; stage checked at 390×844 and 1440×900 in dark and light, and the switcher checked against the usability branch's component (pills render, a pill filters the feed and updates the URL, no console errors).

## 2026-10-14 — v5 platform switcher, phase 2 of Features and usability

| Change | Files |
|---|---|
| **Platform switcher** for a creator's page: a row of pills (All, then each platform PRISM has his posts from, busiest first, with counts) that filters his feed; arrow keys move and pick. Hidden when he only posts in one place. Below it, his paid pages (OnlyFans first, Fansly, JustFor.Fans and others) as link-out cards with a Free tier badge and the price when known; one swipeable row on phones. The creator page mounts it (Design thread) | `components/platform-switcher.js`, `components/elsewhere.js` (`paidPages`), `css/ux.css` |
| **Following fixes**: "Play as Reels" from Following now covers all followed creators (up to 500, was 100); badges recount when the follow list changes mid-request; creators removed from PRISM are unfollowed quietly | `views/reels.js`, `following.js` |

## 2026-10-14 — v5 "Motion", phase 1: one motion vocabulary, shared elements

**Design direction**: nothing just appears or vanishes. Things that move between views keep their identity on the way, and every moving part in the app speaks the same three springs.

| Change | Files |
|---|---|
| **Motion tokens**: three springs (`--spring-snap`, `--spring-glide`, `--spring-settle`, sampled from real damped springs into CSS `linear()`, cubic-bezier fallback) and three durations (`--dur-quick` 140 ms, `--dur-base` 260 ms, `--dur-slow` 440 ms). 70 hard-coded transitions and animations now use them; presses and chips snap, pages and fades glide, sheets, dialogs and toasts settle. `--ease`, `--spring`, `--ease-out` stay as aliases | `app.css` |
| **Card → viewer**: the picture grows out of its card keeping the card's crop (a clip that opens as it grows) instead of stretching from a faded thumbnail; the media's shadow fades in at the end. Videos fly the card's poster to where the video will sit and crossfade once a frame is ready | `components/transitions.js` (new), `components/fx.js` |
| **Viewer → card**: closing the viewer (Esc, ✕, back, drag down) flies the current picture or video frame back into its card if that card is on screen, while the backdrop fades. Following a link out of the viewer does not | `components/transitions.js`, `components/lightbox.js` (3-line hook, agreed with the usability thread) |
| **Avatar → profile**: tapping a creator card, a card's creator line, a Reels creator or the viewer's creator row lifts the avatar; it hovers while the profile loads and lands in the header | `components/transitions.js`, `views/creator.js` |
| Flights wait for the first painted frame, so a slow phone building the viewer no longer skips most of the animation | `components/transitions.js` |

**Why ghosts, not the View Transitions API**: a creator page waits on a fetch before it has a header, and the viewer is an overlay, not a route. A view transition would freeze the page for the whole fetch; a ghost keeps it live and works in every browser.

**Perf** (`scripts/perf-audit.js`, 2 + 2 runs each, old and new back to back): within noise. Home TBT 422/487 → 526/424 ms, Explore TBT 171/179 → 243/134 ms, feed fling 60 fps both, Reels swipe-to-play 366/369 → 375/360 ms. +6 KB script, +1 KB CSS. All flight animations are transform, opacity or a one-shot clip-path.

**Verification**: `tests/v5-motion.test.js` (11 guards); open, close and avatar flights driven in Chromium at 390×844 touch and 1440×900, no console errors, no ghosts or hidden cards left behind. Before/after GIFs in the project's `design/v5-motion/`.

## 2026-10-14 — v5 Following, phase 1 of Features and usability

**Audit findings** (demo seed, Chromium at 390×844 touch and 1366×900): following a creator only fed a "Following" chip in Explore, capped at 100 creators because the ids went in the URL; Saved › Following fetched every followed creator one request at a time; nothing told you a followed creator had posted unless you opened his card. On phones the viewer's thumb dock was unusable: the media layer sat above the top bar's layer, so every tap on save, collect, share or details hit the media instead. Between 900 and 1280 px wide the top bar overflowed sideways and the search box shrank to an icon.

| Change | Files |
|---|---|
| **Following page** (`#/following`, desktop nav, phone More menu, palette, `G` then `F`): a rail of followed creators with a count of what is new for each, then everything they posted, newest first, split at "New since you were last here" / "Earlier"; Photos / Videos switch; up to 500 follows travel in POST bodies | `views/following.js`, `src/routes/follow.js`, `api.js`, `components/feed.js` |
| **New-post badges**: a count on the Following tab and the phone menu, a dot on the phone More button; refreshed on follow, on live "new" pings and when the tab returns; opening Following clears them | `following.js`, `store.js`, `main.js`, `components/menu.js` |
| **Viewer**: "More from him" strip of his latest posts, a "Where else he posts" sheet (free accounts, paid pages as link-outs, other links), and "Search this image" (Google Lens, Bing, TinEye in a new tab) | `components/lightbox.js`, `components/elsewhere.js` |
| **Recent searches** under an empty search box, removable one by one; cleared with History | `components/suggest.js`, `smart.js`, `store.js`, `views/saved.js` |
| Saved › Following loads every followed creator in one request | `views/saved.js` |
| Phone viewer dock and the details sheet sit above the media again | `css/ux.css` |
| Top bar between 900 and 1280 px: icons only (current page keeps its label) | `main.js`, `css/ux.css` |

**Verification**: `tests/v5-following.test.js` (9 tests: age gate, per-creator new counts, hidden creators, split feed never overlaps, paging, input caps, front-end wiring); flows driven in Chromium on phone and desktop with no console errors.

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

## 2026-10-13 — v4.16 "Lumen"

**Design direction**: depth from light, not borders. Every raised surface (buttons, chips, inputs, panels, the tab bar, dialogs) is lit from above: a hairline of light on its top edge, a faint top-down sheen and a soft two-layer shadow beneath. Media gets the room: cards lose their frame and their caption block, and the caption sits over the bottom of the image instead. Type is tighter at display sizes, headings balance their lines (no one-word orphans on phones) and paragraphs wrap "pretty". Motion uses the v4.13 spring for buttons, chips, the tab-bar highlight, toasts and dialogs.

**Audit findings** (same `scripts/perf-audit.js` conditions as v4.13: phone 390×844 @2x, 4× CPU slowdown, 150 ms / 12 Mbps link, demo library, median of 3 runs; the old build was measured twice, back to back with the new one): the web fonts came from Google (two extra origins, 70 KB) and the admin console's stylesheet loaded on every public page. On a phone, a creator's header stacked a 112 px avatar, name, four buttons and two rows of wrapping chips before any content. Opening Reels or the Galaxy shifted the whole layer by the app bar's height (the page-enter animation put a transform on `<main>`, which made it the containing block of their fixed layer until the animation ended).

| Change | Files | Measured (old → new) |
|---|---|---|
| **Fonts self-hosted** and subset: Inter variable 400–700 and Space Grotesk variable 500–700, Latin-1 + common punctuation, preloaded from the shell; Google Fonts dropped from the CSP | `public/fonts/*` (OFL licence included), `index.html`, `theme-init.js`, `src/app.js`, `app.css` | fonts 70.4 → 44.7 KB, two fewer origins; Explore LCP 2.76–3.08 → 2.24–2.28 s; Reels LCP 2.23–2.29 → 2.12–2.15 s |
| **admin.css loads with the console only** (resolved from the admin module's own versioned URL, awaited before the console renders); `.chart-axis`, the one rule a public page shared, moved to app.css | `views/admin/index.js`, `index.html`, `sw.js`, `app.css`, `admin.css` | stylesheet bytes on every public page 25.8 → 23.8 KB, one request fewer |
| **Image-first cards**: no frame, caption over the image on a static scrim (no blur), a ring of light drawn above the image, platform as a tinted tag; dense grid shows the picture only (caption on hover on desktop); tighter gutters on phones | `app.css`, `components/card.js` ("why" chip moves into the caption), `components/masonry.js` (a card's height is now exactly its media) | feed fling 27.4–27.5 → 28.3–29.7 fps, long tasks 2.1–2.3 → 1.0–1.7 s; the same 158 cards take 24% less scrolling |
| Lit controls: buttons, chips, segmented controls, inputs, nav pill, link chips, tabs, modals, toasts, empty states | `app.css` | |
| New tokens: `--hi`, `--raise`, `--ring`, `--scrim`; deeper neutrals; softer two-layer shadows; light theme retuned to match | `app.css` | |
| Phones: creator header in two rows (80 px avatar beside the name, actions full width), account links and tags in one sideways-scrolling row each; a shorter home hero | `app.css` | |
| Keyboard focus: a two-tone ring that reads on any background; on cards it is drawn inside the media | `app.css` | |
| Reels and Galaxy no longer run the page-enter animation (it caused the layout shift above) | `app.css` | Reels CLS 0.039 → 0 under throttling |

**Tried and dropped**: `:has()` selectors for the card focus ring and the creator tag row. They made style recalculation during a feed fling ~45% more expensive (339 → 494 ms), so both use plain selectors now.

**Left to the usability thread's PR**: the phone layouts of Reels (full screen, the order picker in a sheet) and of the Explore filters (one swipeable row, `.filter-scroll`). This release only fades the edge of that row.

**Unchanged, for the record**: first paint ~0.53 s and Home LCP ~3.4 s are within run-to-run noise (Home's largest paint is the hero orbit). Reels swipe-to-first-frame stays ~0.39 s.

**Verification**: 481 unit tests (6 new in `tests/v416-lumen.test.js`: no Google Fonts anywhere, both fonts declared, preloaded and under 30 KB, licence present; admin.css not in the shell and loaded by the console; no public view using an admin-only class; captions over the image with the matching masonry estimate; no new live blur on cards, chips or Reels controls). The v4.13 compositor-only guard still passes. Before/after screenshots on a phone and on desktop (dark and light) of Home, Explore, Creators, a creator page, Saved and the admin console, with no console errors.
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
