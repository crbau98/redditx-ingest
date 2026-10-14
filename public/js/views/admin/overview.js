import { h, icon, fmt, toast } from '../../dom.js';
import { adminGet, adminPost, streamAdmin } from '../../api.js';
import { href } from '../../router.js';
import { platformColor, platformLabel } from '../../store.js';
import { kpi, pageHead, act, platBadge } from './ui.js';

function activityChart(buckets) {
  // 48 hourly slots ending now; missing hours are zero.
  const now = new Date(); now.setMinutes(0, 0, 0);
  const map = new Map(buckets.map((b) => [b.hour, b]));
  const slots = [];
  for (let i = 47; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600000);
    const key = d.toISOString().slice(0, 13);
    slots.push({ key, d, ...(map.get(key) || { added: 0, runs: 0, errors: 0 }) });
  }
  const max = Math.max(1, ...slots.map((s) => s.added));
  return h('div', null,
    h('div', { class: 'chart', role: 'img', 'aria-label': 'Items added per hour, last 48 hours' }, slots.map((s) => h('div', { class: `bar${s.errors ? ' err' : ''}`, style: { height: `${Math.max(2, (s.added / max) * 100)}%` }, title: `${s.d.toLocaleString([], { weekday: 'short', hour: 'numeric' })}: +${s.added} items · ${s.runs} runs${s.errors ? ` · ${s.errors} errors` : ''}` }))),
    h('div', { class: 'chart-axis' }, h('span', null, '48h ago'), h('span', null, `peak ${fmt.int(max)}/h`), h('span', null, 'now')));
}

