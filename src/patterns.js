// Procedural material patterns, evaluated per pixel in object space by the shading stage (any shape, no UVs).
// Each pattern gives a mix factor t (0..1, between the material's pattern colors) and a height h (for bump
// mapping). Coordinates are object space divided by the pattern scale (one feature per unit).

export const PATTERN_TYPES = ['wood', 'marble', 'leather', 'carbon', 'fabric', 'brushed', 'checker', 'stripes', 'knurl', 'concrete', 'brick'];
export const PATTERN_ID = Object.fromEntries(PATTERN_TYPES.map((t, i) => [t, i + 1]));

const hash = (x, y, z) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const sm = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

// smooth value noise in [-1, 1]
export function noise(x, y, z) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z), u = sm(x - x0), v = sm(y - y0), w = sm(z - z0);
  const a = hash(x0, y0, z0), b = hash(x0 + 1, y0, z0), c = hash(x0, y0 + 1, z0), d = hash(x0 + 1, y0 + 1, z0);
  const e = hash(x0, y0, z0 + 1), f = hash(x0 + 1, y0, z0 + 1), g = hash(x0, y0 + 1, z0 + 1), k = hash(x0 + 1, y0 + 1, z0 + 1);
  return lerp(lerp(lerp(a, b, u), lerp(c, d, u), v), lerp(lerp(e, f, u), lerp(g, k, u), v), w) * 2 - 1;
}
export function fbm(x, y, z, octaves = 4) {
  let s = 0, a = 0.5, n = 0;
  for (let o = 0; o < octaves; o++) { s += a * noise(x, y, z); n += a; x = x * 2.03 + 17.1; y = y * 2.03 + 3.7; z = z * 2.03 + 9.3; a *= 0.5; }
  return s / n;
}
// cellular noise: distance to the nearest and second nearest feature point (F1, F2)
let F1 = 0, F2 = 0;
function worley(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  F1 = 9; F2 = 9;
  for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const cx = xi + i, cy = yi + j, cz = zi + k;
    const dx = cx + hash(cx, cy, cz) - x, dy = cy + hash(cy, cz, cx) - y, dz = cz + hash(cz, cx, cy) - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < F1) { F2 = F1; F1 = d; } else if (d < F2) F2 = d;
  }
  F1 = Math.sqrt(F1); F2 = Math.sqrt(F2);
}

// Result of the last evaluation: mix factor and height.
export let PT = 0, PH = 0;

