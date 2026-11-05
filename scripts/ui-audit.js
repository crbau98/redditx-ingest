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
 *
 * Phone mode (repeatable overflow / tap-target / safe-area audit of the PUBLIC app, no admin):
 *
 *     node scripts/ui-audit.js http://localhost:3999 --phone --out ./ui-audit-phone [--only home,reels] [--strict]
 *
 * Every public screen at 360x740, 390x844, 430x932, 768x1024 (+ 1280x800 as the desktop regression check), in both
 * themes (390 and desktop), with touch emulation and a simulated iPhone notch / home indicator (env(safe-area-inset-*)
 * is rewritten to 47px / 34px in the served stylesheet, because Playwright cannot emulate it). Per screen it measures:
 * sideways overflow, content silently clipped at the side, interactive elements under 44px, text under 12px, form
 * fields under 16px (iOS zooms the page on focus), content hidden behind the bottom bar, pinned controls under the
 * notch / home indicator, and sticky chrome as a share of the viewport. --strict exits 1 when a phone screen is over
 * BUDGETS. Writes phone-report.md / phone-report.json / one PNG per screen.
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

// ---------------------------------------------------------------------------------------------- phone mode
const PHONE_VIEWPORTS = [
  { name: '360x740', viewport: { width: 360, height: 740 }, phone: true }, { name: '390x844', viewport: { width: 390, height: 844 }, phone: true },
  { name: '430x932', viewport: { width: 430, height: 932 }, phone: true }, { name: '768x1024', viewport: { width: 768, height: 1024 }, phone: true },
  { name: '1280x800', viewport: { width: 1280, height: 800 }, phone: false },
];
// Safe areas of an iPhone in portrait with the home indicator; Playwright cannot emulate env(safe-area-inset-*).
const NOTCH = { top: 47, bottom: 34 };
// What a phone screen may show under --strict.
const BUDGETS = { overflow: 0, clipped: 0, tapSmall: 0, textSmall: 0, inputSmall: 0, navCover: 0, underNotch: 0, stickyPct: 22 };

