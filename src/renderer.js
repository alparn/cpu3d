// Software rasterizer: the whole pipeline runs on the CPU and writes into a Uint32Array.
//
//   vertex stage  : model/view/projection, per-vertex lighting (Gouraud), outcodes
//   primitive     : trivial reject, homogeneous clipping (near/far + guard band), back-face cull
//   raster        : half-space edge functions on a 1/16 sub-pixel grid with top-left fill rule,
//                   exact per-row span solving (no wasted pixel tests), 1/w depth buffer
//
// The canvas is only used at the very end to blit the finished frame (putImageData).
// With a worker pool (setPool) the per-pixel shading runs on several threads over shared memory.

import { mat4 } from './math.js';
import { buildToneLUT, buildInverseToneLUT, buildShadowMap, drawShadowCasters, shadePass, accumulateRows, temporalRows, halton, SRGB_TO_LINEAR, TONE_SCALE, TONE_MAX_V, TONE_LAST, WIRE_MATERIAL } from './lighting.js';
import { getTexture } from './textures.js';
import { PATTERN_ID } from './patterns.js';

const GUARD = 8; // guard band (in NDC units): only triangles crossing it are clipped in x/y
const NEAR = 1, FAR = 2, LEFT = 4, RIGHT = 8, BOTTOM = 16, TOP = 32;
const PLANES = [NEAR, FAR, LEFT, RIGHT, BOTTOM, TOP];
const STRIDE = 13; // clip vertex: x y z w r g b nx ny nz ox oy oz (object-space position for textures and patterns)

