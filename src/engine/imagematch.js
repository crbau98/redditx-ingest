'use strict';
/**
 * Cross-web content & identity discovery (Phase 2 & 3).
 *
 * 1. Same-picture matching (pHash within dedupeDistance): finds where a creator's published photos or
 *    video keyframes appear across the public web; adds alt-sources and registers pages that name him.
 * 2. Opt-in local face matching (settings.faceMatch, off by default): uses local FaceRes descriptors
 *    via lib/face-match. High face confidence + page names him -> registers source; face match without
 *    text proof -> queued in creator_web_matches ('review') for Admin triage, never auto-attributed.
 * 3. Seeded public web crawling (settings.creatorSeedCrawl): crawls public profile links, link hubs,
 *    and search hits for the creator's handle + paid slug + tags within feed caps and safety gates.
 */
const repo = require('../db/repo');
const config = require('../config');
const settingsStore = require('../settings');
const brave = require('../lib/brave');
const imagefilter = require('../lib/imagefilter');
const phash = require('../lib/phash');
const takedowns = require('../lib/takedowns');
const events = require('./events');
const faceMatch = require('../lib/face-match');
const { hostBlocked } = require('../lib/mediaurl');
const { parseProfile, extractLinks } = require('../lib/links');
const { checkText } = require('../lib/safety');
const { femaleCheck } = require('../lib/scope');

const db = repo.db;

/**
 * A paid page is a public page too (owner decision 2026-11-05): register it as a web/page feed so
 * its public media is read, instead of dropping the match because the page is a paid link-out.
 * @returns {boolean} true when the URL was a paid service page.
 */
function readPaidPage(url, creatorId, origin) {
  if (!require('../lib/paid').serviceOf(url)) return false;
  try { require('./paidpage').registerPaidPage(url, { creatorId, origin }); }
  catch (e) { events.log('WARN', `Could not register the paid page ${url}: ${e.message}`); }
  return true;
}

const REF_PICTURES = 8;
const HITS_PER_QUERY = 16;
const PAGES_PER_CREATOR = 4;
const STALE_DAYS = 14;

/** His reference pictures: recent published ones with a hash. */
function reference(creatorId) {
  const rows = db.prepare(`SELECT m.id, m.phash FROM media m
    WHERE m.creator_id = ? AND m.phash IS NOT NULL AND m.publish_state = 'published'
    ORDER BY COALESCE(m.posted_at, m.ingested_at) DESC LIMIT ?`).all(creatorId, REF_PICTURES);
  return rows.map((r) => ({ mediaId: r.id, phash: r.phash }));
}

/** Is one web picture the very same picture as one of his? {same: bool, mediaId?, distance?} (pHash within the dedupe distance) */
function scoreHit(hit, refs, { distance }) {
  let bestSame = null;
  for (const r of refs) {
    if (hit.phash && r.phash) {
      const d = phash.hamming(hit.phash, r.phash);
      if (d <= distance && (!bestSame || d < bestSame.d)) bestSame = { d, mediaId: r.mediaId };
    }
  }
  return { same: !!bestSame, mediaId: bestSame ? bestSame.mediaId : null, distance: bestSame ? bestSame.d : null };
}

/** Does the result page itself name him? (required before a page becomes his feed) */
function namesCreator(hit, creator, ...handles) {
  const blob = `${hit.title || ''} ${hit.description || ''} ${(hit.url || '').replace(/[-_/]+/g, ' ')}`;
  const aliases = Array.isArray(creator.aliases) ? creator.aliases.map((a) => (typeof a === 'string' ? a : a && a.alias)) : [];
  const texts = [creator.display_name, creator.handle, ...aliases, ...handles].filter(Boolean);
  if (texts.some((t) => t && blob.toLowerCase().includes(String(t).toLowerCase()))) return true;
  return false;
}

/** Build richer query set for a creator: name + handle + paid slug + top style tags. */
function buildQueries(creator, { service = null, paidHandle = null } = {}) {
  const name = creator.display_name || creator.handle;
  const queries = [`"${name}" onlyfans`];
  if (paidHandle && paidHandle !== name) queries.push(`"${paidHandle}" ${service || 'onlyfans'}`);
  if (creator.handle && creator.handle !== name) queries.push(`"${creator.handle}" onlyfans`);
  if (creator.handle && creator.display_name && creator.handle.toLowerCase() !== creator.display_name.toLowerCase()) {
    queries.push(`"${creator.display_name}" "${creator.handle}"`);
  }
  try {
    const tagRows = db.prepare(`SELECT t.name FROM media_tags mt JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id
      WHERE m.creator_id = ? AND m.publish_state = 'published'
      GROUP BY t.id ORDER BY COUNT(*) DESC LIMIT 4`).all(creator.id);
    const style = tagRows.map((r) => r.name).filter((t) => !['gay', 'nsfw', 'reddit', 'bluesky', 'x', 'telegram', 'redgifs', 'web'].includes(t));
    if (style.length) queries.push(`"${name}" ${style.slice(0, 2).join(' ')}`);
  } catch { /* optional tag enrichment */ }
  return [...new Set(queries)];
}

