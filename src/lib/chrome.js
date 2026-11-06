'use strict';
/**
 * Chrome over plain CDP: PRISM's stealth renderer.
 *
 * Why a third browser: Playwright and Browser4 both drive the browser through an automation layer (Playwright's own CDP
 * shim; Browser4's CLI). Anti-bot gates fingerprint that layer, not just the page: in the 2026 benchmark of seven stealth
 * tools against 31 live Cloudflare targets, only the one that spoke raw CDP to a system Chrome passed every gate
 * (nodriver, 28/31; vanilla Playwright 24/31). This module is that shape in Node: launch Chrome, talk WebSocket to its
 * DevTools port, navigate, wait, scroll, hand back the finished DOM. No Playwright, no Puppeteer, no driver binary.
 *
 * It is a RENDERER, not a scraper-policy bypass:
 *   - lib/browser4.assertAllowed() runs first (takedowns, private/loopback hosts, non-http(s), credentials in the URL);
 *   - every request the browser makes goes through PRISM's guard proxy (lib/guardproxy.js), so redirect hops, images,
 *     scripts, XHR and WebSockets cannot reach a private address or a takedown host either;
 *   - robots.txt, noindex / nopin and every downstream gate behave exactly as for the plain path (the caller parses this
 *     DOM with the same extractPage).
 *
 * It also waits out a bot challenge instead of giving up: a managed Cloudflare challenge, DDoS-Guard or DataDome page
 * usually clears itself in a few seconds once the fingerprint passes, and a captcha widget is handed to
 * lib/captchasolver.js when a key is configured. Every step is reported so the run note can name the tier that acted.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const limiter = require('./limiter');
const guard = require('./guardproxy');
const challenge = require('./challenge');
const captchasolver = require('./captchasolver');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = (msg, extra = {}) => Object.assign(new Error(msg), { skip: true, ...extra });

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

const executable = () => {
  const configured = String(config.chrome.path || '').trim();
  if (configured) return fs.existsSync(configured) ? configured : null;
  for (const p of CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch { /* next */ } }
  return null;
};
const available = () => !!executable();
const enabled = () => !!config.chrome.enabled && available();

/* --------------------------------------------------------------- tiny CDP client */
class Client {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { ok, fail, timer } = this.pending.get(m.id);
        this.pending.delete(m.id); clearTimeout(timer);
        if (m.error) fail(new Error(m.error.message)); else ok(m.result);
      } else if (m.method) {
        for (const fn of this.listeners.get(m.method) || []) { try { fn(m.params); } catch { /* listener */ } }
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { ok, fail, timer });
    });
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

/* ------------------------------------------------------------------- the browser */
let browser = null;
let launching = null;
let idleTimer = null;
let queue = Promise.resolve();

function profileDir() {
  const dir = path.join(config.dataDir, 'chrome-profile');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* read-only data dir: fall back to a temp profile */ }
  return dir;
}

