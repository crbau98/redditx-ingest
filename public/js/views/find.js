import { h, icon, avatar, emptyState, proxied } from '../dom.js';
import { post } from '../api.js';
import { navigate, href } from '../router.js';
import { platformLabel, platformColor } from '../store.js';
import { attachSuggest } from '../components/suggest.js';
import { lookupCache } from '../lookup-cache.js';

const EXAMPLES = ['Reno Gold', 'Christian Hogue', 'Alejandro Pino', '@jakipz', 'Diego Sans', 'Malik Delgaty', 'Austin Wolf'];

const paidKind = (l) => {
  const s = `${l.service || ''} ${l.label || ''} ${l.url || ''}`.toLowerCase();
  if (s.includes('onlyfans')) return ['of', 'OnlyFans'];
  if (s.includes('fansly')) return ['fansly', 'Fansly'];
  if (s.includes('justfor.fans') || s.includes('justforfans') || /\bjff\b/.test(s)) return ['jff', 'JFF'];
  return ['', l.service || 'Paid'];
};

/** Public Find-a-creator: name, handle or any public link → accounts found → grouped as one person only on evidence → follow. */
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
    // A query that already resolved this session is answered locally: no rate-limit spend, no 30s wait.
    const cached = lookupCache.get(q);
    if (cached) {
      state = { loading: false, result: cached, error: null, rateLimited: false, following: false, followed: false };
      paint();
      return;
    }
    state = { loading: true, result: null, error: null, rateLimited: false, following: false, followed: false };
    paint();
    try {
      state.result = await post('/api/lookup', { query: q });
      lookupCache.set(q, state.result);
    } catch (e) {
      state.error = e.message;
      state.rateLimited = e.status === 429 || /rate|too many|slow down/i.test(e.message || '');
    }
    state.loading = false;
    paint();
  }

  /**
   * Follow accounts as ONE creator. The server only accepts several at once when this lookup found evidence tying them
   * together (a group); a name match alone is followed account by account. Paid pages are the server's to attach: only the
   * ones found on the chosen accounts themselves.
   */
  async function followSelected(cands, name) {
    if (state.following) return;
    state.following = true;
    paint();
    try {
      const selections = cands.map((c) => ({ platform: c.platform, kind: c.kind, target: c.target }));
      const r = await post('/api/lookup/follow', { name: String(name || input.value).trim(), selections, lookupId: state.result && state.result.lookupId });
      state.following = false;
      state.followed = true;
      paint();
      if (r.creator) setTimeout(() => navigate(`/creator/${r.creator.id}`), 650);
    } catch (e) { state.following = false; paint(); out.prepend(h('div', { class: 'notice warn', role: 'alert' }, e.message)); }
  }

  /** One evidence string → a chip (where the account turned up), ≤40 chars, links out when it carries a URL. */
  function evidenceChip(text, { link = null } = {}) {
    const label = String(text || '').replace(/\s+/g, ' ').trim();
    const short = label.length > 40 ? `${label.slice(0, 39)}…` : label;
    const inner = [icon('search', 'sm'), h('span', null, short)];
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

  /** "Found" is all a platform lookup proves: the account exists and has content. It says nothing about who it belongs to. */
  const foundBadge = () => h('span', { class: 'badge', title: 'This account exists on its platform and has content. That does not by itself mean it belongs to the same person as any other account in the results.' }, icon('check', 'sm'), 'Account found');

  function paidChips(c) {
    const links = c.externalLinks || [];
    if (!links.length) return null;
    return h('div', { class: 'row wrap', style: { gap: '6px', marginTop: '6px' } }, links.map((l) => {
      const [tone, tag] = paidKind(l);
      return h('a', { class: `linkchip ext${tone ? ` paid-pill ${tone}` : ''}`, href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' },
        tone ? h('span', { class: `badge ${tone}${l.free ? ' free' : ''}` }, l.free ? `${tag} · Free` : tag) : null, icon('external', 'sm'), String(l.label || l.url).slice(0, 40));
    }));
  }

  function sampleLink(c) {
    const sample = c.sample || (c.samples && c.samples[0]);
    if (!sample) return null;
    const thumb = sample.thumb || sample.preview;
    return h('a', { class: 'find-sample', href: sample.url || c.url || '#', target: '_blank', rel: 'noopener noreferrer nofollow' },
      thumb ? h('span', { class: 'find-sample-thumb', style: { backgroundImage: `url("${proxied(thumb)}")` } }) : null,
      h('span', { class: 'find-sample-txt' }, h('b', null, 'Latest post'), h('small', { class: 'muted' }, String(sample.title || sample.url || c.url || '').slice(0, 90))));
  }

  /** One account inside a linked group. */
  function memberRow(c) {
    return h('div', { class: 'find-member', 'data-account': `${c.platform}:${c.target}` },
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
        avatar({ avatar_url: c.avatarUrl, display_name: c.displayName || c.target }, 36),
        h('div', { style: { minWidth: 0, flex: '1' } },
          h('div', { class: 'find-cand-name' }, c.displayName || c.target, ' ', foundBadge()),
          h('div', { class: 'find-cand-sub' }, h('span', { class: 'muted sm truncate' }, `@${c.target}`, ' · ', platformLabel(c.platform)))),
        h('a', { class: 'btn sm ghost', href: c.url || '#', target: '_blank', rel: 'noopener noreferrer nofollow' }, icon('external', 'sm'), 'Open')),
      paidChips(c));
  }

  /** Accounts tied together by evidence: the only thing that may be followed as one creator. */
  function groupCard(g, byKey) {
    const members = g.members.map((k) => byKey.get(k)).filter(Boolean);
    if (members.length < 2) return null;
    const best = members[0];
    return h('div', { class: 'card find-group', 'data-group': g.id, style: { borderLeft: '3px solid var(--accent, #7c5cff)', padding: '14px 16px' } },
      h('div', { class: 'row wrap', style: { alignItems: 'center', gap: '10px' } },
        h('strong', null, `${members.length} linked accounts`),
        h('span', { class: 'muted sm' }, 'one person, tied together by what the accounts themselves publish'),
        h('span', { style: { flex: '1' } }),
        h('button', { class: 'btn primary', onclick: () => followSelected(members, best.displayName || best.target) }, icon('plus', 'sm'), `Follow these ${members.length} as one creator`)),
      h('div', { class: 'stack', style: { marginTop: '10px', gap: '10px' } }, members.map(memberRow)),
      h('ul', { class: 'muted sm find-why', style: { margin: '10px 0 0 18px' } }, g.evidence.map((e) => h('li', { 'data-evidence': e.type }, e.detail))));
  }

  /** A name or search match with nothing tying it to the other accounts. Followed on its own, never merged. */
  function possibleCard(c) {
    return h('div', { class: 'card find-cand', 'data-account': `${c.platform}:${c.target}` },
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
        avatar({ avatar_url: c.avatarUrl, display_name: c.displayName || c.target }, 40),
        h('div', { style: { minWidth: 0, flex: '1' } },
          h('div', { class: 'find-cand-name' }, c.displayName || c.target, ' ', foundBadge()),
          h('div', { class: 'find-cand-sub' }, h('span', { class: 'muted sm truncate' }, `@${c.target}`, ' · ', platformLabel(c.platform))))),
      c.bio ? h('p', { class: 'muted sm find-cand-bio' }, String(c.bio).slice(0, 160)) : null,
      evidenceChips(c),
      paidChips(c),
      sampleLink(c),
      h('div', { class: 'muted sm', style: { marginTop: '8px' } }, 'Name match only. Nothing shows this is the same person as the other accounts.'),
      c.status === 'following'
        ? h('div', { class: 'muted sm', style: { marginTop: '6px' } }, 'Already following')
        : h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: () => followSelected([c], c.displayName || c.target) }, icon('plus', 'sm'), 'Follow this account'));
  }

  function paint() {
    btn.disabled = state.loading || state.following;
    btn.setAttribute('aria-busy', String(state.loading || state.following));
    input.disabled = state.loading;
    out.replaceChildren();
    if (state.loading) {
      out.append(
        h('div', { class: 'find-loading', 'aria-label': 'Searching for accounts' },
          h('div', { class: 'spinner', 'aria-hidden': 'true' }),
          h('p', { class: 'muted' }, 'Checking every public platform and the web — usually about half a minute…')),
        h('div', { class: 'creator-grid', 'aria-hidden': 'true' }, [0, 1, 2].map(() => h('div', { class: 'card find-cand' }, h('div', { class: 'skeleton', style: { height: '86px' } }), h('div', { class: 'skeleton', style: { height: '14px', marginTop: '10px' } })))),
      );
    } else if (state.following) {
      out.append(h('div', { class: 'find-loading' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { class: 'muted' }, 'Following…')));
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
          title: `No accounts found for “${input.value.trim() || 'that'}”`,
          text: 'Try the @handle, or paste a direct profile link. Only accounts that exist and have content are shown — never a plausible-looking URL.',
          actions: [h('a', { class: 'btn', href: href('/creators') }, 'Browse creators instead')],
        }));
      } else {
        const byKey = new Map(cands.map((c) => [`${c.platform}:${c.kind}:${String(c.target).toLowerCase()}`, c]));
        const groups = (state.result.groups || []).map((g) => groupCard(g, byKey)).filter(Boolean);
        const possible = cands.filter((c) => !c.groupId);
        out.append(
          h('div', { class: 'row wrap find-result-head', style: { alignItems: 'center' } },
            h('strong', null, `${cands.length} account${cands.length === 1 ? '' : 's'} found`),
            h('span', { class: 'muted' }, 'found = it exists on its platform and has content. Accounts count as one person only when they link to each other.')),
          ...groups,
          possible.length ? h('h2', { class: 'find-possible-head', style: { fontSize: '16px', margin: '14px 0 0' } }, groups.length ? 'Other accounts: possible matches' : 'Possible matches') : null,
          possible.length ? h('div', { class: 'muted sm' }, 'Same name or search hit, but nothing shows they are the same man. Each one is followed on its own.') : null,
          possible.length ? h('div', { class: 'creator-grid find-rest' }, possible.map(possibleCard)) : null,
        );
      }
      // Paid pages are shown on the account they were found on. Only a page named in the search itself is listed here.
      const ext = state.result.queryLinks || [];
      if (ext.length) {
        out.append(h('section', { class: 'find-paid', 'aria-label': 'Paid pages' },
          h('div', { class: 'muted sm' }, 'Paid page named in your search (opens on the creator’s own site):'),
          h('div', { class: 'row wrap', style: { gap: '8px', marginTop: '8px' } }, ext.map((l) => {
            const [tone, tag] = paidKind(l);
            return h('a', { class: `linkchip ext${tone ? ` paid-pill ${tone}` : ''}`, href: l.url, target: '_blank', rel: 'noopener noreferrer nofollow' },
              tone ? h('span', { class: `badge ${tone}${l.free ? ' free' : ''}` }, l.free ? `${tag} · Free` : tag) : null,
              icon('external', 'sm'), String(l.label || l.url).slice(0, 60));
          }))));
      }
    } else {
      out.append(
        h('p', { class: 'muted find-lede' }, 'Look a creator up by name, handle or link. Accounts that exist are listed as found; they are grouped as one person only when they link to each other, never because they share a name. Paid pages are kept as link-outs.'),
        h('div', { class: 'find-examples' },
          h('span', { class: 'muted sm find-try' }, 'Try:'),
          h('div', { class: 'row wrap', style: { gap: '8px' } }, EXAMPLES.map((ex) => h('button', { class: 'chip', type: 'button', title: `Look up ${ex}`, onclick: () => { input.value = ex; run(); } }, ex)))),
      );
    }
  }

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Find a creator'), h('div', { class: 'sub' }, 'One box: a name, @handle or profile link. Local matches appear as you type; Enter looks the name up across the open web. An account is “found” when it exists and has content. Several accounts are followed together only when the lookup shows they link to each other; name matches are followed one at a time. Paid pages stay link-outs.'))),
    form,
    out,
  );
  if (initial) run();
  else paint();
  return () => {};
}
