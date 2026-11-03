'use strict';
/**
 * Mask secrets in text that came from outside (an upstream API's error message, a network error) before it is put in an
 * error, a log line or an admin screen: Bearer tokens, vendor-style keys (sk-..., pk-..., rk-..., also the masked
 * "sk-proj-abc***xyz" form), key=value pairs for api key / token / secret / authorization / password, long opaque tokens,
 * and the exact keys this server is configured with. Ordinary words, numbers and request ids are left alone.
 */
const config = require('../config');

const MASK = '[redacted]';
const PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_*.-]{6,}/g,
  /\b(?:api[_-]?key|x-api-key|token|secret|authorization|password|passwd)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

function redact(text) {
  let out = String(text === null || text === undefined ? '' : text);
  for (const key of [config.creds.openaiKey, config.creds.anthropicKey]) {
    if (key && key.length >= 8) out = out.split(key).join(MASK);
  }
  out = out.replace(PATTERNS[0], `Bearer ${MASK}`).replace(PATTERNS[1], MASK);
  out = out.replace(PATTERNS[2], (m, sep) => `${m.slice(0, m.indexOf(sep))}${sep}${MASK}`);
  return out.replace(PATTERNS[3], MASK);
}

module.exports = redact;
