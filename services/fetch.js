const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_UA = process.env.INGEST_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 PRISM/3.2';

function isPrivateHost(hostname) {
  const h = (hostname || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h === '::1') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  return false;
}

function request(url, { method = 'GET', headers = {}, timeout = 20000, maxRedirects = 5, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let current = url;
    let hops = 0;

    const go = (target) => {
      let parsed;
      try { parsed = new URL(target); } catch (e) { return reject(e); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reject(new Error('Unsupported protocol'));
      }
      if (isPrivateHost(parsed.hostname)) {
        return reject(new Error('Blocked host'));
      }

      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(parsed, {
        method,
        headers: { 'User-Agent': DEFAULT_UA, Accept: '*/*', ...headers }
      }, res => {
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc && hops < maxRedirects) {
          hops++;
          const next = new URL(loc, parsed).toString();
          res.resume();
          return go(next);
        }

        const chunks = [];
        let size = 0;
        res.on('data', c => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            return reject(new Error('Response too large'));
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            url: parsed.toString(),
            body: Buffer.concat(chunks)
          });
        });
      });
      req.on('error', reject);
      req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    };

    go(current);
  });
}

async function fetchText(url, opts = {}) {
  const res = await request(url, opts);
  if (res.status >= 400) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.body.toString('utf8');
}

async function fetchJSON(url, opts = {}) {
  const res = await request(url, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers || {}) }
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = res.body.toString('utf8');
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Invalid JSON from ${url}`); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { request, fetchText, fetchJSON, sleep, isPrivateHost, DEFAULT_UA };
