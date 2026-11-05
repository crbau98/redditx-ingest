'use strict';
/**
 * UI audit: every page of a running PRISM, in a real Chromium, on a desktop (light and dark) and on a phone. For each
 * page it records a screenshot and what a person would trip over:
 *
 *   errors       console errors, uncaught page errors, failed requests, HTTP 5xx answers
 *   layout       sideways scrolling on the page (content wider than the screen)
 *   a11y         pictures without alt text, buttons / links / form fields without an accessible name, duplicate ids
 *   speed        time to the first content and to the largest content (LCP), and how many requests the page made
 *
 *     DEMO_ART=1 DB_PATH=./data/demo.db node scripts/seed-demo.js
 *     DEMO_ART=1 DB_PATH=./data/demo.db ADMIN_KEY=dev PORT=3999 node server.js &
 *     node scripts/ui-audit.js http://localhost:3999 --out ./ui-audit [--admin-key dev] [--headed] [--strict] [--only-admin]
 *
 * With --admin-key every admin screen is audited at 360, 390, 768 and 1280 wide (and 390 in the light theme) for content cut off
 * at the screen edge, scrollers inside the page and touch targets under 44px. --strict makes those findings fail the run.
 *
 * Writes <out>/report.md, <out>/report.json and <out>/<page>-<view>.png. Exit code 1 when any page has an error.
 * Needs Playwright with Chromium (npx playwright install chromium; it is an optional dependency of PRISM).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const BASE = (args.find((a) => /^https?:\/\//.test(a)) || 'http://localhost:3999').replace(/\/+$/, '');
const OUT = path.resolve(opt('out', './ui-audit'));
const ADMIN_KEY = opt('admin-key', process.env.ADMIN_KEY || '');
const HEADED = args.includes('--headed');
const ONLY_ADMIN = args.includes('--only-admin'); // skip the public pages: a fast loop while working on the console

const VIEWS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  { name: 'desktop-dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' },
];
const PAGES = [
  ['home', '/'], ['explore', '/explore'], ['search', '/explore?tags=beard&smart=1&raw=beard'], ['reels', '/reels'], ['browse', '/browse'],
  ['creators', '/creators'], ['find', '/find'], ['saved', '/saved'], ['following', '/following'],
];
// Every admin screen, at the widths an owner really uses: two phones, a tablet, a desktop. Phones are touch (44px targets apply).
const ADMIN_PAGES = ['overview', 'moderation', 'reports', 'media', 'creators', 'identities', 'sources', 'feeds', 'discovery', 'blocklist', 'audit', 'live', 'settings'];
const ADMIN_VIEWS = [360, 390, 768, 1280].map((w) => ({ name: `w${w}`, viewport: { width: w, height: w < 800 ? 844 : 900 }, isMobile: w < 800, hasTouch: w < 800, colorScheme: 'dark', touch: w < 800 }));
const ADMIN_LIGHT = { name: 'w390-light', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light', touch: true };
const TAP_MIN = 44; // DESIGN.md: every interactive element is at least 44px on touch

// In-page checks (run after the page settles).
const CHECKS = (touch) => {
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent
    || el.getAttribute('title') || el.textContent || el.getAttribute('alt') || el.querySelector('img[alt]')?.getAttribute('alt') || '').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && r.right > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const where = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
  const out = { a11y: [], overflow: 0, wide: [] };
  for (const img of document.querySelectorAll('img')) if (visible(img) && !img.hasAttribute('alt')) out.a11y.push(`image without alt: ${where(img)}`);
  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) if (visible(el) && !name(el)) out.a11y.push(`${el.tagName === 'A' ? 'link' : 'button'} without a name: ${where(el)}`);
  for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
    if (!visible(el)) continue;
    const labelled = el.labels && el.labels.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title');
    if (!labelled) out.a11y.push(`form field without a label: ${where(el)}${el.placeholder ? ` (placeholder "${el.placeholder.slice(0, 40)}")` : ''}`);
  }
  const ids = new Map();
  for (const el of document.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) || 0) + 1);
  for (const [id, n] of ids) if (n > 1) out.a11y.push(`duplicate id "${id}" (${n}×)`);
  out.overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (out.overflow > 1) {
    for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); if (r.right > document.documentElement.clientWidth + 1 && visible(el)) { out.wide.push(where(el)); if (out.wide.length >= 5) break; } }
  }
  // Admin layout: content cut off at the right edge by an overflow rule, scrollers inside the page, targets under 44px.
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll') return true; } return false; };
  out.clipped = []; out.hscroll = []; out.small = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('svg')) continue;
    const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    if (r.right > window.innerWidth + 2 && !inScroller(el)) out.clipped.push(`${where(el)} to ${Math.round(r.right)}px`);
    if ((st.overflowX === 'auto' || st.overflowX === 'scroll') && el.scrollWidth - el.clientWidth > 2) out.hscroll.push(`${where(el)} +${el.scrollWidth - el.clientWidth}px`);
  }
  if (touch) {
    for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=checkbox], [role=switch]')) {
      if (!visible(el) || (el.closest('.switch') && el.tagName === 'INPUT')) continue;
      // a checkbox is tapped through its label: the label's box is the target
      const box = (el.type === 'checkbox' || el.type === 'radio') && el.closest('label') ? el.closest('label') : el;
      const r = box.getBoundingClientRect();
      if (r.height < 43.5 || r.width < 43.5) out.small.push(`${Math.round(r.width)}x${Math.round(r.height)} ${where(el)} "${name(el).slice(0, 24)}"`);
    }
  }
  out.clipped = [...new Set(out.clipped)].slice(0, 8); out.hscroll = [...new Set(out.hscroll)].slice(0, 8); out.small = [...new Set(out.small)].slice(0, 12);
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByName('first-contentful-paint')[0];
  out.fcpMs = paint ? Math.round(paint.startTime) : null;
  out.lcpMs = window.__lcp ? Math.round(window.__lcp) : null;
  out.loadMs = nav ? Math.round(nav.loadEventEnd) : null;
  out.requests = performance.getEntriesByType('resource').length;
  out.a11y = [...new Set(out.a11y)].slice(0, 25);
  return out;
};

async function audit(browser, view, label, route, { admin = false } = {}) {
  const ctx = await browser.newContext({ ...view, name: undefined, touch: undefined });
  if (admin) await ctx.addCookies([{ name: 'prism_age', value: '1', url: BASE }]).catch(() => {}); // a fast loop must not depend on clicking the age gate in time
  // the app stores its settings JSON-encoded, so the theme is '"light"' and not 'light'
  if (admin) await ctx.addInitScript((t) => { try { localStorage.setItem('prism.theme', JSON.stringify(t)); } catch { /* storage blocked */ } }, view.colorScheme || 'dark');
  await ctx.addInitScript(() => {
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch { /* not supported */ }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !(admin && /401/.test(m.text()))) errors.push(`console: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => errors.push(`page error: ${e.message.slice(0, 300)}`));
  page.on('requestfailed', (r) => { if (!/abort/i.test(r.failure()?.errorText || '')) errors.push(`request failed: ${r.url().slice(0, 160)} (${r.failure()?.errorText})`); });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()}: ${r.url().slice(0, 160)}`); });
  // Past the age gate the way a visitor gets past it.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const gate = page.getByRole('button', { name: /18 or older/ });
  if (await gate.isVisible({ timeout: 3000 }).catch(() => false)) await gate.click();
  if (admin) await page.evaluate((k) => sessionStorage.setItem('prism.admin', k), ADMIN_KEY).catch(() => {});
  const started = Date.now();
  await page.goto(`${BASE}/#${route}`, { waitUntil: 'domcontentloaded' });
  if (admin) {
    const key = page.getByLabel('Admin key');
    if (await key.isVisible({ timeout: 2500 }).catch(() => false)) { await key.fill(ADMIN_KEY); await page.keyboard.press('Enter'); }
  }
  // the console keeps an event stream open, so it never goes idle: give it a short wait, then let the settle delay below do the rest
  await page.waitForLoadState('networkidle', { timeout: admin ? 2500 : 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { timeout: 3000 }).catch(() => {});
  const checks = await page.evaluate(CHECKS, !!view.touch);
  const file = `${label}-${view.name}.png`;
  await page.screenshot({ path: path.join(OUT, file) });
  await ctx.close();
  return { page: label, route, view: view.name, file, settledMs: Date.now() - started, errors: [...new Set(errors)], ...checks };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: !HEADED });
  const results = [];
  // One creator page too: the first creator the API lists.
  const pages = [...PAGES];
  try {
    const res = await fetch(`${BASE}/api/creators?limit=1`, { headers: { cookie: 'prism_age=1' } });
    const j = await res.json(); const c = (j.items || j)[0];
    if (c) pages.push(['creator', `/creator/${c.id}`]);
  } catch { /* skip it */ }
  if (!ONLY_ADMIN) for (const [label, route] of pages) for (const view of VIEWS) { process.stderr.write(`${label} · ${view.name}\n`); results.push(await audit(browser, view, label, route)); }
  if (ADMIN_KEY) for (const tab of ADMIN_PAGES) for (const view of [...ADMIN_VIEWS, ADMIN_LIGHT]) { process.stderr.write(`admin/${tab} · ${view.name}\n`); results.push({ ...(await audit(browser, view, `admin-${tab}`, `/admin/${tab}`, { admin: true })), admin: true }); }
  await browser.close();

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
  const bad = results.filter((r) => r.errors.length);
  const wide = results.filter((r) => r.overflow > 1);
  // Admin layout verdicts (only admin views carry them): clipped content, scrollers inside the page, targets under 44px on touch.
  const adm = results.filter((r) => r.admin);
  const admClipped = adm.filter((r) => r.clipped.length);
  const admScroll = adm.filter((r) => r.hscroll.length);
  const admSmall = adm.filter((r) => r.small.length);
  const a11y = results.filter((r) => r.a11y.length);
  const lines = [
    `# PRISM UI audit`, '', `${BASE} · ${new Date().toISOString()} · ${results.length} page views (${VIEWS.map((v) => v.name).join(', ')}${ADMIN_KEY ? ' + admin' : ''})`, '',
    `- **Errors:** ${bad.length ? `${bad.length} page views` : 'none'}`,
    `- **Sideways scrolling:** ${wide.length ? `${wide.length} page views` : 'none'}`,
    `- **Accessibility findings:** ${a11y.length ? `${a11y.length} page views` : 'none'}`,
    ...(adm.length ? [`- **Admin, content cut off at the screen edge:** ${admClipped.length ? `${admClipped.length} of ${adm.length} views` : 'none'}`,
      `- **Admin, sideways scrollers inside the page:** ${admScroll.length ? `${admScroll.length} of ${adm.length} views` : 'none'}`,
      `- **Admin, touch targets under ${TAP_MIN}px:** ${admSmall.length ? `${admSmall.reduce((n, r) => n + r.small.length, 0)} (sampled) in ${admSmall.length} of ${adm.length} views` : 'none'}`] : []), '',
    '| Page | View | Errors | Overflow | A11y | FCP | LCP | Requests | Screenshot |', '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.page} | ${r.view} | ${r.errors.length || ''} | ${r.overflow > 1 ? `${r.overflow}px` : ''} | ${r.a11y.length || ''} | ${r.fcpMs ?? ''} | ${r.lcpMs ?? ''} | ${r.requests} | [png](${r.file}) |`),
  ];
  for (const r of results.filter((x) => x.errors.length || x.overflow > 1 || x.a11y.length)) {
    lines.push('', `## ${r.page} · ${r.view}`);
    for (const e of r.errors) lines.push(`- error: ${e}`);
    if (r.overflow > 1) lines.push(`- ${r.overflow}px wider than the screen: ${r.wide.join(', ')}`);
    for (const a of r.a11y) lines.push(`- a11y: ${a}`);
  }
  for (const r of adm.filter((x) => x.clipped.length || x.hscroll.length || x.small.length)) {
    lines.push('', `## admin layout: ${r.page} · ${r.view}`);
    for (const c of r.clipped) lines.push(`- cut off: ${c}`);
    for (const c of r.hscroll) lines.push(`- scroller: ${c}`);
    for (const c of r.small) lines.push(`- small target: ${c}`);
  }
  fs.writeFileSync(path.join(OUT, 'report.md'), `${lines.join('\n')}\n`);
  console.log(`${results.length} page views · ${bad.length} with errors · ${wide.length} overflowing · ${a11y.length} with a11y findings${adm.length ? ` · admin: ${admClipped.length} cut off, ${admScroll.length} with inner scrollers, ${admSmall.length} with small targets` : ''} → ${path.join(OUT, 'report.md')}`);
  // --strict also fails the run on admin layout problems, so a layout regression can gate a release.
  process.exit(bad.length || (args.includes('--strict') && (admClipped.length || admScroll.length || admSmall.length || wide.length)) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
