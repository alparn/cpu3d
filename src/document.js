// Scene document: the single source of truth. Plain JSON, so it can be saved, diffed,
// sent over the wire and written by agents. Every mutation goes through commit() which
// validates, records undo history and notifies listeners (editor, SSE clients, autosave).

import { buildShape } from './recipes.js';
import { isValidTextureSrc } from './textures.js';
import { mat4 } from './math.js';

const HISTORY = 100;
const GEOMETRY_CACHE = 128;

export function createEmptyScene() {
  return {
    format: 'cpu3d-scene',
    version: 1,
    camera: { yaw: 35, pitch: 25, distance: 9, target: [0, 0.8, 0] },
    environment: {
      background: { top: '#171a21', bottom: '#545a66' },
      fog: { near: 16, far: 45 },
      light: { direction: [0.55, 0.85, 0.4], color: '#fff5e6', intensity: 1, softness: 0.1 },
      lights: [],
      reflections: 'sky',
      ground: true,
    },
    objects: [],
  };
}

// ---- value helpers --------------------------------------------------------------------------
const fail = (msg) => { throw new Error(msg); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function parseColor(c, name = 'color') {
  if (typeof c === 'string') {
    let h = c.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(h)) h = '#' + [...h.slice(1)].map((x) => x + x).join('');
    if (/^#[0-9a-f]{6}$/.test(h)) return h;
  } else if (Array.isArray(c) && c.length === 3 && c.every(isNum)) {
    const k = c.some((v) => v > 1) ? 1 : 255; // accept 0..1 or 0..255
    return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0')).join('');
  }
  return fail(`"${name}" must be a hex color like "#ff8800" or [r, g, b]`);
}

export const colorToRGB = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

function vec3(v, name) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) fail(`"${name}" must be [x, y, z]`);
  return [...v];
}
function scale3(v) {
  if (isNum(v)) return [v, v, v];
  return vec3(v, 'scale');
}
function range(v, name, min, max) {
  if (!isNum(v) || v < min || v > max) fail(`"${name}" must be a number between ${min} and ${max}`);
  return v;
}

function normalizeMaterial(m = {}, base = {}) {
  if (typeof m !== 'object' || Array.isArray(m)) fail('"material" must be an object');
  const out = { color: '#c8c8c8', specular: 0.25, shininess: 24, emissive: 0, flat: false, doubleSided: false, ...base };
  if (m.color !== undefined) out.color = parseColor(m.color, 'material.color');
  if (m.specular !== undefined) out.specular = range(m.specular, 'material.specular', 0, 2);
  if (m.shininess !== undefined) out.shininess = range(m.shininess, 'material.shininess', 1, 256);
  if (m.emissive !== undefined) out.emissive = range(m.emissive, 'material.emissive', 0, 10);
  if (m.metalness !== undefined) out.metalness = range(m.metalness, 'material.metalness', 0, 1);
  if (m.roughness !== undefined) {
    if (m.roughness === null) delete out.roughness;
    else out.roughness = range(m.roughness, 'material.roughness', 0, 1);
  }
  if (m.texture !== undefined) {
    if (m.texture === null || m.texture === '') delete out.texture;
    else if (!isValidTextureSrc(m.texture)) fail('"material.texture" must be a PNG path inside the project (e.g. "examples/textures/screen.png") or a "data:image/png;base64,..." URL');
    else out.texture = m.texture;
  }
  if (m.flat !== undefined) out.flat = !!m.flat;
  if (m.doubleSided !== undefined) out.doubleSided = !!m.doubleSided;
  return out;
}

// main light: direction, color, intensity, softness (shadow penumbra); extra lights cast no shadows
function normalizeLight(l, base, name, main = true) {
  if (!l || typeof l !== 'object') fail(`"${name}" must be an object`);
  const out = {
    direction: l.direction !== undefined ? vec3(l.direction, `${name}.direction`) : base.direction,
    color: l.color !== undefined ? parseColor(l.color, `${name}.color`) : base.color,
    intensity: l.intensity !== undefined ? range(l.intensity, `${name}.intensity`, 0, 20) : base.intensity ?? 1,
  };
  if (main) out.softness = l.softness !== undefined ? range(l.softness, `${name}.softness`, 0, 1) : base.softness ?? 0.1;
  return out;
}

// ---- document -------------------------------------------------------------------------------
export class SceneDocument {
  constructor(data = null) {
    this.listeners = new Set();
    this.geometries = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.revision = 0;
    this.data = createEmptyScene();
    this.nextId = 1;
    if (data) this._replace(data);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event) {
    for (const fn of this.listeners) {
      try { fn(event); } catch (e) { console.error(e); }
    }
  }

  // Non-mutating events (an agent looked at the scene, rendered a view, ...)
  activity(activity) {
    this._emit({ type: 'activity', revision: this.revision, activity: { time: Date.now(), ...activity } });
  }

