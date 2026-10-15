// Builds the example gallery: every scene is created through the same tool API agents use
// (add_objects, probe_height, set_camera, ...), then saved with a thumbnail and stats.
//   node examples/build.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneDocument, callTool } from '../src/index.js';
import { pretty } from '../src/tools.js';
import { exportOBJ } from '../src/scene.js';
import { renderPNG, preloadTextures } from '../server/render.js';
import { mat4 } from '../src/math.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const P = (...v) => v.map(r4);

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function tool(doc, name, args) {
  const r = await callTool(doc, name, args, { source: 'examples' });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r.content[0].type === 'text' ? r.content[0].text : r;
}
const add = (doc, objects) => tool(doc, 'add_objects', { objects });
// animate every object whose name matches (string, list of names or predicate); anim may depend on the index
async function animate(doc, match, anim) {
  const hit = (o) => (typeof match === 'function' ? match(o) : Array.isArray(match) ? match.includes(o.name) : o.name === match);
  const list = doc.data.objects.filter(hit);
  for (const [i, o] of list.entries()) await tool(doc, 'set_animation', { id: o.id, animation: typeof anim === 'function' ? anim(o, i) : anim });
}
const timeline = (doc, seconds) => tool(doc, 'set_animation', { duration: seconds });
// camera path that starts and ends on the scene camera, so the clip loops
async function cameraPath(doc, seconds, via, ease = 'spline') {
  const c = doc.data.camera, home = { yaw: c.yaw, pitch: c.pitch, distance: c.distance, target: c.target };
  const keys = [{ t: 0, ...home }, ...via, { t: seconds, ...home }];
  await tool(doc, 'set_animation', { camera: { keys, ease }, duration: seconds });
}
async function probe(doc, points) { return JSON.parse(await tool(doc, 'probe_height', { points })).map((p) => p.y ?? 0); }

// profile helper: arc of a circle centered on (cx, cy), angles in degrees, for lathe profiles
const arc = (cx, cy, r, a0, a1, n = 10, sy = 1) => Array.from({ length: n + 1 }, (_, i) => {
  const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
  return P(Math.max(0, cx + Math.cos(a) * r), cy + Math.sin(a) * r * sy);
});

// A transform for a group of parts (the tools have no groups, so parts are placed in world space).
// Parts are given in the group's local space; rotations are combined correctly via matrices.
function group(position, rotation) {
  const D = Math.PI / 180, G = mat4.compose(mat4.create(), position, rotation.map((v) => v * D), [1, 1, 1]);
  return (part) => {
    const p = part.position || [0, 0, 0];
    const L = mat4.compose(mat4.create(), [0, 0, 0], (part.rotation || [0, 0, 0]).map((v) => v * D), [1, 1, 1]);
    const m = mat4.multiply(mat4.create(), G, L);
    // Euler XYZ (R = Rz * Ry * Rx) back out of the combined matrix
    const ry = Math.asin(Math.max(-1, Math.min(1, -m[2]))), rx = Math.atan2(m[6], m[10]), rz = Math.atan2(m[1], m[0]);
    return {
      ...part,
      position: P(G[0] * p[0] + G[4] * p[1] + G[8] * p[2] + G[12], G[1] * p[0] + G[5] * p[1] + G[9] * p[2] + G[13], G[2] * p[0] + G[6] * p[1] + G[10] * p[2] + G[14]),
      rotation: P(rx / D, ry / D, rz / D),
    };
  };
}

// ------------------------------------------------------------------------------------ scenes
const SCENES = [];
const scene = (id, title, description, build) => SCENES.push({ id, title, description, build });

scene('showcase', 'Shape showcase', 'Every generator in one place: lathe, sweep with twist, extrude, tubes along knots and helices.', async (doc) => {
  const vase = [[0, 0]];
  for (let i = 0; i <= 40; i++) { const y = (i / 40) * 1.9; vase.push(P(0.42 + 0.2 * Math.sin(y * 2.6 - 0.6) + 0.04 * Math.sin(y * 11), y)); }
  const p = (i) => P(Math.cos((i / 7) * 2 * Math.PI) * 3.4, Math.sin((i / 7) * 2 * Math.PI) * 3.4);
  await tool(doc, 'set_environment', { reflections: 'studio', light: { direction: [0.5, 0.85, 0.45], intensity: 1, softness: 0.3 },
    lights: [{ direction: [-0.7, 0.35, -0.6], color: '#cfe0ff', intensity: 0.45 }] }); // chrome and glossy parts reflect softboxes
  await add(doc, [
    { name: 'Torus knot', shape: { type: 'tube', path: { type: 'torusKnot', p: 2, q: 3, steps: 256, size: 1.6 }, radius: 0.14, sides: 12 }, position: [0, 1.7, 0], material: { color: '#f2701f', roughness: 0.15, specular: 0.9, shininess: 180 } },
    { name: 'Vase', shape: { type: 'lathe', profile: vase, segments: 48 }, position: [p(0)[0], 0, p(0)[1]], material: { color: '#4d99d9', roughness: 0.18, specular: 0.7, shininess: 120, doubleSided: true } },
    { name: 'Twisted column', shape: { type: 'sweep', shape: { type: 'star', points: 6, outer: 0.45, inner: 0.28 }, path: { type: 'line', from: [0, 0, 0], to: [0, 1.9, 0], steps: 60 }, twist: 180 }, position: [p(1)[0], 0, p(1)[1]], material: { color: '#e6bd5c', metalness: 1, roughness: 0.3, specular: 1, shininess: 120 } },
    { name: 'Star', shape: { type: 'extrude', shape: { type: 'star', points: 5, outer: 0.75, inner: 0.32 }, depth: 0.3 }, position: [p(2)[0], 1, p(2)[1]], rotation: [0, 30, 0], material: { color: '#d93a4b', roughness: 0.22, specular: 0.8, shininess: 150 } },
    { name: 'Chrome sphere', shape: { type: 'sphere', radius: 0.65, segments: 40, rings: 20 }, position: [p(3)[0], 0.65, p(3)[1]], material: { color: '#dde1e6', metalness: 1, roughness: 0.14, specular: 1, shininess: 200 } },
    { name: 'Torus', shape: { type: 'torus', radius: 0.55, tube: 0.2 }, position: [p(4)[0], 0.8, p(4)[1]], rotation: [70, 0, 0], material: { color: '#46b866', roughness: 0.35, specular: 0.6, shininess: 80 } },
    { name: 'Spring', shape: { type: 'tube', path: { type: 'helix', radius: 0.4, height: 1.6, turns: 5, steps: 300 }, radius: 0.07, sides: 10 }, position: [p(5)[0], 0.1, p(5)[1]], material: { color: '#c9cbd2', metalness: 1, roughness: 0.25, specular: 0.8, shininess: 120 } },
    { name: 'Base', shape: { type: 'box', width: 0.9, height: 0.4, depth: 0.9 }, position: [p(6)[0], 0.2, p(6)[1]], material: { color: '#9a62d6', roughness: 0.4, specular: 0.5, shininess: 60 } },
    { name: 'Spire', shape: { type: 'cone', radius: 0.3, height: 1.0 }, position: [p(6)[0], 0.9, p(6)[1]], material: { color: '#9a62d6', roughness: 0.4, specular: 0.5, shininess: 60, flat: true } },
  ]);
  await tool(doc, 'set_camera', { yaw: 28, pitch: 24, distance: 10.5, target: [0, 0.9, 0] });
  await animate(doc, 'Torus knot', { spin: { axis: [0, 1, 0], speed: 30 } });
  await animate(doc, 'Twisted column', { spin: { axis: [0, 1, 0], speed: -30 } });
  await animate(doc, 'Star', { spin: { axis: [0, 1, 0], speed: 60 } });
  await animate(doc, 'Torus', { spin: { axis: [1, 0, 0], speed: 60 } });
  await animate(doc, 'Chrome sphere', { bob: { amplitude: 0.18, period: 2.4 } });
  await animate(doc, 'Spring', { bob: { amplitude: 0.08, period: 1.5 } });
  await timeline(doc, 12);
});

scene('phone', 'Smartphone', 'Studio product shot: squircle bodies with polished metal frames, a textured home screen under glass, softbox reflections and a stepped triple camera.', async (doc) => {
  await tool(doc, 'set_environment', {
    background: { top: '#0a0b0e', bottom: '#20242c' }, fog: null, ground: false, reflections: 'studio',
    light: { direction: [-0.45, 0.85, 0.45], color: '#fff4e8', intensity: 1, softness: 0.35 },
    lights: [
      { direction: [0.9, 0.3, -0.5], color: '#dfe8ff', intensity: 0.9 }, // rim light from behind right
      { direction: [0.4, 0.2, 0.9], color: '#ffffff', intensity: 0.25 }, // soft fill from the front
    ],
  });
  // real proportions: 146.6 x 70.6 x 8.25 mm, scene unit = 1 dm
  const W = 0.706, H = 1.466, D = 0.0825, CR = 0.15, E = 0.028;
  const rbox = (w, h, d, radius, cornerRadius, segments = 10, smooth = true) => ({ type: 'roundedBox', width: w, height: h, depth: d, radius, cornerRadius, segments, smooth });
  const slab = (w, h, r, d = 0.002, smooth = true) => ({ type: 'extrude', shape: { type: 'roundedRect', width: w, height: h, radius: r, segments: 10, smooth }, depth: d });
  const cyl = (r, h, segments = 48) => ({ type: 'cylinder', radiusTop: r, radiusBottom: r, height: h, segments });
  const dark = { color: '#0b0c0e', roughness: 0.6, specular: 0.2 };
  const o = [];

  o.push(
    { name: 'Floor', shape: { type: 'lathe', profile: [[14, 0], [0, 0]], segments: 64 }, material: { color: '#0e1014', roughness: 0.75, specular: 0.1 } },
    // the top is split into rings: long, thin fan triangles interpolate depth poorly (shadow streaks)
    { name: 'Podium', shape: { type: 'lathe', profile: [[0, 0], [1.35, 0], [1.35, 0.13], [1.3, 0.18], [1.0, 0.18], [0.7, 0.18], [0.4, 0.18], [0.15, 0.18], [0, 0.18]], segments: 96 }, material: { color: '#24272e', roughness: 0.3, specular: 0.5, shininess: 60 } },
  );
  const top = 0.18, lean = 10, ca = Math.cos((lean * Math.PI) / 180), sa = Math.sin((lean * Math.PI) / 180);
  const standY = P(top + (H / 2) * ca + (D / 2) * sa)[0];

  // parts every phone has: frame, buttons, antenna bands, USB-C port, speaker holes
  const shell = (G, frame) => {
    o.push(G({ name: 'Frame', shape: rbox(W, H, D, E, CR), material: frame }));
    o.push(
      G({ name: 'Action button', shape: rbox(0.03, 0.07, 0.034, 0.012, 0.012, 4, false), position: [-W / 2 - 0.004, 0.44, 0], material: frame }),
      G({ name: 'Volume up', shape: rbox(0.03, 0.12, 0.034, 0.012, 0.012, 4, false), position: [-W / 2 - 0.004, 0.3, 0], material: frame }),
      G({ name: 'Volume down', shape: rbox(0.03, 0.12, 0.034, 0.012, 0.012, 4, false), position: [-W / 2 - 0.004, 0.15, 0], material: frame }),
      G({ name: 'Side button', shape: rbox(0.03, 0.2, 0.034, 0.012, 0.012, 4, false), position: [W / 2 + 0.004, 0.25, 0], material: frame }),
    );
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      o.push(G({ name: 'Antenna band', shape: { type: 'box', width: 0.012, height: 0.008, depth: D * 0.72 }, position: [sx * (W / 2 - 0.003), sy * 0.62, 0], material: { color: '#55575b', roughness: 0.45 } }));
    }
    o.push(G({ name: 'USB-C port', shape: rbox(0.09, 0.03, 0.02, 0.009, 0.014, 6, false), position: [0, -H / 2 + 0.006, 0], rotation: [90, 0, 0], material: dark }));
    for (let k = 0; k < 6; k++) {
      for (const sx of [-1, 1]) o.push(G({ name: 'Speaker hole', shape: cyl(0.0065, 0.014, 12), position: [P(sx * (0.11 + k * 0.022))[0], -H / 2 + 0.004, 0], material: dark }));
    }
  };

  // ---- phone A: front, natural titanium, textured display under glass
  const A = group([-0.5, standY, 0.35], [-lean, 16, 0]);
  const front = D / 2;
  shell(A, { color: '#b9b6b0', metalness: 1, roughness: 0.25, specular: 0.8, shininess: 120 });
  o.push(
    A({ name: 'Front glass', shape: rbox(W - 0.012, H - 0.012, 0.004, 0.002, CR - 0.006, 10), position: [0, 0, front - 0.0015], material: { color: '#030405', roughness: 0.04, specular: 1.2, shininess: 256 } }),
    A({ name: 'Display', shape: slab(W - 0.05, H - 0.05, CR - 0.03, 0.001), position: [0, 0, front + 0.0012],
      material: { color: '#ffffff', texture: 'examples/textures/screen.png', emissive: 1, roughness: 0.04, specular: 0.6, shininess: 256 } }),
    A({ name: 'Camera island', shape: slab(0.212, 0.062, 0.031, 0.002, false), position: [0, H / 2 - 0.025 - 0.04, front + 0.0025], material: { color: '#010102', roughness: 0.05, specular: 1, shininess: 256 } }),
  );

  // ---- phone B: back, deep blue titanium, frosted glass, stepped triple camera
  const B = group([0.55, standY, -0.2], [lean, 158, 0]);
  const back = -D / 2, ring = { color: '#8d9bb3', metalness: 1, roughness: 0.18, specular: 1, shininess: 160 };
  shell(B, { color: '#33425a', metalness: 1, roughness: 0.3, specular: 0.8, shininess: 110 });
  o.push(
    B({ name: 'Back glass', shape: rbox(W - 0.012, H - 0.012, 0.004, 0.002, CR - 0.006, 10), position: [0, 0, back + 0.0015], material: { color: '#2e3c54', roughness: 0.5, specular: 0.3, shininess: 20 } }),
    B({ name: 'Camera plateau', shape: rbox(0.36, 0.36, 0.012, 0.006, 0.095, 8), position: [0.155, 0.535, back - 0.005], material: { color: '#2f3e57', roughness: 0.1, specular: 1, shininess: 220 } }),
  );
  for (const [x, y] of [[0.075, 0.615], [0.075, 0.455], [0.235, 0.535]]) {
    const z = back - 0.011;
    o.push(
      B({ name: 'Lens ring', shape: cyl(0.078, 0.024), position: [x, y, z - 0.012], rotation: [90, 0, 0], material: ring }),
      B({ name: 'Lens barrel', shape: cyl(0.065, 0.03), position: [x, y, z - 0.015], rotation: [90, 0, 0], material: { color: '#121418', roughness: 0.35, specular: 0.4 } }),
      B({ name: 'Lens element', shape: { type: 'torus', radius: 0.04, tube: 0.004, segments: 40, sides: 8 }, position: [x, y, z - 0.031], rotation: [90, 0, 0], material: { color: '#2b3858', roughness: 0.2, specular: 0.8 } }),
      B({ name: 'Lens glass', shape: { type: 'sphere', radius: 0.052, segments: 40, rings: 20 }, position: [x, y, z - 0.03], scale: [1, 1, 0.12], material: { color: '#050912', roughness: 0.05, specular: 1.6, shininess: 256 } }),
    );
  }
  o.push(
    B({ name: 'Flash', shape: cyl(0.026, 0.01, 32), position: [0.235, 0.648, back - 0.016], rotation: [90, 0, 0], material: { color: '#f3ead6', roughness: 0.3, specular: 0.5, emissive: 0.05 } }),
    B({ name: 'LiDAR', shape: cyl(0.022, 0.01, 32), position: [0.235, 0.422, back - 0.016], rotation: [90, 0, 0], material: { color: '#07080a', roughness: 0.08, specular: 1.2, shininess: 220 } }),
  );
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 12, pitch: 7, distance: 2.7, target: [0.02, 0.9, 0] });
  // turntable: everything on the podium turns around the vertical axis
  await animate(doc, (o) => o.name !== 'Floor', { orbit: { center: [0, 0, 0], axis: [0, 1, 0], speed: 15 } });
  await timeline(doc, 24);
});

