'use strict';
/**
 * AWS Signature Version 4 for S3-compatible storage (Cloudflare R2, Backblaze B2, MinIO, AWS S3): header-based signing,
 * path-style URLs. Pure functions over node:crypto, so the project needs no AWS SDK.
 */
const crypto = require('crypto');

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const EMPTY_SHA256 = sha256hex('');

/** RFC 3986 encoding of one path segment or query component (S3 does not double-encode). */
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `YYYYMMDD'T'HHMMSS'Z'` */
const amzDate = (d = new Date()) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');

/**
 * @param {{method: string, host: string, path: string, query?: Record<string,string>, headers?: Record<string,string>,
 *          payloadHash?: string, region: string, service?: string, accessKeyId: string, secretAccessKey: string, date?: Date}} o
 *   `path` is already percent-encoded and starts with "/".
 * @returns {{headers: Record<string,string>, signature: string, canonicalRequest: string}} headers to send (lower-case)
 */
function sign(o) {
  const service = o.service || 's3';
  const stamp = amzDate(o.date);
  const day = stamp.slice(0, 8);
  const payloadHash = o.payloadHash || 'UNSIGNED-PAYLOAD';
  const headers = { host: o.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
  for (const [k, v] of Object.entries(o.headers || {})) {
    const key = k.toLowerCase();
    // only these are worth signing; everything else (user-agent, accept-encoding ...) may be rewritten along the way
    if (key === 'range' || key === 'content-type' || key === 'content-md5' || key.startsWith('x-amz-')) headers[key] = String(v).trim();
  }
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = Object.entries(o.query || {}).map(([k, v]) => [enc(k), enc(String(v))]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalRequest = [o.method.toUpperCase(), o.path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${o.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${o.secretAccessKey}`, day);
  const signature = crypto.createHmac('sha256', hmac(hmac(hmac(kDate, o.region), service), 'aws4_request')).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, signature, canonicalRequest, query };
}

module.exports = { sign, sha256hex, enc, amzDate, EMPTY_SHA256 };
