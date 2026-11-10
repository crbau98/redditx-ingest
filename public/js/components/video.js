import { proxied, loadScript } from '../dom.js';
import { reportBroken } from '../api.js';
import { prefs, playback, bus } from '../store.js';
import { clampRate, stepRate, resumeAt } from '../playback-policy.js';

// A playlist link: a .m3u8, or GayForFans' /play/<id>/manifest (an HLS manifest with no extension).
export const isM3u8 = (u) => /\.m3u8(\?|$)|\/play\/[^/]+\/manifest(\?|$)/i.test(u || '');

/**
 * Point a <video> at an item's best source. HLS (with audio) goes through the
 * /api/hls proxy — natively on Safari, via hls.js elsewhere — and falls back to
 * the plain MP4 if the stream fails. Returns a handle whose destroy() releases
 * the stream (hls.js keeps buffers and workers alive until told otherwise).
 */
export function attachVideo(v, it) {
  // autoplay: false while a video only buffers off-screen (Reels warms the next one), so a
  // fallback to the MP4 does not start it playing in the background.
  // promote(): a warmed video became the one on screen. It buffered only a few seconds while it
  // waited (so it did not compete with the playing video for bandwidth); now it may buffer normally.
  const handle = {
    hls: null, dead: false, autoplay: true,
    destroy() { this.dead = true; if (this.hls) { try { this.hls.destroy(); } catch { /* ignore */ } this.hls = null; } },
    promote() { this.autoplay = true; if (this.hls) { this.hls.config.maxBufferLength = 30; this.hls.config.maxMaxBufferLength = 60; } },
    // demote(): the slide stopped being the one on screen. Give back the large buffer it earned while
    // playing, so the neighbours kept warm don't hold 30–60 s of video each.
    demote() { this.autoplay = false; if (this.hls) { this.hls.config.maxBufferLength = 6; this.hls.config.maxMaxBufferLength = 8; } },
  };
  const hls = it.hls_url || (isM3u8(it.media_url) ? it.media_url : null);
  const mp4 = isM3u8(it.media_url) ? null : it.media_url;
  const useHls = hls && (it.has_audio || !mp4);
  // Every source failed: let the server verify the item at its origin.
  const dead = () => { if (!handle.dead) reportBroken(it.id); };
  const challenged = () => {
    if (handle.dead) return;
    handle.dead = true;
    v.dataset.sourceState = 'challenged';
    v.title = 'The source is showing a bot check, so this video cannot be streamed right now. Open it on the source site.';
  };
  const fallback = () => {
    if (handle.dead) return;
    if (!mp4) {
      // No plain file to fall back to: ask the proxy why the stream failed before blaming the item.
      fetch(`/api/hls?url=${encodeURIComponent(hls)}`).then((r) => (r.status === 503 ? challenged() : dead()), () => dead());
      return;
    }
    v.addEventListener('error', dead, { once: true });
    v.src = proxied(mp4); if (handle.autoplay) v.play().catch(() => {});
  };
  if (!useHls) { v.addEventListener('error', dead, { once: true }); v.src = proxied(mp4); return handle; }
  const src = `/api/hls?url=${encodeURIComponent(hls)}`;
  if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = src;
    v.addEventListener('error', fallback, { once: true });
    return handle;
  }
  (async () => {
    try { await loadScript('/vendor/hls.light.min.js'); } catch { fallback(); return; }
    if (handle.dead || !v.isConnected) return;
    const Hls = window.Hls;
    if (!Hls || !Hls.isSupported()) { fallback(); return; }
    // Start at a level that suits the player size and buffer a little ahead when only warming.
    const inst = new Hls({ enableWorker: true, capLevelToPlayerSize: true, backBufferLength: 15, maxBufferLength: handle.autoplay ? 30 : 6, maxMaxBufferLength: handle.autoplay ? 60 : 8 });
    handle.hls = inst;
    inst.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      try { inst.destroy(); } catch { /* ignore */ }
      handle.hls = null;
      // 503 from /api/hls with source_challenged: the source is showing a bot check. The video is fine,
      // so do not report it broken; show the state instead.
      if (data.response && data.response.code === 503) { challenged(); return; }
      fallback();
    });
    inst.loadSource(src);
    inst.attachMedia(v);
  })();
  return handle;
}

/** Apply the saved speed, restore a resume point, and remember where this video left off. */
export function bindWatch(v, it) {
  if (!v || !it || !it.id) return () => {};
  const apply = () => { v.playbackRate = clampRate(prefs.playbackRate); };
  apply();
  const offRate = bus.on('rate', apply);
  const saved = playback.get(it.id);
  let restored = false;
  const restore = () => {
    if (restored || !saved || !Number.isFinite(v.duration)) return;
    const at = resumeAt(saved.t, v.duration);
    if (!at) return;
    restored = true;
    try { v.currentTime = at; } catch { restored = false; }
  };
  v.addEventListener('loadedmetadata', restore);
  if (v.readyState >= 1) restore();
  let last = 0;
  // A player that never reached the clip (a warmed neighbour, a failed open) must not wipe a saved point.
  const save = () => {
    if (!Number.isFinite(v.duration) || v.currentTime < 1) return;
    last = performance.now();
    playback.remember(it.id, v.currentTime, v.duration);
  };
  const onTime = () => { if (performance.now() - last < 5000) return; save(); };
  const onEnded = () => playback.forget(it.id);
  v.addEventListener('timeupdate', onTime);
  v.addEventListener('pause', save);
  v.addEventListener('ended', onEnded);
  return () => {
    save();
    offRate();
    v.removeEventListener('loadedmetadata', restore);
    v.removeEventListener('timeupdate', onTime);
    v.removeEventListener('pause', save);
    v.removeEventListener('ended', onEnded);
  };
}

/** One speed stop faster or slower. The button and the comma / period keys share this. */
export function bumpRate(video, dir) {
  const next = stepRate(prefs.playbackRate, dir);
  prefs.playbackRate = next;
  if (video) video.playbackRate = next;
  return next;
}

export async function togglePip(video) {
  if (!video || typeof document === 'undefined' || !document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function') return false;
  try {
    if (document.pictureInPictureElement === video) { await document.exitPictureInPicture(); return false; }
    await video.requestPictureInPicture();
    return true;
  } catch { return false; }
}

/** Stop a video and drop its network connection. */
export function releaseVideo(v) {
  if (!v) return;
  try { v.pause(); } catch { /* ignore */ }
  v.removeAttribute('src');
  try { v.load(); } catch { /* ignore */ }
}
