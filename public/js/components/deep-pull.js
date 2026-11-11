/**
 * "Find more across the web": the admin-only deep pull for one creator (engine/deepsearch.js through
 * POST/GET /api/admin/creators/:id/pull). Deep pulls spend paid search and unlock credits, so the control
 * exists only for an admin session: with no admin key it renders nothing and sends no request.
 *
 * Dependencies are passed in (the DOM helper, the admin API calls, the key) so the control can be tested
 * without a browser.
 */

const PHASES = ['text', 'video', 'image'];
const PHASE_LABEL = { text: 'Searching the web', video: 'Searching videos', image: 'Matching pictures and reverse image' };

/** The inline line for a status answer: progress while running, the result counts when done. */
export function pullLine(st) {
  if (!st) return '';
  if (st.running) {
    const i = PHASES.indexOf(st.phase);
    return `${PHASE_LABEL[st.phase] || 'Starting'}… ${i >= 0 ? i + 1 : 1}/${PHASES.length} phases`;
  }
  if (st.error) return `Last sweep failed: ${st.error}`;
  if (st.done) {
    const f = st.found || {};
    return `Done: ${f.feeds || 0} new page${f.feeds === 1 ? '' : 's'}, ${f.pictures || 0} picture${f.pictures === 1 ? '' : 's'} matched, ${f.results || 0} result${f.results === 1 ? '' : 's'} read`;
  }
  return '';
}

/**
 * @param {{creatorId: string, adminKey: string, h: Function, adminGet: Function, adminPost: Function,
 *          onFound?: Function, every?: number, setTimer?: Function, clearTimer?: Function}} deps
 * @returns {HTMLElement|null} null when there is no admin session (nothing rendered, nothing requested)
 */
export function deepPullControl({ creatorId, adminKey, h, adminGet, adminPost, onFound, every = 3000, setTimer = setInterval, clearTimer = clearInterval }) {
  if (!adminKey || !creatorId) return null;
  const path = `/creators/${encodeURIComponent(creatorId)}/pull`;
  const line = h('span', { class: 'muted deep-pull-line', role: 'status', 'aria-live': 'polite' });
  const btn = h('button', { class: 'btn', type: 'button', title: 'Admin: search the whole web for his pages, pictures and videos (spends search and unlock credits)' }, 'Find more across the web');
  const wrap = h('span', { class: 'deep-pull' }, btn, line);
  let timer = null;
  let busy = false;
  let sawRunning = false;

  const stop = () => { if (timer) { clearTimer(timer); timer = null; } };
  const paint = (st) => {
    if (wrap.isConnected === false && timer) return stop();
    busy = !!(st && st.running);
    btn.disabled = busy;
    line.textContent = pullLine(st);
    if (busy) { sawRunning = true; if (!timer) timer = setTimer(poll, every); return; }
    stop();
    if (sawRunning && st && st.done) {
      sawRunning = false;
      const f = st.found || {};
      if ((f.feeds || f.pictures) && onFound) onFound(st);
    }
  };
  // A key that is no longer valid (401): the control goes away instead of offering a button that cannot work.
  const lost = (e) => { stop(); if (e && (e.status === 401 || e.status === 403)) wrap.remove(); };
  function poll() { return adminGet(path).then(paint, lost); }

  btn.addEventListener('click', async () => {
    if (busy) return; // a second click while a sweep runs does nothing (the server refuses it too)
    busy = true; btn.disabled = true;
    try {
      const r = await adminPost(path, { force: true });
      if (r && r.started) paint({ running: true, phase: 'text' });
      else { line.textContent = r && r.reason === 'already running' ? 'Already sweeping…' : String((r && (r.error || r.reason)) || 'Could not start'); await poll(); }
    } catch (e) { line.textContent = String((e && e.message) || e); lost(e); busy = false; btn.disabled = false; }
  });
  poll();
  return wrap;
}
