/**
 * How a looked-up account is named on screen: "@handle" for a handle, "host/path" for a page.
 * A target can already carry its "@" ("@jakipz") or be a whole URL ("https://xhamster.com/gay/creators/jakipz");
 * neither gets a second "@". YouTube targets are stored WITH their "@" ("@jakipz", feeds are unique on it), so the
 * label, not the stored target, is where the single "@" is decided.
 */
// Invisible characters (zero-width space / joiners, word joiner, BOM) that can ride in front of a pasted or scraped handle.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
export function targetLabel(target) {
  const t = String(target || '').replace(INVISIBLE, '').trim();
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
    } catch { return t; }
  }
  // Every leading @, ASCII or fullwidth (＠), and any space between them: exactly one @ is shown.
  return `@${t.replace(/^[@\uFF20\s]+/, '')}`;
}
