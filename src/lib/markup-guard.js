'use strict';
/**
 * Bounds the work a hostile page or feed can cost before it reaches the DOM parser.
 *
 * cheerio/parse5 builds the whole tree on the main thread, and the cost is quadratic in nesting depth: 32 KB of unclosed
 * "<item><title>a" took 4 s, a 128 KB nested-table page 8.7 s, and 64 KB took 33 s on the reference machine. One feed could
 * freeze the whole server. This scan is ONE linear pass over the text (indexOf only, no regex backtracking) that counts tags,
 * tracks nesting depth the way a parser would see it, and refuses the document before any tree is built.
 *
 * Failures are Errors whose message names a parse failure, so the engine classifies them as error_kind "parse" (a permanent
 * property of that URL's content, not an outage).
 */
const LIMITS = {
  html: { maxBytes: 2_000_000, maxDepth: 200, maxElements: 100_000 },
  xml: { maxBytes: 1_500_000, maxDepth: 100, maxElements: 120_000 },
  fragment: { maxBytes: 300_000, maxDepth: 60, maxElements: 20_000 }, // one feed entry's description / content
};
const FEED_MAX_ENTRIES = 500;            // entries read from one feed document
const FEED_PARSE_BUDGET_MS = 2000;       // time the per-entry pass may take before the run fails

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'frame', 'keygen']);
// End tags the HTML parser supplies itself: an unclosed <p> or <td> does not nest, so it must not count as depth.
const IMPLIED = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'option', 'optgroup', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rp', 'rt']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);

class MarkupRefused extends Error {
  constructor(message) { super(`Refused to parse hostile markup: ${message}`); this.name = 'MarkupRefused'; this.markupGuard = true; }
}

const isNameChar = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 58 || c === 46;

/**
 * Throws MarkupRefused when the text is too large, too deep or has too many elements for its kind.
 * @param {string} text
 * @param {'html'|'xml'|'fragment'} kind
 * @returns {{elements: number, maxDepth: number}}
 */
function assertParseable(text, kind = 'html') {
  const lim = LIMITS[kind] || LIMITS.html;
  const s = String(text || '');
  if (s.length > lim.maxBytes) throw new MarkupRefused(`${Math.round(s.length / 1024)} KB is over the ${Math.round(lim.maxBytes / 1024)} KB limit`);
  const html = kind !== 'xml';
  let depth = 0; let deepest = 0; let elements = 0; let i = 0; let lower = null; // lowercased once, only if a raw-text element appears
  const n = s.length;
  while (i < n) {
    i = s.indexOf('<', i);
    if (i === -1) break;
    const c1 = s.charCodeAt(i + 1);
    if (c1 === 33 /* ! */) { // comment, CDATA, doctype
      if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); i = e === -1 ? n : e + 3; continue; }
      if (s.startsWith('<![CDATA[', i)) { const e = s.indexOf(']]>', i + 9); i = e === -1 ? n : e + 3; continue; }
      const e = s.indexOf('>', i + 2); i = e === -1 ? n : e + 1; continue;
    }
    if (c1 === 63 /* ? */) { const e = s.indexOf('>', i + 2); i = e === -1 ? n : e + 1; continue; }
    const closing = c1 === 47;
    let j = i + (closing ? 2 : 1);
    const start = j;
    while (j < n && isNameChar(s.charCodeAt(j))) j++;
    if (j === start || !((s.charCodeAt(start) | 32) >= 97 && (s.charCodeAt(start) | 32) <= 122)) { i += 1; continue; } // a "<" that starts no tag
    const name = html ? s.slice(start, j).toLowerCase() : s.slice(start, j);
    const gt = s.indexOf('>', j);
    if (gt === -1) break; // unterminated tag: the rest is text
    if (closing) {
      if (!(html && (VOID.has(name) || IMPLIED.has(name)))) depth = Math.max(0, depth - 1);
      i = gt + 1; continue;
    }
    elements++;
    if (elements > lim.maxElements) throw new MarkupRefused(`more than ${lim.maxElements} elements`);
    const selfClosed = s.charCodeAt(gt - 1) === 47;
    if (!selfClosed && !(html && (VOID.has(name) || IMPLIED.has(name)))) {
      depth++;
      if (depth > deepest) deepest = depth;
      if (depth > lim.maxDepth) throw new MarkupRefused(`nesting deeper than ${lim.maxDepth}`);
    }
    i = gt + 1;
    if (html && RAW.has(name) && !selfClosed) { // raw text: a "<" inside a script is not markup
      if (lower === null) lower = s.toLowerCase();
      const e = lower.indexOf(`</${name}`, i);
      if (e === -1) break;
      i = e;
    }
  }
  return { elements, maxDepth: deepest };
}

/** assertParseable that answers true/false instead of throwing (for a per-entry fragment that may simply be skipped). */
function parseable(text, kind = 'fragment') {
  try { assertParseable(text, kind); return true; } catch (e) { if (e && e.markupGuard) return false; throw e; }
}

module.exports = { assertParseable, parseable, MarkupRefused, LIMITS, FEED_MAX_ENTRIES, FEED_PARSE_BUDGET_MS };
