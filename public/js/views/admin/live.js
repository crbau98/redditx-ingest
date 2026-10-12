import { h, icon, fmt } from '../../dom.js';
import { adminGet, adminPost, adminDelete, streamAdmin } from '../../api.js';
import { pageHead, table, platBadge, statusDot } from './ui.js';

export async function render(root) {
  const consoleEl = h('div', { class: 'console', role: 'log', 'aria-live': 'off' });
  const runsHost = h('div');
  let follow = true; let level = 'ALL'; let paused = false;
  const buffer = [];
  consoleEl.addEventListener('scroll', () => { follow = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 30; });

  const line = (e) => h('div', { class: `ln ${e.level}` }, h('span', { class: 'ts' }, new Date(e.ts).toLocaleTimeString()), h('span', { class: 'lv' }, e.level), e.msg);
  const draw = () => { consoleEl.replaceChildren(...buffer.filter((e) => level === 'ALL' || e.level === level || (level === 'PROBLEMS' && ['WARN', 'ERR'].includes(e.level))).slice(-400).map(line)); if (follow) consoleEl.scrollTop = consoleEl.scrollHeight; };

  const lvSel = h('select', { class: 'select sm', style: { width: 'auto' }, onchange: (e) => { level = e.target.value; draw(); } }, [['ALL', 'All'], ['PROBLEMS', 'Warnings & errors'], ['OK', 'Added'], ['INFO', 'Info']].map(([v, l]) => h('option', { value: v }, l)));
  const pauseBtn = h('button', { class: 'btn sm', onclick: () => { paused = !paused; pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause', 'sm'), paused ? 'Resume' : 'Pause'); } }, icon('pause', 'sm'), 'Pause');
  root.append(pageHead('Live log', 'A real-time view of what the ingestion engine is doing.',
    lvSel, pauseBtn, h('button', { class: 'btn sm', onclick: async () => { await adminDelete('/logs'); buffer.length = 0; draw(); } }, icon('trash', 'sm'), 'Clear')),
  consoleEl, h('div', { class: 'panel' }, h('h3', null, 'Recent runs'), runsHost));

  const logs = await adminGet('/logs', { limit: 400 });
  buffer.push(...logs); draw();

  async function loadRuns() {
    const runs = await adminGet('/runs', { limit: 25 });
    runsHost.replaceChildren(table([
      { label: '', width: '14px', render: (r) => statusDot(r.status) },
      { label: 'Feed', render: (r) => h('div', { class: 'row' }, platBadge(r.platform), h('span', { class: 'truncate', style: { maxWidth: '240px' } }, r.label || r.target)) },
      { label: 'When', render: (r) => fmt.ago(r.started_at) },
      { label: 'Fetched', class: 'num', render: (r) => r.fetched },
      { label: 'Added', class: 'num', render: (r) => (r.added ? h('b', { style: { color: 'var(--good)' } }, `+${r.added}`) : '0') },
      { label: 'Dupes', class: 'num', render: (r) => r.dupes },
      { label: 'Filtered', class: 'num', render: (r) => r.skipped },
      { label: 'Blocked', class: 'num', render: (r) => r.blocked || '' },
      { label: 'Via', render: (r) => h('span', { class: 'sub' }, r.via || '') },
      { label: 'Time', render: (r) => (r.duration_ms ? fmt.ms(r.duration_ms) : '…') },
      { label: 'Error', render: (r) => (r.error ? h('span', { class: 'sub', style: { color: 'var(--bad)' }, title: r.error }, r.error.slice(0, 60)) : '') },
    ], runs, { empty: 'No runs yet — press “Sync everything now” on the Overview.' }));
  }
  await loadRuns();

  const stream = streamAdmin((evt) => {
    if (evt.type === 'log' && !paused) { buffer.push(evt.data); if (buffer.length > 800) buffer.shift(); draw(); }
    if (evt.type === 'run:finish') loadRuns().catch(() => {});
  });
  return () => stream.close();
}
