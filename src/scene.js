// Turns a scene document into something the renderer can draw (shared by editor and server).
import { Mesh, Camera } from './renderer.js';
import { grid } from './geometry.js';
import { colorToRGB, objectMatrix } from './document.js';
import { vec3, mat4 } from './math.js';

let groundGeometry = null;
const ground = () => (groundGeometry ??= grid(40, 40, 40, 40).setFaceColors((x, y, z) =>
  (Math.floor(x) + Math.floor(z)) & 1 ? [0.42, 0.42, 0.44] : [0.33, 0.33, 0.35]));

export const SELECTION_COLOR = [1, 0.62, 0.25];

// Wavefront OBJ text of the given objects in world space (used by export_obj and the size readouts).
export function exportOBJ(objects, geometryFor) {
  const out = ['# exported by cpu3d'];
  let base = 1;
  for (const o of objects) {
    const g = geometryFor(o.shape), m = objectMatrix(o), P = g.positions, I = g.indices;
    out.push(`o ${o.name.replace(/\s+/g, '_')}`);
    for (let k = 0; k < P.length; k += 3) {
      const x = P[k], y = P[k + 1], z = P[k + 2];
      out.push(`v ${+(m[0] * x + m[4] * y + m[8] * z + m[12]).toFixed(5)} ${+(m[1] * x + m[5] * y + m[9] * z + m[13]).toFixed(5)} ${+(m[2] * x + m[6] * y + m[10] * z + m[14]).toFixed(5)}`);
    }
    // mirrored transforms flip the winding
    const flip = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]) < 0;
    for (let t = 0; t < I.length; t += 3) out.push(flip ? `f ${I[t] + base} ${I[t + 2] + base} ${I[t + 1] + base}` : `f ${I[t] + base} ${I[t + 1] + base} ${I[t + 2] + base}`);
    base += P.length / 3;
  }
  return out.join('\n') + '\n';
}

// ---- animation ------------------------------------------------------------------------------
const D2R = Math.PI / 180, TMP_A = mat4.create(), TMP_B = mat4.create(), TMP_C = mat4.create();
const wave = (t, period, phase) => Math.sin(2 * Math.PI * (t / period + phase));
const TRANSFORM_KEYS = (keys) => keys?.some((k) => k.position || k.rotation || k.scale);
export const hasMotion = (o) => !!(o.animation && (o.animation.spin || o.animation.swing || o.animation.bob || o.animation.orbit || o.animation.flow || TRANSFORM_KEYS(o.animation.keys)));

// flow: position along the way (0..1) and the grow / shrink factor at both ends
const flowAt = (f, t) => {
  const k = (((t * f.speed) / f.distance + f.phase) % 1 + 1) % 1;
  const e = f.fade > 0 ? Math.min(1, k / f.fade, (1 - k) / f.fade) : 1;
  return { k, fade: e * e * (3 - 2 * e) };
};

// ---- keyframes
const smooth = (u) => u * u * (3 - 2 * u);
const lerp = (a, b, u) => (Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * u) : a + (b - a) * u);
// cubic Hermite with Catmull-Rom tangents (for uneven key spacing): passes through every key with continuous velocity
function hermite(k, i, ch, t) {
  const a = k[i], b = k[i + 1], prev = k[i - 1] || a, next = k[i + 2] || b, dt = b.t - a.t, u = (t - a.t) / dt;
  const u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const one = (va, vb, vp, vn) => h00 * va + h01 * vb + (h10 * (vb - vp) / (b.t - prev.t) + h11 * (vn - va) / (next.t - a.t)) * dt;
  const A = a[ch], B = b[ch], P = prev[ch], N = next[ch];
  return Array.isArray(A) ? A.map((v, j) => one(v, B[j], P[j], N[j])) : one(A, B, P, N);
}

