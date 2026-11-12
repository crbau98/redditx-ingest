'use strict';
/**
 * Discovery: find creators PRISM is not following yet, score them on
 * independent signals, and follow the strong ones automatically.
 *
 * Signals (each counted once per distinct source, with caps):
 *   identity  web search found this account under the *same name* as a creator
 *             we already follow → it is that creator's other account (linked)
 *   mention   a followed creator @-mentioned / linked the account in a post
 *             (collabs, shout-outs) — the strongest organic signal
 *   cofollow  followed Bluesky creators follow this account
 *   search    a web search on one of the admin's topics surfaced the profile, or
 *             a keyword search found the community / custom feed (v4.6)
 * plus a bonus for reach (subscribers / followers / likes, log-scaled, up to +3),
 * a bonus when the name/bio reads male-focused, and a heavy penalty when
 * it reads female-focused. Everything passes the same safety gate as ingest:
 * a blocked bio rejects the candidate permanently.
 *
 * Network budget: Bluesky graph reads are free; web searches go through Brave
 * with a per-day cap (Admin → Settings). Mention mining is pure SQL.
 *
 * This file wires the run loop and re-exports the strategies, which live in src/engine/discovery/*.js.
 */
const config = require('../config');
const repo = require('../db/repo');
const settingsStore = require('../settings');
const events = require('./events');
const brave = require('../lib/brave');
const websearch = require('../lib/websearch');
const tgBot = require('../lib/telegram-bot');
const { normalizeBskyActor } = require('../lib/bsky-actor');
const { WEIGHTS, CAPS, scoreOf } = require('./discovery-score');
const { fetchBskyProfiles, coreHandle, usable, consider, mineMentions, notePaidHandles, noteOnlyFans, noteSearchedPaid } = require('./discovery/core');
const { blueskyGraph, braveIdentity, braveTopics, communityDiscovery, archivePosts, redditPosters, imageKeywordDiscovery, creatorHangouts, blueskySuggested, peopleSearch, mentionSearchQuery, probeFediMentions, discoverCreatorMentions, _setImageProvider } = require('./discovery/social');
const { probeOnlyFans, coomerDiscovery, coomerIndexDiscovery, coomerNameDiscovery, directoryHarvest, onlyfansDiscovery } = require('./discovery/paid');
const { fetchPerformerDirectory, gffDiscovery, gffNextPage, xhamsterDiscovery, pornhubDiscovery } = require('./discovery/performers');
const { seedCreators, seedStatus, enrich, follow, reject, promote } = require('./discovery/decisions');

/* -------------------------------------------------------------------- run */
let running = false;
let timer = null;
let stopFlag = false;

