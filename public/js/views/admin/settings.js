import { h, icon, toast, confirmDialog, fmt } from '../../dom.js';
import { adminGet, adminPut, adminPost } from '../../api.js';
import { adminSession } from '../../store.js';
import { pageHead, toggle, act } from './ui.js';

export async function render(root) {
  const s = await adminGet('/settings');
  const values = { ...s.values };
  const rows = s.schema.map((d) => {
    let control;
    if (d.type === 'bool') control = toggle(values[d.key], (on) => save({ [d.key]: on }));
    else if (d.type === 'enum') control = h('select', { class: 'select sm', onchange: (e) => save({ [d.key]: e.target.value }) }, d.values.map((v) => h('option', { value: v, selected: values[d.key] === v }, v)));
    else { control = h('input', { class: 'input sm', type: 'number', min: d.min, max: d.max, value: values[d.key] }); control.addEventListener('change', () => save({ [d.key]: control.value })); }
    return h('div', { class: 'setting' }, h('div', { class: 'l' }, d.label), control);
  });
  async function save(patch) { try { const r = await adminPut('/settings', patch); Object.assign(values, r.values); toast('Saved', 'ok'); } catch (e) { toast(e.message, 'err'); } }

  const cred = (label, ok, env) => h('div', { class: 'setting' }, h('div', null, h('div', { class: 'l' }, label), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, env)), h('span', { class: `badge ${ok ? 'good' : ''}` }, ok ? 'configured' : 'not set'));

  const backups = (await adminGet('/backups'));
  const backupList = h('div');
  const paintBackups = (items) => backupList.replaceChildren(items.length ? h('div', { class: 'stack', style: { gap: '6px', marginTop: '10px' } }, items.map((b) => h('div', { class: 'run-live' }, icon('layers', 'sm'), h('span', { class: 'grow mono', style: { fontSize: '12.5px' } }, b.name), h('span', { class: 'muted' }, `${(b.size / 1048576).toFixed(1)} MB`), h('span', { class: 'muted' }, fmt.ago(b.createdAt))))) : h('p', { class: 'muted', style: { fontSize: '13px', marginTop: '8px' } }, 'No backups yet.'));
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
      toast(`Imported: ${r.creators.created} new creators (${r.creators.matched} matched), ${r.feeds.created} new feeds, ${r.blocklist.added} blocklist entries${r.creators.rejected || r.feeds.skipped ? ` — ${r.creators.rejected + r.feeds.skipped} skipped` : ''}`, 'ok');
    } catch (e) { toast(e.message || 'Import failed', 'err'); }
    fileInput.value = '';
  });

  root.append(pageHead('Settings', 'Runtime behaviour. Changes apply immediately.'),
    h('div', { class: 'panel' }, h('h3', null, 'Ingestion'), rows),
    h('div', { class: 'panel' }, h('h3', null, icon('lock', 'sm'), 'Credentials (environment variables)'),
      h('p', { class: 'muted', style: { fontSize: '13.5px', marginBottom: '6px' } }, 'Secrets live in the server environment, never in the database. Every source works in a best-effort public mode without them; keys make it faster and far less likely to be rate-limited.'),
      cred('Reddit app (OAuth)', s.credentials.reddit, 'REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET — create a “script/web app” at reddit.com/prefs/apps'),
      cred('Bluesky (search)', s.credentials.bluesky, 'BSKY_IDENTIFIER + BSKY_APP_PASSWORD — an app password, not your login'),
      cred('X API', s.credentials.x, 'X_BEARER_TOKEN'),
      cred('Mastodon token', s.credentials.mastodon, `MASTODON_ACCESS_TOKEN · instances: ${s.instances.mastodon.join(', ')}`)),
    h('div', { class: 'panel' }, h('h3', null, icon('shield', 'sm'), 'Security'),
      h('div', { class: 'setting' }, h('div', { class: 'l' }, 'Admin key'), h('span', { class: `badge ${s.security.adminKeySet ? 'good' : 'warn'}` }, s.security.adminKeySet ? 'set' : 'NOT SET')),
      h('div', { class: 'setting' }, h('div', { class: 'l' }, 'Age gate enforced by the server'), h('span', { class: `badge ${s.security.ageGateEnforced ? 'good' : 'warn'}` }, s.security.ageGateEnforced ? 'yes' : 'no')),
      h('div', { class: 'setting' }, h('div', { class: 'l' }, 'This browser’s admin session'), h('button', { class: 'btn sm', onclick: () => { adminSession.key = ''; location.hash = '#/'; toast('Locked'); } }, 'Lock now'))),
    h('div', { class: 'panel' }, h('h3', null, icon('layers', 'sm'), 'Backups & portability'),
      h('div', { class: 'setting' }, h('div', null, h('div', { class: 'l' }, 'Database backup'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, backups.enabled ? `Nightly, keeping the newest ${backups.keep}. Stored next to the database.` : 'Nightly backups are off (enable in Ingestion settings above).')),
        h('button', { class: 'btn sm', onclick: (e) => act(e.currentTarget, async () => { await adminPost('/backups'); paintBackups((await adminGet('/backups')).items); }, 'Backup written') }, 'Back up now')),
      backupList,
      h('div', { class: 'setting', style: { marginTop: '8px' } }, h('div', null, h('div', { class: 'l' }, 'Export configuration'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Creators, feeds and the blocklist as JSON — no media, no secrets.')),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: downloadConfig }, icon('download', 'sm'), 'Export'), h('button', { class: 'btn sm', onclick: () => fileInput.click() }, icon('upload', 'sm'), 'Import'), fileInput))),
    h('div', { class: 'panel' }, h('h3', null, 'Maintenance'),
      h('div', { class: 'setting' }, h('div', null, h('div', { class: 'l' }, 'Re-run the safety & quality sweep'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Applies today’s rules to everything already stored. Runs automatically after upgrades.')),
        h('button', { class: 'btn sm', onclick: (e) => act(e.currentTarget, async () => { const r = await adminPost('/maintenance/sweep', {}); toast(`Checked ${r.checked} · blocked ${r.blocked} · to review ${r.review} · hidden ${r.hidden}`, 'ok'); }) }, 'Run sweep')),
      h('div', { class: 'setting' }, h('div', null, h('div', { class: 'l' }, 'Also check for dead Imgur links'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Slower: makes a network request per Imgur item.')),
        h('button', { class: 'btn sm', onclick: (e) => act(e.currentTarget, async () => { const r = await adminPost('/maintenance/sweep', { probe: true }); toast(`Dead links hidden: ${r.dead}`, 'ok'); }) }, 'Sweep + probe')),
      h('div', { class: 'setting' }, h('div', null, h('div', { class: 'l' }, 'Recompute “Trending”'), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Happens every 10 minutes on its own.')),
        h('button', { class: 'btn sm', onclick: (e) => act(e.currentTarget, () => adminPost('/maintenance/recompute'), 'Recomputed') }, 'Recompute'))));
}
