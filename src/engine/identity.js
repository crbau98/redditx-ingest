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
  admin: 10,
};
/** Auto-merge needs this much evidence AND a shared name; without the name it always waits for the admin. */
const AUTO_STRENGTH = 4;

const q = {
  // A name only his bio claimed ('bio') is promoted when an account, profile, merge or the admin confirms it.
  addAlias: db.prepare(`INSERT INTO creator_aliases (creator_id, norm, alias, kind, platform, source) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (creator_id, norm) DO UPDATE SET alias = excluded.alias, kind = excluded.kind, platform = COALESCE(excluded.platform, platform), source = excluded.source
    WHERE creator_aliases.source = 'bio' AND excluded.source != 'bio'`),
  aliasesOf: db.prepare('SELECT alias, norm, kind, platform, source, created_at FROM creator_aliases WHERE creator_id = ? ORDER BY kind, created_at'),
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

/** Record a name or handle for a creator. Returns true when it was new. */
function addAlias(creatorId, alias, { kind = 'handle', platform = null, source = 'account' } = {}) {
  const text = String(alias || '').trim().slice(0, 80);
  const norm = normAlias(text);
  if (!creatorId || !norm || norm.length < 2) return false;
  return q.addAlias.run(creatorId, norm, text, kind, platform, source).changes > 0;
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
 * @param {{type: string, from?: string, detail?: string}} ev
 * @returns {{id, strength, status, merged?: boolean}|null}
 */
function noteLink(x, y, ev, { autoMerge = true } = {}) {
  if (!x || !y || x === y || !WEIGHTS[ev.type]) return null;
  const [a, b] = pair(x, y);
  if (!repo.creators.get(a) || !repo.creators.get(b)) return null;
  let row = q.link.get(a, b);
  const item = { type: ev.type, from: ev.from || null, detail: ev.detail ? String(ev.detail).slice(0, 160) : null };
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
const mergeable = (row) => settingsStore.get().identityAutoMerge !== false && row.status === 'pending' && row.strength >= AUTO_STRENGTH
  && live(row.a_id) && live(row.b_id) && sameName(row.a_id, row.b_id);

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

/** Fold two linked creators into one: the one with more posts stays. */
function merge(linkId, { keepId = null, actor = 'admin' } = {}) {
  const row = q.linkById.get(linkId);
  if (!row || row.status !== 'pending') return null; // decided already: a "different people" verdict is never overridden from the queue
  const A = repo.creators.get(row.a_id); const B = repo.creators.get(row.b_id);
  if (!A || !B) return null;
  const keep = keepId === B.id || (!keepId && (B.media_count || 0) > (A.media_count || 0)) ? B : A;
  const gone = keep === A ? B : A;
  const out = mergeCreators(keep.id, gone.id, { actor, reason: `identity link #${row.id}`, linkId: row.id });
  return out;
}

/** Merge creator `goneId` into `keepId`, keeping both men's names as aliases. Used by the queue and the admin's Merge button. */
function mergeCreators(keepId, goneId, { actor = 'admin', reason = 'merge', linkId = null } = {}) {
  const keep = repo.creators.get(keepId); const gone = repo.creators.get(goneId);
  if (!keep || !gone || keepId === goneId) return null;
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
  addAlias(keepId, gone.handle, { kind: 'handle', source: 'merge' });
  if (gone.display_name) addAlias(keepId, gone.display_name, { kind: 'name', source: 'merge' });
  const out = repo.creators.merge(keepId, goneId);
  if (out) {
    repo.logAction('creator', keepId, 'merge', `${gone.handle} folded in (${reason})`, actor);
    events.log('INFO', `Merged creator ${gone.handle} into ${keep.handle} (${actor === 'identity' ? 'same accounts and name' : actor})`);
  }
  return out;
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

const LINKPAGE_HOSTS = /(^|\.)(linktr\.ee|allmylinks\.com|beacons\.ai|carrd\.co|solo\.to|lnk\.bio|bio\.site|linkin\.bio|hoo\.be|bio\.link|direct\.me|linkpop\.com|taplink\.cc|msha\.ke|fans\.ly|fansly\.com|justfor\.fans|fanvue\.com|loyalfans\.com|fancentro\.com)$/i;

/** link-page or fan-page key from a creator's own profile link: host + first path segment. */
function pageKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const seg = (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    if (host.endsWith('carrd.co') && !seg) return host;
    if (!LINKPAGE_HOSTS.test(host) || seg.length < 3) return null;
    return `${host}/${seg}`;
  } catch { return null; }
}

/**
 * Periodic pass (from discovery): keep aliases in step with followed accounts, and pair up creators who promote the
 * same paid page (OnlyFans, Fansly, JustFor.Fans) or the same link-in-bio page from their own profiles.
 * Pure SQL + JSON, a few ms per thousand creators.
 */
function scan() {
  const out = { aliases: 0, links: 0, merged: 0 };
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

function counts() {
  const o = { pending: 0, merged: 0, rejected: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM identity_links GROUP BY status').all()) o[r.status] = r.n;
  o.aliases = db.prepare('SELECT COUNT(*) AS n FROM creator_aliases').get().n;
  return o;
}

module.exports = { addAlias, aliasesOf, removeAlias, findByAlias, bioAliases, noteLink, noteProfile, settle, merge, mergeCreators, reject, scan, queue, counts, pageKey, WEIGHTS, AUTO_STRENGTH };
