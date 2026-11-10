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
      // views/creators.js creatorQuery(0). Following carries device ids, so that link starts nothing here.
      var picked = {};
      (location.hash.split('?')[1] || '').split('&').forEach(function (pair) {
        if (!pair) return;
        var cut = pair.indexOf('=');
        var key = cut < 0 ? pair : pair.slice(0, cut);
        var val = '';
        try { val = decodeURIComponent((cut < 0 ? '' : pair.slice(cut + 1)).replace(/\+/g, ' ')); } catch (e) { val = ''; }
        if (val) picked[key] = val;
      });
      if (!picked.following && typeof URLSearchParams === 'function') {
        var paid = picked.paid || (picked.onlyfans === '1' ? 'onlyfans' : '');
        var u = new URLSearchParams();
        if (picked.q) u.set('q', picked.q);
        u.set('sort', picked.sort || 'popular');
        if (picked.platform) u.set('platform', picked.platform);
        if (paid) u.set('paid', paid);
        if (picked.fresh) u.set('fresh', picked.fresh);
        u.set('page', '0');
        u.set('limit', '36');
        if (paid === 'onlyfans') u.set('onlyfans', '1');
        lists.push('/api/creators?' + u.toString());
      }
    } else if (seg === 'reels') {
      // For you and a follow feed are POSTs. Shuffle needs a seed this script cannot know.
      // Anything else is the GET mediaQuery(0) in views/reels.js.
      var hasTaste = false;
      try {
        var taste = JSON.parse(localStorage.getItem('prism.taste') || '{}');
        hasTaste = ((taste.events || 0) >= 3 || Object.keys(taste.seeds || {}).length >= 2) && (Object.keys(taste.t || {}).length > 0 || Object.keys(taste.c || {}).length > 0);
      } catch (e) { /* storage blocked: no taste */ }
      var reel = {};
      var reelSeen = {};
      (location.hash.split('?')[1] || '').split('&').forEach(function (pair) {
        if (!pair) return;
        var cut = pair.indexOf('=');
        var key = cut < 0 ? pair : pair.slice(0, cut);
        var val = '';
        try { val = decodeURIComponent((cut < 0 ? '' : pair.slice(cut + 1)).replace(/\+/g, ' ')); } catch (e2) { val = ''; }
        reelSeen[key] = true;
        if (val) reel[key] = val;
      });
      var reelSort = reel.sort || (hasTaste ? 'foryou' : 'trending');
      if (!reel.following && reelSort !== 'foryou' && reelSort !== 'random' && typeof URLSearchParams === 'function') {
        var ru = new URLSearchParams();
        var reelType = reelSeen.type ? reel.type : 'video';
        if (reelType && reelType !== 'all') ru.set('type', reelType);
        ru.set('sort', reelSort);
        if (reel.platform) ru.set('platform', reel.platform);
        if (reel.tag) ru.set('tag', reel.tag);
        if (reel.tags) ru.set('tags', reel.tags);
        if (reel.anytags) ru.set('anytags', reel.anytags);
        if (reel.since) ru.set('since', reel.since);
        if (reel.after) ru.set('after', reel.after);
        if (reel.community) ru.set('community', reel.community);
        if (reel.creator) ru.set('creator', reel.creator);
        if (reel.q) ru.set('q', reel.q);
        if (reel.paid) ru.set('paid', reel.paid);
        ru.set('page', '0');
        ru.set('limit', '12');
        lists.push('/api/media?' + ru.toString());
      }
    } else if (seg === 'browse') { // views/browse.js
      lists.push('/api/tags?limit=200', '/api/communities', '/api/platforms', '/api/topics', '/api/creators?onlyfans=1&limit=1', '/api/media?paid=onlyfans&limit=1', '/api/creators?paid=fansly&limit=1');
    } else if (seg === 'creator') {
      // views/creator.js: the profile, and the first posts page when the filters are still the defaults.
      var creatorId = (location.hash.replace(/^#\/?/, '').split(/[/?]/)[1] || '');
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(creatorId)) {
        lists.push('/api/creators/' + creatorId);
        var picked = {};
        (location.hash.split('?')[1] || '').split('&').forEach(function (pair) {
          if (!pair) return;
          var cut = pair.indexOf('=');
          var key = cut < 0 ? pair : pair.slice(0, cut);
          var val = '';
          try { val = decodeURIComponent((cut < 0 ? '' : pair.slice(cut + 1)).replace(/\+/g, ' ')); } catch (e) { val = ''; }
          if (val) picked[key] = val;
        });
        var platformSent = picked.platform && /^[a-z]{1,20}$/.test(picked.platform);
        if (!picked.type && !picked.q && !platformSent && (!picked.sort || picked.sort === 'recent')) {
          var dense = false;
          try { dense = JSON.parse(localStorage.getItem('prism.density') || '"m"') === 's'; } catch (e2) {}
          lists.push('/api/creators/' + creatorId + '/media?sort=recent&limit=' + (dense ? 48 : 36) + '&page=0');
        }
      }
    }
    // A shared link (?m=<uuid>) opens the viewer. Ask for that one item with the lists, after the age gate.
    // openById still calls get('/api/media/' + id); api.js takes this answer over. Related is not started here.
    var mediaId = '';
    (location.hash.split('?')[1] || '').split('&').forEach(function (pair) {
      var cut = pair.indexOf('=');
      if ((cut < 0 ? pair : pair.slice(0, cut)) !== 'm') return;
      try { mediaId = decodeURIComponent((cut < 0 ? '' : pair.slice(cut + 1)).replace(/\+/g, ' ')); } catch (e) { mediaId = ''; }
    });
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mediaId)) {
      lists.push('/api/media/' + mediaId);
      var me = document.currentScript && document.currentScript.src;
      if (me && document.head) {
        var preload = document.createElement('link');
        preload.rel = 'modulepreload';
        preload.href = me.replace(/theme-init\.js(\?.*)?$/, 'components/lightbox.js');
        document.head.appendChild(preload);
      }
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
