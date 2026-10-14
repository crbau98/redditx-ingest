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

export async function render(root) {
  const grid = h('div', { class: 'source-grid' });
  const health = h('div');
  root.append(pageHead('Sources', 'The platforms PRISM can pull from, and how healthy each connection is.',
    h('button', { class: 'btn sm', onclick: (e) => act(e.currentTarget, async () => { await adminPost('/engine/breakers/reset'); await load(); }, 'Circuit breakers reset') }, icon('refresh', 'sm'), 'Reset circuit breakers')), grid, health,
  h('div', { class: 'panel' }, h('h3', null, icon('shield', 'sm'), 'What PRISM will not do'),
    h('p', { class: 'muted', style: { fontSize: '14px' } }, 'PRISM only reads content that is public without logging in. It does not scrape paywalled or subscription platforms (OnlyFans, Fansly, Patreon…) — those links are kept on a creator’s profile so fans can support them directly. Everything passes a safety gate (anything suggesting a person may be under 18 is dropped) and every item can be reported and permanently blocklisted.')));

  async function load() {
    adminGet('/sources/health').then((r) => health.replaceChildren(healthPanel(r, load))).catch(() => {});
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
