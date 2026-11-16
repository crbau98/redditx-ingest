'use strict';
/**
 * Duty cycle for the background sweeps that need the picture model (face enrolment, body / image re-check, the visual
 * search backfill). They run modelSweepOnMinutes, then rest modelSweepOffMinutes. While they rest nothing touches the
 * model, so lib/imagefilter's idle release can stop its workers and return their memory (~450 MB each). New items are
 * checked at ingest whatever the cycle; only the backlog waits. modelSweepOffMinutes = 0 runs them all the time.
 */
function modelSweepOpen(now = Date.now(), s = require('../settings').get()) {
  const on = Math.max(1, Number(s.modelSweepOnMinutes) || 0);
  const off = Math.max(0, Number(s.modelSweepOffMinutes) || 0);
  if (!off) return true;
  return Math.floor(now / 60000) % (on + off) < on;
}

module.exports = { modelSweepOpen };
