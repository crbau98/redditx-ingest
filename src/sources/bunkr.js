'use strict';
/**
 * Bunkr — one public album (file-locker class; owner decision 2026-11-05: in scope when publicly served).
 *
 * Album pages (`https://bunkr.cr/a/<slug>` and mirrors) list `/f/<fileSlug>` links with no login.
 * Each file page exposes `data-file-id`; `POST https://dl.bunkr.cr/api/_001_v2` with `{id}` returns
 * the CDN base + path. No key. Safety / male-only / picture gates run in the pipeline as usual.
 *
 * Search / browse pages are refused by parse(); only a concrete album (or single file) is a feed.
 * The album feed owns its media (it is the collection, not an aggregator search page).
 *
 * Feed kinds:
 *   album - a public album URL
 *   file  - a single public file URL (one-item album)
 */
const http = require('./http').forPlatform('bunkr', 1200);
const { clip, decodeHtml } = require('./util');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const headers = () => ({ accept: 'text/html,application/xhtml+xml', 'user-agent': UA });

const HOSTS = /(?:^|\.)(?:bunkr\.(?:cr|si|la|ac|fi|black|cat|media|pk|red|site|to|su|is|ws)|bunkrr\.su)$/i;
const ALBUM_RE = /^(?:https?:\/\/)?(?:www\.)?(bunkr(?:r)?\.(?:[a-z]+))\/a\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i;
const FILE_RE = /^(?:https?:\/\/)?(?:www\.)?(bunkr(?:r)?\.(?:[a-z]+))\/f\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i;
const RESOLVE = 'https://dl.bunkr.cr/api/_001_v2';

const FIRST_ITEMS = 24;
const RUN_ITEMS = 12;
const PROBE_ITEMS = 2;
const SEEN_KEEP = 500;
const PAGE_MAX = 2_000_000;

function hostOk(hostname) {
  try { return HOSTS.test(String(hostname || '').toLowerCase()); } catch { return false; }
}

function albumUrl(host, slug) {
  return `https://${host}/a/${slug}`;
}
function fileUrl(host, slug) {
  return `https://${host}/f/${slug}`;
}

/** File slugs (+ optional titles/thumbs) from an album HTML page. */
function albumPage(html, host) {
  const h = String(html || '');
  const title = decodeHtml((/<title>([^<]*)<\/title>/i.exec(h) || [])[1] || '')
    .replace(/\s*\|\s*Bunkr\s*$/i, '').trim() || null;
  const files = [];
  const seen = new Set();
  for (const m of h.matchAll(/href="(?:https?:\/\/[^"]+)?\/f\/([A-Za-z0-9_-]+)"/gi)) {
    const slug = m[1];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    files.push({ slug, url: fileUrl(host, slug), name: null, thumb: null });
  }
  // Titles next to file cards when present
  for (const f of files) {
    const re = new RegExp(`/f/${f.slug}[^>]*>[\\s\\S]{0,400}?title="([^"]+)"|/f/${f.slug}[^>]*>[\\s\\S]{0,200}?<p[^>]*>([^<]+)`, 'i');
    const m = re.exec(h);
    if (m) f.name = decodeHtml(m[1] || m[2] || '').trim() || null;
  }
  for (const m of h.matchAll(/src="(https:\/\/[^"]+(?:thumbs?|static\.scdn)[^"]+)"/gi)) {
    /* thumbs are unordered; leave null unless one-to-one later */
  }
  return { title, files };
}

/** Numeric file id + display name from a file page. */
function filePage(html) {
  const h = String(html || '');
  const id = (/data-file-id="(\d+)"/i.exec(h) || [])[1] || null;
  const title = decodeHtml((/<title>([^<]*)<\/title>/i.exec(h) || [])[1] || '')
    .replace(/\s*\|\s*Bunkr\s*$/i, '').trim() || null;
  const thumb = decodeHtml((/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/i.exec(h) || [])[1] || '') || null;
  return { id, title, thumb };
}

function mediaTypeOf(name) {
  const n = String(name || '').toLowerCase();
  if (/\.(mp4|webm|mkv|mov|m4v)(?:$|\?)/i.test(n)) return 'video';
  if (/\.(jpe?g|png|webp|gif|avif)(?:$|\?)/i.test(n)) return 'image';
  if (/\.(mp3|m4a|aac|flac|wav|ogg)(?:$|\?)/i.test(n)) return 'audio';
  return 'file';
}

/** Build the CDN URL from the resolve API payload. */
function mediaFromResolve(data) {
  if (!data || !data.mediafiles || !data.path) return null;
  const base = String(data.mediafiles).replace(/\/$/, '');
  const path = String(data.path).startsWith('/') ? data.path : `/${data.path}`;
  const name = data.original ? `?n=${encodeURIComponent(data.original)}` : '';
  return { url: `${base}${path}${name}`, name: data.original || null };
}

