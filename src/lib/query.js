'use strict';
/**
 * Query understanding: turn what people type ("hairy beard guys at the beach, videos
 * this week", "@jules gym pics", "best bear clips on reddit") into structured filters,
 * using the library's own vocabulary — its tags, creators, communities and sources —
 * plus synonyms, singular/plural folding and typo correction. Words that match nothing
 * stay as free text for full-text search. Pure function of (text, vocabulary).
 */

const TYPE = {
  video: ['video', 'videos', 'vid', 'vids', 'clip', 'clips', 'gif', 'gifs', 'movie', 'movies', 'reel', 'reels', 'footage'],
  image: ['photo', 'photos', 'pic', 'pics', 'picture', 'pictures', 'image', 'images', 'shot', 'shots', 'still', 'stills'],
};
const SORT = {
  recent: ['new', 'newest', 'latest', 'recent', 'fresh', 'freshest'],
  top: ['best', 'top', 'highest', 'greatest', 'favorite', 'favourite', 'favorites', 'favourites'],
  trending: ['trending', 'popular', 'viral', 'buzzing'],
  random: ['random', 'shuffle', 'shuffled', 'surprise'],
  oldest: ['oldest', 'earliest'],
};
const SINCE = {
  day: ['today', 'tonight', '24h', 'day', 'daily'],
  week: ['week', 'weekly', '7d', 'weekend'],
  month: ['month', 'monthly', '30d'],
  year: ['year', 'yearly', '12m'],
};
const PLATFORM_WORDS = {
  reddit: ['reddit', 'subreddit', 'subreddits'], redgifs: ['redgifs', 'redgif'], bluesky: ['bluesky', 'bsky'],
  mastodon: ['mastodon', 'fediverse', 'toots'], misskey: ['misskey', 'sharkey'], tumblr: ['tumblr'], peertube: ['peertube'], lemmy: ['lemmy'],
  x: ['twitter', 'tweets', 'tweet', 'x.com'], telegram: ['telegram', 'tg'], rss: ['rss', 'blog', 'blogs'],
};
// Words that carry no filtering meaning in this app (everything here is about men).
const STOP = new Set(['a', 'an', 'the', 'of', 'with', 'and', 'or', 'in', 'on', 'at', 'for', 'from', 'by', 'to', 'into', 'show', 'me', 'find',
  'get', 'give', 'some', 'any', 'all', 'more', 'most', 'this', 'that', 'these', 'past', 'last', 'posts', 'post', 'content', 'stuff', 'please', 'pls',
  'guys', 'guy', 'men', 'man', 'dudes', 'dude', 'male', 'males', 'gay', 'hot', 'sexy', 'nsfw', 'only', 'just', 'like', 'who', 'are', 'is', 'being', 'having',
  'i', 'want', 'see', 'look', 'looking', 'something', 'anything', 'his', 'their', 'them', 'of']);

// Descriptive forms people type for things the library tags by noun.
const ALIAS = {
  bearded: 'beard', beards: 'beard', muscular: 'muscle', muscled: 'muscle', muscly: 'muscle', buff: 'muscle', ripped: 'abs', shredded: 'abs', sixpack: 'abs',
  tattooed: 'tattoo', tatted: 'tattoo', inked: 'tattoo', tats: 'tattoo', showering: 'shower', showers: 'shower', swimming: 'swim', swimmer: 'swim', swimmers: 'swim',
  hairy: 'hairy', furry: 'hairy', jocks: 'jock', jockstrap: 'jockstrap', jockstraps: 'jockstrap', outdoor: 'outdoors', outside: 'outdoors', nature: 'outdoors',
  beachy: 'beach', seaside: 'beach', lockerroom: 'locker-room', locker: 'locker-room', selfies: 'selfie', mirrors: 'mirror', gymrat: 'gym', workout: 'gym', lifting: 'gym',
};
/** Light stemming for adjectives/verbs ("bearded" → "beard", "showering" → "shower"). */
const stems = (w) => [w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : null, w.length > 5 && w.endsWith('ed') ? w.slice(0, -2) : null, w.length > 5 && w.endsWith('ed') ? w.slice(0, -1) : null, w.length > 4 && w.endsWith('y') ? w.slice(0, -1) : null].filter(Boolean);

