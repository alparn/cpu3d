// Scene document: the single source of truth. Plain JSON, so it can be saved, diffed,
// sent over the wire and written by agents. Every mutation goes through commit() which
// validates, records undo history and notifies listeners (editor, SSE clients, autosave).

import { buildShape } from './recipes.js';
import { isValidTextureSrc } from './textures.js';
import { mat4 } from './math.js';
import { PATTERN_TYPES } from './patterns.js';

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
    animation: { duration: 12 },
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

// procedural pattern { type, colors: [2..3 colours], scale (size of one feature in units), bump 0..2 }
const PATTERN_SCALE = { wood: 0.25, marble: 0.6, leather: 0.012, carbon: 0.02, fabric: 0.006, brushed: 1, checker: 0.25, stripes: 0.2, knurl: 0.02, concrete: 0.5, brick: 0.65 };
const PATTERN_BUMP = { wood: 0.35, marble: 0, leather: 0.9, carbon: 0.5, fabric: 0.8, brushed: 0.12, checker: 0, stripes: 0, knurl: 1.2, concrete: 0.2, brick: 0.9 };
function normalizePattern(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('"material.pattern" must be an object like { "type": "wood", "colors": ["#8a5a35", "#4a2c18"] }');
  if (!PATTERN_TYPES.includes(p.type)) fail(`"material.pattern.type" must be one of ${PATTERN_TYPES.join(', ')}`);
  if (!Array.isArray(p.colors) || p.colors.length < 2 || p.colors.length > 3) fail('"material.pattern.colors" must be 2 or 3 colours');
  return { type: p.type, colors: p.colors.map((c, i) => parseColor(c, `material.pattern.colors[${i}]`)),
    scale: p.scale === undefined ? PATTERN_SCALE[p.type] : range(p.scale, 'material.pattern.scale', 0.0001, 1000),
    bump: p.bump === undefined ? PATTERN_BUMP[p.type] : range(p.bump, 'material.pattern.bump', 0, 2) };
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
  if (m.mapping !== undefined) {
    if (m.mapping === null || m.mapping === 'planar') delete out.mapping;
    else if (!['box', 'cylinder', 'sphere'].includes(m.mapping)) fail('"material.mapping" must be "planar", "box", "cylinder" or "sphere"');
    else out.mapping = m.mapping;
  }
  if (m.repeat !== undefined) {
    if (m.repeat === null || m.repeat === 1) delete out.repeat;
    else if (typeof m.repeat === 'number') out.repeat = range(m.repeat, 'material.repeat', 0.01, 1000);
    else if (Array.isArray(m.repeat) && m.repeat.length === 2) out.repeat = m.repeat.map((v, i) => range(v, `material.repeat[${i}]`, 0.01, 1000));
    else fail('"material.repeat" must be a number or [u, v]');
  }
  if (m.pattern !== undefined) {
    if (m.pattern === null) delete out.pattern;
    else out.pattern = normalizePattern(m.pattern);
  }
  if (m.castShadow !== undefined) { if (m.castShadow === false) out.castShadow = false; else delete out.castShadow; }
  if (m.flat !== undefined) out.flat = !!m.flat;
  if (m.doubleSided !== undefined) out.doubleSided = !!m.doubleSided;
  return out;
}

