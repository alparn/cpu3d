// Software rasterizer: the whole pipeline runs on the CPU and writes into a Uint32Array.
//
//   vertex stage  : model/view/projection, per-vertex lighting (Gouraud), outcodes
//   primitive     : trivial reject, homogeneous clipping (near/far + guard band), back-face cull
//   raster        : half-space edge functions on a 1/16 sub-pixel grid with top-left fill rule,
//                   exact per-row span solving (no wasted pixel tests), 1/w depth buffer
//
// The canvas is only used at the very end to blit the finished frame (putImageData).

import { mat4 } from './math.js';

const GUARD = 8; // guard band (in NDC units): only triangles crossing it are clipped in x/y
const NEAR = 1, FAR = 2, LEFT = 4, RIGHT = 8, BOTTOM = 16, TOP = 32;
const PLANES = [NEAR, FAR, LEFT, RIGHT, BOTTOM, TOP];
const STRIDE = 7; // clip vertex: x y z w r g b

export class Mesh {
  constructor(geometry, { color = [0.8, 0.8, 0.8], specular = 0.25, shininess = 24, doubleSided = false,
    position = [0, 0, 0], rotation = [0, 0, 0], scale = 1 } = {}) {
    this.geometry = geometry;
    this.color = color;
    this.specular = specular;
    this.shininess = shininess;
    this.doubleSided = doubleSided;
    this.position = position;
    this.rotation = rotation;
    this.scale = typeof scale === 'number' ? [scale, scale, scale] : scale;
    this.matrix = mat4.create();
    this.matrixAutoUpdate = true;
    this.visible = true;
    this.flat = false;       // flat shading for this mesh only
    this.wireframe = false;  // true = dark edges, [r, g, b] (0..1) = colored edges (e.g. selection)
  }

  updateMatrix() {
    mat4.compose(this.matrix, this.position, this.rotation, this.scale);
    return this;
  }
}

export class Camera {
  constructor({ fov = 55, near = 0.1, far = 200, position = [0, 2, 6], target = [0, 0, 0], up = [0, 1, 0] } = {}) {
    Object.assign(this, { fov, near, far, position, target, up });
  }
}

// Lighting state shared by the vertex stage (module level = no allocations per vertex).
const L = {
  lx: 0, ly: 1, lz: 0, lr: 1, lg: 1, lb: 1,
  sr: 0.3, sg: 0.3, sb: 0.35, gr: 0.1, gg: 0.1, gb: 0.1,
  ex: 0, ey: 0, ez: 0,
  fog: false, fn: 0, ff: 1, fr: 0, fg: 0, fb: 0,
  r: 0, g: 0, b: 0,
};

