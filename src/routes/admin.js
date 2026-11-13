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
// The brute-force guard counts every request that does not finish with a success. The live event stream never finishes (it ends when
// the page is left), so each visit to a screen that listens to it used up one of the 20 attempts: 21 page changes in ten minutes locked
// the owner out. A stream that already carries the right key has nothing to guess, so it skips the guard; a wrong key still counts.
router.use((req, res, next) => (req.path === '/stream' && adminKeyValid(req) ? next() : adminRateLimit(req, res, next)), adminCredentialAuth);

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
