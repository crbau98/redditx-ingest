'use strict';
/** Tiny programmable HTTP server for adapter / engine tests. */
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20000, 7)]);
const PNG_TINY = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]);

/**
 * @param {Record<string, (req, res, url: URL) => any>} routes exact-path handlers.
 *   A handler may return {status, json, body, headers}; or write to res itself and return null.
 */
function start(routes = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits.push(`${req.method} ${url.pathname}${url.search}`);
    const handler = routes[url.pathname];
    if (!handler) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      req.bodyText = body;
      let out;
      try { out = handler(req, res, url); } catch (e) { res.writeHead(500); return res.end(String(e.stack)); }
      if (out === null || out === undefined) return;
      const headers = { ...(out.headers || {}) };
      if (out.json !== undefined) { headers['content-type'] = 'application/json'; res.writeHead(out.status || 200, headers); return res.end(JSON.stringify(out.json)); }
      res.writeHead(out.status || 200, headers); res.end(out.body === undefined ? '' : out.body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ server, port, url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}

/** Point config at a throwaway DB and allow localhost mock hosts. Call before requiring app modules. */
function prepareEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-test-'));
  Object.assign(process.env, {
    NODE_ENV: 'test', DB_PATH: path.join(dir, 'test.db'), ALLOW_PRIVATE_HOSTS: 'true', ADMIN_KEY: 'test-key',
    SCHEDULER_ENABLED: 'false', MEDIA_CACHE_MB: '16', ...extra,
  });
  return dir;
}

module.exports = { start, prepareEnv, JPEG, PNG_TINY };
