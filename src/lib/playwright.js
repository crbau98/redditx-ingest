'use strict';
/**
 * Playwright: PRISM's second engine for pages whose media only exists after their JavaScript has run (lib/browser4.js is
 * the first; lib/render.js picks one). An in-process Chromium driven through the Playwright library: no external CLI, no
 * JVM, and one fresh, isolated browser context per page.
 *
 * Same contract as Browser4's renderPages (lib/render.js relies on it): the page is loaded, scrolled to the bottom a few
 * times, its "next page" links followed on the same site, and the finished DOM handed back as HTML to the same parser
 * the plain path uses, so robots.txt, opt-outs, takedowns and every pipeline gate behave identically.
 *
 * Network policy is stronger than Browser4's, because the browser's traffic all goes through lib/guardproxy.js (a
 * DNS-validated proxy in this process): a redirect hop or sub-request to a private address, a public-looking name that
 * resolves to one, or a hop to a takedown host is refused before anything is sent. Service workers
 * are blocked, WebRTC may not use non-proxied UDP and QUIC is off, so nothing leaves the browser around the proxy.
 * A bot-challenge page ends the render; nothing is solved or evaded.
 *
 * Remote pages (Bright Data's Browser API) are read over CDP with chromium.connectOverCDP, one connection per page.
 */
const fs = require('fs');
const config = require('../config');
const limiter = require('./limiter');
const guard = require('./guardproxy');
const browser4 = require('./browser4');

const { sameSite, scrollScript, documentScript } = browser4;
// Same policy as Browser4 (lib/browser4.assertAllowed); config.playwright.testAllowHosts lets tests reach a fixture by name.
const assertAllowed = (u) => {
  let h = ''; try { h = new URL(u).hostname.toLowerCase(); } catch { /* assertAllowed reports it */ }
  return (config.playwright.testAllowHosts || []).includes(h) ? Promise.resolve(new URL(u).href) : browser4.assertAllowed(u);
};
const HOST_GAP_MS = 2000;
const skip = (msg, extra = {}) => Object.assign(new Error(msg), { skip: true, ...extra });
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

let pw = null;
function lib() {
  if (pw !== null) return pw;
  try { pw = require('playwright'); } catch { try { pw = require('playwright-core'); } catch { pw = false; } }
  return pw;
}

const enabled = () => !!config.playwright.enabled;

/* ------------------------------------------------------------ the browser */
let browser = null;
let launching = null;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;
  launching = (async () => {
    const p = lib();
    if (!p) throw skip('Playwright is not installed (npm i playwright)');
    const proxy = await guard.start();
    const b = await p.chromium.launch({
      headless: !config.playwright.headed,
      executablePath: config.playwright.executablePath || undefined,
      proxy,
      args: [
        '--proxy-bypass-list=<-loopback>',        // loopback goes through the guard too (Chromium exempts it by default)
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-background-networking',
      ],
    });
    b.on('disconnected', () => { if (browser === b) browser = null; });
    browser = b;
    return b;
  })();
  try { return await launching; } finally { launching = null; }
}

// One render at a time (memory, and politeness); a render that waited too long for its turn gives up (see renderPages).
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const CHALLENGE = `(() => {
  const t = (document.title || '').toLowerCase();
  if (/just a moment|attention required|verify you are (a )?human|are you a robot|security check|ddos-guard/.test(t)) return true;
  if (document.querySelector('#challenge-form, #cf-challenge-running, .cf-turnstile, iframe[src*="challenges.cloudflare.com"], #px-captcha, .g-recaptcha[data-size="invisible"]') && document.body && document.body.innerText.length < 2000) return true;
  return false;
})()`;

/** Load one page in `page`; @returns the same shape as Browser4's renderOne */
async function readPage(page, url, { scrolls, settleMs, deadline, started }) {
  const left = () => Math.max(1500, deadline - Date.now());
  let resp;
  try {
    resp = await limiter.schedule(`browser4:${hostOf(url)}`, HOST_GAP_MS, () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(config.playwright.timeoutMs, left()) }));
  } catch (e) {
    const refused = guard.refusedSince(started);
    if (refused.length) throw skip(`the page led to a refused address (${refused[refused.length - 1].host}: ${refused[refused.length - 1].reason})`);
    throw Object.assign(new Error(`could not load the page: ${String(e.message).split('\n')[0]}`), { status: 0 });
  }
  // A plain-http hop the guard refused comes back as the guard's own 403 page: that is a refusal, not content.
  const refusedBy = resp && resp.headers()['x-prism-refused'];
  if (refusedBy) throw skip(`the page led to a refused address (${hostOf(resp.url()) || 'unknown'}: ${refusedBy})`);
  const unreachable = resp && resp.headers()['x-prism-unreachable'];
  if (unreachable) throw Object.assign(new Error(`could not reach ${hostOf(resp.url()) || 'the page'} (${unreachable})`), { status: 0 });
  if (await page.evaluate(CHALLENGE).catch(() => false)) throw skip('the site answered with a bot-challenge page', { challenge: true });
  await page.waitForLoadState('networkidle', { timeout: Math.min(15000, left()) }).catch(() => { /* a live connection never idles */ });
  let scrolled = { rounds: 0, height: 0 };
  if (scrolls > 0) {
    try { scrolled = (await Promise.race([page.evaluate(scrollScript(scrolls, settleMs)), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('scroll timed out'), { timedOut: true })), Math.min(scrolls * (settleMs + 1500) + 5000, left())))])) || scrolled; } catch (e) { if (e.timedOut) scrolled = { rounds: -1, height: 0 }; else throw e; }
  }
  const doc = await page.evaluate(documentScript);
  if (!doc || typeof doc.html !== 'string' || !doc.html) throw new Error('the browser returned no page');
  await assertAllowed(doc.url); // where it really ended up
  return { requested: url, url: doc.url, title: doc.title || null, html: doc.html, next: doc.next || null, scrolls: scrolled.rounds };
}