// Hemisphere ambient + Lambert + Blinn-Phong + linear fog. Result in L.r/g/b (0..255).
function shade(nx, ny, nz, px, py, pz, mr, mg, mb, spec, shin, twoSided) {
  let vx = L.ex - px, vy = L.ey - py, vz = L.ez - pz;
  const dist = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
  vx /= dist; vy /= dist; vz /= dist;
  if (twoSided && nx * vx + ny * vy + nz * vz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const hemi = ny * 0.5 + 0.5;
  let r = mr * (L.gr + (L.sr - L.gr) * hemi);
  let g = mg * (L.gg + (L.sg - L.gg) * hemi);
  let b = mb * (L.gb + (L.sb - L.gb) * hemi);
  const ndl = nx * L.lx + ny * L.ly + nz * L.lz;
  if (ndl > 0) {
    r += mr * L.lr * ndl; g += mg * L.lg * ndl; b += mb * L.lb * ndl;
    if (spec > 0) {
      const hx = L.lx + vx, hy = L.ly + vy, hz = L.lz + vz;
      const ndh = (nx * hx + ny * hy + nz * hz) / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
      if (ndh > 0) {
        const s = spec * Math.pow(ndh, shin);
        r += L.lr * s; g += L.lg * s; b += L.lb * s;
      }
    }
  }
  if (L.fog) {
    let f = (dist - L.fn) / (L.ff - L.fn);
    if (f > 0) {
      if (f > 1) f = 1;
      r += (L.fr - r) * f; g += (L.fg - g) * f; b += (L.fb - b) * f;
    }
  }
  L.r = r >= 1 ? 255 : r * 255;
  L.g = g >= 1 ? 255 : g * 255;
  L.b = b >= 1 ? 255 : b * 255;
}

export class Renderer {
  constructor({ width = 640, height = 480, canvas = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.shading = 'gouraud'; // 'flat' | 'gouraud' | 'normals'
    this.wireframe = false;
    this.wireWidth = 0.75; // pixels
    this.cullBack = true;
    this.fog = true;
    this.stats = { meshes: 0, triangles: 0, drawn: 0, clipped: 0, pixels: 0, ms: 0 };
    this._proj = mat4.create();
    this._view = mat4.create();
    this._vp = mat4.create();
    this._mvp = mat4.create();
    this._nm = new Float64Array(9);
    this._planes = new Float64Array(24);
    this._clipA = new Float64Array(16 * STRIDE);
    this._clipB = new Float64Array(16 * STRIDE);
    this._cap = 0;
    this._reserve(4096);
    this.setSize(width, height);
  }

  setSize(width, height) {
    const w = Math.max(1, width | 0), h = Math.max(1, height | 0);
    if (this.canvas) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.image = this.ctx.createImageData(w, h);
      this.pixels = this.image.data;
    } else {
      this.pixels = new Uint8ClampedArray(w * h * 4);
    }
    this.color = new Uint32Array(this.pixels.buffer); // little-endian ABGR
    this.depth = new Float32Array(w * h); // stores 1/w, 0 = infinitely far
    this.width = w;
    this.height = h;
    this._bgKey = '';
  }

  _reserve(n) {
    if (n <= this._cap) return;
    const c = Math.max(n, this._cap * 2);
    this._x = new Int32Array(c); this._y = new Int32Array(c); this._z = new Float64Array(c);
    this._cx = new Float64Array(c); this._cy = new Float64Array(c); this._cz = new Float64Array(c); this._cw = new Float64Array(c);
    this._wx = new Float32Array(c); this._wy = new Float32Array(c); this._wz = new Float32Array(c);
    this._r = new Float32Array(c); this._g = new Float32Array(c); this._b = new Float32Array(c);
    this._oc = new Uint8Array(c);
    this._cap = c;
  }

  _clear(bg) {
    const top = bg?.top ?? [0.1, 0.11, 0.14], bottom = bg?.bottom ?? [0.25, 0.27, 0.3];
    const key = `${top}|${bottom}|${this.width}x${this.height}`;
    if (key !== this._bgKey) {
      const W = this.width, H = this.height, buf = new Uint32Array(W * H);
      for (let y = 0; y < H; y++) {
        const t = y / Math.max(1, H - 1);
        const r = (top[0] + (bottom[0] - top[0]) * t) * 255, g = (top[1] + (bottom[1] - top[1]) * t) * 255;
        const b = (top[2] + (bottom[2] - top[2]) * t) * 255;
        buf.fill(0xff000000 | (b << 16) | (g << 8) | r, y * W, y * W + W);
      }
      this._bg = buf;
      this._bgKey = key;
    }
    this.color.set(this._bg);
    this.depth.fill(0);
  }

  render(scene, camera) {
    const t0 = performance.now();
    const st = this.stats;
    st.meshes = st.triangles = st.drawn = st.clipped = st.pixels = 0;
    this._clear(scene.background);

    mat4.perspective(this._proj, (camera.fov * Math.PI) / 180, this.width / this.height, camera.near, camera.far);
    mat4.lookAt(this._view, camera.position, camera.target, camera.up);
    mat4.multiply(this._vp, this._proj, this._view);
    this._extractPlanes();

    const light = scene.light ?? {};
    const d = light.direction ?? [0.5, 0.9, 0.35], dl = Math.hypot(d[0], d[1], d[2]) || 1;
    const lc = light.color ?? [1, 1, 1], sky = light.sky ?? [0.3, 0.32, 0.38], gnd = light.ground ?? [0.1, 0.09, 0.08];
    L.lx = d[0] / dl; L.ly = d[1] / dl; L.lz = d[2] / dl;
    [L.lr, L.lg, L.lb] = lc; [L.sr, L.sg, L.sb] = sky; [L.gr, L.gg, L.gb] = gnd;
    [L.ex, L.ey, L.ez] = camera.position;
    const fog = scene.fog;
    L.fog = !!(fog && this.fog);
    if (L.fog) {
      L.fn = fog.near; L.ff = fog.far;
      [L.fr, L.fg, L.fb] = fog.color ?? scene.background?.bottom ?? [0.25, 0.27, 0.3];
    }

    for (const mesh of scene.meshes) if (mesh.visible) this._drawMesh(mesh);

    st.ms = performance.now() - t0;
    if (this.ctx) this.ctx.putImageData(this.image, 0, 0);
    return this;
  }

  // Frustum planes (Gribb/Hartmann) for bounding-sphere culling of whole meshes.
  _extractPlanes() {
    const m = this._vp, P = this._planes;
    const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    const list = [[r3, r0, 1], [r3, r0, -1], [r3, r1, 1], [r3, r1, -1], [r3, r2, 1], [r3, r2, -1]];
    list.forEach(([a, b, s], i) => {
      const x = a[0] + s * b[0], y = a[1] + s * b[1], z = a[2] + s * b[2], w = a[3] + s * b[3];
      const l = Math.hypot(x, y, z) || 1;
      P[i * 4] = x / l; P[i * 4 + 1] = y / l; P[i * 4 + 2] = z / l; P[i * 4 + 3] = w / l;
    });
  }

  _drawMesh(mesh) {
    const geo = mesh.geometry;
    if (mesh.matrixAutoUpdate) mesh.updateMatrix();
    const m = mesh.matrix;

    // whole-mesh frustum culling
    const c = geo.center;
    const bx = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12];
    const by = m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13];
    const bz = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14];
    const sc = Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2],
      m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));
    const rad = geo.radius * sc, pl = this._planes;
    for (let i = 0; i < 24; i += 4) if (pl[i] * bx + pl[i + 1] * by + pl[i + 2] * bz + pl[i + 3] < -rad) return;
    this.stats.meshes++;

    const mvp = mat4.multiply(this._mvp, this._vp, m);
    const nm = mat4.normalMatrix(this._nm, m);
    const n = geo.vertexCount;
    this._reserve(n);
    const P = geo.positions, NRM = geo.normals, VC = geo.colors;
    const X = this._x, Y = this._y, Z = this._z, CX = this._cx, CY = this._cy, CZ = this._cz, CW = this._cw;
    const WX = this._wx, WY = this._wy, WZ = this._wz, R = this._r, G = this._g, B = this._b, OC = this._oc;
    const W8 = this.width * 8, H8 = this.height * 8; // NDC -> 1/16 sub-pixel units
    const mode = this.shading === 'normals' ? 2 : this.shading === 'flat' || mesh.flat ? 0 : 1;
    const wire = this.wireframe || mesh.wireframe;
    this._wire = !!wire;
    this._wireCol = Array.isArray(wire)
      ? 0xff000000 | ((wire[2] * 255) << 16) | ((wire[1] * 255) << 8) | (wire[0] * 255) : 0;
    const [mr, mg, mb] = mesh.color, spec = mesh.specular, shin = mesh.shininess, two = mesh.doubleSided;

    // ---- vertex stage
    for (let v = 0, k = 0; v < n; v++, k += 3) {
      const x = P[k], y = P[k + 1], z = P[k + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      WX[v] = wx; WY[v] = wy; WZ[v] = wz;
      const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
      const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
      const cz = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
      const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
      CX[v] = cx; CY[v] = cy; CZ[v] = cz; CW[v] = cw;
      const gw = GUARD * cw;
      let o = 0;
      if (cz < -cw) o |= NEAR;
      if (cz > cw) o |= FAR;
      if (cx < -gw) o |= LEFT;
      if (cx > gw) o |= RIGHT;
      if (cy < -gw) o |= BOTTOM;
      if (cy > gw) o |= TOP;
      OC[v] = o;
      if (cw > 0) {
        const iw = 1 / cw;
        X[v] = Math.round(cx * iw * W8 + W8);
        Y[v] = Math.round(H8 - cy * iw * H8);
        Z[v] = iw;
      }
      if (mode !== 0) {
        const ox = NRM[k], oy = NRM[k + 1], oz = NRM[k + 2];
        let nx = nm[0] * ox + nm[1] * oy + nm[2] * oz;
        let ny = nm[3] * ox + nm[4] * oy + nm[5] * oz;
        let nz = nm[6] * ox + nm[7] * oy + nm[8] * oz;
        const il = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
        nx *= il; ny *= il; nz *= il;
        if (mode === 2) {
          R[v] = (nx * 0.5 + 0.5) * 255; G[v] = (ny * 0.5 + 0.5) * 255; B[v] = (nz * 0.5 + 0.5) * 255;
        } else {
          if (VC) shade(nx, ny, nz, wx, wy, wz, VC[k], VC[k + 1], VC[k + 2], spec, shin, two);
          else shade(nx, ny, nz, wx, wy, wz, mr, mg, mb, spec, shin, two);
          R[v] = L.r; G[v] = L.g; B[v] = L.b;
        }
      }
    }

    // ---- primitive stage
    const I = geo.indices, cull = this.cullBack && !two;
    this._cull = cull;
    this._flat = mode === 0;
    this.stats.triangles += I.length / 3;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c2 = I[t + 2];
      const oa = OC[a], ob = OC[b], oc = OC[c2];
      if (oa & ob & oc) continue; // completely outside one plane
      if ((oa | ob | oc) === 0) {
        const x0 = X[a], y0 = Y[a], x1 = X[b], y1 = Y[b], x2 = X[c2], y2 = Y[c2];
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (area === 0 || (area > 0 && cull)) continue; // screen y points down: front faces have area < 0
        if (mode === 0) {
          this._faceColor(a, b, c2, mesh);
          const r = L.r, g = L.g, bl = L.b;
          this._raster(x0, y0, Z[a], r, g, bl, x1, y1, Z[b], r, g, bl, x2, y2, Z[c2], r, g, bl);
        } else {
          this._raster(x0, y0, Z[a], R[a], G[a], B[a], x1, y1, Z[b], R[b], G[b], B[b], x2, y2, Z[c2], R[c2], G[c2], B[c2]);
        }
      } else {
        if (mode === 0) this._faceColor(a, b, c2, mesh);
        this._clip(a, b, c2, oa | ob | oc);
      }
    }
  }

  // Flat shading: one lighting evaluation per triangle at its centroid.
  _faceColor(a, b, c, mesh) {
    const WX = this._wx, WY = this._wy, WZ = this._wz, VC = mesh.geometry.colors;
    const ux = WX[b] - WX[a], uy = WY[b] - WY[a], uz = WZ[b] - WZ[a];
    const vx = WX[c] - WX[a], vy = WY[c] - WY[a], vz = WZ[c] - WZ[a];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const il = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
    nx *= il; ny *= il; nz *= il;
    let mr, mg, mb;
    if (VC) {
      const ka = a * 3, kb = b * 3, kc = c * 3;
      mr = (VC[ka] + VC[kb] + VC[kc]) / 3; mg = (VC[ka + 1] + VC[kb + 1] + VC[kc + 1]) / 3; mb = (VC[ka + 2] + VC[kb + 2] + VC[kc + 2]) / 3;
    } else [mr, mg, mb] = mesh.color;
    shade(nx, ny, nz, (WX[a] + WX[b] + WX[c]) / 3, (WY[a] + WY[b] + WY[c]) / 3, (WZ[a] + WZ[b] + WZ[c]) / 3,
      mr, mg, mb, mesh.specular, mesh.shininess, mesh.doubleSided);
  }

  // Sutherland-Hodgman in homogeneous clip space, only against the planes that are actually crossed.
  _clip(a, b, c, codes) {
    let inp = this._clipA, out = this._clipB, n = 3;
    const flat = this._flat, idx = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const v = idx[i], o = i * STRIDE;
      inp[o] = this._cx[v]; inp[o + 1] = this._cy[v]; inp[o + 2] = this._cz[v]; inp[o + 3] = this._cw[v];
      inp[o + 4] = flat ? L.r : this._r[v]; inp[o + 5] = flat ? L.g : this._g[v]; inp[o + 6] = flat ? L.b : this._b[v];
    }
    for (let p = 0; p < 6; p++) {
      const bit = PLANES[p];
      if (!(codes & bit)) continue;
      let m = 0;
      for (let i = 0; i < n; i++) {
        const ia = i * STRIDE, ja = ((i + 1) % n) * STRIDE;
        const da = planeDist(bit, inp, ia), db = planeDist(bit, inp, ja);
        if (da >= 0) {
          for (let k = 0; k < STRIDE; k++) out[m * STRIDE + k] = inp[ia + k];
          m++;
        }
        if ((da >= 0) !== (db >= 0)) {
          const t = da / (da - db);
          for (let k = 0; k < STRIDE; k++) out[m * STRIDE + k] = inp[ia + k] + (inp[ja + k] - inp[ia + k]) * t;
          m++;
        }
      }
      const tmp = inp; inp = out; out = tmp;
      n = m;
      if (n < 3) return;
    }
    this.stats.clipped++;
    const W8 = this.width * 8, H8 = this.height * 8;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE, iw = 1 / inp[o + 3];
      inp[o] = Math.round(inp[o] * iw * W8 + W8);
      inp[o + 1] = Math.round(H8 - inp[o + 1] * iw * H8);
      inp[o + 2] = iw;
    }
    for (let i = 1; i < n - 1; i++) {
      const p1 = i * STRIDE, p2 = p1 + STRIDE;
      this._raster(inp[0], inp[1], inp[2], inp[4], inp[5], inp[6],
        inp[p1], inp[p1 + 1], inp[p1 + 2], inp[p1 + 4], inp[p1 + 5], inp[p1 + 6],
        inp[p2], inp[p2 + 1], inp[p2 + 2], inp[p2 + 4], inp[p2 + 5], inp[p2 + 6]);
    }
  }

  // x/y in 1/16 pixel units (integers), z = 1/w, r/g/b in 0..255
  _raster(x0, y0, z0, r0, g0, b0, x1, y1, z1, r1, g1, b1, x2, y2, z2, r2, g2, b2) {
    let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0) return;
    if (area > 0) {
      if (this._cull) return; // back face
    } else {
      // front face: swap to positive orientation, the edge functions below expect it
      let t;
      t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; t = z1; z1 = z2; z2 = t;
      t = r1; r1 = r2; r2 = t; t = g1; g1 = g2; g2 = t; t = b1; b1 = b2; b2 = t;
      area = -area;
    }
    const W = this.width, H = this.height;
    // pixel px is sampled at sub-pixel 16*px + 8
    let minX = Math.ceil((Math.min(x0, x1, x2) - 8) / 16), maxX = Math.floor((Math.max(x0, x1, x2) - 8) / 16);
    let minY = Math.ceil((Math.min(y0, y1, y2) - 8) / 16), maxY = Math.floor((Math.max(y0, y1, y2) - 8) / 16);
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > W - 1) maxX = W - 1;
    if (maxY > H - 1) maxY = H - 1;
    if (minX > maxX || minY > maxY) return;
    this.stats.drawn++;

    // Edge functions E(px, py) = A*px + B*py + C, inside where all three are >= 0.
    // Integer math in doubles -> exact. Non top-left edges get a -1 bias (shared edges drawn once).
    const A0 = (y1 - y2) * 16, B0 = (x2 - x1) * 16;
    const A1 = (y2 - y0) * 16, B1 = (x0 - x2) * 16;
    const A2 = (y0 - y1) * 16, B2 = (x1 - x0) * 16;
    let C0 = (x2 - x1) * (8 - y1) - (y2 - y1) * (8 - x1);
    let C1 = (x0 - x2) * (8 - y2) - (y0 - y2) * (8 - x2);
    let C2 = (x1 - x0) * (8 - y0) - (y1 - y0) * (8 - x0);
    if (!(y2 < y1 || (y2 === y1 && x2 > x1))) C0 -= 1;
    if (!(y0 < y2 || (y0 === y2 && x0 > x2))) C1 -= 1;
    if (!(y1 < y0 || (y1 === y0 && x1 > x0))) C2 -= 1;

    // Attribute planes: value(px, py) = base + dx*px + dy*py
    const k = 16 / area, ex1 = x1 - x0, ey1 = y1 - y0, ex2 = x2 - x0, ey2 = y2 - y0;
    const ox = 0.5 - x0 / 16, oy = 0.5 - y0 / 16;
    const zdx = ((z1 - z0) * ey2 - (z2 - z0) * ey1) * k, zdy = ((z2 - z0) * ex1 - (z1 - z0) * ex2) * k;
    const zb = z0 + zdx * ox + zdy * oy;

    const depth = this.depth, color = this.color, flat = this._flat, wire = this._wire, wireCol = this._wireCol;
    let rdx = 0, rdy = 0, rb = r0, gdx = 0, gdy = 0, gb = g0, bdx = 0, bdy = 0, bb = b0;
    if (!flat) {
      rdx = ((r1 - r0) * ey2 - (r2 - r0) * ey1) * k; rdy = ((r2 - r0) * ex1 - (r1 - r0) * ex2) * k; rb = r0 + rdx * ox + rdy * oy;
      gdx = ((g1 - g0) * ey2 - (g2 - g0) * ey1) * k; gdy = ((g2 - g0) * ex1 - (g1 - g0) * ex2) * k; gb = g0 + gdx * ox + gdy * oy;
      bdx = ((b1 - b0) * ey2 - (b2 - b0) * ey1) * k; bdy = ((b2 - b0) * ex1 - (b1 - b0) * ex2) * k; bb = b0 + bdx * ox + bdy * oy;
    }
    const flatCol = 0xff000000 | ((b0 | 0) << 16) | ((g0 | 0) << 8) | (r0 | 0);
    const n0 = wire ? 1 / Math.hypot(A0, B0) : 0, n1 = wire ? 1 / Math.hypot(A1, B1) : 0, n2 = wire ? 1 / Math.hypot(A2, B2) : 0;
    const LW = this.wireWidth;

    let pix = 0, q;
    for (let py = minY; py <= maxY; py++) {
      const e0 = B0 * py + C0, e1 = B1 * py + C1, e2 = B2 * py + C2;
      // solve the exact covered span [xs, xe] of this row
      let xs = minX, xe = maxX;
      if (A0 > 0) { q = Math.ceil(-e0 / A0); if (q > xs) xs = q; } else if (A0 < 0) { q = Math.floor(e0 / -A0); if (q < xe) xe = q; } else if (e0 < 0) xe = -1;
      if (A1 > 0) { q = Math.ceil(-e1 / A1); if (q > xs) xs = q; } else if (A1 < 0) { q = Math.floor(e1 / -A1); if (q < xe) xe = q; } else if (e1 < 0) xe = -1;
      if (A2 > 0) { q = Math.ceil(-e2 / A2); if (q > xs) xs = q; } else if (A2 < 0) { q = Math.floor(e2 / -A2); if (q < xe) xe = q; } else if (e2 < 0) xe = -1;
      if (xs > xe) continue; // (thin triangles can skip rows, so no early exit)
      pix += xe - xs + 1;

      let i = py * W + xs;
      const end = py * W + xe;
      let z = zb + zdx * xs + zdy * py;
      if (wire) {
        let r = rb + rdx * xs + rdy * py, g = gb + gdx * xs + gdy * py, b = bb + bdx * xs + bdy * py;
        let d0 = (e0 + A0 * xs) * n0, d1 = (e1 + A1 * xs) * n1, d2 = (e2 + A2 * xs) * n2;
        const s0 = A0 * n0, s1 = A1 * n1, s2 = A2 * n2;
        for (; i <= end; i++) {
          if (z > depth[i]) {
            depth[i] = z;
            if (d0 < LW || d1 < LW || d2 < LW) {
              color[i] = wireCol || 0xff000000 | (((b * 0.25) | 0) << 16) | (((g * 0.25) | 0) << 8) | ((r * 0.25) | 0);
            } else color[i] = 0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
          }
          z += zdx; r += rdx; g += gdx; b += bdx; d0 += s0; d1 += s1; d2 += s2;
        }
      } else if (flat) {
        for (; i <= end; i++, z += zdx) {
          if (z > depth[i]) { depth[i] = z; color[i] = flatCol; }
        }
      } else {
        let r = rb + rdx * xs + rdy * py, g = gb + gdx * xs + gdy * py, b = bb + bdx * xs + bdy * py;
        for (; i <= end; i++) {
          if (z > depth[i]) {
            depth[i] = z;
            color[i] = 0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
          }
          z += zdx; r += rdx; g += gdx; b += bdx;
        }
      }
    }
    this.stats.pixels += pix;
  }
}

function planeDist(bit, v, o) {
  const x = v[o], y = v[o + 1], z = v[o + 2], w = v[o + 3];
  switch (bit) {
    case NEAR: return z + w;
    case FAR: return w - z;
    case LEFT: return x + GUARD * w;
    case RIGHT: return GUARD * w - x;
    case BOTTOM: return y + GUARD * w;
    default: return GUARD * w - y;
  }
}
