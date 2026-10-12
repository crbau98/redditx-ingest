import { h, icon, toast } from '../../dom.js';
import { adminGet, adminPost } from '../../api.js';
import { href } from '../../router.js';
import { pageHead, act } from './ui.js';

const ENV_HELP = {
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  bluesky: ['BSKY_IDENTIFIER', 'BSKY_APP_PASSWORD'],
  x: ['X_BEARER_TOKEN'],
  mastodon: ['MASTODON_ACCESS_TOKEN (optional)', 'MASTODON_INSTANCES'],
  lemmy: ['LEMMY_INSTANCES'],
};
const BLURB = {
  reddit: 'Communities and individual redditors. Falls back through OAuth → public JSON → old.reddit → RSS → archive, so it keeps working when Reddit blocks servers.',
  redgifs: 'Creator pages, niches and searches via the public RedGIFs API. Reddit posts linking to RedGIFs are resolved automatically.',
  bluesky: 'Creator timelines (media posts only) through the public AppView. Video plays via HLS. Search needs an app password.',
  mastodon: 'Creators and hashtags on any Mastodon-compatible server. Public API; some servers require sign-in for public timelines.',
  lemmy: 'Communities and users on Lemmy instances (API v3 with v4 fallback).',
  x: 'Creator timelines and searches. The official API (bearer token) is reliable; without it only a best-effort keyless route is available.',
  telegram: 'Public Telegram channels through the web preview (t.me/s/…). No login or key; channels that disable the preview report an error.',
  rss: 'Any RSS / Atom / JSON Feed — creators’ own sites, Tumblr blogs (/rss), Mastodon and Bluesky profile feeds. The most stable way to follow anything.',
  web: 'A single page’s photos and videos (OpenGraph, <video>, linked images). Respects robots.txt.',
  linkinbio: 'Linktree-style hubs. Not content: PRISM reads them to discover a creator’s other public accounts.',
};

export async function render(root) {
  const grid = h('div', { class: 'source-grid' });
  root.append(pageHead('Sources', 'The platforms PRISM can pull from, and how healthy each connection is.',
    h('button', { class: 'btn sm', onclick: (e) => act(e.currentTarget, async () => { await adminPost('/engine/breakers/reset'); await load(); }, 'Circuit breakers reset') }, icon('refresh', 'sm'), 'Reset circuit breakers')), grid,
  h('div', { class: 'panel' }, h('h3', null, icon('shield', 'sm'), 'What PRISM will not do'),
    h('p', { class: 'muted', style: { fontSize: '14px' } }, 'PRISM only reads content that is public without logging in. It does not scrape paywalled or subscription platforms (OnlyFans, Fansly, Patreon…) — those links are kept on a creator’s profile so fans can support them directly. Everything passes a safety gate (anything suggesting a person may be under 18 is dropped) and every item can be reported and permanently blocklisted.')));

  async function load() {
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
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn sm', onclick: (e) => act(e.currentTarget, () => adminPost('/engine/run', { platforms: [s.platform] }), 'Sync queued') }, icon('refresh', 'sm'), 'Sync all'),
          h('a', { class: 'btn sm ghost', href: href('/admin/feeds', { platform: s.platform }) }, 'View feeds', icon('chev-r', 'sm'))));
    }));
  }
  await load();
  const t = setInterval(() => load().catch(() => {}), 15000);
  return () => clearInterval(t);
}
