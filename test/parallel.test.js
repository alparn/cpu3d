import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SceneDocument, Renderer, buildRenderScene, cameraFromState, updateAnimation } from '../src/index.js';
import { ShadePool } from '../src/pool.js';

const load = (id) => new SceneDocument(JSON.parse(readFileSync(new URL(`../examples/${id}.json`, import.meta.url), 'utf8')));
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return s / (a.length * 0.75); };

test('worker pool renders exactly the same pixels as one thread', async () => {
  const pool = await ShadePool.create({ threads: 3 });
  assert.ok(pool, 'worker threads available');
  try {
    const doc = load('castle'), scene = buildRenderScene(doc.data, (s) => doc.geometry(s)), cam = cameraFromState(doc.data.camera);
    const a = new Renderer({ width: 160, height: 100 }), b = new Renderer({ width: 160, height: 100 }).setPool(pool);
    for (const opts of [{}, { accumulate: true }, { accumulate: true }]) { a.render(scene, cam, opts); await b.renderAsync(scene, cam, opts); }
    assert.equal(diff(a.pixels, b.pixels), 0);
    assert.equal(a.samples, 3);
  } finally { pool.terminate(); }
});

test('temporal anti-aliasing converges on a still view and follows a moving one', () => {
  const doc = load('chess'), scene = buildRenderScene(doc.data, (s) => doc.geometry(s));
  const W = 160, H = 100, ref = new Renderer({ width: W, height: H }), taa = new Renderer({ width: W, height: H }), one = new Renderer({ width: W, height: H });
  const c = { ...doc.data.camera };
  ref.render(scene, cameraFromState(c));
  for (let i = 0; i < 15; i++) ref.render(scene, cameraFromState(c), { accumulate: true });
  for (let i = 0; i < 16; i++) taa.render(scene, cameraFromState(c), { temporal: true });
  one.render(scene, cameraFromState(c));
  assert.ok(diff(taa.pixels, ref.pixels) < diff(one.pixels, ref.pixels) * 0.7, 'still: temporal history is closer to the 16-sample image than one frame');

  // moving camera: no ghost of the old view (compare with a fresh frame of the final view)
  for (let i = 0; i < 10; i++) { c.yaw += 1.5; taa.render(scene, cameraFromState(c), { temporal: true }); }
  one.render(scene, cameraFromState(c));
  assert.ok(diff(taa.pixels, one.pixels) < 6, `moving: close to the current view (${diff(taa.pixels, one.pixels).toFixed(2)})`);

  // the first refinement sample starts from the history (no drop in quality when the motion stops)
  taa.render(scene, cameraFromState(c), { accumulate: true });
  assert.ok(taa.samples > 2);
});

test('animated meshes reuse the static shadow map', () => {
  const doc = load('city'), scene = buildRenderScene(doc.data, (s) => doc.geometry(s), { time: 1 });
  const r = new Renderer({ width: 120, height: 80 }), cam = cameraFromState(doc.data.camera);
  r.render(scene, cam);
  const base = scene._shadow.local.base;
  assert.ok(scene.meshes.some((m) => m.dynamic), 'the blimp is dynamic');
  updateAnimation(scene, 2);
  r.render(scene, cam);
  assert.equal(scene._shadow.local.base, base, 'static casters were not drawn again');
  scene.staticVersion = 1;
  r.render(scene, cam);
  assert.notEqual(scene._shadow.local.base, base, 'staticVersion rebuilds the base');
});