async function run({ trigger = 'schedule' } = {}) {
  if (running) return { skipped: 'already running' };
  running = true; stopFlag = false;
  require('../lib/blockwatch').work('discovery');
  const s = settingsStore.get();
  const aborted = () => stopFlag;
  const started = Date.now();
  const report = { trigger, startedAt: new Date(started).toISOString() };
  try {
    report.mentions = mineMentions();
    if (s.discoveryGraph) report.graph = await blueskyGraph({ aborted });
    // Free tiers cost nothing per query: SearXNG and the keyless Bing/DuckDuckGo pair. When a paid
    // budget is in play, spend it deliberately (fewer, richer queries); when it is not — budget set
    // to 0, or no Brave key at all — search is still free, so search MORE rather than not at all.
    // (The old gate skipped topic/identity search entirely when braveDailyBudget was 0 and no
    // SearXNG was configured, even though keyless search was right there.)
    const free = websearch.PROVIDERS.searxng.configured() || s.braveDailyBudget === 0 || !brave.configured();
    if (websearch.configured() && (free || s.braveDailyBudget > 0)) {
      report.aiQueries = await require('./ai').planQueries();
      report.identity = await braveIdentity({ creators: free ? 10 : 5, budget: s.braveDailyBudget, aborted });
      try { report.linkhubs = await require('./creators').crawlLinkHubs({ limit: 6 }); } catch (e) { report.linkhubs = { error: e.message }; }
      report.topics = await braveTopics({ queries: free ? 3 : 1, budget: s.braveDailyBudget, aborted });
    }
    report.seeds = await seedCreators({ aborted });
    if (s.discoveryOnlyFans) report.onlyfans = await onlyfansDiscovery({ budget: s.braveDailyBudget, aborted });
    if (s.discoveryOnlyFans && !config.isTest) report.coomer = await coomerDiscovery({ aborted });
    if (!config.isTest) report.gff = await gffDiscovery({ aborted, pages: s.gffDirectoryPages });
    if (!config.isTest) report.xhamster = await xhamsterDiscovery({ aborted });
    if (!config.isTest) report.pornhub = await pornhubDiscovery({ aborted });
    if (s.discoveryOnlyFans && s.coomerIndexFollows > 0 && !config.isTest) report.coomerIndex = await coomerIndexDiscovery({ limit: s.coomerIndexFollows, aborted });
    if (s.discoveryOnlyFans && s.coomerNameFollows > 0 && !config.isTest) report.coomerNames = await coomerNameDiscovery({ limit: s.coomerNameFollows, aborted });
    if (s.imageMatch && !config.isTest) report.imageMatch = await require('./imagematch').run({ aborted, budget: s.braveDailyBudget });
    if (s.discoveryCommunities) report.communities = await communityDiscovery({ aborted });
    if (s.discoveryCommunities) report.hangouts = creatorHangouts();
    if (s.discoveryPosters && s.redditEnabled && !config.isTest) report.posters = await redditPosters({ subreddits: s.posterSubreddits, leads: s.posterLeads, aborted });
    if (s.discoveryImageKeywords && !config.isTest) report.images = await imageKeywordDiscovery({ hits: s.imageKeywordHits, leads: s.imageKeywordLeads, aborted });
    if (s.discoveryExpand) {
      report.suggested = await blueskySuggested({ aborted });
      report.people = await peopleSearch({ aborted });
      report.creatorMentions = await discoverCreatorMentions({ budget: s.braveDailyBudget, aborted });
    }
    report.identities = require('./identity').scan();
    if (s.discoveryExpand && !config.isTest) report.harvest = await directoryHarvest({ budget: s.braveDailyBudget, aborted });
    report.enrich = await enrich();
    report.aiTriage = await require('./ai').triage();
    report.aiProfiles = await require('./ai').readProfiles();
    report.promote = s.autoDiscover || trigger === 'manual' ? promote(s) : { followed: 0, linked: 0 };
    report.pruned = repo.candidates.prune();
    events.log('INFO', `Discovery ${trigger === 'manual' ? '(manual) ' : ''}finished: ${report.mentions.found} mention leads, ${report.graph ? report.graph.found : 0} graph leads, ${report.topics ? report.topics.found : 0} search leads, ${report.communities ? report.communities.found : 0} community/feed leads, ${report.hangouts ? report.hangouts.found : 0} hangouts, ${report.posters ? report.posters.found : 0} prolific Reddit posters (${report.posters ? report.posters.measured : 0} people measured in ${report.posters ? report.posters.subreddits : 0} communities), ${report.images ? report.images.found : 0} image-search leads (${report.images ? report.images.duplicates : 0} pictures already stored), ${report.suggested ? report.suggested.found : 0} Bluesky suggestions, ${report.people ? report.people.found : 0} people-search leads, ${report.identity ? report.identity.linked : 0} identity matches, ${report.seeds ? report.seeds.followed : 0} named creators found, ${report.onlyfans ? report.onlyfans.found : 0} OnlyFans creators traced (${report.onlyfans ? report.onlyfans.linked : 0} accounts linked), ${report.identities.links} same-creator links (${report.identities.merged} merged), ${report.harvest ? report.harvest.read : 0} directory pages harvested (${report.harvest ? report.harvest.leads : 0} paid leads, ${report.harvest ? report.harvest.candidates : 0} profile links), ${report.gff ? report.gff.followed : 0} performer-directory follows, ${report.coomerIndex ? report.coomerIndex.feeds : 0} creators followed from coomer's creator index (${report.coomerIndex && report.coomerIndex.indexed ? report.coomerIndex.matched : 0} matched of ${report.coomerIndex ? report.coomerIndex.checked : 0} paid handles), ${report.coomerNames ? report.coomerNames.feeds : 0} creators matched on coomer by name, ${report.coomer ? report.coomer.verified : 0} coomer pages verified male (${report.coomer ? report.coomer.deferred : 0} deferred), ${report.imageMatch ? report.imageMatch.pages : 0} image-matched pages; followed ${report.promote.followed}, linked ${report.promote.linked}`);
  } catch (e) {
    report.error = e.message;
    events.log('ERR', `Discovery failed: ${e.message}`);
  } finally {
    require('../lib/blockwatch').work('idle');
    report.durationMs = Date.now() - started;
    repo.discoveryState.set('lastRun', JSON.stringify(report));
    running = false;
  }
  return report;
}

