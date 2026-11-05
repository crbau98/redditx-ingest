// Runs before first paint (loaded synchronously in <head>) so the saved theme never flashes.
(function () {
  try {
    var t = localStorage.getItem('prism.theme');
    t = t ? JSON.parse(t) : 'dark';
    var light = t === 'light' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    var a = localStorage.getItem('prism.accent');
    a = a ? JSON.parse(a) : 'prism';
    if (/^(ocean|ember|forest|violet|mono)$/.test(a)) document.documentElement.dataset.accent = a;
  } catch (e) { /* storage blocked: stay on the dark default */ }
})();

// Deep links: the view for the address being opened is not part of the app's static module graph (views load on
// first visit), so ask for it now, in parallel with main.js, instead of after main.js has run.
(function () {
  try {
    var seg = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || '');
    var view = { explore: 'explore', creators: 'creators', creator: 'creator', saved: 'saved', browse: 'browse', reels: 'reels', following: 'following', find: 'find' }[seg];
    var me = document.currentScript && document.currentScript.src;
    if (!view || !me) return;
    var l = document.createElement('link');
    l.rel = 'modulepreload';
    l.href = me.replace(/theme-init\.js(\?.*)?$/, 'views/' + view + '.js');
    document.head.appendChild(l);
  } catch (e) { /* only a hint */ }
})();

// Start the first screen's requests now. Without this they begin only after main.js has been fetched, parsed and run
// (and, for /api/discover, after /api/meta has answered): two or three round trips (~150 ms each on a phone link) in a
// chain. api.js `get()` takes these over by URL (takeEarly), so the page code does not change; an unused answer is
// dropped after 15 s. Keep the URLs identical to what the views ask for (same params, same order: see api.js qs()).
(function () {
  try {
    if (!window.fetch) return;
    var early = window.__early = {};
    var start = function (url) {
      var p = fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : Promise.reject(new Error(String(r.status))); });
      p.catch(function () { /* the normal request will report the error */ });
      early[url] = { at: Date.now(), p: p };
    };
    var seg = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || '');
    start('/api/meta');
    if (!seg) { // home: the discover payload and the first page of the latest feed (views/home.js)
      start('/api/discover');
      start('/api/media?sort=recent&page=0&limit=36');
    } else if (seg === 'browse') { // views/browse.js
      start('/api/tags?limit=200');
      start('/api/communities');
      start('/api/platforms');
      start('/api/topics');
      start('/api/creators?onlyfans=1&limit=1');
      start('/api/media?paid=onlyfans&limit=1');
      start('/api/creators?paid=fansly&limit=1');
    }
  } catch (e) { /* only a hint */ }
})();