/** Items ingested per day for the last 14 days, stacked by source. */
function dailyChart(rows = []) {
  const days = [];
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) days.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10));
  const byDay = new Map(days.map((d) => [d, []]));
  for (const r of rows) if (byDay.has(r.day)) byDay.get(r.day).push(r);
  const totals = days.map((d) => byDay.get(d).reduce((a, r) => a + r.n, 0));
  const max = Math.max(1, ...totals);
  const plats = [...new Set(rows.map((r) => r.platform))];
  return h('div', null,
    h('div', { class: 'chart stacked', role: 'img', 'aria-label': 'Items ingested per day by source, last 14 days' }, days.map((d, i) => h('div', { class: 'col', style: { height: `${Math.max(2, (totals[i] / max) * 100)}%` }, title: `${new Date(`${d}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: ${fmt.int(totals[i])} items${byDay.get(d).length ? ` — ${byDay.get(d).map((r) => `${platformLabel(r.platform)} ${r.n}`).join(', ')}` : ''}` },
      byDay.get(d).sort((a, b) => b.n - a.n).map((r) => h('div', { class: 'seg', style: { flexGrow: r.n, background: platformColor(r.platform) } }))))),
    h('div', { class: 'chart-axis' }, h('span', null, '14 days ago'), h('span', null, `peak ${fmt.int(max)}/day`), h('span', null, 'today')),
    plats.length ? h('div', { class: 'row wrap', style: { gap: '10px', marginTop: '10px', fontSize: '12px' } }, plats.map((p) => h('span', { class: 'row', style: { gap: '5px' } }, h('span', { class: 'dot', style: { background: platformColor(p), width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block' } }), platformLabel(p)))) : null);
}

export async function render(root, { overview: first }) {
  let o = first;
  const holder = h('div', { class: 'adm-main', style: { gap: '20px' } });
  root.appendChild(holder);
  let stream;

  async function paint() {
    const running = o.engine.running;
    const alerts = [];
    const breakerOpen = Object.entries(o.engine.breakers || {}).filter(([, b]) => b.state !== 'closed');

    const engineBox = h('div', { class: 'panel' },
      h('h3', null, icon('bolt', 'sm'), 'Ingestion engine', h('span', { class: 'grow' }),
        h('span', { class: 'badge ' + (o.engine.paused ? 'warn' : o.engine.schedulerEnabled ? 'good' : '') }, o.engine.paused ? 'Paused' : o.engine.schedulerEnabled ? 'Scheduler on' : 'Scheduler off')),
      h('div', { class: 'row wrap', style: { marginBottom: '12px' } },
        h('button', { class: 'btn primary', onclick: (e) => act(e.currentTarget, async () => { const r = await adminPost('/engine/run', {}); await refresh(); return r; }, 'Sync started') }, icon('refresh', 'sm'), 'Sync everything now'),
        o.engine.paused ? h('button', { class: 'btn', onclick: async () => { await adminPost('/engine/resume'); refresh(); } }, icon('play', 'sm fill'), 'Resume scheduler') : h('button', { class: 'btn', onclick: async () => { await adminPost('/engine/pause'); refresh(); } }, icon('pause', 'sm'), 'Pause scheduler'),
        h('button', { class: 'btn danger', onclick: async () => { await adminPost('/engine/stop'); toast('Stopping…'); refresh(); } }, icon('stop', 'sm'), 'Stop')),
      running.length
        ? h('div', { class: 'stack', style: { gap: '8px' } }, running.map((r) => h('div', { class: 'run-live' }, h('div', { class: 'spinner' }), platBadge(r.platform), h('span', { class: 'truncate grow' }, `${r.kind}: ${r.label || r.target}`), h('span', { class: 'muted num' }, `+${r.added || 0}`))))
        : h('p', { class: 'muted', style: { fontSize: '13.5px' } }, `Idle · ${o.engine.queued} queued · this session: ${o.engine.session.runs} runs, +${fmt.int(o.engine.session.added)} items`),
      breakerOpen.length ? h('div', { class: 'stack', style: { marginTop: '12px', gap: '6px' } }, breakerOpen.map(([p, b]) => h('div', { class: 'run-live', style: { background: 'color-mix(in srgb, var(--warn) 14%, transparent)' } }, icon('alert', 'sm'), h('span', { class: 'grow' }, `${platformLabel(p)} is resting (${b.state}) — ${b.lastError || 'repeated failures'}`)))) : null);

    const total = o.media.published;
    const onboarding = o.feeds.total && !o.media.total ? h('div', { class: 'panel' },
      h('h3', null, icon('sparkle', 'sm'), 'Get your first content in'),
      h('ol', { class: 'steps', style: { margin: 0, padding: 0 } },
        h('li', null, h('div', null, h('b', null, 'Default feeds are ready. '), 'PRISM seeded curated communities and searches. Press ', h('b', null, 'Sync everything now'), ' above.')),
        h('li', null, h('div', null, h('b', null, 'Add people, not just places. '), 'In ', h('a', { href: href('/admin/creators'), style: { color: 'var(--accent)' } }, 'Creators'), ' paste a creator’s profile links (any platform) and PRISM follows all of them.')),
        h('li', null, h('div', null, h('b', null, 'Improve reliability. '), 'Optional API keys (Reddit, Bluesky, X) make sources faster and unblockable — see ', h('a', { href: href('/admin/sources'), style: { color: 'var(--accent)' } }, 'Sources'), '.')))) : null;

    const maxPub = Math.max(1, ...o.pubByPlatform.map((p) => p.count));
    holder.replaceChildren(
      pageHead('Overview', 'Everything at a glance'),
      h('div', { class: 'kpis' },
        kpi({ value: fmt.num(total), label: 'Published', detail: `${fmt.int(o.last24h.added)} added in 24h`, href: href('/admin/media') }),
        kpi({ value: fmt.int(o.creators.active), label: 'Creators', detail: `${fmt.int(o.creators.total)} known · ${o.creators.blocked} blocked`, href: href('/admin/creators') }),
        kpi({ value: `${o.feeds.enabled}`, label: 'Feeds active', detail: `${o.feeds.total} total`, href: href('/admin/feeds') }),
        kpi({ value: fmt.int(o.queues.review), label: 'Awaiting review', detail: 'unclear scope or flagged', href: href('/admin/moderation'), tone: o.queues.review ? 'warn' : null }),
        kpi({ value: fmt.int(o.queues.reports), label: 'Open reports', detail: 'takedowns & safety', href: href('/admin/reports'), tone: o.queues.reports ? 'bad' : null }),
        kpi({ value: o.feeds.failing, label: 'Failing feeds', detail: `${o.last24h.blocked} blocked by safety in 24h`, href: href('/admin/feeds?status=error'), tone: o.feeds.failing ? 'warn' : null }),
        o.imageFilter ? kpi({ value: o.imageFilter.enabled ? (o.imageFilter.failed ? 'unavailable' : fmt.int(o.imageFilter.female)) : 'off', label: 'Women filtered by picture', detail: o.imageFilter.failed ? 'optional ML packages missing — run npm install' : `${fmt.int(o.imageFilter.analyzed)} images checked · library re-check: ${fmt.int(o.imageFilter.sweep.remaining)} left`, href: href('/admin/settings'), tone: o.imageFilter.enabled && o.imageFilter.failed ? 'warn' : null }) : null,
        o.physique ? kpi({ value: o.physique.enabled ? fmt.int(o.physique.hidden) : 'off', label: 'Hidden by body filter', detail: `${fmt.int(o.physique.measured)} bodies measured · threshold ${o.physique.threshold} · ${fmt.int(o.physique.creatorsHidden)} creators hidden · library re-check: ${fmt.int(o.physique.sweep.remaining)} left`, href: href('/admin/settings') }) : null,
        o.health ? kpi({ value: fmt.int(o.health.gone7d), label: 'Gone at source (7d)', detail: `${fmt.int(o.health.checked)} items checked · ${fmt.int(o.health.reports)} viewer reports`, href: href('/admin/media', { state: 'hidden' }) }) : null),
      onboarding,
      h('div', { class: 'grid-2' },
        h('div', { class: 'panel' }, h('h3', null, 'New items per hour'), activityChart(o.activity)),
        engineBox),
      h('div', { class: 'panel' }, h('h3', null, 'Ingested per day, by source'), dailyChart(o.ingestDaily)),
      h('div', { class: 'grid-2' },
        h('div', { class: 'panel' }, h('h3', null, 'Library by source'),
          o.pubByPlatform.length ? h('div', { class: 'hbars' }, o.pubByPlatform.map((p) => h('div', { class: 'hbar', style: { '--c': platformColor(p.platform) } }, h('span', null, platformLabel(p.platform)), h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(p.count / maxPub) * 100}%` } })), h('span', { class: 'n' }, fmt.num(p.count))))) : h('p', { class: 'muted' }, 'No published items yet.')),
        h('div', { class: 'panel' }, h('h3', null, 'Last 24 hours'),
          h('dl', { class: 'kv' },
            h('dt', null, 'Feed runs'), h('dd', { class: 'num' }, fmt.int(o.last24h.runs)),
            h('dt', null, 'Items added'), h('dd', { class: 'num' }, fmt.int(o.last24h.added)),
            h('dt', null, 'Duplicates skipped'), h('dd', { class: 'num' }, fmt.int(o.last24h.dupes)),
            h('dt', null, 'Filtered out'), h('dd', { class: 'num' }, fmt.int(o.last24h.skipped)),
            h('dt', null, 'Blocked by safety'), h('dd', { class: 'num' }, fmt.int(o.last24h.blocked)),
            h('dt', null, 'Blocklist entries'), h('dd', { class: 'num' }, fmt.int(o.blocklist))))));
  }

  async function refresh() { try { o = await adminGet('/overview'); await paint(); } catch { /* keep the last render */ } }
  await paint();
  const timer = setInterval(refresh, 12000);
  stream = streamAdmin((evt) => { if (evt.type === 'run:finish' || evt.type === 'state') refresh(); });
  return () => { clearInterval(timer); stream.close(); };
}