// ---- animation: declarative behaviours, evaluated per frame (see scene.js animatedMatrix)
//   spin  { axis [0,1,0], speed 90 deg/s, step? seconds (ticking), pivot? world point }
//   swing { axis [0,1,0], amplitude 15 deg, period 2 s, phase 0..1, pivot? }
//   bob   { axis [0,1,0] (world), amplitude 0.1, period 2 s, phase 0..1 }
//   orbit { center [0,0,0], axis [0,1,0], speed 30 deg/s }   rigid rotation around a world axis
//   pulse { min 0.5, max 1.5, period 1.5 s, phase 0..1, blink false }   scales emissive
//   wind  { strength 0.08, wavelength 4, speed 1.5, direction [x, z] }   bends vertices with their height (grass, kelp)
//   flow  { axis [1,0,0] (world), distance 4, speed 2 units/s, phase 0..1, fade 0.2 }   moves along the axis and
//         starts over (wind, particles, conveyor belts); grows in / shrinks out over `fade` of the way
//   keys  [{ t, position?, rotation?, scale?, emissive? }] with ease 'smooth' | 'linear' | 'spline' | 'step'
//         keyframes replace the base transform; behaviours are applied on top
// Without pivot, spin and swing turn around the object's own origin and local axis;
// with pivot, around a world axis through that point (parts that move together).
export function normalizeAnimation(a) {
  if (a === null || a === undefined) return null;
  if (typeof a !== 'object' || Array.isArray(a)) fail('"animation" must be an object like { "spin": { "speed": 90 } } or null');
  const known = ['spin', 'swing', 'bob', 'orbit', 'pulse', 'flow', 'wind', 'keys', 'ease'];
  for (const k of Object.keys(a)) if (!known.includes(k)) fail(`unknown animation "${k}" (use ${known.join(', ')})`);
  const obj = (v, n) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`"animation.${n}" must be an object`); return v; };
  const opt = (v, def, n, min, max) => (v === undefined ? def : range(v, `animation.${n}`, min, max));
  const axis = (v, n) => { const ax = v === undefined ? [0, 1, 0] : vec3(v, `animation.${n}.axis`); if (!Math.hypot(...ax)) fail(`"animation.${n}.axis" must not be zero`); return ax; };
  const out = {};
  if (a.spin) {
    const s = obj(a.spin, 'spin');
    out.spin = { axis: axis(s.axis, 'spin'), speed: opt(s.speed, 90, 'spin.speed', -1e5, 1e5) };
    if (s.step !== undefined) out.spin.step = range(s.step, 'animation.spin.step', 0.001, 3600);
    if (s.pivot !== undefined) out.spin.pivot = vec3(s.pivot, 'animation.spin.pivot');
  }
  if (a.swing) {
    const s = obj(a.swing, 'swing');
    out.swing = { axis: axis(s.axis, 'swing'), amplitude: opt(s.amplitude, 15, 'swing.amplitude', 0, 3600),
      period: opt(s.period, 2, 'swing.period', 0.01, 1e4), phase: opt(s.phase, 0, 'swing.phase', -1e4, 1e4) };
    if (s.pivot !== undefined) out.swing.pivot = vec3(s.pivot, 'animation.swing.pivot');
  }
  if (a.bob) {
    const s = obj(a.bob, 'bob');
    out.bob = { axis: axis(s.axis, 'bob'), amplitude: opt(s.amplitude, 0.1, 'bob.amplitude', -1e4, 1e4),
      period: opt(s.period, 2, 'bob.period', 0.01, 1e4), phase: opt(s.phase, 0, 'bob.phase', -1e4, 1e4) };
  }
  if (a.orbit) {
    const s = obj(a.orbit, 'orbit');
    out.orbit = { center: s.center === undefined ? [0, 0, 0] : vec3(s.center, 'animation.orbit.center'), axis: axis(s.axis, 'orbit'),
      speed: opt(s.speed, 30, 'orbit.speed', -1e5, 1e5) };
  }
  if (a.pulse) {
    const s = obj(a.pulse, 'pulse');
    out.pulse = { min: opt(s.min, 0.5, 'pulse.min', 0, 20), max: opt(s.max, 1.5, 'pulse.max', 0, 20),
      period: opt(s.period, 1.5, 'pulse.period', 0.01, 1e4), phase: opt(s.phase, 0, 'pulse.phase', -1e4, 1e4), blink: !!s.blink };
  }
  if (a.flow) {
    const s = obj(a.flow, 'flow');
    out.flow = { axis: s.axis === undefined ? [1, 0, 0] : vec3(s.axis, 'animation.flow.axis'), distance: opt(s.distance, 4, 'flow.distance', 0.001, 1e4),
      speed: opt(s.speed, 2, 'flow.speed', -1e4, 1e4), phase: opt(s.phase, 0, 'flow.phase', -1e4, 1e4), fade: opt(s.fade, 0.2, 'flow.fade', 0, 0.5) };
    if (!Math.hypot(...out.flow.axis)) fail('"animation.flow.axis" must not be zero');
  }
  if (a.wind) {
    const s = obj(a.wind, 'wind');
    out.wind = { strength: opt(s.strength, 0.08, 'wind.strength', 0, 100), wavelength: opt(s.wavelength, 4, 'wind.wavelength', 0.01, 1e4),
      speed: opt(s.speed, 1.5, 'wind.speed', -1e4, 1e4) };
    if (s.direction !== undefined) {
      if (!Array.isArray(s.direction) || s.direction.length !== 2 || !s.direction.every(Number.isFinite) || !Math.hypot(...s.direction)) fail('"animation.wind.direction" must be [x, z]');
      out.wind.direction = [...s.direction];
    } else out.wind.direction = [1, 0];
  }
  if (a.keys !== undefined && a.keys !== null) {
    const keys = normalizeKeys(a.keys, 'animation.keys', (k, n) => {
      const out = {};
      if (k.position !== undefined) out.position = vec3(k.position, `${n}.position`);
      if (k.rotation !== undefined) out.rotation = vec3(k.rotation, `${n}.rotation`);
      if (k.scale !== undefined) out.scale = scale3(k.scale);
      if (k.emissive !== undefined) out.emissive = range(k.emissive, `${n}.emissive`, 0, 10);
      return out;
    }, 'position, rotation, scale or emissive');
    if (keys.length) out.keys = keys;
  }
  if (a.ease !== undefined && out.keys) out.ease = normalizeEase(a.ease, 'animation.ease');
  return Object.keys(out).length ? out : null;
}

