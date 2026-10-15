import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/geometry.js';

const close = (a, b, eps) => Math.abs(a - b) < eps;

test('closed primitives face outwards and have the right volume', () => {
  assert.ok(close(G.box(1, 2, 3).signedVolume(), 6, 1e-9));
  assert.ok(close(G.sphere(1, 64, 32).signedVolume(), (4 / 3) * Math.PI, 0.03));
  assert.ok(close(G.cylinder(0.5, 0.5, 1, 64).signedVolume(), Math.PI * 0.25, 0.01));
  assert.ok(close(G.cone(0.5, 1, 64).signedVolume(), (Math.PI * 0.25) / 3, 0.01));
  assert.ok(close(G.torus(1, 0.25, 96, 32).signedVolume(), 2 * Math.PI * Math.PI * 0.0625, 0.01));
  for (const g of [G.extrude(G.shapes.star(5, 1, 0.4), 0.3), G.tube(G.paths.torusKnot(), 0.1, 12, { closed: true }),
    G.tube(G.paths.helix(), 0.05, 8), G.sweep(G.shapes.star(), G.paths.line([0, 0, 0], [0, 2, 0], 20), { twist: 2 })]) {
    assert.ok(g.signedVolume() > 0);
  }
});

test('rounded box and rounded rectangle', () => {
  const b = G.roundedBox(0.72, 1.5, 0.08, 0.035, 0.11, 8);
  assert.deepEqual(b.min.map((v) => +v.toFixed(6)), [-0.36, -0.75, -0.04]);
  assert.deepEqual(b.max.map((v) => +v.toFixed(6)), [0.36, 0.75, 0.04]);
  const v = b.signedVolume();
  assert.ok(v > 0 && v < 0.72 * 1.5 * 0.08, 'outward and a bit smaller than the sharp box');
  const r = G.shapes.roundedRect(1, 1, 0.2, 16);
  assert.ok(close(G.polygonArea(r), 1 - (4 - Math.PI) * 0.04, 2e-3));
});

test('extrude with holes: rings and spoked gears have the expected volume', () => {
  const ring = G.extrude(G.shapes.circle(1, 64), 0.5, [G.shapes.circle(0.6, 64)]);
  const ringArea = G.polygonArea(G.shapes.circle(1, 64)) - G.polygonArea(G.shapes.circle(0.6, 64));
  assert.ok(close(ring.signedVolume(), ringArea * 0.5, 1e-5)); // positions are float32
  const holes = [0, 1, 2, 3, 4].map((k) => G.shapes.circle(0.18, 24).map(([x, y]) => [x + 0.5 * Math.cos(k * 1.2566), y + 0.5 * Math.sin(k * 1.2566)]));
  const gear = G.extrude(G.shapes.star(40, 1, 0.92), 0.1, holes);
  const area = G.polygonArea(G.shapes.star(40, 1, 0.92)) - 5 * G.polygonArea(G.shapes.circle(0.18, 24));
  assert.ok(close(gear.signedVolume(), area * 0.1, 1e-5));
});

test('ear clipping triangulates concave polygons completely', () => {
  const shape = [[0, 0], [4, 0], [4, 3], [2, 1], [0, 3]];
  const tri = G.triangulate(shape);
  assert.equal(tri.length / 3, shape.length - 2);
  let area = 0;
  for (let t = 0; t < tri.length; t += 3) {
    const [a, b, c] = [shape[tri[t]], shape[tri[t + 1]], shape[tri[t + 2]]];
    area += ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  assert.ok(close(area, G.polygonArea(shape), 1e-9));
});

test('OBJ round trip keeps geometry', () => {
  const g = G.parseOBJ(G.box(2, 1, 1).toOBJ());
  assert.equal(g.triangleCount, 12);
  assert.ok(close(g.signedVolume(), 2, 1e-6));
  const quad = G.parseOBJ('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1/1/1 2/2/2 3/3/3 4/4/4\nf -4 -3 -2\n');
  assert.equal(quad.triangleCount, 3);
});

test('transforms update normals and bounds; mirroring keeps winding outward', () => {
  const g = G.box(1, 1, 1).translate(0, 0.5, 0);
  assert.deepEqual(g.min.map((v) => +v.toFixed(6)), [-0.5, 0, -0.5]);
  const m = G.sphere(1).scale(-1, 1, 1);
  assert.ok(m.signedVolume() > 0);
});

test('noise displaces any shape along its normals, deterministically and without seams', async () => {
  const { buildShape } = await import('../src/recipes.js');
  const plain = buildShape({ type: 'lathe', profile: [[0, 0], [0.5, 0.2], [0.5, 1], [0, 1.2]], segments: 48 });
  const recipe = { type: 'lathe', profile: [[0, 0], [0.5, 0.2], [0.5, 1], [0, 1.2]], segments: 48, noise: { amplitude: 0.03, scale: 12 } };
  const a = buildShape(recipe), b = buildShape(recipe);
  assert.equal(a.vertexCount, plain.vertexCount);
  assert.deepEqual(Array.from(a.positions), Array.from(b.positions), 'same recipe, same surface');
  let moved = 0, maxD = 0;
  for (let i = 0; i < a.positions.length; i++) { const d = Math.abs(a.positions[i] - plain.positions[i]); if (d > 1e-4) moved++; maxD = Math.max(maxD, d); }
  assert.ok(moved > a.positions.length / 3, 'most vertices moved');
  assert.ok(maxD <= 0.031, `bounded by the amplitude (${maxD})`);
  // vertices at the same position (the lathe seam) stay together and share one normal
  const seen = new Map();
  for (let v = 0; v < a.vertexCount; v++) {
    const k = [0, 1, 2].map((c) => Math.round(plain.positions[v * 3 + c] * 1e5)).join();
    const prev = seen.get(k);
    if (prev === undefined) { seen.set(k, v); continue; }
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(a.positions[v * 3 + c] - a.positions[prev * 3 + c]) < 1e-6, 'seam stays closed');
      assert.ok(Math.abs(a.normals[v * 3 + c] - a.normals[prev * 3 + c]) < 1e-5, 'seam shares the normal');
    }
  }
  assert.throws(() => buildShape({ type: 'sphere', noise: 3 }), /noise/);
});
