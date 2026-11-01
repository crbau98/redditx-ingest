import { h, icon, fmt, toast, avatar, debounce } from '../../dom.js';
import { adminGet, adminPost, adminPut } from '../../api.js';
import { parse, navigate } from '../../router.js';
import { table, pager, toggle, platBadge, pageHead, act, kpi } from './ui.js';

const STATUSES = [['pending', 'Waiting'], ['followed', 'Followed'], ['linked', 'Linked to a creator'], ['rejected', 'Rejected'], ['all', 'All']];
const SIGNAL_LABEL = { identity: 'same name', mention: 'mentioned', cofollow: 'followed by', search: 'search', similar: 'looks like', hangout: 'creators post here', ofconfirmed: 'runs a paid page', onlyfans: 'same handle as a paid page' };
// What each strategy found on the last run (keys of the run report).
const STRATEGIES = [['mentions', 'Mentions'], ['graph', 'Bluesky follows'], ['lookalikes', 'Lookalikes'], ['people', 'People search'], ['communities', 'Communities & feeds'], ['hangouts', 'Where creators post'], ['topics', 'Web topics'], ['identity', 'Same-name search'], ['onlyfans', 'Paid pages traced'], ['seeds', 'Named creators'], ['harvest', 'Directory harvest'], ['coomer', 'Coomer creators'], ['gff', 'Performer dir'], ['imageMatch', 'Image match']];
// Which number each strategy's badge shows: its own yield, else found/linked.
const YIELD = { harvest: 'leads', coomer: 'feeds', gff: 'followed', imageMatch: 'pages' };
const foundOf = (r, key) => {
  if (!r) return null;
  const y = YIELD[key];
  if (y && r[y] !== undefined) return r[y];
  return r.found !== undefined ? r.found : r.linked || 0;
};
const SCOPE = { in: ['good', 'male-focused'], uncertain: ['', 'unclear'], excluded: ['bad', 'off-topic'] };
/** Hover text for a strategy badge: a sentence for the new passes (raw JSON means nothing here),
 * the run report itself for everything else. */
function describeRun(key, r) {
  if (!r) return '';
  const rej = r.rejected ? ` · ${r.rejected} rejected` : '';
  if (key === 'harvest') return `${r.searched} searches${r.failed ? ` · ${r.failed} failed` : ''} · ${r.read} directory/list pages read · ${r.leads} paid-page leads found · ${r.candidates} profile links${rej}`;
  if (key === 'coomer') return `${r.searched} keyword queries on the mirror · ${r.creators} creators indexed · ${r.feeds} feeds registered${rej}`;
  if (key === 'gff') return `${r.scanned} ranked performers scanned · ${r.followed} followed${rej}`;
  if (key === 'imageMatch') return `${r.creators} creators image-matched · ${r.pictures} of his pictures found elsewhere · ${r.pages} page${r.pages === 1 ? '' : 's'} registered${r.error ? ` · ${r.error}` : ''}`;
  return JSON.stringify(r);
}

