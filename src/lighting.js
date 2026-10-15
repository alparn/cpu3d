// Lighting for the high quality path:
//   - linear color space + ACES filmic tone mapping (via lookup tables)
//   - directional shadow map (orthographic depth render from the light, cached per scene)
//   - deferred shading pass: per-pixel Blinn-Phong, PCF shadows, screen-space ambient occlusion, fog
// Everything that is noisy (AA, soft shadow edges, AO) is jittered per frame and averaged by the
// renderer's progressive accumulation.

// ---------------------------------------------------------------- color
export const SRGB_TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

const TONE_SIZE = 65536, TONE_MAX = 16;
export const TONE_SCALE = (TONE_SIZE - 1) / TONE_MAX;
export const TONE_MAX_V = TONE_MAX, TONE_LAST = TONE_SIZE - 1;

// linear radiance -> display value 0..255 (ACES fit by Krzysztof Narkowicz, then sRGB encode)
export function buildToneLUT(exposure = 1) {
  const lut = new Float32Array(TONE_SIZE);
  for (let i = 0; i < TONE_SIZE; i++) {
    const x = (i / TONE_SCALE) * exposure;
    let t = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    lut[i] = 255 * (t <= 0.0031308 ? 12.92 * t : 1.055 * t ** (1 / 2.4) - 0.055);
  }
  return lut;
}

// Inverse of the tone curve for each display value 0..255: the radiance that tone maps back to it.
// Emissive surfaces use it so that emissive = 1 reproduces their color (or texture) exactly on screen.
export function buildInverseToneLUT(tone) {
  const inv = new Float32Array(256);
  for (let v = 0, i = 0; v < 256; v++) {
    while (i < tone.length - 1 && tone[i] < v) i++;
    inv[v] = i / TONE_SCALE;
  }
  return inv;
}

// low-discrepancy sequence for jitter (base 2 / base 3), in [0, 1)
export function halton(i, b) {
  let f = 1, r = 0;
  for (i += 1; i > 0; i = Math.floor(i / b)) { f /= b; r += f * (i % b); }
  return r;
}