// (x, y, z): object position / scale; (nx, ny, nz): object-space normal (2D patterns pick the facing plane)
export function evalPattern(type, x, y, z, nx, ny, nz) {
  switch (type) {
    case 1: { // wood: growth rings around an axis along X (planks), warped, with fine fibres along the grain
      // ring centre far away: the rings show as long, gently wavy lines along the board
      const w = fbm(x * 0.06, y * 0.5, z * 0.5, 3) * 1.4;
      const r = Math.sqrt(y * y + (z + 37) * (z + 37)) + w;
      const ring = r - Math.floor(r);
      const fibre = noise(x * 0.25, y * 26, z * 26) * 0.5 + noise(x * 0.5, y * 60, z * 60) * 0.25;
      const late = ring ** 3; // dark late-wood band at the end of each ring
      PT = Math.min(1, Math.max(0, 0.15 + 0.7 * late + 0.25 * fibre + 0.1 * fbm(x * 0.3, y * 2, z * 2, 2)));
      PH = -late * 0.6 + fibre * 0.4;
      return;
    }
    case 2: { // marble: turbulent veins through a cloudy base
      const turb = fbm(x * 0.7, y * 0.7, z * 0.7, 5);
      const v = Math.sin((x * 0.9 + y * 0.45 + z * 0.3 + turb * 3.2) * Math.PI);
      const vein = 1 - Math.min(1, Math.abs(v) / 0.09);
      const fine = 1 - Math.min(1, Math.abs(Math.sin((x * 2.1 - z * 1.3 + turb * 5) * Math.PI)) / 0.05);
      PT = Math.min(1, vein * 0.95 + fine * 0.35 + (fbm(x * 2, y * 2, z * 2, 3) * 0.5 + 0.5) * 0.12);
      PH = -vein * 0.2;
      return;
    }
    case 3: { // leather: pebbled grain cells separated by fine grooves
      worley(x, y, z);
      const edge = F2 - F1, groove = 1 - Math.min(1, edge / 0.12);
      const vary = noise(x * 0.15, y * 0.15, z * 0.15) * 0.5 + 0.5;
      PT = Math.min(1, Math.max(0, 0.25 + vary * 0.45 + groove * 0.35));
      PH = (1 - groove) * Math.min(1, F1 * 1.6) * 0.6 - groove * 0.8 + noise(x * 6, y * 6, z * 6) * 0.08;
      return;
    }
    case 4: case 5: case 7: { // 2D patterns on the plane the surface faces
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      const u = ax >= ay && ax >= az ? z : x, v = ax >= ay && ax >= az ? y : ay >= az ? z : y;
      if (type === 7) { // checker
        const c = (Math.floor(u) + Math.floor(v)) & 1;
        PT = c; PH = 0;
        return;
      }
      if (type === 4) { // carbon fibre: 2x2 twill, each tow a rounded bundle of fibres
        const tu = Math.floor(u), tv = Math.floor(v), dir = ((tu + tv) & 1) === 0, f = dir ? u - tu : v - tv, g = dir ? v - tv : u - tu;
        const bundle = Math.sin(f * Math.PI), fibres = 0.85 + 0.15 * Math.sin(g * 60);
        PT = dir ? 0.25 + 0.55 * bundle * fibres : 0.55 + 0.35 * bundle * fibres;
        PH = bundle * 0.6;
        return;
      }
      // fabric: plain weave of warp and weft threads with a little fuzz
      const wu = Math.sin(u * Math.PI * 2), wv = Math.sin(v * Math.PI * 2), over = wu * wv > 0;
      const thread = over ? Math.abs(Math.sin(u * Math.PI * 2)) : Math.abs(Math.sin(v * Math.PI * 2));
      const fuzz = noise(u * 9, v * 9, (u + v) * 3) * 0.15;
      PT = Math.min(1, Math.max(0, 0.3 + 0.5 * thread + fuzz));
      PH = thread * 0.7 + fuzz;
      return;
    }
    case 6: { // brushed metal: fine streaks along X
      const n = noise(x * 0.02, y * 40, z * 40) * 0.6 + noise(x * 0.05, y * 120, z * 120) * 0.4;
      PT = 0.5 + 0.3 * n; PH = n * 0.5;
      return;
    }
    case 8: { // stripes across Y
      const f = y - Math.floor(y);
      PT = f < 0.5 ? 0 : 1; PH = 0;
      return;
    }
    case 9: { // knurl: diamond pattern around a cylinder along Y (dials, grips)
      const a = Math.atan2(z, x) * Math.sqrt(x * x + z * z), d1 = a + y, d2 = a - y;
      const h = Math.abs(Math.sin(d1 * Math.PI)) * Math.abs(Math.sin(d2 * Math.PI));
      PT = 1 - h; PH = h;
      return;
    }
    case 10: { // concrete: cloudy trowelled surface, fine aggregate speckles, a few darker stains
      const cloud = fbm(x * 0.35, y * 0.35, z * 0.35, 4);
      worley(x * 4, y * 4, z * 4);
      const speck = F1 < 0.12 ? 1 - F1 / 0.12 : 0;
      const stain = Math.max(0, fbm(x * 0.08 + 9, y * 0.08, z * 0.08, 3) - 0.2) * 1.6;
      PT = Math.min(1, Math.max(0, 0.45 + cloud * 0.3 + speck * 0.35 + stain * 0.5));
      PH = cloud * 0.3 - speck * 0.4;
      return;
    }
    case 11: { // brick: running bond on the facing plane, bricks one unit high and two long, recessed mortar
      const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
      const u = ax >= ay && ax >= az ? z : x, v = ax >= ay && ax >= az ? y : ay >= az ? z : y;
      const row = Math.floor(v), uu = u * 0.5 + (row & 1) * 0.5, col = Math.floor(uu);
      const fu = uu - col, fv = v - row, m = 0.045;
      const mortar = fu < m * 0.5 || fu > 1 - m * 0.5 || fv < m || fv > 1 - m;
      if (mortar) { PT = 1; PH = -1; return; }
      const tone = hash(col, row, 7), grain = noise(u * 6, v * 6, col * 1.7) * 0.5 + 0.5;
      PT = tone * 0.32 + grain * 0.14; // between the two brick colours; the third colour is the mortar
      PH = 0.2 + grain * 0.3;
      return;
    }
    default: PT = 0; PH = 0;
  }
}