// ---- keyframes: [{ t: seconds, ...channels }], sorted by t; a later key at the same t replaces the earlier one.
// Each channel is interpolated between the keys that define it (see scene.js sampleKeys).
export const EASES = ['smooth', 'linear', 'spline', 'step'];
function normalizeEase(e, name) {
  if (!EASES.includes(e)) fail(`"${name}" must be one of ${EASES.join(', ')}`);
  return e;
}
const MAX_KEYS = 256;
function normalizeKeys(list, name, channels, what) {
  if (!Array.isArray(list)) fail(`"${name}" must be an array like [{ "t": 0, ... }, { "t": 2, ... }]`);
  if (list.length > MAX_KEYS) fail(`"${name}" allows at most ${MAX_KEYS} keys`);
  const byTime = new Map();
  list.forEach((k, i) => {
    const n = `${name}[${i}]`;
    if (!k || typeof k !== 'object' || Array.isArray(k)) fail(`"${n}" must be an object`);
    const t = Math.round(range(k.t, `${n}.t`, 0, 3600) * 1000) / 1000;
    const out = channels(k, n);
    if (!Object.keys(out).length) fail(`"${n}" needs at least one of ${what}`);
    byTime.set(t, { ...(byTime.get(t) || {}), ...out });
  });
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, ...v }));
}

// camera path: { keys: [{ t, yaw?, pitch?, distance?, target? }], ease: 'spline' }; missing channels use the scene camera
export function normalizeCameraPath(c) {
  if (c === null || c === undefined) return null;
  if (typeof c !== 'object' || Array.isArray(c)) fail('"camera" must be an object like { "keys": [{ "t": 0, "yaw": 0 }, { "t": 12, "yaw": 360 }] } or null');
  for (const k of Object.keys(c)) if (!['keys', 'ease'].includes(k)) fail(`unknown camera path field "${k}" (use keys, ease)`);
  const keys = normalizeKeys(c.keys, 'camera.keys', (k, n) => {
    const out = {};
    if (k.yaw !== undefined) out.yaw = range(k.yaw, `${n}.yaw`, -1e5, 1e5);
    if (k.pitch !== undefined) out.pitch = range(k.pitch, `${n}.pitch`, -89, 89);
    if (k.distance !== undefined) out.distance = range(k.distance, `${n}.distance`, 0.1, 1e4);
    if (k.target !== undefined) out.target = vec3(k.target, `${n}.target`);
    return out;
  }, 'yaw, pitch, distance or target');
  if (!keys.length) return null;
  return { keys, ease: c.ease === undefined ? 'spline' : normalizeEase(c.ease, 'camera.ease') };
}

