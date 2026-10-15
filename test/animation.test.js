import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SceneDocument, callTool, buildRenderScene, animatedMatrix, animatedEmissive, updateAnimation, sceneHasAnimation, cameraAt } from '../src/index.js';
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

test('keyframes: interpolation, set_keyframe merge and remove, camera path', async () => {
  const doc = new SceneDocument();
  await call(doc, 'add_objects', { objects: [{ name: 'Drone', shape: { type: 'box' } }] });
  await call(doc, 'set_animation', { id: 'obj_1', animation: { keys: [{ t: 0, position: [0, 0, 0] }, { t: 2, position: [4, 0, 0], emissive: 2 }], ease: 'linear' } });
  const o = () => doc.data.objects[0];
  near(apply(animatedMatrix(o(), 1), [0, 0, 0]), [2, 0, 0], 'linear halfway');
  near(apply(animatedMatrix(o(), 5), [0, 0, 0]), [4, 0, 0], 'holds after the last key');
  assert.equal(animatedEmissive(o(), 0), 2, 'a channel with one key is constant');

  await call(doc, 'set_keyframe', { id: 'obj_1', time: 1, position: [2, 3, 0], ease: 'smooth' });
  await call(doc, 'set_keyframe', { id: 'obj_1', time: 1, rotation: [0, 90, 0] });
  assert.deepEqual(o().animation.keys[1], { t: 1, position: [2, 3, 0], rotation: [0, 90, 0] }, 'keys at the same time merge');
  assert.equal(o().animation.ease, 'smooth');
  near(apply(animatedMatrix(o(), 1), [0, 0, 0]), [2, 3, 0], 'passes through the key');
  await call(doc, 'set_keyframe', { id: 'obj_1', time: 1, remove: true });
  assert.equal(o().animation.keys.length, 2);
  assert.equal((await call(doc, 'set_keyframe', { id: 'obj_1', time: 1 })).isError, true, 'a key needs a value');

  // spline passes through every key
  await call(doc, 'set_animation', { id: 'obj_1', animation: { keys: [0, 1, 2, 3].map((t) => ({ t, position: [t, t * t, 0] })), ease: 'spline' } });
  for (const t of [0, 1, 2, 3]) near(apply(animatedMatrix(o(), t), [0, 0, 0]), [t, t * t, 0], `spline at key ${t}`);

  await call(doc, 'set_animation', { camera: { keys: [{ t: 0, yaw: 0 }, { t: 10, yaw: 360 }], ease: 'linear' }, duration: 10 });
  assert.equal(cameraAt(doc.data, 5).yaw, 180);
  assert.equal(cameraAt(doc.data, 5).distance, doc.data.camera.distance, 'missing channels use the scene camera');
  await call(doc, 'set_keyframe', { id: 'camera', time: 5, pitch: 60 });
  assert.equal(doc.data.animation.camera.keys.length, 3);
  assert.equal((await call(doc, 'set_animation', { camera: { keys: [{ t: 0, pitch: 120 }] } })).isError, true);
  const saved = new SceneDocument(JSON.parse(JSON.stringify(doc.data)));
  assert.equal(saved.data.animation.camera.keys.length, 3, 'camera path survives save and load');
  await call(doc, 'set_animation', { camera: null });
  assert.equal(doc.data.animation.camera, undefined);
});

test('render_animation returns a contact sheet, export_gif writes a GIF', async () => {
  const { renderers } = await import('../server/render.js');
  const { mkdtempSync, readFileSync, rmSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const doc = new SceneDocument();
  await callTool(doc, 'add_objects', { objects: [{ shape: { type: 'box' }, animation: { spin: { speed: 90 } } }] }, {});
  const sheet = await callTool(doc, 'render_animation', { frames: 4, width: 400 }, { ...renderers });
  assert.ok(!sheet.isError, sheet.content[0].text);
  const png = Buffer.from(sheet.content.find((c) => c.type === 'image').data, 'base64');
  assert.ok(png.readUInt32BE(16) <= 400 && png.readUInt32BE(16) > 380, 'sheet width');
  assert.match(sheet.content[1].text, /4 frames/);

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cpu3d-'))), cwd = process.cwd();
  process.chdir(dir);
  try {
    const r = await callTool(doc, 'export_gif', { name: '../evil name', width: 96, height: 64, seconds: 0.4, fps: 10, samples: 1 }, { ...renderers });
    const info = JSON.parse(r.content[0].text);
    assert.equal(info.file, join(dir, 'exports', 'evil-name.gif'), 'file names stay inside exports/');
    assert.equal(info.frames, 4);
    assert.equal(readFileSync(info.file).subarray(0, 6).toString(), 'GIF89a');
  } finally { process.chdir(cwd); rmSync(dir, { recursive: true }); }
});

test('flow moves along the axis, starts over and fades at the ends', async () => {
  const doc = new SceneDocument();
  await call(doc, 'add_objects', { objects: [{ shape: { type: 'box' }, material: { emissive: 2 },
    animation: { flow: { axis: [0, 0, -2], distance: 4, speed: 2, fade: 0.25 } } }] });
  const o = doc.data.objects[0];
  near(apply(animatedMatrix(o, 1), [0, 0, 0]), [0, 0, -2], 'halfway after 1 s');
  near(apply(animatedMatrix(o, 2.5), [0, 0, 0]), [0, 0, -1], 'starts over after distance / speed');
  assert.equal(animatedEmissive(o, 1), 2, 'full glow in the middle');
  assert.ok(animatedEmissive(o, 0.1) < 0.6, 'fades in at the start');
  const m = animatedMatrix(o, 0.1);
  assert.ok(Math.hypot(m[0], m[1], m[2]) < 0.5, 'grows in at the start');
  assert.equal((await call(doc, 'set_animation', { id: o.id, animation: { flow: { axis: [0, 0, 0] } } })).isError, true);
});
