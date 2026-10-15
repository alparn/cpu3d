// Demo scenes, shared by the browser demo and the Node benchmark.
import * as G from '../src/geometry.js';
import { Mesh } from '../src/renderer.js';

const BG = { top: [0.09, 0.1, 0.13], bottom: [0.33, 0.35, 0.4] };
const LIGHT = { direction: [0.55, 0.85, 0.4], color: [1, 0.96, 0.9], sky: [0.3, 0.34, 0.42], ground: [0.12, 0.1, 0.09] };

export function orbitCamera(camera, view) {
  const { yaw, pitch, dist, target } = view;
  camera.target = target;
  camera.position = [
    target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
    target[1] + dist * Math.sin(pitch),
    target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
  ];
  return camera;
}

function checkerFloor(size = 16, cells = 32) {
  return G.grid(size, size, cells, cells).setFaceColors((x, y, z) =>
    (Math.floor(x) + Math.floor(z)) & 1 ? [0.42, 0.42, 0.44] : [0.3, 0.3, 0.32]);
}

// ---- value noise for the terrain
function hash(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) {
  let s = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 5; o++) { s += amp * noise(x * f, y * f); f *= 2.03; amp *= 0.5; }
  return s;
}

const knotGeometry = () => G.tube(G.paths.torusKnot(2, 3, 256, 1.6), 0.14, 12, { closed: true });

