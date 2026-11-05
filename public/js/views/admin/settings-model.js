// Settings, as the console shows them: grouped, searchable, each with a short title and one plain sentence about what it changes.
// Pure (no DOM). The server's own labels are long notes for developers; this is the owner's view of the same keys.
// A key that is not listed here still shows up, under "Other", with the first sentence of the server's label, so a new
// setting is never lost.

export const GROUPS = [
  { id: 'body', title: 'Body and age filter', note: 'Keeps the library to fit, athletic men. Hides, never deletes: switch it off and everything is back.', open: true },
  { id: 'feeds', title: 'Feed housekeeping', note: 'How the app tidies its own sources and its run history.', open: true },
  { id: 'filters', title: 'Other filters and checks', note: 'Pictures with women, duplicates, unclear male focus, dead links.' },
  { id: 'ingest', title: 'Schedule and limits', note: 'How often feeds run, how many at once, and daily caps.' },
  { id: 'sources', title: 'Sources and media', note: 'Per-platform switches, video copies, thumbnails, browser rendering and paid unblockers.' },
  { id: 'follow', title: 'Following creators', note: 'What the app follows on its own.' },
  { id: 'system', title: 'Backups and AI', note: 'Nightly backups and the AI that reads searches.' },
  { id: 'other', title: 'Other', note: 'Settings without a description yet.' },
];

