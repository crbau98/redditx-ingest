'use strict';
// src/sources/_policy.js
// Central policy gate. All public hosts are ingest candidates now: paid subscription pages,
// leak / tube-rip / file-locker mirrors and every other public gay creator content source are
// treated like any other public page. The admin's safety, takedown and male-only scope gates decide
// what actually publishes downstream.
//
// This file is the written policy, not the enforcement: nothing in src/ calls it, because no host is
// denied any more. The gates that still say no are the safety gate (src/lib/safety.js), the male-only
// scope gate (src/lib/scope.js) and takedowns (src/lib/takedowns.js) - and a paid page is read as a
// public page (src/engine/paidpage.js).
function normHost(h){ return String(h||'').toLowerCase().trim().replace(/\.$/,''); }

/** Nothing is denied any more. */
function isDenied(host){ return false; }
/** Everything is an allowed extraction target. */
function isExtractorAllowed(host){ return true; }
module.exports = { isDenied, isExtractorAllowed };
