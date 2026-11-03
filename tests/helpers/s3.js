'use strict';
const http = require('http');
/* ---- an S3 look-alike that VERIFIES the SigV4 signature of every request (path-style, in memory) ---- */
const ACCESS = 'AKIATESTTESTTEST'; const SECRET = 'secret/for+tests'; const BUCKET = 'prism-test';
function s3Server() {
  const sigv4 = require('../../src/lib/sigv4');
  const objects = new Map(); const log = [];
  const ctl = { proof: 'full' }; // what HEAD/GET reveal about content: 'full' = our x-amz-meta-sha256 + an MD5 ETag, 'etag' = ETag only, 'none' = size only (some S3 look-alikes)
  const proofHeaders = (o) => ({
    ...(ctl.proof === 'full' && o.sha256 ? { 'x-amz-meta-sha256': o.sha256 } : {}),
    ...(ctl.proof !== 'none' ? { etag: `"${require('crypto').createHash('md5').update(o.body).digest('hex')}"` } : {}),
  });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x');
      const auth = String(req.headers.authorization || '');
      const signedHeaders = (/SignedHeaders=([^,]+)/.exec(auth) || [])[1] || '';
      const extra = {};
      for (const n of signedHeaders.split(';')) if (n !== 'host' && (!n.startsWith('x-amz-') || n.startsWith('x-amz-meta-'))) extra[n] = req.headers[n]; // x-amz-date / content-sha256 are passed explicitly below
      const check = sigv4.sign({ method: req.method, host: req.headers.host, path: u.pathname, headers: { ...extra, 'x-amz-date': req.headers['x-amz-date'] }, payloadHash: req.headers['x-amz-content-sha256'],
        region: 'auto', accessKeyId: ACCESS, secretAccessKey: SECRET, date: new Date(req.headers['x-amz-date'].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')) });
      log.push(`${req.method} ${u.pathname}`);
      if (check.headers.authorization !== auth) { res.writeHead(403, { 'content-type': 'application/xml' }); return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); }
      const key = decodeURIComponent(u.pathname);
      if (!key.startsWith(`/${BUCKET}/`)) { res.writeHead(404); return res.end(); }
      if (req.method === 'PUT') { objects.set(key, { body, type: req.headers['content-type'], sha256: req.headers['x-amz-meta-sha256'] || null }); res.writeHead(200); return res.end(); }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
      const o = objects.get(key);
      if (!o) { res.writeHead(404, { 'content-type': 'application/xml' }); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range && req.method === 'GET') {
        const start = Number(range[1]); const end = range[2] ? Math.min(Number(range[2]), o.body.length - 1) : o.body.length - 1;
        res.writeHead(206, { ...proofHeaders(o), 'content-type': o.type, 'content-range': `bytes ${start}-${end}/${o.body.length}`, 'content-length': end - start + 1 });
        return res.end(o.body.subarray(start, end + 1));
      }
      res.writeHead(200, { ...proofHeaders(o), 'content-type': o.type, 'content-length': o.body.length });
      res.end(req.method === 'HEAD' ? undefined : o.body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, objects, log, ctl, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}


module.exports = { s3Server, ACCESS, SECRET, BUCKET };
