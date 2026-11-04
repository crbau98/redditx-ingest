import { h, icon, openModal, toast } from '../dom.js';
import { prefs, tastes } from '../store.js';

const ACCENTS = [
  ['prism', 'Prism', 'linear-gradient(135deg, #8b5cf6, #ff5c8a 55%, #ffb347)'],
  ['ocean', 'Ocean', 'linear-gradient(135deg, #6366f1, #38bdf8 55%, #22d3ee)'],
  ['ember', 'Ember', 'linear-gradient(135deg, #ef4444, #fb7139 55%, #fbbf24)'],
  ['forest', 'Forest', 'linear-gradient(135deg, #0ea5e9, #34d399 55%, #a3e635)'],
  ['violet', 'Violet', 'linear-gradient(135deg, #7c3aed, #a78bfa 55%, #f0abfc)'],
  ['mono', 'Mono', 'linear-gradient(135deg, #3f3f46, #a1a1aa 55%, #e4e4e7)'],
];

/** Personal display settings: theme, accent colour, grid density, previews, history. All device-local. */
export function openDisplaySettings() {
  const seg = (options, current, onPick) => {
    const el = h('div', { class: 'seg', role: 'group' });
    const paint = (v) => el.replaceChildren(...options.map(([val, label]) => h('button', { class: v === val ? 'on' : '', 'aria-pressed': String(v === val), onclick: () => { onPick(val); paint(val); } }, label)));
    paint(current);
    return el;
  };
  const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Accent colour' });
  const paintSwatches = () => swatches.replaceChildren(...ACCENTS.map(([key, label, bg]) => h('button', { class: `swatch${prefs.accent === key ? ' on' : ''}`, style: { background: bg }, title: label, 'aria-label': `${label} accent`, 'aria-pressed': String(prefs.accent === key), onclick: () => { prefs.accent = key; paintSwatches(); } })));
  paintSwatches();
  const check = (label, get, set, hint) => h('label', { class: 'row', style: { gap: '10px', fontSize: '14px', alignItems: 'flex-start' } },
    h('input', { type: 'checkbox', checked: get(), onchange: (e) => set(e.target.checked), style: { marginTop: '3px' } }),
    h('span', null, label, hint ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, hint) : null));

  const m = openModal({
    title: 'Display', sub: 'Saved on this device.',
    body: h('div', null,
      h('div', { class: 'display-row' }, h('label', null, 'Theme'), seg([['auto', 'Auto'], ['dark', 'Dark'], ['light', 'Light']], prefs.theme, (v) => { prefs.theme = v; })),
      h('div', { class: 'display-row' }, h('label', null, 'Accent'), swatches),
      h('div', { class: 'display-row' }, h('label', null, 'Grid'), seg([['s', 'Dense'], ['m', 'Cozy'], ['l', 'Large']], prefs.density, (v) => { prefs.density = v; })),
      h('div', { class: 'display-row' }, h('label', null, 'Behaviour'),
        check('Play video previews in the grid', () => prefs.previews, (v) => { prefs.previews = v; }, 'On hover (desktop) or when mostly on screen (phone).'),
        check('Start videos with sound off', () => prefs.muted, (v) => { prefs.muted = v; }),
        check('Hide things I’ve already seen', () => prefs.hideSeen, (v) => { prefs.hideSeen = v; }),
        check('Pause history and learning', () => prefs.historyOff, (v) => { prefs.historyOff = v; }, 'Stops recording what you open, and stops “For you” from learning.')),
      h('button', { class: 'btn sm ghost', onclick: () => { tastes.reset(); toast('“For you” has been reset'); } }, icon('refresh', 'sm'), 'Reset “For you”')),
    actions: [h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done')],
  });
  return m;
}
