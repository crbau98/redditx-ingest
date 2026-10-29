'use strict';
/**
 * Browser4 client: reads pages in a real Chrome, driven through `browser4-cli` (https://browser4.io).
 *
 * Why: many pages only contain their media after their JavaScript has run (single-page apps, infinite scroll, lazy
 * galleries), so a plain download sees an empty shell. Here the page is loaded in a browser, scrolled to the bottom a
 * few times, and the finished DOM is handed back as HTML for the same parser the plain path uses (sources/web.js
 * extractPage) - so robots.txt, noindex / nopin opt-outs, takedowns and every later pipeline gate behave identically.
 *
 * What it will NOT do, on purpose:
 *   - fight access controls. A bot-challenge page (Cloudflare, CAPTCHA ...) ends the render; nothing is solved or evaded.
 *   - visit anything the rest of PRISM refuses to. A real browser does not go through lib/net.js's connect-time DNS
 *     guard, so: (1) the start URL and every "next page" URL are checked before navigation (private/internal addresses
 *     including what the name resolves to, leak sites, paywalled hosts, takedowns); (2) requests to literal private,
 *     loopback and link-local addresses and local names are ABORTED INSIDE THE BROWSER (CDP Fetch interception), which
 *     covers redirect hops, sub-resources and XHR before anything is sent; (3) where the browser ended up is checked
 *     again afterwards. Not covered: a public-looking NAME that resolves to a private address inside a redirect or
 *     sub-request, and redirect hops to leak/paywall hosts (found only afterwards) - firewall the host for those.
 *   - run a shell. The CLI is started with execFile and an argument array; page URLs are only ever arguments.
 *
 * One browser session serves the whole process, so renders are strictly serialised.
 */
const { execFile } = require('child_process');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const nodeNet = require('net');
const config = require('../config');
const net = require('./net');
const limiter = require('./limiter');
const leaks = require('./leaks');
const takedowns = require('./takedowns');
const { isPaywalledHost } = require('./brave');
const { redact } = require('./brightdata');

const MAX_HTML = 3_500_000;
const HOST_GAP_MS = 2000; // politeness: at least this long between two page loads on one host

/** An error that means "this page is not for us" (not a fault): the engine reports it as skipped, not failed. */
const skip = (msg, extra = {}) => Object.assign(new Error(msg), { skip: true, ...extra });

const enabled = () => !!config.browser4.enabled;
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const sameSite = (a, b) => !!hostOf(a) && hostOf(a) === hostOf(b);

/* --------------------------------------------------------------- URL policy */
/**
 * May PRISM send a browser to this URL? Throws a `skip` error when not.
 * Mirrors what lib/net.js enforces for plain downloads, plus the content policy (leaks, paywalls, takedowns).
 */
async function assertAllowed(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw skip('not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw skip(`only http(s) pages can be rendered (${u.protocol})`);
  if (u.username || u.password) throw skip('URLs with embedded credentials are not rendered');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isPrivateHost(host)) throw skip(`${host} is a private or internal host`);
  // Content policy first: it is offline, and a host we would refuse anyway should not even be looked up.
  const href = u.href;
  if (leaks.isLeakUrl(href)) throw skip('leak site');
  if (isPaywalledHost(href)) throw skip('paywalled host');
  if (takedowns.checkUrl(href)) throw skip('takedown');
  const viaTrustedProxyDns = config.outboundProxy && config.outboundProxyTrustDns;
  if (!config.allowPrivateHosts && !nodeNet.isIP(host) && !viaTrustedProxyDns) {
    let addrs;
    try { addrs = await dns.promises.lookup(host, { all: true }); } catch (e) { throw Object.assign(new Error(`cannot resolve ${host}: ${e.code || e.message}`), { status: 0 }); }
    if (!addrs.length || addrs.some((a) => net.isPrivateIp(a.address))) throw skip(`${host} resolves to a private address`);
  }
  return href;
}