// value of one channel at time t from the keys that define it (held before the first and after the last key)
export function sampleKeys(keys, ch, t, ease = 'smooth') {
  const k = keys.filter((x) => x[ch] !== undefined);
  if (!k.length) return undefined;
  if (t <= k[0].t) return k[0][ch];
  const last = k[k.length - 1];
  if (t >= last.t) return last[ch];
  let i = 0;
  while (k[i + 1].t < t) i++;
  const a = k[i], b = k[i + 1], u = (t - a.t) / (b.t - a.t);
  if (ease === 'step') return a[ch];
  if (ease === 'linear') return lerp(a[ch], b[ch], u);
  if (ease === 'spline') return hermite(k, i, ch, t);
  return lerp(a[ch], b[ch], smooth(u));
}

// the object with its keyframed transform at time t (unchanged if it has no keys)
export function keyed(o, t) {
  const keys = o.animation?.keys;
  if (!keys) return o;
  const e = o.animation.ease;
  return { ...o, position: sampleKeys(keys, 'position', t, e) ?? o.position, rotation: sampleKeys(keys, 'rotation', t, e) ?? o.rotation,
    scale: sampleKeys(keys, 'scale', t, e) ?? o.scale };
}

// camera state at time t: the scene camera, overridden by the camera path if there is one
export function cameraAt(data, t) {
  const path = data.animation?.camera, c = data.camera;
  if (!path) return c;
  const s = (ch) => sampleKeys(path.keys, ch, t, path.ease) ?? c[ch];
  return { yaw: s('yaw'), pitch: Math.max(-89, Math.min(89, s('pitch'))), distance: Math.max(0.1, s('distance')), target: s('target') };
}
export const hasCameraPath = (data) => !!data.animation?.camera;

// world rotation around an axis through point p, applied on the left: m = T(p) R T(-p) m
function rotateAround(m, p, axis, deg) {
  mat4.axisAngle(TMP_A, axis, deg * D2R);
  mat4.translation(TMP_B, [-p[0], -p[1], -p[2]]);
  mat4.multiply(TMP_A, TMP_A, TMP_B);
  mat4.translation(TMP_C, p);
  mat4.multiply(TMP_A, TMP_C, TMP_A);
  return mat4.multiply(m, TMP_A, m);
}
const rotateLocal = (m, axis, deg) => mat4.multiply(m, m, mat4.axisAngle(TMP_A, axis, deg * D2R));

// object matrix at time t (seconds)
export function animatedMatrix(o, t) {
  const a = o.animation;
  if (!a) return objectMatrix(o);
  const m = objectMatrix(keyed(o, t));
  const turn = (spec, deg) => (spec.pivot ? rotateAround(m, spec.pivot, spec.axis, deg) : rotateLocal(m, spec.axis, deg));
  if (a.spin) turn(a.spin, a.spin.speed * (a.spin.step ? a.spin.step * Math.floor(t / a.spin.step + 1e-9) : t));
  if (a.swing) turn(a.swing, a.swing.amplitude * wave(t, a.swing.period, a.swing.phase));
  if (a.orbit) rotateAround(m, a.orbit.center, a.orbit.axis, a.orbit.speed * t);
  if (a.bob) {
    const ax = a.bob.axis, l = Math.hypot(...ax) || 1, d = (a.bob.amplitude * wave(t, a.bob.period, a.bob.phase)) / l;
    mat4.multiply(m, mat4.translation(TMP_A, [ax[0] * d, ax[1] * d, ax[2] * d]), m);
  }
  if (a.flow) {
    const f = a.flow, { k, fade } = flowAt(f, t), ax = f.axis, d = (k * f.distance) / (Math.hypot(...ax) || 1);
    if (fade < 1) { const sc = Math.max(1e-3, fade); TMP_A.fill(0); TMP_A[0] = TMP_A[5] = TMP_A[10] = sc; TMP_A[15] = 1; mat4.multiply(m, m, TMP_A); }
    mat4.multiply(m, mat4.translation(TMP_A, [ax[0] * d, ax[1] * d, ax[2] * d]), m);
  }
  return m;
}