scene('watch', 'Skeleton watch', 'A mechanical skeleton watch at 10:10: spoked brass gears (extrude with holes), a hairspring (tube along a spiral), blued screws, ruby jewels, polished steel and a leather strap.', async (doc) => {
  await tool(doc, 'set_environment', {
    background: { top: '#08090b', bottom: '#1e2128' }, fog: null, ground: false, reflections: 'studio',
    light: { direction: [-0.4, 0.9, 0.35], color: '#fff3e6', intensity: 1.05, softness: 0.3 },
    lights: [{ direction: [0.8, 0.35, -0.6], color: '#d8e4ff', intensity: 0.7 }, { direction: [0.3, 0.4, 0.9], color: '#ffffff', intensity: 0.2 }],
  });
  const o = [];
  const TAU = Math.PI * 2;
  // parts lying flat: shape coordinates (x, y) on the dial, y = towards 12 o'clock (world -z)
  const flat = (x, y, h, deg = 0) => ({ position: P(x, h, -y), rotation: [-90, deg, 0] });
  const pts = (list) => list.map(([x, y]) => P(x, y));
  const circle = (r, n = 48, cx = 0, cy = 0) => pts(Array.from({ length: n }, (_, i) => [cx + Math.cos((i / n) * TAU) * r, cy + Math.sin((i / n) * TAU) * r]));
  // trapezoid teeth; skew > 0 gives the club teeth of an escape wheel
  const gearOutline = (teeth, rOut, rRoot, skew = 0) => {
    const out = [];
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * TAU, st = TAU / teeth;
      for (const [r, f] of [[rRoot, 0], [rOut, 0.28 + skew], [rOut, 0.52 + skew], [rRoot, 0.8]]) out.push([Math.cos(a + f * st) * r, Math.sin(a + f * st) * r]);
    }
    return pts(out);
  };
  // windows between spokes: annular sectors from the hub to the rim
  const spokeHoles = (spokes, rHub, rRim, spokeW) => Array.from({ length: spokes }, (_, k) => {
    const a0 = (k / spokes) * TAU + spokeW / rHub / 2, a1 = ((k + 1) / spokes) * TAU - spokeW / rHub / 2;
    const b0 = (k / spokes) * TAU + spokeW / rRim / 2, b1 = ((k + 1) / spokes) * TAU - spokeW / rRim / 2;
    const arc = [];
    for (let i = 0; i <= 10; i++) { const t = b0 + ((b1 - b0) * i) / 10; arc.push([Math.cos(t) * rRim, Math.sin(t) * rRim]); }
    for (let i = 5; i >= 0; i--) { const t = a0 + ((a1 - a0) * i) / 5; arc.push([Math.cos(t) * rHub, Math.sin(t) * rHub]); }
    return pts(arc);
  });
  const steel = { color: '#cfd3d9', metalness: 1, roughness: 0.12, specular: 1, shininess: 200 };
  const brass = { color: '#d9ad55', metalness: 1, roughness: 0.2, specular: 1, shininess: 150 };
  const blued = { color: '#2f55d4', metalness: 1, roughness: 0.15, specular: 1, shininess: 160 };
  const ruby = { color: '#c3102f', roughness: 0.03, specular: 1.6, shininess: 256, emissive: 0.25 };

  // ---- table and case
  o.push({ name: 'Slate', shape: { type: 'roundedBox', width: 16, height: 0.4, depth: 16, radius: 0.08, cornerRadius: 0.3, segments: 4 }, position: [0, -0.2, 0], material: { color: '#1b1e24', roughness: 0.45, specular: 0.3 } });
  o.push({ name: 'Case', shape: { type: 'lathe', profile: [[0, 0.02], [1.95, 0.02], [2.12, 0.14], [2.2, 0.45], [2.2, 0.85], [2.12, 1.02], [2.0, 1.08], [1.84, 1.08], [1.8, 1.0], [1.8, 0.4], [0, 0.4]], segments: 128 }, material: steel });
  o.push({ name: 'Bezel', shape: { type: 'lathe', profile: [[1.8, 1.08], [2.04, 1.08], [2.0, 1.2], [1.84, 1.2], [1.8, 1.08]], segments: 128 }, material: { color: '#dba48a', metalness: 1, roughness: 0.14, specular: 1, shininess: 200 } });
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    o.push({ name: 'Lug', shape: { type: 'roundedBox', width: 0.42, height: 0.42, depth: 0.95, radius: 0.1, cornerRadius: 0.1, segments: 5 }, position: [sx * 1.3, 0.5, -sy * 2.05], material: steel });
  }
  o.push(
    { name: 'Crown stem', shape: { type: 'cylinder', radiusTop: 0.08, radiusBottom: 0.08, height: 0.25, segments: 24 }, position: [2.3, 0.62, 0], rotation: [0, 0, 90], material: steel },
    { name: 'Crown', shape: { type: 'extrude', shape: { type: 'star', points: 36, outer: 0.27, inner: 0.245 }, depth: 0.3 }, position: [2.55, 0.62, 0], rotation: [0, 90, 0], material: steel },
    { name: 'Crown cap', shape: { type: 'cylinder', radiusTop: 0.2, radiusBottom: 0.2, height: 0.03, segments: 40 }, position: [2.715, 0.62, 0], rotation: [0, 0, 90], material: { color: '#dba48a', metalness: 1, roughness: 0.14 } },
  );

  // ---- movement: plate, wheel train, bridges, jewels, screws
  o.push({ name: 'Main plate', shape: { type: 'extrude', shape: circle(1.78, 128), depth: 0.06, holes: [circle(0.28, 32, -0.5, -0.8), circle(0.16, 24, 0.69, -0.69), circle(0.2, 24, 1.0, 0.35)] }, ...flat(0, 0, 0.43), material: { color: '#a9aeb6', metalness: 1, roughness: 0.42, specular: 0.6 } });
  const wheels = [
    { name: 'Barrel', at: [-0.75, 0.62], teeth: 72, r: 0.62, spokes: 0, h: 0.58, mat: brass },
    { name: 'Center wheel', at: [0, 0], teeth: 64, r: 0.62, spokes: 5, h: 0.5, mat: brass },
    { name: 'Third wheel', at: [0.86, 0.5], teeth: 50, r: 0.42, spokes: 4, h: 0.5, mat: brass },
    { name: 'Fourth wheel', at: [1.045, -0.218], teeth: 48, r: 0.36, spokes: 4, h: 0.5, mat: brass },
    { name: 'Escape wheel', at: [0.69, -0.69], teeth: 15, r: 0.26, spokes: 3, h: 0.5, mat: steel, skew: 0.18 },
  ];
  for (const w of wheels) {
    const tooth = w.teeth > 20 ? 0.035 : 0.06;
    o.push({ name: w.name, shape: { type: 'extrude', shape: gearOutline(w.teeth, w.r, w.r - tooth, w.skew || 0), depth: 0.045,
      holes: w.spokes ? spokeHoles(w.spokes, w.r * 0.22, w.r * 0.78, w.r * 0.12) : [] }, ...flat(w.at[0], w.at[1], w.h), material: w.mat });
    o.push({ name: `${w.name} pinion`, shape: { type: 'extrude', shape: { type: 'star', points: 8, outer: 0.075, inner: 0.05 }, depth: 0.16 }, ...flat(w.at[0], w.at[1], w.h + 0.05), material: steel });
  }
  o.push({ name: 'Barrel drum', shape: { type: 'extrude', shape: circle(0.55, 64), depth: 0.1, holes: [circle(0.12, 24)] }, ...flat(-0.75, 0.62, 0.65), material: { color: '#c79a48', metalness: 1, roughness: 0.32 } });
  o.push({ name: 'Barrel arbor', shape: { type: 'extrude', shape: { type: 'star', points: 3, outer: 0.12, inner: 0.08 }, depth: 0.12 }, ...flat(-0.75, 0.62, 0.68), material: steel });

  // balance wheel with hairspring
  o.push({ name: 'Balance rim', shape: { type: 'extrude', shape: circle(0.5, 96), depth: 0.05, holes: [circle(0.44, 96)] }, ...flat(-0.5, -0.8, 0.58), material: brass });
  for (let k = 0; k < 3; k++) {
    const a = k * 120;
    const c = [-0.5 + Math.cos((a * Math.PI) / 180) * 0.235, -0.8 + Math.sin((a * Math.PI) / 180) * 0.235];
    o.push({ name: 'Balance arm', shape: { type: 'extrude', shape: { type: 'rect', width: 0.44, height: 0.045 }, depth: 0.045 }, ...flat(c[0], c[1], 0.58, a), material: brass });
    o.push({ name: 'Balance screw', shape: { type: 'cylinder', radiusTop: 0.03, radiusBottom: 0.03, height: 0.05, segments: 12 }, ...flat(-0.5 + Math.cos(((a + 60) * Math.PI) / 180) * 0.5, -0.8 + Math.sin(((a + 60) * Math.PI) / 180) * 0.5, 0.58), rotation: [0, 0, 0], material: { color: '#e8c070', metalness: 1, roughness: 0.15 } });
  }
  const spiral = [];
  for (let i = 0; i <= 260; i++) { const t = i / 260, a = t * TAU * 7.5, r = 0.06 + t * 0.27; spiral.push(P(-0.5 + Math.cos(a) * r, 0.64, 0.8 - Math.sin(a) * r)); }
  o.push({ name: 'Hairspring', shape: { type: 'tube', path: spiral, radius: 0.006, sides: 6 }, material: { color: '#9fb4ff', metalness: 1, roughness: 0.2 } });
  o.push({ name: 'Pallet fork', shape: { type: 'extrude', shape: [[-0.32, -0.025], [0.12, -0.03], [0.2, -0.12], [0.26, -0.1], [0.19, 0.0], [0.26, 0.1], [0.2, 0.12], [0.12, 0.03], [-0.32, 0.025]], depth: 0.035 }, ...flat(0.22, -0.74, 0.53, 4), material: steel });
  o.push({ name: 'Pallet jewel', shape: { type: 'box', width: 0.05, height: 0.03, depth: 0.03 }, position: P(0.45, 0.56, 0.86), material: ruby });

  // bridges (polished steel bars) with ruby jewels in polished chatons and blued screws
  const bridge = (name, a, b, w = 0.26) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) + w, ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    o.push({ name, shape: { type: 'extrude', shape: { type: 'roundedRect', width: len, height: w, radius: w / 2, segments: 8 }, depth: 0.05 }, ...flat((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0.72, P(ang)[0]), material: steel });
  };
  const jewel = (x, y) => {
    o.push({ name: 'Chaton', shape: { type: 'torus', radius: 0.05, tube: 0.014, segments: 24, sides: 8 }, position: P(x, 0.75, -y), material: steel });
    o.push({ name: 'Jewel', shape: { type: 'sphere', radius: 0.04, segments: 20, rings: 10 }, position: P(x, 0.75, -y), scale: [1, 0.45, 1], material: ruby });
  };
  const screw = (x, y, slot) => {
    o.push({ name: 'Screw', shape: { type: 'cylinder', radiusTop: 0.06, radiusBottom: 0.065, height: 0.05, segments: 24 }, position: P(x, 0.77, -y), material: blued });
    o.push({ name: 'Screw slot', shape: { type: 'box', width: 0.1, height: 0.012, depth: 0.016 }, position: P(x, 0.795, -y), rotation: [0, slot, 0], material: { color: '#0b1022', roughness: 0.6 } });
  };
  bridge('Barrel bridge', [-1.25, 0.9], [-0.25, 0.35], 0.34);
  bridge('Train bridge', [0.05, 0.05], [0.86, 0.5]);
  bridge('Train bridge 2', [0.86, 0.5], [1.045, -0.218]);
  bridge('Escape bridge', [1.045, -0.218], [0.69, -0.69], 0.22);
  bridge('Balance cock', [-0.5, -0.8], [-1.3, -0.5], 0.3);
  for (const w of wheels.slice(1)) jewel(w.at[0], w.at[1]);
  jewel(-0.5, -0.8);
  for (const [x, y, s] of [[-1.25, 0.9, 20], [-0.25, 0.35, 75], [0.42, 0.25, 140], [1.2, 0.18, 35], [0.82, -0.52, 110], [-1.3, -0.5, 160]]) screw(x, y, s);
  // barrel ratchet wheel on top of the barrel bridge
  o.push({ name: 'Ratchet wheel', shape: { type: 'extrude', shape: gearOutline(40, 0.3, 0.27, 0.15), depth: 0.04, holes: spokeHoles(3, 0.08, 0.22, 0.05) }, ...flat(-0.75, 0.62, 0.78), material: { color: '#d4d8de', metalness: 1, roughness: 0.25 } });
  screw(-0.75, 0.62, 45);

  // ---- dial ring, markers, hands at 10:10:35
  o.push({ name: 'Chapter ring', shape: { type: 'extrude', shape: circle(1.79, 128), depth: 0.04, holes: [circle(1.46, 128)] }, ...flat(0, 0, 0.98), material: { color: '#121419', roughness: 0.35, specular: 0.4 } });
  for (let k = 0; k < 12; k++) {
    const a = 90 - k * 30, ar = (a * Math.PI) / 180;
    for (const off of k === 0 ? [-0.035, 0.035] : [0]) {
      const x = Math.cos(ar) * 1.6 - Math.sin(ar) * off, y = Math.sin(ar) * 1.6 + Math.cos(ar) * off;
      o.push({ name: 'Hour marker', shape: { type: 'roundedBox', width: 0.2, height: 0.045, depth: 0.04, radius: 0.012, cornerRadius: 0.02, segments: 3 }, ...flat(x, y, 1.02, a), material: steel });
    }
  }
  for (let k = 0; k < 60; k++) {
    if (k % 5 === 0) continue;
    const ar = ((90 - k * 6) * Math.PI) / 180;
    o.push({ name: 'Minute dot', shape: { type: 'cylinder', radiusTop: 0.014, radiusBottom: 0.014, height: 0.02, segments: 8 }, position: P(Math.cos(ar) * 1.73, 1.01, -Math.sin(ar) * 1.73), material: { color: '#e9ebef', roughness: 0.4 } });
  }
  const hand = (name, angle, h, parts) => {
    const G = group([0, h, 0], [-90, -angle, 0]);
    for (const p of parts) o.push(G({ name, ...p }));
  };
  const lume = { color: '#dfffe9', emissive: 0.9, roughness: 0.5 };
  hand('Hour hand', 305, 1.05, [
    { shape: { type: 'extrude', shape: [[-0.06, -0.16], [0.06, -0.16], [0.075, 0.55], [0, 0.92], [-0.075, 0.55]], depth: 0.025 }, material: steel },
    { shape: { type: 'extrude', shape: [[-0.032, 0.18], [0.032, 0.18], [0.04, 0.55], [0, 0.78], [-0.04, 0.55]], depth: 0.01 }, position: [0, 0, 0.016], material: lume },
  ]);
  hand('Minute hand', 63.5, 1.09, [
    { shape: { type: 'extrude', shape: [[-0.05, -0.2], [0.05, -0.2], [0.058, 1.0], [0, 1.42], [-0.058, 1.0]], depth: 0.025 }, material: steel },
    { shape: { type: 'extrude', shape: [[-0.026, 0.25], [0.026, 0.25], [0.03, 1.0], [0, 1.25], [-0.03, 1.0]], depth: 0.01 }, position: [0, 0, 0.016], material: lume },
  ]);
  hand('Seconds hand', 210, 1.13, [
    { shape: { type: 'extrude', shape: [[-0.013, -0.42], [0.013, -0.42], [0.007, 1.5], [-0.007, 1.5]], depth: 0.015 }, material: { color: '#e0352c', roughness: 0.3, specular: 0.8 } },
    { shape: { type: 'extrude', shape: circle(0.055, 24, 0, -0.3), depth: 0.015 }, material: { color: '#e0352c', roughness: 0.3, specular: 0.8 } },
  ]);
  o.push({ name: 'Hand cap', shape: { type: 'cylinder', radiusTop: 0.07, radiusBottom: 0.08, height: 0.1, segments: 32 }, position: [0, 1.12, 0], material: steel });

  // ---- leather strap with stitching
  for (const side of [-1, 1]) {
    const path = [];
    for (let i = 0; i <= 30; i++) { const t = i / 30, z = side * (1.95 + t * 5), drop = Math.min(1, t * 2.2); path.push(P(0, 0.5 - 0.36 * (drop * drop * (3 - 2 * drop)), z)); }
    o.push({ name: 'Strap', shape: { type: 'sweep', shape: { type: 'roundedRect', width: 0.26, height: 2.0, radius: 0.1, segments: 4 }, path, caps: true }, material: { color: '#3b2418', roughness: 0.75, specular: 0.05, shininess: 16 } });
    for (let k = 0; k < 9; k++) {
      const z = side * (2.55 + k * 0.48);
      const t = (Math.abs(z) - 1.95) / 5, drop = Math.min(1, t * 2.2), y = 0.5 - 0.36 * (drop * drop * (3 - 2 * drop)) + 0.14;
      for (const x of [-0.88, 0.88]) o.push({ name: 'Stitch', shape: { type: 'box', width: 0.035, height: 0.02, depth: 0.22 }, position: P(x, y, z), material: { color: '#e9dcc0', roughness: 0.7 } });
    }
  }
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 28, pitch: 50, distance: 6.1, target: [0.2, 0.62, 0.25] });
  // the seconds hand and fourth wheel tick once per second, the escapement twice, the balance swings
  const dialAxis = { axis: [0, 0, 1] }; // flat parts: their local z is the watch's vertical axis
  await animate(doc, 'Seconds hand', { spin: { ...dialAxis, speed: -6, step: 1 } });
  await animate(doc, 'Minute hand', { spin: { ...dialAxis, speed: -0.1 } });
  await animate(doc, ['Fourth wheel', 'Fourth wheel pinion'], { spin: { ...dialAxis, speed: -6, step: 1 } });
  await animate(doc, ['Third wheel', 'Third wheel pinion'], { spin: { ...dialAxis, speed: 6 } });
  await animate(doc, ['Escape wheel', 'Escape wheel pinion'], { spin: { ...dialAxis, speed: -24, step: 0.5 } });
  await animate(doc, 'Pallet fork', { swing: { ...dialAxis, amplitude: 7, period: 1 } });
  await animate(doc, ['Balance rim', 'Balance arm', 'Balance screw', 'Hairspring'], { swing: { axis: [0, 1, 0], amplitude: 150, period: 1, pivot: [-0.5, 0.6, 0.8] } });
  await cameraPath(doc, 60, [{ t: 20, yaw: 8, pitch: 60, distance: 4.3, target: [0.1, 0.66, 0.1] }, { t: 40, yaw: 52, pitch: 40, distance: 5.2 }]);
});

