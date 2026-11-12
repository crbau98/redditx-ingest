/**
 * "Find more across the web": the deep search for one creator. Every visitor sees the control on a creator page.
 *
 *   - On mount it reads the status once (silently). If a sweep is already running, for example one started by a lookup
 *     on #/find, the live banner opens by itself.
 *   - A visitor starts a sweep through POST /api/creators/:id/pull (the server enforces the cooldown).
 *   - An admin session starts it through POST /api/admin/creators/:id/pull with { force: true }.
 *   - While it runs, the banner shows a four-stage stepper and live count pills. When accounts, videos or posts go up,
 *     onUpdate(job, { incremental: true }) lets the page refresh its grid and counts without a full reload.
 *
 * The state logic lives in deep-pull-model.js. Everything DOM- or network-facing is passed in, so this can be tested
 * without a browser.
 */
import { normalizeJob, stageStates, counterPills, grew, statusLine, fmtElapsed, refusalText } from './deep-pull-model.js';

const CONTROL_TITLE = 'Search the web for more of this creator’s pages, pictures and videos. One search per creator every ten minutes.';
const ADMIN_TITLE = 'Admin: start a fresh sweep now (spends search and unlock credits)';

function headline(job) {
  if (job.running) return 'Deep search running';
  if (job.status === 'failed') return 'Deep search stopped';
  return 'Deep search finished';
}

function meta(job) {
  const bits = [];
  if (job.elapsedMs !== undefined) bits.push(fmtElapsed(job.elapsedMs));
  if (job.queriesTotal) bits.push(`${job.queriesRun || 0} of ${job.queriesTotal} searches`);
  return bits.join(' · ');
}

/**
 * @param {object} deps
 * @param {string} deps.creatorId
 * @param {string} [deps.adminKey]          set only for an admin session
 * @param {Function} deps.h                 DOM helper
 * @param {(path: string) => Promise<any>} deps.getStatus   fresh GET of a full path (/api/...), never from cache
 * @param {(path: string, body?: object) => Promise<any>} deps.post     POST of a full path (/api/...)
 * @param {(path: string) => Promise<any>} [deps.adminGet]  relative to /api/admin; used only if the public status route is missing
 * @param {(path: string, body?: object) => Promise<any>} [deps.adminPost] relative to /api/admin
 * @param {(job: object, opts: object) => void} [deps.onUpdate]
 * @param {number} [deps.every]             poll interval in ms
 * @returns {HTMLElement|null} null when there is no creator id
 */