const KIND_LABEL = { community: 'community', feedgen: 'custom feed', list: 'list', page: 'link page' };
const reach = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 100) / 10}k` : String(n));

function signalChips(sig) {
  const svcOf = (k, v) => {
    if ((k !== 'ofconfirmed' && k !== 'onlyfans') || !Array.isArray(v) || !v[0] || !String(v[0]).includes(':')) return '';
    const svc = String(v[0]).split(':')[0];
    return ` · ${svc === 'JustFor.Fans' ? 'JFF' : svc}`;
  };
  const chips = Object.entries(sig || {}).filter(([k, v]) => SIGNAL_LABEL[k] && Array.isArray(v) && v.length).map(([k, v]) =>
    h('span', { class: `badge sig-${k}`, title: k === 'search' ? v.join('\n') : `${v.length} distinct source${v.length === 1 ? '' : 's'}` }, `${SIGNAL_LABEL[k]}${svcOf(k, v)} ×${v.length}`));
  const pop = Number(sig && sig.popularity) || 0;
  if (pop) chips.push(h('span', { class: 'badge sig-reach', title: 'Audience: subscribers, followers or likes. Counts toward the score (log-scaled, up to +3).' }, icon('users', 'sm'), reach(pop)));
  return h('div', { class: 'row wrap', style: { gap: '4px' } }, chips);
}

function scoreBar(score, threshold) {
  const pct = Math.max(0, Math.min(100, (score / Math.max(threshold * 1.5, 1)) * 100));
  return h('div', { class: 'scorebar', title: `Score ${score} (auto-follow at ${threshold})` }, h('div', { class: `fill${score >= threshold ? ' hot' : ''}`, style: { width: `${pct}%` } }), h('span', { class: 'num' }, score));
}

export async function render(root) {
  const q = parse().query;
  const f = { status: q.get('status') || 'pending', q: q.get('q') || '', sort: q.get('sort') || 'score', platform: q.get('platform') || '', page: parseInt(q.get('page') || '0', 10) };
  const set = (patch) => navigate('/admin/discovery', { ...f, ...patch }, { replace: true });
  const head = h('div'); const kpis = h('div', { class: 'kpis' }); const tableHost = h('div'); const tune = h('div'); const ofHost = h('div');
  const selected = new Set();
  let data; let seedsText = '';

  const runBtn = h('button', { class: 'btn primary', onclick: (e) => act(e.currentTarget, async () => { await adminPost('/discovery/run'); toast('Discovery started — watch the Live log', 'ok'); setTimeout(load, 2500); }) }, icon('sparkle', 'sm'), 'Run discovery now');
  head.append(pageHead('Discovery', 'Finds creators you are not following yet: who your creators mention and follow, keyword searches on Reddit, Lemmy and Bluesky, directory and list pages across the open web, the Coomer index and the GayForFans performer ranking, then image-matches their content — scores every lead and follows the strong ones automatically.', runBtn));

  const search = h('input', { class: 'input sm', type: 'search', 'aria-label': 'Search candidates', placeholder: 'Search candidates…', value: f.q, style: { maxWidth: '220px' } });
  search.addEventListener('input', debounce(() => set({ q: search.value.trim(), page: 0 }), 350));
  const PLATFORMS = [['', 'All platforms'], ['bluesky', 'Bluesky'], ['reddit', 'Reddit'], ['redgifs', 'RedGIFs'], ['x', 'X'], ['telegram', 'Telegram'], ['mastodon', 'Mastodon'], ['misskey', 'Misskey'], ['lemmy', 'Lemmy'], ['tumblr', 'Tumblr'], ['peertube', 'PeerTube'], ['linkinbio', 'Link pages']];
  const bar = h('div', { class: 'toolbar' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Status' }, STATUSES.map(([v, l]) => h('button', { class: f.status === v ? 'on' : '', onclick: () => set({ status: v, page: 0 }) }, l))),
    search,
    h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Platform', onchange: (e) => set({ platform: e.target.value, page: 0 }) }, PLATFORMS.map(([v, l]) => h('option', { value: v, selected: f.platform === v }, l))),
    h('select', { class: 'select sm', style: { width: 'auto' }, 'aria-label': 'Sort', onchange: (e) => set({ sort: e.target.value }) }, [['score', 'Best score'], ['recent', 'Recently seen'], ['new', 'Newest']].map(([v, l]) => h('option', { value: v, selected: f.sort === v }, l))),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn sm', onclick: (e) => bulk(e.currentTarget, 'follow') }, icon('check', 'sm'), 'Follow selected'),
    h('button', { class: 'btn sm', onclick: (e) => bulk(e.currentTarget, 'reject') }, icon('x', 'sm'), 'Reject selected'));

  async function bulk(btn, action) {
    if (!selected.size) { toast('Select candidates first'); return; }
    const r = await act(btn, () => adminPost('/discovery/candidates', { ids: [...selected], action }));
    if (r) { toast(`${r.ok} ${action === 'follow' ? 'followed' : 'rejected'}${r.failed ? ` · ${r.failed} failed` : ''}`, r.failed ? '' : 'ok'); selected.clear(); load(); }
  }
  const decide = (c, action) => async (e) => {
    const r = await act(e.currentTarget, () => adminPost(`/discovery/candidates/${c.id}`, { action }));
    if (r) { toast(action === 'follow' ? `Following ${c.display_name || c.target} — first sync queued` : action === 'block' ? 'Blocked — it will never be suggested again' : 'Rejected', 'ok'); load(); }
  };

  const runLine = h('div', { class: 'run-lines' });
  function paintRun(d) {
    const last = d.last;
    const rows = [];
    if (last) rows.push(h('div', { class: 'run-strategies' }, h('span', { class: 'muted' }, 'Last run found:'),
      ...STRATEGIES.filter(([k]) => last[k]).map(([k, l]) => h('span', { class: `badge${foundOf(last[k], k) ? ' good' : ''}`, title: describeRun(k, last[k]) }, `${l} ${foundOf(last[k], k)}`))));
    if (d.yield && d.yield.length) rows.push(h('div', { class: 'run-strategies', title: 'For creators discovery followed: the signal that weighed most, and how many have posted since' },
      h('span', { class: 'muted' }, 'Followed creators now posting, by strongest signal:'),
      ...d.yield.map((y) => h('span', { class: `badge sig-${y.signal}` }, `${SIGNAL_LABEL[y.signal] || y.signal} ${y.posting}/${y.followed}`))));
    runLine.replaceChildren(...rows);
  }

  function paintKpis(d) {
    const last = d.last;
    const lastLine = last ? `${fmt.ago(last.startedAt)} · ${last.promote ? `${last.promote.followed} followed, ${last.promote.linked} linked` : last.error || ''}` : 'never';
    kpis.replaceChildren(
      kpi({ value: fmt.int(d.counts.pending), label: 'Waiting for a decision', detail: `auto-follow at score ${d.threshold}` }),
      kpi({ value: fmt.int(d.counts.followed), label: 'Creators followed', detail: `${fmt.int(d.counts.followedToday)} in the last 24h` }),
      kpi({ value: fmt.int(d.counts.linked), label: 'Accounts linked', detail: 'other accounts of known creators' }),
      webKpi(d),
      kpi({ value: d.running ? 'Running…' : d.auto ? 'On' : 'Manual', label: 'Discovery', detail: `last run ${lastLine}` }));
  }

  // Web search can be configured and still find nothing (SearXNG engines blocked by CAPTCHAs): show what really happened.
  function webKpi(d) {
    const w = d.websearch || { configured: false, providers: [] };
    if (!w.configured) return kpi({ value: '—', label: 'Web search', detail: 'not set up: SEARXNG_URL or BRAVE_API_KEY' });
    const used = w.providers.filter((p) => p.configured);
    const tried = used.filter((p) => p.lastAt);
    const bad = tried.find((p) => p.lastError);
    const engines = used.flatMap((p) => p.engines || []);
    const cooldownBits = [];
    if (w.ddgCooldown) cooldownBits.push(`DuckDuckGo /html/ walled until ${new Date(w.ddgCooldown).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    if (w.ddgLiteCooldown) cooldownBits.push(`DuckDuckGo Lite walled until ${new Date(w.ddgLiteCooldown).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    if (w.bingCooldown) cooldownBits.push(`Bing decoys until ${new Date(w.bingCooldown).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    const cooldown = cooldownBits.length ? ` · ${cooldownBits.join(' · ')}` : '';
    const detail = (bad ? `${bad.name}: ${bad.lastError}`
      : tried.length ? `${tried.map((p) => `${p.name} ${fmt.int(p.ok)} ok · ${fmt.int(p.empty)} empty · ${fmt.int(p.failed)} failed`).join(' / ')}${engines.length ? ` · failing engines: ${engines.join(', ')}` : ''}`
        : `${used.map((p) => p.name).join(', ')} · not used since the server started`) + cooldown;
    const value = w.working ? 'Working' : bad ? 'Failing' : tried.length ? 'No results' : 'Idle';
    return kpi({ value: d.brave.configured && w.working ? `${d.brave.usage.count}/${d.brave.budget}` : value, label: d.brave.configured && w.working ? 'Brave searches today' : 'Web search', detail });
  }

  function paintTune(d, settings) {
    const v = settings.values;
    const save = async (patch) => { try { await adminPut('/settings', patch); toast('Saved', 'ok'); } catch (e) { toast(e.message, 'err'); } };
    const num = (key, min, max, label) => { const el = h('input', { class: 'input sm', type: 'number', min, max, value: v[key], 'aria-label': label, style: { width: '96px' } }); el.addEventListener('change', () => save({ [key]: el.value })); return el; };
    const queries = h('textarea', { class: 'textarea', rows: 6, spellcheck: 'false', 'aria-label': 'Topic searches' }); queries.value = v.discoveryQueries || '';
    const keywords = h('textarea', { class: 'textarea', rows: 5, spellcheck: 'false', 'aria-label': 'Community keywords' }); keywords.value = v.discoveryKeywords || '';
    const keyBadge = (ok, label, hint) => h('span', { class: `badge ${ok ? 'good' : ''}`, title: hint }, ok ? icon('check', 'sm') : null, label);
    tune.replaceChildren(h('details', { class: 'panel', open: !d.counts.followed && !d.counts.pending ? true : null },
      h('summary', null, h('b', null, 'Tune discovery'), h('span', { class: 'muted', style: { marginLeft: '10px', fontSize: '13px' } }, 'signals, thresholds, search topics')),
      h('div', { class: 'row wrap', style: { gap: '8px', margin: '12px 0' } },
        keyBadge(d.brave.configured, 'Brave search', 'BRAVE_API_KEY — web search for profiles and identity matching'),
        keyBadge(!!(d.websearch && d.websearch.providers.some((p) => p.name === 'searxng' && p.configured)), 'SearXNG', 'SEARXNG_URL — free web search (bundled in deploy/); also finds X posts when there is no X_BEARER_TOKEN'),
        keyBadge(d.xApi, 'X API', 'X_BEARER_TOKEN — reliable X timelines and searches'),
        keyBadge(d.telegramBot, 'Telegram bot', 'TELEGRAM_API_KEY — channel checks and full descriptions'),
        keyBadge(true, 'Bluesky graph', 'Public, no key needed'), keyBadge(true, 'Mentions', 'Read from posts already ingested'),
        keyBadge(v.discoveryCommunities, 'Communities & feeds', 'Reddit subreddit search, Lemmy community lists, Bluesky custom-feed search — public, no key needed')),
      h('div', { class: 'setting' }, h('div', { class: 'l' }, 'Follow strong candidates automatically'), toggle(v.autoDiscover, (on) => save({ autoDiscover: on }))),
      h('div', { class: 'setting' }, h('div', { class: 'l' }, 'Read who your Bluesky creators follow'), toggle(v.discoveryGraph, (on) => save({ discoveryGraph: on }))),
      h('div', { class: 'setting' }, h('div', null, h('div', { class: 'l' }, 'Search for communities and custom feeds'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'NSFW subreddits, Lemmy communities and popular Bluesky feeds matching your keywords')), toggle(v.discoveryCommunities, (on) => save({ discoveryCommunities: on }))),
      h('div', { class: 'setting' }, h('div', null, h('div', { class: 'l' }, 'Lookalikes and people search'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Accounts Bluesky rates as similar to your creators, plus Bluesky and RedGIFs people matching your keywords')), toggle(v.discoveryExpand, (on) => save({ discoveryExpand: on }))),
      h('div', { class: 'setting' }, h('div', null, h('div', { class: 'l' }, 'Trace OnlyFans creators'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'OnlyFans pages your creators promote lead to the same men’s free accounts on RedGIFs, Bluesky, X, Telegram and link pages. Paid pages named by creators are read like any other public page')), toggle(v.discoveryOnlyFans, (on) => save({ discoveryOnlyFans: on }))),
      h('div', { class: 'setting' }, h('div', null, h('div', { class: 'l' }, 'AI image match'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'After a creator is found, search the web for pictures of his and keep the pages where his content shows up (visual match + the page naming him)')), toggle(v.imageMatch, (on) => save({ imageMatch: on }))),
      h('div', { class: 'setting' }, h('div', { class: 'l' }, 'Image match: creators per run'), num('imageMatchPerRun', 0, 30, 'Image match: creators per run')),
      h('div', { class: 'setting' }, h('div', { class: 'l' }, 'Image match: similarity needed (%)'), num('imageMatchSimilarity', 40, 99, 'Image match: visual similarity needed')),
      h('div', { class: 'setting' }, h('div', null, h('div', { class: 'l' }, 'Auto-follow strong communities'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Only male-focused ones; every post from them is still checked on its own')), toggle(v.discoveryAutoCommunities, (on) => save({ discoveryAutoCommunities: on }))),
      h('div', { class: 'setting' }, h('div', null, h('div', { class: 'l' }, 'Auto-follow at score'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'same name = 6 · each creator who mentions them = 3 · Bluesky lookalike (per creator) = 2 · each who follows them = 1.5 · each creator posting there = 1.5 · each search hit = 2 · audience up to +3 · male-focused bio = +2')), num('discoveryAutoFollowScore', 3, 60, 'Auto-follow at score')),
      h('div', { class: 'setting' }, h('div', { class: 'l' }, 'Max follows per run'), num('discoveryMaxFollowsPerRun', 0, 100, 'Max follows per run')),
      h('div', { class: 'setting' }, h('div', { class: 'l' }, 'Run every (minutes)'), num('discoveryIntervalMin', 15, 1440, 'Run every (minutes)')),
      h('div', { class: 'setting' }, h('div', { class: 'l' }, 'Brave searches per day'), num('braveDailyBudget', 0, 2000, 'Brave searches per day')),
      h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', null, 'Web-search topics (one per line — one is searched per run, in rotation)'), queries,
        h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: () => save({ discoveryQueries: queries.value }) }, 'Save topics')),
      h('div', { class: 'field', style: { marginTop: '10px' } }, h('label', null, 'Community keywords (one per line — two are searched per run on Reddit and Bluesky)'), keywords,
        h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: () => save({ discoveryKeywords: keywords.value }) }, 'Save keywords'))));
  }

  const OF_STATUS = { pending: ['', 'not traced yet'], searching: ['warn', 'nothing found yet'], found: ['good', 'accounts found'], claimed: ['info', 'followed creator'], rejected: ['bad', 'rejected'] };
  const OF_HOSTS = { 'OnlyFans': 'onlyfans.com', 'Fansly': 'fansly.com', 'JustFor.Fans': 'justfor.fans' };
  const pageHref = (l) => `https://${OF_HOSTS[l.service] || 'onlyfans.com'}/${l.handle}`;
  const leadAction = (l, action) => adminPost(`/discovery/onlyfans/${encodeURIComponent(l.handle)}`, { action, service: l.service || 'OnlyFans' });
  async function loadOnlyFans() {
    const r = await adminGet('/discovery/onlyfans', { limit: 15 });
    const paste = h('textarea', { class: 'textarea', rows: 3, spellcheck: 'false', 'aria-label': 'Paid profile links', placeholder: 'onlyfans.com/name, fansly.com/name or justfor.fans/name — or just the handle, one per line' });
    const add = h('button', { class: 'btn sm primary', onclick: (e) => act(e.currentTarget, async () => {
      const out = await adminPost('/discovery/onlyfans', { handles: paste.value });
      toast(`${out.added} added${out.claimed ? ` · ${out.claimed} already followed` : ''}${out.invalid.length ? ` · ${out.invalid.length} not recognised` : ''}`, 'ok');
      paste.value = ''; loadOnlyFans();
    }) }, icon('plus', 'sm'), 'Trace these');
    const c = r.counts;
    const seeds = h('textarea', { class: 'textarea', rows: 4, spellcheck: 'false', 'aria-label': 'Creators to find by name', placeholder: 'Christian Hogue\n@somehandle\nhttps://x.com/someone' });
    seeds.value = seedsText;
    const seedRows = ((data && data.seeds) || []).map((sd) => h('div', { class: 'row', style: { gap: '8px', fontSize: '13px', padding: '3px 0' } },
      h('b', null, sd.name),
      !sd.last ? h('span', { class: 'badge' }, 'not looked up yet')
        : sd.creator ? h('a', { class: 'badge good', href: `#/creator/${sd.creator.id}` }, `@${sd.creator.handle} · ${sd.creator.media_count} posts`)
          : h('span', { class: `badge ${sd.last.error ? 'bad' : 'warn'}`, title: sd.last.error || sd.last.note || '' }, sd.last.error ? 'lookup failed' : 'no strong match yet'),
      sd.last && sd.last.onlyfans && sd.last.onlyfans.length ? h('span', { class: 'badge of' }, 'OF') : null,
      sd.last && sd.last.similar ? h('span', { class: 'sub' }, `${sd.last.similar} similar pages found`) : null,
      sd.last ? h('span', { class: 'sub' }, fmt.ago(sd.last.at)) : null));
    ofHost.replaceChildren(h('details', { class: 'panel', style: { marginTop: '14px' } },
      h('summary', null, h('b', null, 'OnlyFans creators'), h('span', { class: 'muted', style: { marginLeft: '10px', fontSize: '13px' } },
        `${fmt.int(c.creators)} followed creators have a page · ${fmt.int(c.pending + c.searching)} pages being traced · ${fmt.int(c.found)} traced to free accounts`)),
      h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Pages named in posts, bios and web searches (OnlyFans, Fansly, JustFor.Fans — paid pages are followed like any public page). Each is traced to the creator’s free public accounts, which then appear in the queue above with their score.'),
      h('div', { class: 'field' }, h('label', null, 'Creators to find by name (one per line). Each is looked up across every platform PRISM reads, two per discovery run, and re-checked monthly'), seeds,
        h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: (e) => act(e.currentTarget, async () => { await adminPut('/settings', { creatorSeeds: seeds.value }); seedsText = seeds.value; toast('Saved: the next discovery run looks them up', 'ok'); }) }, 'Save names')),
      seedRows.length ? h('div', { style: { margin: '6px 0 14px' } }, seedRows) : null,
      h('div', { class: 'field' }, h('label', null, 'Paid pages to trace'), paste, h('div', { style: { marginTop: '8px' } }, add)),
      table([
        { label: 'Page', render: (l) => h('div', { class: 'cell-stack' }, h('span', { class: 'row', style: { gap: '6px', alignItems: 'center' } },
          h('a', { href: pageHref(l), target: '_blank', rel: 'noopener noreferrer nofollow', style: { fontWeight: 600 } }, l.display_name || l.handle),
          l.service && l.service !== 'OnlyFans' ? h('span', { class: 'badge info' }, l.service === 'JustFor.Fans' ? 'JFF' : l.service) : null),
          h('span', { class: 'sub truncate', style: { maxWidth: '300px' }, title: l.bio || '' }, l.bio ? l.bio.slice(0, 100) : `@${l.handle}`)) },
        { label: 'Named by', render: (l) => h('span', { class: 'sub' }, l.origin === 'search' ? 'web search' : l.origin === 'admin' ? 'you' : `${l.mentions} source${l.mentions === 1 ? '' : 's'}`, l.free ? h('span', { class: 'badge good', style: { marginLeft: '6px' } }, 'free') : null) },
        { label: 'Status', render: (l) => h('div', { class: 'cell-stack' }, h('span', { class: `badge ${OF_STATUS[l.status][0]}` }, OF_STATUS[l.status][1]),
          l.creator_handle ? h('a', { class: 'sub', href: `#/creator/${l.creator_id}` }, `@${l.creator_handle}`) : l.accounts.length ? h('span', { class: 'sub' }, l.accounts.map((a) => `${a.platform}${a.proven ? ' ✓' : ''}`).join(' · ')) : l.reason ? h('span', { class: 'sub' }, l.reason) : null) },
        { label: '', render: (l) => h('div', { class: 'actions' }, l.status !== 'claimed' ? [
          h('button', { class: 'btn sm ghost', onclick: (e) => act(e.currentTarget, async () => { await leadAction(l, 'retry'); loadOnlyFans(); }) }, 'Retrace'),
          l.status !== 'rejected' ? h('button', { class: 'btn sm ghost', onclick: (e) => act(e.currentTarget, async () => { await leadAction(l, 'reject'); loadOnlyFans(); }) }, 'Reject') : null] : null) },
      ], r.items, { empty: 'No OnlyFans pages seen yet. They are picked up from posts and bios as feeds sync, or paste some above.' })));
  }

  async function load() {
    const [d, settings] = await Promise.all([adminGet('/discovery', { status: f.status, q: f.q, platform: f.platform || undefined, sort: f.sort, page: f.page, limit: 40 }), data ? Promise.resolve(null) : adminGet('/settings')]);
    data = d;
    if (settings) seedsText = settings.values.creatorSeeds || '';
    paintKpis(d); paintRun(d);
    if (settings) paintTune(d, settings);
    const r = d.candidates;
    tableHost.replaceChildren(
      table([
        { label: '', width: '28px', render: (c) => { const cb = h('input', { type: 'checkbox', checked: selected.has(c.id), 'aria-label': `Select ${c.target}` }); cb.addEventListener('change', () => { if (cb.checked) selected.add(c.id); else selected.delete(c.id); }); return cb; } },
        { label: 'Candidate', render: (c) => h('div', { class: 'row', style: { gap: '10px', minWidth: 0 } }, avatar({ display_name: c.display_name || c.target, avatar_url: c.avatar_url }, 34),
          h('div', { style: { minWidth: 0 } },
            h('a', { href: c.url || '#', target: '_blank', rel: 'noopener noreferrer nofollow', style: { fontWeight: 600 }, class: 'truncate', title: c.target }, c.display_name || c.label || c.target),
            h('div', { class: 'sub truncate', style: { maxWidth: '320px' }, title: c.bio || '' }, c.bio ? c.bio.slice(0, 120) : c.target))) },
        { label: 'Source', render: (c) => h('div', { class: 'cell-stack' }, platBadge(c.platform), c.kind !== 'user' ? h('span', { class: 'sub' }, KIND_LABEL[c.kind] || c.kind) : null) },
        { label: 'Why', render: (c) => h('div', { class: 'cell-stack' }, signalChips(c.signals), h('span', { class: `badge ${SCOPE[c.scope][0]}` }, SCOPE[c.scope][1]), c.reason && c.reason !== 'checked' ? h('span', { class: 'sub', style: { maxWidth: '220px' } }, c.reason) : null) },
        { label: 'Score', width: '130px', render: (c) => scoreBar(c.score, d.threshold) },
        { label: 'Seen', render: (c) => h('span', { class: 'sub' }, fmt.ago(c.last_seen)) },
        { label: '', render: (c) => h('div', { class: 'actions' },
          c.status === 'pending' ? [
            h('button', { class: 'btn sm primary', onclick: decide(c, 'follow') }, 'Follow'),
            h('button', { class: 'btn sm', onclick: decide(c, 'reject') }, 'Reject'),
            h('button', { class: 'btn icon sm ghost', title: 'Block: never suggest or ingest', 'aria-label': 'Block', onclick: decide(c, 'block') }, icon('lock', 'sm'))]
            : h('button', { class: 'btn sm ghost', onclick: decide(c, 'reset') }, 'Undo')) },
      ], r.items, { empty: f.status === 'pending' ? 'Nothing waiting. Run discovery, or add search topics below — results also arrive on their own every hour.' : 'Nothing here yet.' }),
      pager({ page: r.page, limit: r.limit, total: r.total, onPage: (p) => set({ page: p }) }));
  }

  root.append(head, kpis, runLine, tune, ofHost, bar, tableHost);
  await load();
  loadOnlyFans().catch(() => {});
  const timer = setInterval(() => { if (root.isConnected && data && data.running) load().catch(() => {}); }, 5000);
  return () => clearInterval(timer);
}
