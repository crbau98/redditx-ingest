'use strict';
/**
 * Bot challenges: what a page is hiding behind, and the ones PRISM can clear by itself.
 *
 * A refusal used to be a dead end for the free tiers: Bright Data and Scrapfly are paid, and the local browsers gave up
 * on every challenge page. Two kinds of challenge can be cleared at no cost, and this module owns both:
 *
 *   - Anubis (https://anubis.techaro.lol), the proof-of-work gate now in front of many fediverse servers ("Making sure
 *     you're not a bot!"). The page ships the challenge and the rule; the browser is expected to find a nonce whose
 *     SHA-256 starts with `difficulty` zero nibbles and trade it for a signed cookie. That is arithmetic, not a captcha:
 *     solveAnubis() does it in Node in milliseconds, with no browser and no third party. Anubis binds the challenge to
 *     the User-Agent and client address, so the same headers go on every hop.
 *
 *   - Everything else (Cloudflare's managed challenge, DataDome, PerimeterX, a captcha widget) needs a real browser
 *     fingerprint: lib/chrome.js drives Chrome over plain CDP and waits it out, then lib/captchasolver.js can buy a
 *     token when the page insists on a checkbox. This module only NAMES what was found, so the caller picks the right
 *     tier and the run note can say which one acted.
 *
 * detect() is deliberately conservative: a page counts as a challenge only when a vendor artefact or its exact wording
 * is present, so a normal article that merely says "captcha" is never mistaken for a wall.
 */
const crypto = require('crypto');
const net = require('./net');

/** The browser identity every hop of a challenge uses: Anubis binds the challenge to it. */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const ANUBIS_PASS = '/.within.website/x/cmd/anubis/api/pass-challenge';
const MAX_POW_MS = 20000;
const COOKIE_TTL_MS = 40 * 60 * 1000;      // Anubis cookies last about an hour; renew well before that
const cookies = new Map();                  // host -> {cookie, until}

