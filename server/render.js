// Headless rendering for render_view and the CLI: CPU renderer -> PNG, no browser or GPU needed.
import { Renderer } from '../src/renderer.js';
import { buildRenderScene, cameraFromState } from '../src/scene.js';
import { encodePNG } from './png.js';

// quality 'high' averages `samples` jittered frames (anti-aliasing, soft shadows, smooth AO)
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

export const renderBase64 = (doc, opts) => renderPNG(doc, opts).toString('base64');