// key: [group, title, one plain sentence about what it changes]
const CATALOG = {
  physiqueFilter: ['body', 'Hide heavy or older-looking men', 'Hides pictures of heavy builds, and men who call themselves older (words like “silver fox” or a stated age of 45+), from the whole site.'],
  physiqueThreshold: ['body', 'How heavy counts as heavy', 'A body score from 0 (lean) to 100 (very large): pictures at or above this are hidden. Lower is stricter, and the whole library updates when you move it.'],
  physiqueCreatorShare: ['body', 'Hide a creator when this much is hidden', 'Hides a creator and pauses his feeds once this percentage of his measured pictures are hidden (needs at least 3 measured; 0 means never).'],

  autoRetireFeeds: ['feeds', 'Pause feeds that stopped working', 'Pauses feeds the app made itself once they keep failing or add nothing for weeks. Feeds you added are never touched, and any paused feed can be turned back on.'],
  keepRunHistoryDays: ['feeds', 'Keep run history for', 'How many days of feed run records (the log behind failures and throughput) are kept before they are cleared.'],
  adaptiveScheduling: ['feeds', 'Check busy feeds sooner', 'Busy feeds are read more often and quiet ones less often, instead of everything on the same clock.'],
  maxFeeds: ['feeds', 'Most feeds switched on at once', 'A ceiling on enabled feeds, so discovery cannot grow the list without limit.'],
  newFeedHours: ['feeds', 'New feeds go to the front for', 'A feed you just added is read ahead of the queue for this many hours.'],

  imageFilter: ['filters', 'Hide pictures that show a woman', 'An on-device face check keeps pictures of women out of the library.'],
  imageFilterThreshold: ['filters', 'How sure before it counts as a woman', 'The confidence needed to call a face female. Lower is stricter and hides more.'],
  imageFilterConcurrency: ['filters', 'Pictures checked at once', 'How many pictures the image filter works on in parallel; more is faster and uses more memory.'],
  dedupe: ['filters', 'Merge the same picture posted again', 'Reposts of one picture become a single item that lists every place it was posted.'],
  dedupeDistance: ['filters', 'How alike counts as the same picture', 'From 0 (identical only) to 7 (loosest): how many differences still count as a repost.'],
  imageSweep: ['filters', 'Re-check the existing library', 'Quietly re-runs the picture checks over what is already stored, in the background.'],
  imageSweepPerTick: ['filters', 'Pictures re-checked per minute', 'How fast the background re-check goes; 0 pauses it.'],
  scopeMode: ['filters', 'When male focus is unclear', 'Strict sends unclear posts to the review queue; open publishes them.'],
  untrustedUnclear: ['filters', 'Open-search posts with no male wording', 'Drop discards them; review sends them to the queue for a person.'],
  hostReachability: ['filters', 'Skip media hosts that refuse us', 'Posts whose pictures sit on hosts that block this server are skipped instead of shown broken.'],
  probeUnknownHosts: ['filters', 'Test unknown hosts first', 'Media from a host seen for the first time is fetched once before it is published.'],
  linkHealth: ['filters', 'Hide what was removed at the source', 'Re-checks stored media and hides the items the original site has taken down.'],
  linkHealthPerSweep: ['filters', 'Links re-checked every 10 minutes', 'How many ordinary items the link check visits each round.'],
  linkHealthCohortPerSweep: ['filters', 'Links re-checked on fragile hosts', 'The faster rate for hosts where media is known to disappear.'],
  linkHealthRotHosts: ['filters', 'Hosts where media disappears', 'One host per line; items on these are re-checked at the faster rate whatever their age.'],
  reposts: ['filters', 'Keep reposts', 'Reblogs, reposts and crossposts are kept and credited to the original poster.'],

  schedulerEnabled: ['ingest', 'Run the schedule automatically', 'When off, feeds only run when you press Sync.'],
  tickSeconds: ['ingest', 'Scheduler check interval', 'How often, in seconds, the scheduler looks for feeds that are due.'],
  maxConcurrentFeeds: ['ingest', 'Feeds read at once', 'The most feeds the engine reads in parallel, all platforms together.'],
  platformSlots: ['ingest', 'Feeds at once, per platform', 'Optional per-platform limits like “bluesky=4, telegram=1”; empty uses the built-in defaults.'],
  backfillRunsPerDay: ['ingest', 'History reads per platform per day', 'A daily cap on reading old posts, so history never crowds out fresh ones.'],
  backfillGapMin: ['ingest', 'Minutes between history slices', 'How soon a feed that stopped inside a creator’s history reads its next slice.'],
  itemsPerRun: ['ingest', 'Most items per run', 'The largest number of posts one feed run will take in.'],
  platformDailyMb: ['ingest', 'Daily download cap per platform (MB)', 'Limits how much media is copied into storage per platform each UTC day, like “telegram=5000”.'],
  platformDailyRuns: ['ingest', 'Daily run cap per platform', 'Optional limit on feed runs per platform per day, like “x=300”; empty means no cap.'],

  redditEnabled: ['sources', 'Read Reddit', 'Off by default: without Reddit app keys every run just fails. Turn on once the keys are set; nothing is deleted while it is off.'],
  xMonthlyReadBudget: ['sources', 'X posts read per month', 'Match this to your X plan so the monthly allowance is not overspent.'],
  xKeylessSearchesPerDay: ['sources', 'X searches per day without a key', 'Web searches used to find X posts when there is no token; keeps the search engines from blocking this server.'],
  telegramPublic: ['sources', 'Telegram: read public channels', 'Reads public channels by name with the logged-in account; off means only joined channels.'],
  telegramSearchesPerDay: ['sources', 'Telegram searches per day', 'The most channel-name or hashtag searches per day, 30 seconds apart.'],
  telegramJoinsPerDay: ['sources', 'Telegram joins per day', 'The most channels the account may join per day, and only from the approved list.'],
  telegramApprovedJoins: ['sources', 'Telegram channels it may join', 'One @username per line. Nothing outside this list is ever joined.'],
  coomerPages: ['sources', 'Coomer pages per run', 'How many pages (50 posts each) a Coomer feed reads per run.'],
  gffBrowserAgent: ['sources', 'GayForFans: use a normal browser identity', 'Reads those pages as an ordinary browser; off uses PRISM’s own agent.'],
  keepVideos: ['sources', 'Keep a copy of videos', 'Expiring keeps only videos whose links expire, all keeps every direct video, off keeps none.'],
  keepVideoMaxMb: ['sources', 'Largest video copied (MB)', 'Videos bigger than this are linked, not copied.'],
  thumbnails: ['sources', 'Make small thumbnails', 'Creates a small picture and a colour tint for every item so grids load fast.'],
  thumbnailsPerMinute: ['sources', 'Thumbnails per minute', 'How fast thumbnails are made in the background.'],
  browser4Mode: ['sources', 'Read web pages in a real browser', 'Off never, fallback only when a plain download finds no media, always for every web page.'],
  browser4Scrolls: ['sources', 'Browser: scrolls per page', 'How many times a page is scrolled to load more before it is read.'],
  browser4Pages: ['sources', 'Browser: “next page” links followed', 'How many pages of one site a run may follow.'],
  browser4AutoExpand: ['sources', 'Browser: follow a page’s links as new feeds', 'Untrusted: every item still passes the safety and male-only checks.'],
  browser4ExpandPerRun: ['sources', 'Browser: new feeds per run', 'The most feeds one run may add this way.'],
  brightdataUnlocker: ['sources', 'Bright Data unblocker', 'When a site refuses PRISM, fetch the public page through Bright Data. Costs credits and needs keys on the host.'],
  brightdataUnlockBudget: ['sources', 'Bright Data requests per day', 'A daily cap on unblocked requests; 0 means none.'],
  scrapflyUnlocker: ['sources', 'Scrapfly unblocker', 'Off by default. When on, it only runs for the creators on the allowlist.'],
  scrapflyAllowlist: ['sources', 'Scrapfly allowlist', 'The only creators (ids or handles, one per line) Scrapfly may spend credits on; empty means it never runs.'],
  scrapflyBudget: ['sources', 'Scrapfly requests per day', 'A daily cap on Scrapfly requests.'],
  scrapflyMonthlyBudget: ['sources', 'Scrapfly requests per month', 'A monthly cap; the free plan allows 1000.'],
  scrapflyCreditBudget: ['sources', 'Scrapfly credits per day', 'A daily credit cap; the expensive tier only runs when this is at least 80.'],
  scrapflyMonthlyCreditBudget: ['sources', 'Scrapfly credits per month', 'A monthly credit cap; keep it under what the account has left.'],

  autoTrack: ['follow', 'Follow creators found in communities', 'A creator who keeps posting in a community you read is followed automatically.'],
  autoTrackMinItems: ['follow', 'Posts before he is followed', 'How many posts a creator needs before he is auto-followed.'],
  autoLinkProfiles: ['follow', 'Follow his other public accounts', 'Public accounts named in a creator’s bio are followed as part of the same person.'],
  identityAutoMerge: ['follow', 'Merge his accounts on its own', 'Accounts that link to each other and share a name become one creator; anything less sure waits under Same person?.'],

  backupEnabled: ['system', 'Back up the database nightly', 'Writes a database copy every night next to the database.'],
  backupKeep: ['system', 'Backups to keep', 'Older backups beyond this number are deleted.'],
  aiSearch: ['system', 'AI reads hard searches', 'Slang, typos and other languages are mapped onto the library’s tags; only the typed words and the tag list are sent.'],
};