/** Seeded crawl from a creator's stored public links and bios to discover new public pages/accounts. */
async function seedCrawlCreator(creator, { maxPages = 2 } = {}) {
  const out = { crawled: 0, discovered: 0 };
  if (!creator || !creator.id) return out;
  let links = [];
  try { links = Array.isArray(creator.links) ? creator.links : JSON.parse(creator.links || '[]'); } catch { links = []; }
  if (creator.bio) {
    try { links.push(...extractLinks(creator.bio)); } catch { /* ignore */ }
  }
  const existing = new Set(repo.feeds.list({ creatorId: creator.id, limit: 500 }).items.map((f) => String(f.target).toLowerCase()));
  for (const l of links.slice(0, 8)) {
    if (out.discovered >= maxPages) break;
    const url = l && (l.url || (typeof l === 'string' ? l : null));
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (takedowns.checkUrl(url)) continue;
    let host;
    try { host = new URL(url).hostname; } catch { continue; }
    if (hostBlocked(host)) continue;
    const spec = parseProfile(url);
    if (!spec) continue;
    if (spec.external || !spec.ingestable) {
      // A paid page is a public page too: read it instead of dropping the match.
      if (spec.external) readPaidPage(url, creator.id, 'image-match-crawl');
      continue;
    }
    if (existing.has(String(spec.target).toLowerCase())) continue;
    if (checkText(url, spec.target, spec.label).level === 'block') continue;
    if (femaleCheck(spec.target, spec.label).female) continue;
    if (spec.platform === 'web') {
      try { if (!(await require('../sources/web').robotsAllows(url))) continue; } catch { continue; }
    }
    out.crawled++;
    const r = require('../services/targets').addSpec(spec, { creatorId: creator.id, origin: 'discovered', trusted: true });
    if (r && r.status === 'created') {
      out.discovered++;
      existing.add(String(spec.target).toLowerCase());
      faceMatch.recordWebMatch({
        creatorId: creator.id,
        pageUrl: url,
        title: spec.label || host,
        platform: spec.platform,
        matchKind: 'seed_crawl',
        evidence: `linked from @${creator.handle}'s profile/bio`,
        status: 'confirmed',
      });
    }
  }
  return out;
}

/**
 * One creator: search, read the candidate pictures (and video keyframes), register the pages his content appears on.
 * @returns {Promise<{checked:number, matched:number, pages:number, pictures:number}>}
 */
