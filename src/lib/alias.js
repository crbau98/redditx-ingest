'use strict';
/**
 * Alias keys: the form two names must share to count as the same name. Case, accents, punctuation, a leading
 * "@", the server part of a fediverse handle and the ".bsky.social" style suffix are all dropped, so
 * "@Jake.Fit", "jake_fit@mastodon.social" and "jakefit.bsky.social" all become "jakefit".
 */
const SUFFIX = /\.(bsky\.social|bsky\.team|social|tumblr\.com)$/i;

function normAlias(s) {
  let x = String(s || '').trim().replace(/^@+/, '');
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x)) x = x.split('@')[0]; // user@instance
  x = x.replace(SUFFIX, '');
  x = x.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
  // Handles grow filler affixes across platforms ("the_real_jake", "jake.official", "@RealJake backup"):
  // strip them so one man's accounts share a key. Stems must stay usable on their own, so a man
  // actually called "Image" or "Theo" never collapses.
  let prev;
  do {
    prev = x;
    x = x.replace(/^(the|real|official|iam|im|its|mr)(?=[\p{L}\p{N}]{4,}$)/u, '');
    x = x.replace(/(official|onlyfans|fansly|backup|backupacc|alt|nsfw|xxx|vip|page)$/u, (m) => (x.length - m.length >= 4 ? '' : m));
  } while (x !== prev);
  return x;
}

/** Too short or too generic to identify anyone on its own. */
const GENERIC = new Set(['admin', 'official', 'real', 'alt', 'backup', 'backupacc', 'fanpage', 'fans', 'page', 'profile', 'account', 'user', 'guy', 'boy', 'man', 'gay', 'fit', 'gym', 'daddy', 'jock', 'nsfw', 'free', 'vip', 'model', 'onlyfans', 'fansly', 'instagram', 'tiktok', 'twitter']);
const usableAlias = (norm) => typeof norm === 'string' && norm.length >= 4 && !GENERIC.has(norm) && !/^\d+$/.test(norm);

module.exports = { normAlias, usableAlias };