async function launch() {
  const bin = executable();
  if (!bin) throw skip('Chrome is not installed on this host (set CHROME_PATH)');
  const dir = fs.existsSync(path.join(config.dataDir, 'chrome-profile')) ? profileDir() : fs.mkdtempSync(path.join(os.tmpdir(), 'prism-chrome-'));
  const proxy = await guard.start();
  const args = [
    `--remote-debugging-port=0`,
    `--user-data-dir=${dir}`,
    `--proxy-server=${proxy.server}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--disable-dev-shm-usage', // containers give /dev/shm 64 MB; Chrome crashes without this
    '--disable-blink-features=AutomationControlled', '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--mute-audio', '--hide-scrollbars', '--disable-gpu', '--window-size=1400,1600', 'about:blank',
  ];
  // Chrome refuses to start as root with the sandbox on (the Docker image runs as root on purpose).
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');
  if (!config.chrome.headed) args.unshift('--headless=new');
  const proc = spawn(bin, args, { stdio: 'ignore' });
  proc.on('exit', () => { browser = null; });
  const portFile = path.join(dir, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 120; i++) {
    try {
      const line = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (line) { port = Number(line); break; }
    } catch { /* not written yet */ }
    if (proc.exitCode !== null) break;
    await sleep(250);
  }
  if (!port) { try { proc.kill(); } catch { /* gone */ } throw new Error('Chrome did not open its DevTools port'); }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browser = { proc, port, version, proxy };
  return browser;
}

async function ensure() {
  if (browser && browser.proc.exitCode === null) return browser;
  if (launching) return launching;
  launching = launch().finally(() => { launching = null; });
  return launching;
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { close().catch(() => {}); }, config.chrome.idleMs).unref?.();
}
async function close() {
  const b = browser;
  browser = null;
  if (!b) return;
  try { await fetch(`http://127.0.0.1:${b.port}/json/close/`); } catch { /* no target */ }
  try { b.proc.kill(); } catch { /* gone */ }
}

/* ------------------------------------------------------------------- one render */
async function readPage(url, opts = {}) {
  const b = await ensure();
  const href = await require('./browser4').assertAllowed(url);
  if (opts.allowUrl && !(await opts.allowUrl(href))) throw skip('robots.txt disallows this page');
  const target = await (await fetch(`http://127.0.0.1:${b.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('CDP socket did not open')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); ok(); });
    ws.addEventListener('error', (e) => { clearTimeout(timer); fail(e.error || new Error('CDP socket error')); });
  });
  const c = new Client(ws);
  const notes = [];
  try {
    for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) await c.send(m);
    // Proxy credentials: the guard proxy demands them on every CONNECT. Fetch interception is what makes Chrome ask for
    // them (handleAuthRequests); it needs at least one pattern, so every request is passed straight through.
    await c.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    c.on('Fetch.requestPaused', (p) => { c.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); });
    c.on('Fetch.authRequired', (p) => {
      c.send('Fetch.continueWithAuth', {
        requestId: p.requestId,
        authChallengeResponse: { response: 'ProvideCredentials', username: b.proxy.username, password: b.proxy.password },
      }).catch(() => {});
    });
    await c.send('Emulation.setUserAgentOverride', {
      userAgent: challenge.BROWSER_UA, acceptLanguage: 'en-US,en;q=0.9', platform: 'MacIntel',
    });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1600, deviceScaleFactor: 1, mobile: false });

    const loaded = new Promise((ok) => { c.on('Page.loadEventFired', ok); setTimeout(ok, config.chrome.timeoutMs); });
    await c.send('Page.navigate', { url: href }, config.chrome.timeoutMs);
    await loaded;
    let ms = Number(opts.waitMs ?? 3500);
    await sleep(ms);

    const scrolls = Math.max(0, Math.min(40, Number(opts.scrolls ?? 0)));
    for (let i = 0; i < scrolls; i++) {
      await c.send('Runtime.evaluate', { expression: 'window.scrollBy(0, window.innerHeight * 0.9)' }).catch(() => {});
      await sleep(1100);
    }

    const grab = async () => (await c.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true })).result.value || '';
    let html = await grab();
    let seen = challenge.detect({ status: 200, html });
    if (seen && challenge.isChallenge(seen.kind)) {
      // Give a managed challenge its own time: it usually clears itself once the fingerprint passes.
      const deadline = Date.now() + config.chrome.challengeWaitMs;
      while (seen && Date.now() < deadline) {
        await sleep(1500); html = await grab(); seen = challenge.detect({ status: 200, html });
      }
      if (seen && seen.kind === 'anubis') {
        notes.push('Anubis gate: solved as a proof of work, not in the browser');
        const solved = await challenge.solveAnubis(href, { maxMs: 15000 }).catch(() => null);
        if (solved) {
          for (const part of solved.cookie.split('; ')) {
            const [name, ...rest] = part.split('=');
            if (!name || !rest.length) continue;
            await c.send('Network.setCookie', { name, value: rest.join('='), domain: new URL(href).hostname, path: '/' }).catch(() => {});
          }
          await c.send('Page.navigate', { url: href }, config.chrome.timeoutMs).catch(() => {});
          await sleep(Math.max(2500, ms)); html = await grab(); seen = challenge.detect({ status: 200, html });
        }
      }
      if (seen && seen.solvable === 'token' && captchasolver.configured()) {
        const cfgS = require('../settings').get();
        if (cfgS.captchaSolver !== 'fallback') notes.push('captcha widget: the captcha solver is off');
        else {
          const token = await captchasolver.solveForPage(html, href, { budget: cfgS.captchaSolverBudget }).catch((e) => { notes.push(`captcha solver: ${e.message}`); return null; });
          if (token) {
            await c.send('Runtime.evaluate', { expression: captchasolver.injectScript(token) }).catch(() => {});
            await sleep(4000); html = await grab(); seen = challenge.detect({ status: 200, html });
            notes.push('captcha solved through the token service');
          }
        }
      }
      if (seen && challenge.isChallenge(seen.kind)) notes.push(`${seen.label} still stood after ${Math.round(config.chrome.challengeWaitMs / 1000)}s`);
    }
    return { url: href, html, scrolls, challenge: seen ? seen.kind : null, notes };
  } finally {
    c.close();
    try { await fetch(`http://127.0.0.1:${b.port}/json/close/${target.id}`); } catch { /* already gone */ }
  }
}

/**
 * renderPages(): the same contract as lib/playwright and lib/browser4, so lib/render.js can pick this engine and every
 * caller (web.js, link-in-bio, site expansion) keeps working unchanged.
 */
async function renderPages(url, opts = {}) {
  if (!enabled()) throw skip('the Chrome renderer is not enabled on this host (CHROME_PATH / CHALLENGE_BROWSER=1)');
  const run = queue.then(async () => {
    const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
    const page = await limiter.schedule(`chrome:${host}`, 1500, () => readPage(url, opts));
    let pages = [page];
    // Follow "next" links on the same site, exactly like the other engines, up to `pages`.
    const want = Math.max(1, Math.min(10, Number(opts.pages || 1)));
    if (want > 1) {
      let next = nextLink(page.html, page.url);
      for (let i = 1; i < want && next; i++) {
        try {
          const p = await readPage(next, { ...opts, scrolls: opts.scrolls });
          pages.push(p);
          next = nextLink(p.html, p.url);
        } catch { break; }
      }
    }
    return { via: 'chrome-cdp', pages, notes: pages.flatMap((p) => p.notes || []).filter(Boolean) };
  });
  queue = run.catch(() => {});
  try { return await run; } finally { touchIdle(); }
}

/** The rel=next / "next page" link of a page, on the same site. */
function nextLink(html, base) {
  let host = '';
  try { host = new URL(base).hostname.toLowerCase(); } catch { return null; }
  const rel = String(html).match(/<link[^>]+rel=["']next["'][^>]*href=["']([^"']+)["']/i)
    || String(html).match(/<a[^>]+rel=["']next["'][^>]*href=["']([^"']+)["']/i);
  if (!rel) return null;
  try {
    const u = new URL(rel[1].replace(/&amp;/g, '&'), base);
    return u.hostname.toLowerCase() === host ? u.href : null;
  } catch { return null; }
}

async function status() {
  return {
    enabled: enabled(),
    available: available(),
    executable: executable(),
    headed: !!config.chrome.headed,
    running: !!(browser && browser.proc.exitCode === null),
    version: browser ? browser.version.Browser : null,
    challengeWaitMs: config.chrome.challengeWaitMs,
  };
}

module.exports = { available, enabled, renderPages, readPage, status, close, nextLink, _executable: executable };
