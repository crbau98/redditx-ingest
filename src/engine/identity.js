'use strict';
/**
 * Creator identity: one man, many accounts and names.
 *
 * Every piece of evidence here comes from what creators publish about THEMSELVES: the links in their own bios and
 * link-in-bio pages, the OnlyFans page they promote, and "backup / new / old account: @x" lines in their own bios.
 * Plus whatever the admin decides. There is no face matching and nothing is inferred from other people's posts.
 *
 *   aliases   every handle and display name a creator goes by (creator_aliases). Search finds him by any of them.
 *   links     two creator rows that are probably the same man (identity_links), with the evidence for it. Strong
 *             evidence plus the same name merges them on its own; anything else waits in the admin's queue,
 *             because couples and collab partners link to each other all the time.
 */
const repo = require('../db/repo');
const events = require('./events');
const settingsStore = require('../settings');
const { normAlias, usableAlias } = require('../lib/alias');
const paid = require('../lib/paid');

const db = repo.db;

/** Weight of each kind of evidence. A pair's strength is the sum over the distinct kinds it has. */
const WEIGHTS = {
  'bio-link': 2,       // A's bio links to an account PRISM files under B
  mutual: 2,           // ...and B's bio links back to A
  'bio-alias': 3,      // A's bio says "backup / new / old account: @<B's handle>"
  'same-onlyfans': 4,  // both promote the same OnlyFans page
  'same-paid': 4,      // both promote the same Fansly / JustFor.Fans page
  'same-linkpage': 4,  // both use the same link-in-bio page
  // two rows with the same handle: a candidate for the admin queue only. Never auto-merged (see mergeable).
  'same-handle': 1,
  admin: 10,
};
/** Auto-merge needs this much evidence AND a shared name; without the name it always waits for the admin. */
const AUTO_STRENGTH = 4;

const q = {
  // A name only his bio claimed ('bio') is promoted when an account, profile, merge or the admin confirms it.
  addAlias: db.prepare(`INSERT INTO creator_aliases (creator_id, norm, alias, kind, platform, source, signal, evidence_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (creator_id, norm) DO UPDATE SET alias = excluded.alias, kind = excluded.kind, platform = COALESCE(excluded.platform, platform), source = excluded.source,
      signal = excluded.signal, evidence_url = COALESCE(excluded.evidence_url, evidence_url)
    WHERE creator_aliases.source = 'bio' AND excluded.source != 'bio'`),
  // an alias that already exists keeps its first evidence; this only fills in what is missing
  addEvidence: db.prepare('UPDATE creator_aliases SET signal = COALESCE(signal, ?), evidence_url = COALESCE(evidence_url, ?) WHERE creator_id = ? AND norm = ?'),
  aliasesOf: db.prepare('SELECT alias, norm, kind, platform, source, signal, evidence_url, created_at FROM creator_aliases WHERE creator_id = ? ORDER BY kind, created_at'),
  delAlias: db.prepare('DELETE FROM creator_aliases WHERE creator_id = ? AND norm = ?'),
  byNorm: db.prepare(`SELECT DISTINCT a.creator_id FROM creator_aliases a JOIN creators c ON c.id = a.creator_id
    WHERE a.norm = ? AND c.status != 'blocked' LIMIT 20`),
  nameNorms: db.prepare("SELECT norm FROM creator_aliases WHERE creator_id = ? AND source IN ('account','profile','admin','lookup','merge')"),
  link: db.prepare('SELECT * FROM identity_links WHERE a_id = ? AND b_id = ?'),
  linkById: db.prepare('SELECT * FROM identity_links WHERE id = ?'),
  insLink: db.prepare('INSERT INTO identity_links (a_id, b_id, a_label, b_label, evidence, strength) VALUES (?, ?, ?, ?, ?, ?)'),
  linksOf: db.prepare('SELECT * FROM identity_links WHERE a_id = ? OR b_id = ?'),
  repair: db.prepare("UPDATE identity_links SET a_id = ?, b_id = ?, a_label = ?, b_label = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"),
  delLink: db.prepare('DELETE FROM identity_links WHERE id = ?'),
  kept: db.prepare('UPDATE identity_links SET kept_id = ? WHERE id = ?'),
  updLink: db.prepare("UPDATE identity_links SET evidence = ?, strength = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"),
  decide: db.prepare("UPDATE identity_links SET status = ?, decided_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"),
};

const pair = (x, y) => (x < y ? [x, y] : [y, x]);

/* ---------------------------------------------------------------- aliases */

/** What each kind of alias source rests on, when the caller does not say more. */
const DEFAULT_SIGNAL = { account: 'own-account', profile: 'own-profile', bio: 'bio-line', admin: 'admin', lookup: 'lookup', merge: 'merge' };

/**
 * Record a name or handle for a creator, with where it came from: `signal` (the kind of self-declared evidence) and
 * `evidenceUrl` (the public page that shows it). Returns true when it was new.
 */
