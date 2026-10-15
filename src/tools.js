// Tools: the one API of cpu3d. Agents call them over MCP or HTTP, and the editor UI calls
// exactly the same tools for every click, so humans and agents are equal citizens.

import { SHAPE_REFERENCE, SHAPE_TYPES } from './recipes.js';
import { parseOBJ } from './geometry.js';
import { frameBounds, unionBounds, buildRenderScene, raycast, exportOBJ, cameraAt } from './scene.js';
import { normalizeCameraPath } from './document.js';

export const AGENT_GUIDE = `cpu3d is a 3D modeling workspace. You build scenes from JSON shape recipes
(primitives, lathe, extrude, sweep, tube, terrain, raw meshes); a CPU renderer draws them and a human
watches the result live in the editor.

Workflow:
1. Call get_shape_reference once to learn the recipe format.
2. Call get_scene to see what already exists (ids, bounds).
3. Create with add_objects (several objects per call), adjust with update_object.
4. ALWAYS call render_view after changes and look at the image. Fix what looks wrong.
   Use focus to frame specific objects and different yaw/pitch to check from several sides.

5. To animate, use set_animation (behaviours, keyframes, camera path) and check the motion with render_animation.

World: Y up, ground at y = 0, meters, rotations in degrees, colors as "#rrggbb".`;

const vec3S = (description) => ({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description });
const idsS = { type: 'array', items: { type: 'string' }, description: 'Object ids, e.g. ["obj_1"]' };
const materialS = {
  type: 'object',
  properties: {
    color: { type: 'string', description: 'Hex color, e.g. "#e07a3f"' },
    specular: { type: 'number', description: 'Highlight strength 0..2 (default 0.25)' },
    shininess: { type: 'number', description: 'Highlight sharpness 1..256 (default 24)' },
    flat: { type: 'boolean', description: 'Faceted flat shading' },
    doubleSided: { type: 'boolean', description: 'Render back faces (open surfaces like vases, planes)' },
    emissive: { type: 'number', description: 'Self-illumination 0..10 (screens, lamps, windows, neon); 1 shows the color at full strength' },
    metalness: { type: 'number', description: '0 dielectric .. 1 metal (reflections tinted by the color, no diffuse)' },
    roughness: { type: 'number', description: '0 polished/mirror .. 1 matte (default 0.7); controls how sharp reflections are' },
    texture: { type: 'string', description: 'PNG image: project path (e.g. "examples/textures/screen.png") or "data:image/png;base64,...". By default projected along the thinnest local axis (flat in Z: top = +Y; flat in Y like plane: top = -Z)' },
    mapping: { type: 'string', enum: ['planar', 'box', 'cylinder', 'sphere'], description: 'How the texture wraps: planar (default), box (from all sides, for patterns on any shape), cylinder (labels around Y), sphere' },
    repeat: { type: ['number', 'array'], items: { type: 'number' }, description: 'Tile the texture: a number or [u, v]' },
    pattern: { type: ['object', 'null'], description: 'Procedural surface, no image needed: { type: wood | marble | leather | carbon | fabric | brushed | checker | stripes | knurl, colors: [2 or 3 colours], scale: size of one feature in units, bump: 0..2 relief }' },
  },
};
const shapeS = {
  type: 'object',
  description: 'Shape recipe, e.g. {"type":"cylinder","radiusTop":0.1,"radiusBottom":0.1,"height":2}. See get_shape_reference.',
  properties: { type: { type: 'string', enum: SHAPE_TYPES } },
  required: ['type'],
  additionalProperties: true,
};
const objectProps = {
  name: { type: 'string', description: 'Human readable name' },
  shape: shapeS,
  position: vec3S('World position [x, y, z]'),
  rotation: vec3S('Rotation in degrees [x, y, z]'),
  scale: { type: ['number', 'array'], items: { type: 'number' }, description: 'Uniform number or [x, y, z]' },
  material: materialS,
  visible: { type: 'boolean' },
  animation: { type: ['object', 'null'], description: 'Behaviours: spin, swing, bob, orbit, pulse (see set_animation). null removes' },
  effect: { type: 'boolean', description: 'Mark as a visual effect (airflow, rain, sparks, steam): viewers can hide all effects at once' },
};
const cameraProps = {
  yaw: { type: 'number', description: 'Degrees around the Y axis (0 = looking from +Z)' },
  pitch: { type: 'number', description: 'Degrees above the horizon (-89..89)' },
  distance: { type: 'number', description: 'Distance from target' },
  target: vec3S('Point to look at'),
  focus: { type: ['array', 'string'], items: { type: 'string' }, description: 'Object ids to frame, or "all"' },
};

