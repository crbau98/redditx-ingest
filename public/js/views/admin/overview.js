import { h, icon, fmt, toast, confirmDialog } from '../../dom.js';
import { adminGet, adminPost, adminPatch, adminDelete, streamAdmin } from '../../api.js';
import { href } from '../../router.js';
import { platformColor, platformLabel } from '../../store.js';
import { kpi, pageHead, act, platBadge, undoToast } from './ui.js';
import { attentionItems, explainFeedError, worstFailing, throughput, trendText, physiqueLine, sourceYield } from './logic.js';
import { addFeedDialog } from './feeds.js';

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
    h('div', { class: 'chart stacked', role: 'img', 'aria-label': `Items ingested per day by source, last 14 days. Peak ${fmt.int(max)} a day.` }, days.map((d, i) => h('div', { class: 'col', style: { height: `${Math.max(2, (totals[i] / max) * 100)}%` }, title: `${new Date(`${d}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}: ${fmt.int(totals[i])} items${byDay.get(d).length ? ` — ${byDay.get(d).map((r) => `${platformLabel(r.platform)} ${r.n}`).join(', ')}` : ''}` },
      byDay.get(d).sort((a, b) => b.n - a.n).map((r) => h('div', { class: 'seg', style: { flexGrow: r.n, background: platformColor(r.platform) } }))))),
    h('div', { class: 'chart-axis' }, h('span', null, '14 days ago'), h('span', null, `peak ${fmt.int(max)}/day`), h('span', null, 'today')),
    plats.length ? h('div', { class: 'row wrap', style: { gap: '10px', marginTop: '10px', fontSize: '12px' } }, plats.map((p) => h('span', { class: 'row', style: { gap: '5px' } }, h('span', { class: 'dot', style: { background: platformColor(p) } }), platformLabel(p)))) : null);
}

export async function render(root, { overview: first }) {
  let o = first;
  let health = null; let retired = null;
  const holder = h('div', { class: 'a-ov-wrap', style: { display: 'grid', gap: '14px' } });
  root.appendChild(holder);
  let stream;

  async function refreshExtras() {
    const [hr, rr] = await Promise.allSettled([adminGet('/sources/health'), adminGet('/sources/retired')]);
    health = hr.status === 'fulfilled' ? hr.value : null;
    retired = rr.status === 'fulfilled' ? rr.value : null;
  }
  async function refresh() { try { o = await adminGet('/overview'); await refreshExtras(); paint(); } catch { /* keep the last render */ } }

  /* ---- one-tap fixes ---- */
  const retry = (f) => async (e) => {
    await act(e.currentTarget, async () => { await adminPatch(`/feeds/${f.id}`, { resetErrors: true }); await adminPost(`/feeds/${f.id}/run`, { force: true }); }, 'Retrying now');
    refresh();
  };
  const pause = (f) => async (e) => {
    const r = await act(e.currentTarget, () => adminPatch(`/feeds/${f.id}`, { enabled: false }));
    if (r === undefined) return;
    undoToast(`Paused ${f.label || f.target}`, async () => { await adminPatch(`/feeds/${f.id}`, { enabled: true }); refresh(); }); // undo changes only the switch: the failure history stays
    refresh();
  };
  const turnOn = (f) => async (e) => {
    const r = await act(e.currentTarget, () => adminPatch(`/feeds/${f.id}`, { enabled: true, resetErrors: true, runNow: true }));
    if (r === undefined) return;
    undoToast(`Turned on ${f.label || f.target}`, async () => { await adminPatch(`/feeds/${f.id}`, { enabled: false }); refresh(); });
    refresh();
  };

  function failingCard() {
    const { shown, more } = worstFailing(health.failing, 3);
    const total = health.totals.failing;
    return h('section', { class: 'a-card tone-bad', 'aria-labelledby': 'ov-failing' },
      h('div', { class: 'a-card-head' }, h('h2', { id: 'ov-failing' }, icon('alert', 'sm'), `Failing feeds · ${total}`), h('span', { class: 'grow' }),
        h('a', { class: 'a-link', href: href('/admin/feeds', { status: 'error' }) }, `See all ${Math.max(o.feeds.failing, total)}`)),
      shown.map((f) => {
        const ex = explainFeedError(f.lastError, f.failures);
        const fix = ex.fix === 'credentials'
          ? h('a', { class: 'btn primary sm', href: href('/admin/settings', { section: 'credentials' }) }, ex.fixLabel)
          : h('button', { class: `btn sm ${ex.fix === 'retry' ? 'primary' : ''}`, type: 'button', onclick: ex.fix === 'retry' ? retry(f) : pause(f) }, ex.fixLabel);
        return h('div', { class: 'a-feedrow' },
          h('div', { class: 'a-feedrow-top' }, platBadge(f.platform), h('span', { class: 'name' }, f.label || f.target), h('span', { class: 'badge bad' }, `${f.failures} failed in a row`)),
          h('p', { class: 'why' }, ex.plain, f.lastSuccessAt ? ` Last worked ${fmt.ago(f.lastSuccessAt)}.` : ' It has never worked.'),
          f.lastError ? h('p', { class: 'raw' }, String(f.lastError).slice(0, 160)) : null,
          h('div', { class: 'acts' }, fix, ex.fix === 'retry' ? h('button', { class: 'btn sm', type: 'button', onclick: pause(f) }, 'Pause') : h('button', { class: 'btn sm', type: 'button', onclick: retry(f) }, 'Retry')));
      }),
      more ? h('p', { class: 'a-note' }, `${more} more not shown, the worst ${shown.length} come first.`) : null);
  }

  function retiredCard() {
    const items = retired.items.slice(0, 3);
    return h('section', { class: 'a-card', 'aria-labelledby': 'ov-retired' },
      h('div', { class: 'a-card-head' }, h('h2', { id: 'ov-retired' }, icon('pause', 'sm'), `Paused by the app · ${retired.total}`), h('span', { class: 'grow' }),
        h('a', { class: 'a-link', href: href('/admin/feeds', { status: 'paused' }) }, 'All paused feeds')),
      h('p', { class: 'a-note' }, `These stopped working, so the app switched them off in the last ${retired.days} days. Nothing was deleted.`),
      items.map((f) => h('div', { class: 'a-feedrow' },
        h('div', { class: 'a-feedrow-top' }, platBadge(f.platform), h('span', { class: 'name' }, f.label || f.target), h('span', { class: 'a-sub' }, fmt.ago(f.retired_at))),
        h('p', { class: 'why' }, f.why),
        h('div', { class: 'acts' }, h('button', { class: 'btn sm primary', type: 'button', onclick: turnOn(f) }, 'Turn back on')))),
      retired.total > items.length ? h('p', { class: 'a-note' }, `${retired.total - items.length} more in Feeds → Paused.`) : null);
  }

  function attentionBlock() {
    const rows = attentionItems(o, { retired: retired ? retired.total : 0 });
    if (!rows.length) {
      return h('section', { class: 'a-card', 'aria-labelledby': 'ov-clear' }, h('div', { class: 'a-clear' }, h('span', { class: 'ico' }, icon('check')), h('div', null, h('h2', { id: 'ov-clear', style: { margin: 0, fontSize: '16px' } }, 'All clear'), h('p', { class: 'a-note' }, 'Nothing is waiting for you. Feeds are working and the queues are empty.'))));
    }
    return h('div', { class: 'stack', style: { gap: '10px' } }, h('h2', { class: 'sr-only' }, 'Needs attention'), rows.map((r) => {
      if (r.key === 'failing' && health && health.failing.length) return failingCard();
      if (r.key === 'retired' && retired && retired.items.length) return retiredCard();
      return h('a', { class: `a-attn ${r.tone}`, href: href(`/admin/${r.to}`, r.query || {}) },
        h('span', { class: 'n num' }, fmt.int(r.n)), h('span', { class: 'grow' }, h('b', null, r.title), h('small', null, r.sub)), icon('chev-r', 'sm'));
    }));
  }

  function quickAdd() {
    const input = h('input', { class: 'input', type: 'text', 'aria-label': 'Add a source: paste a link or handle', placeholder: 'Paste a link or @handle to add it', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const go = async (e) => {
      if (e) e.preventDefault();
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      const btn = form.querySelector('button');
      const r = await act(btn, () => adminPost('/feeds', { input: v }));
      if (!r) return;
      input.value = '';
      if (r.status === 'exists') { toast('Already following that'); return; }
      const f = r.feed;
      undoToast(`Added ${f ? (f.label || f.target) : 'it'}; syncing now`, async () => { if (f) await adminDelete(`/feeds/${f.id}`); refresh(); });
      refresh();
    };
    const form = h('form', { class: 'a-quick', onsubmit: go }, input, h('button', { class: 'btn primary', type: 'submit' }, icon('plus', 'sm'), 'Add'));
    return form;
  }

  function throughputCard() {
    const t = throughput(o.activity);
    const max = Math.max(1, ...t.slots.map((s) => s.added));
    return h('section', { class: 'a-card', 'aria-labelledby': 'ov-thr' },
      h('div', { class: 'a-card-head' }, h('h2', { id: 'ov-thr' }, icon('trend', 'sm'), 'Ingested today')),
      h('div', { class: 'a-big' }, h('span', { class: 'v num' }, `+${fmt.int(t.added24)}`), h('span', { class: 't' }, `items in 24h · ${trendText(t)}`)),
      h('div', { class: 'a-spark', role: 'img', 'aria-label': `New items per hour, last 48 hours. Peak ${t.peak ? `${t.peak.added} an hour` : 'none'}.` },
        t.slots.map((s, i) => h('i', { class: `${i < 24 ? 'old' : ''}${s.errors ? ' err' : ''}`.trim(), style: { height: `${Math.max(4, (s.added / max) * 100)}%` }, title: `${s.t.toLocaleString([], { weekday: 'short', hour: 'numeric' })}: +${s.added} items · ${s.runs} runs${s.errors ? ` · ${s.errors} errors` : ''}` }))),
      h('dl', { class: 'a-kv' },
        h('dt', null, 'Feed runs'), h('dd', null, `${fmt.int(t.runs24)}${t.errors24 ? ` (${t.errors24} failed)` : ''}`),
        h('dt', null, 'Duplicates skipped'), h('dd', null, fmt.int(o.last24h.dupes)),
        h('dt', null, 'Filtered out'), h('dd', null, fmt.int(o.last24h.skipped)),
        h('dt', null, 'Blocked by safety'), h('dd', null, fmt.int(o.last24h.blocked))));
  }

  function sourceCard() {
    const rows = sourceYield(o.ingestDaily || []);
    if (!rows.length) return null;
    return h('section', { class: 'a-card', 'aria-labelledby': 'ov-yield' },
      h('div', { class: 'a-card-head' }, h('h2', { id: 'ov-yield' }, icon('layers', 'sm'), 'By source')),
      h('dl', { class: 'a-kv' }, ...rows.flatMap((r) => [
        h('dt', r.quiet ? { class: 'quiet' } : {}, platformLabel(r.platform)),
        h('dd', null, r.quiet
          ? `0 today · ${fmt.int(r.yesterday)} the day before`
          : `${fmt.int(r.today)} today · ${fmt.int(r.yesterday)} the day before`),
      ])));
  }

  function engineCard() {
    const running = o.engine.running;
    const breakerOpen = Object.entries(o.engine.breakers || {}).filter(([, b]) => b.state !== 'closed');
    return h('section', { class: 'a-card', 'aria-labelledby': 'ov-eng' },
      h('div', { class: 'a-card-head' }, h('h2', { id: 'ov-eng' }, icon('bolt', 'sm'), 'Ingestion engine'), h('span', { class: 'grow' }),
        h('span', { class: `badge ${o.engine.paused ? 'warn' : o.engine.schedulerEnabled ? 'good' : ''}` }, o.engine.paused ? 'Paused' : o.engine.schedulerEnabled ? 'Scheduler on' : 'Scheduler off')),
      running.length
        ? h('div', { class: 'stack', style: { gap: '8px' } }, running.map((r) => h('div', { class: 'a-run' }, h('div', { class: 'spinner' }), platBadge(r.platform), h('span', { class: 'truncate grow' }, `${r.kind}: ${r.label || r.target}`), h('span', { class: 'muted num' }, `+${r.added || 0}`))))
        : h('p', { class: 'a-note' }, `Idle · ${o.engine.queued} queued · this session: ${o.engine.session.runs} runs, +${fmt.int(o.engine.session.added)} items`),
      breakerOpen.map(([p, b]) => h('div', { class: 'a-alert warn' }, icon('alert', 'sm'), h('span', null, `${platformLabel(p)} is resting (${b.state}): ${b.lastError || 'repeated failures'}`))),
      h('div', { class: 'a-engine-acts' },
        o.engine.paused ? h('button', { class: 'btn', type: 'button', onclick: async (e) => { await act(e.currentTarget, () => adminPost('/engine/resume'), 'Resumed'); refresh(); } }, icon('play', 'sm fill'), 'Resume')
          : h('button', { class: 'btn', type: 'button', onclick: async (e) => { await act(e.currentTarget, () => adminPost('/engine/pause'), 'Paused'); refresh(); } }, icon('pause', 'sm'), 'Pause'),
        h('button', { class: 'btn danger', type: 'button', disabled: !running.length, onclick: async (e) => {
          if (!(await confirmDialog('Stop the feeds that are running now? They are cut off mid-run and start again at their next turn.', { title: 'Stop running feeds?', confirmLabel: 'Stop them', danger: true }))) return;
          await act(e.currentTarget, () => adminPost('/engine/stop'), 'Stopping'); refresh();
        } }, icon('stop', 'sm'), 'Stop')));
  }

  function numbers() {
    const maxPub = Math.max(1, ...o.pubByPlatform.map((p) => p.count));
    return h('details', { class: 'a-fold' },
      h('summary', null, 'More numbers', h('span', { class: 'summary-note' }, 'library, filters, history')),
      h('div', { class: 'a-fold-body' },
        h('div', { class: 'kpis' },
          kpi({ value: fmt.num(o.media.published), label: 'Published', detail: `${fmt.int(o.last24h.added)} added in 24h`, href: href('/admin/media') }),
          kpi({ value: fmt.int(o.creators.active), label: 'Creators', detail: `${fmt.int(o.creators.total)} known · ${o.creators.blocked} blocked`, href: href('/admin/creators') }),
          kpi({ value: `${o.feeds.enabled}`, label: 'Feeds on', detail: `${o.feeds.total} total`, href: href('/admin/feeds') }),
          o.health ? kpi({ value: fmt.int(o.health.gone7d), label: 'Gone at source (7d)', detail: `${fmt.int(o.health.checked)} items checked`, href: href('/admin/media', { state: 'hidden' }) }) : null),
        o.physique ? h('p', { class: 'a-note' }, physiqueLine(o.physique), ' ', h('a', { class: 'a-link', href: href('/admin/settings', { q: 'body filter' }) }, 'Tune it')) : null,
        o.imageFilter ? h('p', { class: 'a-note' }, o.imageFilter.enabled ? (o.imageFilter.failed ? 'The picture filter is unavailable: its optional packages are missing (run npm install).' : `Picture filter: ${fmt.int(o.imageFilter.female)} pictures with women kept out of ${fmt.int(o.imageFilter.analyzed)} checked.`) : 'The picture filter is off.') : null,
        h('div', null, h('h3', { style: { fontSize: '14px', marginBottom: '8px' } }, 'Ingested per day, by source'), dailyChart(o.ingestDaily)),
        h('div', null, h('h3', { style: { fontSize: '14px', marginBottom: '8px' } }, 'Library by source'),
          o.pubByPlatform.length ? h('div', { class: 'hbars' }, o.pubByPlatform.map((p) => h('div', { class: 'hbar', style: { '--c': platformColor(p.platform) } }, h('span', null, platformLabel(p.platform)), h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(p.count / maxPub) * 100}%` } })), h('span', { class: 'n' }, fmt.num(p.count))))) : h('p', { class: 'a-note' }, 'No published items yet.'))));
  }

  function paint() {
    const active = document.activeElement;
    const typing = active && holder.contains(active) && active.tagName === 'INPUT' && active.value;
    if (typing) return; // never wipe a link the owner is pasting
    const hadHeadingFocus = !!(active && holder.contains(active) && active.tagName === 'H1'); // a repaint must not drop the focus the section just took
    const headerActions = [
      h('button', { class: 'btn', type: 'button', onclick: (e) => act(e.currentTarget, async () => { await adminPost('/engine/run', {}); await refresh(); }, 'Sync started') }, icon('refresh', 'sm'), 'Sync now'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => addFeedDialog(refresh, {}) }, icon('plus', 'sm'), 'Add source'),
    ];
    const tp = throughput(o.activity);
    const sub = `${o.engine.paused ? 'Paused' : o.engine.running.length ? `Syncing ${o.engine.running.length} feed${o.engine.running.length === 1 ? '' : 's'}` : 'Idle'} · +${fmt.int(tp.added24)} items in 24h · ${fmt.int(o.feeds.enabled)} of ${fmt.int(o.feeds.total)} feeds on`;
    if (!o.feeds.total) {
      holder.replaceChildren(pageHead('Overview', sub, ...headerActions), h('div', { class: 'a-card first-run' },
        h('h2', null, icon('compass', 'sm'), 'No sources yet'), h('p', { class: 'a-note' }, 'Add a source, and PRISM starts ingesting.'),
        h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', type: 'button', onclick: () => addFeedDialog(refresh, {}) }, 'Add a source'), h('a', { class: 'btn', href: href('/admin/feeds') }, 'Seeded feeds'))));
      return;
    }
    const onboarding = !o.media.total ? h('section', { class: 'a-card' },
      h('h2', null, icon('sparkle', 'sm'), 'Get your first content in'),
      h('ol', { class: 'steps', style: { margin: 0, padding: 0 } },
        h('li', null, h('div', null, h('b', null, 'Default feeds are ready. '), 'Press ', h('b', null, 'Sync now'), ' above.')),
        h('li', null, h('div', null, h('b', null, 'Add people, not just places. '), 'In ', h('a', { class: 'a-link', href: href('/admin/creators') }, 'Creators'), ' paste a profile link and PRISM follows all of the person’s accounts.')),
        h('li', null, h('div', null, h('b', null, 'Improve reliability. '), 'API keys make sources faster: see ', h('a', { class: 'a-link', href: href('/admin/settings', { section: 'credentials' }) }, 'Settings'), '.')))) : null;
    holder.replaceChildren(
      pageHead('Overview', sub, ...headerActions),
      quickAdd(),
      h('div', { class: 'a-ov' },
        h('div', { class: 'a-ov-main' }, attentionBlock(), onboarding),
        h('div', { class: 'a-ov-side' }, throughputCard(), sourceCard(), engineCard(), numbers())));
    if (hadHeadingFocus) { const h1 = holder.querySelector('h1'); if (h1) h1.focus({ preventScroll: true }); }
  }

  await refreshExtras();
  paint();
  const timer = setInterval(refresh, 15000);
  let lastPush = 0; // the engine streams state often: refresh at most every 3 seconds
  stream = streamAdmin((evt) => { if ((evt.type === 'run:finish' || evt.type === 'state') && Date.now() - lastPush > 3000) { lastPush = Date.now(); refresh(); } });
  return () => { clearInterval(timer); stream.close(); };
}
