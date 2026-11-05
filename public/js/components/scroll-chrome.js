// Phone chrome that gets out of the way:
//  - the sticky filter bar (Explore / Creators / Following) slides up while you scroll down and returns the moment
//    you scroll up. On a 390x844 phone the app bar plus the bar was a third of the screen.
//  - while a text field has focus, `typing` is set on <html>: the floating tab bar is hidden, because with the
//    keyboard up it would sit on top of the field (Android resizes the layout viewport, so fixed bars ride up with it).
// One passive scroll listener; the hide state is a class, the motion is a CSS transform (compositor only).
const PHONE = '(max-width: 899px)';
const TEXT_FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=file]), textarea, [contenteditable=""], [contenteditable="true"]';

export function initScrollChrome() {
  const phone = window.matchMedia(PHONE);
  let bar = null; let lastY = window.scrollY; let travel = 0; let hidden = false; let queued = false;

  const show = () => { if (bar && hidden) bar.classList.remove('bar-hidden'); hidden = false; travel = 0; };
  const hide = () => { if (bar && !hidden) bar.classList.add('bar-hidden'); hidden = true; travel = 0; };

  const frame = () => {
    queued = false;
    if (!bar || !bar.isConnected) { bar = document.querySelector('.filterbar'); hidden = !!(bar && bar.classList.contains('bar-hidden')); }
    const y = window.scrollY; const dy = y - lastY; lastY = y;
    if (!bar || !phone.matches) { if (bar && hidden) show(); return; }
    const a = document.activeElement; // typing in the bar's search box keeps it in view; a tapped chip does not
    if (y < 120 || Math.abs(dy) > 600 || (a && bar.contains(a) && a.matches(`${TEXT_FIELD}, select`))) { show(); return; } // top of the page, a programmatic jump, or you are using it
    if (dy !== 0 && Math.sign(dy) !== Math.sign(travel)) travel = 0; // direction changed: start counting again
    travel += dy;
    if (travel > 28) hide(); else if (travel < -10) show();
  };
  window.addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(frame); } }, { passive: true });
  // a new page has its own bar, and starts at the top
  window.addEventListener('hashchange', () => { bar = null; hidden = false; travel = 0; lastY = window.scrollY; });
  phone.addEventListener('change', () => { if (!phone.matches) show(); });
  // tabbing into the bar (keyboard, switch access) must reveal it
  document.addEventListener('focusin', (e) => { if (bar && hidden && bar.contains(e.target)) show(); });

  const root = document.documentElement;
  document.addEventListener('focusin', (e) => { if (e.target.matches && e.target.matches(TEXT_FIELD)) root.classList.add('typing'); });
  document.addEventListener('focusout', () => { requestAnimationFrame(() => { if (!document.activeElement || !document.activeElement.matches(TEXT_FIELD)) root.classList.remove('typing'); }); });
}
