import { h, icon, avatar, emptyState } from '../dom.js';
import { post } from '../api.js';
import { navigate, href } from '../router.js';
import { platformLabel, platformColor } from '../store.js';
import { attachSuggest } from '../components/suggest.js';

const EXAMPLES = ['Reno Gold', 'Christian Hogue', 'Alejandro Pino', '@jakipz', 'Diego Sans', 'Malik Delgaty', 'Austin Wolf'];

const paidKind = (l) => {
  const s = `${l.service || ''} ${l.label || ''} ${l.url || ''}`.toLowerCase();
  if (s.includes('onlyfans')) return ['of', 'OnlyFans'];
  if (s.includes('fansly')) return ['fansly', 'Fansly'];
  if (s.includes('justfor.fans') || s.includes('justforfans') || /\bjff\b/.test(s)) return ['jff', 'JFF'];
  return ['', l.service || 'Paid'];
};

/** Public Find-a-creator: name, handle or any public link → verified accounts → follow as one creator. */
export async function find(root, { query }) {
  document.title = 'Find a creator — PRISM';
  const initial = query.get('q') || '';
  let state = { loading: false, result: null, error: null, rateLimited: false, following: false, followed: false };

  const input = h('input', { class: 'input lg', type: 'search', name: 'q', placeholder: 'Name, @handle or profile link', value: initial, 'aria-label': 'Find a creator by name, handle or link', autocomplete: 'off', enterkeyhint: 'search' });
  const btn = h('button', { class: 'btn primary lg', type: 'submit' }, icon('search', 'sm'), h('span', null, 'Find'));
  const form = h('form', { class: 'find-form', role: 'search', 'aria-label': 'Find a creator', onsubmit: (e) => { e.preventDefault(); run(); } },
    input, btn);
  const out = h('div', { class: 'stack find-out', style: { marginTop: '18px' }, role: 'status', 'aria-live': 'polite' });

  // Instant local answers while typing (no network lookup), then the one row that triggers the
  // real, rate-limited web lookup. The lookup runs on submit or this row — never per keystroke.
  attachSuggest(input, {
    id: 'find-suggest',
    extraRows: (q, row) => [row([
      icon('external', 'sm'),
      h('span', { class: 'grow' }, `Look up “${q.length > 40 ? `${q.slice(0, 40)}…` : q}” across the open web`),
      h('kbd', { class: 'u-enter' }, '↵'),
    ], () => run())],
  });

  async function run() {
    const q = input.value.trim();
    if (!q || state.loading || state.following) return;
    // Put the query in the URL for sharing and Back — but WITHOUT dispatching hashchange: routeKey
    // includes ?q=, so a dispatched event remounts this view and `if (initial) run()` below would
    // fire a second /api/lookup for the same query (each one counts against the rate limit).
    history.replaceState(null, '', href('/find', { q }));
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
      const selections = cands.map((c) => ({ platform: c.platform, kind: c.kind, target: c.target }));
      // Paid pages the lookup surfaced ride along, so the new profile links out to them from the start.
      const externalLinks = (state.result && state.result.externalLinks) || [];
      const r = await post('/api/lookup/follow', { name: input.value.trim(), selections, externalLinks });
      state.following = false;
      state.followed = true;
      paint();
      if (r.creator) setTimeout(() => navigate(`/creator/${r.creator.id}`), 650);
    } catch (e) { state.following = false; paint(); out.prepend(h('div', { class: 'notice warn', role: 'alert' }, e.message)); }
  }

  /** One evidence string → a chip: verified check, ≤40 chars, links out when it carries a URL. */
  function evidenceChip(text, { link = null } = {}) {
    const label = String(text || '').replace(/\s+/g, ' ').trim();
    const short = label.length > 40 ? `${label.slice(0, 39)}…` : label;
    const inner = [icon('check', 'sm'), h('span', null, short)];
    return link
      ? h('a', { class: 'evidence-chip', href: link, target: '_blank', rel: 'noopener noreferrer nofollow', title: label }, ...inner)
      : h('span', { class: 'evidence-chip', title: label }, ...inner);
  }

  function evidenceChips(c, { max = 3 } = {}) {
    const ev = (c.evidence || []);
    const chips = ev.slice(0, max).map((e) => evidenceChip(e));
    if (ev.length > max) chips.push(h('span', { class: 'evidence-chip more', title: ev.slice(max).join(' · ') }, `+${ev.length - max}`));
    chips.unshift(h('span', { class: 'evidence-chip plat', style: { '--c': platformColor(c.platform) } }, platformLabel(c.platform)));
    return h('div', { class: 'evidence-row' }, chips);
  }

  /** The best match, promoted: bigger, named, verified — the answer to what the user typed. */
  function answerCard(c) {
    const sample = c.sample || (c.samples && c.samples[0]);
    return h('div', { class: 'find-answer' },
      h('div', { class: 'row', style: { gap: '14px', alignItems: 'center' } },
        avatar({ avatar_url: c.avatarUrl, display_name: c.displayName || c.target }, 56),
        h('div', { style: { minWidth: 0, flex: '1' } },
          h('div', { class: 'find-answer-name' }, c.displayName || c.target),
          h('div', { class: 'find-answer-sub muted sm truncate' }, `@${c.target}`),
          evidenceChips(c)),
        h('button', { class: 'btn primary', onclick: (e) => followSelected((state.result && state.result.candidates) || [c], e.currentTarget) }, icon('plus', 'sm'), 'Follow as one creator')),
      c.bio ? h('p', { class: 'muted sm find-cand-bio' }, String(c.bio).slice(0, 220)) : null,
      sample ? h('a', { class: 'find-sample', href: (sample && sample.url) || c.url || '#', target: '_blank', rel: 'noopener noreferrer nofollow' },
        sample.thumb || sample.preview ? h('span', { class: 'find-sample-thumb', style: { backgroundImage: `url("${sample.thumb || sample.preview}")` } }) : null,
        h('span', { class: 'find-sample-txt' }, h('b', null, 'Latest post'), h('small', { class: 'muted' }, String(sample.title || sample.url || '').slice(0, 90)))) : null);
  }

  function evidenceCard(c) {
    const sample = c.sample || (c.samples && c.samples[0]);
    const sampleUrl = (sample && sample.url) || c.url || '#';
    const thumb = sample && (sample.thumb || sample.preview);
    return h('div', { class: 'card find-cand' },
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
        avatar({ avatar_url: c.avatarUrl, display_name: c.displayName || c.target }, 40),
        h('div', { style: { minWidth: 0, flex: '1' } },
          h('div', { class: 'find-cand-name' }, c.displayName || c.target, ' ', h('span', { class: 'badge good' }, icon('check', 'sm'), 'Verified')),
          h('div', { class: 'find-cand-sub' }, h('span', { class: 'muted sm truncate' }, c.target)))),
      c.bio ? h('p', { class: 'muted sm find-cand-bio' }, String(c.bio).slice(0, 160)) : null,
      evidenceChips(c),
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
          h('p', { class: 'muted' }, 'Checking every public platform and the web — usually about half a minute…')),
        h('div', { class: 'creator-grid', 'aria-hidden': 'true' }, [0, 1, 2].map(() => h('div', { class: 'card find-cand' }, h('div', { class: 'skeleton', style: { height: '86px' } }), h('div', { class: 'skeleton', style: { height: '14px', marginTop: '10px' } })))),
      );
    } else if (state.following) {
      out.append(h('div', { class: 'find-loading' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { class: 'muted' }, 'Following him. Merging verified accounts…')));
    } else if (state.followed) {
      out.append(h('div', { class: 'notice ok', role: 'status' }, icon('check', 'sm'), ' Following. Opening profile…'));
    } else if (state.error) {
      out.append(h('div', { class: 'notice warn', role: 'alert' }, state.error),
        emptyState({
          icon: state.rateLimited ? 'clock' : 'alert',
          title: state.rateLimited ? 'Too many lookups' : 'Lookup failed',
          text: state.rateLimited
            ? 'Find is rate-limited so one person can’t sweep the whole web. Try again in a minute, with his @handle or a direct profile link.'
            : 'Check the spelling, or paste a profile link (Bluesky, YouTube, Reddit…). Paid pages are kept as link-outs — search his free, public accounts here.',
          actions: [h('button', { class: 'btn primary', onclick: run }, icon('refresh', 'sm'), 'Try again')],
        }));
    } else if (state.result) {
      const cands = state.result.candidates || [];
      if (!cands.length) {
        out.append(emptyState({
          icon: 'users',
          title: `No verified accounts for “${input.value.trim() || 'that'}”`,
          text: 'Try the @handle, or paste a direct profile link. Only accounts that exist and have content are shown — never a plausible-looking URL.',
          actions: [h('a', { class: 'btn', href: href('/creators') }, 'Browse creators instead')],
        }));
      } else {
        const [best, ...rest] = cands;
        out.append(
          h('div', { class: 'row wrap find-result-head', style: { alignItems: 'center' } },
            h('strong', null, `${cands.length} verified account${cands.length === 1 ? '' : 's'}`),
            h('span', { class: 'muted' }, 'checked against the real platform — never just a plausible URL'),
            h('span', { style: { flex: '1' } }),
            cands.length > 1 ? h('button', { class: 'btn primary', onclick: (e) => followSelected(cands, e.currentTarget) }, icon('plus', 'sm'), 'Follow all as one creator') : null),
          answerCard(best),
          rest.length ? h('div', { class: 'creator-grid find-rest' }, rest.map(evidenceCard)) : null,
        );
      }
      const ext = state.result.externalLinks || [];
      if (ext.length) {
        out.append(h('section', { class: 'find-paid', 'aria-label': 'Paid pages' },
          h('div', { class: 'muted sm' }, 'Paid pages open on the creator’s own site — what they cost is between him and his fans:'),
          h('div', { class: 'row wrap', style: { gap: '8px', marginTop: '8px' } }, ext.map((l) => {
            const [tone, tag] = paidKind(l);
            return h('a', { class: `linkchip ext${tone ? ` paid-pill ${tone}` : ''}`, href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' },
              tone ? h('span', { class: `badge ${tone}${l.free ? ' free' : ''}` }, l.free ? `${tag} · Free` : tag) : null,
              icon('external', 'sm'), String(l.label || l.url).slice(0, 60));
          }))));
      }
    } else {
      out.append(
        h('p', { class: 'muted find-lede' }, 'Pull any creator’s public work in from across the open web — one identity, every public account. Paid pages are kept as link-outs.'),
        h('div', { class: 'find-examples' },
          h('span', { class: 'muted sm find-try' }, 'Try:'),
          h('div', { class: 'row wrap', style: { gap: '8px' } }, EXAMPLES.map((ex) => h('button', { class: 'chip', type: 'button', title: `Look up ${ex}`, onclick: () => { input.value = ex; run(); } }, ex)))),
      );
    }
  }

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Find a creator'), h('div', { class: 'sub' }, 'One box: a name, @handle or profile link. Local matches appear as you type; Enter verifies him across the open web. Only verified accounts are followed — paid pages stay link-outs.'))),
    form,
    out,
  );
  if (initial) run();
  else paint();
  return () => {};
}
