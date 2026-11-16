'use strict';
const express = require('express');
const repo = require('../db/repo');
const { adminRateLimit, adminCredentialAuth, adminKeyValid } = require('../middleware/auth');
const { registerEngine } = require('./admin/engine');
const { registerFeeds } = require('./admin/feeds');
const { registerCreators } = require('./admin/creators');
const { registerModeration } = require('./admin/moderation');
const { registerOps } = require('./admin/ops');

const router = express.Router();
// The brute-force guard counts every request that does not finish with a success. A request that already carries the RIGHT key has
// nothing to guess, so it never touches the guard: not the live event stream (which never finishes: 21 page changes used to lock the
// owner out) and not the owner's own requests after somebody else, behind the same address, burned the budget with wrong keys
// (the lockout used to refuse the correct key too). A wrong or missing key still counts and is still refused.
router.use((req, res, next) => (adminKeyValid(req) ? next() : adminRateLimit(req, res, next)), adminCredentialAuth);

const int = repo.clampInt;
const page = (req, max = 200) => ({ page: int(req.query.page, 0, 100000, 0), limit: int(req.query.limit, 1, max, 50) });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const errorKind = (text) => (text ? require('../engine/errorclass').classify(text).kind : null);
const helpers = { int, page, bad, errorKind };

registerEngine(router, helpers);
registerFeeds(router, helpers);
registerCreators(router, helpers);
registerModeration(router, helpers);
registerOps(router, helpers);

module.exports = router;
