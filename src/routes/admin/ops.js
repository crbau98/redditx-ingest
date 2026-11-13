'use strict';
const config = require('../../config');
const repo = require('../../db/repo');
const settingsStore = require('../../settings');
const maintenance = require('../../engine/maintenance');
const events = require('../../engine/events');
const physique = require('../../engine/physique');
const imagefilter = require('../../lib/imagefilter');
const discovery = require('../../engine/discovery');
const backup = require('../../engine/backup');
const portability = require('../../services/portability');

function registerOps(router, { int, page, bad }) {
// Read-only library-health counts (engine/library-health.js): no writes, no repair; a windowed pass that keeps the loop free.
// Clear face vectors and alt sources still left on media removed before the takedown purge covered them (690c331), through
// the one purge (repo.purgeRemovedContent), in batches with yields. ?dryRun=1 only counts; ?limit=N caps one call.
router.post('/maintenance/purge-removed-residue', async (req, res) => {
  const q = { ...req.query, ...(req.body || {}) };
  const dryRun = q.dryRun === true || q.dryRun === '1' || q.dryRun === 'true';
  const limit = q.limit !== undefined && q.limit !== '' ? int(q.limit, 0, 1000000, 0) : Infinity;
  try { res.json(await require('../../engine/residue-purge').purgeResidue({ dryRun, limit })); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/library-health', async (req, res) => {
  try { res.json(await require('../../engine/library-health').report()); } catch (e) { res.status(500).json({ error: e.message }); }
});
/* ---------------------------------------------------------------- settings */
router.get('/settings', (req, res) => {
  const c = config.creds;
  res.json({
    values: settingsStore.get(),
    schema: settingsStore.describe(),
    credentials: {
      reddit: !!(c.redditClientId && c.redditClientSecret), x: !!c.xBearer, bluesky: !!(c.bskyIdentifier && c.bskyPassword), mastodon: !!c.mastodonToken,
      brave: !!c.braveKey, telegram: !!c.telegramBot, telegramValid: require('../../lib/telegram-bot').configured(),
    },
    instances: { mastodon: config.mastodonInstances },
    security: { adminKeySet: !!config.adminKey, ageGateEnforced: config.ageGateEnforce },
  });
});
const PHYSIQUE_KEYS = ['physiqueFilter', 'physiqueThreshold', 'physiqueCreatorShare'];
router.put('/settings', (req, res) => {
  const before = settingsStore.get();
  const values = settingsStore.update(req.body || {});
  // Audit the physique flips: a false→true or true→false here hid/shown 30k+ rows before, so it leaves a trail.
  for (const k of PHYSIQUE_KEYS) {
    if (values[k] !== before[k]) {
      try { repo.logAction('setting', k, values[k] === false || values[k] === 0 ? 'disable' : (before[k] === false || before[k] === 0 ? 'enable' : 'change'), `${JSON.stringify(before[k])} → ${JSON.stringify(values[k])}`, 'admin'); } catch { /* audit never blocks a settings save */ }
    }
  }
  // Lean preference switched off: forget the stored biases right away (chunked, off this request),
  // so Trending returns to the plain score; switched on: rewind the bias sweep to re-judge everyone.
  if (values.leanPreference === false && before.leanPreference !== false) maintenance.clearLeanBias().catch((e) => events.log('WARN', `Lean preference: ${e.message}`));
  if (values.leanPreference && !before.leanPreference) repo.settings.set('lean_bias_seq', '0');
  // The body filter hides, it never deletes: a new threshold (or switching it off) re-applies to the stored library at once.
  if (PHYSIQUE_KEYS.some((k) => values[k] !== before[k])) {
    const applied = physique.reapply(values);
    if (values.physiqueFilter && !before.physiqueFilter) physique.textSweep(values, { force: true }).catch((e) => events.log('WARN', `Body filter: ${e.message}`));
    return res.json({ values, physique: applied });
  }
  res.json({ values });
});

/* --------------------------------------------------------------- discovery */
router.get('/discovery', (req, res) => {
  const status = ['pending', 'followed', 'linked', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  res.json({
    ...discovery.status(),
    candidates: repo.candidates.list({ status, ...page(req, 200), q: typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : undefined, platform: /^[a-z]{1,20}$/.test(req.query.platform || '') ? req.query.platform : undefined, sort: ['score', 'recent', 'new'].includes(req.query.sort) ? req.query.sort : 'score' }),
    webMatches: (() => {
      try {
        const fm = require('../../lib/face-match');
        return { review: fm.listWebMatches({ status: 'review', limit: 30 }), confirmed: fm.listWebMatches({ status: 'confirmed', limit: 15 }) };
      } catch { return { review: [], confirmed: [] }; }
    })(),
  });
});
router.post('/discovery/web-matches/:id', (req, res) => {
  const action = req.body && req.body.action;
  if (!['confirm', 'reject'].includes(action)) return bad(res, 'action must be confirm or reject');
  const updated = require('../../lib/face-match').decideWebMatch(req.params.id, action, 'admin');
  if (!updated) return bad(res, 'Match not found', 404);
  res.json({ ok: true, match: updated });
});
router.post('/discovery/face-purge', (req, res) => {
  const { creatorId, mediaId } = req.body || {};
  const fm = require('../../lib/face-match');
  if (creatorId) fm.purgeForCreator(String(creatorId));
  if (mediaId) fm.purgeForMedia(String(mediaId));
  res.json({ ok: true });
});
router.post('/discovery/run', (req, res) => {
  const st = discovery.status();
  if (st.running) return res.status(409).json({ error: 'Discovery is already running' });
  discovery.run({ trigger: 'manual' }).catch(() => {});
  res.status(202).json({ ok: true, started: true });
});
router.post('/discovery/candidates/:id', (req, res) => {
  const action = req.body && req.body.action;
  const c = repo.candidates.get(req.params.id);
  if (!c) return bad(res, 'Not found', 404);
  if (action === 'follow') { const r = discovery.follow(c, { actor: 'admin' }); return r.ok ? res.json(r) : bad(res, r.reason || 'Could not follow'); }
  if (action === 'reject' || action === 'block') return res.json(discovery.reject(c.id, { block: action === 'block', reason: action === 'block' ? 'blocked from discovery' : 'rejected by admin' }));
  if (action === 'reset') return res.json(repo.candidates.update(c.id, { status: 'pending', reason: null, decided_at: null }));
  return bad(res, 'action must be follow, reject, block or reset');
});
router.post('/discovery/candidates', (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || !ids.length || !['follow', 'reject'].includes(action)) return bad(res, 'ids[] and action (follow|reject) required');
  const out = { ok: 0, failed: 0 };
  for (const id of ids.slice(0, 200)) {
    const r = action === 'follow' ? discovery.follow(String(id), { actor: 'admin' }) : discovery.reject(String(id));
    if (r && (r.ok || r.status === 'rejected')) out.ok++; else out.failed++;
  }
  res.json(out);
});

/* ---------------------------------------------------------- Paid-page leads */
// Paid pages named in posts, bios and search results (OnlyFans, Fansly, JustFor.Fans); PRISM traces each
// to the person's free public accounts. The paid pages are read like any other public page.
const paidLib = require('../../lib/paid');
router.get('/discovery/onlyfans', (req, res) => {
  const status = ['pending', 'searching', 'found', 'claimed', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'all';
  const service = ['OnlyFans', 'Fansly', 'JustFor.Fans', 'all'].includes(req.query.service) ? req.query.service : 'all';
  res.json({ counts: repo.onlyfans.counts(), ...repo.onlyfans.list({ status, service, ...page(req, 200), q: typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : undefined }) });
});
/** Paste paid-page links or handles (one per line): each becomes a lead the next discovery run traces. */
router.post('/discovery/onlyfans', (req, res) => {
  const { normal } = require('../../lib/onlyfans');
  const lines = String((req.body && req.body.handles) || '').split(/[\n,\s]+/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
  const out = { added: 0, claimed: 0, invalid: [] };
  for (const line of lines) {
    const svc = paidLib.serviceOf(line);
    const service = svc && paidLib.SERVICES[svc].trace ? svc : 'OnlyFans';
    const handle = svc && paidLib.SERVICES[svc].trace ? paidLib.paidHandle(service, line) : (/onlyfans\.com/i.test(line) ? paidLib.ofHandle(line) : normal(line));
    if (!handle) { out.invalid.push(line.slice(0, 80)); continue; }
    const owner = repo.onlyfans.ownerOf(handle, service);
    if (owner) { repo.onlyfans.claim(handle, owner.id, service); out.claimed++; continue; }
    const lead = repo.onlyfans.note(handle, { service, origin: 'admin' });
    if (lead.status === 'rejected' || lead.status === 'searching') repo.onlyfans.update(handle, { service, status: 'pending', reason: null, attempts: 0 });
    out.added++;
  }
  res.json(out);
});
router.post('/discovery/onlyfans/:handle', (req, res) => {
  const service = ['OnlyFans', 'Fansly', 'JustFor.Fans'].includes(req.body && req.body.service) ? req.body.service : 'OnlyFans';
  const lead = repo.onlyfans.get(req.params.handle, service);
  if (!lead) return bad(res, 'Not found', 404);
  const action = req.body && req.body.action;
  if (action === 'retry') return res.json(repo.onlyfans.update(lead.handle, { service, status: 'pending', reason: null, attempts: 0 }));
  if (action === 'reject') return res.json(repo.onlyfans.update(lead.handle, { service, status: 'rejected', reason: 'rejected by admin', checked_at: new Date().toISOString() }));
  return bad(res, 'action must be retry or reject');
});
/* ------------------------------------------------------------- maintenance */
router.post('/maintenance/sweep', async (req, res) => {
  try { res.json({ ok: true, ...(await maintenance.sweep({ probe: !!(req.body && req.body.probe) })) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/maintenance/image-filter', async (req, res) => {
  const s = settingsStore.get();
  res.json({ enabled: s.imageFilter, threshold: s.imageFilterThreshold, sweep: { enabled: s.imageSweep, perMinute: s.imageSweepPerTick, ...maintenance.imageSweepProgress() }, faceMatch: { enabled: s.faceMatch, threshold: s.faceMatchThreshold, perMinute: s.faceSweepPerMinute, ...maintenance.faceSweepProgress() }, physique: { ...physique.stats(s), sweep: maintenance.physiqueSweepProgress() }, dedupe: { enabled: s.dedupe, distance: s.dedupeDistance, ...maintenance.hashSweepProgress() }, thumbnails: { enabled: s.thumbnails, perMinute: s.thumbnailsPerMinute, ...require('../../engine/thumbs').progress() }, model: { available: await imagefilter.available(), ...imagefilter.status() } });
});
router.post('/maintenance/physique-sweep', async (req, res) => {
  try {
    const n = Math.min(Math.max(parseInt(req.body && req.body.limit, 10) || 50, 1), 300);
    res.json({ ok: true, ...(await maintenance.physiqueSweep({ limit: n })), ...maintenance.physiqueSweepProgress() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/maintenance/image-sweep', async (req, res) => {
  try {
    const n = Math.min(Math.max(parseInt(req.body && req.body.limit, 10) || 50, 1), 300);
    res.json({ ok: true, ...(await maintenance.imageSweep({ limit: n })), ...maintenance.imageSweepProgress() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/maintenance/face-sweep', async (req, res) => {
  try {
    const n = Math.min(Math.max(parseInt(req.body && req.body.limit, 10) || 50, 1), 300);
    res.json({ ok: true, ...(await maintenance.faceSweep({ limit: n })), ...maintenance.faceSweepProgress() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* ---------------------------------------------------------------- telegram (joined channels) */
router.get('/telegram', (req, res) => {
  const sync = require('../../services/telegram-sync');
  const s = require('../../settings').get();
  res.json({ ...sync.status(), backfillMax: s.telegramBackfillMax, maxMb: config.telegram.maxMb, store: require('../../lib/objectstore').describe() });
});
router.post('/telegram/sync', async (req, res) => {
  try { res.json({ ok: true, ...(await require('../../services/telegram-sync').sync()) }); }
  catch (e) { res.status(e.status || (e.skip ? 400 : 500)).json({ error: e.message }); }
});
/* ---------------------------------------------------------------- data volume + media store */
router.get('/disk', (req, res) => res.json({ disk: require('../../lib/diskguard').status(), store: require('../../lib/objectstore').describe() }));
/**
 * Move /data/store into the bucket (services/storemigrate). GET = progress. POST {mode:'dry-run'} reports counts and bytes and changes
 * nothing; {mode:'copy'} uploads and verifies; deleting verified local copies is a separate switch that must be asked for twice:
 * {mode:'copy', delete:true, confirmDelete:'delete-verified-local-copies'}.
 */
router.get('/maintenance/store-migrate', (req, res) => {
  res.json({ ...require('../../services/storemigrate').status(), disk: require('../../lib/diskguard').status(), store: require('../../lib/objectstore').describe() });
});
router.post('/maintenance/store-migrate', async (req, res) => {
  const mig = require('../../services/storemigrate');
  const { mode = 'dry-run', check = 0, confirmDelete } = req.body || {};
  const del = req.body && req.body.delete === true;
  try {
    if (mode === 'dry-run') return res.json({ ok: true, report: await mig.dryRun({ check: Math.min(500, Math.max(0, Number(check) || 0)) }) });
    if (mode !== 'copy') return res.status(400).json({ error: 'mode must be "dry-run" or "copy"' });
    if (del && confirmDelete !== 'delete-verified-local-copies') return res.status(400).json({ error: 'deleting local copies needs confirmDelete: "delete-verified-local-copies"' });
    events.log('WARN', `Admin started the store migration${del ? ' WITH deletion of verified local copies' : ' (copy only)'}`);
    res.status(202).json({ ok: true, ...mig.start({ deleteLocal: del }) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/maintenance/store-migrate/stop', (req, res) => res.json({ ok: true, stopped: require('../../services/storemigrate').stop() }));
router.post('/maintenance/recompute', (req, res) => {
  // Chunked so a big library does not freeze the event loop while the admin waits.
  repo.media.recomputeHotChunked().then((updated) => res.json({ ok: true, updated })).catch((e) => res.status(500).json({ error: e.message }));
});
router.get('/backups', (req, res) => res.json({ items: backup.list(), enabled: settingsStore.get().backupEnabled, keep: settingsStore.get().backupKeep }));
router.post('/backups', async (req, res) => {
  try { res.status(201).json({ ok: true, ...(await backup.run()) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/export', (req, res) => {
  res.set({ 'Content-Disposition': `attachment; filename="prism-config-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
  res.json(portability.exportConfig());
});
router.post('/import', (req, res) => {
  try { res.json({ ok: true, ...portability.importConfig(req.body) }); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
}

module.exports = { registerOps };
