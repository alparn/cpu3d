// Geometry builder. Everything is assembled on the CPU from rims (rings of points),
// paths and 2D shapes into flat typed arrays that the software renderer consumes directly.
//
// Core idea (same as the old Babylon GeometryBuilder): a surface is a list of rims;
// consecutive rims are stitched into quads. Sphere, lathe, sweep, torus, tube, parametric
// surfaces are all just different ways of producing rims.
//
// Winding: counter-clockwise = front face (right-handed, like OpenGL).

import { mat4, vec3 } from './math.js';

export class Geometry {
  constructor(positions, indices, { normals = null, colors = null } = {}) {
    this.positions = positions instanceof Float32Array ? positions : new Float32Array(positions);
    this.indices = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
    this.colors = colors ? (colors instanceof Float32Array ? colors : new Float32Array(colors)) : null;
    if (normals) this.normals = normals instanceof Float32Array ? normals : new Float32Array(normals);
    else this.computeNormals();
    this.computeBounds();
  }

  get vertexCount() { return this.positions.length / 3; }
  get triangleCount() { return this.indices.length / 3; }

  // Smooth, area-weighted vertex normals.
  computeNormals() {
    const p = this.positions, ix = this.indices, n = new Float32Array(p.length);
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
      n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
      n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
    for (let k = 0; k < n.length; k += 3) {
      const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      n[k] /= l; n[k + 1] /= l; n[k + 2] /= l;
    }
    this.normals = n;
    return this;
  }

