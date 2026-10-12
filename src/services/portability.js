'use strict';
/**
 * Configuration export / import: creators, feeds and blocklist as portable JSON
 * (no media, no secrets, no settings). Use it to back up what you curated, move
 * to a new host, or share a starter set. Import is additive and idempotent.
 */
const repo = require('../db/repo');
const registry = require('../sources');
const { checkText } = require('../lib/safety');
const { femaleCheck } = require('../lib/scope');

const FORMAT = 'prism-config';

function exportConfig() {
  const creators = repo.db.prepare('SELECT * FROM creators ORDER BY created_at').all().map((c) => {
    let links = []; try { links = JSON.parse(c.links || '[]'); } catch { /* ignore */ }
    return { ref: c.id, handle: c.handle, display_name: c.display_name, bio: c.bio, avatar_url: c.avatar_url, banner_url: c.banner_url, links, verified: !!c.verified, status: c.status, scope: c.scope };
  });
  const feeds = repo.db.prepare('SELECT * FROM feeds ORDER BY platform, kind, target').all().map((f) => ({
    platform: f.platform, kind: f.kind, target: f.target, label: f.label, creatorRef: f.creator_id, enabled: !!f.enabled, trusted: !!f.trusted,
    origin: f.origin, interval_min: f.interval_min, priority: f.priority,
  }));
  const blocklist = repo.db.prepare('SELECT type, value, reason FROM blocklist ORDER BY id').all();
  return { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), creators, feeds, blocklist };
}

function importConfig(data) {
  if (!data || data.format !== FORMAT || !Array.isArray(data.feeds)) throw Object.assign(new Error('Not a PRISM config export'), { status: 400 });
  const out = { creators: { created: 0, matched: 0, rejected: 0 }, feeds: { created: 0, existing: 0, skipped: 0 }, blocklist: { added: 0 } };
  const refToId = new Map();
  const feedsByRef = new Map();
  for (const f of data.feeds) if (f.creatorRef) { if (!feedsByRef.has(f.creatorRef)) feedsByRef.set(f.creatorRef, []); feedsByRef.get(f.creatorRef).push(f); }
  const byHandle = repo.db.prepare('SELECT id FROM creators WHERE handle = ? COLLATE NOCASE LIMIT 1');

  repo.db.transaction(() => {
    for (const c of data.creators || []) {
      if (!c || !c.handle || !c.ref) continue;
      if (checkText(c.handle, c.display_name, c.bio).level === 'block') { out.creators.rejected++; continue; }
      if (femaleCheck(c.handle, c.display_name, c.bio).level === 'hard') { out.creators.rejected++; continue; } // male-only
      // Match an existing creator by (1) any account/feed they own, then (2) identical handle,
      // so re-importing never duplicates people — including ones owned only by an RSS feed or page.
      let existingId = null;
      for (const f of feedsByRef.get(c.ref) || []) {
        const hit = repo.feeds.find(f.platform, f.kind, f.target);
        if (hit && hit.creator_id) { existingId = hit.creator_id; break; }
      }
      if (!existingId) { const row = byHandle.get(c.handle); if (row) existingId = row.id; }
      if (existingId) { refToId.set(c.ref, existingId); out.creators.matched++; continue; }
      const made = repo.creators.create({ handle: c.handle, displayName: c.display_name, bio: c.bio, avatarUrl: c.avatar_url, bannerUrl: c.banner_url, scope: ['in', 'uncertain', 'excluded'].includes(c.scope) ? c.scope : 'in', origin: 'import' });
      repo.creators.update(made.id, { verified: !!c.verified, links: Array.isArray(c.links) ? c.links.slice(0, 24) : [], status: ['active', 'hidden', 'blocked'].includes(c.status) ? c.status : 'active' });
      refToId.set(c.ref, made.id); out.creators.created++;
    }
    for (const f of data.feeds) {
      const adapter = registry.get(f && f.platform);
      if (!adapter || !adapter.kinds.includes(f.kind) || !f.target) { out.feeds.skipped++; continue; }
      if (repo.blocklist.has('creator', `${f.platform}:${String(f.target).toLowerCase()}`)) { out.feeds.skipped++; continue; }
      if (femaleCheck(f.target, f.label).level === 'hard') { out.feeds.skipped++; continue; }
      const r = repo.feeds.upsert({
        platform: f.platform, kind: f.kind, target: String(f.target), label: f.label, creatorId: f.creatorRef ? refToId.get(f.creatorRef) || null : null,
        enabled: f.enabled !== false, trusted: f.trusted !== false, origin: 'import', intervalMin: repo.clampInt(f.interval_min, 5, 20160, 180), priority: repo.clampInt(f.priority, -10, 10, 0),
      });
      if (r.created) out.feeds.created++; else out.feeds.existing++;
    }
    for (const b of data.blocklist || []) {
      if (b && ['source_key', 'hash', 'creator', 'post'].includes(b.type) && b.value && repo.blocklist.add(b.type, String(b.value), b.reason)) out.blocklist.added++;
    }
  })();
  return out;
}

module.exports = { exportConfig, importConfig, FORMAT };