  geometry(shape) {
    const key = JSON.stringify(shape);
    let g = this.geometries.get(key);
    if (g) {
      this.geometries.delete(key);
      this.geometries.set(key, g); // LRU refresh
      return g;
    }
    g = buildShape(shape);
    this.geometries.set(key, g);
    if (this.geometries.size > GEOMETRY_CACHE) this.geometries.delete(this.geometries.keys().next().value);
    return g;
  }

  getObject(id) {
    const o = this.data.objects.find((x) => x.id === id);
    if (!o) fail(`no object with id "${id}". Call get_scene to see the existing ids.`);
    return o;
  }

  // All mutations: run on a copy, commit only if nothing threw.
  commit(activity, mutate) {
    const draft = structuredClone(this.data);
    const result = mutate(draft);
    this.undoStack.push(JSON.stringify(this.data));
    if (this.undoStack.length > HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.data = draft;
    this.revision++;
    this._emit({ type: 'change', revision: this.revision, activity: { time: Date.now(), ...activity } });
    return result;
  }

  _normalizeObject(o, id) {
    if (!o || typeof o !== 'object') fail('each object must be an object');
    if (!o.shape) fail('object is missing "shape" (e.g. { "type": "box" }). Call get_shape_reference for all shapes.');
    this.geometry(o.shape); // validates the recipe
    return {
      id,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : o.shape.type,
      shape: structuredClone(o.shape),
      position: o.position !== undefined ? vec3(o.position, 'position') : [0, 0, 0],
      rotation: o.rotation !== undefined ? vec3(o.rotation, 'rotation') : [0, 0, 0],
      scale: o.scale !== undefined ? scale3(o.scale) : [1, 1, 1],
      material: normalizeMaterial(o.material),
      visible: o.visible !== undefined ? !!o.visible : true,
    };
  }

  addObjects(list, activity) {
    if (!Array.isArray(list) || !list.length) fail('"objects" must be a non-empty array');
    return this.commit(activity, (d) => list.map((o, i) => {
      let obj;
      try { obj = this._normalizeObject(o, `obj_${this.nextId++}`); } catch (e) { fail(`objects[${i}]: ${e.message}`); }
      d.objects.push(obj);
      return obj;
    }));
  }

  updateObject(id, patch, activity) {
    return this.commit(activity, (d) => {
      const o = d.objects.find((x) => x.id === id);
      if (!o) fail(`no object with id "${id}". Call get_scene to see the existing ids.`);
      if (patch.shape !== undefined) { this.geometry(patch.shape); o.shape = structuredClone(patch.shape); }
      if (patch.name !== undefined) o.name = String(patch.name).slice(0, 80);
      if (patch.position !== undefined) o.position = vec3(patch.position, 'position');
      if (patch.rotation !== undefined) o.rotation = vec3(patch.rotation, 'rotation');
      if (patch.scale !== undefined) o.scale = scale3(patch.scale);
      if (patch.material !== undefined) o.material = normalizeMaterial(patch.material, o.material);
      if (patch.visible !== undefined) o.visible = !!patch.visible;
      return o;
    });
  }

  removeObjects(ids, activity) {
    if (!Array.isArray(ids) || !ids.length) fail('"ids" must be a non-empty array');
    for (const id of ids) this.getObject(id);
    return this.commit(activity, (d) => {
      d.objects = d.objects.filter((o) => !ids.includes(o.id));
      return ids;
    });
  }

  clear(activity) {
    return this.commit(activity, (d) => { d.objects = []; });
  }

  setCamera(patch, activity) {
    return this.commit(activity, (d) => {
      const c = d.camera;
      if (patch.yaw !== undefined) c.yaw = range(patch.yaw, 'yaw', -1e5, 1e5);
      if (patch.pitch !== undefined) c.pitch = range(patch.pitch, 'pitch', -89, 89);
      if (patch.distance !== undefined) c.distance = range(patch.distance, 'distance', 0.1, 1e4);
      if (patch.target !== undefined) c.target = vec3(patch.target, 'target');
      return c;
    });
  }

  setEnvironment(patch, activity) {
    return this.commit(activity, (d) => {
      const e = d.environment;
      if (patch.background !== undefined) {
        const b = patch.background;
        if (typeof b === 'string' || Array.isArray(b)) { const c = parseColor(b, 'background'); e.background = { top: c, bottom: c }; }
        else e.background = { top: parseColor(b.top ?? e.background.top, 'background.top'), bottom: parseColor(b.bottom ?? e.background.bottom, 'background.bottom') };
      }
      if (patch.fog !== undefined) {
        if (patch.fog === null || patch.fog === false) e.fog = null;
        else e.fog = { near: range(patch.fog.near, 'fog.near', 0, 1e5), far: range(patch.fog.far, 'fog.far', 0, 1e5) };
      }
      if (patch.light !== undefined) e.light = normalizeLight(patch.light, e.light, 'light');
      if (patch.lights !== undefined) {
        if (!Array.isArray(patch.lights) || patch.lights.length > 4) fail('"lights" must be an array of up to 4 extra lights');
        e.lights = patch.lights.map((l, i) => normalizeLight(l, { direction: [0, 1, 0], color: '#ffffff', intensity: 0.5 }, `lights[${i}]`, false));
      }
      if (patch.reflections !== undefined) {
        if (!['sky', 'studio', 'none'].includes(patch.reflections)) fail('"reflections" must be "sky", "studio" or "none"');
        e.reflections = patch.reflections;
      }
      if (patch.ground !== undefined) e.ground = !!patch.ground;
      return e;
    });
  }

  load(data, activity) {
    const prev = JSON.stringify(this.data);
    this._replace(data);
    this.undoStack.push(prev);
    this.redoStack = [];
    this.revision++;
    this._emit({ type: 'change', revision: this.revision, activity: { time: Date.now(), ...activity } });
  }

  _replace(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.objects)) fail('scene must be an object with an "objects" array');
    const base = createEmptyScene();
    const next = { ...base, camera: { ...base.camera, ...(data.camera || {}) },
      environment: { ...base.environment, ...(data.environment || {}) }, objects: [] };
    // sanitize camera / environment, falling back to defaults for anything invalid
    const c = next.camera, e = next.environment, safe = (fn, def) => { try { return fn(); } catch { return def; } };
    for (const k of ['yaw', 'pitch', 'distance']) if (!isNum(c[k])) c[k] = base.camera[k];
    c.pitch = Math.max(-89, Math.min(89, c.pitch));
    c.distance = Math.max(0.1, c.distance);
    c.target = safe(() => vec3(c.target, 'target'), base.camera.target);
    e.background = {
      top: safe(() => parseColor(e.background?.top), base.environment.background.top),
      bottom: safe(() => parseColor(e.background?.bottom), base.environment.background.bottom),
    };
    e.fog = e.fog && isNum(e.fog.near) && isNum(e.fog.far) ? { near: e.fog.near, far: e.fog.far } : null;
    e.light = safe(() => normalizeLight(e.light || {}, base.environment.light, 'light'), base.environment.light);
    e.lights = safe(() => (Array.isArray(e.lights) ? e.lights.slice(0, 4).map((l, i) => normalizeLight(l, { direction: [0, 1, 0], color: '#ffffff', intensity: 0.5 }, `lights[${i}]`, false)) : []), []);
    e.reflections = ['sky', 'studio', 'none'].includes(e.reflections) ? e.reflections : 'sky';
    e.ground = e.ground !== false;

