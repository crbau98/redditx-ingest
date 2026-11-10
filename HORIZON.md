# PRISM horizon — 10 November 2026

Eight-hour pass on the current app. Evolve it. Do not rewrite it. No paywall bypass, no accounts until the backlog says so, no native shells.

Success: the first screen is useful before the slow calls return, scrolling does not wait on the network, video picks up where it stopped, and each slice keeps the unit suite green.

## Shipped this pass

- [x] List responses omit captions. The viewer loads one caption when details open.
- [x] `Server-Timing` on API responses.
- [x] Feed prefetches the next page into the client cache. Static first-page placeholders.
- [x] Resume position, playback speed, picture in picture. Continue watching on Home.
- [x] Home mounts Latest uploads before `/api/discover` returns, then inserts the hero and rails above that grid.

- [x] Creator pages: the post grid starts with the profile request, then the header is inserted above that same grid.
- [x] Explore: the first media page is prefetched as soon as the filters are known, before the chips are built.
- [x] Reels resume uses the same saved position as the viewer. The progress bar already resyncs on `seeked`, so a restored point does not start the bar at zero.
- [x] Popular creators walk `ix_creators_popular_active` (no `COALESCE`, `INDEXED BY` on the default Popular screen). Ingested media walks `ix_media_pub_ingested` (`ingested_at`, `seq`).
- [x] Image cards already take the 360px thumb whenever it covers the column at up to 2× density (`public/js/images.js`, `tests/images.test.js`).
- [x] Command palette lists recent creators and recent videos from device history before any search.
- [x] Saved → History shows a Continue rail from the same resume list as Home.
- [x] Home keeps Latest uploads when Discover fails, and the grid says the rest of Home is still there when Latest uploads fail.
- [x] Library export includes resume points. Import merges them and keeps the newer timestamp.
- [x] Admin → Overview lists each source’s items today against the day before. A source that went quiet is marked and sorts first.
- [x] Creator cards request the 360px thumb before the platform preview.
- [x] Reopening the command palette within a minute reuses the last history fetch.
- [x] History’s Continue rail rides on the grid’s first request. A resume point past that page is appended to the same request.
- [x] History grid cards show a progress mark where a video left off.
- [x] Viewer and Reels posters, and the search strip, use the cached 360px thumb before the platform preview.
- [x] Reels image slides show the cached thumb, then the platform preview, then the full file.
- [x] The next Reels photo mounts while the current slide is on screen, on the same connections that already buffer the next video.
- [x] A failed Reels thumb steps to the preview, then the file. Collection covers use the 360px thumb.
- [x] Admin review tiles prefer the 360px thumb.
- [x] A missing admin or collection cover steps to the next still. The first picture is probed, because a CSS background never reports a 404.
- [x] Admin → Reports covers use that same chain, and the report row now includes the thumb, the preview, and the file.
- [x] Creator-card preview strips send the thumb and a fallback still. A dead thumb steps to the platform preview once the tile is on screen. The profile stage does the same. `previews` stays a list of strings.
- [x] Topic mosaics use the 360px thumb first and keep the next still. The first tile of the first two topic cards paints immediately. “Because you watch” rails eager-load their first four cards, the same as the other Home rails.
- [x] History’s Continue rail eager-loads its first four cards. Home’s Continue rail stays lazy, because it sits below the first screen.
- [x] Home → Popular now eager-loads the first two creator cards, matching the Popular creators rail.
- [x] For you → Creators you might like eager-loads the first two cards. The media cards above them already eager the first four.
- [x] Saved → Following eager-loads the first four creator cards. The empty Following page eager-loads the first two suggested creators.
- [x] The search suggestion strip stays at six images. A dead thumb steps through `stillChain` (thumb, preview, then the image file) and stops.
- [x] Viewer dock, filmstrip, related, and “more from him” tiles step through `stillChain` when the thumb 404s. The video poster and the blurred backdrop stay on the single small still.
- [x] Viewer and Reels video posters probe that still and step to the next one when it 404s. The probe does not request the video file.
- [x] Command palette recent videos show the 28px still already on the history fetch. A dead thumb steps once to the next still. A video with no still keeps the play icon.
- [x] The Creators browse grid eager-loads the first four cards of the first page. Later pages stay lazy.
- [x] Creators prefetches the next page into the client cache once the current page lands. Load more and the early scroll reuse that response. Prefetch stops when the list is done.
- [x] Reels prefetches the next `/api/media` page, and the next For you page, as soon as the current page lands. The follow POST feed warms through `prefetchQuery`, which shares `query()`’s cache key and does not clear the cache. Prefetch stops when a page comes back short.