export class Mesh {
  constructor(geometry, { color = [0.8, 0.8, 0.8], specular = 0.25, shininess = 24, doubleSided = false, emissive = 0,
    position = [0, 0, 0], rotation = [0, 0, 0], scale = 1, metalness = 0, roughness, texture = null, mapping = 'planar', repeat = 1, pattern = null } = {}) {
    this.geometry = geometry;
    this.color = color;
    this.specular = specular;
    this.shininess = shininess;
    this.doubleSided = doubleSided;
    this.emissive = emissive; // self-illumination: adds color * emissive, independent of lights and shadows
    this.metalness = metalness; // 0 dielectric .. 1 metal (colored reflections, no diffuse)
    this.roughness = roughness; // 0 mirror .. 1 matte; undefined = matte default
    this.texture = texture;     // texture src (see textures.js)
    this.mapping = mapping;     // how the texture wraps: 'planar' (thinnest axis), 'box', 'cylinder' (around Y), 'sphere'
    this.repeat = typeof repeat === 'number' ? [repeat, repeat] : repeat; // tiles across the mapping
    this.pattern = pattern;     // procedural pattern { type, colors: [[r,g,b] 0..1, ...], scale, bump } (patterns.js)
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
  fog: false, fn: 0, ff: 1, fr: 0, fg: 0, fb: 0, // fog color in display units (0..255)
  tone: null, invTone: null,
  r: 0, g: 0, b: 0,
};
const S2L = SRGB_TO_LINEAR;
const lin = (c) => S2L[c >= 1 ? 255 : c <= 0 ? 0 : (c * 255 + 0.5) | 0];

// Per-vertex lighting for the fast path: hemisphere ambient + Lambert + Blinn-Phong in linear light,
// ACES tone mapping, then fog in display space. Material colors are sRGB 0..1. Result in L.r/g/b (0..255).
function shade(nx, ny, nz, px, py, pz, cr, cg, cb, spec, shin, twoSided, emissive = 0) {
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

export class Renderer {
  constructor({ width = 640, height = 480, canvas = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.shading = 'gouraud'; // 'flat' | 'gouraud' | 'normals'
    this.wireframe = false;
    this.wireWidth = 0.75; // pixels
    this.cullBack = true;
    this.fog = true;
    // 'high': deferred per-pixel lighting, shadows, ambient occlusion, progressive anti-aliasing
    // 'fast': per-vertex lighting (Gouraud), single pass
    this.quality = 'high';
    this.shadows = true;
    this.ao = true;
    this.aoStrength = 3.2;
    this.sunIntensity = 1.4; // linear light units; tone mapping maps them back to display range
    this.skyIntensity = 1;
    this.shadowSize = 2048;
    this.exposure = 1;
    this.samples = 0; // accumulated samples of the current high-quality image
    this.stats = { meshes: 0, triangles: 0, drawn: 0, clipped: 0, pixels: 0, ms: 0 };
    this._tone = buildToneLUT(this.exposure);
    this._invTone = buildInverseToneLUT(this._tone);
    this._toneExposure = this.exposure;
    this._tv = new Float64Array(36); // 3 vertices x [x, y, 1/w, nx/w, ny/w, nz/w, r, g, b, ox/w, oy/w, oz/w]
    this._fn = new Float64Array(3);
    this.pool = null;
    this._shared = false;
    this._allocMaterials();
    this.shadowTaps = 1; // soft shadow samples per pixel in temporal frames (rotated per pixel)
    this.temporalMotion = [0.12, 0.12]; // weight of the new frame for moving pixels: base + per pixel of motion
    this.temporalAlpha = 0.035; // smallest weight of a new frame in temporal anti-aliasing (more while things move)
    this.onTextureLoad = null; // called when a texture finished loading (the editor redraws)
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

  // typed array, in shared memory when a worker pool shades the frames
  _alloc(Type, n) {
    return this._shared ? new Type(new SharedArrayBuffer(n * Type.BYTES_PER_ELEMENT)) : new Type(n);
  }

  _allocMaterials() {
    this._matSpec = this._alloc(Float32Array, 65536);
    this._matShin = this._alloc(Float32Array, 65536);
    this._matTwo = this._alloc(Uint8Array, 65536);
    this._matEmis = this._alloc(Float32Array, 65536);
    this._matMetal = this._alloc(Float32Array, 65536);
    this._matRough = this._alloc(Float32Array, 65536);
    // per-mesh motion for temporal AA: world(now) -> world(previous frame) as a 3x4 matrix, flagged when moving
    this._matMotion = this._alloc(Float32Array, 65536 * 12);
    this._matMoving = this._alloc(Uint8Array, 65536);
    this._matMesh = this._alloc(Uint16Array, 65536); // draw id -> stable mesh number (index in the scene + 1)
    // procedural patterns: type, three colors (sRGB 0..255), scale, bump, object -> world normal matrix and model 3x3
    this._matPat = this._alloc(Uint8Array, 65536);
    this._matPatC = this._alloc(Float32Array, 65536 * 9);
    this._matPatS = this._alloc(Float32Array, 65536);
    this._matPatB = this._alloc(Float32Array, 65536);
    this._matNM = this._alloc(Float32Array, 65536 * 9);
    this._matM3 = this._alloc(Float32Array, 65536 * 9);
    this._prevModel = new WeakMap(); // mesh -> model matrix of the previous frame of this renderer
  }

  // Use a ShadePool (pool.js) for renderAsync; null goes back to single-threaded rendering.
  setPool(pool) {
    const shared = !!pool;
    this.pool = pool;
    if (shared !== this._shared) {
      this._shared = shared;
      this._allocMaterials();
      this._tone = this._alloc(Float32Array, 65536);
      this._tone.set(buildToneLUT(this.exposure));
      this.setSize(this.width, this.height);
    }
    return this;
  }

  setSize(width, height) {
    const w = Math.max(1, width | 0), h = Math.max(1, height | 0);
    if (this.canvas) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.image = this.ctx.createImageData(w, h);
    }
    if (this.canvas && this._shared) {
      // canvas pixels cannot live in shared memory: shade into shared buffers, copy at the end
      this.pixels = this.image.data;
      this.color = this._alloc(Uint32Array, w * h);
    } else {
      this.pixels = this.canvas ? this.image.data : this._shared ? new Uint8ClampedArray(new SharedArrayBuffer(w * h * 4)) : new Uint8ClampedArray(w * h * 4);
      this.color = new Uint32Array(this.pixels.buffer); // little-endian ABGR
    }
    this.depth = this._alloc(Float32Array, w * h); // stores 1/w, 0 = infinitely far
    this.width = w;
    this.height = h;
    this._bgKey = '';
    this._gNX = null; // G-buffer and accumulation buffer are allocated on first high-quality frame
    this._acc = null;
    this._accN = 0;
  }

  _ensureGBuffer() {
    const n = this.width * this.height;
    if (this._gNX && this._gNX.length === n) return;
    const A = (T, k) => this._alloc(T, k);
    this._gNX = A(Float32Array, n); this._gNY = A(Float32Array, n); this._gNZ = A(Float32Array, n);
    this._gMat = A(Uint16Array, n);
    this._gOX = A(Float32Array, n); this._gOY = A(Float32Array, n); this._gOZ = A(Float32Array, n); // object position (patterns)
    this._acc = A(Float32Array, n * 3);
    const ao = ((this.width + 1) >> 1) * ((this.height + 1) >> 1);
    this._aoRaw = A(Float32Array, ao); this._aoDepth = A(Float32Array, ao); this._aoBlur = A(Float32Array, ao);
    this._hist = [A(Float32Array, n * 3), A(Float32Array, n * 3)]; // temporal history (ping-pong)
    this._age = [A(Uint8Array, n), A(Uint8Array, n)]; // frames each history pixel has been tracked
    this._histMat = [A(Uint16Array, n), A(Uint16Array, n)]; // which mesh each history pixel showed
    this._taaOut = A(Uint32Array, n); // temporal AA result (the pass reads this frame's colors around each pixel)
    this._ycc = A(Float32Array, n * 3); // this frame in YCoCg, written by the shading stage for the TAA statistics
    this._histWeight = 0; // how many frames the history roughly represents (0 = none)
    this._prevVP = new Float64Array(16);
    this._accN = 0;
  }

  _reserve(n) {
    if (n <= this._cap) return;
    const c = Math.max(n, this._cap * 2);
    this._x = new Int32Array(c); this._y = new Int32Array(c); this._z = new Float64Array(c);
    this._cx = new Float64Array(c); this._cy = new Float64Array(c); this._cz = new Float64Array(c); this._cw = new Float64Array(c);
    this._wx = new Float32Array(c); this._wy = new Float32Array(c); this._wz = new Float32Array(c);
    this._r = new Float32Array(c); this._g = new Float32Array(c); this._b = new Float32Array(c);
    this._vnx = new Float32Array(c); this._vny = new Float32Array(c); this._vnz = new Float32Array(c);
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

  // opts.accumulate: same view as the previous call -> add one more jittered sample to the
  // high-quality image (progressive anti-aliasing, soft shadows, smoother AO).
  // opts.temporal: the view or the scene moved -> blend with the reprojected previous frames (TAA).
  // Otherwise start over.
  render(scene, camera, opts = {}) {
    const ctx = this._begin(scene, camera, opts);
    if (ctx) {
      shadePass(ctx);
      this._post(ctx, 0, this.height);
    }
    return this._end(ctx);
  }

  // Same as render, with the shading spread over the worker pool (falls back to render without one).
  async renderAsync(scene, camera, opts = {}) {
    if (!this.pool) return this.render(scene, camera, opts);
    const ctx = this._begin(scene, camera, opts);
    if (ctx) await this.pool.shade(ctx);
    return this._end(ctx);
  }

  // stage 3 on one thread (the pool runs the same functions per row range)
  _post(ctx, y0, y1) {
    if (ctx.post === 'accumulate') accumulateRows(ctx, y0, y1);
    else temporalRows(ctx, y0, y1);
  }

  _begin(scene, camera, opts) {
    this._t0 = performance.now();
    const st = this.stats;
    st.meshes = st.triangles = st.drawn = st.clipped = st.pixels = 0;
    st.shadeMs = 0;
    const W = this.width, H = this.height;
    const hq = this.quality === 'high' && this.shading !== 'normals';
    if (hq) this._ensureGBuffer();
    // jitter index: progressive samples count up, temporal frames cycle through 16 positions
    const accumulate = hq && opts.accumulate && (this._accN > 0 || this._histWeight > 0);
    const temporal = hq && !accumulate && opts.temporal;
    let frame = 0;
    if (accumulate) frame = this._accN > 0 ? this._accN : this._histWeight;
    else if (temporal) frame = (this._taaFrame = ((this._taaFrame || 0) % 16) + 1);
    const jx = frame ? ((halton(frame, 2) - 0.5) * 2) / W : 0, jy = frame ? ((halton(frame, 3) - 0.5) * 2) / H : 0;
    this._clear(scene.background);

    mat4.perspective(this._proj, (camera.fov * Math.PI) / 180, W / H, camera.near, camera.far);
    const unjittered = hq ? mat4.multiply(new Float64Array(16), this._proj, mat4.lookAt(this._view, camera.position, camera.target, camera.up)) : null;
    this._proj[8] -= jx; // sub-pixel jitter: shifts geometry by (jx, jy) in NDC
    this._proj[9] -= jy;
    mat4.lookAt(this._view, camera.position, camera.target, camera.up);
    mat4.multiply(this._vp, this._proj, this._view);
    this._extractPlanes();

    if (this.exposure !== this._toneExposure) {
      const lut = buildToneLUT(this.exposure);
      if (this._shared) this._tone.set(lut); else this._tone = lut;
      this._invTone = buildInverseToneLUT(this._tone);
      this._toneExposure = this.exposure;
    }
    L.invTone = this._invTone;
    const light = scene.light ?? {};
    const d = light.direction ?? [0.5, 0.9, 0.35], dl = Math.hypot(d[0], d[1], d[2]) || 1;
    const lc = light.color ?? [1, 1, 1], sky = light.sky ?? [0.3, 0.32, 0.38], gnd = light.ground ?? [0.1, 0.09, 0.08];
    L.lx = d[0] / dl; L.ly = d[1] / dl; L.lz = d[2] / dl;
    const li = light.intensity ?? 1;
    [L.lr, L.lg, L.lb] = lc.map((c) => lin(c) * this.sunIntensity * li);
    [L.sr, L.sg, L.sb] = sky.map((c) => c * this.skyIntensity);
    [L.gr, L.gg, L.gb] = gnd.map((c) => c * this.skyIntensity);
    [L.ex, L.ey, L.ez] = camera.position;
    L.tone = this._tone;
    const fog = scene.fog;
    L.fog = !!(fog && this.fog);
    if (L.fog) {
      L.fn = fog.near; L.ff = fog.far;
      const fc = fog.color ?? scene.background?.bottom ?? [0.25, 0.27, 0.3];
      L.fr = fc[0] * 255; L.fg = fc[1] * 255; L.fb = fc[2] * 255;
    }

    this._hq = hq;
    this._matCount = 0;
    for (let k = 0; k < scene.meshes.length; k++) {
      const mesh = scene.meshes[k];
      this._meshNo = Math.min(65535, k + 1);
      if (mesh.visible) this._drawMesh(mesh);
    }
    // remember where every mesh was (also the culled ones), for the motion vectors of the next frame
    if (hq) for (const mesh of scene.meshes) {
      const prev = this._prevModel.get(mesh);
      if (prev) prev.set(mesh.matrix); else this._prevModel.set(mesh, Float64Array.from(mesh.matrix));
    }
    this._rasterMs = performance.now() - this._t0;
    if (!hq) return null;

    const eye = camera.position;
    const F = norm3(sub3(camera.target, eye)), R = norm3(cross3(F, camera.up)), U = cross3(R, F);
    const tanY = Math.tan((camera.fov * Math.PI) / 360), viewDist = Math.hypot(...sub3(camera.target, eye));
    const ctx = {
      W, H, depth: this.depth, color: this.color, NX: this._gNX, NY: this._gNY, NZ: this._gNZ, MAT: this._gMat,
      matSpec: this._matSpec, matShin: this._matShin, matTwo: this._matTwo, matEmis: this._matEmis,
      matMetal: this._matMetal, matRough: this._matRough,
      OX: this._gOX, OY: this._gOY, OZ: this._gOZ, matPat: this._matPat, matPatC: this._matPatC, matPatS: this._matPatS, matPatB: this._matPatB,
      matNM: this._matNM, matM3: this._matM3,
      lights: (scene.lights || []).map((x) => {
        const dd = x.direction, ll = Math.hypot(dd[0], dd[1], dd[2]) || 1, k = this.sunIntensity * (x.intensity ?? 0.5);
        return { x: dd[0] / ll, y: dd[1] / ll, z: dd[2] / ll, r: lin(x.color[0]) * k, g: lin(x.color[1]) * k, b: lin(x.color[2]) * k };
      }),
      environment: this._environment(scene),
      softness: light.softness ?? 0.1,
      invTone: this._invTone,
      eye: [...eye], R, U, F, tanX: tanY * (W / H), tanY, jx, jy, frame, light: { ...L, tone: undefined, invTone: undefined }, tone: this._tone,
      shadow: this.shadows ? this._shadowFor(scene, camera, [L.lx, L.ly, L.lz]) : null,
      shadowNear: this.shadows ? this._smNear : null,
      shadowTaps: this.shadowTaps,
      ao: this.ao ? { radius: Math.min(4, Math.max(0.08, viewDist * 0.045)), strength: this.aoStrength } : null,
      aoRaw: this._aoRaw, aoDepth: this._aoDepth, aoBlur: this._aoBlur,
      fog: L.fog ? { near: L.fn, far: L.ff, r: L.fr, g: L.fg, b: L.fb } : null,
      debug: this.debug,
    };
    if (accumulate) {
      // the first refinement sample starts from the temporal history (no quality drop when motion stops)
      const seed = this._accN === 0;
      ctx.post = 'accumulate';
      ctx.acc = this._acc;
      ctx.seedHist = seed ? this._hist[0] : null;
      ctx.seedW = seed ? this._histWeight : 0;
      ctx.accN = seed ? this._histWeight + 1 : this._accN + 1;
    } else {
      const valid = temporal && this._histWeight > 0;
      ctx.post = 'temporal';
      ctx.taa = { prevVP: this._prevVP, currVP: unjittered, histPrev: this._hist[0], histNext: this._hist[1], valid, alpha: this.temporalAlpha,
        motion: this._matMotion, moving: this._matMoving, meshOf: this._matMesh, agePrev: this._age[0], ageNext: this._age[1],
        matPrev: this._histMat[0], matNext: this._histMat[1], out: this._taaOut, ycc: this._ycc,
        cameraStill: this._prevVP.every((v, k) => v === unjittered[k]), motionBase: this.temporalMotion[0], motionSlope: this.temporalMotion[1] };
      this._histWeight = valid ? Math.min(8, this._histWeight + 1) : 1;
      this._nextVP = unjittered;
    }
    this._shadeT0 = performance.now();
    return ctx;
  }

  _end(ctx) {
    const st = this.stats;
    if (ctx) {
      st.shadeMs = performance.now() - this._shadeT0;
      if (ctx.post === 'accumulate') this._accN = ctx.accN;
      else {
        this.color.set(this._taaOut);
        this._hist.reverse(); // the history just written becomes the previous one
        this._age.reverse();
        this._histMat.reverse();
        this._prevVP.set(this._nextVP);
        this._accN = 0;
      }
    }
    this.samples = ctx ? (ctx.post === 'accumulate' ? this._accN : this._histWeight) : 1;
    st.ms = performance.now() - this._t0;
    if (this.canvas) {
      if (this.color.buffer !== this.pixels.buffer) new Uint32Array(this.pixels.buffer).set(this.color);
      this.ctx.putImageData(this.image, 0, 0);
    }
    return this;
  }

  // Motion of a mesh since the previous frame, as D = prev * inverse(now) in _matMotion[id]; false if it did not move.
  _motionOf(mesh, id) {
    const p = this._prevModel.get(mesh), m = mesh.matrix;
    if (!p) return false;
    let same = true;
    for (let i = 0; i < 16; i++) if (p[i] !== m[i]) { same = false; break; }
    if (same) return false;
    // inverse of the affine model matrix (upper 3x3 by cofactors, then the translation)
    const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], k = m[10];
    const A = e * k - f * h, B = f * g - d * k, C = d * h - e * g, det = a * A + b * B + c * C;
    if (!det) return false;
    const id_ = 1 / det;
    const i00 = A * id_, i01 = (c * h - b * k) * id_, i02 = (b * f - c * e) * id_;
    const i10 = B * id_, i11 = (a * k - c * g) * id_, i12 = (c * d - a * f) * id_;
    const i20 = C * id_, i21 = (b * g - a * h) * id_, i22 = (a * e - b * d) * id_;
    const tx = -(i00 * m[12] + i01 * m[13] + i02 * m[14]), ty = -(i10 * m[12] + i11 * m[13] + i12 * m[14]), tz = -(i20 * m[12] + i21 * m[13] + i22 * m[14]);
    // D = P * inv(M), rows of the 3x4 result
    const o = this._matMotion, j = id * 12;
    for (let r = 0; r < 3; r++) {
      const p0 = p[r], p1 = p[4 + r], p2 = p[8 + r], p3 = p[12 + r];
      o[j + r * 4] = p0 * i00 + p1 * i10 + p2 * i20;
      o[j + r * 4 + 1] = p0 * i01 + p1 * i11 + p2 * i21;
      o[j + r * 4 + 2] = p0 * i02 + p1 * i12 + p2 * i22;
      o[j + r * 4 + 3] = p0 * tx + p1 * ty + p2 * tz + p3;
    }
    return true;
  }

  // Reflection environment: type + linear sky colors from the background gradient.
  _environment(scene) {
    const type = this.reflections === false ? 'none' : scene.reflections || 'sky';
    const top = scene.background?.top ?? [0.1, 0.11, 0.14], bottom = scene.background?.bottom ?? [0.25, 0.27, 0.3];
    return { type, sky: { tr: lin(top[0]), tg: lin(top[1]), tb: lin(top[2]), br: lin(bottom[0]), bg: lin(bottom[1]), bb: lin(bottom[2]) } };
  }

  // Shadow maps: a main map around the area of interest and, when that is much larger than what the camera
  // looks at, a detail map around the view center (two cascades; the shader uses the detail map where it
  // covers a point). Meshes marked `dynamic` (animated, dragged) stay out of a cached base map per cascade;
  // when the scene's `version` changes only they are drawn again, on a copy of it. The cache lives on the
  // scene, so renderers drawing the same scene share it. `staticVersion` invalidates the bases.
  _shadowFor(scene, camera, L) {
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const casters = scene.meshes.filter((m) => m.visible);
    for (const mesh of casters) {
      const g = mesh.geometry, m = mesh.matrix, c = g.center;
      const s = Math.sqrt(Math.max(m[0] ** 2 + m[1] ** 2 + m[2] ** 2, m[4] ** 2 + m[5] ** 2 + m[6] ** 2, m[8] ** 2 + m[9] ** 2 + m[10] ** 2));
      const r = g.radius * s;
      const w = [m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12], m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13], m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14]];
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], w[a] - r); max[a] = Math.max(max[a], w[a] + r); }
    }
    if (!casters.length) { this._smNear = null; return null; }
    // sizes in steps of 1.25, kept while they still fit (hysteresis): a camera move that changes the size back
    // and forth would make every shadow jump in resolution
    const keep = (scene._shadowSize ??= {});
    const quant = (name, r) => {
      const last = keep[name];
      if (last && r <= last && r > last / 1.6) return last;
      return (keep[name] = 1.25 ** Math.ceil(Math.log(r) / Math.log(1.25)));
    };
    const snap = (c, step) => c.map((v) => Math.round(v / step) * step);
    let center = [0, 1, 2].map((a) => (min[a] + max[a]) / 2), radius = Math.hypot(...sub3(max, min)) / 2;
    const dist = Math.hypot(...sub3(camera.target, camera.position));
    const focus = Math.min(400, Math.max(4, dist * 1.6));
    if (radius > focus) { center = [...camera.target]; radius = focus; }
    radius = quant('main', radius);
    const main = this._cascade(scene, casters, 'main', L, snap(center, radius / 16), radius);
    // detail cascade: about what the camera sees around its target. Only with fairly hard light: a wide
    // penumbra (soft light) blurs away the extra resolution anyway
    const penTexels = 1 + (scene.light?.softness ?? 0.1) * 22;
    const near = quant('near', Math.max(0.05, dist * Math.tan((camera.fov * Math.PI) / 360) * 1.15));
    this._smNear = penTexels < 4.5 && near < radius * 0.6 ? this._cascade(scene, casters, 'near', L, snap(camera.target, near / 8), near) : null;
    return main;
  }

  _cascade(scene, casters, name, L, center, radius) {
    const layout = `${L}|${center}|${radius}|${this.shadowSize}|${scene.staticVersion || 0}`;
    const alloc = (n) => this._alloc(Float32Array, n);
    const caches = (scene._shadow ??= {}), slot = `${name}-${this._shared ? 'shared' : 'local'}`;
    let e = caches[slot];
    if (!e || e.layout !== layout) {
      e = caches[slot] = { layout, base: buildShadowMap(casters.filter((m) => !m.dynamic), L, center, radius, this.shadowSize, alloc), sm: null, version: null };
    }
    const dynamic = casters.filter((m) => m.dynamic);
    if (!dynamic.length) return e.base;
    if (e.version !== (scene.version || 0) || !e.sm) {
      e.sm ??= { ...e.base, depth: alloc(e.base.depth.length) };
      e.sm.depth.set(e.base.depth);
      drawShadowCasters(e.sm, dynamic);
      e.version = scene.version || 0;
    }
    return e.sm;
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
    this._P = P;
    const X = this._x, Y = this._y, Z = this._z, CX = this._cx, CY = this._cy, CZ = this._cz, CW = this._cw;
    const WX = this._wx, WY = this._wy, WZ = this._wz, R = this._r, G = this._g, B = this._b, OC = this._oc;
    const W8 = this.width * 8, H8 = this.height * 8; // NDC -> 1/16 sub-pixel units
    const hq = this._hq, flatMesh = this.shading === 'flat' || mesh.flat;
    // modes: 0 flat (fast), 1 gouraud (fast), 2 normals, 3 g-buffer (high quality)
    const mode = this.shading === 'normals' ? 2 : hq ? 3 : flatMesh ? 0 : 1;
    const wire = this.wireframe || mesh.wireframe;
    this._wire = !!wire;
    this._wireCol = Array.isArray(wire)
      ? 0xff000000 | ((wire[2] * 255) << 16) | ((wire[1] * 255) << 8) | (wire[0] * 255) : 0;
    let [mr, mg, mb] = mesh.color;
    const spec = mesh.specular, shin = mesh.shininess, two = mesh.doubleSided;
    const pat = mesh.pattern;
    if (!this._hq && mesh.texture) {
      const t = getTexture(mesh.texture, this.onTextureLoad);
      if (t) { mr *= t.avg[0]; mg *= t.avg[1]; mb *= t.avg[2]; }
    }
    if (!this._hq && pat) { const [a, b] = pat.colors; mr = (a[0] + b[0]) / 2; mg = (a[1] + b[1]) / 2; mb = (a[2] + b[2]) / 2; }
    const VNX = this._vnx, VNY = this._vny, VNZ = this._vnz;
    const tex = mesh.texture ? getTexture(mesh.texture, this.onTextureLoad) : null;
    this._tex = hq ? tex : null;
    this._pat = hq && !!pat;
    this._obj = !!(this._tex || this._pat); // the raster stage needs the object position per pixel
    if (this._tex) this._mapping(geo, mesh, m);
    if (hq) {
      const id = this._matCount = Math.min(this._matCount + 1, WIRE_MATERIAL - 1);
      this._mat = id;
      this._matSpec[id] = spec; this._matShin[id] = Math.max(1, shin); this._matTwo[id] = two ? 1 : 0;
      this._matEmis[id] = mesh.emissive || 0;
      this._matMetal[id] = mesh.metalness || 0;
      this._matRough[id] = mesh.roughness ?? DEFAULT_ROUGHNESS;
      this._flatHQ = flatMesh;
      this._matMoving[id] = this._motionOf(mesh, id) ? 1 : 0;
      this._matMesh[id] = this._meshNo;
      this._matPat[id] = pat ? PATTERN_ID[pat.type] || 0 : 0;
      if (pat) {
        for (let c = 0; c < 3; c++) { const col = pat.colors[Math.min(c, pat.colors.length - 1)]; for (let q = 0; q < 3; q++) this._matPatC[id * 9 + c * 3 + q] = col[q] * 255; }
        this._matPatS[id] = pat.scale; this._matPatB[id] = pat.bump;
        this._matNM.set(nm, id * 9);
        const M3 = this._matM3, j = id * 9;
        M3[j] = m[0]; M3[j + 1] = m[1]; M3[j + 2] = m[2]; M3[j + 3] = m[4]; M3[j + 4] = m[5]; M3[j + 5] = m[6]; M3[j + 6] = m[8]; M3[j + 7] = m[9]; M3[j + 8] = m[10];
      }
    }

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
        if (mode === 3) {
          VNX[v] = nx; VNY[v] = ny; VNZ[v] = nz;
          const cr = VC ? VC[k] : mr, cg = VC ? VC[k + 1] : mg, cb = VC ? VC[k + 2] : mb;
          R[v] = cr >= 1 ? 255 : cr * 255; G[v] = cg >= 1 ? 255 : cg * 255; B[v] = cb >= 1 ? 255 : cb * 255;
        } else if (mode === 2) {
          R[v] = (nx * 0.5 + 0.5) * 255; G[v] = (ny * 0.5 + 0.5) * 255; B[v] = (nz * 0.5 + 0.5) * 255;
        } else {
          if (VC) shade(nx, ny, nz, wx, wy, wz, VC[k], VC[k + 1], VC[k + 2], spec, shin, two, mesh.emissive);
          else shade(nx, ny, nz, wx, wy, wz, mr, mg, mb, spec, shin, two, mesh.emissive);
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
        if (mode === 3) {
          const T = this._tv, fn = this._fn;
          if (flatMesh) this._faceNormal(a, b, c2);
          let o = 0;
          for (const v of [a, b, c2]) {
            const iw = Z[v];
            T[o] = X[v]; T[o + 1] = Y[v]; T[o + 2] = iw;
            T[o + 3] = (flatMesh ? fn[0] : VNX[v]) * iw; T[o + 4] = (flatMesh ? fn[1] : VNY[v]) * iw; T[o + 5] = (flatMesh ? fn[2] : VNZ[v]) * iw;
            T[o + 6] = R[v]; T[o + 7] = G[v]; T[o + 8] = B[v];
            if (this._obj) { T[o + 9] = P[v * 3] * iw; T[o + 10] = P[v * 3 + 1] * iw; T[o + 11] = P[v * 3 + 2] * iw; }
            else { T[o + 9] = 0; T[o + 10] = 0; T[o + 11] = 0; }
            o += 12;
          }
          this._rasterG();
        } else if (mode === 0) {
          this._faceColor(a, b, c2, mesh);
          const r = L.r, g = L.g, bl = L.b;
          this._raster(x0, y0, Z[a], r, g, bl, x1, y1, Z[b], r, g, bl, x2, y2, Z[c2], r, g, bl);
        } else {
          this._raster(x0, y0, Z[a], R[a], G[a], B[a], x1, y1, Z[b], R[b], G[b], B[b], x2, y2, Z[c2], R[c2], G[c2], B[c2]);
        }
      } else {
        if (mode === 0) this._faceColor(a, b, c2, mesh);
        if (mode === 3 && flatMesh) this._faceNormal(a, b, c2);
        this._clip(a, b, c2, oa | ob | oc);
      }
    }
  }

  // World-space face normal into this._fn (flat meshes in the high quality path).
  _faceNormal(a, b, c) {
    const WX = this._wx, WY = this._wy, WZ = this._wz, fn = this._fn;
    const ux = WX[b] - WX[a], uy = WY[b] - WY[a], uz = WZ[b] - WZ[a];
    const vx = WX[c] - WX[a], vy = WY[c] - WY[a], vz = WZ[c] - WZ[a];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const il = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
    fn[0] = nx * il; fn[1] = ny * il; fn[2] = nz * il;
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
      mr, mg, mb, mesh.specular, mesh.shininess, mesh.doubleSided, mesh.emissive);
  }

  // Sutherland-Hodgman in homogeneous clip space, only against the planes that are actually crossed.
  _clip(a, b, c, codes) {
    let inp = this._clipA, out = this._clipB, n = 3;
    const flat = this._flat, idx = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const v = idx[i], o = i * STRIDE;
      inp[o] = this._cx[v]; inp[o + 1] = this._cy[v]; inp[o + 2] = this._cz[v]; inp[o + 3] = this._cw[v];
      inp[o + 4] = flat ? L.r : this._r[v]; inp[o + 5] = flat ? L.g : this._g[v]; inp[o + 6] = flat ? L.b : this._b[v];
      if (this._hq) {
        const fl = this._flatHQ, fn = this._fn;
        inp[o + 7] = fl ? fn[0] : this._vnx[v]; inp[o + 8] = fl ? fn[1] : this._vny[v]; inp[o + 9] = fl ? fn[2] : this._vnz[v];
        const Pp = this._P;
        inp[o + 10] = this._obj ? Pp[v * 3] : 0; inp[o + 11] = this._obj ? Pp[v * 3 + 1] : 0; inp[o + 12] = this._obj ? Pp[v * 3 + 2] : 0;
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
    this.stats.clipped++;
    const W8 = this.width * 8, H8 = this.height * 8;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE, iw = 1 / inp[o + 3];
      inp[o] = Math.round(inp[o] * iw * W8 + W8);
      inp[o + 1] = Math.round(H8 - inp[o + 1] * iw * H8);
      inp[o + 2] = iw;
    }
    if (this._hq) {
      const T = this._tv;
      for (let i = 1; i < n - 1; i++) {
        let o = 0;
        for (const p of [0, i * STRIDE, (i + 1) * STRIDE]) {
          const iw = inp[p + 2];
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

  // Texture mapping of the current mesh (object space):
  //   planar   along the thinnest local axis (flat in Z -> u = x, v = y, top = +Y; flat in Y -> u = x, v = z,
  //            top = -Z; flat in X -> u = -z, v = y), stretched over the bounds once
  //   box      projected along all three axes and blended by the surface direction (no stretching on any shape)
  //   cylinder wrapped around the local Y axis (labels on bottles and cans)
  //   sphere   longitude / latitude (balls, globes)
  // repeat tiles the image; with repeat > 1 or a wrapping mode the image repeats seamlessly.
  _mapping(geo, mesh, m) {
    const ext = [0, 1, 2].map((a) => geo.max[a] - geo.min[a]);
    const thin = ext[2] <= ext[0] && ext[2] <= ext[1] ? 2 : ext[1] <= ext[0] ? 1 : 0;
    const mode = { planar: 0, box: 1, cylinder: 2, sphere: 3 }[mesh.mapping] ?? 0;
    const big = Math.max(...ext) || 1;
    this._map = {
      mode, ua: thin === 0 ? 2 : 0, va: thin === 1 ? 2 : 1, uflip: thin === 0, vflip: thin !== 1,
      min: geo.min, inv: ext.map((e) => 1 / (e || 1)), big: 1 / big, ru: mesh.repeat[0], rv: mesh.repeat[1],
      wrap: mode !== 0 || mesh.repeat[0] !== 1 || mesh.repeat[1] !== 1,
      c: geo.center, m3: [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]],
    };
  }

  // texel (sRGB 0..255) at object point o with world normal n -> TEX_SAMPLE
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
    const W = this.width, H = this.height;
    let minX = Math.ceil((Math.min(x0, x1, x2) - 8) / 16), maxX = Math.floor((Math.max(x0, x1, x2) - 8) / 16);
    let minY = Math.ceil((Math.min(y0, y1, y2) - 8) / 16), maxY = Math.floor((Math.max(y0, y1, y2) - 8) / 16);
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > W - 1) maxX = W - 1;
    if (maxY > H - 1) maxY = H - 1;
    if (minX > maxX || minY > maxY) return;
    this.stats.drawn++;

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
    const k = 16 / area, ex1 = x1 - x0, ey1 = y1 - y0, ex2 = x2 - x0, ey2 = y2 - y0;
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

    const depth = this.depth, color = this.color, NX = this._gNX, NY = this._gNY, NZ = this._gNZ, MAT = this._gMat;
    const mat = this._mat, wire = this._wire, wireCol = this._wireCol, LW = this.wireWidth;
    const tex = this._tex, obj = this._obj, pat = this._pat, OX = this._gOX, OY = this._gOY, OZ = this._gOZ, TS = TEX_SAMPLE;
    const n0 = wire ? 1 / Math.hypot(A0, B0) : 0, n1 = wire ? 1 / Math.hypot(A1, B1) : 0, n2 = wire ? 1 / Math.hypot(A2, B2) : 0;
    let pix = 0, q;
    for (let py = minY; py <= maxY; py++) {
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

const PL = new Float64Array(36); // attribute plane scratch for _rasterG
const DEFAULT_ROUGHNESS = 0.7; // materials without an explicit roughness reflect only faintly
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

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