function addAlias(creatorId, alias, { kind = 'handle', platform = null, source = 'account', signal = null, evidenceUrl = null } = {}) {
  const text = String(alias || '').trim().slice(0, 80);
  const norm = normAlias(text);
  if (!creatorId || !norm || norm.length < 2) return false;
  const sig = signal || DEFAULT_SIGNAL[source] || source;
  const url = evidenceUrl ? String(evidenceUrl).slice(0, 300) : null;
  const added = q.addAlias.run(creatorId, norm, text, kind, platform, source, sig, url).changes > 0;
  q.addEvidence.run(sig, url, creatorId, norm);
  return added;
}

function aliasesOf(creatorId) { return q.aliasesOf.all(creatorId); }

function removeAlias(creatorId, alias) { return q.delAlias.run(creatorId, normAlias(alias)).changes > 0; }

/** Creators who go by this name or handle (exact alias key, any platform). */
function findByAlias(text) {
  const norm = normAlias(text);
  if (!norm) return [];
  return q.byNorm.all(norm).map((r) => repo.creators.get(r.creator_id)).filter(Boolean);
}

/**
 * Handles a creator names as his own other accounts, in his own bio: "backup: @x", "new acc @x",
 * "formerly @x", "aka x", "old account got banned, now @x". Shout-outs ("go follow my bf @x") don't match.
 */
// Handles may be Bluesky-style ("jake-fit.bsky"), dotted or dashed: trailing dots/dashes are punctuation, not name.
const ALIAS_LINE = /\b(?:back[\s-]?up|alt(?:ernate)?|second|2nd|spare|other|new|old|main|priv(?:ate)?|nsfw|sfw|18\+|spicy)\s*(?:acc(?:oun)?t?|acct|page|profile|ig|insta|twitter|x|blog)?\s*(?:is|here|here's|:|-|–|—|=|→|->|>|at|on)?\s*@([A-Za-z0-9_.-]{3,40})/gi;
const AKA = /\b(?:formerly|previously|prev\.?|aka|a\.k\.a\.?|also known as|also goes by|fka|f\.k\.a\.?)\s*[:\-–—]?\s*@?([A-Za-z0-9_.-]{3,40})/gi;
const NEW_HOME = /\b(?:banned|suspended|deleted|locked|got taken down|lost my (?:old )?(?:acc(?:oun)?t|page))\b[^@\n]{0,40}@([A-Za-z0-9_.-]{3,40})/gi;

function bioAliases(bio) {
  const out = new Set();
  const text = String(bio || '');
  for (const re of [ALIAS_LINE, AKA, NEW_HOME]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const h = m[1].replace(/[._-]+$/, '');
      if (usableAlias(normAlias(h))) out.add(h);
    }
  }
  return [...out].slice(0, 8);
}

/* ------------------------------------------------------------------ links */

function strengthOf(evidence, a, b) {
  const kinds = new Set(evidence.map((e) => e.type));
  let s = 0;
  for (const k of kinds) s += WEIGHTS[k] || 0;
  // mutual = a bio link from each of the pair's two creators (not two links from the same side)
  const dirs = new Set(evidence.filter((e) => e.type === 'bio-link').map((e) => e.from));
  if (dirs.has(a) && dirs.has(b)) s += WEIGHTS.mutual;
  return s;
}

/** Evidence moved from a merged-away creator speaks for the survivor now: rewrite `from`, then drop duplicates. */
function remapEvidence(list, goneId, keepId) {
  const out = [];
  for (const e of list) {
    const x = e.from === goneId ? { ...e, from: keepId } : e;
    if (!out.some((y) => y.type === x.type && y.from === x.from && y.detail === x.detail)) out.push(x);
  }
  return out.slice(-20);
}

/** Same name: the two share a usable handle / display-name key that they use themselves (not one from the other's bio). */
function sameName(x, y) {
  const a = new Set(q.nameNorms.all(x).map((r) => r.norm).filter(usableAlias));
  return q.nameNorms.all(y).some((r) => a.has(r.norm));
}

/**
 * Note one piece of evidence that creators x and y are the same man.
 * @param {{type: string, from?: string, detail?: string, url?: string}} ev  url = the public page that shows the evidence
 * @returns {{id, strength, status, merged?: boolean}|null}
 */
function noteLink(x, y, ev, { autoMerge = true } = {}) {
  if (!x || !y || x === y || !WEIGHTS[ev.type]) return null;
  const [a, b] = pair(x, y);
  if (!repo.creators.get(a) || !repo.creators.get(b)) return null;
  let row = q.link.get(a, b);
  const item = { type: ev.type, from: ev.from || null, detail: ev.detail ? String(ev.detail).slice(0, 160) : null };
  if (ev.url) item.url = String(ev.url).slice(0, 300);
  if (!row) {
    const evidence = [item];
    const id = q.insLink.run(a, b, repo.creators.get(a).handle, repo.creators.get(b).handle, JSON.stringify(evidence), strengthOf(evidence, a, b)).lastInsertRowid;
    row = q.linkById.get(id);
    events.log('INFO', `Possible same creator: ${repo.creators.get(a).handle} ↔ ${repo.creators.get(b).handle} (${ev.type})`);
  } else {
    if (row.status !== 'pending') return { id: row.id, strength: row.strength, status: row.status };
    let evidence = []; try { evidence = JSON.parse(row.evidence || '[]'); } catch { evidence = []; }
    if (!evidence.some((e) => e.type === item.type && e.from === item.from && e.detail === item.detail)) {
      evidence = evidence.concat(item).slice(-20);
      q.updLink.run(JSON.stringify(evidence), strengthOf(evidence, a, b), row.id);
      row = q.linkById.get(row.id);
    }
  }
  if (autoMerge && mergeable(row)) {
    const kept = merge(row.id, { actor: 'identity' });
    if (kept) return { id: row.id, strength: row.strength, status: 'merged', merged: true, creatorId: kept.id };
  }
  return { id: row.id, strength: row.strength, status: row.status };
}

