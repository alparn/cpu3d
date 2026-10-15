// Geometry stages of the pipeline, shared by the renderer (one thread) and the render workers (pool.js):
//
//   vertex stage  : model/view/projection (+ wind), per-vertex lighting (Gouraud), outcodes
//   primitive     : trivial reject, homogeneous clipping (near/far + guard band), back-face cull
//   raster        : half-space edge functions on a 1/16 sub-pixel grid with top-left fill rule,
//                   exact per-row span solving (no wasted pixel tests), 1/w depth buffer
//
// The renderer turns the scene into a draw list (one entry per visible mesh, see Renderer#_prepare). The vertex
// stage writes every draw's vertices into frame-wide buffers at the draw's vertex base, so any thread can transform
// any range of them. The raster stage then walks all draws in order on every thread, each thread drawing only the
// rows it owns (interleaved bands): triangles reach every pixel in the same order as on one thread, so the image is
// identical whatever the thread count.

import { TONE_SCALE, TONE_MAX_V, TONE_LAST, WIRE_MATERIAL, SRGB_TO_LINEAR } from './lighting.js';
import { windAt } from './wind.js';
import * as WIND from './wind.js';

const GUARD = 8; // guard band (in NDC units): only triangles crossing it are clipped in x/y
const NEAR = 1, FAR = 2, LEFT = 4, RIGHT = 8, BOTTOM = 16, TOP = 32;
const PLANES = [NEAR, FAR, LEFT, RIGHT, BOTTOM, TOP];
const STRIDE = 13; // clip vertex: x y z w r g b nx ny nz ox oy oz (object-space position for textures and patterns)
export const DRAW_FLOATS = 41; // per draw in the matrix buffer: mvp (16), model (16), normal matrix (9)
export const BAND = 8; // rows per raster band (at most; smaller frames use thinner bands); band b belongs to group b % groups

// Frame-wide vertex buffers (outputs of the vertex stage), allocated with alloc(Type, n).
export function vertexBuffers(n, alloc) {
  const F64 = Float64Array, F32 = Float32Array;
  return {
    cap: n, X: alloc(Int32Array, n), Y: alloc(Int32Array, n), Z: alloc(F64, n),
    CX: alloc(F64, n), CY: alloc(F64, n), CZ: alloc(F64, n), CW: alloc(F64, n),
    WX: alloc(F32, n), WY: alloc(F32, n), WZ: alloc(F32, n), R: alloc(F32, n), G: alloc(F32, n), B: alloc(F32, n),
    NX: alloc(F32, n), NY: alloc(F32, n), NZ: alloc(F32, n), OC: alloc(Uint8Array, n),
  };
}

// Rows of band group k of n: next[y] = first row of the group >= y (H when none is left), or null for all rows.
const ownCache = new Map();
export function ownedRows(H, n, k, band = BAND) {
  if (n <= 1) return null;
  const key = `${H}|${n}|${k}|${band}`;
  let t = ownCache.get(key);
  if (!t) {
    if (ownCache.size > 256) ownCache.clear();
    t = new Int32Array(H + 1);
    t[H] = H;
    for (let y = H - 1; y >= 0; y--) t[y] = ((y / band) | 0) % n === k ? y : t[y + 1];
    ownCache.set(key, t);
  }
  return t;
}

// band height for n groups: thin enough that every group gets a few bands spread over the frame
export const bandFor = (H, n) => Math.max(2, Math.min(BAND, Math.floor(H / (n * 3))));

const S2L = SRGB_TO_LINEAR;
const lin = (c) => S2L[c >= 1 ? 255 : c <= 0 ? 0 : (c * 255 + 0.5) | 0];