  // Bounding sphere (AABB center + max distance), used for frustum culling.
  computeBounds() {
    const p = this.positions;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < p.length; k += 3) {
      for (let a = 0; a < 3; a++) {
        if (p[k + a] < min[a]) min[a] = p[k + a];
        if (p[k + a] > max[a]) max[a] = p[k + a];
      }
    }
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    let r2 = 0;
    for (let k = 0; k < p.length; k += 3) {
      const dx = p[k] - c[0], dy = p[k + 1] - c[1], dz = p[k + 2] - c[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) r2 = d;
    }
    Object.assign(this, { min, max, center: c, radius: Math.sqrt(r2) });
    return this;
  }

  signedVolume() {
    const p = this.positions, ix = this.indices;
    let v = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
      v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
        - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
        + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return v / 6;
  }

  flip() {
    const ix = this.indices, n = this.normals;
    for (let t = 0; t < ix.length; t += 3) { const s = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = s; }
    for (let k = 0; k < n.length; k++) n[k] = -n[k];
    return this;
  }

  // For closed meshes: make sure triangles face outwards.
  orientOutward() {
    if (this.signedVolume() < 0) this.flip();
    return this;
  }

  applyMatrix(m) {
    const p = this.positions;
    for (let k = 0; k < p.length; k += 3) {
      const x = p[k], y = p[k + 1], z = p[k + 2];
      p[k] = m[0] * x + m[4] * y + m[8] * z + m[12];
      p[k + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      p[k + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    if (mat4.determinant3(m) < 0) {
      const ix = this.indices;
      for (let t = 0; t < ix.length; t += 3) { const s = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = s; }
    }
    return this.computeNormals().computeBounds();
  }

  translate(x = 0, y = 0, z = 0) { return this.applyMatrix(mat4.compose(mat4.create(), [x, y, z], [0, 0, 0], [1, 1, 1])); }
  rotate(x = 0, y = 0, z = 0) { return this.applyMatrix(mat4.compose(mat4.create(), [0, 0, 0], [x, y, z], [1, 1, 1])); }
  scale(x = 1, y = x, z = x) { return this.applyMatrix(mat4.compose(mat4.create(), [0, 0, 0], [0, 0, 0], [x, y, z])); }

  // Center at the origin and scale to fit a sphere of the given radius.
  fit(radius = 1) {
    const [cx, cy, cz] = this.center;
    this.translate(-cx, -cy, -cz);
    return this.scale(radius / (this.radius || 1));
  }

  // Give every triangle its own vertices -> hard edges, faceted look.
  unweld() {
    const ix = this.indices, p = this.positions, c = this.colors;
    const P = new Float32Array(ix.length * 3), C = c ? new Float32Array(ix.length * 3) : null;
    const I = new Uint32Array(ix.length);
    for (let i = 0; i < ix.length; i++) {
      const s = ix[i] * 3, d = i * 3;
      P[d] = p[s]; P[d + 1] = p[s + 1]; P[d + 2] = p[s + 2];
      if (C) { C[d] = c[s]; C[d + 1] = c[s + 1]; C[d + 2] = c[s + 2]; }
      I[i] = i;
    }
    this.positions = P; this.colors = C; this.indices = I;
    return this.computeNormals();
  }

  // fn(x, y, z, nx, ny, nz) -> [r, g, b] in 0..1, per vertex
  setColors(fn) {
    const p = this.positions, n = this.normals, c = new Float32Array(p.length);
    for (let k = 0; k < p.length; k += 3) {
      const rgb = fn(p[k], p[k + 1], p[k + 2], n[k], n[k + 1], n[k + 2]);
      c[k] = rgb[0]; c[k + 1] = rgb[1]; c[k + 2] = rgb[2];
    }
    this.colors = c;
    return this;
  }

  // fn(cx, cy, cz, nx, ny, nz) -> [r, g, b], evaluated per triangle at its centroid
  setFaceColors(fn) {
    this.unweld();
    const p = this.positions, n = this.normals, c = new Float32Array(p.length);
    for (let k = 0; k < p.length; k += 9) {
      const rgb = fn((p[k] + p[k + 3] + p[k + 6]) / 3, (p[k + 1] + p[k + 4] + p[k + 7]) / 3,
        (p[k + 2] + p[k + 5] + p[k + 8]) / 3, n[k], n[k + 1], n[k + 2]);
      for (let j = 0; j < 9; j += 3) { c[k + j] = rgb[0]; c[k + j + 1] = rgb[1]; c[k + j + 2] = rgb[2]; }
    }
    this.colors = c;
    return this;
  }

  clone() {
    return new Geometry(this.positions.slice(), this.indices.slice(),
      { normals: this.normals.slice(), colors: this.colors && this.colors.slice() });
  }

  toOBJ() {
    const p = this.positions, ix = this.indices, out = [];
    for (let k = 0; k < p.length; k += 3) out.push(`v ${p[k]} ${p[k + 1]} ${p[k + 2]}`);
    for (let t = 0; t < ix.length; t += 3) out.push(`f ${ix[t] + 1} ${ix[t + 1] + 1} ${ix[t + 2] + 1}`);
    return out.join('\n') + '\n';
  }

  static merge(...list) {
    let nv = 0, ni = 0, anyColor = false;
    for (const g of list) { nv += g.positions.length; ni += g.indices.length; anyColor ||= !!g.colors; }
    const P = new Float32Array(nv), N = new Float32Array(nv), I = new Uint32Array(ni);
    const C = anyColor ? new Float32Array(nv).fill(0.8) : null;
    let po = 0, io = 0;
    for (const g of list) {
      P.set(g.positions, po); N.set(g.normals, po);
      if (C && g.colors) C.set(g.colors, po);
      const off = po / 3, gi = g.indices;
      for (let i = 0; i < gi.length; i++) I[io + i] = gi[i] + off;
      po += g.positions.length; io += gi.length;
    }
    return new Geometry(P, I, { normals: N, colors: C });
  }
}

// ---------------------------------------------------------------------------------------------
// Core builder: stitch rims into a surface.
//   rims      : [[ [x,y,z], ... ], ...]  all rims must have the same number of points
//   closeRims : connect last point of each rim back to its first (tubes, rings)
//   closePath : connect last rim back to the first (torus, closed sweeps)
//   capStart / capEnd : close the open ends with a fan (needs a star-shaped rim)
// With rims ordered like ring() below and stacked bottom to top, the result faces outwards;
// otherwise call .flip() or, for closed meshes, .orientOutward().
export function fromRims(rims, { closeRims = true, closePath = false, capStart = false, capEnd = false } = {}) {
  const R = rims.length, n = rims[0].length, pos = [], idx = [];
  for (const rim of rims) for (const p of rim) pos.push(p[0], p[1], p[2]);
  const iMax = closePath ? R : R - 1, jMax = closeRims ? n : n - 1;
  for (let i = 0; i < iMax; i++) {
    const i1 = (i + 1) % R;
    for (let j = 0; j < jMax; j++) {
      const j1 = (j + 1) % n;
      const a = i * n + j, b = i * n + j1, c = i1 * n + j, d = i1 * n + j1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // caps get their own vertices so the rim edge stays sharp
  const cap = (rim, end) => {
    const base = pos.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (const p of rim) { pos.push(p[0], p[1], p[2]); cx += p[0]; cy += p[1]; cz += p[2]; }
    pos.push(cx / n, cy / n, cz / n);
    const mid = base + n;
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      if (end) idx.push(mid, base + j1, base + j);
      else idx.push(mid, base + j, base + j1);
    }
  };
  if (capStart) cap(rims[0], false);
  if (capEnd) cap(rims[R - 1], true);
  return new Geometry(pos, idx);
}

const ring = (r, y, seg) => {
  const pts = [];
  for (let j = 0; j < seg; j++) {
    const a = (2 * Math.PI * j) / seg;
    pts.push([r * Math.cos(a), y, r * Math.sin(a)]);
  }
  return pts;
};

// ---------------------------------------------------------------------------------------------
// 2D shapes ([x, y] counter-clockwise) and 3D paths

export const shapes = {
  circle: (r = 1, n = 32) => Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [r * Math.cos(a), r * Math.sin(a)];
  }),
  rect: (w = 1, h = 1) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]],
  star: (points = 5, outer = 1, inner = 0.5) => Array.from({ length: points * 2 }, (_, i) => {
    const a = (Math.PI * i) / points + Math.PI / 2, r = i % 2 ? inner : outer;
    return [r * Math.cos(a), r * Math.sin(a)];
  }),
  // rectangle with rounded corners, counter-clockwise, 4 * (segments + 1) points.
  // smooth = true uses superellipse ("squircle") corners: curvature ramps up instead of jumping,
  // the continuous-curvature look of modern devices. They need a larger radius for the same look.
  roundedRect: (w = 1, h = 1, r = 0.1, segments = 6, smooth = false) => {
    r = Math.max(1e-5, Math.min(r, w / 2, h / 2));
    const cx = w / 2 - r, cy = h / 2 - r, pts = [], e = smooth ? 0.5 : 1; // |cos|^e, |sin|^e
    for (const [ox, oy, a0] of [[cx, -cy, -90], [cx, cy, 0], [-cx, cy, 90], [-cx, -cy, 180]]) {
      for (let i = 0; i <= segments; i++) {
        const a = ((a0 + (90 * i) / segments) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        pts.push([ox + r * Math.sign(c) * Math.abs(c) ** e, oy + r * Math.sign(s) * Math.abs(s) ** e]);
      }
    }
    return pts;
  },
};

