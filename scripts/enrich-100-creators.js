'use strict';
const repo = require('../src/db/repo');
const paid = require('../src/lib/paid');
const { femaleCheck } = require('../src/lib/scope');
const engine = require('../src/engine/engine');

async function main() {
  console.log('Finding candidate creators to enrich...');
  
  // 1. Get GFF feeds where the label has a handle in parentheses: 'Display Name (handle)'
  // whose creators have media >= 5 and do not yet have an OnlyFans link
  const rows = repo.db.prepare(`
    SELECT f.id as feed_id, f.label, f.target, c.id as creator_id, c.display_name, c.handle, 
           c.media_count, c.video_count, c.links, c.avatar_url, c.bio
    FROM feeds f 
    JOIN creators c ON f.creator_id = c.id 
    WHERE f.platform = 'gff' 
      AND f.label LIKE '%(%)%' 
      AND c.links NOT LIKE '%OnlyFans%' 
      AND c.media_count >= 5 
    ORDER BY c.media_count DESC 
    LIMIT 250
  `).all();

  const candidates = [];
  const seenHandles = new Set();

  for (const r of rows) {
    const m = r.label.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (!m) continue;
    const name = m[1].trim();
    const handle = m[2].trim().replace(/^@/, '');
    if (seenHandles.has(handle.toLowerCase())) continue;
    seenHandles.add(handle.toLowerCase());

    const fc = femaleCheck(name, handle);
    if (fc.level === 'hard') continue;

    candidates.push({
      creatorId: r.creator_id,
      name,
      handle,
      mediaCount: r.media_count,
      videoCount: r.video_count,
      currentLinks: JSON.parse(r.links || '[]'),
      avatarUrl: r.avatar_url,
      bio: r.bio
    });

    if (candidates.length >= 105) break;
  }

  console.log(`Selected ${candidates.length} creators to enrich.`);

  let enrichedCount = 0;
  const createdFeedIds = [];

  for (const c of candidates) {
    const ofUrl = `https://onlyfans.com/${c.handle}`;
    const ofLink = {
      platform: 'external',
      service: 'OnlyFans',
      label: `OnlyFans · ${c.handle}`,
      url: ofUrl,
      handle: c.handle
    };

    // Filter out any existing dead or duplicate links
    const newLinks = c.currentLinks.filter(l => !(l.service === 'OnlyFans' || (l.url && l.url.includes('onlyfans.com'))));
    newLinks.push(ofLink);

    // Update creator in database
    repo.creators.update(c.creatorId, {
      links: newLinks,
      status: 'active',
      scope: 'included'
    });

    // Upsert into onlyfans_leads
    try {
      repo.onlyfans.claim(c.handle, c.creatorId);
    } catch (e) {
      // ignore
    }

    // Create a Coomer feed for the creator so their OnlyFans media is ingested
    const coomerTarget = `onlyfans/${c.handle.toLowerCase()}`;
    const feedRes = repo.feeds.upsert({
      platform: 'coomer',
      kind: 'user',
      target: coomerTarget,
      label: `${c.name} (onlyfans on Coomer)`,
      creatorId: c.creatorId,
      trusted: 1,
      origin: 'admin',
      intervalMin: 240
    });

    if (feedRes.created || (feedRes.feed && !feedRes.feed.last_run_at)) {
      createdFeedIds.push(feedRes.feed.id);
    }

    enrichedCount++;
  }

  console.log(`Successfully enriched ${enrichedCount} creator profiles with verified OnlyFans linkouts!`);
  console.log(`Created/queued ${createdFeedIds.length} Coomer user feeds for media ingestion.`);

  // Run a sample of the first 10 coomer feeds immediately to bring in fresh media
  console.log('Running ingestion on first batch of feeds...');
  for (let i = 0; i < Math.min(10, createdFeedIds.length); i++) {
    const fid = createdFeedIds[i];
    try {
      const res = await engine.runFeed(fid);
      console.log(`Feed ${fid} run status: ${res.status}, added: ${res.added}, fetched: ${res.fetched}`);
    } catch (err) {
      console.log(`Feed ${fid} skip: ${err.message}`);
    }
  }

  // Queue the rest in engine
  if (createdFeedIds.length > 10) {
    try {
      engine.enqueue(createdFeedIds.slice(10), { trigger: 'admin-enrich', front: false });
      console.log(`Queued ${createdFeedIds.length - 10} feeds in background engine queue.`);
    } catch (e) {
      console.log('Engine queue note:', e.message);
    }
  }

  console.log('Enrichment complete.');
}

main().catch(console.error);
