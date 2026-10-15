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

// low-discrepancy sequence for jitter (base 2 / base 3), in [0, 1)
export function halton(i, b) {
  let f = 1, r = 0;
  for (i += 1; i > 0; i = Math.floor(i / b)) { f /= b; r += f * (i % b); }
  return r;
}

// ---------------------------------------------------------------- shadow map
// Orthographic depth render from the light. Stores "closeness" = dot(p, L) (L points to the light),
// so the standard "greater wins" depth test keeps the surface nearest to the light.
export function buildShadowMap(meshes, L, center, radius, size) {
  const up = Math.abs(L[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  // basis: R, U span the shadow map plane, L is the depth axis
  let R = [up[1] * L[2] - up[2] * L[1], up[2] * L[0] - up[0] * L[2], up[0] * L[1] - up[1] * L[0]];
  const rl = Math.hypot(...R);
  R = R.map((v) => v / rl);
  const U = [L[1] * R[2] - L[2] * R[1], L[2] * R[0] - L[0] * R[2], L[0] * R[1] - L[1] * R[0]];
  const scale = size / (2 * radius);
  const ox = R[0] * center[0] + R[1] * center[1] + R[2] * center[2] - radius;
  const oy = U[0] * center[0] + U[1] * center[1] + U[2] * center[2] - radius;
  const depth = new Float32Array(size * size).fill(-Infinity);
  const s16 = scale * 16;

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
  return { depth, size, R, U, L, ox, oy, scale };
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

// 4x4 box blur over the half-resolution AO (matches the 4x4 kernel rotation pattern), skipping
// neighbours at a clearly different depth so occlusion does not bleed across silhouettes.
function blurAO(src, depth, W, H) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
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
  return out;
}

// ctx: everything the pass needs, prepared by the renderer for this frame
export function shadePass(ctx) {
  const { W, H, depth, color, NX, NY, NZ, MAT, matSpec, matShin, matTwo, matEmis, eye, R, U, F, tanX, tanY, jx, jy,
    light, tone, shadow, frame, ao, fog, debug } = ctx;
  const colK = new Float32Array(W), rowK = new Float32Array(H);
  for (let x = 0; x < W; x++) colK[x] = (((x + 0.5) / W) * 2 - 1 - jx) * tanX;
  for (let y = 0; y < H; y++) rowK[y] = (1 - ((y + 0.5) / H) * 2 - jy) * tanY;

  const { lx, ly, lz, lr, lg, lb, sr, sg, sb, gr, gg, gb } = light;
  const S2L = SRGB_TO_LINEAR;

  // shadow map setup
  const sm = shadow, smS = sm ? sm.size : 0, smD = sm ? sm.depth : null;
  const texel = sm ? 1 / sm.scale : 0, smJu = halton(frame, 2) - 0.5, smJv = halton(frame, 3) - 0.5;

  // ssao setup
  const kernels = ao ? aoKernels(frame) : null;
  const aoR = ao ? ao.radius : 0, aoR2 = aoR * aoR, aoStr = ao ? ao.strength : 0;
  const focal = H / (2 * tanY), aoMaxPx = Math.max(8, H * 0.08);

  const fogOn = !!fog, fn = fog ? fog.near : 0, fspan = fog ? Math.max(1e-6, fog.far - fog.near) : 1;
  const fr = fog ? fog.r : 0, fg = fog ? fog.g : 0, fb = fog ? fog.b : 0;

  // ---- SSAO at half resolution: one value per 2x2 block, taken from a pixel that changes every frame,
  // so progressive accumulation still converges to full resolution
  const aoW = (W + 1) >> 1, aoH = (H + 1) >> 1;
  let aoBuf = ao ? new Float32Array(aoW * aoH).fill(1) : null;
  const aoDepth = ao ? new Float32Array(aoW * aoH) : null; // view depth of each block, for the blur
  if (ao) {
    const fx = frame & 1, fy = (frame >> 1) & 1;
    for (let by = 0; by < aoH; by++) {
      const y = Math.min(H - 1, by * 2 + fy), ry = rowK[y];
      for (let bx = 0; bx < aoW; bx++) {
        const x = Math.min(W - 1, bx * 2 + fx), i = y * W + x, iw = depth[i];
        if (iw === 0) continue;
        const w = 1 / iw, radPx = Math.min(aoMaxPx, (aoR * focal) / w);
        aoDepth[by * aoW + bx] = w;
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
        aoBuf[by * aoW + bx] = o * o; // stronger contrast in creases, almost no effect on open surfaces
      }
    }
    aoBuf = blurAO(aoBuf, aoDepth, aoW, aoH);
  }

  for (let y = 0; y < H; y++) {
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

      // hemisphere ambient
      const hemi = ny * 0.5 + 0.5;
      let r = ar * (gr + (sr - gr) * hemi) * occl;
      let g = ag * (gg + (sg - gg) * hemi) * occl;
      let b = ab * (gb + (sb - gb) * hemi) * occl;

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
            const d = sm.L[0] * qx + sm.L[1] * qy + sm.L[2] * qz + texel;
            const fu = u - u0, fv = v - v0, k = v0 * smS + u0;
            const t00 = d >= smD[k] ? 1 : 0, t10 = d >= smD[k + 1] ? 1 : 0;
            const t01 = d >= smD[k + smS] ? 1 : 0, t11 = d >= smD[k + smS + 1] ? 1 : 0;
            vis = (t00 * (1 - fu) + t10 * fu) * (1 - fv) + (t01 * (1 - fu) + t11 * fu) * fv;
          }
        }
        if (vis > 0) {
          const hx = lx + Vx, hy = ly + Vy, hz = lz + Vz;
          const ndh = (nx * hx + ny * hy + nz * hz) / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
          const shin = matShin[mat];
          // Schlick's approximation of pow(ndh, shin)
          const sp = ndh > 0 ? (matSpec[mat] * ndh) / (shin - shin * ndh + ndh) : 0;
          r += (ar * ndl + sp) * lr * vis;
          g += (ag * ndl + sp) * lg * vis;
          b += (ab * ndl + sp) * lb * vis;
        }
      }

      const emis = matEmis[mat];
      if (emis > 0) { r += ar * emis; g += ag * emis; b += ab * emis; }

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

