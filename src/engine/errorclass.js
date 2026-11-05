'use strict';
/**
 * Why did a feed run fail? One small vocabulary, used by the engine (what to do about it), the sweep (is it worth switching
 * the feed off) and the source-health report (what the owner sees):
 *
 *   rate_limited  the server (or our own limiter) said "slow down": wait, never give up on the feed
 *   blocked       401 / 403 / a bot-challenge page / a sign-in wall: the site refuses this server, which can change
 *   not_found     404 / 410 / suspended / banned / private / "no such user": the TARGET is gone
 *   parse         the answer arrived but is not what the adapter reads (invalid JSON, "web page, not a feed" ...)
 *   timeout       nothing came back in time
 *   network       connection reset / refused / DNS failure / proxy failure
 *   server        the server answered 5xx
 *   config        the source is not set up (no key, no adapter): not a failure of the feed
 *   other         anything else
 *
 * It accepts an Error (status, code, flags set by the adapters) or just the stored message of an older run, so the same
 * function labels history that was written before it existed.
 */

const KINDS = ['rate_limited', 'blocked', 'not_found', 'parse', 'timeout', 'network', 'server', 'config', 'other'];

/** Kinds that say nothing about the feed itself: the same request can work later, so they never end a feed's life. */
const TRANSIENT = new Set(['rate_limited', 'blocked', 'timeout', 'network', 'server']);
/** Kinds that mean the target is gone: switched off after a few tries. */
const PERMANENT = new Set(['not_found']);

const NOT_FOUND_TEXT = /not found|target no longer exists|no longer exists|account suspended|suspended|user_banned|\bbanned\b|deactivated|channel is private|\bis private\b|quarantined|preview[ -]disabled|feed unavailable|no such user|does not exist|doesn't exist/i;
// "API access suspended", "this IP is banned", "app suspended": the SITE refuses us. The target may well exist and access can come back,
// so this is a block (transient), never a missing target. "account suspended" / "user banned" name the target and stay not_found.
const SITEWIDE_BAN_TEXT = /\b(?:ip(?: address)?|api(?: access| key)?|access|app(?:lication)?|client|token|key|server|network|region|country)\b[^.\n]{0,40}\b(?:suspended|banned|blocked|restricted)\b|\b(?:suspended|banned)\b[^.\n]{0,25}\b(?:ip|api|access|app(?:lication)?|token|key)\b/i;
const RATE_TEXT = /rate.?limit|too many requests|\b429\b|throttl|slow down|cooling down|flood.?wait|retry.?after/i;
const BLOCK_TEXT = /bot[- ]?protection|bot[- ]?challenge|challeng|cloudflare|captcha|access denied|forbidden|requires sign-in|sign-in|login wall|walled|refuses? (?:this|prism)|\b(?:401|403|451)\b|unauthori[sz]ed/i;
const PARSE_TEXT = /not a valid feed|invalid json|unexpected token|unexpected end|\bparse|malformed|not a feed|is a web page|returned no token|empty (?:response|body)|unexpected (?:response|html)|not (?:json|xml)/i;
const TIMEOUT_TEXT = /timed? ?out|timeout|etimedout|too slow/i;
const NETWORK_TEXT = /econnreset|econnrefused|enotfound|eai_again|epipe|eproxy|socket hang up|connection (?:aborted|reset|refused|closed)|getaddrinfo|unreachable|network|dns|tls|ssl|certificate|proxy/i;
const SERVER_TEXT = /unavailable|gateway|gateway time-?out|temporarily|overloaded|internal server error/i;
const CONFIG_TEXT = /not configured|no adapter|set [A-Z_]{4,}|is off\b|disabled in settings/i;

function statusOf(err) {
  if (err && typeof err === 'object' && Number.isFinite(Number(err.status)) && Number(err.status) > 0) return Number(err.status);
  const msg = typeof err === 'string' ? err : (err && err.message) || '';
  const m = /\bHTTP[ /:]*(\d{3})\b/i.exec(msg) || /\bstatus (\d{3})\b/i.exec(msg) || /\((?:HTTP )?([45]\d{2})\)/.exec(msg);
  return m ? Number(m[1]) : 0;
}

/**
 * @param {Error|string|null} err
 * @returns {{kind: string, status: number, transient: boolean, permanent: boolean}}
 */
function classify(err) {
  const msg = typeof err === 'string' ? err : String((err && err.message) || '');
  const code = (err && err.code) || '';
  const status = statusOf(err);
  const out = (kind) => ({ kind, status, transient: TRANSIENT.has(kind), permanent: PERMANENT.has(kind) });

  if (err && typeof err === 'object' && err.skip) return out('config');
  if (err && typeof err === 'object' && (err.cooldown || err.rateLimited)) return out('rate_limited');
  if (status === 429) return out('rate_limited');
  // An answer that names the target as gone beats the status: Reddit says 403 for a banned account, Mastodon 410 for a moved one.
  if (status === 404 || status === 410) return out('not_found');
  // "Service Unavailable" / "unavailable on every transport" are outages, not a missing target, and a "blocked host ... private
  // address" is a policy refusal: only phrases that say the target does not exist count.
  if (SITEWIDE_BAN_TEXT.test(msg) && status < 500) return out('blocked');
  if (NOT_FOUND_TEXT.test(msg) && status < 500 && !/private address|resolves to a private/i.test(msg)) return out('not_found');
  if (code === 'BOT_CHALLENGE' || (err && typeof err === 'object' && err.authWall)) return out('blocked');
  if (status === 401 || status === 403 || status === 451) return out('blocked');
  if (status === 422) return out('parse');
  if (status >= 500) return out('server');
  if (status === 0 && (code === 'ETIMEDOUT' || TIMEOUT_TEXT.test(msg)) && !/\b(?:401|403|429)\b/.test(msg)) return out('timeout');
  if (code === 'EBLOCKED' || /^blocked host/i.test(msg)) return out('other'); // our own SSRF guard: a policy refusal about the target, not an outage
  if (BLOCK_TEXT.test(msg)) return out('blocked');
  if (RATE_TEXT.test(msg)) return out('rate_limited');
  if (CONFIG_TEXT.test(msg)) return out('config');
  if (PARSE_TEXT.test(msg)) return out('parse');
  if (code === 'ETIMEDOUT' || TIMEOUT_TEXT.test(msg)) return out('timeout');
  if (SERVER_TEXT.test(msg)) return out('server');
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EPROXY'].includes(code) || NETWORK_TEXT.test(msg)) return out('network');
  return out('other');
}

module.exports = { classify, statusOf, KINDS, TRANSIENT, PERMANENT };
