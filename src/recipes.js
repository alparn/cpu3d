// Shape recipes: plain JSON descriptions of geometry. This is the language agents (and the editor)
// use to describe shapes. A recipe is validated and turned into a Geometry by buildShape().
// No code is ever evaluated, so recipes from untrusted agents are safe to build.

import * as G from './geometry.js';

export const LIMITS = { maxSegments: 512, maxPoints: 20000, maxTrianglesPerObject: 1_000_000 };

const fail = (msg) => { throw new Error(msg); };

function num(v, def, name, min = -1e6, max = 1e6) {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`"${name}" must be a finite number`);
  if (v < min || v > max) fail(`"${name}" must be between ${min} and ${max} (got ${v})`);
  return v;
}
const int = (v, def, name, min, max) => Math.round(num(v, def, name, min, max));
const bool = (v, def, name) => {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') fail(`"${name}" must be true or false`);
  return v;
};

function points(v, dim, name, min) {
  if (!Array.isArray(v)) fail(`"${name}" must be an array of [${dim === 2 ? 'x, y' : 'x, y, z'}] points`);
  if (v.length < min) fail(`"${name}" needs at least ${min} points`);
  if (v.length > LIMITS.maxPoints) fail(`"${name}" has more than ${LIMITS.maxPoints} points`);
  return v.map((p, i) => {
    if (!Array.isArray(p) || p.length !== dim || !p.every((c) => typeof c === 'number' && Number.isFinite(c))) {
      fail(`"${name}[${i}]" must be [${dim === 2 ? 'x, y' : 'x, y, z'}] with finite numbers`);
    }
    return p;
  });
}

function vec3(v, def, name) {
  if (v === undefined || v === null) return def;
  return points([v], 3, name, 1)[0];
}

const SEG = LIMITS.maxSegments;

// ---- 2D shapes (cross sections) -------------------------------------------------------------
function shape2d(s, name = 'shape') {
  if (Array.isArray(s)) return points(s, 2, name, 3);
  if (!s || typeof s !== 'object') fail(`"${name}" must be an array of [x, y] points or an object with a "type"`);
  switch (s.type) {
    case 'circle': return G.shapes.circle(num(s.radius, 0.5, `${name}.radius`, 1e-4), int(s.points, 32, `${name}.points`, 3, SEG));
    case 'polygon': return G.shapes.circle(num(s.radius, 0.5, `${name}.radius`, 1e-4), int(s.sides, 6, `${name}.sides`, 3, SEG));
    case 'rect': return G.shapes.rect(num(s.width, 1, `${name}.width`, 1e-4), num(s.height, 1, `${name}.height`, 1e-4));
    case 'star': return G.shapes.star(int(s.points, 5, `${name}.points`, 2, SEG),
      num(s.outer, 1, `${name}.outer`, 1e-4), num(s.inner, 0.5, `${name}.inner`, 1e-4));
    default: return fail(`unknown 2D shape type "${s.type}" in "${name}" (use circle, polygon, rect, star or an array of [x, y] points)`);
  }
}

// ---- 3D paths -------------------------------------------------------------------------------
function path3d(p, name = 'path') {
  if (Array.isArray(p)) return { pts: points(p, 3, name, 2), closed: false };
  if (!p || typeof p !== 'object') fail(`"${name}" must be an array of [x, y, z] points or an object with a "type"`);
  switch (p.type) {
    case 'line': return { pts: G.paths.line(vec3(p.from, [0, 0, 0], `${name}.from`), vec3(p.to, [0, 1, 0], `${name}.to`),
      int(p.steps, 1, `${name}.steps`, 1, SEG * 4)), closed: false };
    case 'circle': return { pts: G.paths.circle(num(p.radius, 1, `${name}.radius`, 1e-4), int(p.steps, 64, `${name}.steps`, 3, SEG * 4)), closed: true };
    case 'helix': return { pts: G.paths.helix(num(p.radius, 0.5, `${name}.radius`, 1e-4), num(p.height, 2, `${name}.height`),
      num(p.turns, 3, `${name}.turns`, 0.01, 1000), int(p.steps, 200, `${name}.steps`, 2, SEG * 8)), closed: false };
    case 'torusKnot': return { pts: G.paths.torusKnot(int(p.p, 2, `${name}.p`, 1, 50), int(p.q, 3, `${name}.q`, 1, 50),
      int(p.steps, 256, `${name}.steps`, 8, SEG * 8), num(p.size, 1, `${name}.size`, 1e-4)), closed: true };
    default: return fail(`unknown path type "${p.type}" in "${name}" (use line, circle, helix, torusKnot or an array of [x, y, z] points)`);
  }
}