export const paths = {
  line: (from, to, n = 1) => Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
  }),
  // closed, in the XZ plane
  circle: (r = 1, n = 64) => Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [r * Math.cos(a), 0, r * Math.sin(a)];
  }),
  helix: (r = 1, h = 2, turns = 3, n = 200) => Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, a = t * turns * 2 * Math.PI;
    return [r * Math.cos(a), t * h, r * Math.sin(a)];
  }),
  // closed (p, q) torus knot lying in the XZ plane, roughly `size` in radius
  torusKnot: (p = 2, q = 3, n = 256, size = 1) => Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n, r = (Math.cos(q * t) + 2) * size / 3;
    return [r * Math.cos(p * t), -Math.sin(q * t) * size / 3, r * Math.sin(p * t)];
  }),
};

// ---------------------------------------------------------------------------------------------
// Builders

export function box(w = 1, h = 1, d = 1) {
  const s = [w / 2, h / 2, d / 2], pos = [], idx = [];
  // [normal, u, v] with u x v = normal -> counter-clockwise from outside
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = pos.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let a = 0; a < 3; a++) pos.push((n[a] + u[a] * su + v[a] * sv) * s[a]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return new Geometry(pos, idx);
}

// Surface of revolution around Y. profile: [[r, y], ...] from bottom to top, outside at +r.
// phiStart / phiLength (degrees) revolve only part of the way (cutaway models, half pipes).
// A partial lathe of a closed profile (first point = last point, or both ends on the axis)
// gets flat caps on its two cut faces, so it stays a closed solid.
export function lathe(profile, segments = 32, { phiStart = 0, phiLength = 360 } = {}) {
  if (phiLength >= 360 && phiStart === 0) return fromRims(profile.map(([r, y]) => ring(r, y, segments)));
  const full = phiLength >= 360, a0 = (phiStart * Math.PI) / 180, len = (Math.min(360, phiLength) * Math.PI) / 180;
  const first = profile[0], last = profile[profile.length - 1];
  const loop = first[0] === last[0] && first[1] === last[1];
  const closed = loop || (first[0] === 0 && last[0] === 0);
  let prof = profile;
  if (closed) {
    const poly = loop ? profile.slice(0, -1) : profile;
    if (polygonArea(poly) < 0) prof = loop ? [...poly].reverse().concat([poly[poly.length - 1]]) : [...profile].reverse(); // sides face out when the loop runs counter-clockwise in (r, y)
  }
  const n = full ? segments : segments + 1;
  const rims = prof.map(([r, y]) => Array.from({ length: n }, (_, j) => {
    const a = a0 + (len * j) / segments;
    return [r * Math.cos(a), y, r * Math.sin(a)];
  }));
  const sides = fromRims(rims, { closeRims: full });
  if (full || !closed) return sides;
  const poly = loop ? prof.slice(0, -1) : prof, tri = triangulate(poly), pos = [], idx = [];
  for (const [a, flip] of [[a0, true], [a0 + len, false]]) {
    const base = pos.length / 3;
    for (const [r, y] of poly) pos.push(r * Math.cos(a), y, r * Math.sin(a));
    for (let t = 0; t < tri.length; t += 3) {
      if (flip) idx.push(base + tri[t], base + tri[t + 2], base + tri[t + 1]);
      else idx.push(base + tri[t], base + tri[t + 1], base + tri[t + 2]);
    }
  }
  return Geometry.merge(sides, new Geometry(pos, idx));
}