const CHALLENGES = [
  { kind: 'anubis', label: 'Anubis proof-of-work', solvable: 'pow',
    test: (h) => /id=["']anubis_challenge["']|\.within\.website\/x\/cmd\/anubis|Making sure you&#39;re not a bot|Making sure you're not a bot/i.test(h) },
  { kind: 'cloudflare-waf', label: 'Cloudflare firewall block', solvable: 'browser',
    test: (h) => /Request forbidden by administrative rules|error code:? 10(19|20)/i.test(h) },
  { kind: 'cloudflare', label: 'Cloudflare challenge', solvable: 'browser',
    // `challenge-platform` and `cf-chl-widget-*` are not walls by themselves: every cleared page behind Cloudflare still
    // carries the first, and any page embedding a Turnstile widget carries the second. These markers are the interstitial.
    test: (h) => /Just a moment\.\.\.|Attention Required|__cf_chl_|cf_chl_opt|Checking your browser before accessing|Verify you are human|cf-browser-verification/i.test(h) },
  { kind: 'ddos-guard', label: 'DDoS-Guard challenge', solvable: 'browser',
    test: (h) => /ddos-guard|__ddg1_|DDoS protection by/i.test(h) },
  { kind: 'datadome', label: 'DataDome challenge', solvable: 'browser',
    test: (h) => /geo\.captcha-delivery\.com|datadome|dd_cookie_test/i.test(h) },
  { kind: 'perimeterx', label: 'PerimeterX challenge', solvable: 'browser',
    test: (h) => /px-captcha|_px2|perimeterx|Press &amp; Hold/i.test(h) },
  { kind: 'imperva', label: 'Imperva / Incapsula block', solvable: 'browser',
    test: (h) => /Incapsula incident|_Incapsula_Resource|Pardon Our Interruption/i.test(h) },
  { kind: 'captcha', label: 'captcha widget', solvable: 'token',
    test: (h) => /hcaptcha\.com\/1\/api\.js|google\.com\/recaptcha|challenges\.cloudflare\.com\/turnstile|cf-turnstile|g-recaptcha\b|h-captcha\b/i.test(h) },
];

/**
 * What is this answer hiding behind?
 * @param {{status?: number, html?: string, headers?: object}} res
 * @returns {{kind: string, label: string, solvable: string}|null}
 */
function detect(res) {
  const html = String((res && res.html) || '');
  const status = Number((res && res.status) || 0);
  // A tiny body is the usual shape of a challenge; a real page that merely mentions a vendor is not. Size is only a
  // tie-breaker (some challenges are 40 KB of obfuscated script), so a vendor artefact alone still counts.
  // A cleared Cloudflare page still carries leftover artefacts (and nowsecure.nl, Cloudflare's own demo, embeds live
  // Turnstile widgets), so a big page is content unless it is Anubis. Challenge interstitials are small.
  if (!html) return null;
  if (html.length > 120000 && !/id=["']anubis_challenge["']/i.test(html)) return null;
  for (const c of CHALLENGES) if (c.test(html)) return { kind: c.kind, label: c.label, solvable: c.solvable };
  // A 403/429/503 with no known artefact is still a refusal; the caller decides what to do with it.
  if ([403, 429, 503].includes(status)) return { kind: 'refused', label: `HTTP ${status}`, solvable: 'browser' };
  return null;
}

const isChallenge = (kind) => !!kind && kind !== 'refused';

/* ------------------------------------------------------------------ Anubis */

function parseJsonScript(html, id) {
  const m = String(html).match(new RegExp(`<script id=["']${id}["'][^>]*type=["']application/json["'][^>]*>([\\s\\S]*?)</script>`, 'i'))
    || String(html).match(new RegExp(`<script id=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, 'i'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** How many leading zero hex digits does `hex` have? (Anubis difficulty is counted in nibbles.) */
function leadingZeros(hex) {
  let n = 0;
  for (let i = 0; i < hex.length; i++) { if (hex[i] === '0') n++; else break; }
  return n;
}

/**
 * Find the nonce whose SHA-256 starts with `difficulty` zero nibbles.
 * @returns {{nonce: string, hash: string, ms: number}}
 */
function proofOfWork(randomData, difficulty, { maxMs = MAX_POW_MS } = {}) {
  const want = Math.max(0, Math.min(12, Number(difficulty) || 0));
  const started = Date.now();
  for (let nonce = 0; ; nonce++) {
    const hash = crypto.createHash('sha256').update(String(randomData) + String(nonce)).digest('hex');
    if (leadingZeros(hash) >= want) return { nonce: String(nonce), hash, ms: Date.now() - started };
    if ((nonce & 1023) === 0 && Date.now() - started > maxMs) {
      throw Object.assign(new Error(`Anubis proof of work did not finish in ${Math.round(maxMs / 1000)}s (difficulty ${want})`), { status: 504 });
    }
  }
}

/** The Anubis challenge embedded in a page, or null when this is not an Anubis page. */
function anubisChallenge(html) {
  const j = parseJsonScript(html, 'anubis_challenge');
  if (!j || !j.challenge || !j.challenge.randomData) return null;
  const rules = j.rules || {};
  const algorithm = String(rules.algorithm || j.challenge.method || 'fast');
  return {
    id: j.challenge.id,
    randomData: j.challenge.randomData,
    difficulty: Number(rules.difficulty ?? j.challenge.difficulty ?? 2),
    algorithm,
    // The two reference workers (fast, slow) are both SHA-256 with a nibble difficulty; the WASM ones are not.
    supported: algorithm === 'fast' || algorithm === 'slow',
    basePrefix: String(parseJsonScript(html, 'anubis_base_prefix') || '').replace(/\/+$/, ''),
  };
}

/** Cookie header cached for this host (Anubis clears it after roughly an hour). */
function cachedCookie(host) {
  const hit = cookies.get(String(host).toLowerCase());
  if (!hit || hit.until < Date.now()) { cookies.delete(String(host).toLowerCase()); return null; }
  return hit.cookie;
}

function rememberCookie(host, cookie) {
  if (!cookie) return;
  cookies.set(String(host).toLowerCase(), { cookie, until: Date.now() + COOKIE_TTL_MS });
}

/** Forget a host's Anubis cookie (after a 403 that says it went stale). */
const forgetCookie = (host) => cookies.delete(String(host).toLowerCase());

/**
 * Read a page through an Anubis gate: solve the proof of work and come back with the cookie set.
 * @param {string} url
 * @param {{headers?: object, timeout?: number, maxMs?: number}} opts
 * @returns {Promise<{status: number, html: string, headers: object, cookie: string, ms: number, difficulty: number}|null>}
 *          null when the page is not behind Anubis (the caller keeps its own answer)
 */
async function solveAnubis(url, opts = {}) {
  const started = Date.now();
  const headers = { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9', ...(opts.headers || {}) };
  const first = await net.request(url, { headers, retries: 0, timeout: opts.timeout || 25000, maxBytes: 2_000_000 });
  const challenge = anubisChallenge(first.body);
  if (!challenge) return null;
  if (!challenge.supported) {
    throw Object.assign(new Error(`Anubis used the ${challenge.algorithm} algorithm, which PRISM does not compute (only fast/slow)`), { challenge: 'anubis', unsupported: true });
  }
  const sol = proofOfWork(challenge.randomData, challenge.difficulty, { maxMs: opts.maxMs });
  const origin = new URL(first.url || url).origin;
  const setCookies = [].concat(first.headers['set-cookie'] || []);
  const jar = setCookies.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
  const qs = new URLSearchParams({
    id: challenge.id, response: sol.hash, nonce: sol.nonce,
    redir: first.url || url, elapsedTime: String(sol.ms + 50),
  });
  const pass = await net.request(`${origin}${challenge.basePrefix}${ANUBIS_PASS}?${qs}`, {
    headers: { ...headers, cookie: jar, referer: `${origin}/.within.website/`, accept: 'text/html' },
    retries: 0, timeout: opts.timeout || 25000, maxBytes: 1_000_000,
  });
  const issued = [...(pass.cookies || []), ...[].concat(pass.headers['set-cookie'] || []).map((c) => String(c).split(';')[0])]
    .filter((c) => c && c.includes('=') && !c.endsWith('=') && !/cookie-verification/i.test(c));
  if (!issued.length) {
    throw Object.assign(new Error(`Anubis rejected the proof of work (HTTP ${pass.status})`), { status: pass.status === 200 ? 403 : pass.status, challenge: 'anubis' });
  }
  const cookie = [jar.split('; ').filter((c) => c && !/anubis-auth/i.test(c)).join('; '), ...issued].filter(Boolean).join('; ');
  const second = await net.request(url, { headers: { ...headers, cookie, accept: opts.accept || headers.accept }, retries: 0, timeout: opts.timeout || 25000, maxBytes: opts.maxBytes || 3_000_000 });
  const again = anubisChallenge(second.body);
  if (again) {
    // Solved but still gated: the cookie did not take (IP changed mid-run, or the gate rotated the secret).
    throw Object.assign(new Error('Anubis accepted the proof of work but the cookie did not clear the gate'), { status: 403, challenge: 'anubis' });
  }
  rememberCookie(new URL(url).hostname, cookie);
  return { status: second.status, html: second.body.toString('utf8'), headers: second.headers, cookie, ms: Date.now() - started, difficulty: challenge.difficulty };
}

module.exports = {
  BROWSER_UA,
  detect,
  isChallenge,
  anubisChallenge,
  proofOfWork,
  solveAnubis,
  cachedCookie,
  rememberCookie,
  forgetCookie,
  leadingZeros,
  _challenges: CHALLENGES,
};
