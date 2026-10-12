// Hash router. The lightbox lives in the `m` query parameter (#/explore?m=<id>)
// so it can be deep-linked and closed with Back without remounting the page
// underneath it.

export function parse(hash = location.hash) {
  const raw = (hash || '').replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(queryPart) };
}

export function href(path, query = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.set(k, v);
  const s = u.toString();
  return `#${path}${s ? `?${s}` : ''}`;
}

export function navigate(path, query = {}, { replace = false } = {}) {
  const target = href(path, query);
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** Key identifying "which page is showing" — ignores the lightbox param. */
export function routeKey(p = parse()) {
  const q = new URLSearchParams(p.query);
  q.delete('m');
  q.sort();
  return `${p.path}?${q.toString()}`;
}

export function setParam(key, value, { replace = true } = {}) {
  const p = parse();
  if (value === null || value === undefined || value === '') p.query.delete(key); else p.query.set(key, value);
  const target = `#${p.path}${p.query.toString() ? `?${p.query.toString()}` : ''}`;
  if (replace) { history.replaceState(null, '', target); window.dispatchEvent(new HashChangeEvent('hashchange')); }
  else location.hash = target;
}

export function matchRoute(routes, p = parse()) {
  for (const r of routes) {
    const segs = r.pattern.split('/').filter(Boolean);
    if (segs.length === 0 && p.parts.length === 0) return { route: r, params: {} };
    if (segs.length === 0) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const optional = s.endsWith('?');
      const name = s.replace(/\?$/, '');
      if (name.startsWith(':')) {
        if (p.parts[i] === undefined) { if (!optional) { ok = false; break; } } else params[name.slice(1)] = decodeURIComponent(p.parts[i]);
      } else if (p.parts[i] !== name) { ok = false; break; }
    }
    if (ok && p.parts.length <= segs.length) return { route: r, params };
  }
  return null;
}
