// Runs before first paint (loaded synchronously in <head>) so the saved theme never flashes.
(function () {
  try {
    var t = localStorage.getItem('prism.theme');
    t = t ? JSON.parse(t) : 'dark';
    var light = t === 'light' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', light ? '#f5f5f7' : '#0b0b0e'); // status bar / address bar follow the saved theme from the first paint
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
// chain. api.js `get()` takes these over by URL (viaEarly), so the page code does not change; an unused answer is
// dropped after 15 s. Keep the URLs identical to what the views ask for (same params, same order: see api.js qs()).
//
// /api/meta goes first and alone: it says whether this visitor has passed the age gate. The lists are behind that gate,
// so asking for them before it is known would answer a first-time visitor with 403s (and console errors); they start the
// moment meta says the visitor is through (or that the gate is off), which is still long before main.js has run.
(function () {
  try {
    if (!window.fetch) return;
    var early = window.__early = {};
    var start = function (url) {
      var p = fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : Promise.reject(new Error(String(r.status))); });
      p.catch(function () { /* the normal request will report the error */ });
      early[url] = { at: Date.now(), p: p };
      return p;
    };
    var seg = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || '');
    var lists = [];
    if (!seg) { // home: the discover payload and the first page of the latest feed (views/home.js)
      lists.push('/api/discover', '/api/media?sort=recent&page=0&limit=36');
    } else if (seg === 'creators') {
      lists.push('/api/creators?sort=popular&page=0&limit=36');
    } else if (seg === 'reels') {
      // Reels opens on "For you" once there is taste (views/reels.js), which is a /api/recommend
      // POST query we cannot build here; only a visitor without taste asks /api/media?sort=trending.
      var hasTaste = false;
      try {
        var t = JSON.parse(localStorage.getItem('prism.taste') || '{}');
        hasTaste = ((t.events || 0) >= 3 || Object.keys(t.seeds || {}).length >= 2) && (Object.keys(t.t || {}).length > 0 || Object.keys(t.c || {}).length > 0);
      } catch (e) { /* storage blocked: no taste */ }
      if (!hasTaste) lists.push('/api/media?type=video&sort=trending&page=0&limit=12');
    } else if (seg === 'browse') { // views/browse.js
      lists.push('/api/tags?limit=200', '/api/communities', '/api/platforms', '/api/topics', '/api/creators?onlyfans=1&limit=1', '/api/media?paid=onlyfans&limit=1', '/api/creators?paid=fansly&limit=1');
    }
    var confirmed = false;
    try { confirmed = localStorage.getItem('prism.ageConfirmed') === '1'; } catch (e) { /* storage blocked */ }
    var meta = start('/api/meta');
    if (lists.length) {
      if (confirmed) {
        lists.forEach(start);
      } else {
        meta.then(function (text) {
          var gate = JSON.parse(text).ageGate;
          if (gate && gate.enforce && !gate.verified) return; // main.js shows the age gate first; the lists are asked for after it
          try { localStorage.setItem('prism.ageConfirmed', '1'); } catch (e) {}
          lists.forEach(start);
        }).catch(function () { /* the normal requests follow */ });
      }
    }
  } catch (e) { /* only a hint */ }
})();