export function sphere(r = 1, segments = 32, rings = 16) {
  const profile = [];
  for (let i = 0; i <= rings; i++) {
    const a = Math.PI * (i / rings - 0.5);
    profile.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return lathe(profile, segments);
}

export function cylinder(rTop = 0.5, rBottom = 0.5, h = 1, segments = 32, caps = true) {
  return fromRims([ring(rBottom, -h / 2, segments), ring(rTop, h / 2, segments)],
    { capStart: caps && rBottom > 0, capEnd: caps && rTop > 0 });
}

export const cone = (r = 0.5, h = 1, segments = 32) => cylinder(0, r, h, segments);

// Rotation-minimizing frames along a path (parallel transport), twist-corrected for closed paths.
function transportFrames(path, closed) {
  const n = path.length, T = [];
  for (let i = 0; i < n; i++) {
    const prev = path[closed ? (i - 1 + n) % n : Math.max(i - 1, 0)];
    const next = path[closed ? (i + 1) % n : Math.min(i + 1, n - 1)];
    T.push(vec3.normalize(vec3.sub(next, prev)));
  }
  const ref = Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let N = vec3.normalize(vec3.sub(ref, vec3.scale(T[0], vec3.dot(ref, T[0]))));
  const frames = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) N = vec3.normalize(vec3.sub(N, vec3.scale(T[i], vec3.dot(N, T[i]))));
    frames.push({ T: T[i], N, B: vec3.cross(T[i], N) });
  }
  if (closed) {
    const t0 = T[0], N0 = frames[0].N;
    const Ne = vec3.normalize(vec3.sub(N, vec3.scale(t0, vec3.dot(N, t0))));
    const ang = Math.atan2(vec3.dot(vec3.cross(Ne, N0), t0), vec3.dot(Ne, N0));
    for (let i = 1; i < n; i++) {
      const f = frames[i], a = (ang * i) / n, c = Math.cos(a), s = Math.sin(a);
      const Nr = vec3.add(vec3.scale(f.N, c), vec3.scale(f.B, s));
      frames[i] = { T: f.T, N: Nr, B: vec3.cross(f.T, Nr) };
    }
  }
  return frames;
}

// Sweep a 2D shape along a 3D path (tubes, knots, springs, twisted columns ...).
export function sweep(shape, path, { closed = false, closeShape = true, caps = !closed, twist = 0, scale = null } = {}) {
  const frames = transportFrames(path, closed);
  const steps = closed ? path.length : path.length - 1;
  const rims = path.map((p, i) => {
    const { N, B } = frames[i], t = i / steps;
    const s = scale ? scale(t) : 1, a = twist * t, ca = Math.cos(a), sa = Math.sin(a);
    return shape.map(([x, y]) => {
      const u = (x * ca - y * sa) * s, v = (x * sa + y * ca) * s;
      return [p[0] + N[0] * u + B[0] * v, p[1] + N[1] * u + B[1] * v, p[2] + N[2] * u + B[2] * v];
    });
  });
  const g = fromRims(rims, { closeRims: closeShape, closePath: closed, capStart: caps, capEnd: caps });
  return closeShape && (closed || caps) ? g.orientOutward() : g;
}

