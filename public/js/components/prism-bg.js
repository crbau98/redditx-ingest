// "Prism light": a tiny dependency-free WebGL background — domain-warped noise lit in the
// current accent colours, with soft refracted light bands that drift toward the pointer.
// Renders at reduced resolution (it is meant to be soft), pauses when off-screen or when the
// tab is hidden, draws a single still frame for reduced-motion users, steps its resolution down
// on slow GPUs, and leaves the CSS gradient in place when WebGL is unavailable or software-only.

import { gpuTier } from './fx.js';

const VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
const FRAG = `
precision mediump float;
uniform vec2 u_res; uniform float u_time; uniform vec2 u_mouse;
uniform vec3 c1; uniform vec3 c2; uniform vec3 c3; uniform float u_dark;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }
void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time * 0.055;
  vec2 m = (u_mouse - 0.5) * vec2(0.7, -0.5);
  vec2 q = vec2(fbm(p * 1.5 + t), fbm(p * 1.5 - t + 3.1));
  vec2 r = vec2(fbm(p * 1.7 + q * 1.7 + m + vec2(1.7, 9.2) + t * 1.2), fbm(p * 1.7 + q * 1.7 - m + vec2(8.3, 2.8) - t));
  float f = fbm(p * 2.0 + r * 1.9);
  vec3 col = mix(c1, c2, clamp(f * 1.7 - 0.15, 0.0, 1.0));
  col = mix(col, c3, clamp(length(r) * 0.6 - 0.3, 0.0, 1.0));
  // refracted light: thin bright bands that bend with the field, like light through a prism
  float band = pow(abs(sin((p.x * 0.9 + p.y * 0.55 + f * 1.5 + m.x * 0.6) * 5.5 + t * 3.0)), 22.0);
  col += band * mix(c3, vec3(1.0), 0.55) * 0.45;
  float vign = smoothstep(1.35, 0.15, length((p - vec2(m.x * 0.3, 0.12)) * vec2(0.85, 1.25)));
  float a = (0.22 + 0.78 * f) * vign * smoothstep(0.0, 0.5, uv.y);
  a *= (u_dark > 0.5 ? 0.78 : 0.45);
  gl_FragColor = vec4(col * a, a);
}`;

function hexToRgb(str) {
  const s = String(str || '').trim();
  let m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
  m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16) / 255);
  m = s.match(/rgba?\(([^)]+)\)/);
  if (m) return m[1].split(',').slice(0, 3).map((x) => parseFloat(x) / 255);
  return [0.55, 0.36, 0.96];
}

/** Mount the background into `host` (positioned). Returns a destroy function. */
export function mountPrismBackground(host) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // No real GPU: keep the static CSS gradient (a CPU-rendered shader would slow the whole page).
  if (gpuTier() === 'software') return () => {};
  const canvas = document.createElement('canvas');
  canvas.className = 'prism-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false, alpha: true, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true });
  if (!gl) return () => {};

  const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
  const vs = compile(gl.VERTEX_SHADER, VERT); const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return () => {};
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return () => {};
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  const u = { res: U('u_res'), time: U('u_time'), mouse: U('u_mouse'), c1: U('c1'), c2: U('c2'), c3: U('c3'), dark: U('u_dark') };

  const paintColors = () => {
    const cs = getComputedStyle(document.documentElement);
    gl.uniform3fv(u.c1, hexToRgb(cs.getPropertyValue('--accent-2')));
    gl.uniform3fv(u.c2, hexToRgb(cs.getPropertyValue('--accent')));
    gl.uniform3fv(u.c3, hexToRgb(cs.getPropertyValue('--accent-3')));
    gl.uniform1f(u.dark, document.documentElement.dataset.theme === 'light' ? 0 : 1);
  };
  // Soft by design: rendered below full resolution and upscaled by CSS. If frames come in slow
  // (weak GPU, software rendering), step the resolution down; if even the lowest is slow, stop
  // animating and keep a still frame so the rest of the page stays smooth.
  const LEVELS = [0.5, 0.36, 0.25];
  let level = window.matchMedia('(pointer: coarse)').matches ? 1 : 0;
  let still = false; let ema = 16; let frames = 0; let lastNow = 0;
  // Software WebGL (SwiftShader, llvmpipe — VMs, blocklisted GPUs) would starve the page: one still frame.
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    if (/swiftshader|llvmpipe|software|basic render/i.test(renderer)) { still = true; level = LEVELS.length - 1; }
  } catch { /* ignore */ }
  const resize = () => {
    const scale = LEVELS[level];
    const w = Math.max(1, Math.round(host.clientWidth * scale)); const h = Math.max(1, Math.round(host.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    gl.uniform2f(u.res, w, h);
  };

  const mouse = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
  const onMove = (e) => { const r = host.getBoundingClientRect(); mouse.tx = (e.clientX - r.left) / r.width; mouse.ty = (e.clientY - r.top) / r.height; };
  let raf = 0; let visible = true; let start = performance.now(); let dead = false;
  const frame = (now) => {
    if (dead) return;
    if (lastNow) { ema = ema * 0.85 + Math.min(250, now - lastNow) * 0.15; frames++; }
    lastNow = now;
    if (frames > 12 && ema > 30) {
      if (level < LEVELS.length - 1) { level++; resize(); frames = 0; ema = 16; } else still = true;
    }
    mouse.x += (mouse.tx - mouse.x) * 0.04; mouse.y += (mouse.ty - mouse.y) * 0.04;
    gl.uniform1f(u.time, (now - start) / 1000 + 40);
    gl.uniform2f(u.mouse, mouse.x, mouse.y);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (!reduced && !still && visible && !document.hidden) raf = requestAnimationFrame(frame); else { raf = 0; lastNow = 0; }
  };
  const kick = () => { if (!raf && !dead) raf = requestAnimationFrame(frame); };

  host.prepend(canvas);
  host.classList.add('has-prism');
  resize(); paintColors();
  requestAnimationFrame(() => canvas.classList.add('on'));
  kick();

  const ro = new ResizeObserver(() => { resize(); if (reduced || still) kick(); });
  ro.observe(host);
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); });
  io.observe(host);
  const onVis = () => { if (!document.hidden) kick(); };
  const onTheme = () => { paintColors(); kick(); };
  const mo = new MutationObserver(onTheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] });
  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('visibilitychange', onVis);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); dead = true; canvas.remove(); host.classList.remove('has-prism'); });

  return () => {
    dead = true; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); mo.disconnect();
    window.removeEventListener('pointermove', onMove); document.removeEventListener('visibilitychange', onVis);
    const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
    canvas.remove(); host.classList.remove('has-prism');
  };
}
