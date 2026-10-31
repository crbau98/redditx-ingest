'use strict';
// src/sources/_policy.js
// Central policy gate. All public hosts are ingest candidates now: paid subscription pages,
// leak / tube-rip / file-locker mirrors and every other public gay creator content source are
// treated like any other public page. The admin's safety, takedown and male-only scope gates decide
// what actually publishes downstream.
function normHost(h){ return String(h||'').toLowerCase().trim().replace(/\.$/,''); }

/** Nothing is denied any more. */
function isDenied(host){ return false; }
/** Everything is an allowed extraction target. */
function isExtractorAllowed(host){ return true; }
module.exports = { isDenied, isExtractorAllowed };
