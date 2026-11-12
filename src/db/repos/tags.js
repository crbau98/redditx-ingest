'use strict';
/** Part of the data-access layer (src/db/repo.js). Moved here unchanged to keep repo.js readable. */

/** buildTagIntel: tag intelligence: related tags, topics and the query vocabulary. Built by repo.js; repo.js re-exports the result, so callers are unchanged. */
module.exports.buildTagIntel = function buildTagIntel({ db, cleanTag, PLATFORM_TAGS_SQL, library, relatedCache, media }) {
/* ----------------------------------------------------------- tag intelligence */
function topicStills(m) {
  const chain = [];
  for (const u of [m.thumb_url, m.preview_url, m.thumbnail_url, m.media_type === 'image' ? m.media_url : null]) {
    if (u && !chain.includes(u)) chain.push(u);
  }
  return chain;
}

const tagIntel = {
  /**
   * Tags that travel with the given ones: co-occurrence on published media, ranked by
   * how much more often they appear together than their overall frequency predicts.
   * `all` (default) measures against media carrying every given tag — the set a "narrow
   * with" refinement actually narrows; `all: false` uses media carrying any of them (topics).
   */
  related(names, limit = 12, { all = true } = {}) {
    const list = [...new Set((names || []).map(cleanTag).filter(Boolean))].slice(0, 4);
    if (!list.length) return [];
    const lib = library();
    // Co-occurrence over a big base set costs a few hundred ms; it only changes when the snapshot does.
    const key = `${list.join(',')}|${all ? 1 : 0}|${limit}`;
    const hit = relatedCache.get(key);
    if (hit && hit.lib === lib) return hit.value;
    const value = tagIntel.relatedUncached(list, limit, all, lib);
    if (relatedCache.size > 400) relatedCache.clear();
    relatedCache.set(key, { lib, value });
    return value;
  },
  relatedUncached(list, limit, all, lib) {
    const total = lib.total || 1;
    const marks = list.map(() => '?').join(',');
    // The base set (media that carry the listed tags, all of them or any) is found from the tag side: one tag's
    // posting list, probed by (media_id, tag_id) for the rest. No GROUP BY over every tag row of the base set.
    const tagIds = db.prepare(`SELECT id FROM tags WHERE name IN (${marks})`).all(...list).map((r) => r.id);
    if (!tagIds.length || (all && tagIds.length !== list.length)) return [];
    const idMarks = tagIds.map(() => '?').join(',');
    const baseIds = all
      ? db.prepare(`SELECT mt1.media_id AS media_id FROM media_tags mt1 JOIN media m ON m.id = mt1.media_id
          WHERE mt1.tag_id = ? AND m.publish_state = 'published' AND m.scope != 'excluded'
            AND (SELECT COUNT(*) FROM media_tags mt2 WHERE mt2.media_id = mt1.media_id AND mt2.tag_id IN (${idMarks})) = ?`)
        .all(tagIds[0], ...tagIds, tagIds.length).map((r) => r.media_id)
      : db.prepare(`SELECT DISTINCT mt.media_id AS media_id FROM media_tags mt JOIN media m ON m.id = mt.media_id
          WHERE mt.tag_id IN (${idMarks}) AND m.publish_state = 'published' AND m.scope != 'excluded'`)
        .all(...tagIds).map((r) => r.media_id);
    const base = baseIds.length;
    if (!base) return [];
    const rows = db.prepare(`SELECT t.name, COUNT(*) AS co
      FROM media_tags mt JOIN tags t ON t.id = mt.tag_id
      WHERE mt.media_id IN (SELECT value FROM json_each(?))
        AND t.name NOT IN (${marks}) AND t.name NOT IN (${PLATFORM_TAGS_SQL})
      GROUP BY t.id HAVING co >= 2`).all(JSON.stringify(baseIds), ...list);
    const communities = new Set(db.prepare("SELECT DISTINCT community FROM media WHERE community IS NOT NULL").all().map((r) => cleanTag(r.community)));
    return rows.filter((r) => !communities.has(r.name)).map((r) => {
      const lift = (r.co / base) / ((lib.tagCount.get(r.name) || r.co) / total);
      return { name: r.name, count: r.co, lift: Math.round(lift * 100) / 100, score: Math.log(1 + r.co) * Math.log(1 + lift) };
    }).filter((r) => r.lift > 1).sort((a, b) => b.score - a.score).slice(0, limit);
  },

  /**
   * Topics: the library's frequent tags grouped by how often they co-occur (cosine of
   * co-occurrence counts, greedy grouping around the most common tags). Each topic gets a
   * readable name from its two leading tags, a size and a few preview images.
   */
  topics({ maxTopics = 10, pool = 60, minCount = 3 } = {}) {
    const top = db.prepare(`SELECT t.id, t.name, COUNT(*) AS n FROM media_tags mt JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id
      WHERE m.publish_state = 'published' AND m.scope != 'excluded' AND t.name NOT IN (${PLATFORM_TAGS_SQL}) AND t.name NOT IN ('gay','nsfw','video','photo','image')
      GROUP BY t.id HAVING n >= ? ORDER BY n DESC LIMIT ?`).all(minCount, pool);
    if (top.length < 3) return [];
    // community names are tagged too — they say where, not what
    const communities = new Set(db.prepare("SELECT DISTINCT community FROM media WHERE community IS NOT NULL").all().map((r) => cleanTag(r.community)));
    const tags = top.filter((t) => !communities.has(t.name));
    const ids = tags.map((t) => t.id);
    const co = new Map();
    for (const r of db.prepare(`SELECT a.tag_id AS a, b.tag_id AS b, COUNT(*) AS n FROM media_tags a JOIN media_tags b ON a.media_id = b.media_id AND a.tag_id < b.tag_id
        JOIN media m ON m.id = a.media_id WHERE m.publish_state = 'published' AND m.scope != 'excluded' AND a.tag_id IN (${ids.map(() => '?').join(',')}) AND b.tag_id IN (${ids.map(() => '?').join(',')})
        GROUP BY a.tag_id, b.tag_id`).all(...ids, ...ids)) co.set(`${r.a}|${r.b}`, r.n);
    const count = new Map(tags.map((t) => [t.id, t.n]));
    const assoc = (x, y) => { const n = co.get(x < y ? `${x}|${y}` : `${y}|${x}`) || 0; return n / Math.sqrt(count.get(x) * count.get(y)); };
    const used = new Set(); const topics = [];
    for (const seed of tags) {
      if (used.has(seed.id) || topics.length >= maxTopics) continue;
      const members = tags.filter((t) => t.id !== seed.id && !used.has(t.id)).map((t) => ({ t, a: assoc(seed.id, t.id) }))
        .filter((x) => x.a >= 0.22).sort((p, q) => q.a - p.a).slice(0, 5).map((x) => x.t);
      if (!members.length) continue;
      used.add(seed.id); members.forEach((m) => used.add(m.id));
      const names = [seed.name, ...members.map((m) => m.name)];
      const title = `${seed.name[0].toUpperCase()}${seed.name.slice(1).replace(/-/g, ' ')} & ${members[0].name.replace(/-/g, ' ')}`;
      const list = media.list({ tagsAny: names, sort: 'top', limit: 4, noCount: true }).items;
      const total = media.list({ tagsAny: names, limit: 1 }).total;
      const stills = list.map(topicStills).filter((c) => c.length);
      topics.push({ id: names.slice(0, 3).join('+'), title, tags: names, count: total, previews: stills.map((c) => c[0]), previewFalls: stills.map((c) => c[1] || null) });
    }
    return topics.sort((a, b) => b.count - a.count);
  },

  /** Vocabulary for query understanding. */
  vocabulary() {
    return {
      tags: db.prepare(`SELECT t.name, COUNT(*) AS count FROM media_tags mt JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id
        WHERE m.publish_state = 'published' AND m.scope != 'excluded' AND t.name NOT IN (${PLATFORM_TAGS_SQL}) GROUP BY t.id ORDER BY count DESC LIMIT 3000`).all(),
      creators: db.prepare("SELECT id, handle, display_name, media_count FROM creators WHERE status = 'active' AND scope != 'excluded' AND media_count > 0 ORDER BY media_count DESC LIMIT 5000").all(),
      communities: db.prepare("SELECT community AS name, COUNT(*) AS count FROM media WHERE publish_state = 'published' AND scope != 'excluded' AND community IS NOT NULL AND community != '' GROUP BY community ORDER BY count DESC LIMIT 2000").all(),
    };
  },
};
  return { tagIntel };
};
