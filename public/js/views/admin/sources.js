import { h, icon, toast, fmt } from '../../dom.js';
import { adminGet, adminPost, adminPatch } from '../../api.js';
import { href } from '../../router.js';
import { pageHead, act, platBadge } from './ui.js';

const ENV_HELP = {
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  bluesky: ['BSKY_IDENTIFIER', 'BSKY_APP_PASSWORD'],
  x: ['X_BEARER_TOKEN'],
  mastodon: ['MASTODON_ACCESS_TOKEN (optional)', 'MASTODON_INSTANCES'],
  lemmy: ['LEMMY_INSTANCES'],
  telegram: ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'MEDIA_STORE_* (bucket)'],
};
const BLURB = {
  reddit: 'Communities and individual redditors. Falls back through OAuth → public JSON → old.reddit → RSS → archive, so it keeps working when Reddit blocks servers.',
  redgifs: 'Creator pages, niches and searches via the public RedGIFs API. Reddit posts linking to RedGIFs are resolved automatically.',
  bluesky: 'Creator timelines (media posts only) through the public AppView. Video plays via HLS. Search needs an app password.',
  mastodon: 'Creators and hashtags on any Mastodon-compatible server. Public API; some servers require sign-in for public timelines. Boosts are kept and credited to the original poster.',
  tumblr: 'Blogs and tags through Tumblr’s public RSS. Reblogs are kept and credited to the original blog; images are upgraded to the largest size.',
  peertube: 'PeerTube accounts, channels, tags and keyword search across the federation (Sepia Search). Videos play as MP4 or HLS.',
  lemmy: 'Communities and users on Lemmy instances (API v3 with v4 fallback).',
  x: 'Creator timelines and searches. The official API (bearer token) is reliable; without it only a best-effort keyless route is available.',
  telegram: 'Two ways in. Public channels through the web preview (t.me/s/…, no login). And, once you log in (node scripts/telegram-login.js), every channel and group your account has joined, public or private, with full history; files are copied into your bucket (R2/B2) so nothing sits on the server.',
  rss: 'Any RSS / Atom / JSON Feed — creators’ own sites, Tumblr blogs (/rss), Mastodon and Bluesky profile feeds. The most stable way to follow anything.',
  web: 'A single page’s photos and videos (OpenGraph, <video>, linked images). Respects robots.txt.',
  linkinbio: 'Linktree-style hubs. Not content: PRISM reads them to discover a creator’s other public accounts.',
};

const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** One feed line of the health panel: platform, name (links to the feed list), why it is listed, and a pause button. */
function healthRow(f, why, reload) {
  return h('div', { class: 'row wrap', style: { gap: '8px', padding: '6px 0', borderTop: '1px solid var(--line, rgba(127,127,127,.15))' } },
    platBadge(f.platform),
    h('a', { href: href('/admin/feeds', { platform: f.platform, q: f.target }), style: { fontWeight: 600 } }, f.label),
    h('span', { class: 'muted', style: { fontSize: '12.5px' } }, why),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn sm ghost', title: 'Stop reading this feed (it can be switched back on under Feeds)', onclick: (e) => act(e.currentTarget, async () => { await adminPatch(`/feeds/${f.id}`, { enabled: false }); await reload(); }, 'Feed paused') }, 'Pause'));
}

function healthPanel(r, reload) {
  const section = (title, tone, rows, why, hint) => (rows.length ? h('details', { open: tone === 'bad' },
    h('summary', { style: { cursor: 'pointer', fontWeight: 600, padding: '6px 0' } }, `${title} `, h('span', { class: `badge ${tone}` }, String(rows.length))),
    hint ? h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '2px 0 6px' } }, hint) : null,
    rows.map((f) => healthRow(f, why(f), reload))) : null);
  const t = r.totals;
  return h('div', { class: 'panel' },
    h('h3', null, icon('trend', 'sm'), 'Feed health'),
    h('p', { class: 'muted', style: { fontSize: '13.5px' } }, `${fmt.int(t.enabled)} of ${fmt.int(t.feeds)} feeds on${t.neverRun ? ` · ${fmt.int(t.neverRun)} not run yet` : ''} · ${t.failing} failing · ${t.stale} stale · ${t.dead} not adding anything`),
    !t.failing && !t.stale && !t.dead ? h('p', { class: 'muted', style: { fontSize: '13.5px' } }, 'Every active feed is working and adding posts.') : null,
    section('Failing', 'bad', r.failing, (f) => `${f.failures} failed runs in a row${f.lastError ? ` · ${f.lastError.slice(0, 140)}` : ''}`),
    section('Stale', 'warn', r.stale, (f) => `last good run ${ago(f.lastSuccessAt)}`, `No good run for ${r.rules.staleDays}+ days (resting after errors, or its platform is paused).`),
    section('Not adding anything', 'warn', r.dead, (f) => `${f.runs} runs in ${r.rules.deadDays} days, 0 added · ${f.why}`, 'Pausing these frees their slot for feeds that bring new posts.'),
    r.top.length ? h('details', null, h('summary', { style: { cursor: 'pointer', fontWeight: 600, padding: '6px 0' } }, 'Best feeds this week'),
      r.top.map((f) => h('div', { class: 'row wrap', style: { gap: '8px', padding: '4px 0' } }, platBadge(f.platform),
        h('a', { href: href('/admin/feeds', { platform: f.platform, q: f.target }) }, f.label), h('span', { class: 'muted', style: { fontSize: '12.5px' } }, `${fmt.int(f.added)} added in ${f.runs} runs`)))) : null);
}