scene('engine', 'Turbofan cutaway', 'A turbofan with the casing cut open: 22 twisted fan blades, booster and high-pressure compressor stages, a glowing combustor, heat-tinted turbines, all as radial arrays of NACA-profiled blades.', async (doc) => {
  await tool(doc, 'set_environment', {
    background: { top: '#07080a', bottom: '#1d2027' }, fog: null, ground: false, reflections: 'studio',
    light: { direction: [-0.35, 0.85, 0.55], color: '#fff3e6', intensity: 1.05, softness: 0.3 },
    lights: [{ direction: [0.7, 0.4, -0.6], color: '#d6e2ff', intensity: 0.75 }, { direction: [0.2, 0.3, 0.95], color: '#ffffff', intensity: 0.2 }],
  });
  const TAU = Math.PI * 2, H0 = 1.62;
  // the engine is modelled along the local Y axis (lathes and radial arrays), then laid along world X
  const E = group([0, H0, 0], [0, 0, -90]);
  // symmetric NACA 00xx airfoil, chord along x, rotated by the blade pitch
  const airfoil = (chord, thick, pitch, n = 9) => {
    const t = thick / chord, up = [], lo = [];
    for (let i = 0; i <= n; i++) {
      const u = (1 - Math.cos((i / n) * Math.PI)) / 2;
      const yt = 5 * t * chord * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
      up.push([u * chord - chord / 2, yt]);
      if (i > 0 && i < n) lo.push([u * chord - chord / 2, -yt]);
    }
    const a = (pitch * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    return [...up, ...lo.reverse()].map(([x, y]) => P(x * c - y * sn, x * sn + y * c));
  };
  // a ring of blades: one blade swept radially from rHub to rTip with twist, repeated around the axis
  // small blades get a coarser profile: hundreds of them, each only a few pixels wide
  const bladeRing = (name, y, count, rHub, rTip, chord, pitch, twist, mat, thick = 0.12, fine = false) => E({
    name, shape: { type: 'radial', count, offset: [0, y, 0], shape: { type: 'sweep', shape: airfoil(chord, chord * thick, pitch, fine ? 9 : 4),
      path: { type: 'line', from: [rHub, 0, 0], to: [rTip, 0, 0], steps: fine ? 12 : 3 }, twist, caps: true } }, material: mat,
  });
  const titanium = { color: '#a7aeb7', metalness: 1, roughness: 0.26, specular: 0.9, shininess: 140 };
  const steel = { color: '#c9cdd3', metalness: 1, roughness: 0.18, specular: 1, shininess: 180 };
  const stator = { color: '#727880', metalness: 1, roughness: 0.38, specular: 0.6 };
  const hotGold = { color: '#c99550', metalness: 1, roughness: 0.25, specular: 1, shininess: 150 };
  const hotBlue = { color: '#6f7fae', metalness: 1, roughness: 0.25, specular: 1, shininess: 150 };
  // casing parts are revolved through 240 degrees: the open side faces the camera
  const cut = { phiStart: 171.7, phiLength: 240 };
  const o = [];

  // ---- studio and stand
  o.push(
    { name: 'Floor', shape: { type: 'lathe', profile: [[16, 0], [0, 0]], segments: 64 }, material: { color: '#0f1115', roughness: 0.7, specular: 0.15 } },
    { name: 'Base', shape: { type: 'roundedBox', width: 3.8, height: 0.12, depth: 1.9, radius: 0.04, cornerRadius: 0.12, segments: 4 }, position: [0, 0.06, 0], material: { color: '#2a2d33', roughness: 0.45, specular: 0.4 } },
  );
  const R = 1.27, c0 = H0 - 0.12, half = 0.75, aEdge = Math.acos(half / R);
  const cradle = [[-half, 0], [half, 0]];
  for (let i = 0; i <= 24; i++) { const a = -aEdge - (Math.PI - 2 * aEdge) * (i / 24); cradle.push([Math.cos(a) * R, c0 + Math.sin(a) * R]); }
  for (const x of [-0.95, 0.95]) {
    o.push({ name: 'Cradle', shape: { type: 'extrude', shape: cradle.map(([a, b]) => P(a, b)), depth: 0.16 }, position: [x, 0.12, 0], rotation: [0, 90, 0], material: { color: '#f0b400', roughness: 0.4, specular: 0.6, shininess: 60 } });
  }

  // ---- intake: spinner with a spiral marking, fan
  const spinner = [[0, 1.2], [0.29, 1.2], [0.27, 1.36], [0.19, 1.5], [0.09, 1.6], [0, 1.64]];
  o.push(E({ name: 'Spinner', shape: { type: 'lathe', profile: spinner, segments: 64 }, material: { color: '#eef0f3', roughness: 0.25, specular: 0.8, shininess: 120 } }));
  const swirl = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80, y = 1.22 + t * 0.4, k = (y - 1.2) / 0.44;
    const r = (k < 0.36 ? 0.29 - k * 0.055 : k < 0.68 ? 0.27 - (k - 0.36) * 0.25 : k < 0.91 ? 0.19 - (k - 0.68) * 0.43 : 0.09 - (k - 0.91) * 1) * 1.01 + 0.003;
    const a = t * TAU * 0.9;
    swirl.push(P(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  o.push(E({ name: 'Spinner swirl', shape: { type: 'tube', path: swirl, radius: 0.011, sides: 6 }, material: { color: '#16181c', roughness: 0.4 } }));
  o.push(E({ name: 'Fan disk', shape: { type: 'cylinder', radiusTop: 0.3, radiusBottom: 0.32, height: 0.24, segments: 48 }, position: [0, 1.04, 0], material: { color: '#5d636b', metalness: 1, roughness: 0.35 } }));
  o.push(bladeRing('Fan blades', 1.04, 22, 0.26, 1.08, 0.36, 58, -46, titanium, 0.09, true));

  // ---- casings (cut open)
  o.push(E({ name: 'Nacelle', shape: { type: 'lathe', segments: 96, ...cut,
    profile: [[1.12, 1.34], [1.2, 1.3], [1.25, 1.1], [1.25, 0.3], [1.21, -0.5], [1.13, -0.95], [1.09, -0.95], [1.12, -0.5], [1.15, 0.3], [1.14, 1.1], [1.12, 1.34]] },
    material: { color: '#e9ebef', roughness: 0.3, specular: 0.6, shininess: 80 } }));
  o.push(E({ name: 'Fan case liner', shape: { type: 'lathe', segments: 96, ...cut, profile: [[1.115, 1.25], [1.14, 1.25], [1.14, 0.8], [1.115, 0.8], [1.115, 1.25]] }, material: { color: '#3b3f46', roughness: 0.6 } }));
  o.push(E({ name: 'Core casing', shape: { type: 'lathe', segments: 96, ...cut,
    profile: [[0.52, 0.86], [0.57, 0.8], [0.59, 0.2], [0.57, -0.6], [0.52, -1.15], [0.5, -1.5], [0.46, -1.5], [0.48, -1.15], [0.53, -0.6], [0.55, 0.2], [0.53, 0.8], [0.52, 0.86]] },
    material: { color: '#8e949c', metalness: 0.85, roughness: 0.32, specular: 0.8 } }));
  o.push(E({ name: 'Outlet guide vanes', shape: { type: 'radial', count: 40, radius: 0.86, offset: [0, 0.62, 0], rotation: [0, 12, 0], shape: { type: 'box', width: 0.54, height: 0.16, depth: 0.018 } }, material: stator }));

  // ---- booster (low-pressure compressor)
  for (const [k, y] of [0.74, 0.62, 0.5].entries()) {
    o.push(bladeRing(`Booster rotor ${k + 1}`, y, 36, 0.2, 0.5, 0.075, 50, -20, titanium));
    o.push(bladeRing(`Booster stator ${k + 1}`, y - 0.06, 44, 0.24, 0.51, 0.05, -40, 8, stator));
  }
  // ---- high-pressure compressor on a conical drum
  o.push(E({ name: 'Compressor drum', shape: { type: 'lathe', profile: [[0, -0.2], [0.26, -0.2], [0.21, 0.44], [0, 0.44]], segments: 64 }, material: { color: '#7c828a', metalness: 1, roughness: 0.3 } }));
  for (let k = 0; k < 6; k++) {
    const y = 0.38 - k * 0.1, hub = 0.215 + k * 0.007;
    o.push(bladeRing(`HP rotor ${k + 1}`, y, 44 + k * 4, hub, 0.47 - k * 0.018, 0.055, 48, -14, steel));
    o.push(bladeRing(`HP stator ${k + 1}`, y - 0.05, 52 + k * 4, hub + 0.03, 0.48 - k * 0.018, 0.04, -38, 6, stator));
  }

  // ---- combustor: liner, fuel nozzles, flames
  o.push(E({ name: 'Combustor liner', shape: { type: 'lathe', segments: 96, ...cut, profile: [[0.3, -0.24], [0.46, -0.24], [0.48, -0.36], [0.44, -0.5], [0.32, -0.5], [0.28, -0.36], [0.3, -0.24]] },
    material: { color: '#9b8a78', metalness: 1, roughness: 0.4 } }));
  o.push(E({ name: 'Combustion glow', shape: { type: 'torus', radius: 0.38, tube: 0.065, segments: 64, sides: 12 }, position: [0, -0.37, 0], material: { color: '#ff6a12', emissive: 1.8 } }));
  o.push(E({ name: 'Fuel nozzles', shape: { type: 'radial', count: 20, radius: 0.38, offset: [0, -0.27, 0], shape: { type: 'cylinder', radiusTop: 0.022, radiusBottom: 0.03, height: 0.08, segments: 10 } }, material: steel }));
  o.push(E({ name: 'Flames', shape: { type: 'radial', count: 20, radius: 0.38, offset: [0, -0.4, 0], rotation: [180, 0, 0], shape: { type: 'cone', radius: 0.035, height: 0.16, segments: 10 } }, material: { color: '#ffd27a', emissive: 2.4 } }));

  // ---- turbines: heat-tinted, high pressure gold, low pressure blue
  for (const [k, y] of [-0.56, -0.65].entries()) o.push(bladeRing(`HP turbine ${k + 1}`, y, 50, 0.25, 0.44, 0.06, -52, 12, hotGold));
  for (let k = 0; k < 4; k++) {
    const y = -0.77 - k * 0.11;
    o.push(bladeRing(`LP turbine ${k + 1}`, y, 46, 0.24, 0.45 + k * 0.012, 0.07, -50, 18, hotBlue));
    o.push(bladeRing(`LP turbine vanes ${k + 1}`, y + 0.055, 40, 0.26, 0.46 + k * 0.012, 0.05, 40, -8, { color: '#8a6446', metalness: 1, roughness: 0.4 }));
  }
  o.push(E({ name: 'Shaft', shape: { type: 'cylinder', radiusTop: 0.07, radiusBottom: 0.07, height: 2.7, segments: 32 }, position: [0, -0.15, 0], material: steel }));
  o.push(E({ name: 'Turbine disks', shape: { type: 'lathe', profile: [[0, -1.18], [0.24, -1.18], [0.25, -0.52], [0, -0.52]], segments: 64 }, material: { color: '#6a5f57', metalness: 1, roughness: 0.4 } }));
  o.push(E({ name: 'Exhaust cone', shape: { type: 'lathe', profile: [[0, -1.78], [0.12, -1.68], [0.22, -1.42], [0.24, -1.18], [0, -1.18]], segments: 64 }, material: { color: '#55504c', metalness: 1, roughness: 0.42 } }));

  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 38, pitch: 14, distance: 4.7, target: [0.1, 1.5, 0] });
  // low-pressure spool (fan, booster, LP turbine) and the faster high-pressure spool spin around the engine axis
  const lp = (o) => /^(Spinner|Spinner swirl|Fan disk|Fan blades|Booster rotor|LP turbine \d|Shaft|Turbine disks)/.test(o.name);
  const hp = (o) => /^(HP rotor|HP turbine|Compressor drum)/.test(o.name);
  await animate(doc, lp, { spin: { axis: [0, 1, 0], speed: 240 } });
  await animate(doc, hp, { spin: { axis: [0, 1, 0], speed: 480 } });
  await animate(doc, 'Combustion glow', { pulse: { min: 0.75, max: 1.3, period: 0.375 } });
  await animate(doc, 'Flames', { pulse: { min: 0.6, max: 1.4, period: 0.25 } });

  // ---- airflow: glowing streaks (flow behaviour) sucked into the intake, swirling through the bypass
  // duct behind the fan and leaving the core as a hot exhaust jet. Every ring of streaks is one object;
  // each pass takes 0.75 s, so the 3 s and 12 s loops are seamless.
  const streaks = (name, radii, y0, length, color, emissive, count, distance, extra = {}) => radii.map((radius, i) => E({
    name, position: [0, y0, 0],
    shape: { type: 'radial', count, radius, startAngle: (i * 137.5) % 360, shape: { type: 'cylinder', radiusTop: 0.006, radiusBottom: 0.006, height: length, segments: 5, caps: false } },
    material: { color, emissive },
    animation: { flow: { axis: [-1, 0, 0], distance, speed: distance / 0.75, phase: r4((i * 0.37) % 1), fade: 0.25 }, ...extra },
  }));
  await add(doc, [
    ...streaks('Intake air', [0.36, 0.5, 0.62, 0.74, 0.86, 0.97, 0.44, 0.68, 0.92], 3.6, 0.34, '#8fd3ff', 1.3, 9, 2.1),
    ...streaks('Bypass air', [0.68, 0.76, 0.84, 0.92, 1.0, 0.72, 0.88], 0.85, 0.28, '#b8e6ff', 1.2, 10, 2.0, { spin: { axis: [0, 1, 0], speed: 60 } }),
    ...streaks('Exhaust jet', [0.08, 0.16, 0.24, 0.32, 0.12, 0.28], -1.5, 0.24, '#ff8a3d', 1.6, 8, 1.8, { pulse: { min: 0.7, max: 1.3, period: 0.25 } }),
  ]);

  await cameraPath(doc, 12, [{ t: 6, yaw: 72, pitch: 22, distance: 4, target: [0.1, 1.45, 0] }]);
});

scene('fair', 'Fairground at dusk', 'A whole fairground in motion: a Ferris wheel whose gondolas stay upright, a carousel with galloping horses, a wave swinger, a roller coaster train riding its track on spline keyframes with real lift and drop speeds, fireworks, rising balloons and hundreds of lights.', async (doc) => {
  const rand = rng(77), D = Math.PI / 180, LOOP = 24;
  await tool(doc, 'set_environment', {
    background: { top: '#0b0f2e', bottom: '#f08a5d' }, fog: null, ground: false, reflections: 'sky',
    light: { direction: [-0.75, 0.32, -0.55], color: '#ffb27a', intensity: 1.15, softness: 0.2 },
    lights: [{ direction: [0.4, 0.8, 0.5], color: '#7d8cff', intensity: 0.45 }, { direction: [0.6, 0.25, -0.8], color: '#ff6fb0', intensity: 0.3 }],
  });
  // a cylinder from a to b: rotation [pitch, yaw, 0] turns its Y axis onto the direction
  const beam = (name, a, b, radius, material, extra = {}) => {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(...d), n = d.map((v) => v / len);
    return { name, shape: { type: 'cylinder', radiusTop: radius, radiusBottom: radius, height: r4(len), segments: 8 }, position: P((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2),
      rotation: P(Math.acos(Math.max(-1, Math.min(1, n[1]))) / D, Math.atan2(n[0], n[2]) / D, 0), material, ...extra };
  };
  const glow = (color, emissive = 2.2) => ({ color, emissive });
  const steel = { color: '#d9dde3', metalness: 1, roughness: 0.3 };
  const white = { color: '#f2efe8', roughness: 0.4, specular: 0.5 };
  const gold = { color: '#e3b35a', metalness: 1, roughness: 0.25 };
  const o = [];

  // ---- grounds: asphalt, lawns, paths
  o.push({ name: 'Ground', shape: { type: 'plane', width: 400, depth: 400 }, material: { color: '#2a2b30', roughness: 0.85, specular: 0.1 } });
  for (const [x, z, w, d] of [[-14, -4, 26, 14], [13, 4, 17, 17], [21, -9, 18, 18], [-26, 18, 16, 10], [26, 20, 14, 10]]) {
    o.push({ name: 'Lawn', shape: { type: 'box', width: w, height: 0.06, depth: d }, position: [x, 0.03, z], material: { color: '#2f4a2b', roughness: 0.95, specular: 0 } });
  }
  o.push({ name: 'Plaza', shape: { type: 'cylinder', radiusTop: 8, radiusBottom: 8, height: 0.08, segments: 64 }, position: [12, 0.04, 4], material: { color: '#8a7f73', roughness: 0.8 } });

  // ---- Ferris wheel: wheel parts spin around the axle; gondolas orbit and spin back, so they hang upright
  const C = [-14, 12.5, -4], RW = 10, WS = 15; // center, radius, degrees per second (one turn in the 24 s loop)
  const wheelSpin = { spin: { axis: [0, 0, 1], speed: WS, pivot: C } };
  for (const dz of [-0.9, 0.9]) {
    o.push({ name: 'Wheel rim', shape: { type: 'torus', radius: RW, tube: 0.16, segments: 96, sides: 8 }, position: [C[0], C[1], C[2] + dz], rotation: [90, 0, 0], material: { color: '#f4f4f6', roughness: 0.35, specular: 0.6 }, animation: wheelSpin });
    o.push({ name: 'Wheel inner rim', shape: { type: 'torus', radius: RW * 0.55, tube: 0.1, segments: 64, sides: 6 }, position: [C[0], C[1], C[2] + dz], rotation: [90, 0, 0], material: { color: '#f4f4f6', roughness: 0.35 }, animation: wheelSpin });
    o.push({ name: 'Wheel spokes', shape: { type: 'radial', axis: 'z', count: 16, radius: RW / 2, shape: { type: 'cylinder', radiusTop: 0.06, radiusBottom: 0.06, height: RW, segments: 5 }, rotation: [0, 0, 90] }, position: [C[0], C[1], C[2] + dz], material: steel, animation: wheelSpin });
  }
  o.push({ name: 'Wheel cross bars', shape: { type: 'radial', axis: 'z', count: 16, radius: RW, shape: { type: 'cylinder', radiusTop: 0.08, radiusBottom: 0.08, height: 1.8, segments: 5 }, rotation: [90, 0, 0] }, position: C, material: steel, animation: wheelSpin });
  o.push({ name: 'Wheel hub', shape: { type: 'cylinder', radiusTop: 0.9, radiusBottom: 0.9, height: 3.2, segments: 32 }, position: C, rotation: [90, 0, 0], material: { color: '#c8ccd2', metalness: 1, roughness: 0.25 }, animation: wheelSpin });
  // chasing lights: two interleaved rings that blink in turn
  for (const [k, color] of [[0, '#ffe2a8'], [1, '#ff7ac8']]) {
    for (const dz of [-1.0, 1.0]) {
      o.push({ name: 'Wheel lights', shape: { type: 'radial', axis: 'z', count: 32, radius: RW + 0.25, startAngle: k * 5.625, shape: { type: 'sphere', radius: 0.13, segments: 8, rings: 5 } },
        position: [C[0], C[1], C[2] + dz], material: glow(color, 2.4), animation: { ...wheelSpin, pulse: { min: 0.25, max: 1.2, period: 1, phase: k * 0.5, blink: true } } });
    }
    o.push({ name: 'Spoke lights', shape: { type: 'radial', axis: 'z', count: 16, radius: RW * 0.55 + 0.2, startAngle: 11.25 + k * 0.01, shape: { type: 'sphere', radius: 0.12, segments: 8, rings: 5 } },
      position: C, material: glow(k ? '#7ad7ff' : '#fff4c8', 2.2), animation: { ...wheelSpin, pulse: { min: 0.4, max: 1.3, period: 2, phase: k * 0.5 } } });
  }
  // A-frame legs and braces
  for (const sz of [-1, 1]) {
    const top = [C[0], C[1], C[2] + sz * 1.5];
    for (const sx of [-1, 1]) o.push(beam('Wheel leg', [C[0] + sx * 7, 0, C[2] + sz * 3], top, 0.28, { color: '#e8e9ec', roughness: 0.4 }));
    o.push(beam('Wheel brace', [C[0] - 3.5, C[1] / 2, C[2] + sz * 2.25], [C[0] + 3.5, C[1] / 2, C[2] + sz * 2.25], 0.14, { color: '#e8e9ec', roughness: 0.4 }));
  }
  o.push({ name: 'Wheel platform', shape: { type: 'roundedBox', width: 9, height: 0.6, depth: 7, radius: 0.1 }, position: [C[0], 0.3, C[2]], material: { color: '#55565e', roughness: 0.7 } });
  const gondolaColors = ['#e8483f', '#2bb3a6', '#f2c230', '#7b5cd6'];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * 360, p = P(C[0] + RW * Math.cos(a * D), C[1] + RW * Math.sin(a * D), C[2]);
    const anim = { orbit: { center: C, axis: [0, 0, 1], speed: WS }, spin: { axis: [0, 0, 1], speed: -WS }, swing: { axis: [0, 0, 1], amplitude: 3, period: 3, phase: r4((i * 0.37) % 1) } };
    const col = gondolaColors[i % 4];
    o.push({ name: 'Gondola', shape: { type: 'lathe', segments: 24, profile: [[0, -2.35], [0.82, -2.35], [0.98, -2.12], [1.02, -1.5]] }, position: p, material: { color: col, roughness: 0.35, specular: 0.7, doubleSided: true }, animation: anim });
    o.push({ name: 'Gondola roof', shape: { type: 'lathe', segments: 24, profile: [[0, -0.85], [1.02, -0.85], [1.05, -0.75], [0.3, -0.32], [0, -0.28]] }, position: p, material: { color: '#f4f1ea', roughness: 0.4 }, animation: anim });
    o.push({ name: 'Gondola hanger', shape: { type: 'radial', count: 1, offset: [0, -0.45, 0], shape: { type: 'cylinder', radiusTop: 0.06, radiusBottom: 0.06, height: 0.9, segments: 6 } }, position: p, material: steel, animation: anim });
    o.push({ name: 'Gondola lamp', shape: { type: 'radial', count: 1, offset: [0, -0.95, 0], shape: { type: 'sphere', radius: 0.14, segments: 8, rings: 5 } }, position: p, material: glow('#fff1c4', 2.6), animation: anim });
  }

  // ---- carousel: platform, canopy and lights spin; horses orbit with it and gallop up and down
  const K = [12, 0, 4], KS = 30;
  const carouselSpin = { spin: { axis: [0, 1, 0], speed: KS } };
  o.push({ name: 'Carousel base', shape: { type: 'cylinder', radiusTop: 6.2, radiusBottom: 6.4, height: 0.6, segments: 64 }, position: [K[0], 0.3, K[2]], material: { color: '#7a2f3a', roughness: 0.5 } });
  o.push({ name: 'Carousel floor', shape: { type: 'cylinder', radiusTop: 6, radiusBottom: 6, height: 0.12, segments: 64 }, position: [K[0], 0.66, K[2]], material: { color: '#b98b5a', roughness: 0.55 }, animation: carouselSpin });
  o.push({ name: 'Carousel column', shape: { type: 'lathe', segments: 32, profile: [[0, 0.7], [1.3, 0.7], [1.1, 1.2], [0.9, 1.2], [0.9, 4.6], [1.3, 4.9], [0, 4.9]] }, position: [K[0], 0, K[2]], material: { color: '#f3d9a2', metalness: 0.6, roughness: 0.3 }, animation: carouselSpin });
  for (const [k, color] of [[0, '#e94b5b'], [1, '#fbf3e4']]) {
    o.push({ name: 'Carousel canopy', shape: { type: 'radial', count: 12, startAngle: k * 15, shape: { type: 'lathe', segments: 3, phiStart: 0, phiLength: 15, profile: [[0, 7.6], [6.9, 5.3], [6.9, 4.95], [6.7, 4.95], [0, 7.3]] } },
      position: [K[0], 0, K[2]], material: { color, roughness: 0.45, specular: 0.4 }, animation: carouselSpin });
  }
  o.push({ name: 'Carousel crown', shape: { type: 'lathe', segments: 24, profile: [[0, 7.4], [0.7, 7.4], [0.5, 8.2], [0.15, 8.5], [0, 8.6]] }, position: [K[0], 0, K[2]], material: gold, animation: carouselSpin });
  o.push({ name: 'Carousel valance', shape: { type: 'torus', radius: 6.9, tube: 0.12, segments: 96, sides: 6 }, position: [K[0], 4.95, K[2]], material: gold, animation: carouselSpin });
  o.push({ name: 'Carousel lights', shape: { type: 'radial', count: 48, radius: 6.95, offset: [0, 5.15, 0], shape: { type: 'sphere', radius: 0.11, segments: 8, rings: 5 } }, position: [K[0], 0, K[2]],
    material: glow('#ffe7b0', 2.4), animation: { ...carouselSpin, pulse: { min: 0.6, max: 1.25, period: 1.5 } } });
  o.push({ name: 'Carousel inner lights', shape: { type: 'radial', count: 24, radius: 3.2, offset: [0, 6.6, 0], shape: { type: 'sphere', radius: 0.12, segments: 8, rings: 5 } }, position: [K[0], 0, K[2]],
    material: glow('#ff9ad0', 2.2), animation: { ...carouselSpin, pulse: { min: 0.4, max: 1.3, period: 1.5, phase: 0.5 } } });
  const horse = [[1.15, 0.62], [0.95, 0.88], [0.75, 0.98], [0.62, 0.9], [0.55, 0.6], [0.45, 0.35], [-0.5, 0.35], [-0.75, 0.45], [-1.12, 0.3], [-0.95, 0.2], [-0.75, 0.15],
    [-0.7, -0.25], [-0.98, -0.72], [-0.86, -0.8], [-0.55, -0.32], [-0.4, -0.2], [0.3, -0.2], [0.55, -0.45], [0.86, -0.56], [0.92, -0.46], [0.65, -0.3], [0.55, -0.05], [0.62, 0.18], [0.9, 0.46], [1.16, 0.5]];
  const horseColors = ['#f7f3ea', '#3b2a22', '#d9a066', '#f7f3ea', '#9aa3ad', '#7a4a2e'];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 360 + 15, r = i % 2 ? 3.9 : 5.1, x = K[0] + r * Math.cos(a * D), z = K[2] + r * Math.sin(a * D);
    const orbit = { orbit: { center: K, axis: [0, 1, 0], speed: KS } };
    o.push({ name: 'Horse', shape: { type: 'extrude', shape: horse, depth: 0.32 }, position: P(x, 2.3, z), rotation: [0, r4(90 - a), 0], scale: 0.95,
      material: { color: horseColors[i % 6], roughness: 0.35, specular: 0.7 }, animation: { ...orbit, bob: { amplitude: 0.38, period: 2, phase: i % 2 ? 0.5 : 0 } } });
    o.push({ name: 'Horse pole', shape: { type: 'cylinder', radiusTop: 0.05, radiusBottom: 0.05, height: 4.2, segments: 8 }, position: P(x, 2.85, z), material: gold, animation: orbit });
  }

  // ---- wave swinger: the crown spins, chairs fly outwards on tilted chains
  const Wc = [21, 0, -9], WSS = 60, chairR = 7.4, crownR = 4.3, crownY = 12.2, chairY = 7.2;
  const swingOrbit = { orbit: { center: Wc, axis: [0, 1, 0], speed: WSS } };
  o.push({ name: 'Swinger tower', shape: { type: 'lathe', segments: 24, profile: [[0, 0], [1.4, 0], [1.2, 0.6], [0.6, 0.9], [0.55, 12], [0, 12]] }, position: Wc, material: { color: '#f0e6d8', roughness: 0.4 } });
  o.push({ name: 'Swinger crown', shape: { type: 'lathe', segments: 48, profile: [[0, 11.7], [4.6, 11.9], [4.6, 12.3], [1.5, 13.4], [0.3, 14.4], [0, 14.6]] }, position: Wc, material: { color: '#3a63d6', roughness: 0.4, specular: 0.6 }, animation: { spin: { axis: [0, 1, 0], speed: WSS } } });
  o.push({ name: 'Swinger crown lights', shape: { type: 'radial', count: 40, radius: 4.65, offset: [0, 12.1, 0], shape: { type: 'sphere', radius: 0.12, segments: 8, rings: 5 } }, position: Wc,
    material: glow('#bfe9ff', 2.4), animation: { spin: { axis: [0, 1, 0], speed: WSS }, pulse: { min: 0.5, max: 1.3, period: 0.5, blink: true } } });
  const seatColors = ['#f2c230', '#e8483f', '#2bb3a6', '#ffffff'];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * 360;
    const top = [Wc[0] + crownR * Math.cos(a * D), crownY, Wc[2] + crownR * Math.sin(a * D)], seat = [Wc[0] + chairR * Math.cos(a * D), chairY, Wc[2] + chairR * Math.sin(a * D)];
    o.push(beam('Swing chain', top, seat, 0.03, steel, { animation: swingOrbit }));
    const hang = beam('', seat, top, 0, {}).rotation; // local Y up along the chain
    o.push({ name: 'Swing seat', shape: { type: 'roundedBox', width: 0.7, height: 0.12, depth: 0.7, radius: 0.05 }, position: P(...seat), rotation: hang, material: { color: seatColors[i % 4], roughness: 0.4 }, animation: swingOrbit });
    o.push({ name: 'Swing rider', shape: { type: 'radial', count: 1, offset: [0, 0.45, 0], shape: { type: 'sphere', radius: 0.26, segments: 10, rings: 7 } }, position: P(...seat), rotation: hang,
      material: { color: ['#d8a27a', '#8c5a3c', '#f0c9a0'][i % 3], roughness: 0.6 }, animation: swingOrbit });
  }

  // ---- roller coaster: a closed track along the back; the train rides it on keyframes timed by energy
  // conservation (slow over the lift hill, fast in the dips), two laps per loop
  const track = (a) => P(30 * Math.cos(a), 2.4 + 8 * ((1 + Math.cos(a)) / 2) ** 2 + 2 * (1 - Math.cos(3 * a)) / 2 + 1.2 * Math.sin(2 * a) ** 2, -31 + 8 * Math.sin(a));
  const N = 240, pts = Array.from({ length: N }, (_, i) => track((i / N) * Math.PI * 2));
  const lateral = (i) => {
    const a = pts[(i + N - 1) % N], b = pts[(i + 1) % N], tx = b[0] - a[0], tz = b[2] - a[2], l = Math.hypot(tx, tz);
    return [-tz / l, 0, tx / l];
  };
  for (const side of [-0.55, 0.55]) {
    o.push({ name: 'Coaster rail', shape: { type: 'tube', path: pts.map((p, i) => { const n = lateral(i); return P(p[0] + n[0] * side, p[1], p[2] + n[2] * side); }), radius: 0.09, sides: 6, closed: true }, material: { color: '#e23b3b', roughness: 0.35, specular: 0.6 } });
  }
  o.push({ name: 'Coaster spine', shape: { type: 'tube', path: pts.map((p) => P(p[0], p[1] - 0.45, p[2])), radius: 0.2, sides: 8, closed: true }, material: { color: '#d9d4cb', roughness: 0.5 } });
  for (let i = 0; i < N; i += 8) {
    const p = pts[i];
    o.push(beam('Coaster support', [p[0], 0, p[2]], [p[0], p[1] - 0.6, p[2]], 0.16, { color: '#d9d4cb', roughness: 0.5 }));
  }
  o.push({ name: 'Coaster station', shape: { type: 'roundedBox', width: 3, height: 2.6, depth: 8, radius: 0.1 }, position: [track(Math.PI)[0], 1.3, -31 + 2.6], material: { color: '#4e3b6e', roughness: 0.6 } });
  // arc length and travel time per sample point
  const sLen = [0];
  for (let i = 1; i <= N; i++) { const a = pts[i - 1], b = pts[i % N]; sLen.push(sLen[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])); }
  const total = sLen[N], hMax = Math.max(...pts.map((p) => p[1])), tAt = [0];
  for (let i = 1; i <= N; i++) { const h = (pts[i - 1][1] + pts[i % N][1]) / 2, v = Math.sqrt(16 + 2 * 9.81 * (hMax - h)); tAt.push(tAt[i - 1] + (sLen[i] - sLen[i - 1]) / v); }
  const lap = LOOP / 2, tScale = lap / tAt[N];
  const pointAtS = (s) => { // position and tangent at arc length s
    s = ((s % total) + total) % total;
    let i = 0;
    while (sLen[i + 1] < s) i++;
    const u = (s - sLen[i]) / (sLen[i + 1] - sLen[i]), a = pts[i], b = pts[(i + 1) % N];
    return { p: [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * u), d: [0, 1, 2].map((k) => b[k] - a[k]) };
  };
  const sAtTime = (t) => { // inverse of the travel time table
    t = (((t / tScale) % tAt[N]) + tAt[N]) % tAt[N];
    let i = 0;
    while (tAt[i + 1] < t) i++;
    return sLen[i] + ((t - tAt[i]) / (tAt[i + 1] - tAt[i])) * (sLen[i + 1] - sLen[i]);
  };
  const carColors = ['#ffd23f', '#3ec1d3', '#ff6b6b', '#a66cff'];
  for (let c = 0; c < 4; c++) {
    const keys = [];
    let lastYaw = null;
    for (let k = 0; k <= 112; k++) {
      const t = (k / 112) * LOOP, { p, d } = pointAtS(sAtTime(t) - c * 2.5);
      const hl = Math.hypot(d[0], d[2]);
      let yaw = Math.atan2(d[0], d[2]) / D;
      if (lastYaw !== null) { while (yaw < lastYaw - 180) yaw += 360; while (yaw > lastYaw + 180) yaw -= 360; }
      lastYaw = yaw;
      keys.push({ t: r4(t), position: P(p[0], p[1] + 0.75, p[2]), rotation: P(-Math.atan2(d[1], hl) / D, yaw, 0) });
    }
    const anim = { keys, ease: 'spline' };
    o.push({ name: 'Coaster car', shape: { type: 'roundedBox', width: 1.5, height: 0.8, depth: 2.2, radius: 0.18, segments: 4 }, position: keys[0].position, rotation: keys[0].rotation, material: { color: carColors[c], roughness: 0.3, specular: 0.8 }, animation: anim });
    o.push({ name: 'Coaster riders', shape: { type: 'radial', count: 2, radius: 0.36, offset: [0, 0.6, 0], shape: { type: 'sphere', radius: 0.24, segments: 10, rings: 7 } }, position: keys[0].position, rotation: keys[0].rotation,
      material: { color: ['#d8a27a', '#f0c9a0'][c % 2], roughness: 0.6 }, animation: anim });
  }

  // ---- fireworks: a rocket climbs, then a burst of streaks grows and fades (keyframed scale and glow)
  const shells = [[-4, 34, -22, 3, '#ffcf5a'], [10, 38, -26, 9, '#ff5fa2'], [-20, 30, -16, 15, '#6fe3ff'], [4, 36, -20, 20.5, '#9bff7a']];
  for (const [x, y, z, t0, color] of shells) {
    const times = [t0, (t0 + 12) % LOOP].sort((a, b) => a - b);
    const burst = [], rocket = [];
    for (const tb of times) {
      burst.push({ t: r4(tb - 0.02), scale: 0.001, emissive: 0 }, { t: r4(tb), scale: 0.12, emissive: 4 }, { t: r4(tb + 0.6), scale: 1, emissive: 2.6 },
        { t: r4(tb + 1.9), scale: 1.25, emissive: 0 }, { t: r4(tb + 1.95), scale: 0.001, emissive: 0 });
      rocket.push({ t: r4(Math.max(0, tb - 1.45)), scale: 0.001, position: [x, 1, z] }, { t: r4(Math.max(0.01, tb - 1.4)), scale: 1, position: [x, 1, z] },
        { t: r4(tb), scale: 1, position: [x, y, z] }, { t: r4(tb + 0.03), scale: 0.001, position: [x, y, z] });
    }
    o.push({ name: 'Firework', shape: { type: 'radial', count: 14, shape: { type: 'radial', axis: 'z', count: 7, angle: 150, startAngle: -75, radius: 3.2, rotation: [0, 0, 90],
      shape: { type: 'cylinder', radiusTop: 0.07, radiusBottom: 0.02, height: 2, segments: 4, caps: false } } }, position: [x, y, z], scale: 0.001,
      material: { color, emissive: 0 }, animation: { keys: burst, ease: 'linear' } });
    o.push({ name: 'Rocket', shape: { type: 'cylinder', radiusTop: 0.04, radiusBottom: 0.12, height: 1.4, segments: 6 }, position: [x, 1, z], scale: 0.001,
      material: { color: '#fff1c4', emissive: 2.5 }, animation: { keys: rocket, ease: 'linear' } });
  }

  // ---- balloons: a vendor's bunch bobs, a few escaped ones drift up into the sky
  const balloonColors = ['#ff4f6d', '#ffd23f', '#3ec1d3', '#a66cff', '#7bdc6f', '#ff9f43', '#ff6fb0'];
  const V = [4, 0, 19];
  o.push({ name: 'Balloon cart', shape: { type: 'roundedBox', width: 1.6, height: 1, depth: 1, radius: 0.1 }, position: [V[0], 0.5, V[2]], material: { color: '#f2efe8', roughness: 0.5 } });
  for (let i = 0; i < 7; i++) {
    const a = i * 51.4, x = V[0] + Math.cos(a * D) * 0.7, z = V[2] + Math.sin(a * D) * 0.7, y = 3.6 + (i % 3) * 0.45;
    const anim = { bob: { amplitude: 0.12, period: 2.4 + i * 0.2, phase: r4(i / 7) } };
    o.push({ name: 'Balloon', shape: { type: 'sphere', radius: 0.42, segments: 16, rings: 12 }, position: P(x, y, z), scale: [1, 1.18, 1], material: { color: balloonColors[i], roughness: 0.15, specular: 1.2, shininess: 120 }, animation: anim });
    o.push(beam('Balloon string', [V[0], 1, V[2]], [x, y - 0.5, z], 0.01, { color: '#ddd' }, { animation: anim }));
  }
  for (let i = 0; i < 5; i++) {
    o.push({ name: 'Escaped balloon', shape: { type: 'sphere', radius: 0.42, segments: 16, rings: 12 }, position: P(V[0] + 0.5, 3.5, V[2] - 0.3), scale: [1, 1.18, 1],
      material: { color: balloonColors[(i * 2) % 7], roughness: 0.15, specular: 1.2, shininess: 120 },
      animation: { flow: { axis: [0.25 - i * 0.12, 1, -0.3], distance: 32, speed: 32 / LOOP * 2, phase: r4(i / 5), fade: 0.12 } } });
  }

  // ---- food stalls with striped awnings and glowing signs
  const stalls = [[-8, 16, 0], [-14, 16, 0], [16, 17, 0], [22, 17, 0], [-26, 6, 90]];
  stalls.forEach(([x, z, ry], i) => {
    const col = ['#e8483f', '#2bb3a6', '#f2c230', '#7b5cd6', '#ff8a3d'][i];
    o.push({ name: 'Stall', shape: { type: 'roundedBox', width: 4.2, height: 2.2, depth: 2.6, radius: 0.08 }, position: [x, 1.1, z], rotation: [0, ry, 0], material: { color: '#efe7da', roughness: 0.6 } });
    o.push({ name: 'Awning', shape: { type: 'extrude', shape: [[-2.4, 0], [2.4, 0], [2.4, 0.15], [0, 1.1], [-2.4, 0.15]], depth: 3.2 }, position: [x, 2.25, z], rotation: [0, ry, 0], material: { color: col, roughness: 0.5 } });
    o.push({ name: 'Stall sign', shape: { type: 'roundedBox', width: 2.4, height: 0.5, depth: 0.12, radius: 0.04 }, position: ry ? [x + 1.36, 1.8, z] : [x, 1.8, z + 1.36], rotation: [0, ry, 0], material: glow(['#ffe08a', '#9ff3ff', '#ffb3d9', '#c9ffb3', '#ffd0a0'][i], 1.6), animation: { pulse: { min: 0.8, max: 1.15, period: 3, phase: i * 0.2 } } });
  });

  // ---- entrance arch with chasing bulbs, lamp posts, trees
  o.push({ name: 'Entrance arch', shape: { type: 'torus', radius: 6.5, tube: 0.35, segments: 64, sides: 10 }, position: [0, 1.2, 26], rotation: [90, 0, 0], material: { color: '#f2efe8', roughness: 0.4 } });
  for (const x of [-6.5, 6.5]) o.push({ name: 'Arch pillar', shape: { type: 'cylinder', radiusTop: 0.6, radiusBottom: 0.7, height: 1.4, segments: 16 }, position: [x, 0.7, 26], material: { color: '#7a2f3a', roughness: 0.5 } });
  for (const [k, color] of [[0, '#ffe7b0'], [1, '#ff7ac8']]) {
    o.push({ name: 'Arch lights', shape: { type: 'radial', axis: 'z', count: 30, angle: 174, startAngle: 3 + k * 3, radius: 6.5, offset: [0, 0, 0.42], shape: { type: 'sphere', radius: 0.13, segments: 8, rings: 5 } },
      position: [0, 1.2, 26], material: glow(color, 2.5), animation: { pulse: { min: 0.2, max: 1.2, period: 0.8, phase: k * 0.5, blink: true } } });
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2, x = r4(Math.cos(a) * 34), z = r4(Math.sin(a) * 26 - 2);
    if (z < -20) continue;
    o.push({ name: 'Lamp post', shape: { type: 'cylinder', radiusTop: 0.07, radiusBottom: 0.1, height: 4.2, segments: 8 }, position: [x, 2.1, z], material: { color: '#2b2d33', metalness: 0.8, roughness: 0.4 } });
    o.push({ name: 'Lamp', shape: { type: 'sphere', radius: 0.35, segments: 12, rings: 8 }, position: [x, 4.35, z], material: glow('#ffd9a0', 2.4) });
  }
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2, rr = 40 + rand() * 12, x = r4(Math.cos(a) * rr), z = r4(Math.sin(a) * rr * 0.85), h = r4(4 + rand() * 4);
    o.push({ name: 'Tree', shape: { type: 'cone', radius: r4(1.4 + rand()), height: h, segments: 8 }, position: [x, r4(h / 2 + 1), z], material: { color: '#1f3b2a', flat: true, specular: 0 } });
    o.push({ name: 'Trunk', shape: { type: 'cylinder', radiusTop: 0.15, radiusBottom: 0.2, height: 1.2, segments: 6 }, position: [x, 0.6, z], material: { color: '#3d2a1e' } });
  }

  // distant hills close the horizon
  for (let k = 0; k < 3; k++) {
    o.push({ name: 'Hills', shape: { type: 'radial', count: 16, radius: 150 + k * 12, startAngle: k * 7.5, shape: { type: 'cone', radius: 26 - k * 4, height: 9 + k * 5, segments: 10 } },
      position: [0, 2 + k * 2.5, 0], material: { color: ['#251d33', '#1d1830', '#16142a'][k], roughness: 0.9, specular: 0, flat: true } });
  }

  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 18, pitch: 17, distance: 66, target: [1, 9, -6] });
  // establishing shot, past the carousel and the wave swinger, along the Ferris wheel and the coaster, back
  await cameraPath(doc, LOOP, [{ t: 6, yaw: 44, pitch: 11, distance: 38, target: [13, 5, 0] }, { t: 12, yaw: 4, pitch: 9, distance: 40, target: [-8, 10, -12] },
    { t: 18, yaw: -28, pitch: 21, distance: 56, target: [0, 10, -10] }]);
});

