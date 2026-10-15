import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SceneDocument, callTool, buildShape, SHAPE_TYPES } from '../src/index.js';
import { renderBase64 } from '../server/render.js';

const ctx = { source: 'test', render: async (doc, o) => renderBase64(doc, o) };
const call = (doc, name, args) => callTool(doc, name, args, ctx);
const json = (r) => JSON.parse(r.content[0].text);

test('add, update, remove, undo and redo', async () => {
  const doc = new SceneDocument();
  const add = json(await call(doc, 'add_objects', { objects: [
    { name: 'Box', shape: { type: 'box', height: 2 }, position: [0, 1, 0] },
    { shape: { type: 'sphere' }, material: { color: '#f80' } },
  ] }));
  assert.equal(add.added.length, 2);
  assert.deepEqual(add.added[0].bounds, { min: [-0.5, 0, -0.5], max: [0.5, 2, 0.5] });
  assert.equal(doc.data.objects[1].material.color, '#ff8800');

  await call(doc, 'update_object', { id: 'obj_1', position: [2, 1, 0], material: { flat: true } });
  assert.deepEqual(doc.data.objects[0].position, [2, 1, 0]);
  assert.equal(doc.data.objects[0].material.flat, true);
  assert.equal(doc.data.objects[0].material.color, '#c8c8c8', 'material patch merges');

  await call(doc, 'remove_objects', { ids: ['obj_2'] });
  assert.equal(doc.data.objects.length, 1);
  await call(doc, 'undo', {});
  assert.equal(doc.data.objects.length, 2);
  await call(doc, 'redo', {});
  assert.equal(doc.data.objects.length, 1);
});

test('invalid input returns helpful errors and leaves the scene untouched', async () => {
  const doc = new SceneDocument();
  for (const [name, args, msg] of [
    ['add_objects', { objects: [{ shape: { type: 'sphere', radius: 'big' } }] }, /radius/],
    ['add_objects', { objects: [{ shape: { type: 'blob' } }] }, /unknown shape type/],
    ['add_objects', { objects: [{ shape: { type: 'box' }, position: [1, 2] }] }, /position/],
    ['update_object', { id: 'obj_42', name: 'x' }, /no object with id/],
    ['add_objects', { objects: [{ shape: { type: 'box' }, material: { emissive: 50 } }] }, /emissive/],
    ['add_objects', { objects: [{ shape: { type: 'box' }, material: { texture: '../../etc/passwd.png' } }] }, /texture/],
    ['add_objects', { objects: [{ shape: { type: 'box' }, material: { texture: 'https://example.com/a.png' } }] }, /texture/],
    ['set_environment', { reflections: 'disco' }, /reflections/],
    ['nope', {}, /Unknown tool/],
  ]) {
    const r = await call(doc, name, args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, msg);
  }
  assert.equal(doc.data.objects.length, 0);
  assert.equal(doc.revision, 0);
});

test('radial arrays and partial lathes', () => {
  const ring = buildShape({ type: 'radial', count: 12, radius: 2, shape: { type: 'box', width: 0.2, height: 0.3, depth: 0.1 } });
  assert.equal(ring.triangleCount, 144);
  assert.ok(Math.abs(ring.signedVolume() - 12 * 0.006) < 1e-5);
  // a 3/4 pipe from a closed profile loop is a closed solid with capped cut faces
  const pipe = buildShape({ type: 'lathe', profile: [[1, 0], [1.2, 0], [1.2, 1], [1, 1], [1, 0]], segments: 96, phiLength: 270 });
  assert.ok(Math.abs(pipe.signedVolume() - Math.PI * 0.44 * 0.75) / (Math.PI * 0.44 * 0.75) < 2e-3);
  assert.throws(() => buildShape({ type: 'radial', count: 5000, shape: { type: 'box' } }), /count/);
});

test('every shape type in the reference builds', () => {
  const samples = {
    radial: { count: 6, radius: 1, shape: { type: 'sphere', segments: 8, rings: 4 } }, box: {}, roundedBox: { radius: 0.1, cornerRadius: 0.3 }, sphere: {}, cylinder: {}, cone: {}, torus: {}, plane: {}, terrain: { resolution: 16 },
    lathe: { profile: [[0, 0], [1, 0], [0.5, 1]] }, extrude: { shape: { type: 'star' } },
    sweep: { shape: { type: 'rect', width: 0.2, height: 0.1 }, path: { type: 'helix' }, twist: 90 },
    tube: { path: [[0, 0, 0], [1, 1, 0], [2, 0, 0]] }, mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
    blade: {}, scatter: { count: 50, shape: { type: 'blade' } },
  };
  for (const type of SHAPE_TYPES) assert.ok(buildShape({ type, ...samples[type] }).triangleCount > 0, type);
});

test('render_view returns a PNG image', async () => {
  const doc = new SceneDocument(JSON.parse(readFileSync(new URL('../examples/showcase.json', import.meta.url))));
  const r = await call(doc, 'render_view', { width: 160, height: 100, focus: 'all' });
  const img = r.content.find((c) => c.type === 'image');
  const png = Buffer.from(img.data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 160);
});

test('probe_height finds surfaces', async () => {
  const doc = new SceneDocument();
  await call(doc, 'add_objects', { objects: [{ shape: { type: 'box', width: 2, height: 1, depth: 2 }, position: [0, 0.5, 0] }] });
  const [hit, miss] = json(await call(doc, 'probe_height', { points: [[0, 0], [5, 5]] }));
  assert.ok(Math.abs(hit.y - 1) < 1e-6);
  assert.equal(hit.object.id, 'obj_1');
  assert.equal(miss.object, null);
});

test('export and import OBJ', async () => {
  const doc = new SceneDocument();
  await call(doc, 'add_objects', { objects: [{ shape: { type: 'box' }, position: [3, 0.5, 0] }] });
  const obj = (await call(doc, 'export_obj', {})).content[0].text;
  assert.match(obj, /^v 3\.5 /m);
  const imported = json(await call(doc, 'import_obj', { text: obj, fit: null }));
  assert.equal(imported.triangles, 12);
});

test('scatter places copies over the area, wind is a validated behaviour', async () => {
  const g = buildShape({ type: 'scatter', count: 200, width: 10, depth: 4, seed: 3, shape: { type: 'blade', height: 1, segments: 3 } });
  assert.equal(g.triangleCount, 200 * 5);
  assert.ok(g.min[0] > -5.6 && g.max[0] < 5.6 && g.min[2] > -2.6 && g.max[2] < 2.6, 'inside the area');
  assert.deepEqual(Array.from(g.positions.slice(0, 9)), Array.from(buildShape({ type: 'scatter', count: 200, width: 10, depth: 4, seed: 3, shape: { type: 'blade', height: 1, segments: 3 } }).positions.slice(0, 9)), 'deterministic');
  const doc = new SceneDocument();
  await call(doc, 'add_objects', { objects: [{ shape: { type: 'blade' }, animation: { wind: { strength: 0.2, direction: [0, 1] } } }] });
  assert.deepEqual(doc.data.objects[0].animation.wind, { strength: 0.2, wavelength: 4, speed: 1.5, direction: [0, 1] });
  assert.equal((await call(doc, 'set_animation', { id: doc.data.objects[0].id, animation: { wind: { direction: [0, 0] } } })).isError, true);
  await call(doc, 'set_environment', { atmosphere: { color: '#1d5a6e', density: 0.5, rays: 1.2 } });
  assert.equal(doc.data.environment.atmosphere.rays, 1.2);
  assert.equal((await call(doc, 'set_environment', { atmosphere: { density: -1 } })).isError, true);
});
