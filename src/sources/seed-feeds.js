'use strict';
/**
 * Feeds for the curated creator seed (creators-seed.json), derived from what the seed already knows about each creator.
 *
 * The seed shipped one Coomer feed per creator and nothing else, so a fresh boot (and every deploy without a volume is a
 * fresh boot) ended with ~6 seeded items per creator and only Coomer behind them. Two problems:
 *
 *   1. 60 of the 125 Coomer targets were not OnlyFans handles at all but the creator's Bluesky handle or custom domain
 *      ("onlyfans/dannybaldwin.bsky.social"): Coomer has no such page, so the feed ran empty forever.
 *   2. The creator's other public accounts (Bluesky, RedGIFs, GayForFans, link-in-bio hubs, own site) were known from the seed's
 *      media and links but never followed.
 *
 * Pure: takes the parsed seed, returns feed specs. No database, no network.
 */
const { extractLinks } = require('../lib/links');

// Platforms/kinds a seeded creator's own links may add. Reddit/X user feeds are deliberately absent (403/429 on every transport).
const LINK_FEEDS = new Set(['gff/user', 'bluesky/user', 'linkinbio/page', 'web/page']);
const INTERVAL = { 'coomer/user': 240, 'bluesky/user': 180, 'redgifs/user': 240, 'gff/user': 360, 'linkinbio/page': 4320, 'web/page': 720 };

/** A handle that is really a Bluesky handle / domain (dot inside), which an OnlyFans or RedGIFs user name never is. */
const looksLikeDomain = (h) => /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(String(h || '')) && /\.(?:bsky\.social|com|net|org|xxx|me|co|io|tv|app|blue|social|xyz|ink|fans|club|ly)$/i.test(h);

/** The OnlyFans handle the creator's own links name, if any. */
function ofHandle(creator) {
  let links = [];
  try { links = JSON.parse(creator.links || '[]'); } catch { links = []; }
  const l = links.find((x) => x && x.service === 'OnlyFans' && x.handle);
  return l ? String(l.handle).toLowerCase() : null;
}

/**
 * @param {{creators:object[], feeds:object[], media:object[]}} seed
 * @returns {{platform:string, kind:string, target:string, label:string, creator_id:string, interval_min:number}[]}
 */
function deriveFeeds(seed) {
  const creators = new Map((seed.creators || []).map((c) => [c.id, c]));
  const out = [];
  const seen = new Set();
  const add = (platform, kind, target, creatorId, label) => {
    const t = String(target || '').trim();
    if (!t || !creators.has(creatorId)) return;
    if (require('../lib/deadhosts').deadReason(platform, t)) return; // gone or wrong-platform host: never seeded
    const key = `${platform}|${kind}|${t.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ platform, kind, target: t, label: label || null, creator_id: creatorId, interval_min: INTERVAL[`${platform}/${kind}`] || 240 });
  };

  // 1. Coomer pages: repair targets that carry a Bluesky handle / domain instead of the OnlyFans handle.
  for (const f of seed.feeds || []) {
    const c = creators.get(f.creator_id);
    if (!c) continue;
    if (f.platform === 'coomer' && f.kind === 'user') {
      const [service, handle] = String(f.target).split('/');
      if (looksLikeDomain(handle)) {
        const real = service === 'onlyfans' ? ofHandle(c) : null;
        if (real) add('coomer', 'user', `onlyfans/${real}`, c.id, `${c.display_name || c.handle} (onlyfans on Coomer)`);
        add('bluesky', 'user', handle, c.id, `${c.display_name || c.handle} (Bluesky)`);
        continue;
      }
    }
    add(f.platform, f.kind, f.target, c.id, f.label);
  }

  // 2. Accounts the seed's media came from (the media was read from them, so the account exists and has the content).
  for (const m of seed.media || []) {
    if (m.platform === 'bluesky' && m.author) add('bluesky', 'user', m.author, m.creator_id, `${(creators.get(m.creator_id) || {}).display_name || m.author} (Bluesky)`);
    else if (m.platform === 'redgifs' && m.author && !looksLikeDomain(m.author)) add('redgifs', 'user', m.author, m.creator_id, `${m.author} (RedGIFs)`);
  }

  // 3. Public pages the creator's own bio / links point at.
  for (const c of creators.values()) {
    let text = c.bio || '';
    try { for (const l of JSON.parse(c.links || '[]')) text += ` ${l.url || ''}`; } catch { /* no links */ }
    for (const spec of extractLinks(text)) {
      if (spec.external || spec.ingestable === false) continue;
      if (!LINK_FEEDS.has(`${spec.platform}/${spec.kind}`)) continue;
      add(spec.platform, spec.kind, spec.target, c.id, spec.label || null);
    }
  }
  return out;
}

module.exports = { deriveFeeds, looksLikeDomain, ofHandle };