// ---------------------------------------------------------------- shadow map
// Orthographic depth render from the light. Stores "closeness" = dot(p, L) (L points to the light),
// so the standard "greater wins" depth test keeps the surface nearest to the light.
export function buildShadowMap(meshes, L, center, radius, size, alloc = (n) => new Float32Array(n)) {
  const up = Math.abs(L[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  // basis: R, U span the shadow map plane, L is the depth axis
  let R = [up[1] * L[2] - up[2] * L[1], up[2] * L[0] - up[0] * L[2], up[0] * L[1] - up[1] * L[0]];
  const rl = Math.hypot(...R);
  R = R.map((v) => v / rl);
  const U = [L[1] * R[2] - L[2] * R[1], L[2] * R[0] - L[0] * R[2], L[0] * R[1] - L[1] * R[0]];
  const scale = size / (2 * radius);
  const ox = R[0] * center[0] + R[1] * center[1] + R[2] * center[2] - radius;
  const oy = U[0] * center[0] + U[1] * center[1] + U[2] * center[2] - radius;
  const sm = { depth: alloc(size * size).fill(-Infinity), size, R, U, L, ox, oy, scale };
  drawShadowCasters(sm, meshes);
  return sm;
}

// Adds meshes to an existing shadow map (moving objects on top of the cached static ones).
export function drawShadowCasters(sm, meshes) {
  const { depth, size, R, U, L, ox, oy, scale } = sm, s16 = scale * 16;
  for (const mesh of meshes) {
    if (mesh.castShadow === false) continue;
    const g = mesh.geometry, m = mesh.matrix, P = g.positions, I = g.indices, n = P.length / 3;
    const X = new Int32Array(n), Y = new Int32Array(n), Z = new Float32Array(n);
    for (let v = 0, k = 0; v < n; v++, k += 3) {
      const x = P[k], y = P[k + 1], z = P[k + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      X[v] = Math.round((R[0] * wx + R[1] * wy + R[2] * wz - ox) * s16);
      Y[v] = Math.round((U[0] * wx + U[1] * wy + U[2] * wz - oy) * s16);
      Z[v] = L[0] * wx + L[1] * wy + L[2] * wz;
    }
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      rasterDepth(depth, size, X[a], Y[a], Z[a], X[b], Y[b], Z[b], X[c], Y[c], Z[c]);
    }
  }
}

// Depth-only triangle rasterizer (same sub-pixel edge functions as the main rasterizer, no culling).
function rasterDepth(depth, S, x0, y0, z0, x1, y1, z1, x2, y2, z2) {
  let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (area === 0) return;
  if (area < 0) {
    let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; t = z1; z1 = z2; z2 = t;
    area = -area;
  }
  let minX = Math.ceil((Math.min(x0, x1, x2) - 8) / 16), maxX = Math.floor((Math.max(x0, x1, x2) - 8) / 16);
  let minY = Math.ceil((Math.min(y0, y1, y2) - 8) / 16), maxY = Math.floor((Math.max(y0, y1, y2) - 8) / 16);
  if (minX < 0) minX = 0;
  if (minY < 0) minY = 0;
  if (maxX > S - 1) maxX = S - 1;
  if (maxY > S - 1) maxY = S - 1;
  if (minX > maxX || minY > maxY) return;
  const A0 = (y1 - y2) * 16, B0 = (x2 - x1) * 16, C0 = (x2 - x1) * (8 - y1) - (y2 - y1) * (8 - x1);
  const A1 = (y2 - y0) * 16, B1 = (x0 - x2) * 16, C1 = (x0 - x2) * (8 - y2) - (y0 - y2) * (8 - x2);
  const A2 = (y0 - y1) * 16, B2 = (x1 - x0) * 16, C2 = (x1 - x0) * (8 - y0) - (y1 - y0) * (8 - x0);
  const k = 16 / area, ey1 = y1 - y0, ey2 = y2 - y0, ex1 = x1 - x0, ex2 = x2 - x0;
  const zdx = ((z1 - z0) * ey2 - (z2 - z0) * ey1) * k, zdy = ((z2 - z0) * ex1 - (z1 - z0) * ex2) * k;
  const zb = z0 + zdx * (0.5 - x0 / 16) + zdy * (0.5 - y0 / 16);
  let q;
  for (let py = minY; py <= maxY; py++) {
    const e0 = B0 * py + C0, e1 = B1 * py + C1, e2 = B2 * py + C2;
    let xs = minX, xe = maxX;
    if (A0 > 0) { q = Math.ceil(-e0 / A0); if (q > xs) xs = q; } else if (A0 < 0) { q = Math.floor(e0 / -A0); if (q < xe) xe = q; } else if (e0 < 0) continue;
    if (A1 > 0) { q = Math.ceil(-e1 / A1); if (q > xs) xs = q; } else if (A1 < 0) { q = Math.floor(e1 / -A1); if (q < xe) xe = q; } else if (e1 < 0) continue;
    if (A2 > 0) { q = Math.ceil(-e2 / A2); if (q > xs) xs = q; } else if (A2 < 0) { q = Math.floor(e2 / -A2); if (q < xe) xe = q; } else if (e2 < 0) continue;
    let i = py * S + xs, z = zb + zdx * xs + zdy * py;
    for (const end = py * S + xe; i <= end; i++, z += zdx) if (z > depth[i]) depth[i] = z;
  }
}

// ---------------------------------------------------------------- environment (reflections)
// 'sky'   : the background gradient as a sky dome over a darker ground
// 'studio': a dark photo studio with softboxes (product shots: glass and metal live from these)
// Rough surfaces see softer softbox edges, so blurry reflections need no prefiltered maps.
const softbox = (dir, w, h, intensity) => {
  const l = Math.hypot(...dir), d = dir.map((v) => v / l);
  const ref = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  let r = [ref[1] * d[2] - ref[2] * d[1], ref[2] * d[0] - ref[0] * d[2], ref[0] * d[1] - ref[1] * d[0]];
  const rl = Math.hypot(...r);
  r = r.map((v) => v / rl);
  const u = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
  return { d, r, u, w, h, I: intensity };
};
const STUDIO = [
  softbox([-0.55, 0.75, 0.55], 0.5, 0.32, 6),   // key, front left above
  softbox([0.95, 0.2, -0.25], 0.1, 0.85, 7),    // tall strip right (rim on the frame)
  softbox([-0.95, 0.15, -0.35], 0.09, 0.85, 4), // tall strip left
  softbox([0.05, 1, 0.1], 0.55, 0.55, 2.5),     // overhead
  softbox([0.35, 0.25, 1], 0.38, 0.12, 1.6),    // low front strip (glints on screens)
  softbox([-0.25, 0.75, -0.6], 0.5, 0.28, 3.2),  // high back: what flat parts reflect when seen from above
];
let er = 0, eg = 0, eb = 0; // env() result, linear radiance

function env(type, sky, dx, dy, dz, rough) {
  if (type === 'studio') {
    // dark walls above, a light grey studio floor below the horizon (metals need something to reflect)
    let g;
    if (dy >= 0) g = 0.012 + 0.03 * dy;
    else { const k = Math.min(1, -dy / (0.08 + rough * 0.5)); g = 0.012 + (0.11 - 0.012) * k; }
    er = eg = eb = g;
    const soft = 0.025 + rough * 0.9, peak = 1 / (1 + rough * 2.5);
    for (let i = 0; i < STUDIO.length; i++) {
      const b = STUDIO[i], cd = dx * b.d[0] + dy * b.d[1] + dz * b.d[2];
      if (cd < 0.05) continue;
      const a = Math.abs((dx * b.r[0] + dy * b.r[1] + dz * b.r[2]) / cd), c = Math.abs((dx * b.u[0] + dy * b.u[1] + dz * b.u[2]) / cd);
      let wa = (b.w - a) / soft + 0.5, wc = (b.h - c) / soft + 0.5;
      if (wa <= 0 || wc <= 0) continue;
      if (wa > 1) wa = 1;
      if (wc > 1) wc = 1;
      const v = b.I * wa * wc * peak;
      er += v; eg += v * 0.98; eb += v * 0.95;
    }
    return;
  }
  // sky dome from the background colors (linear), ground darker; roughness softens the horizon
  const t = dy;
  if (t >= 0) {
    const k = Math.sqrt(t);
    er = sky.br + (sky.tr - sky.br) * k; eg = sky.bg + (sky.tg - sky.bg) * k; eb = sky.bb + (sky.tb - sky.bb) * k;
  } else {
    let k = -t / (0.06 + rough * 0.6);
    if (k > 1) k = 1;
    const gr = sky.br * 0.25, gg = sky.bg * 0.25, gb = sky.bb * 0.25;
    er = sky.br + (gr - sky.br) * k; eg = sky.bg + (gg - sky.bg) * k; eb = sky.bb + (gb - sky.bb) * k;
  }
}

const spec16 = (t) => { if (t <= 0) return 0; t *= t; t *= t; t *= t; return t * t; };

// cheap per-pixel hash in [0, 1) for jittering rough reflections
const hash = (x, y, f) => {
  let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(f + 1, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

// ---------------------------------------------------------------- deferred shading
export const WIRE_MATERIAL = 0xffff;
const AO_SAMPLES = 8;

// Per-frame rotated sample kernels for SSAO (4x4 interleaved rotations).
function aoKernels(frame) {
  const out = [];
  const base = frame * 2.399963; // golden angle per frame
  for (let p = 0; p < 16; p++) {
    const k = new Float32Array(AO_SAMPLES * 2), rot = base + (p * Math.PI * 2) / 16;
    for (let s = 0; s < AO_SAMPLES; s++) {
      const a = rot + s * 2.399963, r = Math.sqrt((s + 0.5) / AO_SAMPLES);
      k[s * 2] = Math.cos(a) * r;
      k[s * 2 + 1] = Math.sin(a) * r;
    }
    out.push(k);
  }
  return out;
}

// ---------------------------------------------------------------- staged shading
// The pass is split into stages that work on row ranges, so they can run on several threads
// (see pool.js / shade-worker.js) or one after the other (shadePass):
//   1. aoRows      SSAO at half resolution, block rows [b0, b1)
//   2. blurRows    depth-aware blur of the AO, block rows [b0, b1)   (needs all of stage 1)
//      shadeRows   lighting of pixel rows [2*b0, 2*b1)               (needs its own blurred rows)
//   3. postRows    progressive accumulation or temporal anti-aliasing (needs all of stage 2)
// Buffers in ctx are typed arrays (shared memory when threads are used); prepare() derives the
// per-frame tables each thread needs.

export function prepare(ctx) {
  if (ctx._prep) return ctx._prep;
  const { W, H, tanX, tanY, jx, jy, ao, frame } = ctx;
  const colK = new Float32Array(W), rowK = new Float32Array(H);
  for (let x = 0; x < W; x++) colK[x] = (((x + 0.5) / W) * 2 - 1 - jx) * tanX;
  for (let y = 0; y < H; y++) rowK[y] = (1 - ((y + 0.5) / H) * 2 - jy) * tanY;
  return (ctx._prep = { colK, rowK, kernels: ao ? aoKernels(frame) : null, aoW: (W + 1) >> 1, aoH: (H + 1) >> 1 });
}

// ---- 1. SSAO at half resolution: one value per 2x2 block, taken from a pixel that changes every frame,
// so progressive accumulation still converges to full resolution
export function aoRows(ctx, b0, b1) {
  const { W, H, depth, NX, NY, NZ, MAT, matTwo, R, U, F, tanY, ao, frame, aoRaw, aoDepth } = ctx;
  const { colK, rowK, kernels, aoW } = prepare(ctx);
  const aoR = ao.radius, aoR2 = aoR * aoR, aoStr = ao.strength;
  const focal = H / (2 * tanY), aoMaxPx = Math.max(8, H * 0.08);
  const fx = frame & 1, fy = (frame >> 1) & 1;
  for (let by = b0; by < b1; by++) {
    const y = Math.min(H - 1, by * 2 + fy), ry = rowK[y];
    for (let bx = 0; bx < aoW; bx++) {
      const bi = by * aoW + bx, x = Math.min(W - 1, bx * 2 + fx), i = y * W + x, iw = depth[i];
      aoRaw[bi] = 1;
      if (iw === 0) { aoDepth[bi] = 0; continue; }
      const w = 1 / iw, radPx = Math.min(aoMaxPx, (aoR * focal) / w);
      aoDepth[bi] = w;
      if (radPx <= 1.5) continue;
      const vx = colK[x] * w, vy = ry * w, vz = w;
      let nx = NX[i], ny = NY[i], nz = NZ[i];
      const nl = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      nx *= nl; ny *= nl; nz *= nl;
      if (matTwo[MAT[i]] && nx * (R[0] * vx + U[0] * vy + F[0] * vz) + ny * (R[1] * vx + U[1] * vy + F[1] * vz) + nz * (R[2] * vx + U[2] * vy + F[2] * vz) > 0) {
        nx = -nx; ny = -ny; nz = -nz;
      }
      const nvx = nx * R[0] + ny * R[1] + nz * R[2], nvy = nx * U[0] + ny * U[1] + nz * U[2], nvz = nx * F[0] + ny * F[1] + nz * F[2];
      const ker = kernels[((by & 3) << 2) | (bx & 3)];
      let occ = 0;
      for (let s = 0; s < AO_SAMPLES * 2; s += 2) {
        const sx = (x + ker[s] * radPx) | 0, sy = (y - ker[s + 1] * radPx) | 0;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const siw = depth[sy * W + sx];
        if (siw === 0) continue;
        const sw = 1 / siw;
        const ox = colK[sx] * sw - vx, oy = rowK[sy] * sw - vy, oz = sw - vz;
        const vv = ox * ox + oy * oy + oz * oz;
        if (vv > aoR2 || vv < 1e-10) continue;
        const vn = (ox * nvx + oy * nvy + oz * nvz) / Math.sqrt(vv);
        if (vn > 0.15) occ += (vn - 0.15) * (1 - vv / aoR2);
      }
      let o = 1 - (aoStr * occ) / AO_SAMPLES;
      if (o < 0) o = 0;
      aoRaw[bi] = o * o; // stronger contrast in creases, almost no effect on open surfaces
    }
  }
}

// ---- 2a. 4x4 box blur over the half-resolution AO (matches the 4x4 kernel rotation pattern), skipping
// neighbours at a clearly different depth so occlusion does not bleed across silhouettes.
export function blurRows(ctx, b0, b1) {
  const { aoRaw: src, aoDepth: depth, aoBlur: out } = ctx, { aoW: W, aoH: H } = prepare(ctx);
  for (let y = b0; y < b1; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, d = depth[i];
      if (d === 0) { out[i] = 1; continue; }
      const tol = d * 0.06;
      let sum = 0, n = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 2); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 2); xx++) {
          const j = yy * W + xx, dj = depth[j];
          if (dj !== 0 && Math.abs(dj - d) < tol) { sum += src[j]; n++; }
        }
      }
      out[i] = n ? sum / n : src[i];
    }
  }
}