async function resolveFileId(id) {
  const r = await http.raw(RESOLVE, {
    method: 'POST',
    headers: {
      ...headers(),
      'content-type': 'application/json',
      origin: 'https://dl.bunkr.cr',
      referer: 'https://dl.bunkr.cr/',
    },
    body: JSON.stringify({ id: String(id) }),
    maxBytes: 50_000,
    retries: 1,
  });
  if (r.status >= 400) {
    const e = new Error(`bunkr resolve HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  try { return JSON.parse(r.body.toString('utf8')); } catch {
    return null;
  }
}

function parse(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let m = ALBUM_RE.exec(s);
  if (m && hostOk(m[1])) {
    const host = m[1].toLowerCase();
    const slug = m[2];
    const url = albumUrl(host, slug);
    return { platform: 'bunkr', kind: 'album', target: url, ingestable: true, label: `Bunkr album · ${slug}`, url };
  }
  m = FILE_RE.exec(s);
  if (m && hostOk(m[1])) {
    const host = m[1].toLowerCase();
    const slug = m[2];
    const url = fileUrl(host, slug);
    return { platform: 'bunkr', kind: 'file', target: url, ingestable: true, label: `Bunkr file · ${slug}`, url };
  }
  return null;
}

async function fetchFeed(feed, ctx = {}) {
  const notes = [];
  const parsed = parse(feed.target) || parse(feed.url);
  if (!parsed) return { items: [], notes: ['not a Bunkr album or file URL'], via: 'bunkr' };

  const cursor0 = ctx.cursor || {};
  const seen = new Set(Array.isArray(cursor0.seen) ? cursor0.seen : []);
  const asked = Number(ctx.limit) || 0;
  const cap = ctx.probe ? Math.min(PROBE_ITEMS, asked || PROBE_ITEMS) : (!seen.size ? FIRST_ITEMS : RUN_ITEMS);

  let host; let files; let albumTitle = null;
  if (parsed.kind === 'file') {
    const m = FILE_RE.exec(parsed.target);
    host = m[1].toLowerCase();
    files = [{ slug: m[2], url: parsed.target, name: null, thumb: null }];
  } else {
    const m = ALBUM_RE.exec(parsed.target);
    host = m[1].toLowerCase();
    let html;
    try {
      html = await http.text(parsed.target, { maxBytes: PAGE_MAX, retries: 1, headers: headers() });
    } catch (e) {
      return { items: [], notes: [`album: ${e.message}`], via: 'bunkr' };
    }
    const page = albumPage(html, host);
    albumTitle = page.title;
    files = page.files;
    if (!files.length) {
      return {
        items: [],
        cursor: { seen: [...seen].slice(-SEEN_KEEP) },
        profile: albumTitle ? { displayName: albumTitle, avatarUrl: null, bio: null, links: [{ platform: 'external', service: 'Bunkr', label: albumTitle, url: parsed.target, handle: null }] } : null,
        notes: ['album listed no files'],
        via: 'bunkr-html',
      };
    }
  }

  const fresh = files.filter((f) => f.slug && !seen.has(f.slug)).slice(0, cap);
  if (!fresh.length && files.length) notes.push('bunkr: no new files since the last run');

  const items = [];
  for (const f of fresh) {
    if (ctx.aborted && ctx.aborted()) break;
    let meta;
    try {
      const html = await http.text(f.url, { maxBytes: PAGE_MAX, retries: 1, headers: headers() });
      meta = filePage(html);
    } catch (e) {
      notes.push(`${f.slug}: ${e.message}`);
      seen.add(f.slug);
      continue;
    }
    seen.add(f.slug);
    if (!meta.id) { notes.push(`${f.slug}: no file id`); continue; }
    let resolved;
    try {
      resolved = await resolveFileId(meta.id);
    } catch (e) {
      notes.push(`${f.slug}: resolve ${e.message}`);
      continue;
    }
    const media = mediaFromResolve(resolved);
    if (!media) { notes.push(`${f.slug}: empty resolve`); continue; }
    const name = media.name || meta.title || f.name || f.slug;
    items.push({
      sourceId: `bunkr-${meta.id}`,
      position: 0,
      title: clip(name, 200),
      body: '',
      author: albumTitle || null,
      score: 0,
      postedAt: null,
      permalink: f.url,
      mediaType: mediaTypeOf(name),
      mediaUrl: media.url,
      previewUrl: meta.thumb || f.thumb || null,
      thumbnailUrl: meta.thumb || f.thumb || null,
      duration: null,
      tags: [],
      nsfw: 'explicit',
      trusted: false, // album contents are untrusted: male / safety gates must accept each item
    });
    if (asked && items.length >= asked) break;
  }

  return {
    items,
    cursor: { seen: [...seen].slice(-SEEN_KEEP) },
    profile: (albumTitle || parsed.kind === 'album') ? {
      displayName: albumTitle || 'Bunkr album',
      avatarUrl: null,
      bannerUrl: null,
      bio: null,
      links: [{ platform: 'external', service: 'Bunkr', label: albumTitle || 'Bunkr', url: parsed.target, handle: null }],
    } : null,
    notes,
    via: 'bunkr-html',
  };
}

/** Fresh CDN URL for a stored file page whose signed link expired. */
async function resolve(pageUrl) {
  const parsed = parse(pageUrl);
  if (!parsed || (parsed.kind !== 'file' && !FILE_RE.test(String(pageUrl || '')))) {
    const asFile = FILE_RE.exec(String(pageUrl || ''));
    if (!asFile) return null;
  }
  const url = FILE_RE.test(String(pageUrl || '')) ? String(pageUrl) : (parsed && parsed.kind === 'file' ? parsed.target : null);
  if (!url) return null;
  const html = await http.text(url, { maxBytes: PAGE_MAX, retries: 1, headers: headers() });
  const meta = filePage(html);
  if (!meta.id) return null;
  const data = await resolveFileId(meta.id);
  const media = mediaFromResolve(data);
  return media ? { mediaUrl: media.url, previewUrl: meta.thumb || null } : null;
}

module.exports = {
  _albumPage: albumPage,
  _filePage: filePage,
  _mediaFromResolve: mediaFromResolve,
  platform: 'bunkr',
  label: 'Bunkr',
  color: '#a78bfa',
  kinds: ['album', 'file'],
  intervalMin: { album: 360, file: 720 },
  isConfigured: () => ({ ok: true, note: 'public albums, no key' }),
  parse,
  fetch: fetchFeed,
  resolve,
};
