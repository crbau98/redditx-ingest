import { h, icon, toast, openModal } from '../dom.js';
import { collections } from '../store.js';

/** "Add to collection" sheet: tick any number of collections, or make a new one on the spot. */
export function openCollectionPicker(item) {
  const list = h('div', { class: 'coll-pick' });
  const paint = () => {
    const all = collections.list();
    list.replaceChildren(all.length
      ? all.map((c) => {
        const on = c.items.includes(item.id);
        return h('button', { class: `coll-row${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: () => { const now = collections.toggle(c.id, item.id); toast(now ? `Added to ${c.name}` : `Removed from ${c.name}`); paint(); } },
          h('span', { class: 'coll-check' }, on ? icon('check', 'sm') : null),
          h('span', { class: 'grow truncate' }, c.name),
          h('span', { class: 'muted num' }, c.items.length));
      })
      : h('p', { class: 'muted', style: { fontSize: '13.5px', margin: '4px 0 8px' } }, 'No collections yet — name your first one below.'));
  };
  const name = h('input', { class: 'input', placeholder: 'New collection name…', maxlength: 60 });
  const create = () => {
    const v = name.value.trim();
    if (!v) { name.focus(); return; }
    const c = collections.create(v);
    collections.toggle(c.id, item.id);
    toast(`Added to ${c.name}`, 'ok');
    name.value = '';
    paint();
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  paint();
  const m = openModal({
    title: 'Add to collection', sub: 'Collections live on this device, like your saved items.',
    body: h('div', null, list, h('div', { class: 'row', style: { marginTop: '12px', gap: '8px' } }, name, h('button', { class: 'btn primary', onclick: create }, icon('plus', 'sm'), 'Create'))),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Done')],
  });
  return m;
}
