'use strict';
/**
 * "The server has answered a health check."
 *
 * The platform's health probe decides whether a deploy succeeded, and it can only be answered
 * while the event loop is free. Warming the caches (the library index, the vocabulary, the
 * trending refresh) is a few seconds of solid work on a large library, and it used to start right
 * after the server began listening: the probe's request then sat in the queue until the warm-up
 * finished, and a deploy was killed even though the container was perfectly healthy.
 *
 * So the warm-up waits for the first health answer. The fallback timer makes sure it still runs
 * when nothing probes /api/health (a local run, or a platform with the probe turned off).
 */
let resolveHealthy;
const healthy = new Promise((r) => { resolveHealthy = r; });
let answered = false;

/** Called by the health route once it has answered. */
function markHealthy() {
  if (answered) return;
  answered = true;
  resolveHealthy();
}

/** True once a health check has been answered. */
function isHealthy() { return answered; }

/**
 * Run `fn` once the server has answered a health check, or after `fallbackMs`, whichever comes
 * first. Returns a function that cancels the wait.
 */
function afterHealthy(fn, fallbackMs = 10000) {
  let done = false;
  const run = () => { if (done) return; done = true; clearTimeout(timer); fn(); };
  const timer = setTimeout(run, fallbackMs);
  if (timer.unref) timer.unref();
  healthy.then(run);
  return () => { done = true; clearTimeout(timer); };
}

module.exports = { markHealthy, isHealthy, afterHealthy };