// emissive at time t: pulse scales the material's emissive (or 1 if the material has none)
export function animatedEmissive(o, t) {
  const keys = o.animation?.keys, p = o.animation?.pulse, f = o.animation?.flow;
  const base = (keys && sampleKeys(keys, 'emissive', t, o.animation.ease)) ?? (o.material.emissive || 0);
  const fade = f ? flowAt(f, t).fade : 1; // flowing glow fades in and out with its size
  if (!p) return base * fade;
  const w = wave(t, p.period, p.phase), k = p.blink ? (w > 0 ? 1 : 0) : 0.5 + 0.5 * w;
  return (base || 1) * (p.min + (p.max - p.min) * k) * fade;
}

// Update the meshes of a render scene to time t in place (cheap: matrices and emissive only).
// Bumps scene.version when something moved, so shadows are rebuilt.
export function updateAnimation(scene, t) {
  let moved = false;
  for (const m of scene.meshes) {
    const o = m.object;
    if (!o || !o.animation) continue;
    if (hasMotion(o)) { m.matrix = animatedMatrix(o, t); moved = true; }
    if (o.animation.pulse || o.animation.keys || o.animation.flow) m.emissive = animatedEmissive(o, t);
  }
  if (moved) scene.version = (scene.version || 0) + 1;
  return moved;
}

export const sceneHasAnimation = (data) => !!data.animation?.camera || data.objects.some((o) => o.animation);

// geometryFor(shape) -> Geometry, normally SceneDocument#geometry (cached)
export function buildRenderScene(data, geometryFor, { selected = [], showGround = true, time = 0 } = {}) {
  const env = data.environment, meshes = [];
  if (env.ground && showGround) meshes.push(new Mesh(ground(), { specular: 0 }));
  for (const o of data.objects) {
    if (!o.visible) continue;
    const m = new Mesh(geometryFor(o.shape), {
      color: colorToRGB(o.material.color), specular: o.material.specular,
      shininess: o.material.shininess, doubleSided: o.material.doubleSided, emissive: o.material.emissive || 0,
      metalness: o.material.metalness || 0, roughness: o.material.roughness, texture: o.material.texture || null,
    });
    m.matrix = o.animation ? animatedMatrix(o, time) : objectMatrix(o);
    m.matrixAutoUpdate = false;
    m.object = o;
    m.dynamic = hasMotion(o); // moving meshes stay out of the cached static shadow map
    if (o.animation?.pulse || o.animation?.keys || o.animation?.flow) m.emissive = animatedEmissive(o, time);
    m.flat = o.material.flat;
    m.wireframe = selected.includes(o.id) ? SELECTION_COLOR : false;
    m.objectId = o.id;
    meshes.push(m);
  }
  const bottom = colorToRGB(env.background.bottom);
  return {
    meshes,
    background: { top: colorToRGB(env.background.top), bottom },
    light: {
      direction: env.light.direction, color: colorToRGB(env.light.color), intensity: env.light.intensity ?? 1, softness: env.light.softness ?? 0.1,
      sky: [0.3, 0.33, 0.4], ground: [0.12, 0.1, 0.09],
    },
    lights: (env.lights || []).map((l) => ({ direction: l.direction, color: colorToRGB(l.color), intensity: l.intensity ?? 0.5 })),
    reflections: env.reflections || 'sky',
    fog: env.fog ? { near: env.fog.near, far: env.fog.far, color: bottom } : null,
  };
}

// camera state { yaw, pitch (degrees), distance, target } -> Camera
export function cameraFromState(state, camera = new Camera()) {
  const y = (state.yaw * Math.PI) / 180, p = (state.pitch * Math.PI) / 180, t = state.target, d = state.distance;
  camera.target = [...t];
  camera.position = [t[0] + d * Math.cos(p) * Math.sin(y), t[1] + d * Math.sin(p), t[2] + d * Math.cos(p) * Math.cos(y)];
  camera.near = Math.max(0.01, d / 500);
  camera.far = Math.max(200, d * 20);
  return camera;
}

