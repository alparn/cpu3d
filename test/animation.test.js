import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SceneDocument, callTool, buildRenderScene, animatedMatrix, animatedEmissive, updateAnimation, sceneHasAnimation } from '../src/index.js';
import { renderBase64 } from '../server/render.js';

const ctx = { source: 'test', render: async (doc, o) => renderBase64(doc, o) };
const call = (doc, name, args) => callTool(doc, name, args, ctx);
const json = (r) => JSON.parse(r.content[0].text);
const apply = (m, p) => [0, 1, 2].map((i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i]);
const near = (a, b, msg) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${msg}: ${a} vs ${b}`));

test('spin, swing, bob and orbit move the object matrix', () => {
  const spin = { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], animation: { spin: { axis: [0, 1, 0], speed: 90 } } };
  near(apply(animatedMatrix(spin, 1), [1, 0, 0]), [1, 0, -1], 'spin turns around the own origin');
  near(apply(animatedMatrix(spin, 0), [1, 0, 0]), [2, 0, 0], 'time 0 is the rest pose');

  const tick = { ...spin, animation: { spin: { axis: [0, 1, 0], speed: 90, step: 1 } } };
  near(apply(animatedMatrix(tick, 1.9), [1, 0, 0]), apply(animatedMatrix(tick, 1), [1, 0, 0]), 'step holds the angle between ticks');

  const pivot = { ...spin, animation: { spin: { axis: [0, 1, 0], speed: 90, pivot: [0, 0, 0] } } };
  near(apply(animatedMatrix(pivot, 1), [0, 0, 0]), [0, 0, -1], 'pivot spins around a world axis');

  const orbit = { ...spin, animation: { orbit: { center: [0, 0, 0], axis: [0, 1, 0], speed: 180 } } };
  near(apply(animatedMatrix(orbit, 1), [0, 0, 0]), [-1, 0, 0], 'orbit moves around the center');

  const bob = { ...spin, animation: { bob: { axis: [0, 1, 0], amplitude: 0.5, period: 4, phase: 0 } } };
  near(apply(animatedMatrix(bob, 1), [0, 0, 0]), [1, 0.5, 0], 'bob peaks at a quarter period');

  const swing = { ...spin, animation: { swing: { axis: [0, 0, 1], amplitude: 90, period: 4, phase: 0 } } };
  near(apply(animatedMatrix(swing, 1), [1, 0, 0]), [1, 1, 0], 'swing reaches its amplitude at a quarter period');
});

test('pulse scales the emissive value', () => {
  const o = { material: { emissive: 2 }, animation: { pulse: { min: 0, max: 1, period: 2, phase: 0, blink: true } } };
  const values = [0.25, 0.75, 1.25, 1.75].map((t) => animatedEmissive(o, t));
  assert.ok(values.every((v) => v === 0 || v === 2), `blink is on/off: ${values}`);
  assert.ok(values.includes(0) && values.includes(2));
});

test('set_animation validates, stores and undoes behaviours', async () => {
  const doc = new SceneDocument();
  await call(doc, 'add_objects', { objects: [{ name: 'Rotor', shape: { type: 'box' } }] });
  assert.equal(sceneHasAnimation(doc.data), false);
  const r = json(await call(doc, 'set_animation', { id: 'obj_1', animation: { spin: { speed: 45 } }, duration: 8 }));
  assert.deepEqual(r.animation.spin, { axis: [0, 1, 0], speed: 45 });
  assert.equal(doc.data.animation.duration, 8);
  assert.equal(sceneHasAnimation(doc.data), true);

  for (const bad of [{ wobble: {} }, { spin: { axis: [0, 0, 0] } }, { pulse: { max: 99 } }, [1]]) {
    const res = await call(doc, 'set_animation', { id: 'obj_1', animation: bad });
    assert.equal(res.isError, true, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal((await call(doc, 'set_animation', { duration: 0 })).isError, true);

  await call(doc, 'set_animation', { id: 'obj_1', animation: null });
  assert.equal(doc.data.objects[0].animation, undefined);
  await call(doc, 'undo', {});
  assert.equal(doc.data.objects[0].animation.spin.speed, 45);
  const saved = new SceneDocument(JSON.parse(JSON.stringify(doc.data)));
  assert.equal(saved.data.objects[0].animation.spin.speed, 45, 'animation survives save and load');
});

test('updateAnimation moves meshes and invalidates the shadow cache', async () => {
  const doc = new SceneDocument();
  await call(doc, 'add_objects', { objects: [{ shape: { type: 'box' }, position: [2, 0, 0], animation: { orbit: { speed: 90 } } }] });
  const scene = buildRenderScene(doc.data, (s) => doc.geometry(s));
  const mesh = scene.meshes.find((m) => m.object), v = scene.version, before = Array.from(mesh.matrix);
  updateAnimation(scene, 1);
  assert.notEqual(scene.version, v);
  near(apply(mesh.matrix, [0, 0, 0]), [0, 0, -2], 'mesh followed the orbit');
  assert.notDeepEqual(Array.from(mesh.matrix), before);

  const r0 = await call(doc, 'render_view', { width: 64, height: 48, time: 0 });
  const r1 = await call(doc, 'render_view', { width: 64, height: 48, time: 1 });
  const img = (r) => r.content.find((c) => c.type === 'image').data;
  assert.notEqual(img(r0), img(r1), 'render_view(time) shows the animated pose');
});
