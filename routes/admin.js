const express = require('express');
const adminAuth = require('../middleware/admin-auth');
const ingestion = require('../services/ingestion');
const mediaService = require('../services/media');
const creatorsService = require('../services/creators');
const moderation = require('../services/moderation');
const db = require('../db');

const router = express.Router();

// All admin routes require auth
router.use(adminAuth);

// --- Ingestion ---
router.post('/ingest/start', (req, res) => {
  const state = ingestion.getState();
  if (state.ingesting) return res.json({ ok: false, msg: 'Already running' });
  ingestion.runIngestion(req.body);
  res.json({ ok: true });
});

router.post('/ingest/stop', (req, res) => {
  ingestion.stopIngestion();
  res.json({ ok: true });
});

router.post('/ingest/pause', (req, res) => {
  ingestion.pauseIngestion();
  res.json({ ok: true });
});

router.post('/ingest/resume', (req, res) => {
  ingestion.resumeIngestion();
  res.json({ ok: true });
});

router.get('/jobs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  res.json(db.getJobs(limit));
});

// --- Media Management ---
router.patch('/media/:id', (req, res) => {
  const media = db.getMedia(req.params.id);
  if (!media) return res.status(404).json({ error: 'Not found' });
  mediaService.update(req.params.id, req.body);
  res.json(db.getMedia(req.params.id));
});

router.delete('/media/:id', (req, res) => {
  const media = db.getMedia(req.params.id);
  if (!media) return res.status(404).json({ error: 'Not found' });
  mediaService.remove(req.params.id);
  res.json({ ok: true });
});

router.post('/media/:id/moderate', (req, res) => {
  const { action, reason } = req.body;
  if (!action) return res.status(400).json({ error: 'action is required' });
  const result = moderation.moderate(req.params.id, action, reason);
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json(result);
});

// Bulk media actions
router.post('/media/bulk', (req, res) => {
  const { ids, action } = req.body;
  if (!ids || !Array.isArray(ids) || !action) {
    return res.status(400).json({ error: 'ids array and action required' });
  }
  let updated = 0;
  for (const id of ids) {
    const result = moderation.moderate(id, action, 'bulk action');
    if (result) updated++;
  }
  res.json({ ok: true, updated });
});

// --- Creator Management ---
router.patch('/creators/:id', (req, res) => {
  const creator = creatorsService.get(req.params.id);
  if (!creator) return res.status(404).json({ error: 'Not found' });
  creatorsService.update(req.params.id, req.body);
  res.json(creatorsService.get(req.params.id));
});

router.post('/creators/merge', (req, res) => {
  const { keepId, mergeId } = req.body;
  if (!keepId || !mergeId) return res.status(400).json({ error: 'keepId and mergeId required' });
  const result = creatorsService.merge(keepId, mergeId);
  if (!result) return res.status(404).json({ error: 'One or both creators not found' });
  res.json(result);
});

// --- Moderation ---
router.get('/moderation/queue', (req, res) => {
  const { page, limit } = req.query;
  res.json(moderation.getQueue({
    page: parseInt(page) || 0,
    limit: Math.min(parseInt(limit) || 50, 200)
  }));
});

// --- Settings ---
router.get('/settings', (req, res) => {
  res.json(db.getAllSettings());
});

router.put('/settings', (req, res) => {
  const entries = req.body;
  for (const [key, value] of Object.entries(entries)) {
    db.setSetting(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  res.json(db.getAllSettings());
});

module.exports = router;