// Only two live creators merge on their own: folding a hidden (body filter, admin) creator into an active one would
// republish what was hidden, and the reverse would pull a live creator off the site. Those pairs wait for the admin.
const live = (id) => { const c = repo.creators.get(id); return !!c && c.status === 'active'; };
// A shared handle is a reason to look, not proof: two different men can share one. A pair with the same handle
// waits for the admin whatever else it has, and this is checked live, so it holds even before scan() notes it.
const sameHandle = (x, y) => { const a = repo.creators.get(x); const b = repo.creators.get(y); return !!a && !!b && String(a.handle).toLowerCase() === String(b.handle).toLowerCase(); };
const mergeable = (row) => settingsStore.get().identityAutoMerge !== false && row.status === 'pending' && row.strength >= AUTO_STRENGTH
  && live(row.a_id) && live(row.b_id) && sameName(row.a_id, row.b_id) && !sameHandle(row.a_id, row.b_id);

/**
 * Apply any auto-merge now due for this creator (applyProfile notes its evidence first with autoMerge off, so the
 * profile is never half-applied to a creator that was just merged away). Returns the id that survives.
 */
function settle(creatorId) {
  let id = creatorId;
  for (let i = 0; i < 5 && id; i++) {
    const row = q.linksOf.all(id, id).find(mergeable);
    if (!row) break;
    const kept = merge(row.id, { actor: 'identity' });
    if (!kept) break;
    id = kept.id;
  }
  return id;
}

/**
 * The takedown that covers this creator row, or null: by its id or handle (creator), any of its names or paid-page handles (handle),
 * or any of its links (url / domain). Used so a merge or an unmerge never brings a taken-down person back.
 */
function takedownFor(row, aliases = []) {
  if (!row) return null;
  const td = require('../lib/takedowns');
  let links = []; try { links = Array.isArray(row.links) ? row.links : JSON.parse(row.links || '[]'); } catch { links = []; }
  const names = [row.handle, ...aliases.map((a) => a.alias || a)].filter(Boolean);
  const paidHandles = links.map((l) => l && (l.handle || (paid.serviceOf(l.url || '') ? paid.paidHandle(paid.serviceOf(l.url || ''), l.url || '') : null))).filter(Boolean);
  for (const t of repo.takedowns.all()) {
    const v = String(t.value || '');
    if (t.kind === 'creator' && [row.id, ...names].some((n) => td.creatorMatches(n, v))) return t;
    if (t.kind === 'handle' && [...names, ...paidHandles].some((n) => td.handleMatches(n, null, v))) return t;
    if ((t.kind === 'url' || t.kind === 'domain') && links.some((l) => l && l.url && td.checkUrl(l.url, [t]))) return t;
  }
  return null;
}

/** Fold two linked creators into one: the one with more posts stays. */
function merge(linkId, { keepId = null, actor = 'admin', force = false } = {}) {
  lastRefusal = null;
  const row = q.linkById.get(linkId);
  if (!row || row.status !== 'pending') return null; // decided already: a "different people" verdict is never overridden from the queue
  const A = repo.creators.get(row.a_id); const B = repo.creators.get(row.b_id);
  if (!A || !B) return null;
  const keep = keepId === B.id || (!keepId && (B.media_count || 0) > (A.media_count || 0)) ? B : A;
  const gone = keep === A ? B : A;
  const out = mergeCreators(keep.id, gone.id, { actor, reason: `identity link #${row.id}`, linkId: row.id, force });
  if (out && out.error) { lastRefusal = out.error; return null; } // refused (blocked / taken down): the queue and auto-merge just move on
  return out;
}
let lastRefusal = null;
/** Why the last merge() was refused, for the admin route's error message. */
function mergeRefusal() { return lastRefusal; }

