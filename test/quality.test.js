import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SceneDocument } from '../src/document.js';
import { Renderer } from '../src/renderer.js';
import { buildRenderScene, cameraFromState } from '../src/scene.js';
import { buildToneLUT } from '../src/lighting.js';

// brightness of the pixel where a world point lands
function sample(r, p) {
  const m = r._vp;
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  const px = Math.floor((x / w * 0.5 + 0.5) * r.width), py = Math.floor((0.5 - y / w * 0.5) * r.height);
  const c = r.color[py * r.width + px];
  return (c & 255) + ((c >>> 8) & 255) + ((c >>> 16) & 255);
}

function boxScene() {
  const doc = new SceneDocument();
  doc.addObjects([{ shape: { type: 'box' }, position: [0, 0.5, 0], material: { color: '#ffffff' } }], {});
  doc.setEnvironment({ light: { direction: [1, 1, 0] }, fog: null }, {});
  return buildRenderScene(doc.data, (s) => doc.geometry(s));
}

test('high quality: the box casts a shadow away from the light', () => {
  const scene = boxScene(), r = new Renderer({ width: 200, height: 200 });
  const cam = cameraFromState({ yaw: 0, pitch: 89, distance: 6, target: [0, 0, 0] });
  // both points lie inside checker cells of the same color; the light comes from +x at 45 degrees
  const left = [-0.8, 0, 0.25], right = [1.5, 0, 0.25];
  r.render(scene, cam);
  const shadowed = sample(r, left), lit = sample(r, right);
  assert.ok(shadowed < lit * 0.75, `shadowed ${shadowed} should be clearly darker than lit ${lit}`);
  r.shadows = false;
  r.ao = false;
  r.render(scene, cam);
  const a = sample(r, left), b = sample(r, right);
  assert.ok(Math.abs(a - b) < 12, `without shadows both points match (${a} vs ${b})`);
});

test('progressive accumulation counts samples and resets on a new frame', () => {
  const scene = boxScene(), r = new Renderer({ width: 64, height: 64 });
  const cam = cameraFromState({ yaw: 30, pitch: 30, distance: 4, target: [0, 0.5, 0] });
  r.render(scene, cam);
  for (let i = 0; i < 5; i++) r.render(scene, cam, { accumulate: true });
  assert.equal(r.samples, 6);
  r.render(scene, cam);
  assert.equal(r.samples, 1);
  r.quality = 'fast';
  r.render(scene, cam, { accumulate: true });
  assert.equal(r.samples, 1);
});

test('tone curve is monotonic and maps black to black', () => {
  const lut = buildToneLUT(1);
  assert.equal(lut[0], 0);
  for (let i = 1; i < lut.length; i += 97) assert.ok(lut[i] >= lut[i - 1]);
  assert.ok(lut[lut.length - 1] > 250);
});