/** In-page measurements of the screen as it stands (runs inside the page, so it cannot use anything outside itself). */
const PHONE_CHECKS = async ({ notchTop, notchBottom, scrollTest }) => {
  const vw = innerWidth; const vh = innerHeight;
  const vis = (el) => (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true);
  const where = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
  const group = (rows) => { const m = new Map(); for (const r of rows) { const e = m.get(r.key) || { ...r, n: 0 }; e.n++; m.set(r.key, e); } return [...m.values()].sort((a, b) => b.n - a.n); };
  const out = {};
  out.overflow = Math.max(0, document.scrollingElement.scrollWidth - vw);
  // 1. content cut off at the side with no scroll container to reach it (a silent overflow:hidden)
  const clipped = [];
  const scrolls = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const o = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(o.overflowX)) return true;
      if (o.position === 'fixed') return false;
    }
    return false;
  };
  for (const el of document.querySelectorAll('main *, .appbar *, .bottomnav *')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || (r.right <= vw + 1 && r.left >= -1) || !vis(el) || scrolls(el) || getComputedStyle(el).position === 'fixed') continue;
    clipped.push({ key: where(el), el: where(el), right: Math.round(r.right), left: Math.round(r.left) });
  }
  out.clipped = clipped.length; out.clippedList = group(clipped).slice(0, 5);
  // 2. interactive targets (WCAG 2.5.5 / Apple HIG 44pt). Inline links inside running text are exempt.
  const tap = [];
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=link], [role=menuitem], [tabindex]:not([tabindex="-1"])';
  for (const el of document.querySelectorAll(SEL)) {
    if (!vis(el) || el.closest('[aria-hidden="true"], [inert], .sr-only')) continue;
    if (getComputedStyle(el).display === 'inline' && el.tagName === 'A') continue;
    if ((el.type === 'checkbox' || el.type === 'radio') && el.labels && el.labels.length) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.height < 43.5 || r.width < 43.5) tap.push({ key: `${where(el)} ${Math.round(r.width)}x${Math.round(r.height)}`, el: where(el), w: Math.round(r.width), h: Math.round(r.height), label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24) });
  }
  out.tapSmall = tap.length; out.tapList = group(tap).slice(0, 8);
  // 3. text under 12px
  const small = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(el.tagName) || el.closest('svg') || !vis(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs > 0 && fs < 11.95) small.push({ key: `${where(el)} ${fs}px`, el: where(el), px: fs, text: n.nodeValue.trim().slice(0, 24) });
  }
  out.textSmall = small.length; out.textList = group(small).slice(0, 8);
  // 4. form fields under 16px zoom the page on focus in iOS Safari
  const inp = [];
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]), textarea, select')) {
    if (!vis(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 15.95) inp.push({ key: `${where(el)} ${fs}px`, el: where(el), px: fs });
  }
  out.inputSmall = inp.length; out.inputList = group(inp).slice(0, 5);
  // 5. pinned controls that start inside the notch / home indicator (scrolling content just moves out from under them)
  const under = [];
  const pinned = (el) => { for (let p = el; p && p !== document.documentElement; p = p.parentElement) { const ps = getComputedStyle(p).position; if (ps === 'fixed' || ps === 'sticky') return true; } return false; };
  for (const el of document.querySelectorAll(SEL)) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.right < 0 || r.left > vw || !pinned(el)) continue;
    if (r.top < notchTop - 0.5 && r.bottom > 0) under.push({ key: `top ${where(el)}`, el: where(el), edge: 'top', at: Math.round(r.top) });
    if (r.bottom > vh - notchBottom + 0.5 && r.top < vh) under.push({ key: `bottom ${where(el)}`, el: where(el), edge: 'bottom', at: Math.round(r.bottom) });
  }
  out.underNotch = notchTop || notchBottom ? under.length : 0; out.underList = group(under).slice(0, 6);
  // 6. sticky chrome as a share of the viewport, measured after scrolling
  if (scrollTest) {
    const room = document.scrollingElement.scrollHeight - vh;
    if (room > 200) { window.scrollTo(0, Math.min(300, room)); await new Promise((r) => setTimeout(r, 200)); window.scrollTo(0, Math.min(700, room)); await new Promise((r) => setTimeout(r, 600)); }
  }
  let topEdge = 0; let botEdge = vh;
  const chrome = [];
  const pins = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if ((cs.position !== 'fixed' && cs.position !== 'sticky') || !vis(el) || cs.pointerEvents === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.5 || r.height < 24 || r.height > vh * 0.6 || r.bottom <= 0 || r.top >= vh) continue;
    pins.push({ el, r });
  }
  // stacked top chrome: an element pinned under another counts too (app bar + sticky filter bar)
  pins.sort((a, b) => a.r.top - b.r.top);
  for (const { el, r } of pins) {
    if (r.top <= topEdge + 1 && r.top < vh / 2) { topEdge = Math.max(topEdge, r.bottom); chrome.push(`${where(el)} top ${Math.round(r.height)}px`); }
    else if (r.top >= vh / 2 && r.bottom >= vh - 60) { botEdge = Math.min(botEdge, r.top); chrome.push(`${where(el)} bottom ${Math.round(r.height)}px`); }
  }
  out.stickyTop = Math.round(topEdge); out.stickyBottom = Math.round(vh - botEdge);
  // the notch / home indicator belong to the phone, not to the app: only the app's own pinned chrome counts
  out.stickyPct = Math.round(((Math.max(0, topEdge - notchTop) + Math.max(0, vh - botEdge - notchBottom)) / vh) * 1000) / 10; out.stickyList = chrome.slice(0, 6);
  // 7. content hidden behind the bottom bar at the very end of the page
  const bn = document.querySelector('.bottomnav');
  window.scrollTo(0, document.scrollingElement.scrollHeight);
  await new Promise((r) => setTimeout(r, 300));
  out.navCover = 0;
  // Reels is a full-bleed media layer by design (its own controls are checked below)
  if (bn && getComputedStyle(bn).display !== 'none' && !document.body.classList.contains('reels-mode')) {
    const top = bn.getBoundingClientRect().top; let lowest = 0; let who = '';
    for (const el of document.querySelectorAll('main > *, main > * > *, .footer > *')) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom < vh + 1 && r.bottom > lowest) { lowest = r.bottom; who = where(el); }
    }
    const atEnd = document.scrollingElement.scrollHeight - document.scrollingElement.scrollTop - vh <= 2;
    out.navCover = atEnd ? Math.max(0, Math.round(lowest - top)) : 0; out.navCoverBy = who;
  }
  window.scrollTo(0, 0);
  out.coarse = matchMedia('(pointer: coarse)').matches;
  return out;
};

