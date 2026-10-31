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
