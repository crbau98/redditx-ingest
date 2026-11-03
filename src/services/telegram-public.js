'use strict';
/**
 * Telegram beyond the joined-channel list, for the account in TELEGRAM_SESSION. Everything here is deliberately slow and small:
 *
 *   upgradeSpec    a t.me link / handle the app would follow through the web preview (adult channels have none) is followed as an
 *                  MTProto `channel` feed by username instead, read WITHOUT joining. Needs the session AND the object store.
 *   lookupHandles  a creator someone searched for: his handles are looked up as public channel usernames (contacts.Search), and a
 *                  hashtag search finds channels that post about him. Only an exact username match backed by a second sign
 *                  (his own links name it, or the channel's description names him) is followed; the rest are returned as leads.
 *   joinApproved   joins, one at a time, channels from the admin's approved list; never anything else.
 *
 * Budgets: telegramSearchesPerDay (default 12), telegramJoinsPerDay (default 2, 2 h apart). The account never posts, sends or
 * edits anything. Telegram text is registered with lib/aiguard so no model ever sees it.
 */
const repo = require('../db/repo');
const settingsStore = require('../settings');
const events = require('../engine/events');
const mt = require('../lib/telegram-mtproto');
const store = require('../lib/objectstore');
const aiguard = require('../lib/aiguard');
const { extractLinks } = require('../lib/links');

const KEY = 'tg_budget';
const day = () => new Date().toISOString().slice(0, 10);
function budget() {
  let b = null; try { b = JSON.parse(repo.settings.get(KEY) || 'null'); } catch { b = null; }
  if (!b || b.day !== day()) b = { day: day(), searches: 0, joins: 0, lastJoinAt: b ? b.lastJoinAt || 0 : 0 };
  return b;
}
const save = (b) => { try { repo.settings.set(KEY, JSON.stringify(b)); } catch { /* best effort */ } };

/** Can channels be read by username right now? */
function ready(cfg = settingsStore.get()) {
  if (!cfg.telegramPublic) return false;
  if (!mt.configured().ok) return false;
  return !!store.kind();
}

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/** telegram/user (web preview) -> telegram/channel (MTProto, by username) when that can work; otherwise the spec unchanged. */
function upgradeSpec(spec) {
  if (!spec || spec.platform !== 'telegram' || spec.kind !== 'user' || !USERNAME.test(String(spec.target || ''))) return spec;
  if (/(?:_bot|bot)$/i.test(spec.target)) return spec;
  if (!ready()) return spec;
  return { ...spec, kind: 'channel', target: String(spec.target).replace(/^@/, '') };
}

/** Handles a creator is known by on other platforms (a Bluesky domain handle is reduced to its first label). */
function handlesOf(creator) {
  const set = new Set();
  const add = (h) => { const x = String(h || '').replace(/^@/, '').split('.')[0].replace(/[^A-Za-z0-9_]/g, ''); if (USERNAME.test(x)) set.add(x.toLowerCase()); };
  add(creator.handle);
  for (const f of repo.db.prepare("SELECT target FROM feeds WHERE creator_id = ? AND kind = 'user' AND platform != 'telegram'").all(creator.id)) add(f.target);
  return [...set].slice(0, 4);
}

function knownTelegramLinks(creator) {
  let links = creator.links;
  if (typeof links === 'string') { try { links = JSON.parse(links || '[]'); } catch { links = []; } }
  if (!Array.isArray(links)) links = [];
  const out = new Set();
  for (const l of links) for (const s of extractLinks(String(l.url || ''))) if (s.platform === 'telegram') out.add(String(s.target).toLowerCase());
  for (const s of extractLinks(String(creator.bio || ''))) if (s.platform === 'telegram') out.add(String(s.target).toLowerCase());
  return out;
}

