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
 *     node scripts/ui-audit.js http://localhost:3999 --out ./ui-audit [--admin-key dev] [--headed]
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

const VIEWS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  { name: 'desktop-dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' },
];
const PAGES = [
  ['home', '/'], ['explore', '/explore'], ['search', '/explore?tags=beard&smart=1&raw=beard'], ['reels', '/reels'], ['browse', '/browse'],
  ['creators', '/creators'], ['find', '/find'], ['galaxy', '/galaxy'], ['saved', '/saved'], ['following', '/following'],
];
const ADMIN_PAGES = ['overview', 'feeds', 'creators', 'discovery', 'moderation', 'sources', 'settings'];

// In-page checks (run after the page settles).
const CHECKS = () => {
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent
    || el.getAttribute('title') || el.textContent || el.getAttribute('alt') || el.querySelector('img[alt]')?.getAttribute('alt') || '').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
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
  const ctx = await browser.newContext({ ...view, name: undefined });
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
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { timeout: 3000 }).catch(() => {});
  const checks = await page.evaluate(CHECKS);
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
  for (const [label, route] of pages) for (const view of VIEWS) { process.stderr.write(`${label} · ${view.name}\n`); results.push(await audit(browser, view, label, route)); }
  if (ADMIN_KEY) for (const tab of ADMIN_PAGES) { process.stderr.write(`admin/${tab}\n`); results.push(await audit(browser, VIEWS[0], `admin-${tab}`, `/admin/${tab}`, { admin: true })); }
  await browser.close();

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
  const bad = results.filter((r) => r.errors.length);
  const wide = results.filter((r) => r.overflow > 1);
  const a11y = results.filter((r) => r.a11y.length);
  const lines = [
    `# PRISM UI audit`, '', `${BASE} · ${new Date().toISOString()} · ${results.length} page views (${VIEWS.map((v) => v.name).join(', ')}${ADMIN_KEY ? ' + admin' : ''})`, '',
    `- **Errors:** ${bad.length ? `${bad.length} page views` : 'none'}`,
    `- **Sideways scrolling:** ${wide.length ? `${wide.length} page views` : 'none'}`,
    `- **Accessibility findings:** ${a11y.length ? `${a11y.length} page views` : 'none'}`, '',
    '| Page | View | Errors | Overflow | A11y | FCP | LCP | Requests | Screenshot |', '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.page} | ${r.view} | ${r.errors.length || ''} | ${r.overflow > 1 ? `${r.overflow}px` : ''} | ${r.a11y.length || ''} | ${r.fcpMs ?? ''} | ${r.lcpMs ?? ''} | ${r.requests} | [png](${r.file}) |`),
  ];
  for (const r of results.filter((x) => x.errors.length || x.overflow > 1 || x.a11y.length)) {
    lines.push('', `## ${r.page} · ${r.view}`);
    for (const e of r.errors) lines.push(`- error: ${e}`);
    if (r.overflow > 1) lines.push(`- ${r.overflow}px wider than the screen: ${r.wide.join(', ')}`);
    for (const a of r.a11y) lines.push(`- a11y: ${a}`);
  }
  fs.writeFileSync(path.join(OUT, 'report.md'), `${lines.join('\n')}\n`);
  console.log(`${results.length} page views · ${bad.length} with errors · ${wide.length} overflowing · ${a11y.length} with a11y findings → ${path.join(OUT, 'report.md')}`);
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