scene('plush', 'Plush dancer', 'A fluffy plush character with headphones dancing on a light-up floor: fur from surface noise, a baked skeleton (root bounce, sway and twist, arm and leg swings) turned into keyframes for every part, a disco ball and pumping speakers.', async (doc) => {
  const D = Math.PI / 180, LOOP = 8, BEAT = 0.5;
  await tool(doc, 'set_environment', {
    background: { top: '#140f26', bottom: '#3b2a57' }, fog: null, ground: false, reflections: 'studio',
    light: { direction: [0.45, 0.85, 0.65], color: '#fff1e2', intensity: 1.1, softness: 0.35 },
    lights: [{ direction: [-0.8, 0.35, -0.5], color: '#ff5fc8', intensity: 0.55 }, { direction: [0.85, 0.3, -0.45], color: '#4fd8ff', intensity: 0.5 }, { direction: [0, 0.3, 1], color: '#ffffff', intensity: 0.25 }],
  });
  const fur = { color: '#e2c1b2', roughness: 0.95, specular: 0.08 };
  const furNoise = { amplitude: 0.013, scale: 48, octaves: 4, seed: 5 };
  // capsule-like lathe profile from y0 (bottom) to y1, radius r(t) with a little taper
  const bean = (y0, y1, r0, r1, n = 40, pow = 0.7) => Array.from({ length: n + 1 }, (_, i) => {
    const t = (i / n) * Math.PI, y = y0 + ((y1 - y0) * (1 - Math.cos(t))) / 2, k = (y - y0) / (y1 - y0);
    return P(i === 0 || i === n ? 0 : (r0 + (r1 - r0) * k) * Math.sin(t) ** pow, y);
  });

  // the face is an ellipsoid; features sit on its surface
  const FACE = { c: [0, 1.02, 0.335], r: [0.26, 0.2, 0.07] };
  const onFace = (x, y, lift = 0) => P(x, y, FACE.c[2] + FACE.r[2] * Math.sqrt(Math.max(0, 1 - (x / FACE.r[0]) ** 2 - ((y - FACE.c[1]) / FACE.r[1]) ** 2)) + lift);
  // ---- parts in the character's rest pose (feet at the origin, facing +Z); `joint` = what moves them
  const parts = [
    { name: 'Body', joint: 'root', shape: { type: 'lathe', segments: 160, profile: bean(0.1, 1.36, 0.43, 0.36, 72), noise: furNoise }, material: fur },
    { name: 'Face', joint: 'root', shape: { type: 'sphere', radius: 1, segments: 48, rings: 24 }, position: FACE.c, scale: FACE.r, material: { color: '#f7e0d4', roughness: 0.45, specular: 0.3 } },
    { name: 'Eye', joint: 'root', shape: { type: 'sphere', radius: 0.026, segments: 16, rings: 10 }, position: onFace(-0.075, 1.05, -0.006), material: { color: '#161214', roughness: 0.08, specular: 1.4, shininess: 220 } },
    { name: 'Eye', joint: 'root', shape: { type: 'sphere', radius: 0.026, segments: 16, rings: 10 }, position: onFace(0.075, 1.05, -0.006), material: { color: '#161214', roughness: 0.08, specular: 1.4, shininess: 220 } },
    { name: 'Blush', joint: 'root', shape: { type: 'sphere', radius: 0.042, segments: 16, rings: 10 }, position: onFace(-0.14, 0.99, -0.008), scale: [1, 0.55, 0.3], material: { color: '#f3a2a6', roughness: 0.8 } },
    { name: 'Blush', joint: 'root', shape: { type: 'sphere', radius: 0.042, segments: 16, rings: 10 }, position: onFace(0.14, 0.99, -0.008), scale: [1, 0.55, 0.3], material: { color: '#f3a2a6', roughness: 0.8 } },
    { name: 'Smile', joint: 'root', shape: { type: 'tube', radius: 0.0055, sides: 6, path: Array.from({ length: 9 }, (_, i) => { const x = -0.03 + (i / 8) * 0.06; return onFace(x, 0.982 + 0.013 * (x / 0.03) ** 2, 0.001); }) }, material: { color: '#3a2420', roughness: 0.6 } },
    { name: 'Headphone band', joint: 'root', shape: { type: 'tube', radius: 0.026, sides: 10, path: Array.from({ length: 25 }, (_, i) => { const a = (12 + (i / 24) * 156) * D; return P(0.405 * Math.cos(a), 1.03 + 0.37 * Math.sin(a), -0.02); }) }, material: { color: '#1d1d22', roughness: 0.35, specular: 0.6 } },
  ];
  // a round, fluffy bottom: two cheeks bulging out of the back, and a little tail
  for (const sx of [-1, 1]) {
    parts.push({ name: 'Bottom', joint: 'root', shape: { type: 'sphere', radius: 0.19, segments: 48, rings: 32, noise: { ...furNoise, seed: sx > 0 ? 11 : 12 } }, position: [sx * 0.11, 0.3, -0.2], scale: [1, 0.95, 0.85], material: fur });
  }
  parts.push({ name: 'Tail', joint: 'root', shape: { type: 'sphere', radius: 0.065, segments: 32, rings: 20, noise: { ...furNoise, amplitude: 0.016, seed: 13 } }, position: [0, 0.5, -0.36], material: fur });
  for (const sx of [-1, 1]) {
    parts.push({ name: 'Ear cup', joint: 'root', shape: { type: 'cylinder', radiusTop: 0.105, radiusBottom: 0.105, height: 0.09, segments: 32 }, position: [sx * 0.405, 1.04, -0.02], rotation: [0, 0, 90], material: { color: '#26262c', roughness: 0.3, specular: 0.7 } });
    parts.push({ name: 'Ear cup light', joint: 'root', shape: { type: 'torus', radius: 0.075, tube: 0.012, segments: 32, sides: 6 }, position: [sx * 0.452, 1.04, -0.02], rotation: [0, 0, 90], material: { color: '#59e6ff', emissive: 2.2 },
      animation: { pulse: { min: 0.3, max: 1.4, period: BEAT } } });
    parts.push({ name: 'Arm', joint: sx > 0 ? 'armR' : 'armL', shape: { type: 'lathe', segments: 64, profile: bean(-0.6, 0.04, 0.1, 0.09, 36, 0.6), noise: { ...furNoise, seed: sx > 0 ? 7 : 8 } }, material: fur });
    parts.push({ name: 'Leg', joint: sx > 0 ? 'legR' : 'legL', shape: { type: 'lathe', segments: 56, profile: bean(-0.26, 0.06, 0.13, 0.11, 24, 0.55), noise: { ...furNoise, seed: sx > 0 ? 9 : 10 } }, material: fur });
  }
  const joints = { armR: [0.31, 0.9, 0.02], armL: [-0.31, 0.9, 0.02], legR: [0.15, 0.24, 0], legL: [-0.15, 0.24, 0] };

  // ---- the dance: root bounce / sway / twist, arm and leg swings; phrase B (4..8 s) puts the hands up
  const ss = (x) => { const k = Math.max(0, Math.min(1, x)); return k * k * (3 - 2 * k); };
  const pose = (t) => {
    const b = t / BEAT, wB = ss((t - 3.5) / 0.5) - ss((t - 7.5) / 0.5);
    const bounce = (0.045 + 0.06 * wB) * (1 - Math.cos(2 * Math.PI * b)) / 2;
    const root = { pos: [0, 0.04 + bounce, 0], rot: [3 * Math.sin(2 * Math.PI * b) - 4 * wB, 12 * Math.sin((Math.PI * b) / 2), 7 * Math.sin(Math.PI * b) * (1 - 0.4 * wB)] };
    const wave = Math.max(0, Math.sin(Math.PI * b));
    const armA = { R: [18 * Math.sin(Math.PI * b), 0, 22 + 115 * wave], L: [-18 * Math.sin(Math.PI * b), 0, -(20 + 30 * (1 - wave))] };
    const armB = { R: [6 * Math.sin(2 * Math.PI * b), 0, 150 + 14 * Math.sin(2 * Math.PI * b)], L: [-6 * Math.sin(2 * Math.PI * b), 0, -(150 + 14 * Math.sin(2 * Math.PI * b + Math.PI))] };
    const mix = (a, c) => a.map((v, i) => v + (c[i] - v) * wB);
    const step = (side) => Math.max(0, Math.sin(Math.PI * b + (side > 0 ? 0 : Math.PI)));
    return {
      root, armR: mix(armA.R, armB.R), armL: mix(armA.L, armB.L),
      legR: { lift: 0.05 * step(1), rot: [-14 * step(1), 0, 4] }, legL: { lift: 0.05 * step(-1), rot: [-14 * step(-1), 0, -4] },
    };
  };
  const M = (pos, rotDeg, scale = [1, 1, 1]) => mat4.compose(mat4.create(), pos, rotDeg.map((v) => v * D), scale);
  // Euler (applied X, Y, Z) of a rotation matrix; of the two solutions take the one closest to the previous key
  const euler = (m, prev) => {
    const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
    const ry = Math.asin(Math.max(-1, Math.min(1, -m[2] / sx))), rx = Math.atan2(m[6] / sy, m[10] / sz), rz = Math.atan2(m[1] / sx, m[0] / sx);
    const sols = [[rx, ry, rz], [rx + Math.PI, Math.PI - ry, rz + Math.PI]].map((s) => s.map((v) => v / D));
    if (!prev) return sols[0];
    const near = (s) => s.map((v, i) => { while (v - prev[i] > 180) v -= 360; while (v - prev[i] < -180) v += 360; return v; });
    const cand = sols.map(near), cost = (s) => s.reduce((a, v, i) => a + Math.abs(v - prev[i]), 0);
    return cost(cand[0]) <= cost(cand[1]) ? cand[0] : cand[1];
  };
  const keysFor = parts.map(() => []);
  for (let k = 0; k <= LOOP * 10; k++) {
    const t = k / 10, p = pose(t), R = M(p.root.pos, p.root.rot);
    parts.forEach((part, i) => {
      let J = R;
      if (part.joint.startsWith('arm')) J = mat4.multiply(mat4.create(), R, M(joints[part.joint], p[part.joint]));
      if (part.joint.startsWith('leg')) { const l = p[part.joint]; J = mat4.multiply(mat4.create(), R, M([joints[part.joint][0], joints[part.joint][1] + l.lift, 0], l.rot)); }
      const W = mat4.multiply(mat4.create(), J, M(part.position || [0, 0, 0], part.rotation || [0, 0, 0], part.scale || [1, 1, 1]));
      const prev = keysFor[i].at(-1)?.rotation;
      keysFor[i].push({ t: r4(t), position: P(W[12], W[13], W[14]), rotation: P(...euler(W, prev)) });
    });
  }
  // the whole dancer also turns slowly once per loop, so every side shows
  const turn = { orbit: { center: [0, 0, 0], axis: [0, 1, 0], speed: 360 / LOOP } };
  await add(doc, parts.map((part, i) => ({ name: part.name, shape: part.shape, material: part.material, scale: part.scale || 1,
    position: keysFor[i][0].position, rotation: keysFor[i][0].rotation, animation: { ...part.animation, ...turn, keys: keysFor[i], ease: 'spline' } })));

  // ---- the stage: light-up dance floor, disco ball, speakers, neon backdrop, a plant
  const tileColors = ['#ff4fb8', '#4fd8ff', '#a66cff', '#ffd23f'];
  const o = [{ name: 'Floor', shape: { type: 'plane', width: 30, depth: 30 }, material: { color: '#120e1c', roughness: 0.28, specular: 0.6 } }];
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      // glossy coloured glass (metal: no diffuse light, so a dark tile stays dark) that lights up on the beat
      o.push({ name: 'Dance tile', shape: { type: 'roundedBox', width: 0.96, height: 0.04, depth: 0.96, radius: 0.015 }, position: [i, 0.02, j], material: { color: tileColors[(i + j + 8) % 4], emissive: 0.85, metalness: 1, roughness: 0.16 },
        animation: { pulse: { min: 0.04, max: 1, period: 2 * BEAT, phase: r4((((i * 3 + j * 5) % 4) + 4) % 4 / 4), blink: true } } });
    }
  }
  o.push({ name: 'Disco ball', shape: { type: 'sphere', radius: 0.32, segments: 18, rings: 12 }, position: [0, 2.75, -0.6], material: { color: '#e8ecf2', metalness: 1, roughness: 0.04, flat: true }, animation: { spin: { axis: [0, 1, 0], speed: 45 } } });
  o.push({ name: 'Disco cord', shape: { type: 'cylinder', radiusTop: 0.008, radiusBottom: 0.008, height: 1.5, segments: 4 }, position: [0, 3.8, -0.6], material: { color: '#888' } });
  for (const sx of [-1, 1]) {
    const x = sx * 2.25;
    o.push({ name: 'Speaker', shape: { type: 'roundedBox', width: 0.75, height: 1.25, depth: 0.6, radius: 0.04 }, position: [x, 0.625, -1.1], rotation: [0, -sx * 18, 0], material: { color: '#1a1a20', roughness: 0.6 } });
    for (const [y, r] of [[0.45, 0.24], [0.95, 0.09]]) {
      const pos = [x + Math.sin(-sx * 18 * D) * 0.31, y, -1.1 + Math.cos(-sx * 18 * D) * 0.31];
      o.push({ name: r > 0.1 ? 'Woofer' : 'Tweeter', shape: { type: 'lathe', segments: 32, profile: [[0, -0.06], [r * 0.25, -0.05], [r * 0.85, 0], [r, 0.01], [r, -0.01], [0, -0.02]] }, position: P(...pos), rotation: [90, -sx * 18, 0],
        material: { color: '#2b2b33', roughness: 0.5, specular: 0.5 }, animation: r > 0.1 ? { bob: { axis: [Math.sin(-sx * 18 * D), 0, Math.cos(-sx * 18 * D)], amplitude: 0.012, period: BEAT } } : undefined });
    }
    o.push({ name: 'Speaker light', shape: { type: 'roundedBox', width: 0.6, height: 0.03, depth: 0.03, radius: 0.01 }, position: P(x + Math.sin(-sx * 18 * D) * 0.31, 0.1, -1.1 + Math.cos(-sx * 18 * D) * 0.31), rotation: [0, -sx * 18, 0],
      material: { color: sx > 0 ? '#4fd8ff' : '#ff4fb8', emissive: 2 }, animation: { pulse: { min: 0.3, max: 1.3, period: BEAT, phase: 0.25 } } });
  }
  o.push({ name: 'Backdrop', shape: { type: 'lathe', segments: 48, phiStart: 200, phiLength: 140, profile: [[5.2, 0], [5.2, 4.2]] }, position: [0, 0, 1.2], material: { color: '#241a38', roughness: 0.8, doubleSided: true } });
  for (const [y, color] of [[2.2, '#ff4fb8'], [2.5, '#4fd8ff']]) {
    o.push({ name: 'Neon', shape: { type: 'tube', radius: 0.022, sides: 8, path: Array.from({ length: 41 }, (_, i) => { const a = (205 + (i / 40) * 130) * D; return P(5.1 * Math.sin(a), y, 1.2 + 5.1 * Math.cos(a)); }) },
      material: { color, emissive: 2.4 }, animation: { pulse: { min: 0.7, max: 1.2, period: 4 * BEAT, phase: y > 2.3 ? 0.5 : 0 } } });
  }
  // potted plant
  o.push({ name: 'Pot', shape: { type: 'lathe', segments: 32, profile: [[0, 0], [0.2, 0], [0.26, 0.42], [0.24, 0.44], [0, 0.4]] }, position: [-2.6, 0, 0.6], material: { color: '#d8cfc2', roughness: 0.7 } });
  const leaf = [[0, 0], [0.06, 0.12], [0.07, 0.35], [0.03, 0.6], [0, 0.68], [-0.03, 0.6], [-0.07, 0.35], [-0.06, 0.12]];
  for (const [k, tilt, h] of [[0, 30, 0.95], [1, 45, 0.8], [2, 20, 1.1]]) {
    o.push({ name: 'Leaves', shape: { type: 'radial', count: 7, startAngle: k * 17, shape: { type: 'extrude', shape: leaf, depth: 0.01 }, rotation: [0, 90, -tilt] }, position: [-2.6, 0.4, 0.6], scale: [1, h, 1],
      material: { color: ['#3f8a3c', '#4f9a45', '#367a35'][k], roughness: 0.55, doubleSided: true }, animation: { swing: { axis: [0, 0, 1], amplitude: 2, period: 4 * BEAT, phase: k / 3, pivot: [-2.6, 0.4, 0.6] } } });
  }
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 16, pitch: 8, distance: 3.1, target: [0, 0.82, 0] });
  await cameraPath(doc, LOOP, [{ t: 4, yaw: -14, pitch: 12, distance: 2.7, target: [0, 0.9, 0] }]);
});

