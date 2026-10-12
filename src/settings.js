'use strict';
/**
 * Typed, validated runtime settings (stored in the `settings` table, editable
 * from the admin console). Secrets are never stored here — those are env vars.
 */
const config = require('./config');
const repo = require('./db/repo');

const SCHEMA = {
  schedulerEnabled: { type: 'bool', default: config.schedulerEnabled, label: 'Run the scheduler automatically' },
  tickSeconds: { type: 'int', default: 30, min: 5, max: 600, label: 'Scheduler tick (seconds)' },
  maxConcurrentFeeds: { type: 'int', default: 2, min: 1, max: 8, label: 'Feeds synced at once' },
  itemsPerRun: { type: 'int', default: 100, min: 10, max: 300, label: 'Max items per feed run' },
  scopeMode: { type: 'enum', values: ['strict', 'open'], default: 'strict', label: 'Unclear male-focus items: strict = review queue, open = publish' },
  autoTrack: { type: 'bool', default: true, label: 'Auto-follow creators discovered in communities' },
  autoTrackMinItems: { type: 'int', default: 2, min: 1, max: 20, label: 'Posts before a creator is auto-followed' },
  autoLinkProfiles: { type: 'bool', default: true, label: 'Follow creators’ other public accounts found in their bios' },
  maxFeeds: { type: 'int', default: 600, min: 10, max: 5000, label: 'Cap on enabled feeds' },
  probeUnknownHosts: { type: 'bool', default: true, label: 'Verify media from unknown hosts before publishing' },
  backupEnabled: { type: 'bool', default: config.isProd, label: 'Back up the database nightly' },
  backupKeep: { type: 'int', default: 3, min: 1, max: 30, label: 'Backups to keep' },
  keepRunHistoryDays: { type: 'int', default: 30, min: 1, max: 365, label: 'Run history retention (days)' },
};

function coerce(def, raw) {
  if (raw === undefined || raw === null || raw === '') return def.default;
  if (def.type === 'bool') return raw === true || /^(1|true|yes|on)$/i.test(String(raw));
  if (def.type === 'int') {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, def.min), def.max) : def.default;
  }
  if (def.type === 'enum') return def.values.includes(raw) ? raw : def.default;
  return raw;
}

function get() {
  const stored = repo.settings.all();
  const out = {};
  for (const [k, def] of Object.entries(SCHEMA)) out[k] = coerce(def, stored[k]);
  return out;
}

function update(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    const def = SCHEMA[k];
    if (!def) continue; // unknown keys are ignored, never stored
    repo.settings.set(k, String(coerce(def, v)));
  }
  return get();
}

function describe() {
  return Object.entries(SCHEMA).map(([key, d]) => ({ key, type: d.type, label: d.label, min: d.min, max: d.max, values: d.values, default: d.default }));
}

module.exports = { get, update, describe, SCHEMA };
