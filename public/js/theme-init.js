// Runs before first paint (loaded synchronously in <head>) so the saved theme never flashes.
(function () {
  try {
    var t = localStorage.getItem('prism.theme');
    t = t ? JSON.parse(t) : 'auto';
    var light = t === 'light' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    var a = localStorage.getItem('prism.accent');
    a = a ? JSON.parse(a) : 'prism';
    if (/^(ocean|ember|forest|violet|mono)$/.test(a)) document.documentElement.dataset.accent = a;
  } catch (e) { /* storage blocked: stay on the dark default */ }
})();
