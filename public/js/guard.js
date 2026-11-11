/**
 * One view's "has the user left this page?" flag and its cleanup.
 *
 * A view paints a skeleton, hands its cleanup back to the router at once, and fills in later. Every late fill checks
 * isLeft() first, so an answer that lands after you leave never paints over the next page. cleanup() runs the view's
 * own extra teardown (destroy a feed, drop a key handler, clear a timer) once; a second call does nothing.
 *
 *   const life = makeGuard(() => feed.destroy());
 *   get('/api/x').then((r) => { if (life.isLeft()) return; paint(r); });
 *   relatedRail(tags, { alive: life.alive });   // smart.js takes an alive() check
 *   return life.cleanup;
 */
export function makeGuard(onLeave = () => {}) {
  let left = false;
  return {
    isLeft: () => left,
    alive: () => !left,
    cleanup: () => {
      if (left) return;
      left = true;
      onLeave();
    },
  };
}
