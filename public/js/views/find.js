import { h, icon, avatar, emptyState } from '../dom.js';
import { post } from '../api.js';
import { navigate, href } from '../router.js';

const EXAMPLES = ['Christian Hogue', '@jakipz', 'https://bsky.app/profile/jakipz.bsky.social', 'https://www.youtube.com/@GymGuy', 'UC_x5XG1OV2P6uZZ5FSM9Ttw'];

/** Public Find-a-creator: name, handle or any public link → verified accounts → follow as one creator. */
export async function find(root, { query }) {
  document.title = 'Find a creator — PRISM';
  const initial = query.get('q') || '';
  let state = { loading: false, result: null, error: null, rateLimited: false, following: false, followed: false };

  const input = h('input', { class: 'input lg', type: 'search', name: 'q', placeholder: 'Name, @handle, or paste any public link…', value: initial, 'aria-label': 'Find a creator by name, handle or link', autocomplete: 'off', enterkeyhint: 'search' });
  const btn = h('button', { class: 'btn primary lg', type: 'submit' }, icon('search', 'sm'), h('span', null, 'Find'));
  const form = h('form', { class: 'find-form', role: 'search', 'aria-label': 'Find a creator', onsubmit: (e) => { e.preventDefault(); run(); } },
    input, btn);
  const out = h('div', { class: 'stack find-out', style: { marginTop: '18px' }, role: 'status', 'aria-live': 'polite' });

  async function run() {
    const q = input.value.trim();
    if (!q || state.loading || state.following) return;
    navigate('/find', q ? { q } : {}, { replace: true });
    state = { loading: true, result: null, error: null, rateLimited: false, following: false, followed: false };
    paint();
    try {
      state.result = await post('/api/lookup', { query: q });
    } catch (e) {
      state.error = e.message;
      state.rateLimited = e.status === 429 || /rate|too many|slow down/i.test(e.message || '');
    }
    state.loading = false;
    paint();
  }

  async function followSelected(cands, btnEl) {
    if (state.following) return;
    state.following = true;
    paint();
    try {
      const selections = cands.filter((c) => c.verified).map((c) => ({ platform: c.platform, kind: c.kind, target: c.target }));
      // Paid pages the lookup surfaced ride along, so the new profile links out to them from the start.
      const externalLinks = (state.result && state.result.externalLinks) || [];
      const r = await post('/api/lookup/follow', { name: input.value.trim(), selections, externalLinks });
      state.following = false;
      state.followed = true;
      paint();
      if (r.creator) setTimeout(() => navigate(`/creator/${r.creator.id}`), 650);
    } catch (e) { state.following = false; paint(); out.prepend(h('div', { class: 'notice warn', role: 'alert' }, e.message)); }
  }

  function evidenceCard(c) {
    const ev = (c.evidence || []).slice(0, 3);
    const sample = c.sample || (c.samples && c.samples[0]);
    const thumb = sample && (sample.thumb || sample.preview);
    const sampleUrl = (sample && sample.url) || c.url || '#';
    return h('div', { class: 'card find-cand' },
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
        avatar({ avatar_url: c.avatarUrl, display_name: c.displayName || c.target }, 40),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'find-cand-name' }, c.displayName || c.target, ' ', h('span', { class: 'badge good' }, icon('check', 'sm'), 'Verified')),
          h('div', { class: 'muted sm truncate' }, `${c.platform} · ${c.target}`))),
      c.bio ? h('p', { class: 'muted sm find-cand-bio' }, String(c.bio).slice(0, 160)) : null,
      ev.length ? h('ul', { class: 'find-ev' }, ev.map((e) => h('li', null, icon('check', 'sm'), h('span', null, e)))) : null,
      sample ? h('a', { class: 'find-sample', href: sampleUrl, target: '_blank', rel: 'noopener noreferrer nofollow' },
        thumb ? h('span', { class: 'find-sample-thumb', style: { backgroundImage: `url("${thumb}")` } }) : null,
        h('span', { class: 'find-sample-txt' }, h('b', null, 'Latest post'), h('small', { class: 'muted' }, String(sample.title || sample.url || c.url || '').slice(0, 90)))) : null);
  }

  function paint() {
    btn.disabled = state.loading || state.following;
    btn.setAttribute('aria-busy', String(state.loading || state.following));
    input.disabled = state.loading;
    out.replaceChildren();
    if (state.loading) {
      out.append(
        h('div', { class: 'find-loading', 'aria-label': 'Searching verified accounts' },
          h('div', { class: 'spinner', 'aria-hidden': 'true' }),
          h('p', { class: 'muted' }, 'Checking the real platforms — this usually takes a few seconds…')),
        h('div', { class: 'creator-grid', 'aria-hidden': 'true' }, [0, 1, 2].map(() => h('div', { class: 'card find-cand' }, h('div', { class: 'skeleton', style: { height: '86px' } }), h('div', { class: 'skeleton', style: { height: '14px', marginTop: '10px' } })))),
      );
    } else if (state.following) {
      out.append(h('div', { class: 'find-loading' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { class: 'muted' }, 'Pulling him in — merging his verified accounts into one creator…')));
    } else if (state.followed) {
      out.append(h('div', { class: 'notice ok', role: 'status' }, icon('check', 'sm'), ' He’s in — opening his profile…'));
    } else if (state.error) {
      out.append(h('div', { class: 'notice warn', role: 'alert' }, state.error),
        emptyState({
          icon: state.rateLimited ? 'clock' : 'alert',
          title: state.rateLimited ? 'Easy does it — too many lookups' : 'That lookup didn’t go through',
          text: state.rateLimited
            ? 'Find is rate-limited so one person can’t sweep the whole web. Wait a minute, then try again with his @handle or a direct profile link.'
            : 'Check the spelling, or paste a direct profile link (Bluesky, YouTube, Reddit…). Paid pages stay link-outs — search his free, public accounts here.',
          actions: [h('button', { class: 'btn primary', onclick: run }, icon('refresh', 'sm'), 'Try again')],
        }));
    } else if (state.result) {
      const cands = state.result.candidates || [];
      if (!cands.length) {
        out.append(emptyState({
          icon: 'users',
          title: 'No verified public accounts found',
          text: 'Nothing on the open platforms matched that closely enough to verify. Try his @handle on a different platform, or paste a direct profile link.',
          actions: [h('a', { class: 'btn', href: href('/creators') }, 'Browse creators instead')],
        }));
      } else {
        out.append(
          h('div', { class: 'row wrap find-result-head', style: { alignItems: 'center' } },
            h('strong', null, `${cands.length} verified account${cands.length === 1 ? '' : 's'}`),
            h('span', { class: 'muted' }, 'checked against the real platform — never just a plausible URL'),
            h('span', { style: { flex: '1' } }),
            h('button', { class: 'btn primary', onclick: (e) => followSelected(cands, e.currentTarget) }, icon('plus', 'sm'), 'Follow all as one creator')),
          h('div', { class: 'creator-grid' }, cands.map(evidenceCard)),
        );
      }
      const ext = state.result.externalLinks || [];
      if (ext.length) {
        out.append(h('section', { class: 'find-paid', 'aria-label': 'Paid pages' },
          h('div', { class: 'muted sm' }, 'Paid pages open on the creator’s own site — PRISM never fetches inside them:'),
          h('div', { class: 'row wrap', style: { gap: '8px', marginTop: '8px' } }, ext.map((l) =>
            h('a', { class: 'linkchip ext', href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, icon('external', 'sm'), String(l.label || l.url).slice(0, 60))))));
      }
    } else {
      out.append(
        h('p', { class: 'muted find-lede' }, 'Pull any creator’s public work in from across the open web — one identity, every free account. Paid pages stay link-outs.'),
        h('div', { class: 'find-examples' },
          h('span', { class: 'muted sm find-try' }, 'Try:'),
          h('div', { class: 'row wrap', style: { gap: '8px' } }, EXAMPLES.map((ex) => h('button', { class: 'chip', type: 'button', title: `Look up ${ex}`, onclick: () => { input.value = ex; run(); } }, ex)))),
      );
    }
  }

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Find a creator'), h('div', { class: 'sub' }, 'Name, performer name, @handle or profile link. Only verified public accounts are followed — paywalled pages stay link-outs.'))),
    form,
    out,
  );
  if (initial) run();
  else paint();
  return () => {};
}
