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

/**
 * How Chromium is started (pure, so it can be tested without a browser):
 *   - as root only when there is no unprivileged user to drop to (config.chrome.uid); PRISM may be root, Chromium is not;
 *   - with Chromium's sandbox unless that cannot work: a root browser cannot have it, `CHROME_SANDBOX=off` turns it off, and
 *     in `auto` a launch that failed with it is retried without it (the container has no user namespaces);
 *   - with a minimal environment: the renderer never inherits PRISM's API keys and tokens.
 */
function launchPlan({ uid = process.getuid ? process.getuid() : -1, chrome = config.chrome, env = process.env, home, sandboxFailed = false } = {}) {
  const asUser = uid === 0 && chrome.uid > 0 ? { uid: chrome.uid, gid: chrome.gid > 0 ? chrome.gid : chrome.uid } : null;
  const root = uid === 0 && !asUser;
  const noSandbox = root || chrome.sandbox === 'off' || (chrome.sandbox === 'auto' && sandboxFailed);
  // HOME: the browser user cannot read root's home, so it gets its (writable) profile dir; otherwise the real one (Chrome on
  // macOS hangs on its first navigation with HOME pointed elsewhere).
  const ownHome = asUser ? home : (env.HOME || home);
  const childEnv = { PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: ownHome, LANG: env.LANG || 'en_US.UTF-8', TZ: env.TZ || 'UTC' };
  for (const k of ['DISPLAY', 'TMPDIR', 'FONTCONFIG_PATH']) if (env[k]) childEnv[k] = env[k];
  if (asUser && home) { childEnv.XDG_CONFIG_HOME = path.join(home, '.config'); childEnv.XDG_CACHE_HOME = path.join(home, '.cache'); }
  return { asUser, root, noSandbox, env: childEnv };
}

/** Hand a directory tree to the browser's user (root can; a no-op when it already owns it). */
function chownTree(dir, uid, gid) {
  try { if (fs.statSync(dir).uid === uid) return; } catch { return; }
  fs.chownSync(dir, uid, gid);
  for (const f of fs.readdirSync(dir, { recursive: true })) { try { fs.lchownSync(path.join(dir, f), uid, gid); } catch { /* vanished */ } }
}

let sandboxFailed = false; // auto mode: the sandbox could not start once, so this process launches without it

/**
 * Did Chromium fail BECAUSE of its sandbox? Only then may `auto` drop it, for the rest of the process. A timeout, a crash or a
 * missing binary is retried with the sandbox next time. Chromium's own wording, from its Linux sandbox and zygote startup.
 */
const SANDBOX_ERROR = /No usable sandbox|Failed to move to new namespace|setuid sandbox|SUID sandbox|zygote_host_impl_linux|credentials\.cc|sandbox_linux|unshare.*(?:Operation not permitted|EPERM)|(?:user|PID|network) namespaces? .*(?:not|unavailable|disabled)|Check failed: .*sandbox/i;
const isSandboxFailure = (e) => !!(e && SANDBOX_ERROR.test(String(e.chromeStderr || '')));

async function launch() {
  const bin = executable();
  if (!bin) throw skip('Chrome is not installed on this host (set CHROME_PATH)');
  const saved = path.join(config.dataDir, 'chrome-profile');
  const temp = !fs.existsSync(saved);
  const dir = temp ? fs.mkdtempSync(path.join(os.tmpdir(), 'prism-chrome-')) : saved;
  const plan = launchPlan({ home: dir, sandboxFailed });
  if (plan.asUser) chownTree(dir, plan.asUser.uid, plan.asUser.gid);
  try {
    return await start(bin, dir, temp, plan);
  } catch (e) {
    if (plan.noSandbox || config.chrome.sandbox !== 'auto' || !isSandboxFailure(e)) { if (temp) rmProfile(dir); throw e; }
    // No usable sandbox here (typically: no unprivileged user namespaces in the container). The strongest setup that
    // still works: an unprivileged browser user, without the sandbox. Logged once.
    sandboxFailed = true;
    require('../engine/events').log('WARN', `Chrome: its sandbox cannot start on this host (${String(e.message).slice(0, 80)}); running it without the sandbox${plan.asUser ? ` as uid ${plan.asUser.uid}` : ''}`);
    try { return await start(bin, dir, temp, launchPlan({ home: dir, sandboxFailed })); } catch (e2) { if (temp) rmProfile(dir); throw e2; }
  }
}
const rmProfile = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };

