// Headless rendering for render_view and the CLI: CPU renderer -> PNG, no browser or GPU needed.
import { Renderer } from '../src/renderer.js';
import { buildRenderScene, cameraFromState } from '../src/scene.js';
import { encodePNG } from './png.js';

export function renderPNG(doc, { width = 768, height = 512, camera = doc.data.camera, shading = 'gouraud', wireframe = false, highlight = [] } = {}) {
  const r = new Renderer({ width, height });
  r.shading = shading;
  r.wireframe = wireframe;
  const scene = buildRenderScene(doc.data, (s) => doc.geometry(s), { selected: highlight });
  r.render(scene, cameraFromState(camera));
  return encodePNG(r.pixels, width, height);
}

export const renderBase64 = (doc, opts) => renderPNG(doc, opts).toString('base64');
