import { h, icon, toast, fmt, confirmDialog } from '../../dom.js';
import { adminGet, adminPut, adminPost } from '../../api.js';
import { adminSession } from '../../store.js';
import { parse, navigate, href } from '../../router.js';
import { pageHead, toggle, act, searchBox, chips, loadingState } from './ui.js';
import { buildSettingsModel, isChanged, liveHint } from './settings-model.js';

const PHYSIQUE_KEYS = ['physiqueFilter', 'physiqueThreshold', 'physiqueCreatorShare'];
const showDefault = (def) => (def.type === 'bool' ? (def.default ? 'on' : 'off') : def.type === 'text' ? (def.default ? 'the built-in list' : 'empty') : String(def.default));

export async function render(root, { overview } = {}) {
  const q = parse().query;
  const f = { q: q.get('q') || '', changed: q.get('changed') === '1', section: q.get('section') || '' };
  const set = (patch) => navigate('/admin/settings', { ...f, ...patch, changed: (patch.changed ?? f.changed) ? '1' : '' }, { replace: true });
  root.append(pageHead('Settings', 'What PRISM does, in plain words. Changes apply as soon as you make them.'), loadingState('Loading settings'));
  const loading = root.lastElementChild;

  let s;
  try { s = await adminGet('/settings'); } catch (e) { loading.replaceWith(h('div', { class: 'a-alert bad', role: 'alert' }, icon('alert', 'sm'), h('div', null, `Couldn’t load settings: ${e.message}. `, h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('/admin/settings', {}, { replace: true }) }, 'Try again')))); return; }
  const values = { ...s.values };
  let physique = overview && overview.physique;
  const liveEls = []; // [key, element, getValue]

  async function save(def, value, stateEl, rowUpdate) {
    stateEl.className = 'a-set-state'; stateEl.textContent = 'Saving…';
    try {
      const r = await adminPut('/settings', { [def.key]: value });
      Object.assign(values, r.values);
      stateEl.className = 'a-set-state ok'; stateEl.textContent = 'Saved';
      setTimeout(() => { if (stateEl.textContent === 'Saved') stateEl.textContent = ''; }, 2500);
      rowUpdate();
      if (PHYSIQUE_KEYS.includes(def.key)) { // the whole library was re-checked: show what it did
        try { physique = (await adminGet('/overview')).physique || physique; } catch { /* keep the last numbers */ }
      }
      refreshLive();
      refreshChangedCount();
    } catch (e) {
      stateEl.className = 'a-set-state err'; stateEl.textContent = `Not saved: ${e.message}`;
      toast(e.message, 'err');
    }
  }
  const refreshLive = () => { for (const [key, el] of liveEls) el.textContent = liveHint(key, values[key], { physique }); };

  function control(def, row) {
    const state = h('span', { class: 'a-set-state', role: 'status', 'aria-live': 'polite' });
    const wrap = h('div', { class: 'a-set-ctl' });
    const commit = (v) => save(def, v, state, row.update);
    let get = () => values[def.key];
    let setUi = () => {};
    if (def.type === 'bool') {
      const label = h('span', { class: 'a-sub', style: { minWidth: '1.8em' } }, values[def.key] ? 'On' : 'Off');
      const sw = toggle(values[def.key], (on) => { label.textContent = on ? 'On' : 'Off'; commit(on); }, def.label.slice(0, 80));
      setUi = (v) => { const i = sw.querySelector('input'); i.checked = !!v; i.setAttribute('aria-checked', String(!!v)); label.textContent = v ? 'On' : 'Off'; };
      row.headExtra = h('div', { class: 'a-set-ctl' }, label, sw);
    } else if (def.type === 'enum') {
      const cur = () => values[def.key];
      if (def.values.length <= 3) {
        const grp = h('div', { class: 'a-seg', role: 'group', 'aria-label': row.title }, def.values.map((v) => h('button', { class: 'a-chip', type: 'button', 'aria-pressed': String(cur() === v), onclick: () => { commit(v); for (const b of grp.children) b.setAttribute('aria-pressed', String(b.textContent === v)); } }, v)));
        setUi = (v) => { for (const b of grp.children) b.setAttribute('aria-pressed', String(b.textContent === v)); };
        wrap.append(grp);
      } else {
        const sel = h('select', { class: 'select', 'aria-label': row.title, onchange: (e) => commit(e.target.value) }, def.values.map((v) => h('option', { value: v, selected: cur() === v }, v)));
        setUi = (v) => { sel.value = v; };
        wrap.append(sel);
      }
    } else if (def.type === 'text') {
      const ta = h('textarea', { class: 'textarea', rows: 4, spellcheck: 'false', 'aria-label': row.title });
      ta.value = values[def.key] || '';
      const saveBtn = h('button', { class: 'btn sm primary', type: 'button', disabled: true, onclick: () => commit(ta.value) }, 'Save');
      ta.addEventListener('input', () => { saveBtn.disabled = ta.value === (values[def.key] || ''); });
      ta.addEventListener('change', () => { /* saved with the button: a blur on a phone must not save half-typed text */ });
      setUi = (v) => { ta.value = v || ''; saveBtn.disabled = true; };
      wrap.append(ta, h('div', { class: 'a-set-ctl' }, saveBtn));
    } else { // int
      const range = def.max - def.min;
      const out = h('output', { class: 'a-num-out' }, String(values[def.key]));
      if (range <= 100) {
        const input = h('input', { class: 'a-range', type: 'range', min: def.min, max: def.max, step: 1, value: values[def.key], 'aria-label': row.title });
        input.addEventListener('input', () => { out.textContent = input.value; row.live(input.value); });
        input.addEventListener('change', () => commit(Number(input.value)));
        setUi = (v) => { input.value = v; out.textContent = String(v); };
        wrap.append(input, out);
      } else {
        const step = range > 5000 ? 100 : range > 500 ? 10 : 1;
        const input = h('input', { type: 'number', min: def.min, max: def.max, value: values[def.key], 'aria-label': row.title, inputmode: 'numeric' });
        let t = null;
        const apply = (n) => { const v = Math.min(def.max, Math.max(def.min, Number.isFinite(n) ? Math.round(n) : def.default)); input.value = v; clearTimeout(t); t = setTimeout(() => commit(v), 450); };
        input.addEventListener('change', () => apply(Number(input.value)));
        wrap.append(h('div', { class: 'a-step' },
          h('button', { type: 'button', 'aria-label': `Decrease ${row.title}`, onclick: () => apply(Number(input.value) - step) }, '−'), input,
          h('button', { type: 'button', 'aria-label': `Increase ${row.title}`, onclick: () => apply(Number(input.value) + step) }, '+')), h('span', { class: 'a-sub' }, `${fmt.int(def.min)} to ${fmt.int(def.max)}`));
        setUi = (v) => { input.value = v; };
      }
    }
    return { wrap, state, setUi, get };
  }

  function settingRow(it) {
    const { def } = it;
    const row = { title: it.title };
    const flag = h('span', { class: 'a-flag', hidden: !it.changed }, 'Changed');
    const reset = h('button', { class: 'a-reset', type: 'button', hidden: !it.changed }, `Reset to ${showDefault(def)}`);
    const live = h('p', { class: 'a-set-live', hidden: true });
    row.update = () => {
      const ch = isChanged(def, values[def.key]);
      flag.hidden = !ch; reset.hidden = !ch;
      reset.textContent = `Reset to ${showDefault(def)}`;
    };
    row.live = (v) => { live.textContent = liveHint(def.key, v, { physique }); live.hidden = !live.textContent; };
    const ctl = control(def, row);
    if (liveHint(def.key, values[def.key], { physique })) { liveEls.push([def.key, live]); live.textContent = liveHint(def.key, values[def.key], { physique }); live.hidden = false; }
    reset.addEventListener('click', async () => {
      if (def.type === 'text' && !(await confirmDialog(`Put “${it.title}” back to ${showDefault(def)}? What you typed is replaced.`, { title: 'Reset this setting?', confirmLabel: 'Reset' }))) return;
      ctl.setUi(def.default);
      await save(def, def.default, ctl.state, row.update);
      row.live(def.default);
    });
    const hint = it.hint ? h('p', { class: 'a-set-hint' }, it.hint) : (def.label.length > 140 ? h('p', { class: 'a-set-hint' }, def.label) : null);
    return h('div', { class: 'a-set', 'data-key': def.key },
      h('div', { class: 'a-set-head' }, h('div', { class: 'a-set-title', id: `set-${def.key}` }, it.title, flag), row.headExtra || null, hint),
      def.type === 'bool' ? null : ctl.wrap,
      live, h('div', { class: 'a-set-ctl' }, ctl.state, reset));
  }

  /* ---- the settings, by group ---- */
  const host = h('div', { class: 'stack' });
  const changedChip = h('span', { class: 'badge' });
  const count = h('span', { class: 'a-meta', role: 'status' });
  function refreshChangedCount() { const m = buildSettingsModel(s.schema, values); changedChip.textContent = String(m.changed); }
  function paintGroups() {
    liveEls.length = 0;
    const m = buildSettingsModel(s.schema, values, { query: f.q, changedOnly: f.changed });
    count.textContent = f.q || f.changed ? `${m.shown} of ${m.total} settings` : `${m.total} settings`;
    changedChip.textContent = String(m.changed);
    host.replaceChildren(
      ...m.groups.map((g) => h('details', { class: 'a-group', open: g.open || !!f.q || f.changed || null, id: `grp-${g.id}` },
        h('summary', null, h('div', { class: 'grow' }, h('span', { class: 'gt' }, g.title), h('span', { class: 'gn' }, g.note)), g.changed ? h('span', { class: 'a-flag' }, `${g.changed} changed`) : null, h('span', { class: 'badge' }, String(g.items.length))),
        g.items.map(settingRow))),
      m.groups.length ? null : h('div', { class: 'empty' }, h('div', { class: 'ico' }, icon('search')), h('h3', null, 'No setting matches'), h('p', null, f.q ? `Nothing mentions “${f.q}”. Try one word, like “threshold” or “backup”.` : 'You have not changed anything from the defaults.'),
        h('div', { class: 'row wrap', style: { justifyContent: 'center' } }, h('button', { class: 'btn', type: 'button', onclick: () => set({ q: '', changed: false }) }, 'Clear the search'))));
  }

  /* ---- the rest of the console's system controls ---- */
  const cred = (label, ok, env) => h('div', { class: 'a-cred' }, h('div', null, h('div', { style: { fontWeight: 600 } }, label), h('div', { class: 'env' }, env)), h('span', { class: `badge ${ok ? 'good' : ''}` }, ok ? 'configured' : 'not set'));
  const backups = await adminGet('/backups').catch(() => ({ items: [], enabled: false, keep: 0 }));
  const backupList = h('div');
  const paintBackups = (items) => backupList.replaceChildren(items.length ? h('div', { class: 'stack', style: { gap: '6px', padding: '0 16px 14px' } }, items.map((b) => h('div', { class: 'a-run' }, icon('layers', 'sm'), h('span', { class: 'grow', style: { fontFamily: 'ui-monospace, monospace', fontSize: '12.5px', overflowWrap: 'anywhere' } }, b.name), h('span', { class: 'muted' }, `${(b.size / 1048576).toFixed(1)} MB`), h('span', { class: 'muted' }, fmt.ago(b.createdAt))))) : h('p', { class: 'a-note', style: { padding: '0 16px 14px' } }, 'No backups yet.'));
  paintBackups(backups.items);
  const downloadConfig = async () => {
    const res = await fetch('/api/admin/export', { headers: { 'x-admin-key': adminSession.key } });
    if (!res.ok) { toast('Export failed', 'err'); return; }
    const a = h('a', { href: URL.createObjectURL(await res.blob()), download: `prism-config-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a); a.click(); a.remove();
  };
  const fileInput = h('input', { type: 'file', accept: 'application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0]; if (!file) return;
    try {
      const r = await adminPost('/import', JSON.parse(await file.text()));
      toast(`Imported: ${r.creators.created} new creators (${r.creators.matched} matched), ${r.feeds.created} new feeds, ${r.blocklist.added} blocklist entries${r.creators.rejected || r.feeds.skipped ? ` · ${r.creators.rejected + r.feeds.skipped} skipped` : ''}`, 'ok');
    } catch (e) { toast(e.message || 'Import failed', 'err'); }
    fileInput.value = '';
  });
  const action = (title, text, btn) => h('div', { class: 'a-set' }, h('div', { class: 'a-set-head' }, h('div', { class: 'a-set-title' }, title), h('p', { class: 'a-set-hint' }, text)), h('div', { class: 'a-set-ctl' }, btn));
  const maintStatus = h('p', { class: 'a-note', style: { padding: '12px 16px 0' } }, 'Loading sweep backlogs…');
  const group = (id, title, note, ...kids) => h('details', { class: 'a-group', id: `grp-${id}`, open: f.section === id || null }, h('summary', null, h('div', { class: 'grow' }, h('span', { class: 'gt' }, title), h('span', { class: 'gn' }, note))), kids);
  const system = h('div', { class: 'stack' },
    group('credentials', 'Keys and logins', 'Secrets live in the server environment, never in the database. Every source works without them; keys make it faster and less likely to be rate-limited.',
      cred('Reddit app (OAuth)', s.credentials.reddit, 'REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET (a “script/web app” at reddit.com/prefs/apps)'),
      cred('Bluesky (search)', s.credentials.bluesky, 'BSKY_IDENTIFIER + BSKY_APP_PASSWORD (an app password, not your login)'),
      cred('X API', s.credentials.x, 'X_BEARER_TOKEN (reliable timelines and search; reads count against the monthly budget)'),
      cred('Brave Search', s.credentials.brave, 'BRAVE_API_KEY (web search for finding creators and their other accounts)'),
      cred('Telegram bot', s.credentials.telegramValid, s.credentials.telegram && !s.credentials.telegramValid ? 'TELEGRAM_API_KEY is set but is not a Bot API token (expected 123456:ABC… from @BotFather)' : 'TELEGRAM_API_KEY (channel checks and full channel descriptions)'),
      cred('Mastodon token', s.credentials.mastodon, `MASTODON_ACCESS_TOKEN · instances: ${s.instances.mastodon.join(', ')}`)),
    group('security', 'Security', 'Who can open this console.',
      h('div', { class: 'a-cred' }, h('div', { style: { fontWeight: 600 } }, 'Admin key'), h('span', { class: `badge ${s.security.adminKeySet ? 'good' : 'warn'}` }, s.security.adminKeySet ? 'set' : 'NOT SET')),
      h('div', { class: 'a-cred' }, h('div', { style: { fontWeight: 600 } }, 'Age gate enforced by the server'), h('span', { class: `badge ${s.security.ageGateEnforced ? 'good' : 'warn'}` }, s.security.ageGateEnforced ? 'yes' : 'no')),
      action('This browser’s admin session', 'Forgets the admin key on this device.', h('button', { class: 'btn', type: 'button', onclick: () => { adminSession.key = ''; location.hash = '#/'; toast('Locked'); } }, 'Lock now'))),
    group('backups', 'Backups and moving house', backups.enabled ? `Nightly, keeping the newest ${backups.keep}.` : 'Nightly backups are off (turn them on under Backups and AI).',
      action('Database backup', 'Writes a copy of the database next to it.', h('button', { class: 'btn', type: 'button', onclick: (e) => act(e.currentTarget, async () => { await adminPost('/backups'); paintBackups((await adminGet('/backups')).items); }, 'Backup written') }, 'Back up now')),
      backupList,
      action('Export or import configuration', 'Creators, feeds and the blocklist as JSON: no media, no secrets.', h('div', { class: 'row wrap' }, h('button', { class: 'btn', type: 'button', onclick: downloadConfig }, icon('download', 'sm'), 'Export'), h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, icon('upload', 'sm'), 'Import'), fileInput))),
    group('maintenance', 'Maintenance', 'One-off jobs. Each runs now and reports what it changed.',
      maintStatus,
      action('Re-run the safety and quality sweep', 'Applies today’s rules to everything already stored. Runs by itself after upgrades.', h('button', { class: 'btn', type: 'button', onclick: (e) => act(e.currentTarget, async () => { const r = await adminPost('/maintenance/sweep', {}); toast(`Checked ${r.checked} · blocked ${r.blocked} · to review ${r.review} · hidden ${r.hidden}`, 'ok'); }) }, 'Run sweep')),
      action('Also check for dead Imgur links', 'Slower: makes a network request for every Imgur item.', h('button', { class: 'btn', type: 'button', onclick: (e) => act(e.currentTarget, async () => { const r = await adminPost('/maintenance/sweep', { probe: true }); toast(`Dead links hidden: ${r.dead}`, 'ok'); }) }, 'Sweep and probe')),
      action('Recompute “Trending”', 'Happens every 10 minutes on its own.', h('button', { class: 'btn', type: 'button', onclick: (e) => act(e.currentTarget, () => adminPost('/maintenance/recompute'), 'Recomputed') }, 'Recompute'))));
  adminGet('/maintenance/image-filter').then((m) => {
    if (!maintStatus.isConnected) return;
    maintStatus.textContent = [`Safety sweep: ${fmt.int(m.sweep.remaining)} left`, m.thumbnails && m.thumbnails.enabled === false ? 'Thumbnails: off' : `Thumbnails: ${fmt.int(m.thumbnails.remaining)} left`, `Near-duplicates: ${fmt.int(m.dedupe.remaining)} left`].join(' · ');
  }).catch(() => { maintStatus.textContent = ''; });

  const toolbar = h('div', { class: 'a-toolbar' },
    h('div', { class: 'a-toolbar-row' }, searchBox({ value: f.q, placeholder: 'Search: threshold, backup, older…', label: 'Search settings', onInput: (v) => { f.q = v; paintGroups(); rest.hidden = !!(f.q || f.changed); } })),
    h('div', { class: 'a-toolbar-row' }, chips([['', 'All'], ['1', 'Changed']], f.changed ? '1' : '', (v) => set({ changed: v === '1' }), 'Show'), changedChip, h('span', { class: 'grow' }), count));
  const discoveryNote = h('p', { class: 'a-note' }, 'Discovery (thresholds, budgets and search topics for finding new creators) is set on the ', h('a', { class: 'a-link', href: href('/admin/discovery') }, 'Discovery page'), '.');

  const rest = h('div', { class: 'stack', hidden: !!(f.q || f.changed) }, discoveryNote, h('h2', { style: { fontSize: '15px', margin: '8px 0 0' } }, 'System'), system);
  loading.replaceWith(toolbar, host, rest);
  paintGroups();
  if (f.section) setTimeout(() => { const el = document.getElementById(`grp-${f.section}`); if (el) { el.open = true; el.scrollIntoView({ block: 'start' }); } }, 50);
}