/** Merge creator `goneId` into `keepId`, keeping both men's names as aliases. Used by the queue and the admin's Merge button. */
function mergeCreators(keepId, goneId, { actor = 'admin', reason = 'merge', linkId = null, force = false } = {}) {
  const keep = repo.creators.get(keepId); const gone = repo.creators.get(goneId);
  if (!keep || !gone || keepId === goneId) return null;
  // A creator under a safety hold (hidden for human review) or with an underage / nonconsensual report is never merged, not even with
  // force: folding him into another row would dissolve the hold and point the report at a deleted row (Crucible v4.23.1 gate). The
  // human act is to resolve the review and restore him first.
  for (const [role, c] of [['folded', gone], ['kept', keep]]) {
    const held = db.prepare(`SELECT 1 FROM reports WHERE kind IN ('underage', 'nonconsensual')
      AND (creator_id = ? OR media_id IN (SELECT id FROM media WHERE creator_id = ?)) AND status = 'open' LIMIT 1`).get(c.id, c.id);
    const lastStatus = db.prepare(`SELECT action FROM moderation_actions WHERE target_type = 'creator' AND target_id = ?
      AND (action LIKE '%hide%' OR action LIKE '%block%' OR action LIKE '%restore%' OR action LIKE 'admin-%' OR action LIKE 'safety%' OR action LIKE 'report%')
      ORDER BY id DESC LIMIT 1`).get(c.id);
    if (held || (c.status === 'hidden' && lastStatus && lastStatus.action === 'safety-hold')) {
      return { error: `the ${role} creator ${c.handle} is held for a safety review: resolve the review and restore him first`, status: 409 };
    }
  }
  // A blocked or taken-down row folded into a live one would put its posts back on the site under the kept name. Only an explicit
  // force (the admin, knowingly) does that.
  if (!force) {
    for (const [role, c] of [['folded', gone], ['kept', keep]]) {
      if (c.status === 'blocked') return { error: `the ${role} creator ${c.handle} is blocked: restore it first, or pass force=1`, status: 409 };
      const t = takedownFor(c, aliasesOf(c.id));
      if (t) return { error: `the ${role} creator ${c.handle} is covered by takedown #${t.id} (${t.kind}:${t.value}): pass force=1 to merge anyway`, status: 409 };
    }
  }
  // Record the decision (a direct admin merge gets a row of its own), then move gone's other open links over to keep.
  let row = linkId ? q.linkById.get(linkId) : q.link.get(...pair(keepId, goneId));
  if (!row) {
    const [a, b] = pair(keepId, goneId);
    row = q.linkById.get(q.insLink.run(a, b, repo.creators.get(a).handle, repo.creators.get(b).handle, JSON.stringify([{ type: 'admin', from: null, detail: null }]), WEIGHTS.admin).lastInsertRowid);
  }
  q.decide.run('merged', actor, row.id);
  q.kept.run(keepId, row.id);
  for (const r of q.linksOf.all(goneId, goneId)) {
    if (r.id === row.id || r.status === 'merged') continue; // history stays as it was
    const other = r.a_id === goneId ? r.b_id : r.a_id;
    if (other === keepId) { q.delLink.run(r.id); continue; }
    const [a, b] = pair(keepId, other);
    const clash = q.link.get(a, b);
    if (clash) {
      if (r.status === 'rejected' && clash.status === 'pending') q.decide.run('rejected', r.decided_by || actor, clash.id); // "different people" carries over
      else if (r.status === 'pending' && clash.status === 'pending') { // both suggested the same third man: pool the evidence
        let ev = []; try { ev = JSON.parse(clash.evidence || '[]'); } catch { ev = []; }
        let more = []; try { more = JSON.parse(r.evidence || '[]'); } catch { more = []; }
        ev = remapEvidence(ev.concat(more), goneId, keepId);
        q.updLink.run(JSON.stringify(ev), strengthOf(ev, a, b), clash.id);
      }
      q.delLink.run(r.id);
      continue;
    }
    q.repair.run(a, b, repo.creators.get(a).handle, repo.creators.get(b) ? repo.creators.get(b).handle : null, r.id);
    if (r.status === 'pending') {
      let ev = []; try { ev = JSON.parse(r.evidence || '[]'); } catch { ev = []; }
      ev = remapEvidence(ev, goneId, keepId);
      q.updLink.run(JSON.stringify(ev), strengthOf(ev, a, b), r.id);
    }
  }
  const snapId = snapshotMerge(keepId, goneId, { actor, reason, linkId: row.id }); // taken before anything of the fold is written
  addAlias(keepId, gone.handle, { kind: 'handle', source: 'merge' });
  if (gone.display_name) addAlias(keepId, gone.display_name, { kind: 'name', source: 'merge' });
  const out = repo.creators.merge(keepId, goneId);
  if (!out) db.prepare('DELETE FROM merge_snapshots WHERE id = ?').run(snapId);
  if (out) {
    out.snapshotId = snapId;
    repo.logAction('creator', keepId, force ? 'merge-forced' : 'merge', `${gone.handle} folded in (${reason}; undo: POST /api/admin/identity/unmerge/${snapId})`, actor);
    events.log('INFO', `Merged creator ${gone.handle} into ${keep.handle} (${actor === 'identity' ? 'same accounts and name' : actor})`);
  }
  return out;
}

/* ------------------------------------------------------- merge snapshots + undo */
/**
 * A merge deletes the folded row. Before it does, everything needed to rebuild it is kept: the row itself, the kept row as it was,
 * the ids of the feeds, media and paid leads that move, the folded row's aliases, the kept row's alias keys before, and the push
 * subscriptions that followed the folded row. unmerge() puts them back.
 */