const lookup = (table) => { const m = new Map(); for (const [k, words] of Object.entries(table)) for (const w of words) m.set(w, k); return m; };
const TYPE_W = lookup(TYPE); const SORT_W = lookup(SORT); const SINCE_W = lookup(SINCE); const PLAT_W = lookup(PLATFORM_WORDS);

/** Optimal-string-alignment distance, bounded (returns max+1 when over). */
function distance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > max) return max + 1;
  }
  return d[a.length][b.length];
}

const singular = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 4 && /(ss|sh|ch|x)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const core = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Build the matcher's vocabulary once (cache it; it is cheap to rebuild every minute).
 * @param {{tags: {name, count}[], creators: {id, handle, display_name, media_count}[], communities: {name, count}[]}} v
 */
function buildVocabulary({ tags = [], creators = [], communities = [] }) {
  const tagMap = new Map(tags.map((t) => [t.name, t.count]));
  const bySingular = new Map();
  for (const t of tags) { const s = singular(t.name); if (!bySingular.has(s) || bySingular.get(s).count < t.count) bySingular.set(s, t); }
  const creatorMap = new Map();
  for (const c of creators) {
    for (const key of [core(c.handle), core(c.display_name)]) {
      if (key.length < 3) continue;
      const prev = creatorMap.get(key);
      if (!prev || prev.media_count < c.media_count) creatorMap.set(key, c);
    }
  }
  const communityMap = new Map(communities.map((c) => [String(c.name).toLowerCase(), c]));
  return { tags, tagMap, bySingular, creatorMap, communityMap };
}

/**
 * @returns {{type?, sort?, since?, platform?, tags: string[] (≤6), creator?, community?, text: string,
 *   chips: {key, value, label}[], corrections: {from, to}[], understood: boolean}}
 */