export function torus(R = 1, r = 0.3, segments = 48, sides = 16) {
  return sweep(shapes.circle(r, sides), paths.circle(R, segments), { closed: true });
}

export const tube = (path, r = 0.1, sides = 12, opts = {}) => sweep(shapes.circle(r, sides), path, opts);

// Extrude any simple 2D polygon (concave allowed) along Z, centered on z = 0.
// holes: simple polygons inside the shape (gears with spokes, rings, frames, letters like "O").
export function extrude(shape, depth = 0.2, holes = []) {
  const pts = polygonArea(shape) < 0 ? shape.slice().reverse() : shape; // outline counter-clockwise
  const hs = holes.map((h) => (polygonArea(h) > 0 ? h.slice().reverse() : h)); // holes clockwise
  const z0 = -depth / 2, z1 = depth / 2, pos = [], idx = [];
  // side walls: the same quad winding faces outwards on the outline and into the holes
  for (const loop of [pts, ...hs]) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = loop[i], [bx, by] = loop[(i + 1) % n], base = pos.length / 3;
      pos.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z1);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const cap = hs.length ? bridgeHoles(pts, hs) : pts;
  const tri = triangulate(cap);
  let base = pos.length / 3;
  for (const [x, y] of cap) pos.push(x, y, z1);
  for (let t = 0; t < tri.length; t += 3) idx.push(base + tri[t], base + tri[t + 1], base + tri[t + 2]);
  base = pos.length / 3;
  for (const [x, y] of cap) pos.push(x, y, z0);
  for (let t = 0; t < tri.length; t += 3) idx.push(base + tri[t], base + tri[t + 2], base + tri[t + 1]);
  return new Geometry(pos, idx);
}

// Merge holes into the outline with zero-width bridges so ear clipping can triangulate the cap
// (the approach of earcut: connect each hole's rightmost vertex to a visible outline vertex).
function bridgeHoles(outer, holes) {
  let poly = outer.map((p) => [p[0], p[1]]);
  const order = holes.map((h) => ({ h, mx: Math.max(...h.map((p) => p[0])) })).sort((a, b) => b.mx - a.mx);
  for (const { h } of order) {
    let mi = 0;
    for (let i = 1; i < h.length; i++) if (h[i][0] > h[mi][0]) mi = i;
    const [mx, my] = h[mi];
    // closest edge hit by a ray from M towards +x; take its endpoint with the larger x
    let best = Infinity, P = -1;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[1] > my) === (b[1] > my)) continue;
      const x = a[0] + ((my - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (x >= mx && x - mx < best) { best = x - mx; P = a[0] > b[0] ? i : (i + 1) % poly.length; }
    }
    if (P < 0) continue; // hole outside the outline: ignore
    // if other outline vertices lie inside the triangle (M, hit, P), connect to the one closest to the ray
    const ix = mx + best, [px, py] = poly[P];
    let bestTan = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [qx, qy] = poly[i];
      if (i === P || qx < mx) continue;
      const s1 = (ix - mx) * (qy - my), s2 = (px - ix) * (qy - my) - (py - my) * (qx - ix), s3 = (mx - px) * (qy - py) - (my - py) * (qx - px);
      const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
      if (!inside) continue;
      const tan = Math.abs(qy - my) / (qx - mx || 1e-12);
      if (tan < bestTan) { bestTan = tan; P = i; }
    }
    const loop = [...h.slice(mi), ...h.slice(0, mi + 1)].map((p) => [p[0], p[1]]); // M ... M
    poly = [...poly.slice(0, P + 1), ...loop, [poly[P][0], poly[P][1]], ...poly.slice(P + 1)];
  }
  return poly;
}

// Heightfield in the XZ plane. height(x, z) -> y
export function grid(w = 10, d = 10, nx = 10, nz = 10, height = null) {
  const pos = [], idx = [];
  for (let iz = 0; iz <= nz; iz++) {
    for (let ix = 0; ix <= nx; ix++) {
      const x = (ix / nx - 0.5) * w, z = (iz / nz - 0.5) * d;
      pos.push(x, height ? height(x, z) : 0, z);
    }
  }
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = iz * (nx + 1) + ix, b = a + 1, c = a + nx + 1, d2 = c + 1;
      idx.push(a, c, b, b, c, d2);
    }
  }
  return new Geometry(pos, idx);
}