/** Pages from `first` on, following same-site "next page" links. `open(fn)` runs fn(page) on a fresh page and cleans up. */
async function loop(first, { scrolls, maxPages, settleMs, deadline, allowUrl, open }) {
  const pages = []; const notes = []; const seen = new Set();
  let target = first;
  while (target && pages.length < maxPages && !seen.has(target)) {
    seen.add(target);
    if (pages.length) {
      if (Date.now() > deadline - 8000) { notes.push('time budget reached'); break; }
      try { await assertAllowed(target); if (allowUrl && !(await allowUrl(target))) { notes.push(`next page not allowed: ${target}`); break; } } catch (e) { notes.push(`next page skipped: ${e.message}`); break; }
    }
    let p;
    const t = target;
    try { p = await open((page) => readPage(page, t, { scrolls, settleMs, deadline, started: Date.now() })); } catch (e) {
      if (pages.length && !e.challenge) { notes.push(`page ${pages.length + 1} failed: ${e.message}`); break; }
      throw e;
    }
    pages.push(p);
    target = p.next && sameSite(p.next, first) ? p.next : null;
  }
  return { pages, notes };
}

/**
 * @param {string} url
 * @param {{scrolls?, pages?, settleMs?, budgetMs?, allowUrl?, remote?}} opts as lib/browser4.renderPages
 * @returns {Promise<{via: 'playwright'|'brightdata-browser', pages, notes}>}
 */
function renderPages(url, opts = {}) {
  const scrolls = Math.min(Math.max(opts.scrolls ?? 8, 0), 40);
  const maxPages = Math.min(Math.max(opts.pages ?? 1, 1), 10);
  const settleMs = Math.min(Math.max(opts.settleMs ?? 700, 100), 5000);
  const budgetMs = opts.budgetMs || config.playwright.renderBudgetMs;
  const queuedAt = Date.now();
  return exclusive(async () => {
    if (!enabled()) throw skip('Playwright rendering is not enabled (PLAYWRIGHT_ENABLED)');
    if (Date.now() - queuedAt > config.playwright.maxQueueWaitMs) throw skip('the browser is busy with another page');
    const first = await assertAllowed(url);
    const deadline = Date.now() + budgetMs;
    if (opts.remote) {
      const wss = config.brightdata.browserWss;
      if (!wss) throw skip('BRIGHTDATA_BROWSER_WSS is not set');
      const p = lib();
      if (!p) throw skip('Playwright is not installed (npm i playwright)');
      // Bright Data's Browser API allows one navigation per connection: connect, read, disconnect, for every page.
      const r = await loop(first, {
        scrolls, maxPages, settleMs, deadline, allowUrl: opts.allowUrl,
        open: async (fn) => {
          let b;
          try { b = await p.chromium.connectOverCDP(wss, { timeout: 60000 }); } catch (e) { throw new Error(`cannot reach the remote browser: ${require('./brightdata').redact(String(e.message).split('\n')[0])}`); }
          try { const ctx = b.contexts()[0] || await b.newContext(); const page = await ctx.newPage(); return await fn(page); } finally { await b.close().catch(() => {}); }
        },
      });
      return { via: 'brightdata-browser', ...r };
    }
    const b = await getBrowser();
    const r = await loop(first, {
      scrolls, maxPages, settleMs, deadline, allowUrl: opts.allowUrl,
      open: async (fn) => {
        const ctx = await b.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 900 }, javaScriptEnabled: true });
        try { const page = await ctx.newPage(); return await fn(page); } finally { await ctx.close().catch(() => {}); }
      },
    });
    return { via: 'playwright', ...r };
  });
}

/* ------------------------------------------------------------------ status */
function available() {
  if (!enabled()) return { ok: false, reason: 'PLAYWRIGHT_ENABLED is not set' };
  const p = lib();
  if (!p) return { ok: false, reason: 'Playwright is not installed (npm i playwright)' };
  const exe = config.playwright.executablePath || (() => { try { return p.chromium.executablePath(); } catch { return ''; } })();
  if (!exe || !fs.existsSync(exe)) return { ok: false, reason: `no Chromium for Playwright at ${exe || '(unknown)'}: run "npx playwright install chromium" or set PLAYWRIGHT_CHROMIUM_PATH` };
  let version = null;
  try { version = require('playwright/package.json').version; } catch { try { version = require('playwright-core/package.json').version; } catch { version = null; } }
  return { ok: true, version, executable: exe };
}

async function status() {
  return { enabled: enabled(), ...available(), headed: config.playwright.headed, running: !!(browser && browser.isConnected()) };
}

async function close() {
  return exclusive(async () => { const b = browser; browser = null; if (b) await b.close().catch(() => {}); });
}

module.exports = { enabled, available, status, renderPages, close, CHALLENGE };