export function deepPullControl({ creatorId, adminKey = '', h, getStatus, post, adminGet, adminPost, onUpdate, every = 2500, setTimer = setInterval, clearTimer = clearInterval }) {
  if (!creatorId) return null;
  const id = encodeURIComponent(creatorId);
  const publicPath = `/api/creators/${id}/pull`;   // status (GET) and visitor start (POST)
  const adminPath = `/creators/${id}/pull`;        // relative to /api/admin

  const btn = h('button', { class: 'btn dp-btn', type: 'button', title: adminKey ? ADMIN_TITLE : CONTROL_TITLE }, 'Find more across the web');
  const liveLine = h('span', { class: 'dp-sr', role: 'status', 'aria-live': 'polite' });
  const banner = h('div', { class: 'deep-pull-banner', hidden: true, 'aria-label': 'Deep search progress' });
  const note = h('span', { class: 'muted sm deep-pull-note', role: 'status' });
  // A div, not a span: the banner is a block and the wrapper must be able to hold it (valid HTML).
  const wrap = h('div', { class: 'deep-pull' }, btn, note, banner, liveLine);

  let timer = null;
  let running = false;
  let busy = false;          // a start request is in flight
  let sawThisSession = false; // the banner shows only for a sweep this page saw start or run
  let lastFound;
  let misses = 0;

  const stop = () => { if (timer) { clearTimer(timer); timer = null; } };
  const say = (text) => { if (liveLine.textContent !== text) liveLine.textContent = text; };

  function paint(job) {
    banner.hidden = false;
    banner.replaceChildren(
      h('div', { class: 'dp-head' },
        h('strong', { class: 'dp-title' }, headline(job)),
        meta(job) ? h('span', { class: 'muted sm dp-meta' }, meta(job)) : null),
      h('ol', { class: 'dp-stepper', 'aria-label': 'Deep search stages' }, stageStates(job).map((s, i) =>
        h('li', { class: `dp-step ${s.state}`, 'aria-current': s.state === 'active' ? 'step' : null },
          h('span', { class: 'dp-dot', 'aria-hidden': 'true' }, s.state === 'done' ? '✓' : s.state === 'failed' ? '!' : String(i + 1)),
          h('span', { class: 'dp-step-label' }, s.label)))),
      h('ul', { class: 'dp-pills', 'aria-label': 'Live counts' }, counterPills(job.found).map((p) =>
        h('li', { class: 'dp-pill', 'data-pill': p.id }, h('b', { class: 'num' }, p.text), h('span', null, p.label)))));
    say(statusLine(job));
  }

  /** Apply one status answer: paint, keep polling while it runs, and refresh the page when the counts moved. */
  function apply(job) {
    if (!wrap.isConnected) return stop();
    const wasRunning = running;
    // A finished sweep this page never saw run stays hidden; one that was running here ends with a final refresh.
    if (!job || (!job.running && !wasRunning && !sawThisSession)) { stop(); return; }
    const prev = lastFound;
    lastFound = job.found;
    running = job.running;
    paint(job);
    btn.disabled = running || busy;
    btn.textContent = running ? 'Searching…' : 'Find more across the web';
    if (running) {
      if (!timer) timer = setTimer(tick, every);
      if (grew(prev, job.found) && onUpdate) onUpdate(job, { incremental: true });
      return;
    }
    stop();
    if (wasRunning && onUpdate) onUpdate(job, { incremental: true, final: true });
  }

  /** The public status route, or (before it exists) the admin status route for an admin session. */
  async function readStatus() {
    try {
      return normalizeJob(await getStatus(publicPath));
    } catch (e) {
      if (e && e.status === 404 && adminKey && adminGet) return normalizeJob(await adminGet(adminPath));
      throw e;
    }
  }

  async function tick() {
    if (!wrap.isConnected) return stop();
    let job;
    try { job = await readStatus(); misses = 0; }
    catch (e) {
      if (++misses < 3) return;
      stop();
      say('Lost contact with the sweep. Reload the page to see where it stands.');
      return;
    }
    apply(job);
  }

  btn.addEventListener('click', async () => {
    if (busy || running) return;
    busy = true; btn.disabled = true; note.textContent = '';
    try {
      const r = adminKey && adminPost ? await adminPost(adminPath, { force: true }) : await post(publicPath, {});
      if (r && r.started) {
        sawThisSession = true;
        // A start answer may not carry a running job yet; show the first stage rather than nothing.
        const started = normalizeJob(r);
        apply(started && started.running ? started : normalizeJob({ job: { phase: 'starting', status: 'running' } }));
        return;
      }
      if (r && r.reason === 'already running') {
        sawThisSession = true;
        note.textContent = 'Already searching…';
        const job = await readStatus().catch(() => null);
        apply(job);
        return;
      }
      note.textContent = refusalText(r);
    } catch (e) {
      if (adminKey && (e.status === 401 || e.status === 403)) { stop(); wrap.remove(); return; }
      note.textContent = e && e.status === 404 ? 'Deep search is not available here yet.' : String((e && e.message) || 'Could not start a search.');
    } finally {
      busy = false;
      btn.disabled = running;
    }
  });

  // Silent check on mount: a sweep that is already running opens its banner without a click.
  readStatus().then((job) => { if (wrap.isConnected) apply(job); }).catch(() => {});
  return wrap;
}
