#!/usr/bin/env node
'use strict';
/**
 * Post-deploy check for "stored media comes straight from the bucket" (STORE_DIRECT). Read-only: it asks the running app for
 * one stored file and follows the redirect, the way a browser does. Exit code 1 when any check fails.
 *
 *     node scripts/verify-store-direct.js https://your-app.example [--url https://media.prism.invalid/<key>]
 *
 * Without --url it picks a stored picture from the public listing. It confirms the age gate the way the app's own button does
 * (POST /api/age/confirm), so a gated deployment answers. Nothing is written, and no credential is printed.
 */
const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');
const allowHttp = args.includes('--allow-http'); // local testing against a plain-http mock bucket
const given = args.includes('--url') ? args[args.indexOf('--url') + 1] : '';
if (!base) { console.error('usage: node scripts/verify-store-direct.js https://your-app.example [--url https://media.prism.invalid/<key>]'); process.exit(2); }

const rows = []; let failed = false;
const check = (name, ok, detail = '') => { rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failed = true; };
const cspOf = (h) => Object.fromEntries(String(h || '').split(';').map((d) => { const [k, ...v] = d.trim().split(/\s+/); return [k, v]; }));

(async () => {
  const meta = await (await fetch(`${base}/api/meta`)).json();
  const storeHost = meta.directMedia && meta.directMedia.store;
  check('/api/meta says stored media is redirected (directMedia.store)', typeof storeHost === 'string' && !!storeHost, `version ${meta.version}, store=${JSON.stringify(storeHost)}`);
  if (!storeHost) { console.log(rows.join('\n')); console.log('\nThe redirect is off: no bucket in this mode, STORE_DIRECT=0, an endpoint the browser cannot reach, or a build without this feature.'); process.exit(1); }

  // the app's own age confirmation: a cookie, nothing else
  let cookie = '';
  try {
    const c = await fetch(`${base}/api/age/confirm`, { method: 'POST' });
    cookie = (c.headers.getSetCookie ? c.headers.getSetCookie() : []).map((x) => x.split(';')[0]).join('; ');
  } catch { /* an ungated deployment needs none */ }
  const get = (url, extra = {}) => fetch(url, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...extra } });

  let storeUrl = given;
  if (!storeUrl) {
    for (const q of ['/api/media?limit=200', '/api/media?limit=200&sort=recent']) {
      const list = await (await get(`${base}${q}`)).json().catch(() => ({}));
      for (const it of list.items || []) {
        const u = [it.thumb_url, it.preview_url, it.thumbnail_url, it.media_url].find((x) => { try { return new URL(x).hostname === storeHost; } catch { return false; } });
        if (u) { storeUrl = u; break; }
      }
      if (storeUrl) break;
    }
  }
  check('found a stored file to test', !!storeUrl, storeUrl || 'none in the listing: pass --url');
  if (!storeUrl) { console.log(rows.join('\n')); process.exit(1); }

  const r = await get(`${base}/api/proxy?url=${encodeURIComponent(storeUrl)}`);
  const loc = r.headers.get('location') || '';
  let L = null; try { L = new URL(loc); } catch { /* reported below */ }
  check('the proxy answers with a redirect (307), not the bytes', r.status === 307, `status ${r.status}`);
  check('it points at the bucket, not at this app, over https', !!L && L.origin !== new URL(base).origin && (L.protocol === 'https:' || allowHttp), L ? L.origin : 'no Location');
  check('the URL is presigned (X-Amz-Signature, Expires, SignedHeaders=host)', !!L && L.searchParams.has('X-Amz-Signature') && Number(L.searchParams.get('X-Amz-Expires')) > 0 && L.searchParams.get('X-Amz-SignedHeaders') === 'host',
    L ? `expires ${L.searchParams.get('X-Amz-Expires')} s` : '');
  const cc = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  check('the redirect is cacheable for less than the signature lives', !!cc && !!L && Number(cc[1]) > 0 && Number(cc[1]) < Number(L.searchParams.get('X-Amz-Expires')), `Cache-Control: ${r.headers.get('cache-control')}`);
  check('the redirect carries no body', (await r.arrayBuffer()).byteLength === 0);

  if (L) {
    const full = await fetch(L, { method: 'GET', headers: { range: 'bytes=0-1023' } });
    const type = full.headers.get('content-type') || '';
    await full.arrayBuffer();
    check('the bucket serves it: 206 for a Range request (seeking works)', full.status === 206 && /^bytes 0-\d+\/\d+$/.test(full.headers.get('content-range') || ''), `status ${full.status}, ${full.headers.get('content-range')}`);
    check('with an image or video content type', /^(image|video)\//.test(type), type);
    const head = await fetch(L, { method: 'GET' }); const cl = head.headers.get('content-length'); await head.body.cancel();
    check('and a plain GET works (200)', head.status === 200, `status ${head.status}, ${cl} bytes`);

    const home = await fetch(`${base}/`);
    const csp = cspOf(home.headers.get('content-security-policy'));
    const bucketPath = `${L.origin}/${L.pathname.split('/')[1]}/`; // path-style: the first path segment is the bucket
    for (const d of ['img-src', 'media-src', 'connect-src']) check(`CSP ${d} names the bucket path`, (csp[d] || []).includes(bucketPath), bucketPath);
    check('and no source allows the whole bucket host (other tenants\' buckets)', !Object.values(csp).some((v) => v.includes(L.origin) || v.includes(`${L.origin}/`)), L.origin);
    check('CSP has no wildcard', !JSON.stringify(csp).includes('*'));
  }
  const marked = await get(`${base}/api/proxy?url=${encodeURIComponent(storeUrl)}&mark=prism`);
  check('the watermarked download is not redirected (stays on the proxy)', marked.status !== 307 && !marked.headers.get('location'), `status ${marked.status}`);

  console.log(rows.join('\n'));
  console.log(failed ? '\nFAILED' : '\nOK: stored media is served straight from the bucket');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(rows.join('\n')); console.error(`\nerror: ${e.message}`); process.exit(1); });