function understand(text, vocab) {
  const out = { tags: [], text: '', chips: [], corrections: [], understood: false };
  const raw = String(text || '').trim().slice(0, 200);
  if (!raw) return out;
  const leftover = [];
  const addTag = (name, from) => {
    if (!out.tags.includes(name) && out.tags.length < 6) { out.tags.push(name); out.chips.push({ key: 'tag', value: name, label: `#${name}` }); }
    if (from && from !== name && singular(from) !== name && from.replace(/-/g, '') !== name.replace(/-/g, '')) out.corrections.push({ from, to: name });
  };
  const setOnce = (key, value, label) => { if (!out[key]) { out[key] = value; out.chips.push({ key, value, label }); } };

  // explicit syntax first: #tag @creator r/community u/user "quoted phrase"
  let rest = raw.replace(/"([^"]{2,60})"/g, (_, phrase) => { leftover.push(`"${phrase}"`); return ' '; });
  rest = rest.replace(/(^|\s)#([\p{L}\p{N}_-]{2,40})/gu, (_, sp, t) => { const name = t.toLowerCase().replace(/_/g, '-'); if (vocab.tagMap.has(name)) addTag(name); else leftover.push(t); return ' '; });
  rest = rest.replace(/(^|\s)(?:@|u\/)([A-Za-z0-9_.-]{2,40})/g, (_, sp, h) => { const c = vocab.creatorMap.get(core(h)); if (c) setOnce('creator', c, `by ${c.display_name || c.handle}`); else leftover.push(h); return ' '; });
  rest = rest.replace(/(^|\s)r\/([A-Za-z0-9_]{2,40})/g, (_, sp, name) => { const c = vocab.communityMap.get(name.toLowerCase()); if (c) setOnce('community', c.name, c.name); else leftover.push(`r/${name}`); return ' '; });
  // phrases that mean a time window
  rest = rest.replace(/\b(?:this|past|last|the past|the last)\s+(day|24 hours|week|month|year)\b/gi, (_, w) => { const k = SINCE_W.get(w.toLowerCase().split(' ')[0]) || 'day'; setOnce('since', k, { day: 'Past day', week: 'Past week', month: 'Past month', year: 'Past year' }[k]); return ' '; });

  const words = rest.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9.-]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    // multi-word tags ("locker room" -> locker-room), longest first
    let matched = false;
    for (let n = 3; n >= 2 && !matched; n--) {
      if (i + n > words.length) continue;
      const phrase = words.slice(i, i + n).join('-');
      const t = vocab.tagMap.has(phrase) ? phrase : vocab.bySingular.has(singular(phrase)) ? vocab.bySingular.get(singular(phrase)).name : null;
      if (t) { addTag(t); i += n - 1; matched = true; }
      else {
        const c = vocab.creatorMap.get(core(words.slice(i, i + n).join('')));
        if (c && core(words.slice(i, i + n).join('')).length >= 5) { setOnce('creator', c, `by ${c.display_name || c.handle}`); i += n - 1; matched = true; }
      }
    }
    if (matched) continue;
    const w = words[i];
    if (TYPE_W.has(w)) { setOnce('type', TYPE_W.get(w), TYPE_W.get(w) === 'video' ? 'Videos' : 'Photos'); continue; }
    if (SORT_W.has(w)) { setOnce('sort', SORT_W.get(w), { recent: 'Newest', top: 'Top rated', trending: 'Trending', random: 'Shuffle', oldest: 'Oldest' }[SORT_W.get(w)]); continue; }
    if (SINCE_W.has(w) && (i > 0 && /^(this|past|last)$/.test(words[i - 1]) || w === 'today' || w === 'tonight' || w === 'weekend')) { const k = SINCE_W.get(w); setOnce('since', k, { day: 'Past day', week: 'Past week', month: 'Past month', year: 'Past year' }[k]); continue; }
    if (PLAT_W.has(w)) { setOnce('platform', PLAT_W.get(w), `on ${w === 'twitter' || w === 'tweets' ? 'X' : w[0].toUpperCase() + w.slice(1)}`); continue; }
    if (STOP.has(w) || /^\d+$/.test(w)) continue;
    if (vocab.tagMap.has(w)) { addTag(w); continue; }
    const s = singular(w);
    if (vocab.bySingular.has(s)) { addTag(vocab.bySingular.get(s).name, w); continue; }
    const alias = ALIAS[w] && (vocab.tagMap.has(ALIAS[w]) ? ALIAS[w] : null);
    const stem = alias || stems(w).find((x) => vocab.tagMap.has(x));
    if (stem) { addTag(stem); continue; } // a different form, not a misspelling
    const c = vocab.creatorMap.get(core(w));
    if (c && core(w).length >= 4) { setOnce('creator', c, `by ${c.display_name || c.handle}`); continue; }
    const comm = vocab.communityMap.get(w);
    if (comm) { setOnce('community', comm.name, comm.name); continue; }
    // typo correction against tags (prefer frequent tags; stricter for short words)
    if (w.length >= 4) {
      const max = w.length >= 8 ? 2 : 1;
      let best = null;
      for (const t of vocab.tags) {
        if (Math.abs(t.name.length - w.length) > max + 1) continue;
        const d = Math.min(distance(w, t.name, max), distance(s, t.name, max));
        if (d <= max && (!best || d < best.d || (d === best.d && t.count > best.count))) best = { name: t.name, d, count: t.count };
      }
      if (best) { addTag(best.name, w); continue; }
    }
    leftover.push(w);
  }
  out.text = leftover.join(' ').trim();
  out.understood = out.chips.length > 0;
  return out;
}

module.exports = { understand, buildVocabulary, distance, singular };
