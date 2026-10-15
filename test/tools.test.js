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

test('every shape type in the reference builds', () => {
  const samples = {
    box: {}, roundedBox: { radius: 0.1, cornerRadius: 0.3 }, sphere: {}, cylinder: {}, cone: {}, torus: {}, plane: {}, terrain: { resolution: 16 },
    lathe: { profile: [[0, 0], [1, 0], [0.5, 1]] }, extrude: { shape: { type: 'star' } },
    sweep: { shape: { type: 'rect', width: 0.2, height: 0.1 }, path: { type: 'helix' }, twist: 90 },
    tube: { path: [[0, 0, 0], [1, 1, 0], [2, 0, 0]] }, mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
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
