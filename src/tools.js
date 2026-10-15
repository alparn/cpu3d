// Tools: the one API of cpu3d. Agents call them over MCP or HTTP, and the editor UI calls
// exactly the same tools for every click, so humans and agents are equal citizens.

import { SHAPE_REFERENCE, SHAPE_TYPES } from './recipes.js';
import { parseOBJ } from './geometry.js';
import { frameBounds, unionBounds, buildRenderScene, raycast, exportOBJ } from './scene.js';

export const AGENT_GUIDE = `cpu3d is a 3D modeling workspace. You build scenes from JSON shape recipes
(primitives, lathe, extrude, sweep, tube, terrain, raw meshes); a CPU renderer draws them and a human
watches the result live in the editor.

Workflow:
1. Call get_shape_reference once to learn the recipe format.
2. Call get_scene to see what already exists (ids, bounds).
3. Create with add_objects (several objects per call), adjust with update_object.
4. ALWAYS call render_view after changes and look at the image. Fix what looks wrong.
   Use focus to frame specific objects and different yaw/pitch to check from several sides.

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
    texture: { type: 'string', description: 'PNG image: project path (e.g. "examples/textures/screen.png") or "data:image/png;base64,...". Projected along the thinnest local axis of the object (flat in Z: top = +Y; flat in Y like plane: top = -Z)' },
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

function resolveCamera(doc, args) {
  let cam = { ...doc.data.camera };
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
    description: `Animates an object with declarative behaviours (combine freely), or sets the timeline length.
  spin  { axis: [0,1,0], speed: deg/s, step?: seconds (ticking clock hands), pivot?: [x,y,z] }
  swing { axis, amplitude: deg, period: s, phase: 0..1, pivot? }   oscillating rotation (pendulum, balance wheel)
  bob   { axis: world [0,1,0], amplitude, period: s, phase }      up/down (floating boat)
  orbit { center: [x,y,z], axis, speed: deg/s }                   rigid rotation around a world axis (turntable, planets)
  pulse { min, max, period: s, phase, blink: bool }               scales emissive (glowing, blinking lights)
Without pivot, spin/swing turn around the object's own origin and LOCAL axis; with pivot, around a WORLD axis through that point
(use the same pivot for parts that must move together). animation: null removes it. Check the motion with render_view(time).`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Object to animate (omit to only change the timeline duration)' },
        animation: { type: ['object', 'null'] },
        duration: { type: 'number', description: 'Timeline length in seconds (playback loops), default 12' },
      },
    },
    run: (doc, a, act) => {
      if (a.duration !== undefined) {
        if (typeof a.duration !== 'number' || a.duration < 1 || a.duration > 3600) throw new Error('"duration" must be 1..3600 seconds');
        if (a.id === undefined) {
          doc.commit(act(`set the timeline to ${a.duration} s`), (d) => { d.animation = { ...(d.animation || {}), duration: a.duration }; });
          return text({ duration: a.duration });
        }
      }
      if (a.id === undefined) throw new Error('"id" is required (or give only "duration")');
      const kinds = a.animation ? Object.keys(a.animation).join(', ') : 'removed';
      const o = doc.updateObject(a.id, { animation: a.animation ?? null }, act(`animated ${doc.getObject(a.id).name} (${kinds})`));
      if (a.duration !== undefined) doc.commit(act(`set the timeline to ${a.duration} s`), (d) => { d.animation = { ...(d.animation || {}), duration: a.duration }; });
      return text({ id: o.id, animation: o.animation ?? null, hint: 'Check it with render_view at a few different time values.' });
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
        time: { type: 'number', description: 'Animation time in seconds (default 0)' },
      },
    },
    readOnly: true,
    run: async (doc, a, act, ctx) => {
      if (!ctx.render) throw new Error('rendering images is not available in this context');
      const camera = resolveCamera(doc, a);
      const width = Math.round(Math.min(1600, Math.max(64, a.width ?? 768)));
      const height = Math.round(Math.min(1200, Math.max(64, a.height ?? 512)));
      const time = typeof a.time === 'number' && Number.isFinite(a.time) ? Math.max(0, a.time) : 0;
      const png = await ctx.render(doc, { width, height, camera, shading: a.shading, wireframe: a.wireframe, highlight: a.highlight || [], time });
      const cam = `yaw ${camera.yaw.toFixed(0)}°, pitch ${camera.pitch.toFixed(0)}°, distance ${camera.distance.toFixed(2)}, target [${camera.target.map((v) => v.toFixed(2))}]`;
      return [{ type: 'image', data: png, mimeType: 'image/png' }, { type: 'text', text: `${width}x${height}, t = ${time} s, camera: ${cam}` }];
    },
    summary: () => 'rendered a view',
    details: (doc, a) => ({ camera: resolveCamera(doc, a) }),
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

// ctx: { source: who is calling (e.g. "claude-code", "you"), render?: async (doc, opts) => base64 PNG }
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

