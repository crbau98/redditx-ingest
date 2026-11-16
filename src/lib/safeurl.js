'use strict';
/**
 * Only http(s) addresses leave the server as links. A scraped page can carry `javascript:` or `data:` URLs; CSP
 * (script-src 'self') already stops them from running, and this is the second barrier (Crucible wave 11, item 11).
 */
const HTTP = /^https?:\/\/[^\s]/i;

/** The trimmed URL when it is http(s), else null. */
function httpUrl(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  return HTTP.test(s) ? s : null;
}

/** A creator's links with every non-http(s) `url` removed; a link left with neither a url nor a handle is dropped. */
function safeLinks(links) {
  if (!Array.isArray(links)) return [];
  const out = [];
  for (const l of links) {
    if (!l || typeof l !== 'object') continue;
    if (l.url === undefined || l.url === null || l.url === '') { if (l.handle) out.push(l); continue; }
    const url = httpUrl(l.url);
    if (url) out.push(url === l.url ? l : { ...l, url });
    else if (l.handle) { const { url: _drop, ...rest } = l; out.push(rest); }
  }
  return out;
}

module.exports = { httpUrl, safeLinks };
