// Offline rendering of animations: frame sequences with motion blur, GIFs and contact sheets.
// Shared by the CLI, the server tools and the editor's GIF export.
import { Renderer } from './renderer.js';
import { buildRenderScene, cameraFromState, cameraAt, updateAnimation } from './scene.js';
import { GifEncoder } from './gif.js';

export const timelineDuration = (data) => data.animation?.duration || 12;

// Renders frame after frame (generator, so callers can yield to the UI or report progress).
// In high quality each frame averages `samples` jittered renders spread over `shutter` (0..1) of the
// frame interval: anti-aliasing, soft shadows and motion blur in one go.
// camera: fixed camera state, or null to follow the scene's camera path.
// Yields { index, time, pixels }; pixels is reused between frames, copy it to keep it.
// pool: optional ShadePool (pool.js) to shade on several threads.
export async function* renderFrames(data, geometryFor, { width = 480, height = 320, times, samples = 4, shutter = 0.5, fps = 15,
  quality = 'high', camera = null, shading = 'gouraud', pool = null, effects = true } = {}) {
  const r = new Renderer({ width, height }).setPool(pool);
  r.quality = quality;
  r.shading = shading;
  const duration = timelineDuration(data), wrap = (t) => ((t % duration) + duration) % duration;
  const scene = buildRenderScene(data, geometryFor, { time: wrap(times[0] ?? 0), effects });
  const n = quality === 'high' ? Math.max(1, samples) : 1;
  for (let f = 0; f < times.length; f++) {
    for (let i = 0; i < n; i++) {
      const t = wrap(times[f] + (n > 1 ? ((i / n) * shutter) / fps : 0));
      updateAnimation(scene, t);
      await r.renderAsync(scene, cameraFromState(camera || cameraAt(data, t)), { accumulate: i > 0 });
    }
    yield { index: f, time: times[f], pixels: r.pixels };
  }
}

// evenly spaced frame times: start, start + 1/fps, ... (count frames)
export const frameTimes = (start, count, fps) => Array.from({ length: count }, (_, i) => +(start + i / fps).toFixed(4));

// Encode a GIF. The palette is built from a few frames spread over the clip, so colors stay stable.
// onProgress(done, total) is called after each frame; return a Promise from it to yield (browser UI).
export async function renderGIF(data, geometryFor, { width = 480, height = 320, fps = 15, start = 0, seconds, samples = 4, shutter = 0.5,
  quality = 'high', camera = null, dither = 1, onProgress, pool = null, effects = true } = {}) {
  const length = Math.min(seconds ?? timelineDuration(data), 60);
  const count = Math.max(1, Math.min(900, Math.round(length * fps)));
  const times = frameTimes(start, count, fps);
  const opts = { width, height, samples, shutter, fps, quality, camera, pool, effects };
  const probe = [0, 0.33, 0.66].map((k) => times[Math.floor(k * count)]).filter((t, i, a) => a.indexOf(t) === i);
  const sample = [];
  for await (const { pixels } of renderFrames(data, geometryFor, { ...opts, times: probe, samples: 1 })) sample.push(pixels.slice());
  const gif = new GifEncoder(width, height, { delay: 1 / fps, dither }).palette(sample);
  for await (const { index, pixels } of renderFrames(data, geometryFor, { ...opts, times })) {
    gif.add(pixels);
    if (onProgress) await onProgress(index + 1, count);
  }
  return { bytes: gif.finish(), frames: count, seconds: count / fps };
}

// Frames of a clip side by side in one image (agents check motion with a single picture).
// Returns { pixels, width, height, times }.
export async function renderContactSheet(data, geometryFor, { width = 1024, height = 640, frames = 6, start = 0, seconds, columns, samples = 4,
  quality = 'high', camera = null, pool = null } = {}) {
  const length = seconds ?? timelineDuration(data);
  const count = Math.max(2, Math.min(16, frames));
  const cols = columns || Math.ceil(Math.sqrt(count * (width / height) / 1.5)), rows = Math.ceil(count / cols), gap = 4;
  const cw = Math.max(32, Math.floor((width - gap * (cols - 1)) / cols)), ch = Math.max(24, Math.floor(cw / 1.5));
  const W = cols * cw + gap * (cols - 1), H = rows * ch + gap * (rows - 1);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = out[i + 1] = out[i + 2] = 24; out[i + 3] = 255; }
  // the last frame is the end of the clip, unless the clip is the full loop (then the end equals the start)
  const full = seconds === undefined || seconds >= timelineDuration(data);
  const times = Array.from({ length: count }, (_, i) => +(start + (length * i) / (full ? count : count - 1)).toFixed(3));
  for await (const { index, pixels } of renderFrames(data, geometryFor, { width: cw, height: ch, times, samples, quality, camera, shutter: 0, pool })) {
    const ox = (index % cols) * (cw + gap), oy = Math.floor(index / cols) * (ch + gap);
    for (let y = 0; y < ch; y++) out.set(pixels.subarray(y * cw * 4, (y + 1) * cw * 4), ((oy + y) * W + ox) * 4);
  }
  return { pixels: out, width: W, height: H, times, columns: cols };
}