scene('castle', 'Castle', 'Curtain walls with 48 merlons, four towers, a keep, gatehouse, moat ring, bridge and a forest. About 190 objects.', async (doc) => {
  const rand = rng(11);
  // round-arched gate: rectangle with a half circle on top (counter-clockwise)
  const gateShape = [[-0.75, 0], [0.75, 0], ...Array.from({ length: 13 }, (_, i) => P(Math.cos((i / 12) * Math.PI) * 0.75, 1.5 + Math.sin((i / 12) * Math.PI) * 0.75))];
  const stone = '#a19b90', dark = '#857f75', roof = '#8c2f24', wood = '#4f3420';
  await tool(doc, 'set_environment', { background: { top: '#5f8fd0', bottom: '#e8e2d6' }, fog: { near: 45, far: 140 }, ground: false,
    light: { direction: [0.6, 0.6, 0.45], color: '#ffe0b5', intensity: 1.15, softness: 0.25 },
    lights: [{ direction: [-0.5, 0.6, -0.6], color: '#9fc4ff', intensity: 0.3 }] }); // warm sun, cool sky fill
  const o = [
    { name: 'Meadow', shape: { type: 'plane', width: 90, depth: 90 }, material: { color: '#5a8a42', specular: 0 } },
    { name: 'Moat', shape: { type: 'lathe', profile: [[12.5, 0.03], [9, 0.03]], segments: 72 }, material: { color: '#2f6290', roughness: 0.06, specular: 1, shininess: 160 } },
    { name: 'Bridge', shape: { type: 'box', width: 2.4, height: 0.25, depth: 4 }, position: [0, 0.2, 10.7], material: { color: wood } },
    { name: 'Road', shape: { type: 'box', width: 2.4, height: 0.04, depth: 30 }, position: [0, 0.02, 27.7], material: { color: '#a48f6c', specular: 0 } },
  ];
  for (const s of [-1, 1]) {
    o.push({ name: `Wall ${s > 0 ? 'south' : 'north'}`, shape: { type: 'box', width: 10, height: 3, depth: 0.8 }, position: [0, 1.5, 5 * s], material: { color: stone } });
    o.push({ name: `Wall ${s > 0 ? 'east' : 'west'}`, shape: { type: 'box', width: 0.8, height: 3, depth: 10 }, position: [5 * s, 1.5, 0], material: { color: stone } });
  }
  for (let k = 0; k < 12; k++) {
    const t = r4(-4.4 + k * 0.8);
    for (const s of [-1, 1]) {
      o.push({ name: 'Merlon', shape: { type: 'box', width: 0.45, height: 0.5, depth: 0.8 }, position: [t, 3.25, 5 * s], material: { color: stone } });
      o.push({ name: 'Merlon', shape: { type: 'box', width: 0.8, height: 0.5, depth: 0.45 }, position: [5 * s, 3.25, t], material: { color: stone } });
    }
  }
  for (const [x, z] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) {
    o.push(
      { name: 'Tower', shape: { type: 'cylinder', radiusTop: 1.25, radiusBottom: 1.4, height: 5.5, segments: 28 }, position: [x, 2.75, z], material: { color: dark } },
      { name: 'Tower gallery', shape: { type: 'cylinder', radiusTop: 1.55, radiusBottom: 1.3, height: 0.6, segments: 28 }, position: [x, 5.8, z], material: { color: stone } },
      { name: 'Tower roof', shape: { type: 'cone', radius: 1.7, height: 2.6, segments: 28 }, position: [x, 7.4, z], material: { color: roof, roughness: 0.4, specular: 0.5, shininess: 60 } },
      { name: 'Flagpole', shape: { type: 'cylinder', radiusTop: 0.03, radiusBottom: 0.04, height: 1.3, segments: 8 }, position: [x, 9.3, z], material: { color: '#333' } },
      { name: 'Flag', shape: { type: 'extrude', shape: [[0, 0], [0.8, 0.22], [0, 0.45]], depth: 0.03 }, position: [x + 0.03, 9.45, z], rotation: [0, -30, 0], material: { color: '#e8c547', roughness: 0.6, doubleSided: true } },
    );
  }
  o.push(
    { name: 'Keep', shape: { type: 'box', width: 4, height: 6.5, depth: 4 }, position: [0, 3.25, -1.2], material: { color: dark } },
    { name: 'Keep roof', shape: { type: 'cone', radius: 3.1, height: 2.6, segments: 4 }, position: [0, 7.8, -1.2], rotation: [0, 45, 0], material: { color: roof, roughness: 0.4, specular: 0.5, shininess: 60, flat: true } },
    { name: 'Keep turret', shape: { type: 'lathe', profile: [[0, 0], [0.75, 0], [0.7, 7.5], [0.9, 7.6], [0.9, 8.1], [0, 8.1]], segments: 24 }, position: [1.9, 0, 0.6], material: { color: stone } },
    { name: 'Turret roof', shape: { type: 'cone', radius: 1, height: 1.8, segments: 24 }, position: [1.9, 9, 0.6], material: { color: roof, roughness: 0.4, specular: 0.5, shininess: 60 } },
    { name: 'Gatehouse', shape: { type: 'box', width: 3.4, height: 4.2, depth: 1.8 }, position: [0, 2.1, 5], material: { color: dark } },
    { name: 'Gate', shape: { type: 'extrude', shape: gateShape, depth: 0.1 }, position: [0, 0, 5.92], material: { color: '#3b2716' } },
  );
  for (let k = 0; k < 4; k++) o.push({ name: 'Gate merlon', shape: { type: 'box', width: 0.45, height: 0.5, depth: 1.8 }, position: [r4(-1.3 + k * 0.866), 4.45, 5], material: { color: dark } });
  for (let i = 0; i < 36; i++) {
    const a = rand() * Math.PI * 2, d = 15 + rand() * 22, x = r4(Math.cos(a) * d), z = r4(Math.sin(a) * d);
    if (Math.abs(x) < 3 && z > 0) continue;
    const s = r4(0.8 + rand() * 0.7), green = ['#2f6b34', '#3d7d3a', '#285c2e'][i % 3];
    o.push({ name: 'Trunk', shape: { type: 'cylinder', radiusTop: 0.12, radiusBottom: 0.18, height: 1.2, segments: 8 }, position: [x, 0.6 * s, z], scale: s, material: { color: '#5b3a22' } });
    o.push({ name: 'Tree', shape: { type: 'cone', radius: 1, height: 2.8, segments: 9 }, position: [x, r4(2.4 * s), z], scale: s, material: { color: green, flat: true, specular: 0 } });
  }
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 32, pitch: 22, distance: 29, target: [0, 2.8, 0] });
  await animate(doc, 'Flag', (o, i) => ({ swing: { axis: [0, 1, 0], amplitude: 14, period: 1.5, phase: i * 0.27 } }));
  await timeline(doc, 12);
});

