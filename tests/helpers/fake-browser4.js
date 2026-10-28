#!/usr/bin/env node
'use strict';
/**
 * A stand-in for `browser4-cli`: just enough of its surface for src/lib/browser4.js, so the suite needs no Chrome.
 * Scripted by $FAKE_B4_DIR/routes.json  { "<url>": { html, title, final, next, challenge, delayMs, fail } }
 * and recorded in $FAKE_B4_DIR/calls.jsonl, one line per invocation.
 */
const fs = require('fs');
const path = require('path');

const dir = process.env.FAKE_B4_DIR;
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('browser4-cli 0.0.0-fake'); process.exit(0); }

let json = false; let session = null; let i = 0;
while (i < argv.length) {
  if (argv[i] === '-s') { session = argv[i + 1]; i += 2; } else if (argv[i] === '--json') { json = true; i++; } else break;
}
const cmd = argv[i]; const rest = argv.slice(i + 1);
const routes = JSON.parse(fs.readFileSync(path.join(dir, 'routes.json'), 'utf8'));
const curFile = path.join(dir, 'current.txt');
const current = () => (fs.existsSync(curFile) ? fs.readFileSync(curFile, 'utf8') : '');
const record = (extra = {}) => fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ cmd, rest, json, session, ...extra })}\n`);
const envelope = (output) => console.log(JSON.stringify({ status: 'ok', command: cmd, output }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  switch (cmd) {
    case 'goto': {
      const url = rest[0]; const route = routes[url];
      record({ url });
      if (route && route.delayMs) await sleep(route.delayMs);
      if (!route || route.fail) { console.error(`Navigation failed\n  [CDP_ERROR] ${route && route.fail ? route.fail : 'no such page'}`); process.exit(1); }
      fs.writeFileSync(curFile, url);
      console.log('### Page');
      break;
    }
    case 'page-info': {
      record();
      const route = routes[current()] || {};
      envelope({ pages: [{ index: 0, title: route.title || '', url: route.final || current(), active: true }], count: 1, challenge_detected: !!route.challenge });
      break;
    }
    case 'eval': {
      let script = '';
      if (rest.includes('--stdin')) { for await (const c of process.stdin) script += c; }
      const scroll = /scrollTo/.test(script);
      record({ scroll, await: rest.includes('--await') });
      const route = routes[current()] || {};
      envelope({ result: scroll ? { rounds: 2, height: 1200 } : { url: route.final || current(), title: route.title || '', html: route.html || '', next: route.next || null }, expression: 'script' });
      break;
    }
    default: // open, wait, close ...
      record();
      console.log('ok');
  }
})();