// Camera state that frames the given world bounds.
export function frameBounds(bounds, base = { yaw: 35, pitch: 25 }, fov = 55) {
  const c = [0, 1, 2].map((a) => (bounds.min[a] + bounds.max[a]) / 2);
  const r = Math.max(0.25, Math.hypot(...[0, 1, 2].map((a) => bounds.max[a] - bounds.min[a])) / 2);
  return { yaw: base.yaw, pitch: base.pitch, target: c, distance: (r / Math.sin(((fov / 2) * Math.PI) / 180)) * 1.1 };
}

export function unionBounds(list) {
  if (!list.length) return { min: [-1, 0, -1], max: [1, 1, 1] };
  return {
    min: [0, 1, 2].map((a) => Math.min(...list.map((b) => b.min[a]))),
    max: [0, 1, 2].map((a) => Math.max(...list.map((b) => b.max[a]))),
  };
}

// Closest ray hit (Moeller-Trumbore) against meshes that carry an objectId -> { mesh, distance } or null.
export function raycast(meshes, origin, dir) {
  let best = null;
  for (const mesh of meshes) {
    if (mesh.objectId === undefined) continue;
    const g = mesh.geometry, m = mesh.matrix, P = g.positions, I = g.indices;
    // bounding sphere test
    const c = g.center;
    const cx = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12] - origin[0];
    const cy = m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13] - origin[1];
    const cz = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14] - origin[2];
    const s = Math.sqrt(Math.max(m[0] ** 2 + m[1] ** 2 + m[2] ** 2, m[4] ** 2 + m[5] ** 2 + m[6] ** 2, m[8] ** 2 + m[9] ** 2 + m[10] ** 2));
    const tc = cx * dir[0] + cy * dir[1] + cz * dir[2], rad = g.radius * s;
    if (cx * cx + cy * cy + cz * cz - tc * tc > rad * rad) continue;
    const W = new Float64Array(P.length);
    for (let k = 0; k < P.length; k += 3) {
      const x = P[k], y = P[k + 1], z = P[k + 2];
      W[k] = m[0] * x + m[4] * y + m[8] * z + m[12];
      W[k + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      W[k + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, cc = I[t + 2] * 3;
      const e1x = W[b] - W[a], e1y = W[b + 1] - W[a + 1], e1z = W[b + 2] - W[a + 2];
      const e2x = W[cc] - W[a], e2y = W[cc + 1] - W[a + 1], e2z = W[cc + 2] - W[a + 2];
      const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det, tx = origin[0] - W[a], ty = origin[1] - W[a + 1], tz = origin[2] - W[a + 2];
      const uu = (tx * px + ty * py + tz * pz) * inv;
      if (uu < 0 || uu > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const vv = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
      if (vv < 0 || uu + vv > 1) continue;
      const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (dist > 1e-6 && (!best || dist < best.distance)) best = { mesh, distance: dist };
    }
  }
  return best;
}

// World-space ray through a screen position (NDC -1..1) of the camera.
export function screenRay(camera, ndcX, ndcY, aspect) {
  const f = vec3.normalize(vec3.sub(camera.target, camera.position));
  const r = vec3.normalize(vec3.cross(f, camera.up));
  const u = vec3.cross(r, f);
  const th = Math.tan(((camera.fov / 2) * Math.PI) / 180);
  const dir = vec3.normalize(vec3.add(f, vec3.add(vec3.scale(r, ndcX * th * aspect), vec3.scale(u, ndcY * th))));
  return { origin: [...camera.position], dir };
}

export function pick(meshes, camera, ndcX, ndcY, aspect) {
  const { origin, dir } = screenRay(camera, ndcX, ndcY, aspect);
  return raycast(meshes, origin, dir);
}

// Intersection of a ray with the plane through `point` with normal `n`, or null if parallel / behind.
export function rayPlane(ray, point, n) {
  const d = vec3.dot(ray.dir, n);
  if (Math.abs(d) < 1e-6) return null;
  const t = vec3.dot(vec3.sub(point, ray.origin), n) / d;
  return t > 0 && t < 1e5 ? vec3.add(ray.origin, vec3.scale(ray.dir, t)) : null;
}