let snapReady = false;
function ensureSnapshots() {
  if (snapReady) return;
  db.exec(`CREATE TABLE IF NOT EXISTS merge_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, keep_id TEXT NOT NULL, gone_id TEXT NOT NULL, link_id INTEGER,
      gone_row TEXT NOT NULL, keep_row TEXT NOT NULL, feed_ids TEXT NOT NULL, media_ids TEXT NOT NULL, lead_handles TEXT NOT NULL,
      gone_aliases TEXT NOT NULL, keep_alias_norms TEXT NOT NULL, push_subs TEXT NOT NULL,
      actor TEXT, reason TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), undone_at TEXT, undone_by TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_merge_snapshots_gone ON merge_snapshots(gone_id)');
  snapReady = true;
}
function snapshotMerge(keepId, goneId, { actor = null, reason = null, linkId = null } = {}) {
  ensureSnapshots();
  const ids = (sql) => db.prepare(sql).all(goneId).map((r) => r.id);
  const subs = db.prepare('SELECT id, creator_ids FROM push_subscriptions WHERE creator_ids LIKE ?').all(`%${goneId}%`)
    .map((r) => { let list = []; try { list = JSON.parse(r.creator_ids || '[]'); } catch { list = []; } return { id: r.id, hadKeep: list.includes(keepId) }; });
  return db.prepare(`INSERT INTO merge_snapshots (keep_id, gone_id, link_id, gone_row, keep_row, feed_ids, media_ids, lead_handles, gone_aliases, keep_alias_norms, push_subs, actor, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(keepId, goneId, linkId,
    JSON.stringify(db.prepare('SELECT * FROM creators WHERE id = ?').get(goneId)), JSON.stringify(db.prepare('SELECT * FROM creators WHERE id = ?').get(keepId)),
    JSON.stringify(ids('SELECT id FROM feeds WHERE creator_id = ?')), JSON.stringify(ids('SELECT id FROM media WHERE creator_id = ?')),
    JSON.stringify(db.prepare('SELECT handle FROM onlyfans_leads WHERE creator_id = ?').all(goneId).map((r) => r.handle)),
    JSON.stringify(db.prepare('SELECT * FROM creator_aliases WHERE creator_id = ?').all(goneId)),
    JSON.stringify(db.prepare('SELECT norm FROM creator_aliases WHERE creator_id = ?').all(keepId).map((r) => r.norm)),
    JSON.stringify(subs), actor, reason ? String(reason).slice(0, 500) : null).lastInsertRowid;
}

function snapshots({ limit = 50, creatorId = null } = {}) {
  ensureSnapshots();
  const rows = creatorId
    ? db.prepare('SELECT * FROM merge_snapshots WHERE keep_id = ? OR gone_id = ? ORDER BY id DESC LIMIT ?').all(creatorId, creatorId, limit)
    : db.prepare('SELECT * FROM merge_snapshots ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => { const g = JSON.parse(r.gone_row); const k = JSON.parse(r.keep_row);
    return { id: r.id, keep: { id: r.keep_id, handle: k.handle }, gone: { id: r.gone_id, handle: g.handle }, media: JSON.parse(r.media_ids).length, feeds: JSON.parse(r.feed_ids).length,
      actor: r.actor, reason: r.reason, createdAt: r.created_at, undoneAt: r.undone_at, undo: r.undone_at ? null : { method: 'POST', path: `/api/admin/identity/unmerge/${r.id}` } }; });
}

/**
 * Undo one merge: the folded row comes back with its own feeds, media, paid leads, aliases and followers; what the merge added to
 * the kept row (its links, the names it learned, blanks it filled) is taken off again; the pair is recorded as different people so
 * no automatic pass merges it again. Rows that moved on since (re-filed by hand, deleted) are left where they are.
 * @returns {{ok: true, restored: string, media: number, feeds: number}|{error: string}}
 */
function unmerge(snapshotId, { actor = 'admin', force = false } = {}) {
  ensureSnapshots();
  const r = db.prepare('SELECT * FROM merge_snapshots WHERE id = ?').get(Number(snapshotId));
  if (!r) return { error: 'No such merge snapshot', status: 404 };
  if (r.undone_at) return { error: `Already undone at ${r.undone_at}`, status: 409 };
  if (repo.creators.get(r.gone_id)) return { error: 'That creator row exists again', status: 409 };
  const keep = db.prepare('SELECT * FROM creators WHERE id = ?').get(r.keep_id);
  const gone = JSON.parse(r.gone_row); const keepBefore = JSON.parse(r.keep_row);
  // Never bring a taken-down or blocked person back as a live row: the takedown or the block may have come after the merge.
  if (keep && keep.status === 'blocked') return { error: `the kept creator ${keep.handle} is blocked now: restoring ${gone.handle} from it would put a blocked person back`, status: 409 };
  const t = takedownFor(gone, JSON.parse(r.gone_aliases)) || (keep ? takedownFor(keep, aliasesOf(keep.id)) : null);
  if (t) return { error: `takedown #${t.id} (${t.kind}:${t.value}) covers ${gone.handle} or the row it was folded into`, status: 409 };
  if (gone.status === 'blocked') return { error: `${gone.handle} was blocked when it was merged`, status: 409 };
  // another creator has taken that handle since: two rows of one name would be the split this repaired
  const clash = db.prepare("SELECT id, handle FROM creators WHERE lower(handle) = lower(?) AND id != ? AND status != 'blocked'").get(gone.handle, r.keep_id);
  if (clash && !force) return { error: `another creator (${clash.id}) now has the handle ${clash.handle}: merge or rename it first, or pass force=1`, status: 409 };
  const cols = db.prepare('PRAGMA table_info(creators)').all().map((c) => c.name).filter((c) => Object.prototype.hasOwnProperty.call(gone, c));
  const moveBack = (table, ids, key = 'id') => {
    let n = 0; const st = db.prepare(`UPDATE ${table} SET creator_id = ? WHERE ${key} = ? AND creator_id IS ?`);
    for (const id of ids) n += st.run(r.gone_id, id, r.keep_id).changes;
    return n;
  };
  const out = db.transaction(() => {
    db.prepare(`INSERT INTO creators (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => gone[c]));
    const media = moveBack('media', JSON.parse(r.media_ids));
    const feeds = moveBack('feeds', JSON.parse(r.feed_ids));
    moveBack('onlyfans_leads', JSON.parse(r.lead_handles), 'handle');
    // aliases: the folded row's own come back; the keys the merge added to the kept row go
    const keepNorms = new Set(JSON.parse(r.keep_alias_norms));
    const goneAliases = JSON.parse(r.gone_aliases);
    const added = new Set([...goneAliases.map((a) => a.norm), normAlias(gone.handle), gone.display_name ? normAlias(gone.display_name) : null].filter(Boolean));
    for (const norm of added) if (!keepNorms.has(norm)) q.delAlias.run(r.keep_id, norm);
    for (const a of goneAliases) {
      const c = Object.keys(a);
      db.prepare(`INSERT OR IGNORE INTO creator_aliases (${c.join(', ')}) VALUES (${c.map(() => '?').join(', ')})`).run(...c.map((k) => (k === 'creator_id' ? r.gone_id : a[k])));
    }
    if (keep) {
      // the kept row: links that came only from the folded row go; blanks the merge filled from it are blank again
      const parseL = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
      const key = (l) => String((l && (l.url || l.handle)) || '').toLowerCase();
      const before = new Set(parseL(keepBefore.links).map(key)); const fromGone = new Set(parseL(gone.links).map(key));
      const links = parseL(keep.links).filter((l) => before.has(key(l)) || !fromGone.has(key(l)));
      const patch = { links };
      for (const [col, k] of [['display_name', 'displayName'], ['bio', 'bio'], ['avatar_url', 'avatarUrl'], ['banner_url', 'bannerUrl']]) {
        if (keep[col] !== keepBefore[col] && keep[col] === gone[col]) patch[k] = keepBefore[col];
      }
      repo.creators.update(r.keep_id, patch);
    }
    for (const sub of JSON.parse(r.push_subs)) {
      const row = db.prepare('SELECT creator_ids FROM push_subscriptions WHERE id = ?').get(sub.id);
      if (!row) continue;
      let list = []; try { list = JSON.parse(row.creator_ids || '[]'); } catch { list = []; }
      if (!sub.hadKeep) list = list.filter((x) => x !== r.keep_id);
      if (!list.includes(r.gone_id)) list.push(r.gone_id);
      db.prepare('UPDATE push_subscriptions SET creator_ids = ? WHERE id = ?').run(JSON.stringify(list), sub.id);
    }
    // "different people" from now on: no automatic pass folds them again
    const [a, b] = pair(r.keep_id, r.gone_id);
    const link = q.link.get(a, b);
    if (link) db.prepare("UPDATE identity_links SET status = 'rejected', decided_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(actor, link.id);
    else q.decide.run('rejected', actor, q.insLink.run(a, b, a === r.keep_id ? keepBefore.handle : gone.handle, a === r.keep_id ? gone.handle : keepBefore.handle, JSON.stringify([{ type: 'admin', from: null, detail: 'unmerged' }]), 0).lastInsertRowid);
    db.prepare("UPDATE merge_snapshots SET undone_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), undone_by = ? WHERE id = ?").run(actor, r.id);
    return { media, feeds };
  })();
  repo.creators.refreshStats(r.gone_id);
  if (keep) repo.creators.refreshStats(r.keep_id);
  repo.logAction('creator', r.gone_id, 'unmerge', `restored from ${keepBefore.handle} (merge snapshot #${r.id}); ${out.media} media, ${out.feeds} feeds`, actor);
  events.log('INFO', `Unmerged ${gone.handle} from ${keepBefore.handle}`);
  return { ok: true, restored: r.gone_id, ...out };
}

function reject(linkId, actor = 'admin') {
  const row = q.linkById.get(linkId);
  if (!row || row.status !== 'pending') return false;
  q.decide.run('rejected', actor, linkId);
  repo.logAction('creator', row.a_id, 'identity-reject', `not the same as ${row.b_id}`, actor);
  return true;
}

/* -------------------------------------------------------- profile + scan */

/**
 * Called whenever a platform hands us a creator's profile (engine/creators.applyProfile).
 * Records his handle and display name, and the alias handles his bio names on the same platform.
 * @returns {{aliases: number, accounts: Array<{platform, kind, target}>}} accounts = bio-named handles nobody has yet
 */
function noteProfile(creatorId, feed, profile) {
  const out = { aliases: 0, accounts: [] };
  if (!creatorId || !profile) return out;
  if (feed && feed.kind === 'user' && addAlias(creatorId, feed.target, { platform: feed.platform, source: 'account' })) out.aliases++;
  if (profile.displayName && addAlias(creatorId, profile.displayName, { kind: 'name', platform: feed && feed.platform, source: 'profile' })) out.aliases++;
  for (const h of bioAliases(profile.bio)) {
    if (addAlias(creatorId, h, { platform: feed && feed.platform, source: 'bio' })) out.aliases++;
    if (!feed || feed.kind !== 'user') continue;
    const owner = repo.creators.byAccount(feed.platform, h);
    if (owner && owner.id !== creatorId) noteLink(creatorId, owner.id, { type: 'bio-alias', from: creatorId, detail: `${feed.platform}:@${h}` }, { autoMerge: false });
    else if (!owner) out.accounts.push({ platform: feed.platform, kind: 'user', target: h, ingestable: true });
  }
  return out;
}

const LINKPAGE_HOSTS = /(^|\.)(linktr\.ee|allmylinks\.com|beacons\.ai|carrd\.co|campsite\.bio|solo\.to|bento\.me|direct\.me|milkshake\.app|msha\.ke|hoo\.be|snipfeed\.co|lnk\.bio|taplink\.cc|bio\.site|linkin\.bio|bio\.link|linkpop\.com|withkoji\.com|stan\.store|fans\.ly|fansly\.com|justfor\.fans|fanvue\.com|loyalfans\.com|fancentro\.com)$/i;

/** link-page or fan-page key from a creator's own profile link: host + first path segment. */
function pageKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const seg = (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    if (host.endsWith('carrd.co') && !seg) return host;
    if (!LINKPAGE_HOSTS.test(host) || seg.length < 3) return null;
    // a site page or asset on the host (justfor.fans/wallet-topup.php, /images) is not anybody's link page
    const { PATH_WORDS, FILE_EXT } = require('../lib/handle-words');
    if (FILE_EXT.test(seg) || PATH_WORDS.has(seg)) return null;
    return `${host}/${seg}`;
  } catch { return null; }
}

/**
 * Periodic pass (from discovery): keep aliases in step with followed accounts, and pair up creators who promote the
 * same paid page (OnlyFans, Fansly, JustFor.Fans) or the same link-in-bio page from their own profiles.
 * Pure SQL + JSON, a few ms per thousand creators.
 */
function scan() {
  const out = { aliases: 0, links: 0, merged: 0, handleCandidates: 0 };
  for (const f of db.prepare("SELECT creator_id, platform, target FROM feeds WHERE creator_id IS NOT NULL AND kind = 'user'").all()) {
    if (addAlias(f.creator_id, f.target, { platform: f.platform, source: 'account' })) out.aliases++;
  }
  const byKey = new Map();
  const note = (key, type, id) => { if (!byKey.has(key)) byKey.set(key, { type, ids: new Set() }); byKey.get(key).ids.add(id); };
  const notePaid = (service, handle, id) => {
    const h = String(handle || '').toLowerCase();
    if (!h) return;
    if (service === 'OnlyFans') note(`of:${h}`, 'same-onlyfans', id);
    else note(`paid:${service}:${h}`, 'same-paid', id);
  };
  for (const c of db.prepare("SELECT id, links, bio FROM creators WHERE status != 'blocked'").all()) {
    let links = []; try { links = JSON.parse(c.links || '[]'); } catch { links = []; }
    for (const l of links) {
      if (!l) continue;
      const svc = l.service || paid.serviceOf(l.url || '');
      const handle = l.handle || (svc ? paid.paidHandle(svc, l.url || '') : null);
      if (svc && paid.SERVICES[svc] && paid.SERVICES[svc].trace && handle) notePaid(svc, handle, c.id);
      const k = l.url && pageKey(l.url);
      if (k) note(`page:${k}`, 'same-linkpage', c.id);
    }
    for (const p of paid.findPaidHandles(c.bio).filter((p) => paid.SERVICES[p.service].trace)) notePaid(p.service, p.handle, c.id);
  }
  // Same handle on several creator rows (a man's accounts on different platforms, or two men with one name):
  // each pair is noted for the admin with the handle as evidence. Never merged here.
  const byHandle = db.prepare(`SELECT lower(handle) AS h, group_concat(id) AS ids, COUNT(*) AS n FROM creators
    WHERE status != 'blocked' AND handle != '' GROUP BY lower(handle) HAVING COUNT(*) > 1 AND COUNT(*) <= 10`).all();
  for (const { h, ids } of byHandle) {
    const list = ids.split(',');
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!repo.creators.get(list[i]) || !repo.creators.get(list[j])) continue;
        const r = noteLink(list[i], list[j], { type: 'same-handle', detail: h }, { autoMerge: false });
        if (r) out.handleCandidates = (out.handleCandidates || 0) + 1;
      }
    }
  }
  for (const [key, { type, ids }] of byKey) {
    if (ids.size < 2 || ids.size > 4) continue; // more than four creators on one page is an agency or a promo hub, not one man
    const list = [...ids];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!repo.creators.get(list[i]) || !repo.creators.get(list[j])) continue; // merged away earlier in this pass
        const r = noteLink(list[i], list[j], { type, detail: key.replace(/^(of|paid|page):/, '') });
        if (r) { out.links++; if (r.merged) out.merged++; }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ admin */

function parseLink(row) {
  if (!row) return null;
  let evidence = []; try { evidence = JSON.parse(row.evidence || '[]'); } catch { evidence = []; }
  const card = (id, label) => {
    const c = repo.creators.get(id);
    if (!c) return { id, handle: label || id, display_name: null, avatar_url: null, media_count: 0, status: 'merged', gone: true, aliases: [] }; // merged away
    return { id: c.id, handle: c.handle, display_name: c.display_name, avatar_url: c.avatar_url, media_count: c.media_count, status: c.status, aliases: aliasesOf(id).map((a) => a.alias).slice(0, 12) };
  };
  return { id: row.id, status: row.status, strength: row.strength, evidence, created_at: row.created_at, updated_at: row.updated_at, decided_by: row.decided_by, kept_id: row.kept_id,
    a: card(row.a_id, row.a_label), b: card(row.b_id, row.b_label), sameName: row.status === 'merged' ? true : sameName(row.a_id, row.b_id) };
}

function queue({ status = 'pending', page = 0, limit = 50 } = {}) {
  const st = ['pending', 'merged', 'rejected'].includes(status) ? status : 'pending';
  const total = db.prepare('SELECT COUNT(*) AS n FROM identity_links WHERE status = ?').get(st).n;
  const items = db.prepare(`SELECT * FROM identity_links WHERE status = ? ORDER BY ${st === 'pending' ? 'strength DESC, updated_at DESC' : 'updated_at DESC'} LIMIT ? OFFSET ?`).all(st, limit, page * limit).map(parseLink);
  return { items, total, page, limit };
}

/**
 * Creators that share a handle (case-insensitive), for the admin's "Same handle" queue. Read-only: no job calls it and it
 * never merges. Each group lists its creators (most posts first) and every pair still undecided, with whether an
 * automatic merge would be allowed (same-handle pairs never are: see mergeable) and which row a merge keeps (the one with
 * more posts, as merge() does; a tie keeps the first). Pairs already merged or marked "different people" are left out,
 * and a group with no undecided pair is not listed.
 */
function sameHandleGroups({ limit = 200 } = {}) {
  const groups = db.prepare(`SELECT lower(handle) AS h, COUNT(*) AS n FROM creators
    WHERE handle != '' GROUP BY lower(handle) HAVING COUNT(*) > 1 ORDER BY n DESC, h LIMIT ?`).all(Math.max(1, Math.min(1000, limit)));
  const members = db.prepare(`SELECT c.id, c.handle, c.display_name AS name, c.status, c.media_count AS mediaCount,
      (SELECT group_concat(DISTINCT f.platform) FROM feeds f WHERE f.creator_id = c.id) AS platforms
    FROM creators c WHERE lower(c.handle) = ? ORDER BY c.media_count DESC, c.id`);
  const out = [];
  for (const g of groups) {
    const list = members.all(g.h).map((c) => ({ ...c, mediaCount: c.mediaCount || 0, platforms: c.platforms ? c.platforms.split(',') : [] }));
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i]; const y = list[j];
        const link = q.link.get(...pair(x.id, y.id));
        if (link && link.status !== 'pending') continue; // merged, or "different people": decided
        const keep = (y.mediaCount || 0) > (x.mediaCount || 0) ? y : x;
        pairs.push({
          aId: x.id, bId: y.id, linkId: link ? link.id : null, linked: !!link,
          autoMergeAllowed: link ? mergeable(link) : false,
          keepId: keep.id, goneId: keep === x ? y.id : x.id,
        });
      }
    }
    if (pairs.length) out.push({ handle: g.h, creators: list, pairs });
  }
  return { groups: out, total: out.length };
}

/** "Different people" for two same-handle creators: recorded as a rejected identity link, so the pair stops coming back. */
function dismissSameHandle(aId, bId, actor = 'admin') {
  if (!aId || !bId || aId === bId || !sameHandle(aId, bId)) return false;
  const r = noteLink(aId, bId, { type: 'same-handle', detail: String(repo.creators.get(aId).handle).toLowerCase() }, { autoMerge: false });
  if (!r) return false;
  return r.status === 'rejected' || reject(r.id, actor);
}

function counts() {
  const o = { pending: 0, merged: 0, rejected: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM identity_links GROUP BY status').all()) o[r.status] = r.n;
  o.aliases = db.prepare('SELECT COUNT(*) AS n FROM creator_aliases').get().n;
  return o;
}

module.exports = { mergeRefusal, takedownFor, snapshots, unmerge, ensureSnapshots, sameHandleGroups, dismissSameHandle, addAlias, aliasesOf, removeAlias, findByAlias, bioAliases, noteLink, noteProfile, settle, merge, mergeCreators, reject, scan, queue, counts, pageKey, WEIGHTS, AUTO_STRENGTH };