// ---- terrain noise --------------------------------------------------------------------------
function hash(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x, y, seed = 1, octaves = 5) {
  let s = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++) { s += amp * noise(x * f, y * f, seed); f *= 2.03; amp *= 0.5; }
  return s;
}

// ---- builder --------------------------------------------------------------------------------
export const SHAPE_TYPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'terrain',
  'lathe', 'extrude', 'sweep', 'tube', 'mesh'];

export function buildShape(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) fail('shape must be an object with a "type"');
  let g;
  switch (r.type) {
    case 'box':
      g = G.box(num(r.width, 1, 'width', 1e-4), num(r.height, 1, 'height', 1e-4), num(r.depth, 1, 'depth', 1e-4));
      break;
    case 'sphere':
      g = G.sphere(num(r.radius, 0.5, 'radius', 1e-4), int(r.segments, 32, 'segments', 3, SEG), int(r.rings, 16, 'rings', 2, SEG));
      break;
    case 'cylinder':
      g = G.cylinder(num(r.radiusTop, 0.5, 'radiusTop', 0), num(r.radiusBottom, 0.5, 'radiusBottom', 0),
        num(r.height, 1, 'height', 1e-4), int(r.segments, 32, 'segments', 3, SEG), bool(r.caps, true, 'caps'));
      break;
    case 'cone':
      g = G.cone(num(r.radius, 0.5, 'radius', 1e-4), num(r.height, 1, 'height', 1e-4), int(r.segments, 32, 'segments', 3, SEG));
      break;
    case 'torus':
      g = G.torus(num(r.radius, 0.5, 'radius', 1e-4), num(r.tube, 0.15, 'tube', 1e-4),
        int(r.segments, 48, 'segments', 3, SEG), int(r.sides, 16, 'sides', 3, SEG));
      break;
    case 'plane':
      g = G.plane(num(r.width, 1, 'width', 1e-4), num(r.depth, 1, 'depth', 1e-4));
      break;
    case 'terrain': {
      const w = num(r.width, 20, 'width', 1e-3), d = num(r.depth, w, 'depth', 1e-3);
      const res = int(r.resolution, 96, 'resolution', 2, 700), h = num(r.height, 4, 'height', 0);
      const sc = num(r.scale, 0.08, 'scale', 1e-5, 100), seed = int(r.seed, 1, 'seed', 0, 1e6);
      const water = num(r.waterLevel, 0.35, 'waterLevel', 0, 1);
      g = G.grid(w, d, res, res, (x, z) => Math.max(0, (fbm(x * sc + 10, z * sc + 3, seed) - water) / (1 - water)) * h);
      if (bool(r.colorize, true, 'colorize')) {
        g.setColors((x, y, z, nx, ny) => {
          const t = h > 0 ? y / h : 0;
          if (y < 1e-3) return [0.15, 0.33, 0.52];
          if (t < 0.06) return [0.74, 0.68, 0.48];
          if (t > 0.75 && ny > 0.6) return [0.94, 0.95, 0.97];
          if (ny < 0.72) return [0.45, 0.42, 0.4];
          return [0.28 + 0.15 * t, 0.48 - 0.1 * t, 0.2 + 0.05 * t];
        });
      }
      break;
    }
    case 'lathe':
      g = G.lathe(points(r.profile, 2, 'profile', 2), int(r.segments, 48, 'segments', 3, SEG));
      break;
    case 'extrude':
      g = G.extrude(shape2d(r.shape), num(r.depth, 0.2, 'depth', 1e-4));
      break;
    case 'sweep':
    case 'tube': {
      const { pts, closed: pathClosed } = path3d(r.path);
      const closed = bool(r.closed, pathClosed, 'closed');
      const section = r.type === 'tube'
        ? G.shapes.circle(num(r.radius, 0.1, 'radius', 1e-4), int(r.sides, 12, 'sides', 3, SEG))
        : shape2d(r.shape);
      const scaleEnd = num(r.scaleEnd, 1, 'scaleEnd', 0, 1000);
      g = G.sweep(section, pts, {
        closed,
        caps: bool(r.caps, !closed, 'caps'),
        twist: (num(r.twist, 0, 'twist', -36000, 36000) * Math.PI) / 180,
        scale: scaleEnd !== 1 ? (t) => 1 + (scaleEnd - 1) * t : null,
      });
      break;
    }
    case 'mesh': {
      const P = r.positions, I = r.indices;
      if (!Array.isArray(P) || P.length % 3 || !P.every(Number.isFinite)) fail('"positions" must be a flat array of numbers [x0, y0, z0, x1, ...]');
      const n = P.length / 3;
      if (!Array.isArray(I) || I.length % 3 || !I.every((i) => Number.isInteger(i) && i >= 0 && i < n)) {
        fail(`"indices" must be a flat array of vertex indices (0..${n - 1}), 3 per triangle, counter-clockwise from outside`);
      }
      g = new G.Geometry(P, I);
      break;
    }
    default:
      fail(`unknown shape type "${r.type}". Available: ${SHAPE_TYPES.join(', ')}`);
  }
  if (g.triangleCount > LIMITS.maxTrianglesPerObject) {
    fail(`shape has ${g.triangleCount} triangles, the limit is ${LIMITS.maxTrianglesPerObject}. Reduce segments/resolution.`);
  }
  return g;
}