// pretty JSON, but short arrays stay on one line (readable for humans, cheap in tokens for agents)
export const pretty = (v) => JSON.stringify(v, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, inner) => `[${inner.split(/,\s+/).join(', ')}]`);
const text = (v) => [{ type: 'text', text: typeof v === 'string' ? v : pretty(v) }];
const names = (list) => list.slice(0, 3).map((o) => o.name).join(', ') + (list.length > 3 ? ` (+${list.length - 3} more)` : '');
const brief = (doc, o) => ({ id: o.id, name: o.name, triangles: doc.geometry(o.shape).triangleCount, bounds: doc.bounds(o) });

function compactShape(shape) {
  if (shape.type !== 'mesh') return shape;
  return { type: 'mesh', vertices: shape.positions.length / 3, triangles: shape.indices.length / 3 };
}

// camera for a render: the scene camera (or the camera path at args.time), then focus and explicit overrides
function resolveCamera(doc, args) {
  const t = typeof args.time === 'number' && Number.isFinite(args.time) ? Math.max(0, args.time) : 0;
  let cam = { ...(args.camera_path === false ? doc.data.camera : cameraAt(doc.data, t)) };
  if (args.focus) {
    const ids = args.focus === 'all' ? doc.data.objects.filter((o) => o.visible).map((o) => o.id) : args.focus;
    cam = { ...cam, ...frameBounds(unionBounds(ids.map((id) => doc.bounds(doc.getObject(id)))), cam) };
  }
  for (const k of ['yaw', 'pitch', 'distance', 'target']) if (args[k] !== undefined) cam[k] = args[k];
  return cam;
}