const dot = (ok) => h('span', { class: `dot ${ok ? 'good' : 'warn'}` });
const line = (ok, label, text) => h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, dot(ok), h('span', null, h('b', null, `${label}: `), h('span', { class: 'muted' }, text)));

/** Browser rendering engines, Claude and Bright Data: what is switched on, what is spent today. Never shows a key. */
function enginesPanel(b, a, reload) {
  const r = b.render || { engine: 'browser4', browser4: b, playwright: { enabled: false, reason: 'not reported' } };
  const eng = (e) => (e.ok ? `ready${e.version ? ` (v${e.version})` : ''}${e.running ? ' · running' : ''}` : (e.reason || 'off'));
  const u = a.usage || { calls: 0, input: 0, output: 0, refusals: 0 };
  return h('div', { class: 'panel' },
    h('h3', null, icon('sparkle', 'sm'), 'Engines: browsers and AI'),
    h('div', { class: 'meta', style: { display: 'grid', gap: '6px' } },
      line(true, 'Pages built by JavaScript are read with', `${r.engine === 'playwright' ? 'Playwright' : 'Browser4'} (RENDER_ENGINE=${r.setting || 'auto'}, mode ${b.mode})`),
      line(r.browser4.ok, 'Browser4', eng(r.browser4)),
      line(r.playwright.ok, 'Playwright', eng(r.playwright)),
      b.brightdata ? line(b.brightdata.discover.configured || b.brightdata.unlocker.configured, 'Bright Data', `Discover ${b.brightdata.discover.configured ? 'on' : 'off'} · Unlocker ${b.brightdata.unlocker.configured ? `${b.brightdata.unlocker.mode}, ${b.brightdata.unlocker.usage.count || 0}/${b.brightdata.unlocker.budgetPerDay} today` : 'off'}`) : null,
      line(a.configured, 'Claude', a.configured ? `${a.model} · ${fmt.int(u.calls)}/${fmt.int(a.budget)} requests today · ${fmt.int(u.input)} in / ${fmt.int(u.output)} out tokens${u.refusals ? ` · ${u.refusals} declined` : ''}` : 'off (set ANTHROPIC_API_KEY)'),
      a.configured ? line(a.search || a.discovery, 'Claude does', [a.search ? 'search reading' : null, a.discovery ? 'discovery queries + account triage' : null].filter(Boolean).join(' · ') || 'nothing (both settings off)') : null,
      (a.plannedQueries || []).length ? h('details', null, h('summary', { style: { cursor: 'pointer' } }, `${a.plannedQueries.length} discovery queries Claude planned today`),
        h('ul', { class: 'muted', style: { fontSize: '13px', margin: '4px 0 0 18px' } }, a.plannedQueries.map((q) => h('li', null, q)))) : null),
    a.configured ? h('div', { class: 'row wrap', style: { marginTop: '8px' } },
      h('button', { class: 'btn sm', title: 'Ask Claude for new discovery searches now', onclick: (e) => act(e.currentTarget, async () => { const x = await adminPost('/ai/plan'); toast(`${x.planned} new queries planned`); await reload(); }) }, icon('sparkle', 'sm'), 'Plan queries now'),
      h('button', { class: 'btn sm', title: 'Judge the next discovered accounts from their public name and bio', onclick: (e) => act(e.currentTarget, async () => { const x = await adminPost('/ai/triage'); toast(`${x.judged} judged · ${x.boosted} boosted · ${x.held} held · ${x.rejected} rejected`); await reload(); }) }, icon('shield', 'sm'), 'Triage accounts now')) : null);
}