    let maxId = 0;
    data.objects.forEach((o, i) => {
      const m = /^obj_(\d+)$/.exec(o.id || '');
      if (m) maxId = Math.max(maxId, +m[1]);
      let obj;
      try { obj = this._normalizeObject(o, o.id || null); } catch (e) { fail(`objects[${i}]: ${e.message}`); }
      next.objects.push(obj);
    });
    this.nextId = Math.max(this.nextId, maxId + 1);
    for (const o of next.objects) if (!o.id || next.objects.filter((x) => x.id === o.id).length > 1) o.id = `obj_${this.nextId++}`;
    this.data = next;
  }

  undo(activity) { return this._travel(this.undoStack, this.redoStack, activity); }
  redo(activity) { return this._travel(this.redoStack, this.undoStack, activity); }

  _travel(from, to, activity) {
    if (!from.length) return false;
    to.push(JSON.stringify(this.data));
    this.data = JSON.parse(from.pop());
    this.revision++;
    this._emit({ type: 'change', revision: this.revision, activity: { time: Date.now(), ...activity } });
    return true;
  }

  // World-space axis-aligned bounds of an object.
  bounds(o) { return worldBounds(o, this.geometry(o.shape)); }

  summary() {
    let triangles = 0;
    const objects = this.data.objects.map((o) => {
      const t = this.geometry(o.shape).triangleCount;
      triangles += t;
      return { ...o, triangles: t, bounds: this.bounds(o) };
    });
    return { ...this.data, objects, stats: { objects: objects.length, triangles, revision: this.revision } };
  }
}

export function objectMatrix(o) {
  const d = Math.PI / 180;
  return mat4.compose(mat4.create(), o.position, [o.rotation[0] * d, o.rotation[1] * d, o.rotation[2] * d], o.scale);
}

// World-space AABB of an object, from its geometry's transformed bounding box corners.
export function worldBounds(o, g) {
  const m = objectMatrix(o);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? g.max[0] : g.min[0], y = i & 2 ? g.max[1] : g.min[1], z = i & 4 ? g.max[2] : g.min[2];
    const w = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], w[a]); max[a] = Math.max(max[a], w[a]); }
  }
  const r = (v) => v.map((x) => Math.round(x * 1000) / 1000);
  return { min: r(min), max: r(max) };
}
