/**
 * How a looked-up account is named on screen: "@handle" for a handle, "host/path" for a page.
 * A target can already carry its "@" ("@jakipz") or be a whole URL ("https://xhamster.com/gay/creators/jakipz");
 * neither gets a second "@".
 */
export function targetLabel(target) {
  const t = String(target || '').trim();
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
    } catch { return t; }
  }
  return `@${t.replace(/^@+/, '')}`;
}
