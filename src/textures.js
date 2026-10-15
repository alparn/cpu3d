// Texture registry shared by editor and server. Textures are referenced by `src`:
//   - a PNG inside the project, e.g. "examples/textures/screen.png" (no "..", no absolute paths)
//   - a data URL "data:image/png;base64,..." (how agents send their own images)
// Loading is async and platform specific (setTextureLoader); rendering only uses textures that
// are already loaded and asks for a redraw when one arrives.

const cache = new Map(); // src -> { tex, promise, error }
let loader = null;

export const TEXTURE_SRC = /^(data:image\/png;base64,[A-Za-z0-9+/=]+|[A-Za-z0-9_\-./]+\.png)$/;
export const isValidTextureSrc = (s) => typeof s === 'string' && s.length < 6_000_000 && TEXTURE_SRC.test(s) && !s.includes('..') && !s.startsWith('/');

// fn(src) -> Promise<{ width, height, data: RGBA bytes }>
export function setTextureLoader(fn) { loader = fn; }

function toTexture({ width, height, data }) {
  const px = new Uint32Array(width * height);
  let r = 0, g = 0, b = 0;
  for (let i = 0, o = 0; i < px.length; i++, o += 4) {
    px[i] = 0xff000000 | (data[o + 2] << 16) | (data[o + 1] << 8) | data[o];
    r += data[o]; g += data[o + 1]; b += data[o + 2];
  }
  const n = px.length || 1;
  return { w: width, h: height, px, avg: [r / n / 255, g / n / 255, b / n / 255] };
}

export function loadTexture(src) {
  let e = cache.get(src);
  if (!e) {
    e = {};
    cache.set(src, e);
    e.promise = (loader ? loader(src) : Promise.reject(new Error('no texture loader')))
      .then((img) => { e.tex = toTexture(img); return e.tex; })
      .catch((err) => { e.error = err; console.warn(`[cpu3d] texture ${src.slice(0, 60)}: ${err.message}`); return null; });
  }
  return e.promise;
}

// Synchronous lookup for the renderer: the texture if loaded, otherwise null (starts loading).
export function getTexture(src, onLoad) {
  const e = cache.get(src);
  if (e?.tex) return e.tex;
  if (!e) loadTexture(src).then((t) => t && onLoad && onLoad());
  else if (onLoad && !e.error) e.promise.then((t) => t && onLoad());
  return null;
}

export const loadTextures = (srcs) => Promise.all([...new Set(srcs)].map(loadTexture));