// ---- 2b. lighting of pixel rows [y0, y1)
export function shadeRows(ctx, y0, y1) {
  const { W, depth, color, NX, NY, NZ, MAT, matSpec, matShin, matTwo, matEmis, matMetal, matRough, lights, environment, softness, invTone, eye, R, U, F,
    light, tone, shadow, frame, ao, fog, debug, aoBlur } = ctx;
  const { colK, rowK, aoW } = prepare(ctx);
  const { lx, ly, lz, lr, lg, lb, sr, sg, sb, gr, gg, gb } = light;
  const S2L = SRGB_TO_LINEAR;

  // shadow map setup
  const sm = shadow, smS = sm ? sm.size : 0, smD = sm ? sm.depth : null;
  // soft shadows: the PCF sample point wanders over a disc that grows with the light's softness
  const pen = 1 + (softness || 0) * 22;
  const texel = sm ? 1 / sm.scale : 0, smJu = (halton(frame, 2) - 0.5) * pen, smJv = (halton(frame, 3) - 0.5) * pen;
  const envType = environment ? environment.type : 'none', sky = environment ? environment.sky : null;
  const extra = lights || [], nExtra = extra.length;
  const aoBuf = ao ? aoBlur : null;

  const fogOn = !!fog, fn = fog ? fog.near : 0, fspan = fog ? Math.max(1e-6, fog.far - fog.near) : 1;
  const fr = fog ? fog.r : 0, fg = fog ? fog.g : 0, fb = fog ? fog.b : 0;

  for (let y = y0; y < y1; y++) {
    const ry = rowK[y], row = y * W;
    for (let x = 0; x < W; x++) {
      const i = row + x, iw = depth[i];
      if (iw === 0) continue;
      const mat = MAT[i];
      if (mat === WIRE_MATERIAL) continue; // already final color

      // view space position (right, up, forward) and world position
      const w = 1 / iw, vx = colK[x] * w, vy = ry * w, vz = w;
      const dx = R[0] * vx + U[0] * vy + F[0] * vz, dy = R[1] * vx + U[1] * vy + F[1] * vz, dz = R[2] * vx + U[2] * vy + F[2] * vz;
      const px = eye[0] + dx, py = eye[1] + dy, pz = eye[2] + dz;
      const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const Vx = -dx / dist, Vy = -dy / dist, Vz = -dz / dist;

      let nx = NX[i], ny = NY[i], nz = NZ[i];
      const nl = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      nx *= nl; ny *= nl; nz *= nl;
      if (nx * Vx + ny * Vy + nz * Vz < 0 && matTwo[mat]) { nx = -nx; ny = -ny; nz = -nz; }

      const c = color[i];
      const ar = S2L[c & 255], ag = S2L[(c >>> 8) & 255], ab = S2L[(c >>> 16) & 255];

      // ambient occlusion: half-resolution buffer, nearest lookup
      const occl = aoBuf ? aoBuf[(y >> 1) * aoW + (x >> 1)] : 1;

      if (debug === 'ao') { const v = occl * 255; color[i] = 0xff000000 | (v << 16) | (v << 8) | v; continue; }

      // emissive surfaces (screens, lamps) are dark emitters: they do not also scatter light diffusely
      const emis = matEmis[mat], metal = matMetal[mat], rough = matRough[mat], kd = (1 - metal) * (emis >= 1 ? 0 : 1 - emis);
      // highlight color: white for dielectrics, the albedo for metals
      const scr = 1 + (ar - 1) * metal, scg = 1 + (ag - 1) * metal, scb = 1 + (ab - 1) * metal;

      // hemisphere ambient (diffuse only)
      const hemi = ny * 0.5 + 0.5;
      let r = ar * kd * (gr + (sr - gr) * hemi) * occl;
      let g = ag * kd * (gg + (sg - gg) * hemi) * occl;
      let b = ab * kd * (gb + (sb - gb) * hemi) * occl;

      const shin = matShin[mat], specK = matSpec[mat], specCut = 1 - 16 / shin; // below that the curve is 0
      // sun
      const ndl = nx * lx + ny * ly + nz * lz;
      if (ndl > 0) {
        let vis = 1;
        if (sm) {
          // normal offset reduces acne on surfaces at grazing angles
          const off = texel * 1.5;
          const qx = px + nx * off, qy = py + ny * off, qz = pz + nz * off;
          const u = (sm.R[0] * qx + sm.R[1] * qy + sm.R[2] * qz - sm.ox) * sm.scale - 0.5 + smJu;
          const v = (sm.U[0] * qx + sm.U[1] * qy + sm.U[2] * qz - sm.oy) * sm.scale - 0.5 + smJv;
          const u0 = Math.floor(u), v0 = Math.floor(v);
          if (u0 >= 0 && v0 >= 0 && u0 < smS - 1 && v0 < smS - 1) {
            // depth bias grows with the PCF disc and the surface slope towards the light (no acne on soft shadows)
            const slope = Math.sqrt(Math.max(0, 1 - ndl * ndl)) / Math.max(ndl, 0.08);
            const d = sm.L[0] * qx + sm.L[1] * qy + sm.L[2] * qz + texel * (1 + 0.6 * pen * Math.min(slope, 8));
            const fu = u - u0, fv = v - v0, k = v0 * smS + u0;
            const t00 = d >= smD[k] ? 1 : 0, t10 = d >= smD[k + 1] ? 1 : 0;
            const t01 = d >= smD[k + smS] ? 1 : 0, t11 = d >= smD[k + smS + 1] ? 1 : 0;
            vis = (t00 * (1 - fu) + t10 * fu) * (1 - fv) + (t01 * (1 - fu) + t11 * fu) * fv;
          }
        }
        if (vis > 0) {
          const hx = lx + Vx, hy = ly + Vy, hz = lz + Vz;
          const ndh = (nx * hx + ny * hy + nz * hz) / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
          // pow(ndh, shin) ~ exp(shin * (ndh - 1)) ~ (1 + shin * (ndh - 1) / 16)^16: four multiplies,
          // accurate near the peak and exactly zero in the tail (no haze on glossy surfaces)
          const sp = ndh > specCut ? specK * spec16(1 + shin * (ndh - 1) * 0.0625) : 0;
          r += (ar * kd * ndl + sp * scr) * lr * vis;
          g += (ag * kd * ndl + sp * scg) * lg * vis;
          b += (ab * kd * ndl + sp * scb) * lb * vis;
        }
      }
      // extra lights (fill, rim): no shadows
      for (let e = 0; e < nExtra; e++) {
        const el = extra[e], nd = nx * el.x + ny * el.y + nz * el.z;
        if (nd <= 0) continue;
        const hx = el.x + Vx, hy = el.y + Vy, hz = el.z + Vz;
        const ndh = (nx * hx + ny * hy + nz * hz) / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
        const sp = ndh > specCut ? specK * spec16(1 + shin * (ndh - 1) * 0.0625) : 0;
        r += (ar * kd * nd + sp * scr) * el.r; g += (ag * kd * nd + sp * scg) * el.g; b += (ab * kd * nd + sp * scb) * el.b;
      }

      // environment reflection with Fresnel; rough surfaces jitter the direction (averaged over frames)
      // matte dielectrics (most default materials) reflect so little that it is not worth computing
      if (envType !== 'none' && (rough <= 0.6 || metal > 0)) {
        const ndv = Math.max(1e-3, nx * Vx + ny * Vy + nz * Vz);
        let rx = 2 * ndv * nx - Vx, ry = 2 * ndv * ny - Vy, rz = 2 * ndv * nz - Vz;
        if (rough > 0.02 && frame > 0) {
          const j = rough * rough * 0.6;
          rx += (hash(x, y, frame) - 0.5) * j; ry += (hash(y, x, frame) - 0.5) * j; rz += (hash(x + y, x, frame) - 0.5) * j;
          const rl = 1 / Math.sqrt(rx * rx + ry * ry + rz * rz);
          rx *= rl; ry *= rl; rz *= rl;
        }
        env(envType, sky, rx, ry, rz, rough);
        // split-sum environment BRDF, analytic fit (Karis / Lazarov): F = f0 * A + B, roughness-aware at grazing angles
        const c0 = 1 - rough, c1 = 0.0425 - 0.0275 * rough, c2 = 1.04 - 0.572 * rough, c3 = 0.022 * rough - 0.04;
        const a004 = Math.min(c0 * c0, Math.exp(-6.4325 * ndv)) * c0 + c1, A = c2 - 1.04 * a004, Bf = 1.04 * a004 + c3; // exp(x ln2) = 2^x
        const f0r = 0.04 + (ar - 0.04) * metal, f0g = 0.04 + (ag - 0.04) * metal, f0b = 0.04 + (ab - 0.04) * metal;
        r += er * (f0r * A + Bf) * occl; g += eg * (f0g * A + Bf) * occl; b += eb * (f0b * A + Bf) * occl;
      }

      if (emis > 0) { r += invTone[c & 255] * emis; g += invTone[(c >>> 8) & 255] * emis; b += invTone[(c >>> 16) & 255] * emis; }

      // tone map, then fog in display space so it matches the background exactly
      let R8 = tone[r >= TONE_MAX_V ? TONE_LAST : (r * TONE_SCALE) | 0];
      let G8 = tone[g >= TONE_MAX_V ? TONE_LAST : (g * TONE_SCALE) | 0];
      let B8 = tone[b >= TONE_MAX_V ? TONE_LAST : (b * TONE_SCALE) | 0];
      if (fogOn) {
        let f = (dist - fn) / fspan;
        if (f > 0) {
          if (f > 1) f = 1;
          R8 += (fr - R8) * f; G8 += (fg - G8) * f; B8 += (fb - B8) * f;
        }
      }
      color[i] = 0xff000000 | ((B8 | 0) << 16) | ((G8 | 0) << 8) | (R8 | 0);
    }
  }
}

