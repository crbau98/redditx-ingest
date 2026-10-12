import { h, openModal, toast, icon } from '../dom.js';
import { post } from '../api.js';

const KINDS = [
  ['takedown', 'Remove my content (I appear in it / I made it)'],
  ['copyright', 'Copyright / DMCA'],
  ['underage', 'Person may be under 18'],
  ['nonconsensual', 'Shared without consent'],
  ['other', 'Something else'],
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function form({ withLink }) {
  const kind = h('select', { class: 'select' }, KINDS.map(([v, l]) => h('option', { value: v }, l)));
  const reason = h('textarea', { class: 'textarea', rows: 4, placeholder: 'Tell us what is wrong. For takedowns, explain how you are connected to the content.', style: { fontFamily: 'inherit', fontSize: '14px' }, maxlength: 2000 });
  const contact = h('input', { class: 'input', type: 'text', placeholder: 'Email (optional — only if you want a reply)', maxlength: 200, autocomplete: 'email' });
  const link = withLink ? h('input', { class: 'input', type: 'text', placeholder: 'Paste the link to the item or creator page' }) : null;
  const body = h('div', null,
    link ? h('div', { class: 'field' }, h('label', null, 'Link'), link) : null,
    h('div', { class: 'field' }, h('label', null, 'What is this about?'), kind),
    h('div', { class: 'field' }, h('label', null, 'Details'), reason),
    h('div', { class: 'field' }, h('label', null, 'Contact'), contact),
    h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Reports about minors or lack of consent hide the content immediately while we review. Removed content is blocklisted and will not be re-imported.'));
  return { body, kind, reason, contact, link };
}

async function submit(payload, modal) {
  try {
    await post('/api/report', payload);
    toast('Report received — thank you', 'ok');
    modal.close();
  } catch (e) { toast(e.message || 'Could not send report', 'err'); }
}

export function openReport({ mediaId, creatorId, title = 'Report this content' }) {
  const f = form({ withLink: false });
  const modal = openModal({
    title, sub: 'Help keep PRISM safe and respectful.', body: f.body,
    actions: [h('button', { class: 'btn', onclick: () => modal.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => submit({ mediaId, creatorId, kind: f.kind.value, reason: f.reason.value, contact: f.contact.value }, modal) }, icon('flag', 'sm'), 'Send report')],
  });
}

/** Footer entry point: accepts a pasted link instead of an id. */
export function openTakedownForm() {
  const f = form({ withLink: true });
  const modal = openModal({
    title: 'Report content / takedown request', sub: 'Open the item or creator page, copy its address from the browser, and paste it below.', body: f.body,
    actions: [h('button', { class: 'btn', onclick: () => modal.close() }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          const raw = f.link.value;
          const id = (raw.match(UUID) || [])[0];
          if (!id) { toast('That link does not contain an item or creator id', 'err'); return; }
          const isCreator = /creator\//.test(raw);
          submit({ mediaId: isCreator ? undefined : id, creatorId: isCreator ? id : undefined, kind: f.kind.value, reason: f.reason.value, contact: f.contact.value }, modal);
        },
      }, 'Send request')],
  });
}
