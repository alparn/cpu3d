// Procedural textures for the Neon district scene: lit facade windows, glowing neon signs with
// abstract glyphs and a billboard. A tiny RGBA painter with a box-blur glow, no dependencies.

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(width, height, bg) {
  const px = new Float32Array(width * height * 3), c = hex(bg);
  for (let i = 0; i < width * height; i++) px.set(c, i * 3);
  const rect = (x, y, w, h, color, alpha = 1, layer = px) => {
    const col = typeof color === 'string' ? hex(color) : color;
    for (let j = Math.max(0, Math.floor(y)); j < Math.min(height, Math.ceil(y + h)); j++) {
      for (let i = Math.max(0, Math.floor(x)); i < Math.min(width, Math.ceil(x + w)); i++) {
        const k = (j * width + i) * 3;
        for (let q = 0; q < 3; q++) layer[k + q] += (col[q] - layer[k + q]) * alpha;
      }
    }
  };
  const toRGBA = () => {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) { out[i * 4] = px[i * 3]; out[i * 4 + 1] = px[i * 3 + 1]; out[i * 4 + 2] = px[i * 3 + 2]; out[i * 4 + 3] = 255; }
    return { width, height, data: out };
  };
  return { px, rect, toRGBA, width, height };
}

// separable box blur (3 passes ~ gaussian) of a float RGB layer
function blur(layer, W, H, r) {
  const tmp = new Float32Array(layer.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < H; y++) for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += layer[(y * W + Math.min(W - 1, Math.max(0, x))) * 3 + c];
      for (let x = 0; x < W; x++) {
        tmp[(y * W + x) * 3 + c] = s / (2 * r + 1);
        s += layer[(y * W + Math.min(W - 1, x + r + 1)) * 3 + c] - layer[(y * W + Math.max(0, x - r)) * 3 + c];
      }
    }
    for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[(Math.min(H - 1, Math.max(0, y)) * W + x) * 3 + c];
      for (let y = 0; y < H; y++) {
        layer[(y * W + x) * 3 + c] = s / (2 * r + 1);
        s += tmp[(Math.min(H - 1, y + r + 1) * W + x) * 3 + c] - tmp[(Math.max(0, y - r) * W + x) * 3 + c];
      }
    }
  }
}

// Facade with rows of windows: some lit warm or cool, some dark, a few with blinds.
export function paintWindows(seed, { width = 256, height = 1024, cols = 8, rows = 36, lit = 0.45 } = {}) {
  const rand = rng(seed), cv = canvas(width, height, '#0b0c13');
  const cw = width / cols, rh = height / rows;
  const tints = ['#ffb35c', '#ffc77e', '#ffd9a0', '#ffb35c', '#cfe0ff', '#9fbfff', '#ff7ab8'];
  for (let r = 0; r < rows; r++) {
    // whole floors tend to be lit or dark together
    const floor = rand() < 0.25 ? 0.15 : rand() < 0.2 ? 0.9 : lit;
    for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.18, y = r * rh + rh * 0.22, w = cw * 0.64, h = rh * 0.6;
      if (rand() < floor) {
        const t = hex(tints[Math.floor(rand() ** 1.4 * tints.length)]), k = 0.3 + rand() * 0.55;
        cv.rect(x, y, w, h, t.map((v) => v * k));
        if (rand() < 0.3) cv.rect(x, y, w, h * (0.2 + rand() * 0.5), '#2a2420', 0.8); // blinds half down
      } else cv.rect(x, y, w, h, '#0f121b');
    }
    cv.rect(0, r * rh, width, rh * 0.08, '#07080c'); // floor slab line
  }
  return cv.toRGBA();
}