// ---- 3. post: running average of jittered frames (progressive refinement of a still image).
// acc holds display-space sums; accN is the sample count after adding this frame (1 = start over).
// seedHist / seedW: start the sum from the temporal history, counted as seedW samples.
export function accumulateRows(ctx, y0, y1) {
  const { W, color: c, acc, accN: n, seedHist: sh, seedW } = ctx, inv = 1 / n;
  const i0 = y0 * W, i1 = y1 * W;
  if (n === 1) {
    for (let i = i0, k = i0 * 3; i < i1; i++, k += 3) { const v = c[i]; acc[k] = v & 255; acc[k + 1] = (v >>> 8) & 255; acc[k + 2] = (v >>> 16) & 255; }
    return;
  }
  if (sh) for (let k = i0 * 3, e = i1 * 3; k < e; k++) acc[k] = sh[k] * seedW;
  for (let i = i0, k = i0 * 3; i < i1; i++, k += 3) {
    const v = c[i];
    const r = (acc[k] += v & 255), g = (acc[k + 1] += (v >>> 8) & 255), b = (acc[k + 2] += (v >>> 16) & 255);
    c[i] = 0xff000000 | (((b * inv + 0.5) | 0) << 16) | (((g * inv + 0.5) | 0) << 8) | ((r * inv + 0.5) | 0);
  }
}

