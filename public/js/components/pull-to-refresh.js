import { h, icon } from '../dom.js';
import { haptic } from './fx.js';

/**
 * Native-feeling pull-to-refresh for top-level scroll views.
 * Activates only when the viewport is at the top (scrollY === 0) on coarse touch pointers.
 * Shows a spring-damped rotating indicator, fires a selection haptic when passing the threshold,
 * runs the async onRefresh callback in a rotating spinner state, and returns with a spring ease.
 */
export function initPullToRefresh(container, onRefresh) {
  if (typeof window === 'undefined' || !container) return () => {};

  const spinner = h('div', { class: 'ptr-icon' }, icon('refresh', 'sm'));
  const indicator = h('div', { class: 'ptr-indicator', 'aria-hidden': 'true' }, spinner);
  document.body.appendChild(indicator);

  let startY = 0;
  let startX = 0;
  let active = false;
  let pulling = false;
  let thresholdPassed = false;
  let refreshing = false;

  const THRESHOLD = 64;
  const MAX_PULL = 84;

  const onTouchStart = (e) => {
    if (refreshing || (window.scrollY || document.documentElement.scrollTop || 0) > 0) return;
    if (!e.touches || e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    active = true;
    pulling = false;
    thresholdPassed = false;
  };

  const onTouchMove = (e) => {
    if (!active || refreshing) return;
    const y = e.touches[0].clientY;
    const x = e.touches[0].clientX;
    const dy = y - startY;
    const dx = x - startX;

    if (!pulling) {
      if (window.scrollY > 0) {
        active = false;
        return;
      }
      // Must be a clear downwards vertical pull, not a horizontal gesture
      if (dy > 8 && dy > Math.abs(dx) * 1.4) {
        pulling = true;
      } else if (Math.abs(dx) > dy || dy < 0) {
        active = false;
        return;
      }
    }

    if (pulling) {
      if (e.cancelable) e.preventDefault();
      // Logarithmic rubber-band resistance
      const pull = Math.min(MAX_PULL, dy * 0.46);
      const progress = Math.min(1, pull / THRESHOLD);
      indicator.style.transition = 'none';
      indicator.style.transform = `translate3d(0, ${pull}px, 0) scale(${0.65 + 0.35 * progress})`;
      indicator.style.opacity = String(Math.min(1, progress * 1.3));
      indicator.style.setProperty('--ptr-rot', `${progress * 280}deg`);

      if (pull >= THRESHOLD && !thresholdPassed) {
        thresholdPassed = true;
        haptic('selection');
      } else if (pull < THRESHOLD && thresholdPassed) {
        thresholdPassed = false;
      }
    }
  };

  const resetIndicator = (fast = false) => {
    indicator.classList.remove('ptr-loading');
    indicator.style.transition = fast
      ? 'transform var(--dur-quick, 140ms) var(--spring-glide, ease-out), opacity var(--dur-quick, 140ms) ease'
      : 'transform var(--dur-base, 260ms) var(--spring-glide, ease-out), opacity var(--dur-base, 260ms) ease';
    indicator.style.transform = 'translate3d(0, 0, 0) scale(0.6)';
    indicator.style.opacity = '0';
    setTimeout(() => {
      if (!refreshing && !pulling) {
        indicator.style.transition = '';
        indicator.style.transform = '';
        indicator.style.opacity = '';
        indicator.style.removeProperty('--ptr-rot');
      }
    }, 280);
  };

  const onTouchEnd = async () => {
    if (!active || !pulling) {
      active = false;
      pulling = false;
      return;
    }
    active = false;
    pulling = false;

    if (thresholdPassed && !refreshing) {
      refreshing = true;
      indicator.classList.add('ptr-loading');
      indicator.style.transition = 'transform var(--dur-quick, 140ms) var(--spring-glide, ease-out), opacity var(--dur-quick, 140ms) ease';
      indicator.style.transform = 'translate3d(0, 52px, 0) scale(1)';
      indicator.style.opacity = '1';
      haptic('light');

      const minWait = new Promise((r) => setTimeout(r, 400));
      try {
        await Promise.all([Promise.resolve(onRefresh()), minWait]);
      } catch {
        /* view handles its own errors */
      } finally {
        refreshing = false;
        resetIndicator();
      }
    } else {
      resetIndicator(true);
    }
  };

  const opts = { passive: false };
  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, opts);
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return () => {
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchmove', onTouchMove, opts);
    container.removeEventListener('touchend', onTouchEnd);
    container.removeEventListener('touchcancel', onTouchEnd);
    indicator.remove();
  };
}
