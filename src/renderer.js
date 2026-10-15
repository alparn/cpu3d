// Software renderer: the whole pipeline runs on the CPU and writes into a Uint32Array.
//
//   prepare       : culling, materials, motion, shadow maps -> a draw list (this file, on the calling thread)
//   vertex, raster: transform, clip and rasterize the draw list (raster.js)
//   shading       : AO, deferred lighting, atmosphere, accumulation or temporal AA (lighting.js)
//
// The canvas is only used at the very end to blit the finished frame (putImageData).
// With a RenderPool (setPool) everything after the draw list runs on several threads over shared memory.

import { mat4 } from './math.js';
import { buildToneLUT, buildInverseToneLUT, shadowBasis, shadowPlan, runShadowPlan, shadePass, accumulateRows, temporalRows, halton, SRGB_TO_LINEAR, WIRE_MATERIAL } from './lighting.js';
import { getTexture } from './textures.js';
import { PATTERN_ID } from './patterns.js';
import { RasterCore, vertexBuffers, vertexChunks, DRAW_FLOATS } from './raster.js';

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

// Lighting state of the frame (the fast path lights vertices with it, see raster.js).
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
    // prepMs: time on the calling thread to prepare the frame (draw list, shadow maps); ms: the whole frame
    this.stats = { meshes: 0, triangles: 0, drawn: 0, clipped: 0, pixels: 0, ms: 0, prepMs: 0 };
    this._tone = buildToneLUT(this.exposure);
    this._invTone = buildInverseToneLUT(this._tone);
    this._toneExposure = this.exposure;
    this._core = new RasterCore(); // geometry stages when rendering on this thread
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
    this.setSize(width, height);
  }

  // typed array, in shared memory when a worker pool renders the frames
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

  // Use a RenderPool (pool.js) for renderAsync; null goes back to rendering on the calling thread.
  setPool(pool) {
    const shared = !!pool;
    this.pool = pool;
    if (shared !== this._shared) {
      this._shared = shared;
      this._allocMaterials();
      this._tone = this._alloc(Float32Array, 65536);
      this._tone.set(buildToneLUT(this.exposure));
      this._vb = this._dm = null; // frame buffers of the geometry stages
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
      // canvas pixels cannot live in shared memory: render into shared buffers, copy at the end
      this.pixels = this.image.data;
      this.color = this._alloc(Uint32Array, w * h);
    } else {
      this.pixels = this.canvas ? this.image.data : this._shared ? new Uint8ClampedArray(new SharedArrayBuffer(w * h * 4)) : new Uint8ClampedArray(w * h * 4);
      this.color = new Uint32Array(this.pixels.buffer); // little-endian ABGR
    }
    this.depth = this._alloc(Float32Array, w * h); // stores 1/w, 0 = infinitely far
    this.width = w;
    this.height = h;
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

  // opts.accumulate: same view as the previous call -> add one more jittered sample to the
  // high-quality image (progressive anti-aliasing, soft shadows, smoother AO).
  // opts.temporal: the view or the scene moved -> blend with the reprojected previous frames (TAA).
  // Otherwise start over.
  render(scene, camera, opts = {}) {
    const ctx = this._begin(scene, camera, opts);
    const core = this._core;
    core.begin(ctx, null);
    for (const d of ctx.draws) core.vertices(d, 0, d.n);
    core.clear();
    for (const d of ctx.draws) core.triangles(d);
    ctx.rasterStats = core.stats;
    if (ctx.hq) {
      if (ctx.shadowPlan) runShadowPlan(ctx.shadowPlan);
      shadePass(ctx);
      this._post(ctx, 0, this.height);
    }
    return this._end(ctx);
  }

  // Same as render, with everything after the draw list spread over the pool's threads. Without a pool, or when
  // the pool fails, the frame is rendered on the calling thread (and the pool is no longer used).
  async renderAsync(scene, camera, opts = {}) {
    if (!this.pool) return this.render(scene, camera, opts);
    const ctx = this._begin(scene, camera, opts);
    try {
      await this.pool.frame(ctx);
    } catch (e) {
      console.warn('cpu3d: render threads failed, continuing on one thread:', e.message);
      // shadow maps this frame was drawing are incomplete: drop the shared ones
      for (const key of Object.keys(scene._shadow || {})) if (key.endsWith('-shared')) delete scene._shadow[key];
      this.setPool(null);
      return this.render(scene, camera, opts);
    }
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
    this._time = scene.time || 0; // animation time (wind)
    const draws = this._drawList(scene);
    // remember where every mesh was (also the culled ones), for the motion vectors of the next frame
    if (hq) for (const mesh of scene.meshes) {
      const prev = this._prevModel.get(mesh);
      if (prev) prev.set(mesh.matrix); else this._prevModel.set(mesh, Float64Array.from(mesh.matrix));
    }
    const job = {
      W, H, hq, depth: this.depth, color: this.color, draws, vb: this._vb, dm: this._dm, chunks: vertexChunks(draws),
      vp: Float64Array.from(this._vp), vlight: { ...L }, time: this._time, wireWidth: this.wireWidth, bg: scene.background ?? null,
    };
    if (!hq) {
      this.stats.prepMs = performance.now() - this._t0;
      return job;
    }

    const eye = camera.position;
    const F = norm3(sub3(camera.target, eye)), R = norm3(cross3(F, camera.up)), U = cross3(R, F);
    const tanY = Math.tan((camera.fov * Math.PI) / 360), viewDist = Math.hypot(...sub3(camera.target, eye));
    this._shadowTasks = [];
    const ctx = Object.assign(job, {
      NX: this._gNX, NY: this._gNY, NZ: this._gNZ, MAT: this._gMat,
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
      shadow: this.shadows ? this._shadowFor(scene, camera, [L.lx, L.ly, L.lz]) : null, // fills _shadowTasks
      shadowNear: this.shadows ? this._smNear : null,
      shadowTaps: this.shadowTaps,
      ao: this.ao ? { radius: Math.min(4, Math.max(0.08, viewDist * 0.045)), strength: this.aoStrength } : null,
      aoRaw: this._aoRaw, aoDepth: this._aoDepth, aoBlur: this._aoBlur,
      fog: L.fog ? { near: L.fn, far: L.ff, r: L.fr, g: L.fg, b: L.fb } : null,
      atmos: scene.atmosphere ? { ...scene.atmosphere, time: this._time } : null,
      debug: this.debug,
    });
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
    if (this._shadowTasks.length) ctx.shadowPlan = shadowPlan(this._shadowTasks, this._time, (T, n) => this._scratch(T, n));
    this._shadowTasks = null;
    this.stats.prepMs = performance.now() - this._t0;
    return ctx;
  }

  _end(ctx) {
    const st = this.stats, rs = ctx.rasterStats;
    if (rs) { st.drawn = rs.drawn; st.clipped = rs.clipped; st.pixels = rs.pixels; }
    if (ctx.hq) {
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
    this.samples = ctx.hq ? (ctx.post === 'accumulate' ? this._accN : this._histWeight) : 1;
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
    const casters = scene.meshes.filter((m) => m.visible && m.castShadow !== false);
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

  // Shadow drawing is not done here but collected in this._shadowTasks: the frame runs it (on the render threads
  // with a pool, before the lighting stage needs it).
  _cascade(scene, casters, name, L, center, radius) {
    const layout = `${L}|${center}|${radius}|${this.shadowSize}|${scene.staticVersion || 0}`;
    const alloc = (n) => this._alloc(Float32Array, n);
    const caches = (scene._shadow ??= {}), slot = `${name}-${this._shared ? 'shared' : 'local'}`;
    const dynamic = casters.filter((m) => m.dynamic), version = scene.version || 0, tasks = this._shadowTasks;
    let e = caches[slot];
    if (!e || e.layout !== layout) {
      e = caches[slot] = { layout, base: shadowBasis(L, center, radius, this.shadowSize, alloc), sm: null, version: null };
      tasks.push({ map: e.base, fill: 'clear', casters: casters.filter((m) => !m.dynamic) });
      if (dynamic.length) {
        // drawn from scratch in the same frame (it cannot start from a copy of a base that is drawn concurrently)
        e.sm = { ...e.base, depth: alloc(e.base.depth.length) };
        tasks.push({ map: e.sm, fill: 'clear', casters });
        e.version = version;
      }
    } else if (dynamic.length && (e.version !== version || !e.sm)) {
      e.sm ??= { ...e.base, depth: alloc(e.base.depth.length) };
      tasks.push({ map: e.sm, fill: e.base.depth, casters: dynamic });
      e.version = version;
    }
    return dynamic.length ? e.sm : e.base;
  }

  // reused scratch array per type (shared with a pool), sized up as needed: one live array per type and frame
  _scratch(Type, n) {
    const key = Type.name, cur = (this._scratchBufs ??= {})[key];
    if (cur && cur.length >= n && (cur.buffer instanceof ArrayBuffer) === !this._shared) return cur.subarray(0, n);
    const a = this._alloc(Type, Math.max(1024, Math.ceil(n * 1.25)));
    this._scratchBufs[key] = a;
    return a.subarray(0, n);
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

  // The draw list: one entry per visible mesh, with its matrices in a shared buffer (dm), its vertices at `base`
  // in the frame's vertex buffers and, in high quality, its material registered under `mat`.
  _drawList(scene) {
    const draws = [], hq = this._hq, st = this.stats;
    let verts = 0, matCount = 0;
    for (let k = 0; k < scene.meshes.length; k++) {
      const mesh = scene.meshes[k];
      if (!mesh.visible) continue;
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
      let outside = false;
      for (let i = 0; i < 24; i += 4) if (pl[i] * bx + pl[i + 1] * by + pl[i + 2] * bz + pl[i + 3] < -rad) { outside = true; break; }
      if (outside) continue;
      st.meshes++;
      st.triangles += geo.indices.length / 3;

      const flatMesh = this.shading === 'flat' || mesh.flat;
      // modes: 0 flat (fast), 1 gouraud (fast), 2 normals, 3 g-buffer (high quality)
      const mode = this.shading === 'normals' ? 2 : hq ? 3 : flatMesh ? 0 : 1;
      const wire = this.wireframe || mesh.wireframe;
      let [mr, mg, mb] = mesh.color;
      const pat = mesh.pattern, two = mesh.doubleSided;
      const texture = mesh.texture ? getTexture(mesh.texture, this.onTextureLoad) : null;
      if (!hq && texture) { mr *= texture.avg[0]; mg *= texture.avg[1]; mb *= texture.avg[2]; }
      if (!hq && pat) { const [a, b] = pat.colors; mr = (a[0] + b[0]) / 2; mg = (a[1] + b[1]) / 2; mb = (a[2] + b[2]) / 2; }
      const tex = hq ? texture : null;
      const nm = mat4.normalMatrix(this._nm, m);
      let mat = 0;
      if (hq) {
        const id = mat = matCount = Math.min(matCount + 1, WIRE_MATERIAL - 1);
        this._matSpec[id] = mesh.specular; this._matShin[id] = Math.max(1, mesh.shininess); this._matTwo[id] = two ? 1 : 0;
        this._matEmis[id] = mesh.emissive || 0;
        this._matMetal[id] = mesh.metalness || 0;
        this._matRough[id] = mesh.roughness ?? DEFAULT_ROUGHNESS;
        this._matMoving[id] = this._motionOf(mesh, id) ? 1 : 0;
        this._matMesh[id] = Math.min(65535, k + 1);
        this._matPat[id] = pat ? PATTERN_ID[pat.type] || 0 : 0;
        if (pat) {
          for (let c = 0; c < 3; c++) { const col = pat.colors[Math.min(c, pat.colors.length - 1)]; for (let q = 0; q < 3; q++) this._matPatC[id * 9 + c * 3 + q] = col[q] * 255; }
          this._matPatS[id] = pat.scale; this._matPatB[id] = pat.bump;
          this._matNM.set(nm, id * 9);
          const M3 = this._matM3, j = id * 9;
          M3[j] = m[0]; M3[j + 1] = m[1]; M3[j + 2] = m[2]; M3[j + 3] = m[4]; M3[j + 4] = m[5]; M3[j + 5] = m[6]; M3[j + 6] = m[8]; M3[j + 7] = m[9]; M3[j + 8] = m[10];
        }
      }
      draws.push({
        index: draws.length, k: draws.length * DRAW_FLOATS, geo, base: verts, n: geo.vertexCount, mode, flat: flatMesh, two,
        cull: this.cullBack && !two, wire: !!wire,
        wireCol: Array.isArray(wire) ? 0xff000000 | ((wire[2] * 255) << 16) | ((wire[1] * 255) << 8) | (wire[0] * 255) : 0,
        color: [mr, mg, mb], spec: mesh.specular, shin: mesh.shininess, emissive: mesh.emissive || 0, mat,
        tex, map: tex ? this._mapping(geo, mesh, m) : null, pat: hq && !!pat, obj: !!(tex || (hq && pat)), wind: mesh.wind || null,
        _m: m, _nm: Float64Array.from(nm),
      });
      verts += geo.vertexCount;
    }
    this._matCount = matCount;
    // frame buffers of the geometry stages (grown as needed; shared memory with a pool)
    if (!this._vb || this._vb.cap < verts) this._vb = vertexBuffers(Math.max(4096, Math.ceil(verts * 1.25)), (T, n) => this._alloc(T, n));
    if (!this._dm || this._dm.length < draws.length * DRAW_FLOATS) {
      const cap = Math.max(64, Math.ceil(draws.length * 1.5));
      this._dm = this._alloc(Float64Array, cap * DRAW_FLOATS);
    }
    const dm = this._dm;
    for (const d of draws) {
      dm.set(mat4.multiply(this._mvp, this._vp, d._m), d.k); dm.set(d._m, d.k + 16); dm.set(d._nm, d.k + 32);
      delete d._m; delete d._nm;
    }
    return draws;
  }

  // Texture mapping of a mesh (object space), evaluated per pixel by the raster stage:
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
    return {
      mode, ua: thin === 0 ? 2 : 0, va: thin === 1 ? 2 : 1, uflip: thin === 0, vflip: thin !== 1,
      min: [...geo.min], inv: ext.map((e) => 1 / (e || 1)), big: 1 / big, ru: mesh.repeat[0], rv: mesh.repeat[1],
      wrap: mode !== 0 || mesh.repeat[0] !== 1 || mesh.repeat[1] !== 1,
      c: [...geo.center], m3: [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]],
    };
  }
}

const DEFAULT_ROUGHNESS = 0.7; // materials without an explicit roughness reflect only faintly
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