/** One screen at one viewport and theme. `prep(page)` gets the page into a state (opens a dialog). */
async function phoneScreen(browser, vp, theme, label, route, ids, prep, { gate = false } = {}) {
  const ctx = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.phone ? 3 : 1, isMobile: vp.phone, hasTouch: vp.phone, colorScheme: theme, serviceWorkers: 'block' });
  await ctx.addInitScript(({ theme: t, favs, follows }) => {
    try {
      localStorage.setItem('prism.theme', JSON.stringify(t)); localStorage.setItem('prism.introDone', 'true'); localStorage.setItem('prism.reelsHint', 'true');
      if (!localStorage.getItem('prism.favs')) { localStorage.setItem('prism.favs', JSON.stringify(favs)); localStorage.setItem('prism.follows', JSON.stringify(follows)); }
    } catch { /* storage blocked */ }
  }, { theme, favs: ids.media.slice(0, 12), follows: ids.creators.slice(0, 4).map((c) => ({ id: c.id, handle: c.handle, name: c.display_name, seen: new Date(Date.now() - 864e5).toISOString() })) });
  if (vp.phone) {
    // the notch: safe-area insets cannot be emulated, so the served stylesheet gets the values of an iPhone
    await ctx.route(/\/css\/bundle\.css$/, async (r2) => {
      const res = await r2.fetch();
      const css = (await res.text()).replace(/env\(safe-area-inset-top(?:,[^)]*)?\)/g, `${NOTCH.top}px`).replace(/env\(safe-area-inset-bottom(?:,[^)]*)?\)/g, `${NOTCH.bottom}px`);
      await r2.fulfill({ response: res, body: css });
    });
  }
  if (!gate) await ctx.addCookies([{ name: 'prism_age', value: '1', url: BASE }]); // a visitor who already confirmed their age
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message.slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
  await page.goto(`${BASE}/#${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(gate ? '.age-card' : '#main > *', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1300);
  if (prep) await prep(page);
  await page.waitForTimeout(700);
  const file = `${label}-${vp.name}-${theme}.png`;
  await page.screenshot({ path: path.join(OUT, file) });
  const checks = await page.evaluate(PHONE_CHECKS, { notchTop: vp.phone ? NOTCH.top : 0, notchBottom: vp.phone ? NOTCH.bottom : 0, scrollTest: true });
  await ctx.close();
  return { page: label, route, viewport: vp.name, theme, file, phone: vp.phone, errors: [...new Set(errors)], ...checks };
}

async function phoneAudit() {
  fs.mkdirSync(OUT, { recursive: true });
  const getJson = async (p) => (await fetch(`${BASE}${p}`, { headers: { cookie: 'prism_age=1' } })).json();
  const media = ((await getJson('/api/media?limit=12')).items || []).map((m) => m.id);
  const creators = ((await getJson('/api/creators?limit=6')).items || []);
  if (!media.length || !creators.length) throw new Error('the app has no media / creators: seed it first (scripts/seed-demo.js)');
  const ids = { media, creators };
  const openSettings = async (pg) => { await pg.getByRole('button', { name: 'Display settings' }).first().click(); await pg.waitForTimeout(500); };
  const SCREENS = [
    ['home', '/'], ['browse', '/browse'], ['creators', '/creators'], ['creator', `/creator/${creators[0].id}`], ['explore', '/explore'], ['reels', '/reels'],
    ['find', '/find'], ['saved', '/saved'], ['following', '/following'], ['lightbox', `/explore?m=${media[0]}`], ['settings', '/', openSettings], ['age-gate', '/', null, { gate: true }],
  ];
  const only = opt('only', '');
  let browser = await chromium.launch({ headless: !HEADED });
  const results = [];
  for (const [label, route, prep, extra] of SCREENS) {
    if (only && !only.split(',').includes(label)) continue;
    for (const vp of PHONE_VIEWPORTS) {
      for (const theme of (vp.name === '390x844' || !vp.phone ? ['dark', 'light'] : ['dark'])) {
        process.stderr.write(`${label} · ${vp.name} · ${theme}\n`);
        // a screen that crashes the browser (a long audit on a small machine) is retried once on a fresh one
        for (let attempt = 1; ; attempt++) {
          try { results.push(await phoneScreen(browser, vp, theme, label, route, ids, prep, extra)); break; } catch (e) {
            if (attempt >= 2) throw e;
            process.stderr.write(`  retrying (${String(e.message).split('\n')[0]})\n`);
            await browser.close().catch(() => {}); browser = await chromium.launch({ headless: !HEADED });
          }
        }
      }
    }
  }
  await browser.close();
  const payload = { base: BASE, at: new Date().toISOString(), budgets: BUDGETS, results };
  fs.writeFileSync(path.join(OUT, 'phone-report.json'), JSON.stringify(payload, null, 2));
  const over = (r) => (r.phone ? Object.keys(BUDGETS).filter((k) => r[k] > BUDGETS[k]) : []);
  const lines = ['# PRISM phone audit', '', `${BASE} · ${payload.at} · notch ${NOTCH.top}px / home indicator ${NOTCH.bottom}px simulated on phone viewports`, '',
    '| Screen | Viewport | Theme | Overflow | Clipped | Tap<44 | Text<12 | Input<16 | Nav covers | Under notch | Sticky % | Errors |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.page} | ${r.viewport} | ${r.theme} | ${r.overflow} | ${r.clipped} | ${r.tapSmall} | ${r.textSmall} | ${r.inputSmall} | ${r.navCover} | ${r.underNotch} | ${r.stickyPct} | ${r.errors.length} |`)];
  for (const r of results.filter((x) => over(x).length || x.errors.length)) {
    lines.push('', `## ${r.page} · ${r.viewport} · ${r.theme}: over budget: ${over(r).join(', ') || '-'}`);
    for (const e of r.errors) lines.push(`- error: ${e}`);
    for (const t of r.clippedList || []) lines.push(`- clipped: ${t.el} (x ${t.n}) right=${t.right} left=${t.left}`);
    for (const t of r.tapList || []) lines.push(`- tap ${t.w}x${t.h}: ${t.el} "${t.label}" (x ${t.n})`);
    for (const t of r.textList || []) lines.push(`- text ${t.px}px: ${t.el} "${t.text}" (x ${t.n})`);
    for (const t of r.inputList || []) lines.push(`- input ${t.px}px: ${t.el} (x ${t.n})`);
    for (const t of r.underList || []) lines.push(`- ${t.edge} safe area: ${t.el} at ${t.at}px (x ${t.n})`);
    if (r.navCover) lines.push(`- bottom bar covers ${r.navCover}px of ${r.navCoverBy}`);
    if (r.stickyPct > BUDGETS.stickyPct) lines.push(`- sticky chrome ${r.stickyPct}%: ${r.stickyList.join(', ')}`);
  }
  fs.writeFileSync(path.join(OUT, 'phone-report.md'), `${lines.join('\n')}\n`);
  const totals = Object.keys(BUDGETS).map((k) => `${k} ${results.filter((r) => over(r).includes(k)).length}`);
  console.log(`${results.length} screens · phone screens over budget: ${totals.join(', ')} → ${path.join(OUT, 'phone-report.md')}`);
  process.exit(args.includes('--strict') && results.some((r) => over(r).length || r.errors.length) ? 1 : 0);
}

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
  if (args.includes('--phone')) return phoneAudit();
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