// Per-vertex lighting for the fast path: hemisphere ambient + Lambert + Blinn-Phong in linear light,
// ACES tone mapping, then fog in display space. Material colors are sRGB 0..1. Result in L.r/g/b (0..255).
function shade(L, nx, ny, nz, px, py, pz, cr, cg, cb, spec, shin, twoSided, emissive) {
  const mr = lin(cr), mg = lin(cg), mb = lin(cb), tone = L.tone;
  let vx = L.ex - px, vy = L.ey - py, vz = L.ez - pz;
  const dist = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
  vx /= dist; vy /= dist; vz /= dist;
  if (twoSided && nx * vx + ny * vy + nz * vz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const hemi = ny * 0.5 + 0.5;
  const kd = emissive >= 1 ? 0 : 1 - emissive; // emitters do not also scatter light diffusely
  let r = mr * kd * (L.gr + (L.sr - L.gr) * hemi);
  let g = mg * kd * (L.gg + (L.sg - L.gg) * hemi);
  let b = mb * kd * (L.gb + (L.sb - L.gb) * hemi);
  const ndl = nx * L.lx + ny * L.ly + nz * L.lz;
  if (ndl > 0) {
    r += mr * kd * L.lr * ndl; g += mg * kd * L.lg * ndl; b += mb * kd * L.lb * ndl;
    if (spec > 0) {
      const hx = L.lx + vx, hy = L.ly + vy, hz = L.lz + vz;
      const ndh = (nx * hx + ny * hy + nz * hz) / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
      if (ndh > 0) {
        const s = spec * Math.pow(ndh, shin);
        r += L.lr * s; g += L.lg * s; b += L.lb * s;
      }
    }
  }
  if (emissive > 0) {
    const inv = L.invTone, q = (c) => inv[c >= 1 ? 255 : c <= 0 ? 0 : (c * 255 + 0.5) | 0];
    r += q(cr) * emissive; g += q(cg) * emissive; b += q(cb) * emissive;
  }
  let R8 = tone[r >= TONE_MAX_V ? TONE_LAST : (r * TONE_SCALE) | 0];
  let G8 = tone[g >= TONE_MAX_V ? TONE_LAST : (g * TONE_SCALE) | 0];
  let B8 = tone[b >= TONE_MAX_V ? TONE_LAST : (b * TONE_SCALE) | 0];
  if (L.fog) {
    let f = (dist - L.fn) / (L.ff - L.fn);
    if (f > 0) {
      if (f > 1) f = 1;
      R8 += (L.fr - R8) * f; G8 += (L.fg - G8) * f; B8 += (L.fb - B8) * f;
    }
  }
  L.r = R8; L.g = G8; L.b = B8;
}

// One per thread. A frame job (built by the renderer) carries:
//   W, H, color, depth, (high quality) NX NY NZ MAT OX OY OZ G-buffer, vb (vertexBuffers), draws, dm (matrix buffer),
//   vlight (lighting state of the fast path), tchunks / bins / binCount (pool only, see bin()),
//   hq, wireWidth, time, bg { top, bottom }
export class RasterCore {
  constructor() {
    this._tv = new Float64Array(36); // 3 vertices x [x, y, 1/w, nx/w, ny/w, nz/w, r, g, b, ox/w, oy/w, oz/w]
    this._fn = new Float64Array(3);
    this._clipA = new Float64Array(16 * STRIDE);
    this._clipB = new Float64Array(16 * STRIDE);
    this._pl = new Float64Array(36); // attribute planes of _rasterG
    this.stats = { drawn: 0, clipped: 0, pixels: 0 };
  }

  // own: ownedRows(...) of this thread, or null for the whole frame
  begin(job, own) {
    this.job = job;
    this.own = own;
    this.W = job.W; this.H = job.H;
    this.L = job.vlight;
    this.stats.drawn = this.stats.clipped = this.stats.pixels = 0;
  }

  // background gradient and empty depth for the owned rows
  clear() {
    const { W, H, color, depth, bg } = this.job, own = this.own;
    const top = bg?.top ?? [0.1, 0.11, 0.14], bottom = bg?.bottom ?? [0.25, 0.27, 0.3];
    for (let y = own ? own[0] : 0; y < H; y = own ? own[y + 1] : y + 1) {
      const t = y / Math.max(1, H - 1);
      const r = (top[0] + (bottom[0] - top[0]) * t) * 255, g = (top[1] + (bottom[1] - top[1]) * t) * 255;
      const b = (top[2] + (bottom[2] - top[2]) * t) * 255;
      color.fill(0xff000000 | (b << 16) | (g << 8) | r, y * W, y * W + W);
      depth.fill(0, y * W, y * W + W);
    }
  }

  // ---- vertex stage for vertices [v0, v1) of draw d
  vertices(d, v0, v1) {
    const job = this.job, vb = job.vb, dm = job.dm, o = d.k;
    const geo = d.geo, P = geo.positions, NRM = geo.normals, VC = geo.colors;
    const base = d.base, X = vb.X, Y = vb.Y, Z = vb.Z, CX = vb.CX, CY = vb.CY, CZ = vb.CZ, CW = vb.CW;
    const WX = vb.WX, WY = vb.WY, WZ = vb.WZ, R = vb.R, G = vb.G, B = vb.B, VNX = vb.NX, VNY = vb.NY, VNZ = vb.NZ, OC = vb.OC;
    const W8 = this.W * 8, H8 = this.H * 8; // NDC -> 1/16 sub-pixel units
    const mode = d.mode, L = this.L, [mr, mg, mb] = d.color;
    const wind = d.wind, wt = job.time, wbase = geo.min[1], vp = job.vp;
    // model (m), model-view-projection (p) and normal matrix (q) of this draw
    const p0 = dm[o], p1 = dm[o + 1], p2 = dm[o + 2], p3 = dm[o + 3], p4 = dm[o + 4], p5 = dm[o + 5], p6 = dm[o + 6], p7 = dm[o + 7];
    const p8 = dm[o + 8], p9 = dm[o + 9], p10 = dm[o + 10], p11 = dm[o + 11], p12 = dm[o + 12], p13 = dm[o + 13], p14 = dm[o + 14], p15 = dm[o + 15];
    const m0 = dm[o + 16], m1 = dm[o + 17], m2 = dm[o + 18], m4 = dm[o + 20], m5 = dm[o + 21], m6 = dm[o + 22];
    const m8 = dm[o + 24], m9 = dm[o + 25], m10 = dm[o + 26], m12 = dm[o + 28], m13 = dm[o + 29], m14 = dm[o + 30];
    const q0 = dm[o + 32], q1 = dm[o + 33], q2 = dm[o + 34], q3 = dm[o + 35], q4 = dm[o + 36], q5 = dm[o + 37], q6 = dm[o + 38], q7 = dm[o + 39], q8 = dm[o + 40];
    for (let v = v0, k = v0 * 3; v < v1; v++, k += 3) {
      const x = P[k], y = P[k + 1], z = P[k + 2], j = base + v;
      let wx = m0 * x + m4 * y + m8 * z + m12;
      let wy = m1 * x + m5 * y + m9 * z + m13;
      let wz = m2 * x + m6 * y + m10 * z + m14;
      let cx, cy, cz, cw;
      if (wind) {
        // wind bends the vertex in world space; project the moved point
        windAt(wind, y, wbase, wx, wz, wt);
        wx += WIND.DX; wy += WIND.DY; wz += WIND.DZ;
        cx = vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12];
        cy = vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13];
        cz = vp[2] * wx + vp[6] * wy + vp[10] * wz + vp[14];
        cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
      } else {
        cx = p0 * x + p4 * y + p8 * z + p12;
        cy = p1 * x + p5 * y + p9 * z + p13;
        cz = p2 * x + p6 * y + p10 * z + p14;
        cw = p3 * x + p7 * y + p11 * z + p15;
      }
      WX[j] = wx; WY[j] = wy; WZ[j] = wz;
      CX[j] = cx; CY[j] = cy; CZ[j] = cz; CW[j] = cw;
      const gw = GUARD * cw;
      let oc = 0;
      if (cz < -cw) oc |= NEAR;
      if (cz > cw) oc |= FAR;
      if (cx < -gw) oc |= LEFT;
      if (cx > gw) oc |= RIGHT;
      if (cy < -gw) oc |= BOTTOM;
      if (cy > gw) oc |= TOP;
      OC[j] = oc;
      if (cw > 0) {
        const iw = 1 / cw;
        X[j] = Math.round(cx * iw * W8 + W8);
        Y[j] = Math.round(H8 - cy * iw * H8);
        Z[j] = iw;
      }
      if (mode !== 0) {
        const ox = NRM[k], oy = NRM[k + 1], oz = NRM[k + 2];
        let nx = q0 * ox + q1 * oy + q2 * oz;
        let ny = q3 * ox + q4 * oy + q5 * oz;
        let nz = q6 * ox + q7 * oy + q8 * oz;
        const il = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
        nx *= il; ny *= il; nz *= il;
        if (mode === 3) {
          VNX[j] = nx; VNY[j] = ny; VNZ[j] = nz;
          const cr = VC ? VC[k] : mr, cg = VC ? VC[k + 1] : mg, cb = VC ? VC[k + 2] : mb;
          R[j] = cr >= 1 ? 255 : cr * 255; G[j] = cg >= 1 ? 255 : cg * 255; B[j] = cb >= 1 ? 255 : cb * 255;
        } else if (mode === 2) {
          R[j] = (nx * 0.5 + 0.5) * 255; G[j] = (ny * 0.5 + 0.5) * 255; B[j] = (nz * 0.5 + 0.5) * 255;
        } else {
          if (VC) shade(L, nx, ny, nz, wx, wy, wz, VC[k], VC[k + 1], VC[k + 2], d.spec, d.shin, d.two, d.emissive);
          else shade(L, nx, ny, nz, wx, wy, wz, mr, mg, mb, d.spec, d.shin, d.two, d.emissive);
          R[j] = L.r; G[j] = L.g; B[j] = L.b;
        }
      }
    }
  }

  // ---- primitive stage + raster
  // On one thread: triangles(d) for every draw in order. On the pool: bin() sorts the triangles of chunks of the
  // draw list into per-thread lists (by the rows they cover), then binned() rasterizes a thread's lists in order.

  // all triangles of draw d (restricted to the owned rows, if any)
  triangles(d) {
    this.useDraw(d);
    const n = d.geo.indices.length;
    for (let t = 0; t < n; t += 3) this.triangle(t);
  }

  useDraw(d) {
    this._d = d;
    this._I = d.geo.indices;
    this._cull = d.cull;
    this._flat = d.mode === 0;
    this._hq = d.mode === 3;
    this._mat = d.mat;
    this._wire = d.wire;
    this._wireCol = d.wireCol;
    this._tex = d.tex;
    this._map = d.map;
    this._obj = d.obj;
    this._pat = d.pat;
  }

  // triangle at index offset t of the current draw
  triangle(t) {
    const d = this._d, vb = this.job.vb, base = d.base, I = this._I;
    const OC = vb.OC, a = base + I[t], b = base + I[t + 1], c2 = base + I[t + 2];
    const oa = OC[a], ob = OC[b], oc = OC[c2];
    if (oa & ob & oc) return; // completely outside one plane
    const mode = d.mode;
    if ((oa | ob | oc) !== 0) {
      if (mode === 0) this._faceColor(a, b, c2);
      if (mode === 3 && d.flat) this._faceNormal(a, b, c2);
      this._clip(a, b, c2, oa | ob | oc);
      return;
    }
    const X = vb.X, Y = vb.Y, Z = vb.Z, R = vb.R, G = vb.G, B = vb.B;
    const x0 = X[a], y0 = Y[a], x1 = X[b], y1 = Y[b], x2 = X[c2], y2 = Y[c2];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area === 0 || (area > 0 && d.cull)) return; // screen y points down: front faces have area < 0
    if (mode === 3) {
      const T = this._tv, fn = this._fn, flatMesh = d.flat, obj = d.obj, P = d.geo.positions;
      const VNX = vb.NX, VNY = vb.NY, VNZ = vb.NZ;
      if (flatMesh) this._faceNormal(a, b, c2);
      let o = 0;
      for (let q = 0; q < 3; q++) {
        const v = q === 0 ? a : q === 1 ? b : c2, iw = Z[v], pv = (v - base) * 3;
        T[o] = X[v]; T[o + 1] = Y[v]; T[o + 2] = iw;
        T[o + 3] = (flatMesh ? fn[0] : VNX[v]) * iw; T[o + 4] = (flatMesh ? fn[1] : VNY[v]) * iw; T[o + 5] = (flatMesh ? fn[2] : VNZ[v]) * iw;
        T[o + 6] = R[v]; T[o + 7] = G[v]; T[o + 8] = B[v];
        if (obj) { T[o + 9] = P[pv] * iw; T[o + 10] = P[pv + 1] * iw; T[o + 11] = P[pv + 2] * iw; }
        else { T[o + 9] = 0; T[o + 10] = 0; T[o + 11] = 0; }
        o += 12;
      }
      this._rasterG();
    } else if (mode === 0) {
      this._faceColor(a, b, c2);
      const L = this.L, r = L.r, g = L.g, bl = L.b;
      this._raster(x0, y0, Z[a], r, g, bl, x1, y1, Z[b], r, g, bl, x2, y2, Z[c2], r, g, bl);
    } else {
      this._raster(x0, y0, Z[a], R[a], G[a], B[a], x1, y1, Z[b], R[b], G[b], B[b], x2, y2, Z[c2], R[c2], G[c2], B[c2]);
    }
  }

  // Binning of triangle chunk c (job.tchunks: draw, first index offset, end, slot) for n band groups (group k owns
  // the bands b with b % n = k): every triangle that survives the trivial tests goes into the list of each group
  // owning one of its rows, in order. Lists live in job.bins at (slot * n + group * count), their lengths in
  // job.binCount[c * n + group].
  bin(c, n) {
    const job = this.job, tc = job.tchunks, d = job.draws[tc[c * 4]], t0 = tc[c * 4 + 1], t1 = tc[c * 4 + 2];
    const count = (t1 - t0) / 3, region = tc[c * 4 + 3] * n, bins = job.bins, lens = job.binCount;
    const vb = job.vb, OC = vb.OC, X = vb.X, Y = vb.Y, I = d.geo.indices, base = d.base, cull = d.cull, H = this.H, W = this.W, band = job.band;
    if (!this._lens || this._lens.length < n) this._lens = new Int32Array(n);
    const len = this._lens;
    len.fill(0, 0, n);
    for (let t = t0; t < t1; t += 3) {
      const a = base + I[t], b = base + I[t + 1], c2 = base + I[t + 2];
      const oa = OC[a], ob = OC[b], oc = OC[c2];
      if (oa & ob & oc) continue;
      let first = 0, last = n - 1; // bands covered (clipped triangles: all of them)
      if ((oa | ob | oc) === 0) {
        const x0 = X[a], y0 = Y[a], x1 = X[b], y1 = Y[b], x2 = X[c2], y2 = Y[c2];
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        if (area === 0 || (area > 0 && cull)) continue;
        let r0 = Math.ceil(((y0 < y1 ? (y0 < y2 ? y0 : y2) : y1 < y2 ? y1 : y2) - 8) / 16);
        let r1 = Math.floor(((y0 > y1 ? (y0 > y2 ? y0 : y2) : y1 > y2 ? y1 : y2) - 8) / 16);
        if (r0 < 0) r0 = 0;
        if (r1 > H - 1) r1 = H - 1;
        if (r0 > r1) continue; // between two pixel rows, or off screen
        // same for columns: tiny far-away triangles that miss every pixel center never reach the raster stage
        let c0 = Math.ceil(((x0 < x1 ? (x0 < x2 ? x0 : x2) : x1 < x2 ? x1 : x2) - 8) / 16);
        let c1 = Math.floor(((x0 > x1 ? (x0 > x2 ? x0 : x2) : x1 > x2 ? x1 : x2) - 8) / 16);
        if (c0 < 0) c0 = 0;
        if (c1 > W - 1) c1 = W - 1;
        if (c0 > c1) continue;
        first = (r0 / band) | 0; last = (r1 / band) | 0;
        if (last - first >= n) { first = 0; last = n - 1; }
      }
      for (let band = first; band <= last; band++) {
        const k = band % n;
        bins[region + k * count + len[k]++] = t;
      }
    }
    for (let k = 0; k < n; k++) lens[c * n + k] = len[k];
  }

  // raster the binned lists of band group k of n (after all chunks were binned; this.own = ownedRows(H, n, k))
  binned(k, n) {
    const job = this.job, tc = job.tchunks, nc = tc.length / 4, bins = job.bins, lens = job.binCount, draws = job.draws;
    let current = null;
    for (let c = 0; c < nc; c++) {
      const m = lens[c * n + k];
      if (m === 0) continue;
      const d = draws[tc[c * 4]];
      if (d !== current) { this.useDraw(d); current = d; }
      const count = (tc[c * 4 + 2] - tc[c * 4 + 1]) / 3, at = tc[c * 4 + 3] * n + k * count;
      for (let i = 0; i < m; i++) this.triangle(bins[at + i]);
    }
  }

  // World-space face normal into this._fn (flat meshes in the high quality path).
  _faceNormal(a, b, c) {
    const vb = this.job.vb, WX = vb.WX, WY = vb.WY, WZ = vb.WZ, fn = this._fn;
    const ux = WX[b] - WX[a], uy = WY[b] - WY[a], uz = WZ[b] - WZ[a];
    const vx = WX[c] - WX[a], vy = WY[c] - WY[a], vz = WZ[c] - WZ[a];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const il = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
    fn[0] = nx * il; fn[1] = ny * il; fn[2] = nz * il;
  }

  // Flat shading: one lighting evaluation per triangle at its centroid. Result in L.r/g/b.
  _faceColor(a, b, c) {
    const d = this._d, vb = this.job.vb, WX = vb.WX, WY = vb.WY, WZ = vb.WZ, VC = d.geo.colors;
    const ux = WX[b] - WX[a], uy = WY[b] - WY[a], uz = WZ[b] - WZ[a];
    const vx = WX[c] - WX[a], vy = WY[c] - WY[a], vz = WZ[c] - WZ[a];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const il = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
    nx *= il; ny *= il; nz *= il;
    let mr, mg, mb;
    if (VC) {
      const ka = (a - d.base) * 3, kb = (b - d.base) * 3, kc = (c - d.base) * 3;
      mr = (VC[ka] + VC[kb] + VC[kc]) / 3; mg = (VC[ka + 1] + VC[kb + 1] + VC[kc + 1]) / 3; mb = (VC[ka + 2] + VC[kb + 2] + VC[kc + 2]) / 3;
    } else [mr, mg, mb] = d.color;
    shade(this.L, nx, ny, nz, (WX[a] + WX[b] + WX[c]) / 3, (WY[a] + WY[b] + WY[c]) / 3, (WZ[a] + WZ[b] + WZ[c]) / 3,
      mr, mg, mb, d.spec, d.shin, d.two, d.emissive);
  }

  // Sutherland-Hodgman in homogeneous clip space, only against the planes that are actually crossed.
  _clip(a, b, c, codes) {
    let inp = this._clipA, out = this._clipB, n = 3;
    const vb = this.job.vb, d = this._d, L = this.L, flat = this._flat, hq = this._hq, idx = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const v = idx[i], o = i * STRIDE;
      inp[o] = vb.CX[v]; inp[o + 1] = vb.CY[v]; inp[o + 2] = vb.CZ[v]; inp[o + 3] = vb.CW[v];
      inp[o + 4] = flat ? L.r : vb.R[v]; inp[o + 5] = flat ? L.g : vb.G[v]; inp[o + 6] = flat ? L.b : vb.B[v];
      if (hq) {
        const fl = d.flat, fn = this._fn, P = d.geo.positions, pv = (v - d.base) * 3;
        inp[o + 7] = fl ? fn[0] : vb.NX[v]; inp[o + 8] = fl ? fn[1] : vb.NY[v]; inp[o + 9] = fl ? fn[2] : vb.NZ[v];
        inp[o + 10] = this._obj ? P[pv] : 0; inp[o + 11] = this._obj ? P[pv + 1] : 0; inp[o + 12] = this._obj ? P[pv + 2] : 0;
      }
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
    if (!this.own || this.own[0] === 0) this.stats.clipped++; // counted once, by the thread owning the first row
    const W8 = this.W * 8, H8 = this.H * 8;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE, iw = 1 / inp[o + 3];
      inp[o] = Math.round(inp[o] * iw * W8 + W8);
      inp[o + 1] = Math.round(H8 - inp[o + 1] * iw * H8);
      inp[o + 2] = iw;
    }
    if (hq) {
      const T = this._tv;
      for (let i = 1; i < n - 1; i++) {
        let o = 0;
        for (let q = 0; q < 3; q++) {
          const p = q === 0 ? 0 : q === 1 ? i * STRIDE : (i + 1) * STRIDE, iw = inp[p + 2];
          T[o] = inp[p]; T[o + 1] = inp[p + 1]; T[o + 2] = iw;
          T[o + 3] = inp[p + 7] * iw; T[o + 4] = inp[p + 8] * iw; T[o + 5] = inp[p + 9] * iw;
          T[o + 6] = inp[p + 4]; T[o + 7] = inp[p + 5]; T[o + 8] = inp[p + 6];
          T[o + 9] = inp[p + 10] * iw; T[o + 10] = inp[p + 11] * iw; T[o + 11] = inp[p + 12] * iw;
          o += 12;
        }
        this._rasterG();
      }
      return;
    }
    for (let i = 1; i < n - 1; i++) {
      const p1 = i * STRIDE, p2 = p1 + STRIDE;
      this._raster(inp[0], inp[1], inp[2], inp[4], inp[5], inp[6],
        inp[p1], inp[p1 + 1], inp[p1 + 2], inp[p1 + 4], inp[p1 + 5], inp[p1 + 6],
        inp[p2], inp[p2 + 1], inp[p2 + 2], inp[p2 + 4], inp[p2 + 5], inp[p2 + 6]);
    }
  }

  // texel (sRGB 0..255) at object point o with world normal n -> TEX_SAMPLE (see Renderer#_mapping for the modes)
  _texAt(ox, oy, oz, nx, ny, nz) {
    const M = this._map, t = this._tex, P = [ox, oy, oz];
    if (M.mode === 0) {
      let u = (P[M.ua] - M.min[M.ua]) * M.inv[M.ua], v = (P[M.va] - M.min[M.va]) * M.inv[M.va];
      if (M.uflip) u = 1 - u;
      if (M.vflip) v = 1 - v;
      return texel(t, u * M.ru, v * M.rv, M.wrap);
    }
    if (M.mode === 2 || M.mode === 3) {
      const dx = ox - M.c[0], dy = oy - M.c[1], dz = oz - M.c[2];
      const u = 0.5 + Math.atan2(dx, dz) / (2 * Math.PI);
      const v = M.mode === 2 ? 1 - (oy - M.min[1]) * M.inv[1] : Math.acos(Math.max(-1, Math.min(1, dy / (Math.hypot(dx, dy, dz) || 1)))) / Math.PI;
      return texel(t, u * M.ru, v * M.rv, true);
    }
    // box: object-space normal (transpose of the model 3x3 times the world normal), weights from its direction
    const m3 = M.m3;
    let ax = Math.abs(m3[0] * nx + m3[1] * ny + m3[2] * nz), ay = Math.abs(m3[3] * nx + m3[4] * ny + m3[5] * nz), az = Math.abs(m3[6] * nx + m3[7] * ny + m3[8] * nz);
    ax *= ax * ax * ax; ay *= ay * ay * ay; az *= az * az * az;
    const sum = ax + ay + az || 1, k = M.big;
    let r = 0, g = 0, b = 0;
    if (ax > 0.01 * sum) { texel(t, -oz * k * M.ru, 1 - oy * k * M.rv, true); r += TEX_SAMPLE[0] * ax; g += TEX_SAMPLE[1] * ax; b += TEX_SAMPLE[2] * ax; }
    if (ay > 0.01 * sum) { texel(t, ox * k * M.ru, oz * k * M.rv, true); r += TEX_SAMPLE[0] * ay; g += TEX_SAMPLE[1] * ay; b += TEX_SAMPLE[2] * ay; }
    if (az > 0.01 * sum) { texel(t, ox * k * M.ru, 1 - oy * k * M.rv, true); r += TEX_SAMPLE[0] * az; g += TEX_SAMPLE[1] * az; b += TEX_SAMPLE[2] * az; }
    TEX_SAMPLE[0] = r / sum; TEX_SAMPLE[1] = g / sum; TEX_SAMPLE[2] = b / sum;
    return TEX_SAMPLE;
  }

  // High quality path: rasterize into the G-buffer (depth, perspective-correct normal, albedo, material).
  // Vertices come from this._tv, 12 values each: [x, y (1/16 px), 1/w, nx/w, ny/w, nz/w, r, g, b (sRGB 0..255), ox/w, oy/w, oz/w]
  // (object-space position, for textures and patterns). With a texture, albedo = texel * vertex color.
  // Same edge setup and span solving as _raster below.
  _rasterG() {
    const T = this._tv;
    const x0 = T[0], y0 = T[1];
    let o1 = 12, o2 = 24;
    let area = (T[12] - x0) * (T[25] - y0) - (T[24] - x0) * (T[13] - y0);
    if (area === 0) return;
    if (area > 0) {
      if (this._cull) return; // back face
    } else { o1 = 24; o2 = 12; area = -area; }
    const x1 = T[o1], y1 = T[o1 + 1], x2 = T[o2], y2 = T[o2 + 1];
    const W = this.W, H = this.H, own = this.own;
    let minX = Math.ceil((Math.min(x0, x1, x2) - 8) / 16), maxX = Math.floor((Math.max(x0, x1, x2) - 8) / 16);
    let minY = Math.ceil((Math.min(y0, y1, y2) - 8) / 16), maxY = Math.floor((Math.max(y0, y1, y2) - 8) / 16);
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > W - 1) maxX = W - 1;
    if (maxY > H - 1) maxY = H - 1;
    if (minX > maxX || minY > maxY) return;
    if (own && own[minY] > maxY) return;
    if (!own || own[minY] === minY) this.stats.drawn++; // counted by the thread owning its first row

    const A0 = (y1 - y2) * 16, B0 = (x2 - x1) * 16;
    const A1 = (y2 - y0) * 16, B1 = (x0 - x2) * 16;
    const A2 = (y0 - y1) * 16, B2 = (x1 - x0) * 16;
    let C0 = (x2 - x1) * (8 - y1) - (y2 - y1) * (8 - x1);
    let C1 = (x0 - x2) * (8 - y2) - (y0 - y2) * (8 - x2);
    let C2 = (x1 - x0) * (8 - y0) - (y1 - y0) * (8 - x0);
    if (!(y2 < y1 || (y2 === y1 && x2 > x1))) C0 -= 1;
    if (!(y0 < y2 || (y0 === y2 && x0 > x2))) C1 -= 1;
    if (!(y1 < y0 || (y1 === y0 && x1 > x0))) C2 -= 1;

    // attribute planes: value(px, py) = base + dx * px + dy * py
    const PL = this._pl, k = 16 / area, ex1 = x1 - x0, ey1 = y1 - y0, ex2 = x2 - x0, ey2 = y2 - y0;
    const ox = 0.5 - x0 / 16, oy = 0.5 - y0 / 16;
    for (let a = 2; a < 12; a++) {
      const v0 = T[a], v1 = T[o1 + a], v2 = T[o2 + a];
      const dx = ((v1 - v0) * ey2 - (v2 - v0) * ey1) * k, dy = ((v2 - v0) * ex1 - (v1 - v0) * ex2) * k;
      PL[a * 3] = v0 + dx * ox + dy * oy; PL[a * 3 + 1] = dx; PL[a * 3 + 2] = dy;
    }
    const zb = PL[6], zdx = PL[7], zdy = PL[8];
    const nxb = PL[9], nxdx = PL[10], nxdy = PL[11], nyb = PL[12], nydx = PL[13], nydy = PL[14];
    const nzb = PL[15], nzdx = PL[16], nzdy = PL[17], rb = PL[18], rdx = PL[19], rdy = PL[20];
    const gb = PL[21], gdx = PL[22], gdy = PL[23], bb = PL[24], bdx = PL[25], bdy = PL[26];
    const pxb = PL[27], pxdx = PL[28], pxdy = PL[29], pyb = PL[30], pydx = PL[31], pydy = PL[32], pzb = PL[33], pzdx = PL[34], pzdy = PL[35];

    const job = this.job, depth = job.depth, color = job.color, NX = job.NX, NY = job.NY, NZ = job.NZ, MAT = job.MAT;
    const mat = this._mat, wire = this._wire, wireCol = this._wireCol, LW = job.wireWidth;
    const tex = this._tex, obj = this._obj, pat = this._pat, OX = job.OX, OY = job.OY, OZ = job.OZ, TS = TEX_SAMPLE;
    const n0 = wire ? 1 / Math.hypot(A0, B0) : 0, n1 = wire ? 1 / Math.hypot(A1, B1) : 0, n2 = wire ? 1 / Math.hypot(A2, B2) : 0;
    let pix = 0, q;
    for (let py = minY; py <= maxY; py++) {
      if (own && own[py] !== py) { py = own[py] - 1; continue; } // jump to the next owned band
      const e0 = B0 * py + C0, e1 = B1 * py + C1, e2 = B2 * py + C2;
      let xs = minX, xe = maxX;
      if (A0 > 0) { q = Math.ceil(-e0 / A0); if (q > xs) xs = q; } else if (A0 < 0) { q = Math.floor(e0 / -A0); if (q < xe) xe = q; } else if (e0 < 0) xe = -1;
      if (A1 > 0) { q = Math.ceil(-e1 / A1); if (q > xs) xs = q; } else if (A1 < 0) { q = Math.floor(e1 / -A1); if (q < xe) xe = q; } else if (e1 < 0) xe = -1;
      if (A2 > 0) { q = Math.ceil(-e2 / A2); if (q > xs) xs = q; } else if (A2 < 0) { q = Math.floor(e2 / -A2); if (q < xe) xe = q; } else if (e2 < 0) xe = -1;
      if (xs > xe) continue;
      pix += xe - xs + 1;
      let i = py * W + xs;
      const end = py * W + xe;
      let z = zb + zdx * xs + zdy * py;
      let nx = nxb + nxdx * xs + nxdy * py, ny = nyb + nydx * xs + nydy * py, nz = nzb + nzdx * xs + nzdy * py;
      let r = rb + rdx * xs + rdy * py, g = gb + gdx * xs + gdy * py, b = bb + bdx * xs + bdy * py;
      let qx = pxb + pxdx * xs + pxdy * py, qy = pyb + pydx * xs + pydy * py, qz = pzb + pzdx * xs + pzdy * py;
      let d0 = (e0 + A0 * xs) * n0, d1 = (e1 + A1 * xs) * n1, d2 = (e2 + A2 * xs) * n2;
      const s0 = A0 * n0, s1 = A1 * n1, s2 = A2 * n2;
      for (; i <= end; i++) {
        if (z > depth[i]) {
          depth[i] = z;
          if (wire && (d0 < LW || d1 < LW || d2 < LW)) {
            color[i] = wireCol || 0xff000000 | (((b * 0.25) | 0) << 16) | (((g * 0.25) | 0) << 8) | ((r * 0.25) | 0);
            MAT[i] = WIRE_MATERIAL;
          } else {
            const iz = 1 / z;
            NX[i] = nx * iz; NY[i] = ny * iz; NZ[i] = nz * iz;
            if (obj) {
              const ox = qx * iz, oy = qy * iz, oz = qz * iz;
              if (pat) { OX[i] = ox; OY[i] = oy; OZ[i] = oz; }
              if (tex) {
                // texel at this point (mapping mode, repeat), tinted by the vertex color
                this._texAt(ox, oy, oz, NX[i], NY[i], NZ[i]);
                color[i] = 0xff000000 | (((TS[2] * b) / 255) << 16) | (((TS[1] * g) / 255) << 8) | ((TS[0] * r) / 255);
              } else color[i] = 0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
            } else {
              color[i] = 0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
            }
            MAT[i] = mat;
          }
        }
        z += zdx; nx += nxdx; ny += nydx; nz += nzdx; r += rdx; g += gdx; b += bdx; qx += pxdx; qy += pydx; qz += pzdx;
        d0 += s0; d1 += s1; d2 += s2;
      }
    }
    this.stats.pixels += pix;
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
    const W = this.W, H = this.H, own = this.own;
    // pixel px is sampled at sub-pixel 16*px + 8
    let minX = Math.ceil((Math.min(x0, x1, x2) - 8) / 16), maxX = Math.floor((Math.max(x0, x1, x2) - 8) / 16);
    let minY = Math.ceil((Math.min(y0, y1, y2) - 8) / 16), maxY = Math.floor((Math.max(y0, y1, y2) - 8) / 16);
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > W - 1) maxX = W - 1;
    if (maxY > H - 1) maxY = H - 1;
    if (minX > maxX || minY > maxY) return;
    if (own && own[minY] > maxY) return;
    if (!own || own[minY] === minY) this.stats.drawn++;

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

    const depth = this.job.depth, color = this.job.color, flat = this._flat, wire = this._wire, wireCol = this._wireCol;
    let rdx = 0, rdy = 0, rb = r0, gdx = 0, gdy = 0, gb = g0, bdx = 0, bdy = 0, bb = b0;
    if (!flat) {
      rdx = ((r1 - r0) * ey2 - (r2 - r0) * ey1) * k; rdy = ((r2 - r0) * ex1 - (r1 - r0) * ex2) * k; rb = r0 + rdx * ox + rdy * oy;
      gdx = ((g1 - g0) * ey2 - (g2 - g0) * ey1) * k; gdy = ((g2 - g0) * ex1 - (g1 - g0) * ex2) * k; gb = g0 + gdx * ox + gdy * oy;
      bdx = ((b1 - b0) * ey2 - (b2 - b0) * ey1) * k; bdy = ((b2 - b0) * ex1 - (b1 - b0) * ex2) * k; bb = b0 + bdx * ox + bdy * oy;
    }
    const flatCol = 0xff000000 | ((b0 | 0) << 16) | ((g0 | 0) << 8) | (r0 | 0);
    const n0 = wire ? 1 / Math.hypot(A0, B0) : 0, n1 = wire ? 1 / Math.hypot(A1, B1) : 0, n2 = wire ? 1 / Math.hypot(A2, B2) : 0;
    const LW = this.job.wireWidth;

    let pix = 0, q;
    for (let py = minY; py <= maxY; py++) {
      if (own && own[py] !== py) { py = own[py] - 1; continue; }
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

// Vertex chunks of a draw list as [draw, v0, v1] triples (the unit of work of the vertex stage).
export function vertexChunks(draws, size = 4096) {
  let n = 0;
  for (const d of draws) n += Math.ceil(d.n / size);
  const out = new Int32Array(n * 3);
  let j = 0;
  for (const d of draws) for (let v = 0; v < d.n; v += size) { out[j++] = d.index; out[j++] = v; out[j++] = Math.min(d.n, v + size); }
  return out;
}

// Triangle chunks as [draw, first index offset, end, slot] (slot: triangles before this chunk, where its bins start).
export function triangleChunks(draws, size = 2048) {
  let n = 0;
  for (const d of draws) n += Math.ceil(d.geo.indices.length / 3 / size);
  const out = new Int32Array(n * 4);
  let j = 0, slot = 0;
  for (const d of draws) {
    const len = d.geo.indices.length;
    for (let t = 0; t < len; t += size * 3) {
      const end = Math.min(len, t + size * 3);
      out[j++] = d.index; out[j++] = t; out[j++] = end; out[j++] = slot;
      slot += (end - t) / 3;
    }
  }
  return out;
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

// bilinear texel lookup (u, v in texture units 0..1; wrap repeats, otherwise clamps) -> TEX_SAMPLE (sRGB 0..255)
const TEX_SAMPLE = new Float64Array(3);
function texel(t, u, v, wrap) {
  const tw = t.w, th = t.h, tp = t.px;
  if (wrap) { u -= Math.floor(u); v -= Math.floor(v); }
  let fx = u * tw - 0.5, fy = v * th - 0.5;
  let ix = Math.floor(fx), iy = Math.floor(fy);
  const ax = fx - ix, ay = fy - iy;
  let ix1 = ix + 1, iy1 = iy + 1;
  if (wrap) { ix = (ix + tw) % tw; ix1 = ix1 % tw; iy = (iy + th) % th; iy1 = iy1 % th; }
  else { ix = ix < 0 ? 0 : ix > tw - 1 ? tw - 1 : ix; ix1 = ix1 > tw - 1 ? tw - 1 : ix1 < 0 ? 0 : ix1; iy = iy < 0 ? 0 : iy > th - 1 ? th - 1 : iy; iy1 = iy1 > th - 1 ? th - 1 : iy1 < 0 ? 0 : iy1; }
  const c00 = tp[iy * tw + ix], c10 = tp[iy * tw + ix1], c01 = tp[iy1 * tw + ix], c11 = tp[iy1 * tw + ix1];
  const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
  TEX_SAMPLE[0] = (c00 & 255) * w00 + (c10 & 255) * w10 + (c01 & 255) * w01 + (c11 & 255) * w11;
  TEX_SAMPLE[1] = ((c00 >>> 8) & 255) * w00 + ((c10 >>> 8) & 255) * w10 + ((c01 >>> 8) & 255) * w01 + ((c11 >>> 8) & 255) * w11;
  TEX_SAMPLE[2] = ((c00 >>> 16) & 255) * w00 + ((c10 >>> 16) & 255) * w10 + ((c01 >>> 16) & 255) * w01 + ((c11 >>> 16) & 255) * w11;
  return TEX_SAMPLE;
}
