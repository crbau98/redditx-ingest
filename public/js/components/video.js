import { proxied, loadScript } from '../dom.js';
import { reportBroken } from '../api.js';

export const isM3u8 = (u) => /\.m3u8(\?|$)/i.test(u || '');

/**
 * Point a <video> at an item's best source. HLS (with audio) goes through the
 * /api/hls proxy — natively on Safari, via hls.js elsewhere — and falls back to
 * the plain MP4 if the stream fails. Returns a handle whose destroy() releases
 * the stream (hls.js keeps buffers and workers alive until told otherwise).
 */
export function attachVideo(v, it) {
  // autoplay: false while a video only buffers off-screen (Reels warms the next one), so a
  // fallback to the MP4 does not start it playing in the background.
  const handle = { hls: null, dead: false, autoplay: true, destroy() { this.dead = true; if (this.hls) { try { this.hls.destroy(); } catch { /* ignore */ } this.hls = null; } } };
  const hls = it.hls_url || (isM3u8(it.media_url) ? it.media_url : null);
  const mp4 = isM3u8(it.media_url) ? null : it.media_url;
  const useHls = hls && (it.has_audio || !mp4);
  // Every source failed: let the server verify the item at its origin.
  const dead = () => { if (!handle.dead) reportBroken(it.id); };
  const fallback = () => {
    if (handle.dead) return;
    if (!mp4) { dead(); return; }
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
    const inst = new Hls({ enableWorker: true });
    handle.hls = inst;
    inst.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) { try { inst.destroy(); } catch { /* ignore */ } handle.hls = null; fallback(); } });
    inst.loadSource(src);
    inst.attachMedia(v);
  })();
  return handle;
}

/** Stop a video and drop its network connection. */
export function releaseVideo(v) {
  if (!v) return;
  try { v.pause(); } catch { /* ignore */ }
  v.removeAttribute('src');
  try { v.load(); } catch { /* ignore */ }
}