- [x] Saved → Smart feeds asks for the first four “what’s new” counts immediately. The rest wait for an idle callback, or a short timeout when the browser has none. A count that returns after the row is gone does not rewrite the page.
- [x] Home shows the first two smart feeds under the first screen, after Discover has painted. The count uses the same request as Saved. Pull to refresh reloads those counts from the current saved list.
- [x] An empty library and a failed Discover snapshot still show those two feeds under the message. The counts start after the message is on screen.
- [x] Discover’s Try again builds the replacement page before it destroys the old Latest uploads grid.
- [x] An empty library can be pulled to refresh its smart-feed counts. That pull does not rebuild the empty message.
- [x] Browse paints sources, communities, and tags as soon as those three return. Topics and the paid tiles fill in afterward. A failure of topics or of a count leaves the rest of the page up.
- [x] The Creators grid shows eight card skeletons until the first page replaces them. A failed first page, or Following with nobody followed, clears the skeletons.
- [x] Reels puts one full-height skeleton slide in the track before the first page returns. The first real slide replaces it. A failed first page removes it and shows the existing error. Try again, and a shuffle restart, put the skeleton back. The skeleton does not request a video.
- [x] A deep link into the viewer shows the item as soon as that item returns. The related list, used as the swipe sequence, fills in afterward. A failed related list leaves the item on screen. A newer open does not take the late list.
- [x] “More like this” uses that same related list (the first 9) when a deep link already asked for it. The strip does not start a second related request in that case. If the strip already painted, the late list does not replace it.
- [x] The viewer’s creator dock and “More from him” share one request for his recent posts. A second open within two minutes reuses that answer.
- [x] A shared link (`?m=<uuid>`) starts `/api/media/<id>` with the other early requests, after the age gate. `openById` still calls `get`, so that answer is reused. A non-uuid `m` starts nothing. Related is not started here. The viewer module is preloaded at the same time.
- [x] A creator link (`#/creator/<uuid>`) starts the profile and the default first page of posts after the age gate. Compact density asks for 48 posts; anything else asks for 36. `#/creator/abc` stays meta-only. A type, source, search, or non-recent sort starts the profile only.
- [x] The Creators grid starts the page-0 URL it will actually ask for. A search, source, paid page, freshness window, or other sort is included. `onlyfans=1` is added when the paid filter is OnlyFans. `lookup` is left out. Following starts nothing extra, because those ids live on this device.
- [x] A Reels link starts the first page that reel will ask for. A tag, search, source, sort, or media type is part of that URL. `type=all` omits type. Following, For you, and Shuffle start nothing extra. A visitor with taste and no sort still starts nothing. The plain Reels URL stays `/api/media?type=video&sort=trending&page=0&limit=12`.
- [x] `creators()` and `reels()` return their cleanup before the first page is awaited. A late page or a late failure does not paint a page you have left. The skeletons stay until that response arrives. Leaving Reels also drops the key handler while the first page is still in flight.
- [x] `home()` and `creator()` return their cleanup before `/api/discover` and the profile are awaited. A late snapshot, a late failure, or a late profile does not replace a page you have left. The Home skeleton and the creator header skeleton stay until that response arrives. Leaving also destroys the early feed. Activity, collabs, similar creators, and the profile tint do not write into a page you have left.
- [x] Discover’s Try again builds the replacement Home before it destroys the old grid, and hands that replacement’s cleanup to the stop the router already holds. Leaving after Try again destroys the replacement grid, and a late snapshot from that retry does not paint.
- [x] Saved → Following returns its cleanup before `/api/follow/summary` resolves. A late summary, or a late failure, does not paint a tab you have left. The creator skeletons stay until that response arrives.
- [x] `browse()` returns its cleanup before the catalog (`/api/tags`, `/api/communities`, `/api/platforms`) is awaited. A late catalog, a late failure, or an empty library does not replace a page you have left. The skeleton stays until that response arrives. Topics and the paid tiles still fill in afterward, and they do not write into a page you have left.

- [x] Find’s cleanup marks the page as left. A lookup or a follow that finishes after you leave does not paint, and it does not open that creator. The page that is up stays up.

- [x] A published insert moves that creator’s counters by the one new row. Hide, restore, and re-attribute still recount. The body read in the link-health probe already stops itself (`src/engine/probe.js`).
- [x] Review queue: Publish all, Hide all, or Remove all on a hold applies to every waiting row with that exact reason, in chunks of 500. A hold that already fits on the page stays on the group buttons. Block stays one item at a time.
- [x] Review queue: page through holds that do not share a reason, so a mixed backlog is not stuck on the newest 60.

## Next

55. [x] Review queue: filter the page by hold kind or one named reason, so you do not page past unrelated holds.
56. [x] Saved and Collections grids show the same resume progress mark History already uses, so a half-watched video is visible where you left it.
57. [x] Saved → Saved shows the same Continue rail Home and History already use, so half-watched videos are one tap away without opening History.
58. [x] An empty Following page returns its cleanup before popular creators resolve. A late list, or a late failure, does not paint a page you have left.

## Later

11. Do not start accounts, native shells, or a search-index rewrite in this pass.

## Check each slice

- `node --test tests/horizon-speed.test.js` plus the tests the slice touches.
- Phone width 360 and desktop 1280 if the layout moved.
- Leave Reddit and Telegram text off hosted models.