// Vertical neon sign: a glowing frame and abstract glyphs built from strokes on a 4 x 4 grid.
export function paintSign(seed, color, { width = 128, height = 512, glyphs = 4 } = {}) {
  const rand = rng(seed), cv = canvas(width, height, '#050407'), W = width, H = height;
  const glow = new Float32Array(W * H * 3), core = hex(color), white = core.map((v) => 255 - (255 - v) * 0.35);
  const stroke = (x, y, w, h) => { cv.rect(x, y, w, h, white); cv.rect(x, y, w, h, core, 1, glow); };
  const t = 7, pad = 12;
  stroke(pad, pad, W - 2 * pad, t); stroke(pad, H - pad - t, W - 2 * pad, t); stroke(pad, pad, t, H - 2 * pad); stroke(W - pad - t, pad, t, H - 2 * pad);
  const gh = (H - 4 * pad) / glyphs, gw = W - 6 * pad;
  for (let g = 0; g < glyphs; g++) {
    const ox = 3 * pad, oy = 2 * pad + g * gh + gh * 0.12, s = gw / 4, n = 3 + Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      const horizontal = rand() < 0.55, a = Math.floor(rand() * 4), b = Math.floor(rand() * 3), len = 1 + Math.floor(rand() * (4 - b));
      if (horizontal) stroke(ox + b * s, oy + a * s * 0.95, len * s, t);
      else stroke(ox + a * s, oy + b * s * 0.95, t, len * s * 0.95);
    }
  }
  blur(glow, W, H, 9);
  for (let i = 0; i < glow.length; i++) cv.px[i] = Math.min(255, cv.px[i] + glow[i] * 1.6);
  return cv.toRGBA();
}

// Billboard: a retro sun with scan lines over a magenta to violet sky, glyph columns at the side.
export function paintBillboard(seed, { width = 512, height = 256 } = {}) {
  const rand = rng(seed), cv = canvas(width, height, '#12061f'), W = width, H = height;
  for (let y = 0; y < H; y++) {
    const k = y / H, c = [255 * (0.15 + 0.6 * k), 40 + 40 * k, 120 + 60 * (1 - k)];
    cv.rect(0, y, W, 1, c.map((v) => v * 0.55));
  }
  const cx = W * 0.62, cy = H * 0.62, R = H * 0.42;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d > R || y > cy + R * 0.15) continue;
    const band = y > cy - R * 0.2 && Math.floor((y - (cy - R * 0.2)) / (H * 0.035)) % 2 === 1;
    if (band) continue;
    const k = (y - (cy - R)) / (2 * R), c = [255, 210 - 150 * k, 90 + 40 * k];
    cv.rect(x, y, 1, 1, c);
  }
  for (let col = 0; col < 3; col++) {
    for (let r = 0; r < 7; r++) {
      if (rand() < 0.25) continue;
      cv.rect(20 + col * 34, 22 + r * 31, 22 + rand() * 6, 6, '#7ff6ff');
      if (rand() < 0.6) cv.rect(20 + col * 34 + rand() * 16, 22 + r * 31, 6, 20, '#7ff6ff');
    }
  }
  return cv.toRGBA();
}

// Light smeared on wet asphalt: broken vertical streaks that fade out towards the far end (v = 0).
export function paintWetStreak(seed, { width = 64, height = 256 } = {}) {
  const rand = rng(seed), cv = canvas(width, height, '#000000'), layer = new Float32Array(width * height * 3);
  for (let k = 0; k < 14; k++) {
    const x = rand() * width, w = 1 + rand() * 2, y0 = rand() * height * 0.15, len = height * (0.3 + rand() * 0.6), b = 120 + rand() * 135;
    for (let y = Math.floor(y0); y < Math.min(height, y0 + len); y++) {
      if (rand() < 0.12) continue; // ripples break the streak
      // brightest under the light source (v = 0, the far end of the patch), fading towards the viewer
      const f = (1 - y / height) ** 1.3 * (1 - Math.abs((y - y0) / len - 0.5) * 0.6);
      cv.rect(x, y, w, 1, [b * f, b * f, b * f], 1, layer);
    }
  }
  blur(layer, width, height, 2);
  for (let i = 0; i < layer.length; i++) cv.px[i] = Math.min(255, layer[i] * 1.4);
  return cv.toRGBA();
}