export const scenes = {
  showcase() {
    const ring = (i, n, r = 3.4) => [Math.cos((i / n) * 2 * Math.PI) * r, Math.sin((i / n) * 2 * Math.PI) * r];
    const meshes = [new Mesh(checkerFloor(), { specular: 0 })];
    const spinners = [];
    const add = (geo, opts, spin = 0.4) => {
      const m = new Mesh(geo, opts);
      meshes.push(m);
      if (spin) spinners.push([m, spin]);
      return m;
    };

    // centre: torus knot = tube swept along a closed path
    add(knotGeometry(), { color: [0.95, 0.55, 0.2], specular: 0.6, shininess: 40, position: [0, 1.7, 0] }, 0.35);

    const N = 7;
    let [x, z] = ring(0, N);
    // lathe: vase (open at the top, so double sided)
    const profile = [[0, 0]];
    for (let i = 0; i <= 40; i++) {
      const y = (i / 40) * 1.9;
      profile.push([0.42 + 0.2 * Math.sin(y * 2.6 - 0.6) + 0.04 * Math.sin(y * 11), y]);
    }
    add(G.lathe(profile, 48), { color: [0.3, 0.6, 0.85], specular: 0.5, doubleSided: true, position: [x, 0, z] }, 0);

    // sweep with twist: twisted star column
    [x, z] = ring(1, N);
    add(G.sweep(G.shapes.star(6, 0.45, 0.28), G.paths.line([0, 0, 0], [0, 1.9, 0], 60), { twist: Math.PI }),
      { color: [0.85, 0.8, 0.35], position: [x, 0, z] }, 0.5);

    // extrude: concave 2D shape -> ear-clipped caps
    [x, z] = ring(2, N);
    add(G.extrude(G.shapes.star(5, 0.75, 0.32), 0.3), { color: [0.85, 0.3, 0.35], position: [x, 1, z] }, 0.8);

    // sphere (lathe of a half circle)
    [x, z] = ring(3, N);
    add(G.sphere(0.65, 40, 20), { color: [0.8, 0.82, 0.86], specular: 0.9, shininess: 60, position: [x, 0.65, z] }, 0);

    // torus (circle swept along circle)
    [x, z] = ring(4, N);
    add(G.torus(0.55, 0.2, 48, 20), { color: [0.35, 0.75, 0.45], position: [x, 0.8, z] }, 0.7);

    // spring: tube along a helix
    [x, z] = ring(5, N);
    add(G.tube(G.paths.helix(0.4, 1.6, 5, 300), 0.07, 10), { color: [0.75, 0.75, 0.8], specular: 0.8, position: [x, 0.1, z] }, 0.3);

    // merged primitives: box stack + cone
    [x, z] = ring(6, N);
    const stack = G.Geometry.merge(
      G.box(0.9, 0.4, 0.9).translate(0, 0.2, 0),
      G.box(0.6, 0.4, 0.6).rotate(0, 0.4, 0).translate(0, 0.6, 0),
      G.cylinder(0.25, 0.25, 0.4, 32).translate(0, 1.0, 0),
      G.cone(0.3, 0.6, 32).translate(0, 1.5, 0),
    );
    add(stack, { color: [0.65, 0.45, 0.85], position: [x, 0, z] }, 0.25);

    return {
      meshes, background: BG, light: LIGHT, fog: { near: 12, far: 30 },
      view: { yaw: 0.5, pitch: 0.42, dist: 10.5, target: [0, 0.9, 0] },
      update(t) { for (const [m, s] of spinners) m.rotation[1] = t * s; },
    };
  },

  stress({ count = 6 } = {}) {
    const geo = knotGeometry();
    const meshes = [new Mesh(checkerFloor(40, 40), { specular: 0 })];
    const gap = 3.6;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        const hue = (i * count + j) / (count * count);
        meshes.push(new Mesh(geo, {
          color: [0.55 + 0.4 * Math.sin(hue * 6.28), 0.55 + 0.4 * Math.sin(hue * 6.28 + 2.1), 0.55 + 0.4 * Math.sin(hue * 6.28 + 4.2)],
          specular: 0.5, position: [(i - (count - 1) / 2) * gap, 1.6, (j - (count - 1) / 2) * gap],
        }));
      }
    }
    return {
      meshes, background: BG, light: LIGHT, fog: { near: 20 + count * 2, far: 45 + count * 5 },
      view: { yaw: 0.6, pitch: 0.5, dist: 8 + count * 3.2, target: [0, 1, 0] },
      update(t) { meshes.forEach((m, i) => { if (i) { m.rotation[1] = t * 0.6 + i; m.rotation[0] = t * 0.3; } }); },
    };
  },

  terrain() {
    const geo = G.grid(80, 80, 220, 220, (x, z) => Math.max(0, (fbm(x * 0.045 + 10, z * 0.045 + 3) - 0.42) * 22));
    geo.setColors((x, y, z, nx, ny) => {
      if (y < 0.02) return [0.15, 0.33, 0.52];
      if (y < 0.5) return [0.74, 0.68, 0.48];
      if (y > 7 && ny > 0.6) return [0.94, 0.95, 0.97];
      if (ny < 0.72) return [0.45, 0.42, 0.4];
      const t = Math.min(1, y / 7);
      return [0.28 + 0.12 * t, 0.48 - 0.08 * t, 0.2 + 0.05 * t];
    });
    const sky = { top: [0.3, 0.45, 0.68], bottom: [0.72, 0.78, 0.84] };
    return {
      meshes: [new Mesh(geo, { specular: 0 })],
      background: sky, light: { ...LIGHT, sky: [0.45, 0.5, 0.6] }, fog: { near: 18, far: 60, color: sky.bottom },
      view: { yaw: 0.8, pitch: 0.38, dist: 34, target: [0, 1, 0] }, spin: 0.05,
    };
  },

  obj({ geometry = null } = {}) {
    // default model: a bumpy "supershape" from a parametric surface
    const geo = geometry ?? G.parametric((u, v) => {
      const th = u * 2 * Math.PI, ph = v * Math.PI;
      const r = 1 + 0.18 * Math.sin(6 * th) * Math.sin(5 * ph);
      return [r * Math.sin(ph) * Math.cos(th), -r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)];
    }, 96, 64, { closeU: true }).orientOutward();
    geo.fit(1.4);
    const model = new Mesh(geo, { color: [0.82, 0.78, 0.7], specular: 0.4, doubleSided: true, position: [0, -geo.min[1], 0] });
    return {
      meshes: [new Mesh(checkerFloor(), { specular: 0 }), model],
      background: BG, light: LIGHT, fog: { near: 12, far: 30 },
      view: { yaw: 0.5, pitch: 0.3, dist: 5, target: [0, 1.2, 0] }, spin: 0.15,
    };
  },
};
