'use strict';
/**
 * Captcha tokens, bought one at a time (CapSolver's HTTP API).
 *
 * The last wall in front of a page is a widget that wants a human: Cloudflare Turnstile's checkbox, hCaptcha, reCAPTCHA.
 * A real browser alone cannot clear those; a token service can, for a few tenths of a cent each. This module is the whole
 * integration: detect the widget and its site key, ask for a token, hand back the JavaScript that puts it where the page
 * expects it (lib/chrome.js runs that inside the page, then the page's own form does the rest).
 *
 * Off by default and inert without `CAPSOLVER_API_KEY`. A daily cap (setting captchaSolverBudget, default 50) stops a
 * broken page from draining the account: every token costs money.
 */
const config = require('../config');
const repo = require('../db/repo');
const net = require('./net');

const today = () => new Date().toISOString().slice(0, 10);
const configured = () => !!config.creds.capsolverKey;

function usage() {
  let u = {};
  try { u = JSON.parse(repo.settings.get('captchasolver.usage') || '{}'); } catch { u = {}; }
  return u.day === today() ? { day: u.day, count: u.count || 0, total: u.total || 0 } : { day: today(), count: 0, total: u.total || 0 };
}
function record() {
  const u = usage();
  repo.settings.set('captchasolver.usage', JSON.stringify({ day: u.day, count: u.count + 1, total: u.total + 1 }));
}
const remaining = (budget) => Math.max(0, Number(budget || 0) - usage().count);

/** Which widget does this page embed, and with what site key? */
function widget(html, url) {
  const h = String(html || '');
  const key = (h.match(/data-sitekey=["']([^"']+)["']/i) || h.match(/["']sitekey["']\s*:\s*["']([^"']+)["']/i) || [])[1];
  if (/challenges\.cloudflare\.com\/turnstile|cf-turnstile/i.test(h)) return { type: 'AntiTurnstileTaskProxyLess', siteKey: key, kind: 'turnstile', url };
  if (/hcaptcha\.com\/1\/api\.js|h-captcha/i.test(h)) return { type: 'HCaptchaTaskProxyLess', siteKey: key, kind: 'hcaptcha', url };
  if (/recaptcha\/api\.js|g-recaptcha/i.test(h)) {
    const v3 = /grecaptcha\.execute|render=([A-Za-z0-9_-]{20,})/.test(h);
    return { type: v3 ? 'ReCaptchaV3TaskProxyLess' : 'ReCaptchaV2TaskProxyLess', siteKey: key, kind: v3 ? 'recaptcha3' : 'recaptcha2', url };
  }
  return null;
}

async function call(path, body) {
  const res = await net.request(`${config.baseUrls.capsolver}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), retries: 1, timeout: 30000, maxBytes: 1_000_000,
  });
  let json;
  try { json = JSON.parse(res.body); } catch { throw Object.assign(new Error(`captcha service answered ${res.status} with something that is not JSON`), { status: res.status }); }
  if (Number(json.errorId) > 0) {
    throw Object.assign(new Error(`captcha service: ${String(json.errorDescription || json.errorCode || 'error').slice(0, 160)}`), {
      status: json.errorCode === 'ERROR_KEY_DENIED_ACCESS' ? 401 : 502, skip: json.errorCode === 'ERROR_KEY_DENIED_ACCESS',
    });
  }
  return json;
}

/**
 * Buy one token for the widget on this page.
 * @returns {Promise<string>} the token
 */
async function solve({ type, siteKey, url, action }, { budget = 0 } = {}) {
  if (!configured()) throw Object.assign(new Error('CAPSOLVER_API_KEY is not set'), { skip: true });
  if (!siteKey) throw Object.assign(new Error('the captcha widget has no site key PRISM can read'), { skip: true });
  if (budget && remaining(budget) <= 0) throw Object.assign(new Error(`captcha solver daily budget reached (${budget}/day)`), { budget: true });
  const task = { type, websiteURL: url, websiteKey: siteKey };
  if (action) task.pageAction = action;
  const created = await call('/createTask', { clientKey: config.creds.capsolverKey, task });
  if (!created.taskId) throw Object.assign(new Error('captcha service did not return a task id'), { status: 502 });
  record(); // a task was accepted: it is billed whether or not it yields a token
  const deadline = Date.now() + config.captcha.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, config.captcha.pollMs));
    const got = await call('/getTaskResult', { clientKey: config.creds.capsolverKey, taskId: created.taskId });
    if (got.status === 'ready' && got.solution && got.solution.token) return String(got.solution.token);
  }
  throw Object.assign(new Error(`captcha service did not solve the widget within ${Math.round(config.captcha.timeoutMs / 1000)}s`), { status: 504 });
}

/** Detect and solve whatever this page embeds. */
async function solveForPage(html, url, opts) {
  const w = widget(html, url);
  if (!w) throw Object.assign(new Error('no captcha widget found on the page'), { skip: true });
  return solve(w, opts);
}

/** JavaScript that puts a token where the page looks for it, then nudges the page's own check. */
function injectScript(token) {
  const t = JSON.stringify(String(token));
  return `(() => {
    const token = ${t};
    const put = (sel, name) => {
      let el = document.querySelector(sel);
      if (!el) { el = document.createElement('textarea'); el.name = name; el.style.display = 'none'; document.body.appendChild(el); }
      el.value = token; el.innerHTML = token;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    put('[name="cf-turnstile-response"]', 'cf-turnstile-response');
    put('[name="g-recaptcha-response"]', 'g-recaptcha-response');
    put('[name="h-captcha-response"]', 'h-captcha-response');
    try { if (window.___grecaptcha_cfg) for (const k of Object.keys(window.___grecaptcha_cfg.clients || {})) { const c = window.___grecaptcha_cfg.clients[k]; const cb = c && c.callback; if (typeof cb === 'function') cb(token); } } catch (e) {}
    return true;
  })()`;
}

module.exports = { configured, solve, solveForPage, widget, injectScript, usage, remaining };