/* ------------------------------------------------------------- CLI plumbing */
const workDir = () => {
  const dir = path.join(config.dataDir, 'browser4');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Run `browser4-cli -s <session> [--json] ...args`. Resolves with the parsed envelope (json) or stdout (text). */
function cli(args, { json = true, input = null, timeoutMs = config.browser4.timeoutMs, session = config.browser4.session } = {}) {
  const full = ['-s', session, ...(json ? ['--json'] : []), ...args];
  return new Promise((resolve, reject) => {
    const child = execFile(config.browser4.bin, full, {
      cwd: workDir(), timeout: Math.max(1000, timeoutMs), maxBuffer: 24 * 1024 * 1024, env: process.env, windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message).trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
        const e = new Error(redact(`browser4-cli ${args[0]}: ${err.killed ? `timed out after ${Math.round(timeoutMs / 1000)}s` : detail || err.message}`)); // a remote endpoint's credentials never reach a log
        e.code = err.code; e.status = 0; e.timedOut = !!err.killed;
        if (err.code === 'ENOENT') { e.message = `browser4-cli not found (${config.browser4.bin}); install it with: npm i -g browser4-cli && browser4-cli install`; e.missing = true; }
        return reject(e);
      }
      if (!json) return resolve(String(stdout));
      try { resolve(JSON.parse(String(stdout).trim().split('\n').filter(Boolean).pop())); } catch { reject(Object.assign(new Error(`browser4-cli ${args[0]}: unreadable output`), { status: 0 })); }
    });
    if (input !== null) child.stdin.end(input); else child.stdin.end();
  });
}

let chain = Promise.resolve();
/** Run `fn` after everything queued before it; a failure never blocks the queue. */
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

let opened = false;
async function ensureOpen(budgetMs) {
  if (opened) return;
  // `open` sets the display mode of a NEW session. First launch starts a JVM, so it gets more time than a normal call.
  await cli(['open', config.browser4.headed ? '--headed' : '--headless', 'about:blank'], { json: false, timeoutMs: Math.max(config.browser4.timeoutMs, Math.min(budgetMs, 120000)) });
  opened = true;
}

