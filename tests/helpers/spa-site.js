'use strict';
/**
 * A small single-page "gallery" whose HTML is an EMPTY SHELL: everything a crawler wants (pictures, the next-page link, the
 * links to other galleries) is built by JavaScript after load, and more pictures arrive as the page is scrolled.
 * It is what a plain download cannot read and a real browser can.
 *
 *   /               home: links to the galleries, built by JS
 *   /gallery        6 pictures, +6 on each scroll to the bottom (3 batches = 18), then a JS-built rel="next" link
 *   /gallery?page=2 6 more pictures, no next link
 *   /set/<name>     a small gallery (4 pictures)
 *   /challenge      looks like a bot-challenge interstitial
 *   /login          noise
 */
const { start, JPEG } = require('./mock');

const BATCH = 6; const BATCHES = 3;
const shell = (title, body, script) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width"><style>img{display:block;width:900px;height:900px;background:#cbd5e1}</style></head>
<body><nav><a href="/">Home</a> <a href="/login">Log in</a></nav><div id="app"></div><div id="more"></div>${body}<script>${script}</script></body></html>`;

const galleryScript = (second) => `
(async () => {
  const app = document.getElementById('app'); let batch = 0; let busy = false;
  const base = ${second ? 100 : 0}; const maxBatches = ${second ? 1 : BATCHES};
  const add = () => { for (let i = 0; i < ${BATCH}; i++) { const n = base + batch * ${BATCH} + i; const im = document.createElement('img'); im.src = '/img/' + n + '.jpg'; im.width = 900; im.height = 900; im.alt = 'Gay muscle gym selfie ' + n; app.appendChild(im); } };
  const loadMore = async () => {
    if (busy || batch >= maxBatches) return; busy = true;
    await fetch('/api/ping').then((r) => r.text());           // pictures arrive asynchronously, like a real feed
    add(); batch++; busy = false;
    if (!${second} && batch >= maxBatches) { const a = document.createElement('a'); a.rel = 'next'; a.href = '/gallery?page=2'; a.textContent = 'Next'; document.body.appendChild(a); }
  };
  await loadMore();
  window.addEventListener('scroll', () => { if (innerHeight + scrollY >= document.documentElement.scrollHeight - 60) loadMore(); });
})();`;

const homeScript = `
(async () => {
  const sets = await fetch('/api/sets').then((r) => r.json());
  const ul = document.createElement('ul');
  for (const s of sets) { const li = document.createElement('li'); li.innerHTML = '<a href="' + s.href + '">' + s.name + '</a>'; ul.appendChild(li); }
  document.getElementById('app').appendChild(ul);
})();`;

const setScript = (name) => `
(async () => { const app = document.getElementById('app'); for (let i = 0; i < 4; i++) { const im = document.createElement('img'); im.src = '/img/${name.length}0' + i + '.jpg'; im.width = 800; im.height = 800; im.alt = 'Gay muscle ${name} ' + i; app.appendChild(im); } })();`;

async function startSite() {
  const html = (body) => ({ headers: { 'content-type': 'text/html; charset=utf-8' }, body });
  return start({
    '/': () => html(shell('Home', '', homeScript)),
    '/gallery': (req, res, url) => html(shell('Gallery', '', galleryScript(url.searchParams.get('page') === '2'))),
    '/set/alpha': () => html(shell('Alpha', '', setScript('alpha'))),
    '/set/beta': () => html(shell('Beta', '', setScript('beta'))),
    '/login': () => html(shell('Log in', '<form></form>', '')),
    '/challenge': () => html('<!doctype html><html><head><title>Just a moment...</title></head><body><h1>Checking your browser before accessing the site.</h1><div id="cf-challenge-running"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>'),
    '/api/ping': () => ({ body: 'ok' }),
    '/api/sets': () => ({ json: [{ name: 'Gallery', href: '/gallery' }, { name: 'Alpha', href: '/set/alpha' }, { name: 'Beta', href: '/set/beta' }, { name: 'Log in', href: '/login' }] }),
    '/robots.txt': () => ({ headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\nAllow: /\n' }),
    ...Object.fromEntries(Array.from({ length: 700 }, (_, n) => [`/img/${n}.jpg`, () => ({ headers: { 'content-type': 'image/jpeg' }, body: JPEG })])),
  });
}

module.exports = { startSite };