// Human/agent readable reference. Served by the get_shape_reference tool.
export const SHAPE_REFERENCE = `# cpu3d shape recipes

World: right-handed, Y is up, the ground plane is y = 0, units are meters.
Every object = { name, shape, position [x,y,z], rotation [x,y,z] in DEGREES, scale (number or [x,y,z]), material }.
material = { color: "#rrggbb", specular 0..2, shininess 1..256, flat: bool (faceted look), doubleSided: bool (for open surfaces) }.
Shapes are built around their own origin (see "origin" below); use position to place them.

## Primitives
- box       { type: "box", width=1, height=1, depth=1 }                       origin: center
- sphere    { type: "sphere", radius=0.5, segments=32, rings=16 }             origin: center
- cylinder  { type: "cylinder", radiusTop=0.5, radiusBottom=0.5, height=1, segments=32, caps=true }   origin: center
- cone      { type: "cone", radius=0.5, height=1, segments=32 }              origin: center (tip at +height/2)
- torus     { type: "torus", radius=0.5, tube=0.15, segments=48, sides=16 }  origin: center, lies flat in XZ
- plane     { type: "plane", width=1, depth=1 }                               origin: center, faces +Y
- terrain   { type: "terrain", width=20, depth=width, resolution=96, height=4, scale=0.08, seed=1, waterLevel=0.35, colorize=true }
            noise heightfield in XZ, y from 0 (flat water) to height

## Generative (the interesting part)
- lathe     { type: "lathe", profile: [[r, y], ...], segments=48 }
            Revolves a 2D profile around the Y axis. List points from BOTTOM to TOP, r >= 0.
            Start/end with r = 0 to close the bottom/top. Open profiles (vases) need material.doubleSided.
            Example vase: [[0,0],[0.4,0],[0.5,0.3],[0.3,1.0],[0.35,1.4]]
- extrude   { type: "extrude", shape: Shape2D, depth=0.2 }
            Extrudes a 2D polygon (concave allowed) along Z, centered on z = 0. Rotate [-90,0,0] to lay it flat.
- sweep     { type: "sweep", shape: Shape2D, path: Path3D, closed?, caps?, twist=0 (degrees over the length), scaleEnd=1 }
            Moves a cross-section along a 3D path (columns, rails, frames, horns, twisted shapes).
- tube      { type: "tube", path: Path3D, radius=0.1, sides=12, closed?, caps? }
            Sweep of a circle: pipes, cables, springs, handles, knots.
- mesh      { type: "mesh", positions: [x0,y0,z0, ...], indices: [a,b,c, ...] }
            Raw triangles, counter-clockwise when seen from outside.

## Shape2D (cross sections, in the XY plane)
- [[x, y], ...]                              any simple polygon, at least 3 points
- { type: "circle", radius=0.5, points=32 }
- { type: "polygon", radius=0.5, sides=6 }
- { type: "rect", width=1, height=1 }
- { type: "star", points=5, outer=1, inner=0.5 }

## Path3D
- [[x, y, z], ...]                           polyline, at least 2 points (use many points for smooth curves)
- { type: "line", from=[0,0,0], to=[0,1,0], steps=1 }       (more steps = more twist resolution)
- { type: "circle", radius=1, steps=64 }                    closed, in the XZ plane
- { type: "helix", radius=0.5, height=2, turns=3, steps=200 } from y=0 upwards
- { type: "torusKnot", p=2, q=3, steps=256, size=1 }        closed

## Tips
- Build complex objects from several simple objects (a table = top box + 4 cylinder legs).
- Things standing on the ground: position.y = half their height for center-origin shapes.
- After changes call render_view to look at the result, then fix what looks wrong.
- Keep triangle counts sensible (a few thousand per object is plenty).
`;
