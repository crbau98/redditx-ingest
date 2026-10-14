import { h, icon, avatar, emptyState } from '../dom.js';
import { post } from '../api.js';
import { navigate, href } from '../router.js';
import { creatorCard } from '../components/creator-card.js';

const EXAMPLES = ['Christian Hogue', '@jakipz', 'https://bsky.app/profile/jakipz.bsky.social', 'https://www.youtube.com/@GymGuy', 'UC_x5XG1OV2P6uZZ5FSM9Ttw'];

/** Public Find-a-creator: name, handle or any public link → verified accounts → follow as one creator. */
export async function find(root, { query }) {
  document.title = 'Find a creator — PRISM';
  const initial = query.get('q') || '';
  let state = { loading: false, result: null, error: null };

  const input = h('input', { class: 'input lg', type: 'search', placeholder: 'Name, @handle, or paste any public link…', value: initial, 'aria-label': 'Find a creator' });
  const btn = h('button', { class: 'btn primary lg', onclick: run }, icon('search', 'sm'), 'Find');
  const out = h('div', { class: 'stack', style: { marginTop: '18px' } });

  async function run() {
    const q = input.value.trim();
    if (!q) return;
    navigate('/find', q ? { q } : {}, { replace: true });
    state = { loading: true, result: null, error: null };
    paint();
    try {
      state.result = await post('/api/lookup', { query: q });
    } catch (e) { state.error = e.message; }
    state.loading = false;
    paint();
  }

  async function followSelected(cands, btnEl) {
    btnEl.disabled = true;
    try {
      const selections = cands.filter((c) => c.verified).map((c) => ({ platform: c.platform, kind: c.kind, target: c.target }));
      const r = await post('/api/lookup/follow', { name: input.value.trim(), selections });
      if (r.creator) navigate(`/creator/${r.creator.id}`);
    } catch (e) { btnEl.disabled = false; out.prepend(h('div', { class: 'notice warn' }, e.message)); }
  }

  function paint() {
    out.replaceChildren();
    if (state.loading) out.append(h('div', { class: 'spinner', 'aria-label': 'Searching' }));
    else if (state.error) out.append(h('div', { class: 'notice warn' }, state.error));
    else if (state.result) {
      const cands = (state.result.candidates || []).filter((c) => c.verified);
      if (!cands.length) {
        out.append(emptyState({ icon: 'users', title: 'No verified public accounts found', text: 'Try his @handle on different platforms, or paste a direct profile link.' }));
      } else {
        out.append(
          h('div', { class: 'row wrap', style: { alignItems: 'center' } },
            h('strong', null, `${cands.length} verified account${cands.length === 1 ? '' : 's'}`),
            h('span', { class: 'muted' }, 'verified through the real platform — never just a plausible URL'),
            h('span', { style: { flex: '1' } }),
            h('button', { class: 'btn primary', onclick: (e) => followSelected(cands, e.currentTarget) }, icon('plus', 'sm'), 'Follow all as one creator')),
          ),
          h('div', { class: 'creator-grid' }, cands.map((c) => {
            const card = h('div', { class: 'card find-cand' },
              h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
                avatar(c.avatarUrl, c.displayName || c.target, 'md'),
                h('div', null, h('div', { style: { fontWeight: 700 } }, c.displayName || c.target), h('div', { class: 'muted sm' }, `${c.platform} · ${c.target}`))),
              c.bio ? h('p', { class: 'muted sm' }, String(c.bio).slice(0, 160)) : null,
              h('div', { class: 'muted sm' }, (c.evidence || []).slice(0, 2).join(' · ')));
            return card;
          })),
        );
      }
      const ext = state.result.externalLinks || [];
      if (ext.length) {
        out.append(h('div', { class: 'muted sm' }, 'Paid pages (link-outs, never fetched): ', ext.map((l) => l.url).join(' · ')));
      }
    } else {
      out.append(
        h('div', { class: 'muted' }, 'Pull any gay male creator’s public work in from across the open web — one identity, every free account.'),
        h('div', { class: 'row wrap' }, EXAMPLES.map((ex) => h('button', { class: 'chip', onclick: () => { input.value = ex; run(); } }, ex))),
      );
    }
  }

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Find a creator'), h('div', { class: 'sub' }, 'Name, performer name, @handle or profile link. Paywalled pages stay link-outs.'))),
    h('div', { class: 'row', style: { gap: '8px', maxWidth: '640px' } }, input, btn),
    out,
  );
  if (initial) run();
  else paint();
  return () => {};
}