async function matchCreator(creator, { budget = 40, aborted = () => false, service = null, paidHandle = null } = {}) {
  const out = { checked: 0, matched: 0, pages: 0, pictures: 0 };
  const refs = reference(creator.id);
  const s = settingsStore.get();
  const useFaces = !!s.faceMatch;
  const faceRefs = useFaces ? faceMatch.creatorReferenceFaces(creator.id) : [];
  if (!refs.length && !faceRefs.length) return out;

  const distance = s.dedupeDistance == null ? 6 : s.dedupeDistance;
  const queries = buildQueries(creator, { service, paidHandle });

  const existing = new Set(repo.feeds.list({ platform: 'web', creatorId: creator.id, limit: 500 }).items.map((f) => String(f.target).toLowerCase()));
  const seenPages = new Set();

  for (const q of queries.slice(0, 4)) {
    if (aborted() || out.pages >= PAGES_PER_CREATOR) break;
    let hits = [];
    try {
      hits = await brave.images(q, { count: HITS_PER_QUERY, budget, preferKeyless: true });
    } catch (e) {
      if (e && (e.skip || e.budget)) break;
      events.log('WARN', `Image match: "${q}" — ${e.message}`);
      continue;
    }
    for (const hit of hits) {
      if (aborted() || out.checked >= HITS_PER_QUERY || out.pages >= PAGES_PER_CREATOR) break;
      const pageUrl = hit.pageUrl || hit.url;
      const isVid = hit.mediaType === 'video' || hit.type === 'video' || /\.(mp4|webm|mov|m3u8)(\?|#|$)/i.test(hit.mediaUrl || '');
      const img = hit.imageUrl
        || (hit.mediaUrl && /\.(jpe?g|png|gif|webp|avif)(\?|#|$)/i.test(hit.mediaUrl) ? hit.mediaUrl : null)
        || hit.thumbnailUrl
        || (isVid ? imagefilter.deriveVideoPosterUrl(hit.mediaUrl || pageUrl) : null);
      if (!img || !pageUrl) continue;
      if (takedowns.checkUrl(pageUrl) || takedowns.checkUrl(img)) continue;
      let parsedUrl;
      try { parsedUrl = new URL(pageUrl); } catch { continue; }
      if (hostBlocked(parsedUrl.hostname)) continue;
      if (checkText(hit.title, hit.description, pageUrl).level === 'block') continue;
      if (femaleCheck(hit.title, hit.description).female) continue;
      const key = String(pageUrl).toLowerCase();
      if (seenPages.has(key) || existing.has(key)) continue;
      seenPages.add(key);
      out.checked++;

      const res = await imagefilter.analyze(img, { faces: useFaces, hash: true, timeout: 10000 });
      if (!res || res.status !== 'ok') continue;
      if (useFaces && Array.isArray(res.faces) && imagefilter.judge(res).female) continue;

      const named = namesCreator(hit, creator, paidHandle);
      const verdict = res.phash && refs.length ? scoreHit({ phash: res.phash }, refs, { distance }) : { same: false };

      if (verdict.same) {
        if (verdict.mediaId) {
          try { repo.media.addAltSource(verdict.mediaId, { platform: 'web', source_url: pageUrl, author: creator.handle || null }); out.pictures++; } catch { /* best effort */ }
        }
        faceMatch.recordWebMatch({
          creatorId: creator.id,
          mediaId: verdict.mediaId,
          pageUrl,
          imageUrl: img,
          title: hit.title || parsedUrl.host,
          platform: 'web',
          matchKind: isVid ? 'video_keyframe' : 'phash',
          phashDistance: verdict.distance,
          evidence: named
            ? `same ${isVid ? 'video keyframe' : 'picture'} (${verdict.distance} bits), page names him`
            : `same ${isVid ? 'video keyframe' : 'picture'} (${verdict.distance} bits) reposted`,
          status: named ? 'confirmed' : 'review',
        });
        if (!named) continue;
        const spec = parseProfile(pageUrl) || { platform: 'web', kind: 'page', target: pageUrl, ingestable: true, label: parsedUrl.host };
        if (spec.external) { readPaidPage(pageUrl, creator.id, 'image-match'); continue; }
        if (spec.platform === 'web') {
          try { if (!(await require('../sources/web').robotsAllows(pageUrl))) continue; } catch { continue; }
        }
        const r = require('../services/targets').addSpec(spec, { creatorId: creator.id, origin: 'discovered', trusted: true });
        if (r.status === 'created') {
          out.pages++;
          repo.logAction('creator', creator.id, 'image-match',
            `same picture (${verdict.distance} bits), page names him → ${pageUrl}`, 'discovery');
        }
        out.matched++;
        continue;
      }

      // Opt-in local face matching when pHash did not match
      if (useFaces && faceRefs.length && Array.isArray(res.faces) && res.faces.length) {
        const fv = faceMatch.evaluateCreatorFaceMatch(res.faces, creator.id, { named, refs: faceRefs });
        if (fv.verdict === 'confirmed') {
          const spec = parseProfile(pageUrl) || { platform: 'web', kind: 'page', target: pageUrl, ingestable: true, label: parsedUrl.host };
          if (spec.external) { readPaidPage(pageUrl, creator.id, 'image-match'); continue; }
          if (spec.platform === 'web') {
            try { if (!(await require('../sources/web').robotsAllows(pageUrl))) continue; } catch { continue; }
          }
          faceMatch.recordWebMatch({
            creatorId: creator.id,
            mediaId: fv.refMediaId,
            pageUrl,
            imageUrl: img,
            title: hit.title || parsedUrl.host,
            platform: spec.platform || 'web',
            matchKind: 'face+text',
            score: fv.score,
            evidence: fv.reason,
            status: 'confirmed',
          });
          const r = require('../services/targets').addSpec(spec, { creatorId: creator.id, origin: 'discovered', trusted: true });
          if (r.status === 'created') {
            out.pages++;
            repo.logAction('creator', creator.id, 'face-match', `${fv.reason} → ${pageUrl}`, 'discovery');
          }
          out.matched++;
        } else if (fv.verdict === 'review') {
          faceMatch.recordWebMatch({
            creatorId: creator.id,
            mediaId: fv.refMediaId,
            pageUrl,
            imageUrl: img,
            title: hit.title || parsedUrl.host,
            platform: 'web',
            matchKind: 'face_review',
            score: fv.score,
            evidence: fv.reason,
            status: 'review',
          });
        }
      }
    }
  }
  // Reverse-image mirror candidates (Yandex's "sites" list for one of his public pictures). Review-queue rows only: a page that
  // shows the same picture is a candidate for a human, never an automatic match. At most one lookup per creator per run.
  try {
    const yx = require('../lib/yandex');
    if (config.yandexImages && refs.length) {
      const ref = db.prepare(`SELECT id, media_url FROM media WHERE creator_id = ? AND publish_state = 'published'
        AND media_url LIKE 'http%' AND media_url NOT LIKE '%' || ? || '%' ORDER BY COALESCE(posted_at, ingested_at) DESC LIMIT 1`)
        .get(creator.id, config.storeHost);
      if (ref && ref.media_url) {
        const sites = await yx.cbirSites(ref.media_url, { count: 20 });
        for (const site of sites) {
          if (takedowns.checkUrl(site.pageUrl)) continue;
          const paidPage = require('../engine/paidpage').paidPageUrl(site.pageUrl);
          if (paidPage) require('../engine/paidpage').registerPaidPage(site.pageUrl, { creatorId: creator.id, origin: 'cbir' });
          faceMatch.recordWebMatch({
            creatorId: creator.id,
            mediaId: ref.id,
            pageUrl: site.pageUrl,
            imageUrl: null,
            title: site.title || site.source,
            platform: 'web',
            matchKind: 'cbir',
            evidence: 'Yandex reverse-image: the same picture appears on this page (review before any link)',
            status: 'review',
          });
          out.pages++;
        }
      }
    }
  } catch (e) {
    events.log('WARN', `Reverse-image lookup skipped for creator ${creator.id}: ${e.message}`);
  }
  try {
    db.prepare("UPDATE creators SET last_monitored_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(creator.id);
  } catch { /* ignore if column not migrated yet */ }
  return out;
}

/** Creators whose pictures exist and who have not been matched recently (newest first). */
function pickCreators(limit) {
  const stale = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();
  return db.prepare(`SELECT c.id FROM creators c
    WHERE c.status = 'active' AND c.scope IN ('in','uncertain')
      AND (SELECT COUNT(*) FROM media m WHERE m.creator_id = c.id AND m.phash IS NOT NULL AND m.publish_state = 'published') >= 2
      AND COALESCE((SELECT updated_at FROM discovery_state WHERE key = 'imgmatch.' || c.id), '') < ?
    GROUP BY c.id
    ORDER BY
      CASE WHEN EXISTS (SELECT 1 FROM onlyfans_leads l WHERE l.creator_id = c.id AND l.status = 'claimed') THEN 0
           WHEN c.links IS NOT NULL AND c.links != '[]' AND c.links != '' THEN 1
           WHEN c.origin != 'ingest' THEN 2 ELSE 3 END,
      (SELECT COUNT(*) FROM media m WHERE m.creator_id = c.id AND m.phash IS NOT NULL AND m.publish_state = 'published') DESC
    LIMIT ?`).all(stale, limit)
    .map((r) => repo.creators.get(r.id)).filter(Boolean);
}

/**
 * The discovery pass. Registers `limit` creators (imageMatchPerRun).
 * @returns {Promise<{creators:number, matched:number, pages:number, pictures:number, error?:string}>}
 */
async function run({ limit, aborted = () => false, budget = 40 } = {}) {
  const s = settingsStore.get();
  const max = limit == null ? (s.imageMatchPerRun || 4) : limit;
  const out = { creators: 0, matched: 0, pages: 0, pictures: 0 };
  if (!s.imageMatch || max <= 0) return out;
  if (!imagefilter.available()) return { ...out, error: 'image model unavailable' };
  for (const creator of pickCreators(Math.max(1, max))) {
    if (aborted() || out.creators >= max) break;
    const of = require('../lib/onlyfans').creatorOnlyFans(creator);
    let service = null; let paidHandle = null;
    if (of) { service = 'onlyfans'; paidHandle = of.handle; }
    else {
      const p = require('../lib/paid').creatorPaid(creator)[0];
      if (p) { service = p.service; paidHandle = p.handle; }
    }
    try {
      if (s.creatorSeedCrawl) await seedCrawlCreator(creator, { maxPages: 2 });
      const r = await matchCreator(creator, { budget, aborted, service, paidHandle });
      out.creators++;
      out.matched += r.matched;
      out.pages += r.pages;
      out.pictures += r.pictures;
      if (r.pages) events.log('OK', `Image match: ${creator.display_name || creator.handle} — ${r.pages} page(s) of his registered${r.pictures ? `, ${r.pictures} picture(s) already stored found elsewhere` : ''}`);
    } catch (e) {
      events.log('WARN', `Image match: ${creator.display_name || creator.handle} — ${e.message}`);
    }
    repo.discoveryState.set(`imgmatch.${creator.id}`, new Date().toISOString());
  }
  return out;
}

module.exports = { run, matchCreator, reference, scoreHit, namesCreator, pickCreators, buildQueries, seedCrawlCreator };