/** Run JavaScript in the page. Objects come back as objects; a JSON string is parsed. */
async function evalJs(source, { await: wait = false, timeoutMs, session } = {}) {
  const env = await cli(['eval', '--stdin', ...(wait ? ['--await'] : [])], { input: source, timeoutMs, session });
  let r = env && env.output ? env.output.result : null;
  if (typeof r === 'string' && /^[[{]/.test(r)) { try { r = JSON.parse(r); } catch { /* keep the string */ } }
  return r;
}

/* ------------------------------------------------- network-level private blocks */
// Glob patterns (the documented "plain text = contains" form does not match in Browser4 4.15.1; globs do). A leading `*`
// also matches the scheme, so http and https are both covered. Chrome canonicalises 2130706433 / 0x7f.1 to 127.0.0.1 first.
// Deliberately conservative: `*://10.*` also aborts a URL that merely CONTAINS "://10." (a query string, say).
// Not covered: 100.64.0.0/10 (carrier-grade NAT), which would need 64 patterns.
const PRIVATE_URL_PATTERNS = (() => {
  const v4 = ['127.', '0.', '10.', '169.254.', '192.168.', ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.`)];
  const out = v4.map((h) => `*://${h}*`);
  for (const h of ['127.', '10.', '169.254.', '192.168.', 'localhost']) out.push(`*@${h}*`); // credentials in front of the host
  out.push('*://localhost*', '*://*.localhost*', '*://*.local/*', '*://*.local:*', '*://*.internal/*', '*://*.internal:*',
    '*://[::*', '*://[fc*', '*://[fd*', '*://[fe8*', '*://[fe9*', '*://[fea*', '*://[feb*', '*://[ff*');
  return out;
})();
const blockPatterns = () => config.browser4.blockPatterns || PRIVATE_URL_PATTERNS; // blockPatterns: tests only

/**
 * Make sure the browser aborts requests to private addresses before anything navigates. Cheap to repeat (one listing call
 * when nothing is missing), so it runs before every render: routes belong to a tab and a restarted backend loses them.
 * Fails CLOSED: if the routes cannot be registered, the page is not loaded.
 */
async function ensureBlocks() {
  if (!config.browser4.blockPrivate) return;
  const patterns = blockPatterns();
  const listing = await cli(['network', 'routes'], { json: false, timeoutMs: 20000 });
  const have = new Set(String(listing).split('\n').map((l) => l.replace(/^abort\s+/, '').trim()));
  for (const pattern of patterns) {
    if (have.has(pattern)) continue;
    try { await cli(['network', 'route', pattern, '--abort'], { json: false, timeoutMs: 20000 }); } catch (e) {
      throw Object.assign(new Error(`cannot block private addresses in the browser (${e.message}); not loading the page`), { status: 0 });
    }
  }
}

/* ------------------------------------------------------- scripts run in-page */
const scrollScript = (rounds, settleMs) => `(async () => {
  let last = -1, stable = 0, done = 0;
  for (; done < ${rounds | 0}; done++) {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => setTimeout(r, ${settleMs | 0}));
    const h = document.documentElement.scrollHeight;
    if (h === last) { if (++stable >= 2) { done++; break; } } else { stable = 0; last = h; }
  }
  window.scrollTo(0, 0);
  return { rounds: done, height: last };
})()`;

// The finished DOM, the URL it ended up on, and the page's own "next page" link.
const documentScript = `(() => {
  const n = document.querySelector('link[rel~="next"], a[rel~="next"], a[aria-label="Next" i], a[aria-label="Next page" i], li.next > a, a.next, a.pagination-next');
  const html = '<!doctype html>' + document.documentElement.outerHTML;
  return { url: location.href, title: document.title, html: html.length > ${MAX_HTML} ? html.slice(0, ${MAX_HTML}) : html, next: n && n.href ? n.href : null };
})()`;

/* ------------------------------------------------------------------ render */
async function renderOne(url, { scrolls, settleMs, deadline, session }) {
  const left = () => Math.max(1500, deadline - Date.now());
  await limiter.schedule(`browser4:${hostOf(url)}`, HOST_GAP_MS, () => cli(['goto', url], { json: false, timeoutMs: Math.min(config.browser4.timeoutMs, left()), session }));

  // Never press on through a challenge page: that is a "no", not an obstacle.
  const info = await cli(['page-info'], { timeoutMs: Math.min(15000, left()), session });
  if (info && info.output && info.output.challenge_detected) throw skip('the site answered with a bot-challenge page', { challenge: true });

  await cli(['wait', '--load', 'networkidle', '--timeout', '15000'], { json: false, timeoutMs: Math.min(20000, left()), session }).catch(() => { /* a page with a live connection never idles: carry on */ });

  let scrolled = { rounds: 0, height: 0 };
  if (scrolls > 0) {
    try { scrolled = (await evalJs(scrollScript(scrolls, settleMs), { await: true, timeoutMs: Math.min(scrolls * (settleMs + 1500) + 5000, left()), session })) || scrolled; } catch (e) { if (e.timedOut) scrolled = { rounds: -1, height: 0 }; else throw e; }
  }

  const doc = await evalJs(documentScript, { timeoutMs: Math.min(30000, left()), session });
  if (!doc || typeof doc.html !== 'string' || !doc.html) throw new Error('the browser returned no page');

  // A redirect may have taken the browser somewhere PRISM must not go: check where it really ended up.
  await assertAllowed(doc.url);
  return { requested: url, url: doc.url, title: doc.title || null, html: doc.html, next: doc.next || null, scrolls: scrolled.rounds };
}

/**
 * The page loop shared by the local browser and the remote Browser API: render, then follow the page's own "next page" link
 * (same site only) up to `maxPages`. `around(fn)` wraps ONE page's render (the remote browser attaches and detaches per page).
 */
async function renderLoop(first, { scrolls, maxPages, settleMs, deadline, allowUrl, session, around = (fn) => fn() }) {
  const pages = []; const notes = []; const seen = new Set();
  let target = first;
  while (target && pages.length < maxPages && !seen.has(target)) {
    seen.add(target);
    if (pages.length) {
      if (Date.now() > deadline - 8000) { notes.push('time budget reached'); break; }
      try { await assertAllowed(target); if (allowUrl && !(await allowUrl(target))) { notes.push(`next page not allowed: ${target}`); break; } } catch (e) { notes.push(`next page skipped: ${e.message}`); break; }
    }
    let p;
    try { p = await around(() => renderOne(target, { scrolls, settleMs, deadline, session })); } catch (e) {
      if (pages.length && !e.challenge) { notes.push(`page ${pages.length + 1} failed: ${e.message}`); break; }
      throw e;
    }
    pages.push(p);
    target = p.next && sameSite(p.next, first) ? p.next : null;
  }
  return { pages, notes };
}

/**
 * Render a page - and, through "next page" links on the same site, up to `pages` of them - in the browser.
 * @param {string} url
 * @param {{scrolls?:number, pages?:number, settleMs?:number, budgetMs?:number, allowUrl?:(u:string)=>Promise<boolean>, remote?:boolean}} opts
 *   allowUrl: extra permission check for follow-up pages (the web adapter passes robots.txt).
 *   remote:   render in Bright Data's Browser API (BRIGHTDATA_BROWSER_WSS) instead of the local Chrome. That browser unblocks
 *             as it loads, so it is only for a page that REFUSED the local one (see sources/web.js unlockedRead). It runs on
 *             Bright Data's machines, so the local private-address routes do not apply, and the URL is checked here before it
 *             leaves PRISM (a private address is never handed to a third party).
 * @returns {Promise<{via:'browser4'|'brightdata-browser', pages:Array<{requested,url,title,html,next,scrolls}>, notes:string[]}>}
 */
function renderPages(url, opts = {}) {
  const scrolls = Math.min(Math.max(opts.scrolls ?? 8, 0), 40);
  const maxPages = Math.min(Math.max(opts.pages ?? 1, 1), 10);
  const settleMs = Math.min(Math.max(opts.settleMs ?? 700, 100), 5000);
  const budgetMs = opts.budgetMs || config.browser4.renderBudgetMs;
  const queuedAt = Date.now();
  return exclusive(async () => {
    if (!enabled()) throw skip('Browser4 is not enabled (BROWSER4_ENABLED)');
    // One browser serves everyone: a feed that has waited too long for it is read without it this time, instead of
    // running into the engine's per-run time limit (which would count as a failure of the feed's whole platform).
    if (Date.now() - queuedAt > config.browser4.maxQueueWaitMs) throw skip('Browser4 is busy with another page');
    const first = await assertAllowed(url);
    const deadline = Date.now() + budgetMs;
    try {
      if (opts.remote) {
        const wss = config.brightdata.browserWss;
        if (!wss) throw skip('BRIGHTDATA_BROWSER_WSS is not set');
        const session = `${config.browser4.session}-brd`;
        const loop = await renderLoop(first, {
          scrolls, maxPages, settleMs, deadline, allowUrl: opts.allowUrl, session,
          // Bright Data's Browser API allows ONE navigation per connection: a fresh attach for every page, closed after it.
          around: async (fn) => {
            await cli(['attach', '--cdp', wss], { json: false, timeoutMs: 60000, session });
            try { return await fn(); } finally { await cli(['close'], { json: false, timeoutMs: 20000, session }).catch(() => {}); }
          },
        });
        return { via: 'brightdata-browser', ...loop };
      }
      try { await ensureOpen(budgetMs); await ensureBlocks(); } catch (e) { opened = false; throw e; }
      try {
        const loop = await renderLoop(first, { scrolls, maxPages, settleMs, deadline, allowUrl: opts.allowUrl, session: config.browser4.session });
        return { via: 'browser4', ...loop };
      } catch (e) {
        if (e.timedOut || /not found|unreadable|session/i.test(e.message)) opened = false; // re-open next time (backend restarted, session lost)
        throw e;
      }
    } finally {
      // goto/open leave accessibility snapshots in the working directory; nothing here reads them.
      fs.rm(path.join(workDir(), '.browser4-cli'), { recursive: true, force: true }, () => {});
    }
  });
}

/* ------------------------------------------------------------------ status */
let availCache = null;
/** Is the CLI installed and answering? Cached for a minute. */
async function available({ force = false } = {}) {
  if (!enabled()) return { ok: false, reason: 'BROWSER4_ENABLED is not set' };
  if (!force && availCache && Date.now() - availCache.at < 60000) return availCache.value;
  const value = await new Promise((resolve) => {
    execFile(config.browser4.bin, ['--version'], { timeout: 10000, env: process.env, windowsHide: true }, (err, stdout) => {
      if (err) resolve({ ok: false, reason: err.code === 'ENOENT' ? `browser4-cli not found (${config.browser4.bin})` : String(err.message).slice(0, 200) });
      else resolve({ ok: true, version: String(stdout).trim() });
    });
  });
  availCache = { at: Date.now(), value };
  return value;
}

async function status() {
  const a = await available();
  return { enabled: enabled(), ...a, session: config.browser4.session, headed: config.browser4.headed };
}

/** Close the browser session (scripts and tests; the long-running server leaves it open for the next render). */
async function close() {
  return exclusive(async () => { if (!opened) return; opened = false; try { await cli(['close'], { json: false, timeoutMs: 20000 }); } catch { /* already gone */ } });
}

/** Remove the private-address routes (tests that need the browser to reach a local fixture afterwards). */
const _unblock = () => cli(['network', 'unroute'], { json: false, timeoutMs: 20000 }).catch(() => {});

module.exports = { enabled, available, status, renderPages, assertAllowed, close, sameSite, PRIVATE_URL_PATTERNS, _unblock, _reset: () => { opened = false; availCache = null; } };