scene('chess', 'Chess set', 'Italian opening on a wooden board. Every piece is a lathe profile, the knights are extruded silhouettes.', async (doc) => {
  await tool(doc, 'set_environment', { background: { top: '#16120f', bottom: '#43352a' }, fog: null, ground: false, reflections: 'studio',
    light: { direction: [-0.5, 0.9, 0.6], color: '#fff0dc', intensity: 1.05, softness: 0.4 },
    lights: [{ direction: [0.35, 0.45, -0.9], color: '#cfe0ff', intensity: 0.55 }] }); // cool rim from behind
  const base = (rb) => [[0, 0], [rb, 0], [rb, 0.06], P(rb * 0.92, 0.1), P(rb * 0.8, 0.13)];
  const profiles = {
    pawn: [...base(0.33), [0.2, 0.18], [0.12, 0.4], [0.2, 0.43], [0.2, 0.46], [0.1, 0.49], ...arc(0, 0.6, 0.14, -55, 90, 12)],
    rook: [...base(0.36), [0.26, 0.2], [0.21, 0.7], [0.28, 0.74], [0.3, 0.95], [0.21, 0.95], [0.21, 0.87], [0, 0.87]],
    bishop: [...base(0.34), [0.22, 0.18], [0.12, 0.62], [0.2, 0.66], [0.2, 0.69], [0.1, 0.72], ...arc(0, 0.88, 0.15, -65, 80, 12, 1.25), ...arc(0, 1.1, 0.05, -60, 90, 6)],
    queen: [...base(0.37), [0.24, 0.2], [0.13, 0.82], [0.22, 0.87], [0.22, 0.91], [0.13, 0.94], [0.21, 1.13], [0.25, 1.17], [0.15, 1.14], [0.07, 1.16], ...arc(0, 1.22, 0.07, -50, 90, 8)],
    king: [...base(0.38), [0.25, 0.2], [0.14, 0.86], [0.23, 0.91], [0.23, 0.95], [0.14, 0.98], [0.22, 1.19], [0.13, 1.25], [0, 1.25]],
    knight: [...base(0.35), [0.26, 0.18], [0.24, 0.25], [0, 0.25]],
  };
  const horse = [[-0.2, 0], [0.2, 0], [0.16, 0.22], [0.08, 0.38], [0.3, 0.52], [0.36, 0.63], [0.3, 0.71], [0.1, 0.72], [0.03, 0.84], [-0.06, 0.78], [-0.18, 0.66], [-0.24, 0.45], [-0.25, 0.2]];
  const o = [];
  for (let f = 0; f < 8; f++) {
    for (let r = 0; r < 8; r++) {
      o.push({ name: `Square ${'abcdefgh'[f]}${r + 1}`, shape: { type: 'box', width: 1, height: 0.2, depth: 1 }, position: [f - 3.5, 0.1, 3.5 - r],
        material: { color: (f + r) % 2 ? '#e9dcc0' : '#6b4a2f', roughness: 0.32, specular: 0.5, shininess: 80 } });
    }
  }
  for (const [x, z, w, d] of [[0, 4.3, 8.9, 0.6], [0, -4.3, 8.9, 0.6], [4.3, 0, 0.6, 8], [-4.3, 0, 0.6, 8]]) {
    o.push({ name: 'Frame', shape: { type: 'box', width: w, height: 0.3, depth: d }, position: [x, 0.15, z], material: { color: '#3d2716', roughness: 0.25, specular: 0.6, shininess: 100 } });
  }
  o.push({ name: 'Table', shape: { type: 'cylinder', radiusTop: 9, radiusBottom: 9, height: 0.4, segments: 64 }, position: [0, -0.2, 0], material: { color: '#2a201a', roughness: 0.65, specular: 0.2 } });
  const back = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
  const pos = [];
  for (let f = 0; f < 8; f++) { pos.push(['w', back[f], f, 1], ['w', 'pawn', f, 2], ['b', 'pawn', f, 7], ['b', back[f], f, 8]); }
  const moves = [[4, 2, 4, 4], [4, 7, 4, 5], [6, 1, 5, 3], [1, 8, 2, 6], [5, 1, 2, 4]];
  for (const [f0, r0, f1, r1] of moves) { const p = pos.find((q) => q[2] === f0 && q[3] === r0); p[2] = f1; p[3] = r1; }
  for (const [side, kind, f, r] of pos) {
    const x = f - 3.5, z = 3.5 - (r - 1), mat = side === 'w' ? { color: '#efe6d2', roughness: 0.22, specular: 0.7, shininess: 120 } : { color: '#221d1b', roughness: 0.14, specular: 1, shininess: 160 };
    const label = `${side === 'w' ? 'White' : 'Black'} ${kind}`;
    o.push({ name: label, shape: { type: 'lathe', profile: profiles[kind], segments: 32 }, position: [x, 0.2, z], material: mat });
    if (kind === 'knight') o.push({ name: `${label} head`, shape: { type: 'extrude', shape: horse, depth: 0.26 }, position: [x, 0.43, z], rotation: [0, side === 'w' ? 90 : -90, 0], material: { ...mat, flat: true } });
    if (kind === 'king') {
      o.push({ name: `${label} cross`, shape: { type: 'box', width: 0.07, height: 0.26, depth: 0.07 }, position: [x, 1.57, z], material: mat });
      o.push({ name: `${label} cross bar`, shape: { type: 'box', width: 0.2, height: 0.07, depth: 0.07 }, position: [x, 1.6, z], material: mat });
    }
  }
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 20, pitch: 30, distance: 10.5, target: [0, 0.2, 0.4] });
  // slow turntable of board and pieces (the round table is symmetric)
  await animate(doc, (o) => o.name !== 'Table', { orbit: { center: [0, 0, 0], axis: [0, 1, 0], speed: 6 } });
  await timeline(doc, 60);
});

