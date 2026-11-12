/**
 * The model behind the deep-pull progress UI: no DOM and no imports, so it can be tested under node.
 *
 *   normalizeJob    the status answer (new `job` shape, or the older flat shape) as one job
 *   stageStates     the four stages, each done / active / failed / todo
 *   counterPills    the live counts shown as pills ("—" until the server reports the number)
 *   grew            did a poll tick bring new accounts, videos or posts (drives the live grid refresh)
 *   provenanceOf    why a search result matched, as pills, from the server's evidence
 *   statusLine      one short sentence for screen readers and the inline line
 */

export const STAGES = [
  { id: 'profiles', label: 'Profiles & Aliases', phases: ['starting', 'profiles'] },
  { id: 'videos', label: 'Video Indexes', phases: ['videos'] },
  { id: 'images', label: 'Visual & Face Match', phases: ['images'] },
  { id: 'pulling', label: 'Pulling New Posts', phases: ['pulling'] },
];

// Older phase names (the server's first version used three) map onto the stages they stand for.
const LEGACY_PHASE = { text: 'profiles', video: 'videos', image: 'images' };

const COUNT_KEYS = ['feeds', 'candidates', 'leads', 'videos', 'avatars', 'enqueuedFeeds', 'postsAdded'];

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

function normCounts(f) {
  const out = {};
  for (const k of COUNT_KEYS) out[k] = num(f ? f[k] : undefined);
  return out;
}

/** Index of the stage a phase belongs to, or -1 when the phase is not one this UI knows. */
function stageIndexOf(phase) {
  const p = LEGACY_PHASE[phase] || phase;
  return STAGES.findIndex((s) => s.phases.includes(p));
}

/**
 * One job from either shape: the new `job` object, or a job as the server sends it today (the same fields with older
 * names: `postsAdded` at the top, `results` for candidates, `text`/`video`/`image` phases, and `done` as a flag).
 */
function fromJob(j) {
  const running = !!j.running || j.status === 'running';
  const error = j.error || null;
  const done = !!j.done || j.status === 'done' || j.phase === 'done';
  let status;
  if (running) status = 'running';
  else if (j.status === 'failed' || error) status = 'failed';
  else if (done) status = 'done';
  else status = 'idle';
  const f = j.found || {};
  const postsAdded = f.postsAdded !== undefined ? f.postsAdded : j.postsAdded;
  const start = Date.parse(j.startedAt || '');
  const end = running ? Date.now() : (Date.parse(j.lastAt || '') || Date.now());
  return {
    status,
    running,
    phase: LEGACY_PHASE[j.phase] || j.phase || (running ? 'starting' : 'done'),
    found: normCounts({ ...f, postsAdded, candidates: f.candidates !== undefined ? f.candidates : f.results }),
    queriesRun: num(j.queriesRun),
    queriesTotal: num(j.queriesTotal),
    elapsedMs: num(j.elapsedMs) !== undefined ? num(j.elapsedMs) : (Number.isFinite(start) ? Math.max(0, end - start) : undefined),
    error,
  };
}

/** One job from a status or start answer, or null when there is no job (nothing running and nothing finished). */
export function normalizeJob(resp) {
  if (!resp || typeof resp !== 'object') return null;
  const j = resp.job && typeof resp.job === 'object' ? resp.job : resp;
  const job = fromJob(j);
  return job.status === 'idle' ? null : job;
}

/** What a refused start says, in words the visitor can act on. */
export function refusalText(r) {
  if (!r) return 'Could not start a search.';
  if (r.reason === 'cooldown') {
    const at = new Date(r.until);
    return Number.isNaN(at.getTime())
      ? 'Searched recently. Try again in a few minutes.'
      : `Searched recently. Try again after ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  }
  if (r.reason === 'off in Settings') return 'Deep search is switched off right now.';
  return String(r.message || r.error || r.reason || 'Could not start a search.');
}

/** Each stage with its state. A finished job has every stage done; a failed one stops on the stage it was in. */
export function stageStates(job) {
  if (!job) return STAGES.map((s) => ({ id: s.id, label: s.label, state: 'todo' }));
  if (job.status === 'done') return STAGES.map((s) => ({ id: s.id, label: s.label, state: 'done' }));
  const cur = Math.max(0, stageIndexOf(job.phase));
  return STAGES.map((s, i) => {
    let state = 'todo';
    if (i < cur) state = 'done';
    else if (i === cur) state = job.status === 'failed' ? 'failed' : 'active';
    return { id: s.id, label: s.label, state };
  });
}

/** The live counts as pills. A count the server has not sent shows "—", never a made-up zero. */
export function counterPills(found) {
  const f = found || {};
  return [
    { id: 'accounts', label: 'Accounts linked', value: f.feeds },
    { id: 'posts', label: 'New posts pulled', value: f.postsAdded },
    { id: 'videos', label: 'Videos matched', value: f.videos },
    { id: 'leads', label: 'Paid leads', value: f.leads },
  ].map((p) => ({ ...p, text: p.value === undefined ? '—' : String(p.value) }));
}

/** True when accounts, videos or posts went up since the last poll (a missing earlier count counts as zero). */
export function grew(prevFound, nextFound) {
  const p = prevFound || {};
  const n = nextFound || {};
  return ['feeds', 'videos', 'postsAdded'].some((k) => (n[k] || 0) > (p[k] || 0));
}

/** Why a result matched. The server may send `provenance` (kinds below); otherwise it is read from the evidence lines. */
export const PROVENANCE = {
  exact: 'Exact handle',
  backlink: 'Bio backlink',
  alias: 'Alias match',
  visual: 'Visual match',
  web: 'Web search',
  directory: 'Directory match',
};

export function provenanceOf(c) {
  const kinds = [];
  const add = (k) => { if (PROVENANCE[k] && !kinds.includes(k)) kinds.push(k); };
  if (c && Array.isArray(c.provenance)) for (const p of c.provenance) add(typeof p === 'string' ? p : p && p.kind);
  for (const e of (c && c.evidence) || []) {
    const s = String(e || '').trim();
    // lookup.js writes these: the handle the visitor typed, a link on another profile, a web hit, a people-search hit
    if (/^handle “/.test(s)) add('exact');
    else if (/^(linked from |link-in-bio on |listed on link-in-bio )/.test(s)) add('backlink');
    else if (/^web search:/.test(s)) add('web');
    else if (/(people search|creator search|performer directory)/i.test(s)) add('directory');
  }
  return kinds.map((k) => ({ kind: k, label: PROVENANCE[k] }));
}

/** 65000 → "1m 05s", 42000 → "42s". */
export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** One sentence for the inline status line and for screen readers. */
export function statusLine(job) {
  if (!job) return '';
  if (job.status === 'failed') return `Stopped: ${job.error || 'the sweep failed'}`;
  if (job.running) {
    const i = Math.max(0, stageIndexOf(job.phase));
    return `${STAGES[i].label}, step ${i + 1} of ${STAGES.length}`;
  }
  const f = job.found || {};
  return `Done: ${f.feeds || 0} linked account${f.feeds === 1 ? '' : 's'}, ${f.postsAdded || 0} new post${f.postsAdded === 1 ? '' : 's'} pulled`;
}