export const TOOLS = [
  {
    name: 'get_shape_reference',
    description: 'Returns the full reference of shape recipes (primitives, lathe, extrude, sweep, tube, terrain, mesh), 2D shapes, 3D paths and modeling tips. Read this before building.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    run: () => SHAPE_REFERENCE,
    summary: () => 'read the shape reference',
  },
  {
    name: 'get_scene',
    description: 'Returns the current scene: all objects with id, shape recipe, transform, material, triangle count and world bounds, plus camera and environment.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    run: (doc) => {
      const s = doc.summary();
      return text({ ...s, objects: s.objects.map((o) => ({ ...o, shape: compactShape(o.shape) })) });
    },
    summary: (doc) => `inspected the scene (${doc.data.objects.length} objects)`,
  },
  {
    name: 'add_objects',
    description: 'Adds one or more objects to the scene. Returns their ids and world bounds.',
    inputSchema: {
      type: 'object',
      properties: { objects: { type: 'array', items: { type: 'object', properties: objectProps, required: ['shape'] }, minItems: 1 } },
      required: ['objects'],
    },
    run: (doc, a, act) => {
      const added = doc.addObjects(a.objects, act(`added ${names(a.objects.map((o, i) => ({ name: o.name || o.shape?.type || `object ${i + 1}` })))}`));
      return text({ added: added.map((o) => brief(doc, o)), hint: 'Call render_view to check the result.' });
    },
  },
  {
    name: 'update_object',
    description: 'Changes an existing object. Only the given fields change; material fields are merged. Giving "shape" replaces the whole recipe.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...objectProps }, required: ['id'] },
    run: (doc, a, act) => {
      const { id, ...patch } = a;
      const o = doc.updateObject(id, patch, act(`updated ${doc.getObject(id).name} (${Object.keys(patch).join(', ') || 'nothing'})`));
      return text(brief(doc, o));
    },
  },
  {
    name: 'remove_objects',
    description: 'Removes objects by id.',
    inputSchema: { type: 'object', properties: { ids: idsS }, required: ['ids'] },
    run: (doc, a, act) => {
      const list = (a.ids || []).map((id) => doc.getObject(id));
      doc.removeObjects(a.ids, act(`removed ${names(list)}`));
      return text({ removed: a.ids });
    },
  },
  {
    name: 'clear_scene',
    description: 'Removes all objects (camera and environment stay). Can be undone.',
    inputSchema: { type: 'object', properties: {} },
    run: (doc, a, act) => { doc.clear(act('cleared the scene')); return 'Scene cleared.'; },
  },
  {
    name: 'load_scene',
    description: 'Replaces the whole scene with a scene document { camera?, environment?, objects: [...] } (same format as get_scene).',
    inputSchema: { type: 'object', properties: { scene: { type: 'object' } }, required: ['scene'] },
    run: (doc, a, act) => {
      doc.load(a.scene, act(`loaded a scene with ${a.scene?.objects?.length ?? 0} objects`));
      return text({ objects: doc.data.objects.map((o) => brief(doc, o)) });
    },
  },
  {
    name: 'set_camera',
    description: 'Sets the scene camera that the editor and render_view use by default. Use focus to frame objects automatically.',
    inputSchema: { type: 'object', properties: cameraProps },
    run: (doc, a, act) => {
      const cam = doc.setCamera(resolveCamera(doc, a), act('moved the camera'));
      return text(cam);
    },
  },
  {
    name: 'set_environment',
    description: 'Changes background gradient, fog, light and the ground grid.',
    inputSchema: {
      type: 'object',
      properties: {
        background: { type: ['object', 'string'], description: '"#rrggbb" or { top, bottom }' },
        fog: { type: ['object', 'null'], description: '{ near, far } distances, or null to disable' },
        light: { type: 'object', description: '{ direction: [x, y, z] pointing towards the light, color, intensity, softness 0..1 (soft shadows) }' },
        lights: { type: 'array', items: { type: 'object' }, description: 'Up to 4 extra lights without shadows: [{ direction, color, intensity }] (fill, rim)' },
        reflections: { type: 'string', enum: ['sky', 'studio', 'none'], description: 'What glossy surfaces reflect: the sky gradient, a photo studio with softboxes, or nothing' },
        ground: { type: 'boolean', description: 'Show the checker ground at y = 0' },
      },
    },
    run: (doc, a, act) => text(doc.setEnvironment(a, act(`changed the environment (${Object.keys(a).join(', ')})`))),
  },
  {
    name: 'probe_height',
    description: 'Casts vertical rays at [x, z] positions and returns the height (y) of the topmost surface and which object it hit. Use it to place things on terrain or on top of other objects.',
    inputSchema: {
      type: 'object',
      properties: {
        points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, description: '[[x, z], ...] (max 200)' },
        ignore: idsS,
      },
      required: ['points'],
    },
    readOnly: true,
    run: (doc, a) => {
      if (!Array.isArray(a.points) || !a.points.length || a.points.length > 200) throw new Error('"points" must be 1..200 [x, z] pairs');
      const ignore = a.ignore || [];
      const meshes = buildRenderScene(doc.data, (s) => doc.geometry(s), { showGround: false }).meshes.filter((m) => !ignore.includes(m.objectId));
      const top = Math.max(100, ...doc.data.objects.map((o) => doc.bounds(o).max[1] + 1));
      return text(a.points.map(([x, z]) => {
        const hit = raycast(meshes, [x, top, z], [0, -1, 0]);
        if (!hit) return { x, z, y: doc.data.environment.ground ? 0 : null, object: null };
        const o = doc.data.objects.find((ob) => ob.id === hit.mesh.objectId);
        return { x, z, y: +(top - hit.distance).toFixed(4), object: { id: o.id, name: o.name } };
      }));
    },
    summary: (doc, a) => `probed the height at ${a.points?.length ?? 0} points`,
  },
  {
    name: 'set_animation',
    description: `Animates an object with behaviours and/or keyframes, sets a camera path, or the timeline length.
Behaviours (combine freely):
  spin  { axis: [0,1,0], speed: deg/s, step?: seconds (ticking clock hands), pivot?: [x,y,z] }
  swing { axis, amplitude: deg, period: s, phase: 0..1, pivot? }   oscillating rotation (pendulum, balance wheel)
  bob   { axis: world [0,1,0], amplitude, period: s, phase }      up/down (floating boat)
  orbit { center: [x,y,z], axis, speed: deg/s }                   rigid rotation around a world axis (turntable, planets)
  pulse { min, max, period: s, phase, blink: bool }               scales emissive (glowing, blinking lights)
  flow  { axis: world [1,0,0], distance, speed: units/s, phase, fade: 0..0.5 }   moves along the axis and starts over,
        growing in and shrinking out at the ends: wind streaks, particles, exhaust, rain, conveyor belts.
        Tip: a radial array of thin glowing cylinders with flow (and spin for swirl) reads as airflow.
Without pivot, spin/swing turn around the object's own origin and LOCAL axis; with pivot, around a WORLD axis through that point
(use the same pivot for parts that must move together).
Keyframes: keys: [{ t: seconds, position?, rotation? (deg), scale?, emissive? }], ease: "smooth" (default, eases in and out
at every key) | "linear" | "spline" (smooth curve through all keys, for flight paths) | "step". Keys replace the base transform
(channels without keys keep it); behaviours are applied on top. Values hold before the first and after the last key.
Camera path: camera: { keys: [{ t, yaw?, pitch?, distance?, target? }], ease: "spline" } (null removes it); a turntable is
{ keys: [{ t: 0, yaw: 0 }, { t: 12, yaw: 360 }], ease: "linear" }. The timeline loops after duration seconds.
animation: null removes an object's animation. Check motion with render_animation (one image with several frames) or render_view(time).`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Object to animate' },
        animation: { type: ['object', 'null'], description: 'Behaviours and/or keys + ease (replaces the previous animation of the object)' },
        camera: { type: ['object', 'null'], description: 'Camera path { keys, ease }, or null to remove it' },
        duration: { type: 'number', description: 'Timeline length in seconds (playback loops), default 12' },
      },
    },
    run: (doc, a, act) => {
      if (a.id === undefined && a.duration === undefined && a.camera === undefined) throw new Error('give "id" + "animation", "camera" and/or "duration"');
      if (a.duration !== undefined && (typeof a.duration !== 'number' || a.duration < 1 || a.duration > 3600)) throw new Error('"duration" must be 1..3600 seconds');
      const out = {};
      if (a.id !== undefined) {
        if (a.animation === undefined) throw new Error('"animation" is required with "id" (null removes it)');
        const kinds = a.animation ? Object.keys(a.animation).join(', ') : 'removed';
        const o = doc.updateObject(a.id, { animation: a.animation ?? null }, act(`animated ${doc.getObject(a.id).name} (${kinds})`));
        Object.assign(out, { id: o.id, animation: o.animation ?? null });
      }
      if (a.camera !== undefined || a.duration !== undefined) {
        const path = a.camera === undefined ? undefined : normalizeCameraPath(a.camera);
        const what = [a.camera !== undefined && (path ? `a camera path with ${path.keys.length} keys` : 'no camera path'), a.duration !== undefined && `${a.duration} s`].filter(Boolean).join(', ');
        doc.commit(act(`set the timeline: ${what}`), (d) => {
          d.animation = { ...(d.animation || { duration: 12 }) };
          if (a.duration !== undefined) d.animation.duration = a.duration;
          if (path) d.animation.camera = path; else if (a.camera !== undefined) delete d.animation.camera;
        });
        Object.assign(out, { duration: doc.data.animation.duration, camera: doc.data.animation.camera ?? null });
      }
      return text({ ...out, hint: 'Check the motion with render_animation, or render_view at a few time values.' });
    },
  },
  {
    name: 'set_keyframe',
    description: `Adds or updates ONE keyframe at a time, merging into an existing key at that time. Handy to build motion step by step:
  { id: "obj_3", time: 2, position: [0, 1, 0], rotation: [0, 90, 0] }       object key (position, rotation, scale, emissive)
  { id: "camera", time: 6, yaw: 120, distance: 8, target: [0, 1, 0] }     camera path key (yaw, pitch, distance, target)
  { id: "obj_3", time: 2, remove: true }                                  delete the key at that time
ease (optional) sets the interpolation of that object or the camera path: smooth | linear | spline | step.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Object id, or "camera" for the camera path' },
        time: { type: 'number', description: 'Seconds on the timeline' },
        position: vec3S('Object position at this time'),
        rotation: vec3S('Object rotation in degrees at this time'),
        scale: { type: ['number', 'array'], items: { type: 'number' }, description: 'Object scale at this time' },
        emissive: { type: 'number', description: 'Object glow 0..10 at this time' },
        yaw: { type: 'number' }, pitch: { type: 'number' }, distance: { type: 'number' }, target: vec3S('Camera target at this time'),
        ease: { type: 'string', enum: ['smooth', 'linear', 'spline', 'step'] },
        remove: { type: 'boolean', description: 'Delete the key at this time' },
      },
      required: ['id', 'time'],
    },
    run: (doc, a, act) => {
      const cam = a.id === 'camera', fields = cam ? ['yaw', 'pitch', 'distance', 'target'] : ['position', 'rotation', 'scale', 'emissive'];
      const values = Object.fromEntries(fields.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
      const name = cam ? 'the camera' : doc.getObject(a.id).name;
      const keys = doc.setKey(a.id, a.time, values, { remove: !!a.remove, ease: a.ease },
        act(a.remove ? `removed the key of ${name} at ${a.time} s` : `keyed ${name} at ${a.time} s (${Object.keys(values).join(', ')})`));
      return text({ id: a.id, keys });
    },
  },
  {
    name: 'render_view',
    description: 'Renders the scene on the CPU and returns a PNG image so you can see your work. Optional camera overrides do not change the scene camera.',
    inputSchema: {
      type: 'object',
      properties: {
        ...cameraProps,
        width: { type: 'number', description: 'Pixels, default 768, max 1600' },
        height: { type: 'number', description: 'Pixels, default 512, max 1200' },
        shading: { type: 'string', enum: ['gouraud', 'flat', 'normals'] },
        wireframe: { type: 'boolean', description: 'Show triangle edges' },
        highlight: idsS,
        time: { type: 'number', description: 'Animation time in seconds (default 0); a camera path is followed unless camera_path is false' },
        camera_path: { type: 'boolean', description: 'false: use the scene camera even if there is a camera path' },
        effects: { type: 'boolean', description: 'false: leave out objects marked as effects' },
      },
    },
    readOnly: true,
    run: async (doc, a, act, ctx) => {
      if (!ctx.render) throw new Error('rendering images is not available in this context');
      const camera = resolveCamera(doc, a);
      const width = Math.round(Math.min(1600, Math.max(64, a.width ?? 768)));
      const height = Math.round(Math.min(1200, Math.max(64, a.height ?? 512)));
      const time = typeof a.time === 'number' && Number.isFinite(a.time) ? Math.max(0, a.time) : 0;
      const png = await ctx.render(doc, { width, height, camera, shading: a.shading, wireframe: a.wireframe, highlight: a.highlight || [], time, effects: a.effects !== false });
      const cam = `yaw ${camera.yaw.toFixed(0)}°, pitch ${camera.pitch.toFixed(0)}°, distance ${camera.distance.toFixed(2)}, target [${camera.target.map((v) => v.toFixed(2))}]`;
      return [{ type: 'image', data: png, mimeType: 'image/png' }, { type: 'text', text: `${width}x${height}, t = ${time} s, camera: ${cam}` }];
    },
    summary: () => 'rendered a view',
    details: (doc, a) => ({ camera: resolveCamera(doc, a) }),
  },
  {
    name: 'render_animation',
    description: `Renders several frames of the animation into ONE image (a contact sheet, left to right, top to bottom), so you
can check motion in a single look. Frames are evenly spaced over the clip; the text lists the time of each frame.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...cameraProps,
        frames: { type: 'number', description: 'Number of frames 2..16 (default 6)' },
        start: { type: 'number', description: 'Clip start in seconds (default 0)' },
        seconds: { type: 'number', description: 'Clip length (default: the whole timeline)' },
        width: { type: 'number', description: 'Sheet width in pixels, default 1024, max 1600' },
        camera_path: { type: 'boolean', description: 'false: fixed scene camera even if there is a camera path' },
      },
    },
    readOnly: true,
    run: async (doc, a, act, ctx) => {
      if (!ctx.renderSheet) throw new Error('rendering images is not available in this context');
      const fixed = a.camera_path === false || a.focus || ['yaw', 'pitch', 'distance', 'target'].some((k) => a[k] !== undefined);
      const camera = fixed ? resolveCamera(doc, { ...a, camera_path: false }) : null;
      const width = Math.round(Math.min(1600, Math.max(256, a.width ?? 1024)));
      const seconds = typeof a.seconds === 'number' ? Math.max(0.1, Math.min(3600, a.seconds)) : undefined;
      const { png, times, columns } = await ctx.renderSheet(doc, { width, frames: Math.round(a.frames ?? 6), start: Math.max(0, a.start ?? 0), seconds, camera });
      return [{ type: 'image', data: png, mimeType: 'image/png' },
        { type: 'text', text: `${times.length} frames in ${columns} columns at t = ${times.join(', ')} s · camera: ${camera ? 'fixed' : 'scene camera path'}` }];
    },
    summary: (doc, a) => `rendered ${a.frames ?? 6} animation frames`,
  },
  {
    name: 'export_gif',
    description: `Renders the animation to an animated GIF (high quality, motion blur). With the cpu3d server the file is saved to
the exports/ folder of the server's working directory and the path is returned; in the browser editor it is downloaded.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name without extension (default "animation")' },
        width: { type: 'number', description: 'Pixels, default 480, max 960' },
        height: { type: 'number', description: 'Pixels, default 320, max 720' },
        fps: { type: 'number', description: 'Frames per second 5..30 (default 15)' },
        start: { type: 'number', description: 'Clip start in seconds (default 0)' },
        seconds: { type: 'number', description: 'Clip length, default the whole timeline, max 20' },
        samples: { type: 'number', description: 'Samples per frame 1..16 (anti-aliasing, motion blur), default 4' },
      },
    },
    readOnly: true,
    run: async (doc, a, act, ctx) => {
      if (!ctx.saveGif) throw new Error('GIF export is not available in this context');
      const clamp = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
      const opts = {
        name: String(a.name || 'animation').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'animation',
        width: Math.round(clamp(a.width, 64, 960, 480)), height: Math.round(clamp(a.height, 64, 720, 320)), fps: clamp(a.fps, 5, 30, 15),
        start: clamp(a.start, 0, 3600, 0), seconds: clamp(a.seconds, 0.2, 20, Math.min(20, doc.data.animation?.duration ?? 12)),
        samples: Math.round(clamp(a.samples, 1, 16, 4)),
      };
      const r = await ctx.saveGif(doc, opts);
      return text({ ...r, width: opts.width, height: opts.height, fps: opts.fps });
    },
    summary: (doc, a) => `exported a GIF (${a.name || 'animation'})`,
  },
  {
    name: 'export_obj',
    description: 'Exports visible objects (or the given ids) as one Wavefront OBJ text in world space.',
    inputSchema: { type: 'object', properties: { ids: idsS } },
    readOnly: true,
    run: (doc, a) => {
      const list = a.ids?.length ? a.ids.map((id) => doc.getObject(id)) : doc.data.objects.filter((o) => o.visible);
      return exportOBJ(list, (s) => doc.geometry(s));
    },
    summary: (doc, a) => `exported ${a.ids?.length ?? 'all'} objects as OBJ`,
  },
  {
    name: 'import_obj',
    description: 'Imports a Wavefront OBJ text as a new mesh object. By default the model is scaled to fit a 2 m sphere and placed on the ground.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'OBJ file content' },
        name: { type: 'string' },
        fit: { type: ['number', 'null'], description: 'Fit into a sphere of this radius (default 1), null keeps original size' },
        position: vec3S('World position, default on the ground at the origin'),
        material: materialS,
      },
      required: ['text'],
    },
    run: (doc, a, act) => {
      if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('"text" must contain OBJ data');
      const g = parseOBJ(a.text);
      if (!g.triangleCount) throw new Error('no faces found in the OBJ data');
      if (a.fit !== null) g.fit(a.fit ?? 1);
      const shape = { type: 'mesh', positions: Array.from(g.positions, (v) => +v.toFixed(5)), indices: Array.from(g.indices) };
      const name = a.name || 'Imported model';
      const [o] = doc.addObjects([{ name, shape, position: a.position ?? [0, -g.min[1], 0], material: { doubleSided: true, ...a.material } }],
        act(`imported ${name} (${g.triangleCount} triangles)`));
      return text(brief(doc, o));
    },
  },
  {
    name: 'undo',
    description: 'Undoes the last change.',
    inputSchema: { type: 'object', properties: {} },
    run: (doc, a, act) => (doc.undo(act('undo')) ? 'Undone.' : 'Nothing to undo.'),
  },
  {
    name: 'redo',
    description: 'Redoes the last undone change.',
    inputSchema: { type: 'object', properties: {} },
    run: (doc, a, act) => (doc.redo(act('redo')) ? 'Redone.' : 'Nothing to redo.'),
  },
];

// ctx: { source: who is calling (e.g. "claude-code", "you"), render?: async (doc, opts) => base64 PNG,
//        renderSheet?: async (doc, opts) => { png, times, columns }, saveGif?: async (doc, opts) => { file, bytes, frames } }
export async function callTool(doc, name, args, ctx = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { isError: true, content: text(`Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(', ')}`) };
  const a = args && typeof args === 'object' ? args : {};
  const act = (summary) => ({ source: ctx.source || 'agent', tool: name, summary });
  try {
    const out = await tool.run(doc, a, act, ctx);
    if (tool.summary) doc.activity({ ...act(tool.summary(doc, a)), ...tool.details?.(doc, a) });
    return { content: Array.isArray(out) ? out : text(out) };
  } catch (e) {
    doc.activity({ ...act(`failed: ${e.message}`), error: true });
    return { isError: true, content: text(`Error: ${e.message}`) };
  }
}

export const toolList = () => TOOLS.map(({ name, description, inputSchema, readOnly }) => ({
  name, description, inputSchema, annotations: { readOnlyHint: !!readOnly },
}));

// OpenAI / generic function-calling format
export const toolListOpenAI = () => TOOLS.map(({ name, description, inputSchema }) => ({
  type: 'function', function: { name, description, parameters: inputSchema },
}));

