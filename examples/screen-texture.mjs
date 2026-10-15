// Paints a phone home screen into an RGBA image (used as the display texture of the Smartphone
// gallery scene). A tiny 2D painter with anti-aliased signed-distance shapes, no dependencies.
// Layout is designed in "points" (390 x 844) and scaled to the texture size.

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export function paintHomeScreen(width = 590) {
  const S = width / 390, W = width, H = Math.round(844 * S);
  const px = new Float32Array(W * H * 3);

  const put = (i, c, a) => {
    const k = i * 3;
    px[k] += (c[0] - px[k]) * a; px[k + 1] += (c[1] - px[k + 1]) * a; px[k + 2] += (c[2] - px[k + 2]) * a;
  };
  // signed distance of a rounded rectangle (center cx, cy, half size hx, hy, radius r)
  const sdRound = (x, y, cx, cy, hx, hy, r) => {
    const qx = Math.abs(x - cx) - (hx - r), qy = Math.abs(y - cy) - (hy - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
  // fill a shape given in points; color may be a function of (u, v) inside the box for gradients
  function shape(x, y, w, h, r, color, alpha = 1, sd = null) {
    const x0 = Math.max(0, Math.floor(x * S) - 1), y0 = Math.max(0, Math.floor(y * S) - 1);
    const x1 = Math.min(W - 1, Math.ceil((x + w) * S) + 1), y1 = Math.min(H - 1, Math.ceil((y + h) * S) + 1);
    const cx = (x + w / 2) * S, cy = (y + h / 2) * S, hx = (w / 2) * S, hy = (h / 2) * S, rr = r * S;
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const d = sd ? sd(i + 0.5, j + 0.5) : sdRound(i + 0.5, j + 0.5, cx, cy, hx, hy, rr);
        const cov = Math.min(1, Math.max(0, 0.5 - d));
        if (cov <= 0) continue;
        const c = typeof color === 'function' ? color((i / S - x) / w, (j / S - y) / h) : color;
        put(j * W + i, c, cov * alpha);
      }
    }
  }
  const rect = (x, y, w, h, r, color, alpha) => shape(x, y, w, h, r, color, alpha);
  const circle = (cx, cy, rad, color, alpha = 1) => shape(cx - rad, cy - rad, rad * 2, rad * 2, rad, color, alpha);
  const ring = (cx, cy, rad, t, color, alpha = 1) => shape(cx - rad, cy - rad, rad * 2, rad * 2, 0, color, alpha,
    (i, j) => Math.abs(Math.hypot(i - cx * S, j - cy * S) - (rad - t / 2) * S) - (t / 2) * S);
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const vgrad = (a, b) => (u, v) => mix(hex(a), hex(b), v);

  // 7-segment digits with rounded segments (enough for clocks, dates and temperatures)
  const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '°': 'abfg' };
  function digits(str, x, y, h, color) {
    const w = h * 0.52, t = h * 0.13, gap = h * 0.22;
    for (const ch of str) {
      if (ch === ':') { circle(x + t, y + h * 0.3, t * 0.6, color); circle(x + t, y + h * 0.72, t * 0.6, color); x += t * 3; continue; }
      if (ch === '°') { ring(x + h * 0.14, y + h * 0.14, h * 0.14, t * 0.8, color); x += h * 0.4; continue; }
      const segs = SEG[ch] || '';
      const sc = ch === '°' ? 0.5 : 1, ww = w * sc, hh = h * sc;
      const s = { a: [0, 0, ww, t], b: [ww - t, 0, t, hh / 2], c: [ww - t, hh / 2, t, hh / 2], d: [0, hh - t, ww, t],
        e: [0, hh / 2, t, hh / 2], f: [0, 0, t, hh / 2], g: [0, hh / 2 - t / 2, ww, t] };
      for (const k of segs) { const [sx, sy, sw, sh] = s[k]; rect(x + sx, y + sy, sw, sh, t / 2, color); }
      x += ww + gap;
    }
  }

  // ---- wallpaper: deep gradient with soft color glows
  for (let j = 0; j < H; j++) {
    const c = mix(hex('#1a1240'), hex('#071b3f'), j / H);
    for (let i = 0; i < W; i++) { const k = (j * W + i) * 3; px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; }
  }
  for (const [gx, gy, gr, col, a] of [[70, 170, 230, '#ff3d7f', 0.55], [340, 300, 260, '#7b4dff', 0.6], [230, 640, 300, '#008cff', 0.45], [40, 560, 190, '#ff9a3c', 0.35]]) {
    const c = hex(col), R = gr * S;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const d2 = ((i - gx * S) ** 2 + (j - gy * S) ** 2) / (R * R);
        if (d2 < 4) put(j * W + i, c, a * Math.exp(-d2 * 2.2));
      }
    }
  }

  const white = [255, 255, 255];
  // ---- status bar
  digits('10:24', 34, 17, 13, white);
  for (let b = 0; b < 4; b++) rect(285 + b * 6, 27 - b * 3, 4, 5 + b * 3, 1.2, white, b < 3 ? 1 : 0.4);
  rect(318, 18, 25, 12, 3.5, white, 0.45);
  rect(320, 20, 18, 8, 2, white);
  rect(344, 22, 2, 4, 1, white, 0.45);

  // ---- widgets
  rect(24, 62, 165, 165, 24, vgrad('#2f8cff', '#1556d6'));
  circle(156, 96, 15, hex('#ffd34d'));
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; circle(156 + Math.cos(a) * 22, 96 + Math.sin(a) * 22, 2.2, hex('#ffd34d')); }
  rect(42, 82, 64, 9, 4.5, white, 0.9);
  digits('21°', 42, 116, 46, white);
  rect(42, 186, 90, 8, 4, white, 0.75);
  rect(42, 202, 60, 7, 3.5, white, 0.5);

  rect(201, 62, 165, 165, 24, [250, 250, 252]);
  rect(219, 82, 72, 9, 4.5, hex('#ff3b30'));
  digits('15', 219, 104, 58, hex('#1c1c1e'));
  for (let k = 0; k < 3; k++) rect(219, 180 + k * 12, 128 - k * 30, 7, 3.5, hex('#8e8e93'), 0.6);

  // ---- app grid: gradient squircle-ish icons with simple white glyphs and a label placeholder
  const icons = [
    ['#5ef08a', '#22b04b', 'bubble'], ['#7fd4ff', '#1e88ff', 'ring'], ['#ffd25e', '#ff9500', 'sun'], ['#ff8aa8', '#ff2d55', 'camera'],
    ['#9c9cff', '#5856d6', 'bars'], ['#a7f0ff', '#32ade6', 'drop'], ['#fff07a', '#ffcc00', 'notes'], ['#e3a4ff', '#af52de', 'play'],
    ['#ffffff', '#e5e5ea', 'flower'], ['#ffb27a', '#ff6b22', 'grid'], ['#5ee0d6', '#00a39a', 'plus'], ['#f2f2f7', '#c7c7cc', 'gear'],
    ['#ff7a7a', '#e5203a', 'square'], ['#8e8e93', '#48484a', 'clock'], ['#7ab8ff', '#0a5cff', 'tri'], ['#d6b98a', '#a2845e', 'book'],
  ];
  const glyph = (kind, cx, cy, s, col = white) => {
    switch (kind) {
      case 'bubble': circle(cx, cy - 1, s * 0.34, col); shape(cx - s * 0.3, cy + s * 0.08, s * 0.22, s * 0.22, s * 0.05, col); break;
      case 'ring': ring(cx, cy, s * 0.3, s * 0.1, col); circle(cx, cy, s * 0.1, col); break;
      case 'sun': circle(cx, cy, s * 0.2, col); for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; circle(cx + Math.cos(a) * s * 0.33, cy + Math.sin(a) * s * 0.33, s * 0.05, col); } break;
      case 'camera': rect(cx - s * 0.3, cy - s * 0.17, s * 0.6, s * 0.4, s * 0.08, col); rect(cx - s * 0.12, cy - s * 0.25, s * 0.24, s * 0.12, s * 0.04, col);
        circle(cx, cy + s * 0.03, s * 0.13, hex('#d0103a')); circle(cx, cy + s * 0.03, s * 0.07, col); break;
      case 'bars': for (let k = 0; k < 4; k++) rect(cx - s * 0.3 + k * s * 0.16, cy + s * 0.25 - (k + 1) * s * 0.13, s * 0.1, (k + 1) * s * 0.13, s * 0.04, col); break;
      case 'drop': circle(cx, cy + s * 0.08, s * 0.22, col); shape(cx - s * 0.11, cy - s * 0.3, s * 0.22, s * 0.3, s * 0.11, col); break;
      case 'notes': for (let k = 0; k < 3; k++) rect(cx - s * 0.28, cy - s * 0.2 + k * s * 0.17, s * (0.56 - k * 0.12), s * 0.07, s * 0.035, hex('#7a5a00')); break;
      case 'play': shape(cx - s * 0.2, cy - s * 0.25, s * 0.5, s * 0.5, 0, col, 1, (i, j) => {
        const x = i / S - (cx - s * 0.15), y = Math.abs(j / S - cy); return Math.max(-x, x + y * 1.3 - s * 0.38) * S; }); break;
      case 'flower': for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; circle(cx + Math.cos(a) * s * 0.17, cy + Math.sin(a) * s * 0.17, s * 0.13, hex(['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de'][k]), 0.85); } break;
      case 'grid': for (let k = 0; k < 4; k++) rect(cx - s * 0.27 + (k % 2) * s * 0.3, cy - s * 0.27 + Math.floor(k / 2) * s * 0.3, s * 0.24, s * 0.24, s * 0.06, col); break;
      case 'plus': rect(cx - s * 0.06, cy - s * 0.28, s * 0.12, s * 0.56, s * 0.05, col); rect(cx - s * 0.28, cy - s * 0.06, s * 0.56, s * 0.12, s * 0.05, col); break;
      case 'gear': ring(cx, cy, s * 0.3, s * 0.12, hex('#636366')); for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; circle(cx + Math.cos(a) * s * 0.33, cy + Math.sin(a) * s * 0.33, s * 0.06, hex('#636366')); } circle(cx, cy, s * 0.08, hex('#636366')); break;
      case 'square': rect(cx - s * 0.24, cy - s * 0.24, s * 0.48, s * 0.48, s * 0.1, col); break;
      case 'clock': ring(cx, cy, s * 0.32, s * 0.06, col); rect(cx - s * 0.025, cy - s * 0.22, s * 0.05, s * 0.24, s * 0.025, col); rect(cx - s * 0.025, cy - s * 0.025, s * 0.18, s * 0.05, s * 0.025, col); break;
      case 'tri': shape(cx - s * 0.3, cy - s * 0.3, s * 0.6, s * 0.6, 0, col, 1, (i, j) => {
        const x = Math.abs(i / S - cx), y = j / S - cy; return Math.max(y - s * 0.22, x * 1.6 - y * 0.9 - s * 0.24) * S; }); break;
      case 'book': rect(cx - s * 0.26, cy - s * 0.26, s * 0.24, s * 0.52, s * 0.05, col); rect(cx + s * 0.02, cy - s * 0.26, s * 0.24, s * 0.52, s * 0.05, col); break;
      default: break;
    }
  };
  const ICON = 62, gapX = (390 - 4 * ICON) / 5;
  icons.forEach(([a, b, kind], n) => {
    const x = gapX + (n % 4) * (ICON + gapX), y = 258 + Math.floor(n / 4) * 100;
    rect(x, y, ICON, ICON, 15, vgrad(a, b));
    glyph(kind, x + ICON / 2, y + ICON / 2, ICON);
    rect(x + 11, y + ICON + 9, ICON - 22, 6, 3, white, 0.55);
  });

  // ---- page dots, dock, home indicator
  circle(187, 676, 3.5, white); circle(203, 676, 3.5, white, 0.4);
  rect(12, 706, 366, 92, 34, white, 0.18);
  [['#5ef08a', '#22b04b', 'bubble'], ['#7fd4ff', '#1e88ff', 'ring'], ['#ffffff', '#e5e5ea', 'flower'], ['#ff8aa8', '#ff2d55', 'play']].forEach(([a, b, kind], n) => {
    const x = gapX + n * (ICON + gapX), y = 721;
    rect(x, y, ICON, ICON, 15, vgrad(a, b));
    glyph(kind, x + ICON / 2, y + ICON / 2, ICON, kind === 'flower' ? white : white);
  });
  rect(128, 826, 134, 5, 2.5, white);

  const data = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    data[p * 4] = px[p * 3]; data[p * 4 + 1] = px[p * 3 + 1]; data[p * 4 + 2] = px[p * 3 + 2]; data[p * 4 + 3] = 255;
  }
  return { width: W, height: H, data };
}