/** The server label's first sentence, as a stand-in description for a setting this file does not know yet. */
export function firstSentence(label) {
  const s = String(label || '').trim();
  const cut = s.split(/(?<=[.!?])\s|\s[—–]\s|:\s/)[0] || s;
  return cut.length > 140 ? `${cut.slice(0, 137).trim()}…` : cut;
}

const GROUP_BY_SERVER = { safety: 'filters', telegram: 'sources', sources: 'sources', maintenance: 'filters', search: 'system', discovery: 'other' };

/** Title, one-sentence hint and group for a setting definition from GET /settings. */
export function describeSetting(def) {
  const c = CATALOG[def.key];
  if (c) return { group: c[0], title: c[1], hint: c[2], known: true };
  return { group: GROUP_BY_SERVER[def.group] || 'other', title: firstSentence(def.label), hint: '', known: false };
}

/** True when the stored value differs from the built-in default. */
export function isChanged(def, value) {
  if (value === undefined || value === null) return false;
  return String(value).replace(/\r/g, '').trim() !== String(def.default ?? '').replace(/\r/g, '').trim();
}

const norm = (s) => String(s || '').toLowerCase();

/**
 * Groups the settings for display.
 * @param {Array} schema GET /settings → schema
 * @param {object} values GET /settings → values
 * @param {{query?: string, changedOnly?: boolean}} opts every word of the query must appear in the title, sentence, key or group name
 */
export function buildSettingsModel(schema, values, { query = '', changedOnly = false } = {}) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const byGroup = new Map(GROUPS.map((g) => [g.id, { ...g, items: [], changed: 0 }]));
  let total = 0; let shown = 0; let changed = 0;
  for (const def of schema) {
    if (def.group === 'discovery') continue; // lives on the Discovery page
    total++;
    const d = describeSetting(def);
    const value = values[def.key];
    const isCh = isChanged(def, value);
    if (isCh) changed++;
    const g = byGroup.get(d.group) || byGroup.get('other');
    const hay = norm(`${d.title} ${d.hint} ${def.key} ${g.title}`);
    if (words.length && !words.every((w) => hay.includes(w))) continue;
    if (changedOnly && !isCh) continue;
    shown++;
    if (isCh) g.changed++;
    g.items.push({ key: def.key, def, value, title: d.title, hint: d.hint, known: d.known, changed: isCh });
  }
  // inside a group, the catalog's order is the owner's order; unknown keys follow in the server's order
  const order = Object.keys(CATALOG);
  for (const g of byGroup.values()) g.items.sort((a, b) => (order.indexOf(a.key) < 0 ? 1e6 : order.indexOf(a.key)) - (order.indexOf(b.key) < 0 ? 1e6 : order.indexOf(b.key)));
  return { groups: [...byGroup.values()].filter((g) => g.items.length), total, shown, changed };
}

/** What a number means right now, for the sliders that benefit from a sentence next to them. */
export function liveHint(key, value, ctx = {}) {
  const v = Number(value);
  if (key === 'physiqueThreshold') {
    const strict = v <= 35 ? 'strict' : v >= 60 ? 'relaxed' : 'balanced';
    const hidden = ctx.physique && ctx.physique.enabled ? ` ${ctx.physique.hidden} pictures are hidden right now.` : '';
    return `Hides pictures scoring ${v} or more out of 100 (${strict}).${hidden}`;
  }
  if (key === 'physiqueCreatorShare') return v === 0 ? 'Never hides a whole creator.' : `Hides a creator when ${v}% of his measured pictures are hidden.`;
  if (key === 'keepRunHistoryDays') return `Run records older than ${v} day${v === 1 ? '' : 's'} are cleared.`;
  if (key === 'imageFilterThreshold') return `Calls a face female at ${v}% confidence or more.`;
  return '';
}
