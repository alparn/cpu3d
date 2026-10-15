// Headless rendering for render_view and the CLI: CPU renderer -> PNG, no browser or GPU needed.
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Renderer } from '../src/renderer.js';
import { buildRenderScene, cameraFromState } from '../src/scene.js';
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
  highlight = [], quality = 'high', samples = 8 } = {}) {
  const r = new Renderer({ width, height });
  r.shading = shading;
  r.wireframe = wireframe;
  r.quality = quality;
  const scene = buildRenderScene(doc.data, (s) => doc.geometry(s), { selected: highlight });
  const cam = cameraFromState(camera);
  const n = quality === 'high' ? Math.max(1, samples) : 1;
  for (let i = 0; i < n; i++) r.render(scene, cam, { accumulate: i > 0 });
  return encodePNG(r.pixels, width, height);
}

export async function renderBase64(doc, opts) {
  await preloadTextures(doc);
  return renderPNG(doc, opts).toString('base64');
}
