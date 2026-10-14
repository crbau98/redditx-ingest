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
  return x.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Too short or too generic to identify anyone on its own. */
const GENERIC = new Set(['admin', 'official', 'model', 'onlyfans', 'fansly', 'backup', 'account', 'user', 'guy', 'boy', 'man', 'gay', 'fit', 'gym', 'daddy', 'jock', 'nsfw', 'free', 'vip']);
const usableAlias = (norm) => typeof norm === 'string' && norm.length >= 4 && !GENERIC.has(norm) && !/^\d+$/.test(norm);

module.exports = { normAlias, usableAlias };