export const plane = (w = 1, d = 1) => grid(w, d, 1, 1);

// Box with rounded edges (edge radius) and rounded corners in the XY plane (corner radius),
// centered on the origin, depth along Z. Built from rims: rounded rectangles that shrink
// along a quarter circle towards the front and back faces, so all edges are smooth.
export function roundedBox(w = 1, h = 1, d = 1, edge = 0.05, corner = edge, segments = 6, smooth = false) {
  const e = Math.max(1e-5, Math.min(edge, w / 2, h / 2, d / 2));
  const c = Math.max(e, Math.min(corner, w / 2, h / 2));
  const rims = [];
  const rim = (z, inset) => shapes.roundedRect(w - 2 * inset, h - 2 * inset, Math.max(1e-5, c - inset), segments, smooth)
    .map(([x, y]) => [x, y, z]);
  for (let k = 0; k <= segments; k++) { // back edge: from the back face out to the side
    const phi = -Math.PI / 2 + (k / segments) * (Math.PI / 2);
    rims.push(rim(-(d / 2 - e) + e * Math.sin(phi), e * (1 - Math.cos(phi))));
  }
  for (let k = 0; k <= segments; k++) { // front edge: from the side in to the front face
    const phi = (k / segments) * (Math.PI / 2);
    rims.push(rim(d / 2 - e + e * Math.sin(phi), e * (1 - Math.cos(phi))));
  }
  return fromRims(rims, { capStart: true, capEnd: true }).orientOutward();
}

// fn(u, v) -> [x, y, z] with u, v in [0, 1]
export function parametric(fn, nu = 32, nv = 32, { closeU = false, closeV = false } = {}) {
  const rims = [];
  for (let i = 0; i < (closeU ? nu : nu + 1); i++) {
    const rim = [];
    for (let j = 0; j < (closeV ? nv : nv + 1); j++) rim.push(fn(i / nu, j / nv));
    rims.push(rim);
  }
  return fromRims(rims, { closeRims: closeV, closePath: closeU });
}

// ---------------------------------------------------------------------------------------------
// Polygon triangulation (ear clipping, O(n^2), fine for hand-made shapes)

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

export function triangulate(pts) {
  const n = pts.length, out = [];
  if (n < 3) return out;
  const V = polygonArea(pts) > 0 ? pts.map((_, i) => i) : pts.map((_, i) => n - 1 - i);
  let nv = n, guard = 2 * nv;
  for (let v = nv - 1; nv > 2;) {
    if (guard-- <= 0) break; // not a simple polygon
    let u = v; if (u >= nv) u = 0;
    v = u + 1; if (v >= nv) v = 0;
    let w = v + 1; if (w >= nv) w = 0;
    if (isEar(pts, V, u, v, w, nv)) {
      out.push(V[u], V[v], V[w]);
      V.splice(v, 1);
      nv--;
      guard = 2 * nv;
    }
  }
  return out;
}

function isEar(pts, V, u, v, w, n) {
  const [ax, ay] = pts[V[u]], [bx, by] = pts[V[v]], [cx, cy] = pts[V[w]];
  if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) <= 1e-12) return false;
  for (let p = 0; p < n; p++) {
    if (p === u || p === v || p === w) continue;
    const [px, py] = pts[V[p]];
    // bridged holes duplicate vertices: a copy of a corner does not block the ear
    if ((px === ax && py === ay) || (px === bx && py === by) || (px === cx && py === cy)) continue;
    if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) >= 0 &&
        (cx - bx) * (py - by) - (cy - by) * (px - bx) >= 0 &&
        (ax - cx) * (py - cy) - (ay - cy) * (px - cx) >= 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Wavefront OBJ (positions + faces; polygons are fan-triangulated, normals recomputed)

export function parseOBJ(text) {
  const pos = [], idx = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const s = line.split(/\s+/);
      pos.push(+s[1], +s[2], +s[3]);
    } else if (line.startsWith('f ')) {
      const s = line.split(/\s+/), f = [];
      for (let i = 1; i < s.length; i++) {
        if (!s[i]) continue;
        const k = parseInt(s[i], 10);
        f.push(k < 0 ? pos.length / 3 + k : k - 1);
      }
      for (let i = 1; i + 1 < f.length; i++) idx.push(f[0], f[i], f[i + 1]);
    }
  }
  return new Geometry(pos, idx);
}
