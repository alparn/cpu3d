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

test('textures are projected along the thinnest axis with the image upright', async () => {
  const { encodePNG } = await import('../server/png.js');
  await import('../server/render.js'); // installs the Node texture loader
  const { loadTextures } = await import('../src/textures.js');
  // 2x2 image: top row red | green, bottom row blue | white
  const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const src = 'data:image/png;base64,' + encodePNG(px, 2, 2).toString('base64');
  await loadTextures([src]);
  const doc = new SceneDocument();
  doc.addObjects([{ shape: { type: 'plane', width: 2, depth: 2 }, rotation: [90, 0, 0], position: [0, 1, 0],
    material: { color: '#ffffff', texture: src, emissive: 1, doubleSided: true } }], {});
  doc.setEnvironment({ ground: false, reflections: 'none', fog: null }, {});
  const scene = buildRenderScene(doc.data, (s) => doc.geometry(s));
  const r = new Renderer({ width: 100, height: 100 });
  r.shadows = false; r.ao = false;
  r.render(scene, cameraFromState({ yaw: 0, pitch: 0, distance: 3, target: [0, 1, 0] }));
  const at = (x, y) => { const c = r.color[y * 100 + x]; return [c & 255, (c >>> 8) & 255, (c >>> 16) & 255]; };
  const [tl, tr, bl] = [at(38, 38), at(62, 38), at(38, 62)];
  assert.ok(tl[0] > 150 && tl[0] > 3 * tl[1] && tl[0] > 3 * tl[2], `top left red, got ${tl}`);
  assert.ok(tr[1] > 150 && tr[1] > 3 * tr[0] && tr[1] > 3 * tr[2], `top right green, got ${tr}`);
  assert.ok(bl[2] > 150 && bl[2] > 3 * bl[0] && bl[2] > 3 * bl[1], `bottom left blue, got ${bl}`);
});

test('PNG decoder round trip', async () => {
  const { encodePNG, decodePNG } = await import('../server/png.js');
  const px = new Uint8ClampedArray(5 * 3 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 41) % 256));
  const back = decodePNG(encodePNG(px, 5, 3));
  assert.equal(back.width, 5);
  assert.deepEqual([...back.data], [...px]);
});

test('procedural patterns and texture mappings', async () => {
  const { SceneDocument, Renderer, buildRenderScene, cameraFromState } = await import('../src/index.js');
  const doc = new SceneDocument();
  doc.addObjects([{ shape: { type: 'sphere', radius: 1, segments: 48, rings: 24 }, material: { color: '#808080' } }], { source: 't' });
  const cam = cameraFromState({ yaw: 0, pitch: 0, distance: 3.2, target: [0, 0, 0] });
  const render = () => { const r = new Renderer({ width: 96, height: 96 }); r.render(buildRenderScene(doc.data, (s) => doc.geometry(s), { showGround: false }), cam); return r.pixels.slice(); };
  const variance = (px) => { let s = 0, q = 0, n = 0; for (let y = 30; y < 66; y++) for (let x = 30; x < 66; x++) { const v = px[(y * 96 + x) * 4]; s += v; q += v * v; n++; } return q / n - (s / n) ** 2; };
  const plain = variance(render());
  const id = doc.data.objects[0].id;
  doc.updateObject(id, { material: { pattern: { type: 'checker', colors: ['#000000', '#ffffff'], scale: 0.4 } } }, { source: 't' });
  assert.ok(variance(render()) > plain * 3, 'checker pattern shows on the sphere');
  doc.updateObject(id, { material: { pattern: { type: 'leather', colors: ['#808080', '#808080'] } } }, { source: 't' });
  assert.equal(doc.data.objects[0].material.pattern.scale, 0.012, 'default scale per pattern type');
  assert.ok(variance(render()) > plain, 'leather relief changes the shading even with one colour');
  assert.throws(() => doc.updateObject(id, { material: { pattern: { type: 'lava', colors: ['#000', '#fff'] } } }, { source: 't' }), /pattern.type/);
  assert.throws(() => doc.updateObject(id, { material: { mapping: 'cube' } }, { source: 't' }), /mapping/);
  doc.updateObject(id, { material: { pattern: null, mapping: 'sphere', repeat: [4, 2] } }, { source: 't' });
  assert.equal(doc.data.objects[0].material.pattern, undefined);
  assert.deepEqual(doc.data.objects[0].material.repeat, [4, 2]);
});