scene('station', 'Space station', 'A rotating-wheel station with spokes, solar wings, docking modules, an antenna dish, an approaching shuttle and a ringed planet.', async (doc) => {
  const rand = rng(5);
  await tool(doc, 'set_environment', { background: { top: '#020308', bottom: '#0e1832' }, fog: null, ground: false,
    light: { direction: [0.8, 0.35, 0.5], color: '#fff8ee', intensity: 1.2, softness: 0.05 },
    lights: [{ direction: [-0.6, -0.5, -0.6], color: '#4f86d8', intensity: 0.4 }] }); // blue light bouncing off the planet
  const hull = { color: '#d7d9de', roughness: 0.35, specular: 0.8, shininess: 60 }, metal = { color: '#9aa0aa', metalness: 1, roughness: 0.3, specular: 0.7 };
  const o = [
    { name: 'Hub', shape: { type: 'sphere', radius: 1.7, segments: 40, rings: 20 }, material: hull },
    { name: 'Spine', shape: { type: 'cylinder', radiusTop: 0.45, radiusBottom: 0.45, height: 16, segments: 20 }, material: metal },
    { name: 'Habitat ring', shape: { type: 'torus', radius: 9, tube: 0.9, segments: 128, sides: 20 }, material: hull },
    { name: 'Light strip', shape: { type: 'torus', radius: 9.95, tube: 0.12, segments: 128, sides: 6 }, material: { color: '#ffa04a', emissive: 1.6, specular: 1.5 } },
    { name: 'Inner ring', shape: { type: 'torus', radius: 4.2, tube: 0.35, segments: 64, sides: 12 }, position: [0, 0, 0], material: metal },
  ];
  for (let i = 0; i < 6; i++) {
    const a = i * 60, rad = (a * Math.PI) / 180, m = 4.95;
    o.push({ name: `Spoke ${i + 1}`, shape: { type: 'cylinder', radiusTop: 0.18, radiusBottom: 0.18, height: 6.6, segments: 12 }, position: P(Math.sin(rad) * m, 0, Math.cos(rad) * m), rotation: [90, a, 0], material: metal });
  }
  for (const s of [-1, 1]) {
    o.push(
      { name: 'Module', shape: { type: 'cylinder', radiusTop: 1, radiusBottom: 1, height: 3, segments: 24 }, position: [0, 9 * s, 0], material: hull },
      { name: 'Dock cone', shape: { type: 'cylinder', radiusTop: s > 0 ? 0.4 : 1, radiusBottom: s > 0 ? 1 : 0.4, height: 1, segments: 24 }, position: [0, 11 * s, 0], material: metal },
      { name: 'Truss', shape: { type: 'cylinder', radiusTop: 0.12, radiusBottom: 0.12, height: 36, segments: 8 }, position: [0, 6 * s, 0], rotation: [0, 0, 90], material: metal },
    );
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        o.push({ name: 'Solar panel', shape: { type: 'box', width: 2.7, height: 0.05, depth: 3.8 }, position: [r4(side * (11 + k * 2.9)), 6 * s, 0], material: { color: '#1c3a7a', roughness: 0.15, specular: 1.3, shininess: 120 } });
      }
    }
  }
  const dish = [];
  for (let i = 0; i <= 12; i++) { const r = (i / 12) * 1.8; dish.push(P(r, r * r * 0.22)); }
  o.push(
    { name: 'Antenna mast', shape: { type: 'cylinder', radiusTop: 0.06, radiusBottom: 0.08, height: 1.4, segments: 8 }, position: [0, 13.2, 0], material: metal },
    { name: 'Antenna dish', shape: { type: 'lathe', profile: dish, segments: 32 }, position: [0, 13.9, 0], rotation: [25, 0, 0], material: { color: '#eceef2', metalness: 1, roughness: 0.3, doubleSided: true, specular: 0.8 } },
    { name: 'Shuttle fuselage', shape: { type: 'lathe', profile: [[0, 0], [0.5, 0], [0.55, 2.4], [0.4, 3.1], [0.18, 3.5], [0, 3.6]], segments: 20 }, position: [16, 4, 9], rotation: [0, 35, -90], material: hull },
    { name: 'Shuttle wings', shape: { type: 'extrude', shape: [[1.4, 0], [-1, 1.6], [-1.3, 1.6], [-1.1, 0], [-1.3, -1.6], [-1, -1.6]], depth: 0.1 }, position: [17.1, 4, 8.2], rotation: [90, 0, 35], material: { color: '#cfd2d8', flat: true } },
    { name: 'Engine glow', shape: { type: 'cone', radius: 0.45, height: 1.2, segments: 16 }, position: [15.6, 4, 9.25], rotation: [0, 35, 90], material: { color: '#ff9b3d', emissive: 2.2, specular: 2 } },
    { name: 'Planet', shape: { type: 'sphere', radius: 40, segments: 64, rings: 32 }, position: [-60, -38, -95], material: { color: '#2f6db5', roughness: 0.55, specular: 0.4, shininess: 30 } },
    { name: 'Planet ring', shape: { type: 'torus', radius: 62, tube: 0.9, segments: 160, sides: 8 }, position: [-60, -38, -95], rotation: [14, 0, 9], material: { color: '#c8a46a' } },
  );
  const stars = [], idx = [];
  for (let i = 0; i < 400; i++) {
    const u = rand() * 2 - 1, t = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u), R = 260;
    const c = [Math.cos(t) * s * R, u * R, Math.sin(t) * s * R], k = 0.5 + rand() * 0.6, b = stars.length / 3;
    stars.push(...P(c[0], c[1] + k, c[2]), ...P(c[0] - k, c[1] - k, c[2]), ...P(c[0] + k, c[1] - k, c[2] + k));
    idx.push(b, b + 1, b + 2);
  }
  o.push({ name: 'Stars', shape: { type: 'mesh', positions: stars, indices: idx }, material: { color: '#ffffff', emissive: 1.4, doubleSided: true, specular: 0 } });
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 38, pitch: 24, distance: 40, target: [2, 0, 0] });
  await animate(doc, (o) => /^(Hub|Habitat ring|Light strip|Inner ring|Spoke)/.test(o.name), { orbit: { center: [0, 0, 0], axis: [0, 1, 0], speed: 8 } });
  await animate(doc, 'Light strip', { orbit: { center: [0, 0, 0], axis: [0, 1, 0], speed: 8 }, pulse: { min: 0.7, max: 1.2, period: 3 } });
  await animate(doc, ['Shuttle fuselage', 'Shuttle wings'], { bob: { axis: [0, 1, 0], amplitude: 0.35, period: 5 } });
  await animate(doc, 'Engine glow', { bob: { axis: [0, 1, 0], amplitude: 0.35, period: 5 }, pulse: { min: 0.7, max: 1.4, period: 0.5 } });
  await cameraPath(doc, 45, [{ t: 22.5, yaw: 100, pitch: 12, distance: 33 }]);
});

