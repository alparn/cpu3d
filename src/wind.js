// Wind: bends vertices with their height above the base of the shape (grass, kelp, flags, trees).
// A travelling wave plus a faster gust runs across the field, so neighbours sway together but not in sync.
//   wind = { strength (bend at 1 unit height, in units), wavelength (units), speed (units/s), direction [x, z] }
export let DX = 0, DY = 0, DZ = 0;

// y: object-space height of the vertex, base: lowest y of the shape, (wx, wz): world position, t: seconds
export function windAt(w, y, base, wx, wz, t) {
  const h = y - base;
  if (h <= 0) { DX = 0; DY = 0; DZ = 0; return; }
  const bend = w.strength * h * h, k = (2 * Math.PI) / w.wavelength;
  const along = wx * w.dx + wz * w.dz, phase = (t * w.speed - along) * k;
  const s = 0.35 + 0.65 * Math.sin(phase) + 0.25 * Math.sin(phase * 1.9 + wx * 0.37 - wz * 0.53 + t * 0.7);
  const off = bend * s;
  DX = w.dx * off; DZ = w.dz * off; DY = -0.3 * bend * Math.abs(s); // a bent stalk gets a little shorter
}

export function normalizeWindForRender(w) {
  const d = w.direction || [1, 0], l = Math.hypot(d[0], d[1]) || 1;
  return { strength: w.strength, wavelength: w.wavelength, speed: w.speed, dx: d[0] / l, dz: d[1] / l };
}