/**
 * Does a channel's own text claim to be HIS page? Only an ownership phrase in the same sentence as his name/handle counts ("official
 * page of Rex Carter", "I'm @rexcarter", "my channel"), and any negation or fan-page wording anywhere in the text rules it out
 * ("not affiliated with @rex", "fake @rex", "fan page", "unofficial"). A bare mention of "@handle" proves nothing.
 */
const NEGATION = /\b(?:not|never|isn'?t|no)\b[^.!?\n]{0,30}\b(?:affiliated|official|him|his|related|connected|owned|run|managed|associated)\b|\b(?:un-?official|fake|fan[\s-]?(?:page|account|channel|club|made)|parody|impersonat\w*|tribute|copycat|scam|not\s+(?:the\s+)?real|no\s+relation)\b/i;
const OWNERSHIP_PHRASE = /\b(?:official(?:\s+(?:page|channel|account|telegram))?|my\s+(?:own\s+)?(?:official\s+)?(?:channel|page|account|telegram|content)|i(?:'m|\s+am)|this\s+is\s+(?:the\s+)?(?:official\s+)?(?:channel|page|account)\s+of|follow\s+me|dm\s+me|(?:channel|page|account)\s+of)\b/i;
function claimsOwnership(title, about, names) {
  const text = `${title || ''}. ${about || ''}`.toLowerCase();
  if (NEGATION.test(text)) return false;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wanted = [...new Set(names.map((n) => String(n || '').toLowerCase().replace(/^@/, '').trim()).filter((n) => n.length >= 4))];
  for (const sentence of text.split(/[.!?\n|·•]+/)) {
    if (!OWNERSHIP_PHRASE.test(sentence)) continue;
    if (wanted.some((n) => new RegExp(`(?<![a-z0-9_])${esc(n)}(?![a-z0-9_])`).test(sentence))) return true;
  }
  return false;
}

/**
 * Look a creator's handles up on Telegram. Auto-follows ONLY a channel that his own links name; the rest become leads (kept in
 * discovery state `tg.leads.<creator id>`). Returns { searched, followed:[username], leads:[{username,title,why}], skipped }.
 * One call per creator per 30 days unless `force`.
 */
async function lookupHandles(creatorId, { force = false } = {}) {
  const out = { searched: 0, followed: [], leads: [], skipped: null };
  const cfg = settingsStore.get();
  if (!ready(cfg)) { out.skipped = 'telegram not ready (session or object store missing, or switched off)'; return out; }
  const creator = repo.creators.get(creatorId);
  if (!creator || creator.status !== 'active') { out.skipped = 'creator not active'; return out; }
  const stamp = `tg.lookup.${creator.id}`;
  const last = new Date(repo.discoveryState.get(stamp, '') || 0).getTime();
  if (!force && Date.now() - last < 30 * 86400000) { out.skipped = 'looked up in the last 30 days'; return out; }
  const linked = knownTelegramLinks(creator);
  const names = [creator.display_name, ...handlesOf(creator)].filter(Boolean).map((x) => String(x).toLowerCase());
  for (const handle of handlesOf(creator)) {
    const b = budget();
    if (b.searches >= cfg.telegramSearchesPerDay) { out.skipped = 'daily Telegram search budget used'; break; }
    b.searches++; save(b); out.searched++;
    let found = [];
    try { found = await mt.searchChannels(handle, { limit: 6 }); } catch (e) { events.log('WARN', `Telegram lookup "${handle}": ${e.message}`); if (e.retryAfter || e.skip) break; continue; }
    for (const ch of found) {
      if (String(ch.username).toLowerCase() !== handle) continue; // exact username only
      let about = '';
      try { const p = await mt.profile(ch.username, { avatar: false }); about = String(p.about || ''); aiguard.mark([p.title, p.about]); } catch { /* the title alone then */ }
      const text = `${ch.title} ${about}`.toLowerCase();
      // The channel controls its own title and description, so they prove nothing about who runs it (an impersonator writes "official
      // page of ..."). Only HIS OWN links naming the channel make it his; every other exact-username hit is a lead for an admin.
      if (!linked.has(String(ch.username).toLowerCase())) {
        out.leads.push({ username: ch.username, title: ch.title, claimsOwnership: claimsOwnership(ch.title, about, [handle, ...names]), why: 'exact username, but none of his own links names this channel' });
        continue;
      }
      const r = require('./targets').addSpec({ platform: 'telegram', kind: 'channel', target: ch.username, label: ch.title, ingestable: true }, { creatorId: creator.id, origin: 'discovered', trusted: 0 });
      if (r.status === 'created' || r.status === 'exists') out.followed.push(ch.username);
    }
  }
  // Channels that post a hashtag of his handle (not joined): leads only, never followed on this evidence alone
  const b2 = budget();
  const tag = handlesOf(creator)[0];
  if (tag && b2.searches < cfg.telegramSearchesPerDay && !out.skipped) {
    b2.searches++; save(b2); out.searched++;
    try { for (const h of await mt.searchPosts(tag, { limit: 30 })) if (!out.followed.includes(h.username)) out.leads.push({ username: h.username, title: h.title, why: `${h.hits} post(s) with #${tag}` }); } catch (e) { events.log('WARN', `Telegram hashtag "${tag}": ${e.message}`); }
  }
  repo.discoveryState.set(stamp, new Date().toISOString());
  if (out.leads.length) repo.discoveryState.set(`tg.leads.${creator.id}`, JSON.stringify(out.leads.slice(0, 20))); // for an admin to review
  events.log('INFO', `Telegram lookup for ${creator.display_name || creator.handle}: ${out.searched} search(es), followed ${out.followed.length}, ${out.leads.length} lead(s)`);
  return out;
}

/** Fire and forget: a creator was just followed on request (lookup / admin). Never throws, never blocks the caller. */
function queueLookup(creatorId) {
  if (!ready()) return;
  setTimeout(() => { lookupHandles(creatorId).catch((e) => events.log('WARN', `Telegram lookup: ${e.message}`)); }, 5000).unref();
}

/** Join at most one channel from the approved list per call, within the daily cap and the 2 h spacing. */
async function joinApproved() {
  const cfg = settingsStore.get();
  if (!mt.configured().ok) return { joined: null, reason: 'not configured' };
  const approved = String(cfg.telegramApprovedJoins || '').split('\n').map((l) => l.trim().replace(/^@|^https?:\/\/t\.me\//i, '').replace(/\/+$/, '')).filter((u) => USERNAME.test(u));
  if (!approved.length) return { joined: null, reason: 'approved list is empty' };
  const b = budget();
  if (b.joins >= cfg.telegramJoinsPerDay) return { joined: null, reason: 'daily join cap reached' };
  if (Date.now() - (b.lastJoinAt || 0) < 2 * 3600 * 1000) return { joined: null, reason: 'last join less than 2 h ago' };
  const dialogs = new Set((await mt.dialogs()).map((d) => String(d.username || '').toLowerCase()));
  const next = approved.find((u) => !dialogs.has(u.toLowerCase()));
  if (!next) return { joined: null, reason: 'already a member of every approved channel' };
  b.joins++; b.lastJoinAt = Date.now(); save(b);
  const r = await mt.joinChannel(next);
  events.log('OK', `Telegram: joined approved channel @${next}`);
  try { await require('./telegram-sync').sync(); } catch { /* the next scheduled sync picks it up */ }
  return { joined: r.username || next };
}

function status() { const b = budget(); const cfg = settingsStore.get(); return { ready: ready(cfg), searchesToday: b.searches, searchesPerDay: cfg.telegramSearchesPerDay, joinsToday: b.joins, joinsPerDay: cfg.telegramJoinsPerDay }; }

module.exports = { claimsOwnership, ready, upgradeSpec, lookupHandles, queueLookup, joinApproved, handlesOf, status };
