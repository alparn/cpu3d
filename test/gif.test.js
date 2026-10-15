import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GifEncoder } from '../src/gif.js';

// minimal GIF decoder: global palette, LZW, frame rectangles, transparency, "do not dispose"
function decodeGIF(b) {
  assert.equal(String.fromCharCode(...b.subarray(0, 6)), 'GIF89a');
  const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8), pal = b.subarray(13, 13 + 768);
  let p = 13 + 768, transparent = -1, delay = 0, loop = false;
  const screen = new Uint8Array(w * h * 4), frames = [];
  while (b[p] !== 0x3b) {
    if (b[p] === 0x21) {
      const label = b[p + 1];
      if (label === 0xf9) { transparent = b[p + 3] & 1 ? b[p + 6] : -1; delay = b[p + 4] | (b[p + 5] << 8); }
      if (label === 0xff) loop = true;
      p += 2;
      while (b[p]) p += b[p] + 1;
      p++;
    } else if (b[p] === 0x2c) {
      const x0 = b[p + 1] | (b[p + 2] << 8), y0 = b[p + 3] | (b[p + 4] << 8), fw = b[p + 5] | (b[p + 6] << 8), fh = b[p + 7] | (b[p + 8] << 8);
      const min = b[p + 10];
      p += 11;
      const bytes = [];
      while (b[p]) { bytes.push(...b.subarray(p + 1, p + 1 + b[p])); p += b[p] + 1; }
      p++;
      const idx = lzwDecode(bytes, min, fw * fh);
      assert.equal(idx.length, fw * fh, 'pixel count');
      for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
        const c = idx[y * fw + x];
        if (c === transparent) continue;
        const o = ((y + y0) * w + x + x0) * 4;
        screen[o] = pal[c * 3]; screen[o + 1] = pal[c * 3 + 1]; screen[o + 2] = pal[c * 3 + 2]; screen[o + 3] = 255;
      }
      frames.push({ pixels: screen.slice(), delay });
    } else throw new Error(`unexpected block 0x${b[p].toString(16)} at ${p}`);
  }
  return { w, h, frames, loop };
}

function lzwDecode(bytes, min, count) {
  const clear = 1 << min, eoi = clear + 1, out = [];
  let size = min + 1, dict = [], prev = null, bit = 0;
  const reset = () => { dict = Array.from({ length: clear + 2 }, (_, i) => [i]); size = min + 1; prev = null; };
  reset();
  while (out.length <= count) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= ((bytes[bit >> 3] >> (bit & 7)) & 1) << i;
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    let entry;
    if (code < dict.length) entry = dict[code];
    else if (code === dict.length && prev) entry = [...prev, prev[0]];
    else throw new Error(`bad code ${code}`);
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length === 1 << size && size < 12) size++;
  }
  return out;
}

test('GIF encoder round trip: palette, LZW, delta frames', () => {
  const w = 97, h = 61, enc = new GifEncoder(w, h, { delay: 0.1, dither: 0 });
  const frame = (k) => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, inBox = x >= 10 + k * 7 && x < 30 + k * 7 && y > 15 && y < 40;
      px[i] = inBox ? 230 : (x * 255) / w; px[i + 1] = inBox ? 40 : (y * 255) / h; px[i + 2] = inBox ? 30 : 128; px[i + 3] = 255;
    }
    return px;
  };
  const input = [0, 1, 2, 3].map(frame);
  enc.palette(input);
  input.forEach((f) => enc.add(f));
  const gif = decodeGIF(enc.finish());
  assert.equal(gif.w, w);
  assert.equal(gif.frames.length, 4);
  assert.ok(gif.loop);
  assert.equal(gif.frames[1].delay, 10);
  for (let k = 0; k < 4; k++) {
    let err = 0;
    const a = gif.frames[k].pixels, b = input[k];
    for (let i = 0; i < a.length; i += 4) err = Math.max(err, Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    assert.ok(err < 40, `frame ${k} max channel error ${err}`);
    const box = ((25 * w) + 20 + k * 7) * 4; // inside the moving red box
    assert.ok(a[box] > 200 && a[box + 1] < 80, `frame ${k} shows the box`);
  }
});

test('GIF encoder handles long runs (dictionary resets)', () => {
  const w = 300, h = 200, enc = new GifEncoder(w, h, { dither: 1 });
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i += 4) { const v = (i * 2654435761) >>> 24; px[i] = v; px[i + 1] = 255 - v; px[i + 2] = (v * 7) & 255; px[i + 3] = 255; }
  enc.add(px);
  enc.add(px);
  const gif = decodeGIF(enc.finish());
  assert.equal(gif.frames.length, 2);
  assert.deepEqual(gif.frames[0].pixels, gif.frames[1].pixels, 'an unchanged frame keeps the image');
});
