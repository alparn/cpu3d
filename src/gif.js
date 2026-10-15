// Animated GIF encoder, no dependencies (browser and Node).
//   const gif = new GifEncoder(width, height, { delay: 1 / 15 });
//   gif.palette(sampleFrames);   // optional: build the shared palette from a few frames first
//   gif.add(rgba); ... ; const bytes = gif.finish();
// One global 255-color palette (median cut) keeps colors stable between frames; ordered dithering
// hides banding without flickering; pixels that did not change are written as transparent and each
// frame is cropped to the changed area, which makes mostly static scenes small.

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
const TRANSPARENT = 255;

class ByteWriter {
  constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; }
  byte(b) {
    if (this.len === this.buf.length) { const n = new Uint8Array(this.buf.length * 2); n.set(this.buf); this.buf = n; }
    this.buf[this.len++] = b;
  }
  bytes(list) { for (const b of list) this.byte(b); }
  u16(v) { this.byte(v & 255); this.byte((v >> 8) & 255); }
  text(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  result() { return this.buf.slice(0, this.len); }
}

// median cut on a 5-bit-per-channel histogram -> up to `count` colors [[r, g, b], ...]
export function medianCut(frames, count = 255, step = 3) {
  const hist = new Uint32Array(32768);
  for (const px of frames) for (let i = 0; i < px.length; i += 4 * step) hist[((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3)]++;
  const colors = [];
  for (let c = 0; c < 32768; c++) if (hist[c]) colors.push(c);
  const ch = (c, a) => (c >> (10 - a * 5)) & 31;
  let boxes = [colors];
  while (boxes.length < count) {
    // split the box with the largest (range x population), along its widest channel
    let best = -1, score = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      let n = 0, r = 0;
      for (let a = 0; a < 3; a++) { let lo = 31, hi = 0; for (const c of b) { const v = ch(c, a); if (v < lo) lo = v; if (v > hi) hi = v; } r = Math.max(r, hi - lo); }
      for (const c of b) n += hist[c];
      if (r * Math.sqrt(n) > score) { score = r * Math.sqrt(n); best = i; }
    });
    if (best < 0) break;
    const b = boxes[best];
    let axis = 0, wide = -1;
    for (let a = 0; a < 3; a++) { let lo = 31, hi = 0; for (const c of b) { const v = ch(c, a); if (v < lo) lo = v; if (v > hi) hi = v; } if (hi - lo > wide) { wide = hi - lo; axis = a; } }
    b.sort((x, y) => ch(x, axis) - ch(y, axis));
    let total = 0, half = 0, cut = 1;
    for (const c of b) total += hist[c];
    for (let i = 0; i < b.length - 1; i++) { half += hist[b[i]]; if (half >= total / 2) { cut = i + 1; break; } }
    boxes.splice(best, 1, b.slice(0, cut), b.slice(cut));
  }
  return boxes.filter((b) => b.length).map((b) => {
    let n = 0, r = 0, g = 0, bl = 0;
    for (const c of b) { const w = hist[c]; n += w; r += ch(c, 0) * w; g += ch(c, 1) * w; bl += ch(c, 2) * w; }
    return [r, g, bl].map((v) => Math.round(((v / n) * 255) / 31));
  });
}

export class GifEncoder {
  // delay in seconds per frame; dither 0..1 (ordered dithering strength)
  constructor(width, height, { delay = 1 / 15, dither = 1, loop = true } = {}) {
    Object.assign(this, { width, height, delay, dither, loop });
    this.out = new ByteWriter();
    this.prev = null;
    this.colors = null;
    this.frames = 0;
  }

  palette(sampleFrames) {
    this.colors = medianCut(sampleFrames, 255);
    while (this.colors.length < 256) this.colors.push([0, 0, 0]);
    this.lut = new Int16Array(1 << 18).fill(-1); // 6 bits per channel -> palette index
    return this;
  }

