// Turns a scene document into something the renderer can draw (shared by editor and server).
import { Mesh, Camera } from './renderer.js';
import { grid } from './geometry.js';
import { colorToRGB, objectMatrix } from './document.js';
import { vec3 } from './math.js';

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

// geometryFor(shape) -> Geometry, normally SceneDocument#geometry (cached)
export function buildRenderScene(data, geometryFor, { selected = [], showGround = true } = {}) {
  const env = data.environment, meshes = [];
  if (env.ground && showGround) meshes.push(new Mesh(ground(), { specular: 0 }));
  for (const o of data.objects) {
    if (!o.visible) continue;
    const m = new Mesh(geometryFor(o.shape), {
      color: colorToRGB(o.material.color), specular: o.material.specular,
      shininess: o.material.shininess, doubleSided: o.material.doubleSided,
    });
    m.matrix = objectMatrix(o);
    m.matrixAutoUpdate = false;
    m.flat = o.material.flat;
    m.wireframe = selected.includes(o.id) ? SELECTION_COLOR : false;
    m.objectId = o.id;
    meshes.push(m);
  }
  const bottom = colorToRGB(env.background.bottom);
  return {
    meshes,
    background: { top: colorToRGB(env.background.top), bottom },
    light: { direction: env.light.direction, color: colorToRGB(env.light.color), sky: [0.3, 0.33, 0.4], ground: [0.12, 0.1, 0.09] },
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

// Ray through a screen position (NDC -1..1) of the camera.
export function pick(meshes, camera, ndcX, ndcY, aspect) {
  const f = vec3.normalize(vec3.sub(camera.target, camera.position));
  const r = vec3.normalize(vec3.cross(f, camera.up));
  const u = vec3.cross(r, f);
  const th = Math.tan(((camera.fov / 2) * Math.PI) / 180);
  const dir = vec3.normalize(vec3.add(f, vec3.add(vec3.scale(r, ndcX * th * aspect), vec3.scale(u, ndcY * th))));
  return raycast(meshes, camera.position, dir);
}
