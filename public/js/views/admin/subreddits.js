import { h, fmt, toast } from '../../dom.js';
import { adminGet, adminPatch } from '../../api.js';
import { table, pageHead, act, loadingState, errorState } from './ui.js';
import { feedToggle, applyRecommendations, TASTE_TONE } from './logic.js';

// Subreddits: every Reddit community feed scored by what it produced for this library (engine/subreddit-taste.js).
// The score only recommends. Nothing here pauses on its own: each pause or re-enable is one click (or "Apply all").
export async function render(root) {
  const recHost = h('div', { class: 'stack' });
  const host = h('div');
  root.append(pageHead('Subreddits', 'How much each subreddit gives you: items a day, items from creators you follow, empty or rate-limited runs, and its last useful item. Creators you follow count most. Suggestions are never applied for you.'), recHost, host);

  const toggle = (feedId, enabled) => { const { path, body } = feedToggle(feedId, enabled); return adminPatch(path, body); };

  function recPanel(title, recs, verb) {
    if (!recs.length) return null;
    const list = recs.map((r) => h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '12px' } },
      h('span', null, h('b', null, `r/${r.name}`), h('span', { class: 'muted' }, ` · ${r.why}`)),
      h('button', { class: 'btn sm', type: 'button', onclick: async (e) => { if (await act(e.currentTarget, () => toggle(r.feedId, r.enabled), `${verb}d r/${r.name}`) !== undefined) load(); } }, verb)));
    const all = h('button', { class: 'btn sm primary', type: 'button', onclick: async (e) => {
      e.currentTarget.disabled = true;
      const ok = await applyRecommendations(recs, adminPatch);
      toast(`${verb}d ${ok} of ${recs.length}`, ok === recs.length ? 'ok' : 'err');
      load();
    } }, `${verb} all ${recs.length}`);
    return h('div', { class: 'panel' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('b', null, title), all), h('div', { class: 'stack', style: { gap: '6px', marginTop: '8px' } }, list));
  }

  async function load() {
    host.replaceChildren(loadingState());
    let r;
    try { r = await adminGet('/subreddits'); } catch (e) { host.replaceChildren(errorState(e.message, load)); return; }
    const { pause, enable } = r.recommendations;
    recHost.replaceChildren(...[
      recPanel(`Suggested to pause (no followed creators in 30 days, under ${r.minRate} items a day)`, pause, 'Pause'),
      recPanel('Paused, but worth turning back on (they carried creators you follow)', enable, 'Enable'),
    ].filter(Boolean));
    if (!pause.length && !enable.length) recHost.replaceChildren(h('p', { class: 'muted' }, 'No suggestions right now.'));
    host.replaceChildren(table([
      { label: 'Subreddit', render: (s) => h('a', { href: `https://www.reddit.com/r/${encodeURIComponent(s.name)}/`, target: '_blank', rel: 'noopener noreferrer' }, `r/${s.name}`) },
      { label: 'Taste', render: (s) => h('span', null, h('span', { class: `badge ${TASTE_TONE[s.label] || ''}` }, s.label), ` ${s.score}`) },
      { label: 'Items/day (14d)', render: (s) => String(s.perDay) },
      { label: 'Followed creators (30d)', render: (s) => fmt.int(s.followed30) },
      { label: 'Empty or skipped runs', render: (s) => (s.runs ? `${Math.round(s.badShare * 100)}% of ${s.runs}` : 'no runs') },
      { label: 'Last useful item', render: (s) => (s.lastUsefulAt ? fmt.ago(s.lastUsefulAt) : 'never') },
      { label: '', srLabel: 'Actions', cell: 'actions', render: (s) => h('button', { class: `btn sm${s.enabled ? '' : ' good'}`, type: 'button',
        onclick: async (e) => { if (await act(e.currentTarget, () => toggle(s.feedId, !s.enabled), s.enabled ? `Paused r/${s.name}` : `Enabled r/${s.name}`) !== undefined) load(); } },
      s.enabled ? 'Pause' : 'Unpause') },
    ], r.rows, { empty: 'No subreddit feeds yet.', label: 'Subreddits' }));
  }
  load();
}