scene('city', 'City block', 'A procedural downtown: 36 blocks, towers with setbacks, round glass towers, rooftop details and a park with a pond.', async (doc) => {
  const rand = rng(42);
  await tool(doc, 'set_environment', { background: { top: '#4a6aa3', bottom: '#f1c99e' }, fog: { near: 55, far: 150 }, ground: false,
    light: { direction: [0.75, 0.36, 0.3], color: '#ffcf9e', intensity: 1.35, softness: 0.15 },
    lights: [{ direction: [-0.4, 0.7, -0.5], color: '#8fb0e0', intensity: 0.35 }] }); // golden hour: low warm sun, blue sky fill
  const palette = ['#c9c2b6', '#9fa7b0', '#d8d2c4', '#7f8b96', '#b6a48e', '#e3ddd0', '#8e9aa6', '#5d6a78'];
  const glass = ['#6f93b5', '#4f7898', '#86a9c4'];
  const o = [{ name: 'Asphalt', shape: { type: 'plane', width: 80, depth: 80 }, material: { color: '#3a3d42', specular: 0 } }];
  const N = 6, pitch = 11;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const cx = (i - (N - 1) / 2) * pitch, cz = (j - (N - 1) / 2) * pitch;
      const center = 1 - Math.hypot(cx, cz) / (pitch * N * 0.75);
      o.push({ name: 'Sidewalk', shape: { type: 'box', width: 8, height: 0.15, depth: 8 }, position: [cx, 0.075, cz], material: { color: '#a8a49c', specular: 0 } });
      if (i === 1 && j === 4) {
        o.push({ name: 'Park lawn', shape: { type: 'box', width: 7.4, height: 0.2, depth: 7.4 }, position: [cx, 0.1, cz], material: { color: '#5d8c45', specular: 0 } });
        o.push({ name: 'Pond', shape: { type: 'lathe', profile: [[1.7, 0.21], [0, 0.21]], segments: 40 }, position: [cx + 1, 0, cz + 0.8], material: { color: '#3b6f99', roughness: 0.06, specular: 1.2, shininess: 160 } });
        for (let t = 0; t < 9; t++) {
          const x = r4(cx - 3 + rand() * 6), z = r4(cz - 3 + rand() * 6);
          if (Math.hypot(x - cx - 1, z - cz - 0.8) < 2) continue;
          o.push({ name: 'Trunk', shape: { type: 'cylinder', radiusTop: 0.08, radiusBottom: 0.1, height: 0.8, segments: 8 }, position: [x, 0.6, z], material: { color: '#5b3a22' } });
          o.push({ name: 'Tree', shape: { type: 'sphere', radius: 0.65, segments: 12, rings: 8 }, position: [x, 1.4, z], material: { color: '#3f7a35', flat: true, specular: 0 } });
        }
        continue;
      }
      for (const [dx, dz] of [[-1.9, -1.9], [1.9, -1.9], [-1.9, 1.9], [1.9, 1.9]]) {
        if (rand() < 0.12) continue;
        const x = r4(cx + dx), z = r4(cz + dz);
        const h = r4(2 + rand() * 4 + Math.max(0, center) ** 2 * 26 * rand());
        const col = palette[Math.floor(rand() * palette.length)];
        if (h > 12 && rand() < 0.35) {
          const g = glass[Math.floor(rand() * glass.length)];
          o.push({ name: 'Glass tower', shape: { type: 'cylinder', radiusTop: 1.4, radiusBottom: 1.6, height: h, segments: 28 }, position: [x, h / 2 + 0.15, z], material: { color: g, roughness: 0.06, specular: 1.4, shininess: 200 } });
          o.push({ name: 'Crown', shape: { type: 'cylinder', radiusTop: 0.9, radiusBottom: 1.4, height: 1.2, segments: 28 }, position: [x, h + 0.75, z], material: { color: '#d9dde2' } });
          o.push({ name: 'Spire', shape: { type: 'cylinder', radiusTop: 0.02, radiusBottom: 0.08, height: 3, segments: 6 }, position: [x, h + 2.85, z], material: { color: '#d9dde2', metalness: 1, roughness: 0.3 } });
          o.push({ name: 'Warning light', shape: { type: 'sphere', radius: 0.14, segments: 12, rings: 8 }, position: [x, r4(h + 4.4), z], material: { color: '#ff2a1a', emissive: 2.5 } });
          continue;
        }
        const w = r4(2.6 + rand() * 0.8), d = r4(2.6 + rand() * 0.8);
        o.push({ name: 'Building', shape: { type: 'box', width: w, height: h, depth: d }, position: [x, h / 2 + 0.15, z], material: { color: col, specular: 0.15 } });
        if (h > 8) {
          const h2 = r4(h * (0.25 + rand() * 0.3));
          o.push({ name: 'Setback', shape: { type: 'box', width: r4(w * 0.7), height: h2, depth: r4(d * 0.7) }, position: [x, r4(h + h2 / 2 + 0.15), z], material: { color: col, specular: 0.15 } });
          if (rand() < 0.5) {
            o.push({ name: 'Antenna', shape: { type: 'cylinder', radiusTop: 0.03, radiusBottom: 0.06, height: 2.5, segments: 6 }, position: [x, r4(h + h2 + 1.4), z], material: { color: '#cfd3d8', metalness: 1, roughness: 0.3 } });
            o.push({ name: 'Warning light', shape: { type: 'sphere', radius: 0.11, segments: 12, rings: 8 }, position: [x, r4(h + h2 + 2.7), z], material: { color: '#ff2a1a', emissive: 2.5 } });
          }
        } else if (rand() < 0.6) {
          o.push({ name: 'Rooftop unit', shape: { type: 'box', width: 0.8, height: 0.4, depth: 0.6 }, position: [r4(x + 0.4), r4(h + 0.35), z], material: { color: '#8a8f96' } });
        }
      }
    }
  }
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 35, pitch: 27, distance: 82, target: [0, 8, 0] });
  await animate(doc, 'Warning light', (o, i) => ({ pulse: { min: 0.1, max: 1, period: 1.5, phase: (i % 3) / 3, blink: true } }));

  // a blimp on a keyframed spline loop: all parts share one origin (hull axis = local Y), so the same keys move them as one
  const hullProfile = [];
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * Math.PI, y = -Math.cos(a), len = y < 0 ? 3.6 : 3.1;
    hullProfile.push(P(1.25 * Math.sin(a) ** 0.9, y * len));
  }
  await add(doc, [
    { name: 'Blimp hull', scale: 1.6, shape: { type: 'lathe', profile: hullProfile, segments: 40 }, material: { color: '#e9ecef', roughness: 0.35, specular: 0.6 } },
    { name: 'Blimp band', scale: 1.6, shape: { type: 'lathe', profile: [[1.26, 0.2], [1.2, 1.0]], segments: 40 }, material: { color: '#40c4ff', emissive: 1.6, doubleSided: true } },
    { name: 'Blimp fins', scale: 1.6, shape: { type: 'radial', count: 4, radius: 0.95, offset: [0, -2.9, 0], startAngle: 45, shape: { type: 'roundedBox', width: 1.1, height: 1.2, depth: 0.08, radius: 0.03 } }, material: { color: '#3a4a5c', roughness: 0.4 } },
    { name: 'Blimp gondola', scale: 1.6, shape: { type: 'radial', count: 1, offset: [0, 0.4, 1.3], shape: { type: 'roundedBox', width: 0.5, height: 1.3, depth: 0.4, radius: 0.15, smooth: true } }, material: { color: '#2b3440', roughness: 0.3, specular: 0.6 } },
  ]);
  const loop = 24, keys = [];
  let heading = null;
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * 2 * Math.PI, pos = P(27 * Math.cos(a), 29 + 3 * Math.sin(2 * a), 21 * Math.sin(a));
    let h = (Math.atan2(-27 * Math.sin(a), 21 * Math.cos(a)) * 180) / Math.PI;
    if (heading !== null) while (h < heading - 180) h += 360;
    heading = h;
    keys.push({ t: (i / 8) * loop, position: pos, rotation: P(90, h, 0) });
  }
  await animate(doc, (o) => o.name.startsWith('Blimp'), { keys, ease: 'spline' });
  await cameraPath(doc, loop, [{ t: 12, yaw: 78, pitch: 21, distance: 72, target: [0, 11, 0] }]);
});

scene('garden', 'Alien garden', 'Tapered sweeps along procedural curves, glowing mushrooms, spiral shells and crystals, all placed on the terrain with probe_height.', async (doc) => {
  const rand = rng(3);
  await tool(doc, 'set_environment', { background: { top: '#040f17', bottom: '#174452' }, fog: { near: 16, far: 55 }, ground: false,
    light: { direction: [-0.4, 0.8, 0.5], color: '#cfefff', intensity: 0.75, softness: 0.45 },
    lights: [{ direction: [0.5, 0.3, -0.8], color: '#ff5fc8', intensity: 0.25 }, { direction: [-0.6, 0.2, 0.6], color: '#4fe3d0', intensity: 0.25 }] });
  await add(doc, [{ name: 'Ground', shape: { type: 'terrain', width: 56, resolution: 140, height: 3.2, scale: 0.07, seed: 3, waterLevel: 0.15, colorize: false }, material: { color: '#2e2546', roughness: 0.45, specular: 0.25, shininess: 30 } }]);
  const neon = ['#ff4fa3', '#58f2c6', '#ffd166', '#8c7bff', '#4fd1ff'];
  const spots = Array.from({ length: 70 }, () => { const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * 15; return P(Math.cos(a) * d, Math.sin(a) * d); });
  const ys = await probe(doc, spots);
  const o = [];
  spots.forEach(([x, z], i) => {
    const y = r4(ys[i] - 0.05), col = neon[i % neon.length];
    if (i < 30) {
      const h = 2 + rand() * 4, ph = rand() * 6, path = [];
      for (let k = 0; k <= 24; k++) { const t = k / 24; path.push(P(Math.sin(t * 3 + ph) * 0.7 * t, h * t, Math.cos(t * 2.4 + ph) * 0.7 * t)); }
      o.push({ name: 'Tentacle', shape: { type: 'sweep', shape: { type: 'circle', radius: r4(0.14 + rand() * 0.12), points: 10 }, path, scaleEnd: 0.08 }, position: [x, y, z], material: { color: col, emissive: 0.45, roughness: 0.3, specular: 1, shininess: 80 } });
    } else if (i < 42) {
      const s = r4(0.6 + rand() * 0.9);
      o.push({ name: 'Mushroom stem', shape: { type: 'cylinder', radiusTop: 0.12, radiusBottom: 0.18, height: 1.3, segments: 12 }, position: [x, r4(y + 0.65 * s), z], scale: s, material: { color: '#e8e0f0', emissive: 0.15, roughness: 0.5 } });
      o.push({ name: 'Mushroom cap', shape: { type: 'lathe', profile: [[0, 0], [0.85, 0.02], [0.8, 0.22], [0.5, 0.45], [0, 0.55]], segments: 28 }, position: [x, r4(y + 1.25 * s), z], scale: s, material: { color: col, emissive: 0.85, roughness: 0.25, specular: 1.2, shininess: 80 } });
    } else if (i < 50) {
      const path = [];
      for (let k = 0; k <= 80; k++) { const t = k / 80, a = t * Math.PI * 7, r = 0.9 * (1 - t) + 0.05; path.push(P(Math.cos(a) * r, t * 1.6, Math.sin(a) * r)); }
      o.push({ name: 'Spiral shell', shape: { type: 'sweep', shape: { type: 'circle', radius: 0.32, points: 12 }, path, scaleEnd: 0.1 }, position: [x, r4(y + 0.2), z], material: { color: '#f2d4b6', roughness: 0.15, specular: 1, shininess: 160 } });
    } else {
      o.push({ name: 'Crystal', shape: { type: 'cone', radius: r4(0.18 + rand() * 0.25), height: r4(1 + rand() * 2), segments: 5 }, position: [x, r4(y + 0.6), z], rotation: P(rand() * 40 - 20, rand() * 360, rand() * 40 - 20), material: { color: '#7fe8ff', emissive: 0.3, roughness: 0.04, specular: 1.6, shininess: 220, flat: true } });
    }
  });
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 15, pitch: 16, distance: 22, target: [0, 2.2, 0] });
  const r2 = rng(9);
  await animate(doc, 'Tentacle', () => ({ swing: { axis: [r2() - 0.5, 0, r2() - 0.5], amplitude: 6, period: 4, phase: r2() } }));
  await animate(doc, 'Mushroom cap', () => ({ pulse: { min: 0.55, max: 1.35, period: 3, phase: r2() } }));
  await animate(doc, 'Crystal', () => ({ pulse: { min: 0.4, max: 1.8, period: 2, phase: r2() } }));
  await timeline(doc, 12);
});

scene('lighthouse', 'Lighthouse island', 'A noise terrain island; the lighthouse and boat were placed on the surface and on the water with probe_height.', async (doc) => {
  await tool(doc, 'set_environment', { background: { top: '#35599a', bottom: '#f2d2ae' }, fog: { near: 30, far: 85 }, ground: false,
    light: { direction: [-0.7, 0.4, 0.45], color: '#ffd8a8', intensity: 1.2, softness: 0.25 },
    lights: [{ direction: [0.5, 0.6, -0.4], color: '#9cc0ff', intensity: 0.3 }] }); // evening sun, sky fill
  await add(doc, [
    { name: 'Island', shape: { type: 'terrain', width: 60, resolution: 160, height: 7, scale: 0.05, seed: 7, waterLevel: 0.42 }, position: [0, -0.2, 0] },
    { name: 'Sea', shape: { type: 'plane', width: 70, depth: 70 }, position: [0, -0.12, 0], material: { color: '#1d4c74', roughness: 0.07, specular: 1.2, shininess: 220 } },
  ]);
  const [hill] = await probe(doc, [[0, 0]]);
  const y = r4(hill);
  const rail = Array.from({ length: 17 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return P(Math.cos(a) * 1.15, 0, Math.sin(a) * 1.15); });
  await add(doc, [
    { name: 'Rock base', shape: { type: 'cylinder', radiusTop: 2.2, radiusBottom: 2.8, height: 1.2, segments: 9 }, position: [0, y, 0], material: { color: '#6e6a66', flat: true } },
    { name: 'Tower', shape: { type: 'lathe', profile: [[0, 0], [1.1, 0], [1.0, 1.5], [0.8, 5.2], [0, 5.2]], segments: 40 }, position: [0, r4(y + 0.6), 0], material: { color: '#f2f0ea', roughness: 0.5 } },
    { name: 'Red band', shape: { type: 'cylinder', radiusTop: 0.93, radiusBottom: 0.97, height: 1.0, segments: 40, caps: false }, position: [0, r4(y + 3.2), 0], material: { color: '#c7362f' } },
    { name: 'Gallery', shape: { type: 'cylinder', radiusTop: 1.25, radiusBottom: 1.25, height: 0.15, segments: 40 }, position: [0, r4(y + 5.85), 0], material: { color: '#2c2f36' } },
    { name: 'Railing', shape: { type: 'tube', path: rail, radius: 0.035, sides: 6, closed: true }, position: [0, r4(y + 6.35), 0], material: { color: '#2c2f36' } },
    { name: 'Lantern', shape: { type: 'cylinder', radiusTop: 0.6, radiusBottom: 0.6, height: 0.9, segments: 8 }, position: [0, r4(y + 6.4), 0], material: { color: '#ffd166', specular: 1.4, shininess: 80, flat: true, emissive: 1.8 } },
    { name: 'Roof', shape: { type: 'cone', radius: 0.8, height: 0.8, segments: 24 }, position: [0, r4(y + 7.25), 0], material: { color: '#c7362f', roughness: 0.35, specular: 0.6, shininess: 80 } },
    { name: 'Boat hull', shape: { type: 'extrude', shape: [[-1.1, 0.3], [-0.8, -0.2], [0.8, -0.2], [1.3, 0.35]], depth: 0.7 }, position: [-4, -0.05, 16], rotation: [0, 35, 0], material: { color: '#8a4b2a', flat: true } },
    { name: 'Mast', shape: { type: 'cylinder', radiusTop: 0.04, radiusBottom: 0.05, height: 1.8 }, position: [-4, 1.05, 16], material: { color: '#d8cbb0' } },
  ]);
  await tool(doc, 'set_camera', { yaw: 20, pitch: 14, distance: 27, target: [0, 4, 7] });
  await animate(doc, 'Lantern', { pulse: { min: 0.35, max: 1.6, period: 3 } });
  const rock = { swing: { axis: [1, 0, 0], amplitude: 4, period: 4, pivot: [-4, 0, 16] }, bob: { amplitude: 0.06, period: 4, phase: 0.25 } };
  await animate(doc, ['Boat hull', 'Mast'], rock);
  await timeline(doc, 12);
});

// ------------------------------------------------------------------------------------ build
// the phone's display texture is painted procedurally as well
const { paintHomeScreen } = await import('./screen-texture.mjs');
const { encodePNG } = await import('../server/png.js');
mkdirSync(join(DIR, 'textures'), { recursive: true });
const screenImg = paintHomeScreen(590);
writeFileSync(join(DIR, 'textures', 'screen.png'), encodePNG(screenImg.data, screenImg.width, screenImg.height));
mkdirSync(join(DIR, 'thumbs'), { recursive: true });
const manifest = [];
for (const s of SCENES) {
  const t0 = performance.now();
  const doc = new SceneDocument();
  await s.build(doc);
  const json = pretty(doc.data) + '\n';
  writeFileSync(join(DIR, `${s.id}.json`), json);
  await preloadTextures(doc);
  writeFileSync(join(DIR, 'thumbs', `${s.id}.png`), renderPNG(doc, { width: 640, height: 400 }));
  const geos = new Map(doc.data.objects.map((o) => [JSON.stringify(o.shape), doc.geometry(o.shape)]));
  let triangles = 0, ram = 0;
  for (const o of doc.data.objects) triangles += doc.geometry(o.shape).triangleCount;
  for (const g of geos.values()) ram += g.positions.byteLength + g.normals.byteLength + g.indices.byteLength + (g.colors?.byteLength ?? 0);
  const entry = {
    id: s.id, title: s.title, description: s.description, objects: doc.data.objects.length, triangles,
    jsonBytes: Buffer.byteLength(json), objBytes: exportOBJ(doc.data.objects, (sh) => doc.geometry(sh)).length, ramBytes: ram,
  };
  manifest.push(entry);
  console.log(`${s.id.padEnd(11)} ${String(entry.objects).padStart(4)} objects ${String(triangles).padStart(7)} tris  json ${(entry.jsonBytes / 1024).toFixed(1)} KB  obj ${(entry.objBytes / 1048576).toFixed(2)} MB  (${(performance.now() - t0).toFixed(0)} ms)`);
}
writeFileSync(join(DIR, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
