// Headless rendering for render_view and the CLI: CPU renderer -> PNG, no browser or GPU needed.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Renderer } from '../src/renderer.js';
import { buildRenderScene, cameraFromState } from '../src/scene.js';
import { renderContactSheet, renderGIF } from '../src/frames.js';
import { ShadePool } from '../src/pool.js';
import { setTextureLoader, loadTextures, isValidTextureSrc } from '../src/textures.js';
import { encodePNG, decodePNG } from './png.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Textures: data URLs, or PNG files inside the project folder (never outside of it).
setTextureLoader(async (src) => {
  if (!isValidTextureSrc(src)) throw new Error('invalid texture source');
  if (src.startsWith('data:')) return decodePNG(Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'));
  const file = resolve(ROOT, src);
  if (!file.startsWith(ROOT + sep)) throw new Error('texture outside the project');
  return decodePNG(await readFile(file));
});

export const sceneTextures = (doc) => doc.data.objects.map((o) => o.material.texture).filter(Boolean);
export const preloadTextures = (doc) => loadTextures(sceneTextures(doc));

// quality 'high' averages `samples` jittered frames (anti-aliasing, soft shadows, smooth AO).
// Call preloadTextures(doc) first if the scene uses textures.
export function renderPNG(doc, { width = 768, height = 512, camera = doc.data.camera, shading = 'gouraud', wireframe = false,
  highlight = [], quality = 'high', samples = 8, time = 0 } = {}) {
  const r = new Renderer({ width, height });
  r.shading = shading;
  r.wireframe = wireframe;
  r.quality = quality;
  const scene = buildRenderScene(doc.data, (s) => doc.geometry(s), { selected: highlight, time });
  const cam = cameraFromState(camera);
  const n = quality === 'high' ? Math.max(1, samples) : 1;
  for (let i = 0; i < n; i++) r.render(scene, cam, { accumulate: i > 0 });
  return encodePNG(r.pixels, width, height);
}

// one pool of shading threads for the server (render_view, render_animation, export_gif); idle threads
// do not keep the process alive
let poolPromise = null;
export const getPool = () => (poolPromise ??= ShadePool.create());

export async function renderPNGAsync(doc, { width = 768, height = 512, camera = doc.data.camera, shading = 'gouraud', wireframe = false,
  highlight = [], quality = 'high', samples = 8, time = 0, effects = true } = {}) {
  const r = new Renderer({ width, height }).setPool(await getPool());
  r.shading = shading;
  r.wireframe = wireframe;
  r.quality = quality;
  const scene = buildRenderScene(doc.data, (s) => doc.geometry(s), { selected: highlight, time, effects });
  const cam = cameraFromState(camera);
  const n = quality === 'high' ? Math.max(1, samples) : 1;
  for (let i = 0; i < n; i++) await r.renderAsync(scene, cam, { accumulate: i > 0 });
  return encodePNG(r.pixels, width, height);
}

export async function renderBase64(doc, opts) {
  await preloadTextures(doc);
  return (await renderPNGAsync(doc, opts)).toString('base64');
}

// render_animation: several frames in one PNG
export async function renderSheet(doc, opts) {
  await preloadTextures(doc);
  const sheet = await renderContactSheet(doc.data, (s) => doc.geometry(s), { samples: 4, pool: await getPool(), ...opts });
  return { png: encodePNG(sheet.pixels, sheet.width, sheet.height).toString('base64'), times: sheet.times, columns: sheet.columns };
}

export async function gifBytes(doc, opts) {
  await preloadTextures(doc);
  return renderGIF(doc.data, (s) => doc.geometry(s), { pool: await getPool(), ...opts });
}

// export_gif: written to <cwd>/exports/<name>.gif (the name is sanitized by the tool)
export async function saveGif(doc, { name = 'animation', ...opts }) {
  const t0 = performance.now(), gif = await gifBytes(doc, opts);
  const dir = resolve(process.cwd(), 'exports'), file = resolve(dir, `${name}.gif`);
  if (!file.startsWith(dir + sep)) throw new Error('invalid file name');
  await mkdir(dir, { recursive: true });
  await writeFile(file, gif.bytes);
  return { file, bytes: gif.bytes.length, frames: gif.frames, seconds: gif.seconds, ms: Math.round(performance.now() - t0) };
}

// everything the tools need for images, as one context object
export const renderers = { render: renderBase64, renderSheet, saveGif };