/**
 * Which kinds of signal bring creators who actually post: for every followed/linked lead, credit
 * the signal that contributed most to its score, and count how many of those creators have
 * published media since. Lets the admin see which rules earn their keep.
 */
function signalYield() {
  const out = new Map();
  for (const c of repo.db.prepare(`SELECT ca.signals, cr.media_count FROM candidates ca LEFT JOIN creators cr ON cr.id = ca.creator_id
      WHERE ca.status IN ('followed', 'linked')`).iterate()) {
    let sig = {}; try { sig = JSON.parse(c.signals || '{}'); } catch { sig = {}; }
    let best = null; let bw = 0;
    for (const [k, w] of Object.entries(WEIGHTS)) { const v = w * Math.min((sig[k] || []).length, CAPS[k]); if (v > bw) { bw = v; best = k; } }
    if (!best) continue;
    const e = out.get(best) || { signal: best, followed: 0, posting: 0 };
    e.followed++; if ((c.media_count || 0) > 0) e.posting++;
    out.set(best, e);
  }
  return [...out.values()].sort((a, b) => b.followed - a.followed);
}

function status() {
  let last = null;
  try { last = JSON.parse(repo.discoveryState.get('lastRun') || 'null'); } catch { last = null; }
  const s = settingsStore.get();
  return {
    running, last, counts: repo.candidates.counts(), yield: signalYield(),
    brave: { configured: brave.configured(), usage: brave.usage(), budget: s.braveDailyBudget },
    websearch: websearch.status(),
    telegramBot: tgBot.configured(), xApi: !!config.creds.xBearer, communities: s.discoveryCommunities, autoCommunities: s.discoveryAutoCommunities, expand: s.discoveryExpand,
    onlyfans: { enabled: s.discoveryOnlyFans, ...repo.onlyfans.counts() },
    seeds: seedStatus(),
    ai: { ...require('../lib/llm').status(), discovery: s.aiDiscovery, plannedQueries: require('./ai').plannedQueries() },
    auto: s.autoDiscover, intervalMin: s.discoveryIntervalMin, threshold: s.discoveryAutoFollowScore,
  };
}

/** Background loop: checks every 5 minutes whether a run is due (so interval changes apply live). */
function start() {
  if (timer) return;
  timer = setInterval(() => {
    const s = settingsStore.get();
    if (!s.schedulerEnabled || !s.autoDiscover || running) return;
    let last = 0;
    try { last = new Date(JSON.parse(repo.discoveryState.get('lastRun') || '{}').startedAt || 0).getTime(); } catch { last = 0; }
    if (Date.now() - last >= s.discoveryIntervalMin * 60000) run().catch(() => {});
  }, 5 * 60 * 1000);
  timer.unref();
}
function stop() { stopFlag = true; clearInterval(timer); timer = null; }

module.exports = { normalizeBskyActor, fetchBskyProfiles, archivePosts, fetchPerformerDirectory, seedCreators, seedStatus,onlyfansDiscovery, coomerDiscovery, coomerIndexDiscovery, coomerNameDiscovery, gffDiscovery, gffNextPage, xhamsterDiscovery, pornhubDiscovery, directoryHarvest, discoverCreatorMentions, mentionSearchQuery, probeFediMentions, noteOnlyFans, notePaidHandles, noteSearchedPaid, probeOnlyFans, run, status, statusSummary: status, start, stop, follow, reject, promote, consider, mineMentions, blueskyGraph, braveIdentity, braveTopics, communityDiscovery, creatorHangouts, redditPosters, imageKeywordDiscovery, _setImageProvider, blueskySuggested, peopleSearch, signalYield, enrich, scoreOf, coreHandle, usable };