  _nearest(r, g, b) {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let idx = this.lut[key];
    if (idx >= 0) return idx;
    const cr = (r & 0xfc) + 2, cg = (g & 0xfc) + 2, cb = (b & 0xfc) + 2;
    let best = 1e9;
    for (let i = 0; i < 255; i++) {
      const c = this.colors[i], dr = c[0] - cr, dg = c[1] - cg, db = c[2] - cb;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < best) { best = d; idx = i; }
    }
    return (this.lut[key] = idx);
  }

  _header() {
    const o = this.out;
    o.text('GIF89a');
    o.u16(this.width); o.u16(this.height);
    o.bytes([0xf7, 0, 0]); // global color table, 256 entries
    for (const c of this.colors) o.bytes(c);
    if (this.loop) { o.bytes([0x21, 0xff, 11]); o.text('NETSCAPE2.0'); o.bytes([3, 1, 0, 0, 0]); }
  }

  add(rgba) {
    if (!this.colors) this.palette([rgba]);
    if (!this.frames) this._header();
    const { width: w, height: h } = this, idx = new Uint8Array(w * h), amp = 10 * this.dither;
    for (let y = 0, p = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p++) {
        const d = BAYER[((y & 3) << 2) | (x & 3)] * amp, i = p * 4;
        const r = Math.max(0, Math.min(255, rgba[i] + d)), g = Math.max(0, Math.min(255, rgba[i + 1] + d)), b = Math.max(0, Math.min(255, rgba[i + 2] + d));
        idx[p] = this._nearest(r | 0, g | 0, b | 0);
      }
    }
    // crop to the pixels that changed since the previous frame; unchanged pixels inside become transparent
    let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
    const prev = this.prev;
    if (prev) {
      x0 = w; y0 = h; x1 = -1; y1 = -1;
      for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p++) {
        if (idx[p] !== prev[p]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) { x0 = y0 = x1 = y1 = 0; } // nothing changed: one transparent pixel
    }
    const fw = x1 - x0 + 1, fh = y1 - y0 + 1, data = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      const p = (y + y0) * w + x + x0;
      data[y * fw + x] = prev && idx[p] === prev[p] ? TRANSPARENT : idx[p];
    }
    const o = this.out, delay = Math.max(2, Math.round(this.delay * 100));
    o.bytes([0x21, 0xf9, 4, (1 << 2) | (prev ? 1 : 0)]); // graphic control: keep previous frame, transparency after frame 1
    o.u16(delay); o.bytes([TRANSPARENT, 0]);
    o.byte(0x2c); o.u16(x0); o.u16(y0); o.u16(fw); o.u16(fh); o.byte(0);
    lzw(o, data, 8);
    this.prev = idx;
    this.frames++;
  }

  finish() {
    this.out.byte(0x3b);
    return this.out.result();
  }
}

// GIF flavoured LZW with variable code size, data written in sub-blocks of up to 255 bytes
// dictionary: (prefix code << 8 | byte) -> code, shared between calls and invalidated by bumping the generation
let table = null, gen = null, generation = 0;
function newGeneration() {
  if (!table) { table = new Int32Array(4096 << 8); gen = new Uint32Array(4096 << 8); }
  if (++generation === 0xffffffff) { gen.fill(0); generation = 1; }
}

function lzw(o, data, minSize) {
  newGeneration();
  o.byte(minSize);
  const clear = 1 << minSize, eoi = clear + 1;
  let size = minSize + 1, next = eoi + 1;
  let block = new Uint8Array(255), blen = 0, acc = 0, bits = 0;
  const emit = (code) => {
    acc |= code << bits; bits += size;
    while (bits >= 8) {
      block[blen++] = acc & 255; acc >>>= 8; bits -= 8;
      if (blen === 255) { o.byte(255); o.bytes(block); blen = 0; }
    }
  };
  emit(clear);
  let prefix = data[0];
  for (let i = 1; i < data.length; i++) {
    const c = data[i], key = (prefix << 8) | c;
    if (gen[key] === generation) { prefix = table[key]; continue; }
    emit(prefix);
    if (next < 4096) {
      table[key] = next; gen[key] = generation;
      if (next === 1 << size && size < 12) size++;
      next++;
    } else {
      emit(clear);
      newGeneration(); size = minSize + 1; next = eoi + 1;
    }
    prefix = c;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) { block[blen++] = acc & 255; if (blen === 255) { o.byte(255); o.bytes(block); blen = 0; } }
  if (blen) { o.byte(blen); for (let i = 0; i < blen; i++) o.byte(block[i]); }
  o.byte(0);
}