export async function render(root) {
  const grid = h('div', { class: 'source-grid' });
  const health = h('div');
  const engines = h('div');
  root.append(pageHead('Sources', 'The platforms PRISM can pull from, and how healthy each connection is.',
    h('button', { class: 'btn sm', onclick: (e) => act(e.currentTarget, async () => { await adminPost('/engine/breakers/reset'); await load(); }, 'Circuit breakers reset') }, icon('refresh', 'sm'), 'Reset circuit breakers')), grid, engines, health,
  h('div', { class: 'panel' }, h('h3', null, icon('shield', 'sm'), 'Safety and boundaries'),
    h('p', { class: 'muted', style: { fontSize: '14px' } }, 'PRISM reads public creator content from across the web — personal sites, social profiles, galleries, RSS feeds — and follows what creators publish. Everything passes a safety gate (anything suggesting a person may be under 18 is dropped) and every item can be reported and permanently blocklisted.')));

  async function load() {
    adminGet('/sources/health').then((r) => health.replaceChildren(healthPanel(r, load))).catch(() => {});
    Promise.all([adminGet('/browser4'), adminGet('/ai')]).then(([b, a]) => engines.replaceChildren(enginesPanel(b, a, load))).catch(() => {});
    const sources = await adminGet('/sources');
    grid.replaceChildren(...sources.map((s) => {
      const confs = Object.entries(s.config);
      const bad = confs.filter(([, c]) => !c.ok);
      const br = s.breaker;
      return h('div', { class: 'source', style: { '--c': s.color } },
        h('h3', null, h('span', { class: 'dot', style: { background: s.color } }), s.label, h('span', { class: 'grow' }),
          br.state !== 'closed' ? h('span', { class: 'badge warn' }, `resting · ${br.state}`) : bad.length ? h('span', { class: 'badge warn' }, bad.length === confs.length ? 'needs setup' : 'partial') : h('span', { class: 'badge good' }, 'ready')),
        h('p', { class: 'muted', style: { fontSize: '13.5px' } }, BLURB[s.platform] || ''),
        h('div', { class: 'meta' },
          h('div', null, icon('rss', 'sm'), `${s.feeds.enabled || 0} active · ${s.feeds.total || 0} feeds`, s.feeds.failing ? h('span', { class: 'badge bad' }, `${s.feeds.failing} failing`) : null),
          confs.map(([k, c]) => h('div', null, h('span', { class: `dot ${c.ok ? 'good' : 'warn'}` }), h('span', null, `${k}: `, c.note || (c.ok ? 'ok' : 'unavailable')))),
          br.lastError ? h('div', { style: { color: 'var(--warn)' } }, icon('alert', 'sm'), br.lastError) : null,
          ENV_HELP[s.platform] ? h('div', { class: 'muted', style: { fontSize: '12px' } }, `Env: ${ENV_HELP[s.platform].join(', ')}`) : null),
        s.score ? h('div', { class: 'muted', style: { fontSize: '12.5px' }, title: 'Last 7 days' },
          `7d: ${fmt.int(s.score.added)} added · ${s.score.yieldPerRun}/run · ${s.score.creators} creators · ${s.score.errorRate}% errors · ${s.score.emptyRate}% empty runs · ${fmt.int(s.score.filtered)} filtered`) : h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'No runs in the last 7 days'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn sm', onclick: (e) => act(e.currentTarget, () => adminPost('/engine/run', { platforms: [s.platform] }), 'Sync queued') }, icon('refresh', 'sm'), 'Sync all'),
          s.platform === 'telegram' ? h('button', { class: 'btn sm', title: 'Re-read the channels your account has joined and follow new ones', onclick: (e) => act(e.currentTarget, async () => { const r = await adminPost('/telegram/sync'); toast(`${r.channels} joined channel(s) · ${r.created} new feed(s)${r.skippedFemale.length ? ` · ${r.skippedFemale.length} skipped (male-only)` : ''}${(r.skippedBody || []).length ? ` · ${r.skippedBody.length} skipped (body filter)` : ''}`); await load(); }) }, icon('refresh', 'sm'), 'Sync joined channels') : null,
          h('a', { class: 'btn sm ghost', href: href('/admin/feeds', { platform: s.platform }) }, 'View feeds', icon('chev-r', 'sm'))));
    }));
  }
  await load();
  const t = setInterval(() => load().catch(() => {}), 15000);
  return () => clearInterval(t);
}