// ---- 3. post: temporal anti-aliasing for moving images (camera moves, animation).
// Each pixel is reprojected into the previous frame with the previous (unjittered) view-projection,
// the history is clamped to the 3x3 neighbourhood of the current frame (no ghosting on moving or
// uncovered parts) and blended in. Jitter, AO and soft shadow noise average out over ~10 frames.
// histPrev / histNext: Float32 rgb in display space; prevVP / currVP: unjittered view-projections;
// taa.valid = false starts over.
export function temporalRows(ctx, y0, y1) {
  const { colK, rowK } = prepare(ctx);
  // one call per row: V8 optimizes the row function as a whole instead of on-stack replacing inner loops
  for (let y = y0; y < y1; y++) taaRow(ctx, colK, rowK[y], y);
}

function taaRow(ctx, colK, ry, y) {
  const { W, H, depth, color: c, eye, R, U, F, taa } = ctx;
  const { prevVP: M, currVP: Q, histPrev: hp, histNext: hn, valid, alpha } = taa;
  {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, v = c[i], k = i * 3;
      const cr = v & 255, cg = (v >>> 8) & 255, cb = (v >>> 16) & 255;
      let a = 1, hr = 0, hg = 0, hb = 0;
      const iw = depth[i];
      if (valid) {
        // where was this surface (or, for the background, this view direction) in the previous frame?
        let wx, wy, wz, ww;
        const w = iw === 0 ? 1e4 : 1 / iw, vx = colK[x] * w, vy = ry * w;
        const dx = R[0] * vx + U[0] * vy + F[0] * w, dy = R[1] * vx + U[1] * vy + F[1] * w, dz = R[2] * vx + U[2] * vy + F[2] * w;
        if (iw === 0) { wx = dx; wy = dy; wz = dz; ww = 0; } else { wx = eye[0] + dx; wy = eye[1] + dy; wz = eye[2] + dz; ww = 1; }
        const cx = M[0] * wx + M[4] * wy + M[8] * wz + M[12] * ww, cy = M[1] * wx + M[5] * wy + M[9] * wz + M[13] * ww;
        const cw = M[3] * wx + M[7] * wy + M[11] * wz + M[15] * ww;
        const qx = Q[0] * wx + Q[4] * wy + Q[8] * wz + Q[12] * ww, qy = Q[1] * wx + Q[5] * wy + Q[9] * wz + Q[13] * ww;
        const qw = Q[3] * wx + Q[7] * wy + Q[11] * wz + Q[15] * ww;
        if (cw > 1e-6 && qw > 1e-6) {
          // motion = unjittered position then minus unjittered position now; applied to the pixel center,
          // so a still image samples the history exactly (no blur from the jitter)
          const px = x + ((cx / cw - qx / qw) * 0.5) * W, py = y - ((cy / cw - qy / qw) * 0.5) * H;
          const x0 = Math.floor(px), y0h = Math.floor(py);
          if (x0 >= 1 && y0h >= 1 && x0 < W - 2 && y0h < H - 2) {
            // Catmull-Rom (bicubic) history sample: bilinear would blur the image a bit more every frame
            const fx = px - x0, fy = py - y0h;
            const ax = crw(fx), ay = crw(fy);
            hr = 0; hg = 0; hb = 0;
            for (let m = 0; m < 4; m++) {
              const wy = ay[m], j = ((y0h - 1 + m) * W + x0 - 1) * 3;
              const w0 = ax[0] * wy, w1 = ax[1] * wy, w2 = ax[2] * wy, w3 = ax[3] * wy;
              hr += hp[j] * w0 + hp[j + 3] * w1 + hp[j + 6] * w2 + hp[j + 9] * w3;
              hg += hp[j + 1] * w0 + hp[j + 4] * w1 + hp[j + 7] * w2 + hp[j + 10] * w3;
              hb += hp[j + 2] * w0 + hp[j + 5] * w1 + hp[j + 8] * w2 + hp[j + 11] * w3;
            }
            // neighbourhood clamp: min / max of the 3x3 pixels around (unrolled, borders repeat)
            const rm = (y > 0 ? y - 1 : y) * W, r0 = y * W, rp = (y < H - 1 ? y + 1 : y) * W, xm = x > 0 ? x - 1 : x, xp = x < W - 1 ? x + 1 : x;
            // variance clipping: mean +- 1.25 standard deviations of the 3x3 neighbourhood (tighter than min / max)
            let sr = cr, sg = cg, sb = cb, qr = cr * cr, qg = cg * cg, qb = cb * cb, u = 0, t = 0;
            u = c[rm + xm]; t = u & 255; sr += t; qr += t * t; t = (u >>> 8) & 255; sg += t; qg += t * t; t = (u >>> 16) & 255; sb += t; qb += t * t;
            u = c[rm + x]; t = u & 255; sr += t; qr += t * t; t = (u >>> 8) & 255; sg += t; qg += t * t; t = (u >>> 16) & 255; sb += t; qb += t * t;
            u = c[rm + xp]; t = u & 255; sr += t; qr += t * t; t = (u >>> 8) & 255; sg += t; qg += t * t; t = (u >>> 16) & 255; sb += t; qb += t * t;
            u = c[r0 + xm]; t = u & 255; sr += t; qr += t * t; t = (u >>> 8) & 255; sg += t; qg += t * t; t = (u >>> 16) & 255; sb += t; qb += t * t;
            u = c[r0 + xp]; t = u & 255; sr += t; qr += t * t; t = (u >>> 8) & 255; sg += t; qg += t * t; t = (u >>> 16) & 255; sb += t; qb += t * t;
            u = c[rp + xm]; t = u & 255; sr += t; qr += t * t; t = (u >>> 8) & 255; sg += t; qg += t * t; t = (u >>> 16) & 255; sb += t; qb += t * t;
            u = c[rp + x]; t = u & 255; sr += t; qr += t * t; t = (u >>> 8) & 255; sg += t; qg += t * t; t = (u >>> 16) & 255; sb += t; qb += t * t;
            u = c[rp + xp]; t = u & 255; sr += t; qr += t * t; t = (u >>> 8) & 255; sg += t; qg += t * t; t = (u >>> 16) & 255; sb += t; qb += t * t;
            const mr = sr / 9, mg = sg / 9, mb = sb / 9;
            const dr = 1.25 * Math.sqrt(Math.max(0, qr / 9 - mr * mr)) + 2, dg = 1.25 * Math.sqrt(Math.max(0, qg / 9 - mg * mg)) + 2, db = 1.25 * Math.sqrt(Math.max(0, qb / 9 - mb * mb)) + 2;
            hr = hr < mr - dr ? mr - dr : hr > mr + dr ? mr + dr : hr;
            hg = hg < mg - dg ? mg - dg : hg > mg + dg ? mg + dg : hg;
            hb = hb < mb - db ? mb - db : hb > mb + db ? mb + db : hb;
            // fast motion: trust the new frame more (resampling the history blurs a little every frame)
            const speed = Math.abs(px - x) + Math.abs(py - y);
            a = alpha + (speed > 8 ? 0.4 : speed * 0.05);
            if (a > 1) a = 1;
          }
        }
      }
      const r = hr + (cr - hr) * a, g = hg + (cg - hg) * a, b = hb + (cb - hb) * a;
      hn[k] = r; hn[k + 1] = g; hn[k + 2] = b;
      c[i] = 0xff000000 | (((b + 0.5) | 0) << 16) | (((g + 0.5) | 0) << 8) | ((r + 0.5) | 0);
    }
  }
}

// Catmull-Rom weights for the 4 taps around a sample at fraction t (two reused arrays: x and y)
const CRW = [new Float64Array(4), new Float64Array(4)];
let crwSlot = 0;
function crw(t) {
  const w = CRW[(crwSlot ^= 1)], t2 = t * t, t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
  return w;
}

// All stages on the calling thread.
export function shadePass(ctx) {
  const { aoH } = prepare(ctx);
  if (ctx.ao) { aoRows(ctx, 0, aoH); blurRows(ctx, 0, aoH); }
  shadeRows(ctx, 0, ctx.H);
}
