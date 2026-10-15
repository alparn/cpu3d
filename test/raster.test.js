import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/renderer.js';

// Reference: brute-force pixel-center test with the same sub-pixel grid and top-left rule.
function reference(W, H, x0, y0, x1, y1, x2, y2) {
  if ((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0) < 0) { [x1, x2] = [x2, x1]; [y1, y2] = [y2, y1]; }
  const topLeft = (ax, ay, bx, by) => by - ay < 0 || (by === ay && bx > ax);
  const E = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax) - (topLeft(ax, ay, bx, by) ? 0 : 1);
  const out = new Set();
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const sx = px * 16 + 8, sy = py * 16 + 8;
      if (E(x1, y1, x2, y2, sx, sy) >= 0 && E(x2, y2, x0, y0, sx, sy) >= 0 && E(x0, y0, x1, y1, sx, sy) >= 0) out.add(py * W + px);
    }
  }
  return out;
}

test('rasterizer coverage matches a brute-force reference exactly', () => {
  const W = 48, H = 48, r = new Renderer({ width: W, height: H });
  r._flat = true; r._cull = false; r._wire = false;
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % (W * 16 + 160) - 80; };
  for (let n = 0; n < 1500; n++) {
    const v = [rnd(), rnd(), rnd(), rnd(), rnd(), rnd()];
    if ((v[2] - v[0]) * (v[5] - v[1]) - (v[4] - v[0]) * (v[3] - v[1]) === 0) continue;
    r.color.fill(0); r.depth.fill(0);
    r._raster(v[0], v[1], 1, 255, 255, 255, v[2], v[3], 1, 255, 255, 255, v[4], v[5], 1, 255, 255, 255);
    const got = new Set();
    r.color.forEach((c, i) => { if (c) got.add(i); });
    assert.deepEqual([...got].sort(), [...reference(W, H, ...v)].sort(), `triangle ${v}`);
  }
});

test('shared edges are drawn exactly once (no cracks, no overlap)', () => {
  const W = 32, H = 32, r = new Renderer({ width: W, height: H });
  r._flat = true; r._cull = false; r._wire = false;
  const count = new Uint8Array(W * H);
  // a fan of triangles around a shared center covering the whole screen
  const c = [256 + 3, 256 + 7], pts = [[-40, -40], [552, -40], [552, 552], [-40, 552]];
  r.depth.fill(0);
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4];
    r.color.fill(0); r.depth.fill(0);
    r._raster(c[0], c[1], 1, 255, 0, 0, a[0], a[1], 1, 255, 0, 0, b[0], b[1], 1, 255, 0, 0);
    r.color.forEach((v, j) => { if (v) count[j]++; });
  }
  assert.ok(count.every((n) => n === 1), 'every pixel covered exactly once');
});