// participating medium: haze or water with volumetric light shafts from the main light
//   { color, density 0..2 (per 10 units), rays 0..4 (shaft strength), rayColor, scale (shaft size, units), speed, far }
function normalizeAtmosphere(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) fail('"atmosphere" must be an object like { "color": "#1d5a6e", "density": 0.4, "rays": 1 } or null');
  return {
    color: parseColor(a.color ?? '#20586a', 'atmosphere.color'), rayColor: parseColor(a.rayColor ?? '#bfefff', 'atmosphere.rayColor'),
    density: a.density === undefined ? 0.35 : range(a.density, 'atmosphere.density', 0, 20), rays: a.rays === undefined ? 1 : range(a.rays, 'atmosphere.rays', 0, 4),
    scale: a.scale === undefined ? 3 : range(a.scale, 'atmosphere.scale', 0.01, 1e4), speed: a.speed === undefined ? 0.3 : range(a.speed, 'atmosphere.speed', -100, 100),
    far: a.far === undefined ? 60 : range(a.far, 'atmosphere.far', 0.1, 1e5),
  };
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
      ...(o.animation ? { animation: normalizeAnimation(o.animation) } : {}),
      ...(o.effect ? { effect: true } : {}), // a visual effect (airflow, rain, sparks): viewers can hide all of them
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
      if (patch.effect !== undefined) { if (patch.effect) o.effect = true; else delete o.effect; }
      if (patch.animation !== undefined) {
        const a = normalizeAnimation(patch.animation);
        if (a) o.animation = a; else delete o.animation;
      }
      return o;
    });
  }

  // Insert or merge one keyframe at time t (object channels, or camera channels when id is "camera").
  // remove: true deletes the key at t. Returns the resulting key list.
  setKey(id, t, values = {}, { remove = false, ease } = {}, activity) {
    const time = Math.round(range(t, 'time', 0, 3600) * 1000) / 1000;
    return this.commit(activity, (d) => {
      const merge = (keys = []) => {
        const rest = keys.filter((k) => k.t !== time), old = keys.find((k) => k.t === time);
        return remove ? rest : [...rest, { ...(old || {}), ...values, t: time }];
      };
      if (id === 'camera') {
        d.animation ??= { duration: 12 };
        const prev = d.animation.camera;
        const path = normalizeCameraPath({ keys: merge(prev?.keys), ease: ease ?? prev?.ease ?? 'spline' });
        if (path) d.animation.camera = path; else delete d.animation.camera;
        return path?.keys || [];
      }
      const o = d.objects.find((x) => x.id === id);
      if (!o) fail(`no object with id "${id}". Call get_scene to see the existing ids.`);
      const { keys, ease: e, ...rest } = o.animation || {};
      const next = merge(keys);
      const a = normalizeAnimation({ ...rest, ...(next.length ? { keys: next, ease: ease ?? e ?? 'smooth' } : {}) });
      if (a) o.animation = a; else delete o.animation;
      return a?.keys || [];
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
      if (patch.atmosphere !== undefined) e.atmosphere = patch.atmosphere === null ? null : normalizeAtmosphere(patch.atmosphere);
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
    e.atmosphere = safe(() => (e.atmosphere ? normalizeAtmosphere(e.atmosphere) : null), null);
    // timeline length in seconds (playback loops)
    const dur = data.animation?.duration;
    next.animation = { duration: typeof dur === 'number' && dur >= 1 && dur <= 3600 ? dur : 12 };
    const path = safe(() => normalizeCameraPath(data.animation?.camera), null);
    if (path) next.animation.camera = path;

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