async function start(bin, dir, temp, plan) {
  const proxy = await guard.start();
  try { fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true }); } catch { /* none */ }
  const args = [
    `--remote-debugging-port=0`,
    `--user-data-dir=${dir}`,
    `--proxy-server=${proxy.server}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--disable-dev-shm-usage', // containers give /dev/shm 64 MB; Chrome crashes without this
    '--disable-blink-features=AutomationControlled', '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--mute-audio', '--hide-scrollbars', '--disable-gpu', '--window-size=1400,1600', 'about:blank',
  ];
  if (plan.noSandbox) args.unshift('--no-sandbox');
  if (!config.chrome.headed) args.unshift('--headless=new');
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: plan.env, ...(plan.asUser || {}) });
  // Startup stderr is kept (8 KB at most) to tell a sandbox failure from any other; afterwards it is drained and dropped.
  let stderr = ''; let keep = true;
  proc.stderr.on('data', (d) => { if (keep && stderr.length < 8192) stderr += d.toString('utf8'); });
  proc.on('exit', () => { if (browser && browser.proc === proc) browser = null; });
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
  keep = false;
  if (!port) {
    try { proc.kill(); } catch { /* gone */ }
    throw Object.assign(new Error(proc.exitCode !== null ? `Chrome exited at start (code ${proc.exitCode})` : 'Chrome did not open its DevTools port'), { chromeStderr: stderr });
  }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browser = { proc, port, version, proxy, dir, temp, sandbox: !plan.noSandbox, user: plan.asUser ? plan.asUser.uid : (process.getuid ? process.getuid() : null) };
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
  // A throwaway profile goes with its browser: one was left behind in the temp dir on every launch.
  if (b.temp) { await new Promise((r) => { if (b.proc.exitCode !== null) r(); else { b.proc.once('exit', r); setTimeout(r, 3000).unref(); } }); rmProfile(b.dir); }
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
    // A managed challenge (Cloudflare / DDoS-Guard / DataDome) usually clears itself once the fingerprint passes: give it
    // its own time. A proof of work and a captcha widget are not waited for - each has its own handler below, and waiting
    // would only burn the 15 s.
    if (seen && seen.solvable === 'browser') {
      const deadline = Date.now() + config.chrome.challengeWaitMs;
      while (seen && Date.now() < deadline) {
        await sleep(1500); html = await grab(); seen = challenge.detect({ status: 200, html });
      }
    }
    // Anubis is arithmetic, not a browser test: solve it in Node and hand the signed cookie to the page.
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
    // A captcha widget is the one wall a browser cannot pass alone: buy a token when the solver is on and configured.
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
    if (seen && challenge.isChallenge(seen.kind)) {
      notes.push(seen.solvable === 'browser'
        ? `${seen.label} still stood after ${Math.round(config.chrome.challengeWaitMs / 1000)}s`
        : `${seen.label} still stood`);
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
    sandbox: browser ? browser.sandbox : (sandboxFailed ? false : null),
    user: browser ? browser.user : null,
    version: browser ? browser.version.Browser : null,
    challengeWaitMs: config.chrome.challengeWaitMs,
  };
}

module.exports = { _launchPlan: launchPlan, _isSandboxFailure: isSandboxFailure, _launch: () => launch(), _resetSandbox: () => { sandboxFailed = false; }, available, enabled, renderPages, readPage, status, close, nextLink, _executable: executable };
