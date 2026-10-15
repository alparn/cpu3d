// Tiny PNG encoder (RGBA8) for headless snapshots in Node.
import { deflateSync, inflateSync } from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

export function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bit, RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Minimal PNG decoder: 8-bit RGB / RGBA / gray(+alpha), non-interlaced, all five row filters.
// Returns { width, height, data: Uint8ClampedArray RGBA }.
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file');
  let i = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), kind = buf.toString('ascii', i + 4, i + 8), data = buf.subarray(i + 8, i + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    i += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels || interlace) throw new Error('unsupported PNG (needs 8-bit RGB/RGBA/gray, non-interlaced)');
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[dst + x - channels] : 0, b = y ? px[dst - stride + x] : 0;
      const c = x >= channels && y ? px[dst - stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, s = 0; p < width * height; p++, s += channels) {
    const o = p * 4;
    if (channels >= 3) { out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; } else { out[o] = out[o + 1] = out[o + 2] = px[s]; }
    out[o + 3] = channels === 4 ? px[s + 3] : channels === 2 ? px[s + 1] : 255;
  }
  return { width, height, data: out };
}
