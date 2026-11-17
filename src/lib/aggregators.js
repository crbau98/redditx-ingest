'use strict';
/**
 * Aggregator, ranking and leak-index sites: pages that list MANY creators (OnlyFans directories, "top 50 gay OnlyFans", leak
 * indexes, forum threads, tube-site search pages). A page there about one man links dozens of other people's pages, so nothing
 * on it may be filed on him unless it is visibly his: a link counts only when its own handle is his handle or a known alias.
 * Before this, a fanstats.com page left women's TikTok / OnlyFans / Amazon links on a creator, and onlypedia / fanscentral pages
 * (with that site's own Instagram) were filed on the wrong man.
 *
 * Per-creator mirrors (coomer, kemono, GayForFans performer pages) are not here: their URL is keyed by the creator's own handle.
 */
const DOMAINS = [
  // directories / rankings / stats
  'onlypedia.org', 'onlypedia.com', 'fanstats.com', 'fanstats.org', 'fanscentral.com', 'fansmetrics.com', 'onlyfinder.com', 'onlyfinder.co',
  'fansearch.net', 'hubite.com', 'juicysearch.com', 'fansfinder.com', 'onlysearch.co', 'onlysearch.com', 'fanspage.com', 'onlyfanstop.com',
  'bestonlyfans.com', 'topfansites.com', 'fansly-top.com', 'onlyfansranking.com', 'gaysdream.com', 'gayonlyfans.com', 'besties.com',
  // leak indexes and image boards
  'fapello.com', 'fapello.su', 'leakimedia.com', 'thothub.to', 'thothub.tv', 'nudostar.com', 'nudostar.tv', 'fapopedia.net', 'fapodrop.com', 'erothots.co',
  'simpcity.su', 'simpcity.cr', 'socialmediagirls.com', 'influencersgonewild.com', 'leakedmodels.com', 'onlyleaks.org', 'fapelo.com', 'fapeza.com', 'nudogram.com',
  // forums and tube search pages
  'lpsg.com', 'eporner.com', 'spankbang.com', 'sxyprn.com', 'boyfriendtv.com',
];

const hostOf = (u) => { try { return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
/** Is this URL (or host) on an aggregator site? */
function isAggregator(url) {
  const h = hostOf(url);
  return !!h && DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** The handle a link names, when it names one: a paid page handle, a social/profile handle, or null (a generic URL). */
function linkHandle(link) {
  if (!link) return null;
  if (link.handle) return String(link.handle);
  const url = link.url || '';
  if (!url) return null;
  const paid = require('./paid');
  const svc = link.service && paid.SERVICES[link.service] ? link.service : paid.serviceOf(url);
  if (svc) return paid.paidHandle(svc, url);
  try {
    const p = require('./links').parseProfile(url);
    if (p && p.kind === 'user' && p.target) return String(p.target).replace(/^@+/, '').split('@')[0];
  } catch { /* not a profile URL */ }
  return null;
}

/**
 * The links from a page that may be filed on `creator`. From an aggregator page only his own (handle or alias match); from any
 * page, never a link INTO an aggregator site (his "onlypedia page" is the site's page about him, not his link).
 * @param {object} creator {handle, display_name}
 * @param {object[]} links
 * @param {{source?: string|null, known?: string[]}} opts source = the page the links were read from; known = his aliases
 * @returns {{keep: object[], dropped: Array<{link: object, why: string}>}}
 */
function ownLinks(creator, links, { source = null, known = [] } = {}) {
  const keep = []; const dropped = [];
  const fromAggregator = !!source && isAggregator(source);
  const { samePerson } = require('../engine/deepsearch');
  for (const l of links || []) {
    if (!l) continue;
    if (l.url && isAggregator(l.url)) { dropped.push({ link: l, why: 'aggregator site' }); continue; }
    if (!fromAggregator) { keep.push(l); continue; }
    const h = linkHandle(l);
    if (h && samePerson(creator || {}, h, known)) keep.push(l);
    else dropped.push({ link: l, why: h ? `found on ${hostOf(source)}, handle ${h} is not his` : `found on ${hostOf(source)}, names nobody` });
  }
  return { keep, dropped };
}

const compact = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** Does this page URL name him: one of its path segments is his handle / alias, or contains his 5+ letter handle? */
function urlNames(creator, url, known = []) {
  let segs = [];
  try { segs = new URL(url).pathname.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } }); } catch { return false; }
  const { samePerson } = require('../engine/deepsearch');
  const names = [creator && creator.handle, creator && creator.display_name, ...known].map(compact).filter((n) => n.length >= 5);
  for (const seg of segs) {
    if (samePerson(creator || {}, seg.replace(/\.[a-z0-9]{2,5}$/i, ''), known)) return true;
    const c = compact(seg);
    if (names.some((n) => c.includes(n))) return true;
  }
  return false;
}

module.exports = { urlNames, compact, DOMAINS, isAggregator, linkHandle, ownLinks, hostOf };
