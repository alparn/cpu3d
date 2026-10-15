// Builds the example gallery: every scene is created through the same tool API agents use
// (add_objects, probe_height, set_camera, ...), then saved with a thumbnail and stats.
//   node examples/build.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneDocument, callTool } from '../src/index.js';
import { pretty } from '../src/tools.js';
import { exportOBJ } from '../src/scene.js';
import { renderPNG } from '../server/render.js';
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
  await add(doc, [
    { name: 'Torus knot', shape: { type: 'tube', path: { type: 'torusKnot', p: 2, q: 3, steps: 256, size: 1.6 }, radius: 0.14, sides: 12 }, position: [0, 1.7, 0], material: { color: '#f28c33', specular: 0.6, shininess: 40 } },
    { name: 'Vase', shape: { type: 'lathe', profile: vase, segments: 48 }, position: [p(0)[0], 0, p(0)[1]], material: { color: '#4d99d9', specular: 0.5, doubleSided: true } },
    { name: 'Twisted column', shape: { type: 'sweep', shape: { type: 'star', points: 6, outer: 0.45, inner: 0.28 }, path: { type: 'line', from: [0, 0, 0], to: [0, 1.9, 0], steps: 60 }, twist: 180 }, position: [p(1)[0], 0, p(1)[1]], material: { color: '#d9cc59' } },
    { name: 'Star', shape: { type: 'extrude', shape: { type: 'star', points: 5, outer: 0.75, inner: 0.32 }, depth: 0.3 }, position: [p(2)[0], 1, p(2)[1]], rotation: [0, 30, 0], material: { color: '#d94d59' } },
    { name: 'Chrome sphere', shape: { type: 'sphere', radius: 0.65, segments: 40, rings: 20 }, position: [p(3)[0], 0.65, p(3)[1]], material: { color: '#ccd1db', specular: 0.9, shininess: 60 } },
    { name: 'Torus', shape: { type: 'torus', radius: 0.55, tube: 0.2 }, position: [p(4)[0], 0.8, p(4)[1]], rotation: [70, 0, 0], material: { color: '#59bf73' } },
    { name: 'Spring', shape: { type: 'tube', path: { type: 'helix', radius: 0.4, height: 1.6, turns: 5, steps: 300 }, radius: 0.07, sides: 10 }, position: [p(5)[0], 0.1, p(5)[1]], material: { color: '#bfbfcc', specular: 0.8 } },
    { name: 'Base', shape: { type: 'box', width: 0.9, height: 0.4, depth: 0.9 }, position: [p(6)[0], 0.2, p(6)[1]], material: { color: '#a673d9' } },
    { name: 'Spire', shape: { type: 'cone', radius: 0.3, height: 1.0 }, position: [p(6)[0], 0.9, p(6)[1]], material: { color: '#a673d9', flat: true } },
  ]);
  await tool(doc, 'set_camera', { yaw: 28, pitch: 24, distance: 10.5, target: [0, 0.9, 0] });
});

scene('phone', 'Smartphone', 'Product shot of two phones: rounded aluminium bodies, a lit home screen with app icons and dock, and a triple camera module.', async (doc) => {
  await tool(doc, 'set_environment', { background: { top: '#07080b', bottom: '#1b1f27' }, fog: null, ground: false, light: { direction: [0.55, 0.9, 0.25], color: '#fff6ec' } });
  const W = 0.72, H = 1.5, D = 0.08; // phone body, scene units are decimeters
  const rbox = (w, h, d, radius, cornerRadius, segments = 8) => ({ type: 'roundedBox', width: w, height: h, depth: d, radius, cornerRadius, segments });
  const slab = (w, h, r, d = 0.003) => ({ type: 'extrude', shape: { type: 'roundedRect', width: w, height: h, radius: r, segments: 8 }, depth: d });
  const o = [];

  // studio: round podium on a dark floor
  o.push(
    { name: 'Floor', shape: { type: 'lathe', profile: [[14, 0], [0, 0]], segments: 64 }, material: { color: '#121418', specular: 0.25, shininess: 30 } },
    { name: 'Podium', shape: { type: 'lathe', profile: [[0, 0], [1.35, 0], [1.35, 0.13], [1.3, 0.18], [0, 0.18]], segments: 96 }, material: { color: '#2b2f37', specular: 0.4, shininess: 40 } },
  );
  const top = 0.18;

  // ---- phone A: screen towards the camera, leaning back 10 degrees
  const lean = 10, ca = Math.cos((lean * Math.PI) / 180), sa = Math.sin((lean * Math.PI) / 180);
  const A = group([-0.5, P(top + (H / 2) * ca + (D / 2) * sa)[0], 0.35], [-lean, 16, 0]);
  const front = D / 2;
  const screen = (x, y, z) => [x, y, front + z];
  o.push(
    A({ name: 'Phone A body', shape: rbox(W, H, D, 0.034, 0.11), material: { color: '#3b3e44', specular: 1.4, shininess: 70 } }),
    A({ name: 'Phone A glass', shape: rbox(W - 0.02, H - 0.02, 0.006, 0.003, 0.1), position: [0, 0, front - 0.002], material: { color: '#050608', specular: 1.6, shininess: 140 } }),
    A({ name: 'Wallpaper', shape: slab(W - 0.06, H - 0.06, 0.085), position: screen(0, 0, 0.0025), material: { color: '#161a3d', specular: 0.6, shininess: 80 } }),
    A({ name: 'Glow violet', shape: { type: 'extrude', shape: { type: 'circle', radius: 0.26, points: 48 }, depth: 0.002 }, position: screen(-0.06, 0.28, 0.0045), material: { color: '#4b35b8', specular: 0.5 } }),
    A({ name: 'Glow pink', shape: { type: 'extrude', shape: { type: 'circle', radius: 0.21, points: 48 }, depth: 0.002 }, position: screen(0.12, -0.08, 0.0055), material: { color: '#a8306a', specular: 0.5 } }),
    A({ name: 'Glow amber', shape: { type: 'extrude', shape: { type: 'circle', radius: 0.15, points: 40 }, depth: 0.002 }, position: screen(-0.12, -0.38, 0.0065), material: { color: '#b8692a', specular: 0.5 } }),
    A({ name: 'Camera cutout', shape: slab(0.19, 0.052, 0.026), position: screen(0, 0.655, 0.008), material: { color: '#000000', specular: 1.5, shininess: 120 } }),
  );
  // status bar
  o.push(
    A({ name: 'Clock', shape: slab(0.07, 0.022, 0.006), position: screen(-0.22, 0.655, 0.008), material: { color: '#f2f3f7', specular: 0.3 } }),
    A({ name: 'Battery', shape: slab(0.05, 0.022, 0.007), position: screen(0.23, 0.655, 0.008), material: { color: '#f2f3f7', specular: 0.3 } }),
  );
  // big widget + app grid
  o.push(A({ name: 'Weather widget', shape: slab(0.56, 0.26, 0.05), position: screen(0, 0.44, 0.0085), material: { color: '#2a6ff2', specular: 0.6, shininess: 60 } }));
  o.push(A({ name: 'Widget sun', shape: { type: 'extrude', shape: { type: 'circle', radius: 0.045, points: 32 }, depth: 0.002 }, position: screen(0.17, 0.48, 0.0105), material: { color: '#ffd34d', specular: 0.4 } }));
  o.push(A({ name: 'Widget temp', shape: slab(0.16, 0.06, 0.012), position: screen(-0.13, 0.46, 0.0105), material: { color: '#eef3ff', specular: 0.3 } }));
  const icons = ['#34c759', '#0a84ff', '#ff9f0a', '#ff375f', '#5e5ce6', '#64d2ff', '#ffd60a', '#bf5af2', '#30d158', '#ff6b35', '#0fb5ae', '#f2f2f7', '#ff2d55', '#8e8e93', '#32ade6', '#a2845e'];
  icons.forEach((col, i) => {
    const cx = -0.21 + (i % 4) * 0.14, cy = 0.22 - Math.floor(i / 4) * 0.165;
    o.push(A({ name: 'App icon', shape: slab(0.105, 0.105, 0.026), position: screen(P(cx)[0], P(cy)[0], 0.0085), material: { color: col, specular: 0.7, shininess: 60 } }));
  });
  o.push(A({ name: 'Dock', shape: slab(0.62, 0.15, 0.055), position: screen(0, -0.6, 0.0085), material: { color: '#3b3f63', specular: 0.6, shininess: 60 } }));
  ['#34c759', '#0a84ff', '#f2f2f7', '#ff9f0a'].forEach((col, i) => {
    o.push(A({ name: 'Dock icon', shape: slab(0.105, 0.105, 0.026), position: screen(P(-0.21 + i * 0.14)[0], -0.6, 0.0105), material: { color: col, specular: 0.7, shininess: 60 } }));
  });
  o.push(A({ name: 'Home indicator', shape: slab(0.2, 0.012, 0.006), position: screen(0, -0.705, 0.0085), material: { color: '#d8dae3' } }));
  // side buttons
  o.push(
    A({ name: 'Power button', shape: rbox(0.03, 0.18, 0.03, 0.012, 0.012, 4), position: [W / 2 + 0.008, 0.28, 0], material: { color: '#45484e', specular: 1.4, shininess: 70 } }),
    A({ name: 'Volume up', shape: rbox(0.03, 0.12, 0.03, 0.012, 0.012, 4), position: [-W / 2 - 0.008, 0.33, 0], material: { color: '#45484e', specular: 1.4, shininess: 70 } }),
    A({ name: 'Volume down', shape: rbox(0.03, 0.12, 0.03, 0.012, 0.012, 4), position: [-W / 2 - 0.008, 0.18, 0], material: { color: '#45484e', specular: 1.4, shininess: 70 } }),
  );

  // ---- phone B: back towards the camera, camera module
  const B = group([0.55, P(top + (H / 2) * ca + (D / 2) * sa)[0], -0.2], [lean, 158, 0]);
  const back = -D / 2;
  o.push(
    B({ name: 'Phone B body', shape: rbox(W, H, D, 0.034, 0.11), material: { color: '#26364f', specular: 1.4, shininess: 70 } }),
    B({ name: 'Back glass', shape: rbox(W - 0.03, H - 0.03, 0.006, 0.003, 0.1), position: [0, 0, back + 0.001], material: { color: '#2d4263', specular: 0.5, shininess: 25 } }),
    B({ name: 'Camera plateau', shape: rbox(0.33, 0.33, 0.03, 0.012, 0.075), position: [0.165, 0.52, back - 0.012], material: { color: '#34507a', specular: 1.2, shininess: 90 } }),
  );
  for (const [x, y] of [[0.08, 0.6], [0.08, 0.44], [0.25, 0.52]]) {
    o.push(
      B({ name: 'Lens ring', shape: { type: 'cylinder', radiusTop: 0.068, radiusBottom: 0.068, height: 0.03, segments: 48 }, position: [x, y, back - 0.035], rotation: [90, 0, 0], material: { color: '#b4bcc8', specular: 1.6, shininess: 90 } }),
      B({ name: 'Lens', shape: { type: 'cylinder', radiusTop: 0.052, radiusBottom: 0.052, height: 0.034, segments: 48 }, position: [x, y, back - 0.036], rotation: [90, 0, 0], material: { color: '#06080c', specular: 2, shininess: 160 } }),
      B({ name: 'Lens glass', shape: { type: 'sphere', radius: 0.03, segments: 32, rings: 16 }, position: [x, y, back - 0.047], scale: [1, 1, 0.35], material: { color: '#1b2a4a', specular: 2, shininess: 200 } }),
    );
  }
  o.push(
    B({ name: 'Flash', shape: { type: 'cylinder', radiusTop: 0.022, radiusBottom: 0.022, height: 0.012, segments: 32 }, position: [0.25, 0.64, back - 0.03], rotation: [90, 0, 0], material: { color: '#f6ead0', specular: 1.2, shininess: 80 } }),
    B({ name: 'Sensor', shape: { type: 'cylinder', radiusTop: 0.016, radiusBottom: 0.016, height: 0.012, segments: 24 }, position: [0.25, 0.4, back - 0.03], rotation: [90, 0, 0], material: { color: '#0b0d12', specular: 1.4, shininess: 120 } }),
    B({ name: 'Power button', shape: rbox(0.03, 0.18, 0.03, 0.012, 0.012, 4), position: [W / 2 + 0.008, 0.28, 0], material: { color: '#2c3d58', specular: 1.4, shininess: 70 } }),
  );
  // the display lights itself: everything on the screen is emissive and barely reflects
  const glow = { Wallpaper: 0.8, 'Glow violet': 0.75, 'Glow pink': 0.75, 'Glow amber': 0.75, Clock: 1.2, Battery: 1.2, 'Weather widget': 1.1,
    'Widget sun': 1.3, 'Widget temp': 1.3, 'App icon': 1.15, Dock: 0.9, 'Dock icon': 1.15, 'Home indicator': 1.2 };
  for (const part of o) if (glow[part.name]) part.material = { ...part.material, emissive: glow[part.name], specular: 0.05 };
  // camera lenses get a faint blue coating glint
  for (const part of o) if (part.name === 'Lens glass') part.material = { ...part.material, emissive: 0.15 };
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 12, pitch: 7, distance: 2.75, target: [0.02, 0.9, 0] });
});

scene('castle', 'Castle', 'Curtain walls with 48 merlons, four towers, a keep, gatehouse, moat ring, bridge and a forest. About 190 objects.', async (doc) => {
  const rand = rng(11);
  // round-arched gate: rectangle with a half circle on top (counter-clockwise)
  const gateShape = [[-0.75, 0], [0.75, 0], ...Array.from({ length: 13 }, (_, i) => P(Math.cos((i / 12) * Math.PI) * 0.75, 1.5 + Math.sin((i / 12) * Math.PI) * 0.75))];
  const stone = '#a19b90', dark = '#857f75', roof = '#8c2f24', wood = '#6b4a2f';
  await tool(doc, 'set_environment', { background: { top: '#6f9fd8', bottom: '#dce7f1' }, fog: { near: 45, far: 140 }, ground: false, light: { direction: [0.5, 0.8, 0.35] } });
  const o = [
    { name: 'Meadow', shape: { type: 'plane', width: 90, depth: 90 }, material: { color: '#5a8a42', specular: 0 } },
    { name: 'Moat', shape: { type: 'lathe', profile: [[12.5, 0.03], [9, 0.03]], segments: 72 }, material: { color: '#2f6290', specular: 1, shininess: 60 } },
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
      { name: 'Tower roof', shape: { type: 'cone', radius: 1.7, height: 2.6, segments: 28 }, position: [x, 7.4, z], material: { color: roof } },
      { name: 'Flagpole', shape: { type: 'cylinder', radiusTop: 0.03, radiusBottom: 0.04, height: 1.3, segments: 8 }, position: [x, 9.3, z], material: { color: '#333' } },
      { name: 'Flag', shape: { type: 'extrude', shape: [[0, 0], [0.8, 0.22], [0, 0.45]], depth: 0.03 }, position: [x + 0.03, 9.45, z], rotation: [0, -30, 0], material: { color: '#e8c547', doubleSided: true } },
    );
  }
  o.push(
    { name: 'Keep', shape: { type: 'box', width: 4, height: 6.5, depth: 4 }, position: [0, 3.25, -1.2], material: { color: dark } },
    { name: 'Keep roof', shape: { type: 'cone', radius: 3.1, height: 2.6, segments: 4 }, position: [0, 7.8, -1.2], rotation: [0, 45, 0], material: { color: roof, flat: true } },
    { name: 'Keep turret', shape: { type: 'lathe', profile: [[0, 0], [0.75, 0], [0.7, 7.5], [0.9, 7.6], [0.9, 8.1], [0, 8.1]], segments: 24 }, position: [1.9, 0, 0.6], material: { color: stone } },
    { name: 'Turret roof', shape: { type: 'cone', radius: 1, height: 1.8, segments: 24 }, position: [1.9, 9, 0.6], material: { color: roof } },
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
});

scene('chess', 'Chess set', 'Italian opening on a wooden board. Every piece is a lathe profile, the knights are extruded silhouettes.', async (doc) => {
  await tool(doc, 'set_environment', { background: { top: '#1d1814', bottom: '#4a3b2e' }, fog: null, ground: false, light: { direction: [-0.5, 0.9, 0.6], color: '#fff3e0' } });
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
        material: { color: (f + r) % 2 ? '#e9dcc0' : '#6b4a2f', specular: 0.35, shininess: 40 } });
    }
  }
  for (const [x, z, w, d] of [[0, 4.3, 8.9, 0.6], [0, -4.3, 8.9, 0.6], [4.3, 0, 0.6, 8], [-4.3, 0, 0.6, 8]]) {
    o.push({ name: 'Frame', shape: { type: 'box', width: w, height: 0.3, depth: d }, position: [x, 0.15, z], material: { color: '#3d2716', specular: 0.4 } });
  }
  o.push({ name: 'Table', shape: { type: 'cylinder', radiusTop: 9, radiusBottom: 9, height: 0.4, segments: 64 }, position: [0, -0.2, 0], material: { color: '#2a201a', specular: 0.2 } });
  const back = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
  const pos = [];
  for (let f = 0; f < 8; f++) { pos.push(['w', back[f], f, 1], ['w', 'pawn', f, 2], ['b', 'pawn', f, 7], ['b', back[f], f, 8]); }
  const moves = [[4, 2, 4, 4], [4, 7, 4, 5], [6, 1, 5, 3], [1, 8, 2, 6], [5, 1, 2, 4]];
  for (const [f0, r0, f1, r1] of moves) { const p = pos.find((q) => q[2] === f0 && q[3] === r0); p[2] = f1; p[3] = r1; }
  for (const [side, kind, f, r] of pos) {
    const x = f - 3.5, z = 3.5 - (r - 1), mat = side === 'w' ? { color: '#efe6d2', specular: 0.6, shininess: 50 } : { color: '#2b2522', specular: 0.9, shininess: 60 };
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
});

scene('station', 'Space station', 'A rotating-wheel station with spokes, solar wings, docking modules, an antenna dish, an approaching shuttle and a ringed planet.', async (doc) => {
  const rand = rng(5);
  await tool(doc, 'set_environment', { background: { top: '#020308', bottom: '#0e1832' }, fog: null, ground: false, light: { direction: [0.8, 0.35, 0.5], color: '#fff8ee' } });
  const hull = { color: '#d7d9de', specular: 0.8, shininess: 50 }, metal = { color: '#9aa0aa', specular: 0.7 };
  const o = [
    { name: 'Hub', shape: { type: 'sphere', radius: 1.7, segments: 40, rings: 20 }, material: hull },
    { name: 'Spine', shape: { type: 'cylinder', radiusTop: 0.45, radiusBottom: 0.45, height: 16, segments: 20 }, material: metal },
    { name: 'Habitat ring', shape: { type: 'torus', radius: 9, tube: 0.9, segments: 128, sides: 20 }, material: hull },
    { name: 'Light strip', shape: { type: 'torus', radius: 9.95, tube: 0.12, segments: 128, sides: 6 }, material: { color: '#f59e42', specular: 1.5 } },
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
        o.push({ name: 'Solar panel', shape: { type: 'box', width: 2.7, height: 0.05, depth: 3.8 }, position: [r4(side * (11 + k * 2.9)), 6 * s, 0], material: { color: '#1c3a7a', specular: 1.3, shininess: 90 } });
      }
    }
  }
  const dish = [];
  for (let i = 0; i <= 12; i++) { const r = (i / 12) * 1.8; dish.push(P(r, r * r * 0.22)); }
  o.push(
    { name: 'Antenna mast', shape: { type: 'cylinder', radiusTop: 0.06, radiusBottom: 0.08, height: 1.4, segments: 8 }, position: [0, 13.2, 0], material: metal },
    { name: 'Antenna dish', shape: { type: 'lathe', profile: dish, segments: 32 }, position: [0, 13.9, 0], rotation: [25, 0, 0], material: { color: '#eceef2', doubleSided: true, specular: 0.6 } },
    { name: 'Shuttle fuselage', shape: { type: 'lathe', profile: [[0, 0], [0.5, 0], [0.55, 2.4], [0.4, 3.1], [0.18, 3.5], [0, 3.6]], segments: 20 }, position: [16, 4, 9], rotation: [0, 35, -90], material: hull },
    { name: 'Shuttle wings', shape: { type: 'extrude', shape: [[1.4, 0], [-1, 1.6], [-1.3, 1.6], [-1.1, 0], [-1.3, -1.6], [-1, -1.6]], depth: 0.1 }, position: [17.1, 4, 8.2], rotation: [90, 0, 35], material: { color: '#cfd2d8', flat: true } },
    { name: 'Engine glow', shape: { type: 'cone', radius: 0.45, height: 1.2, segments: 16 }, position: [15.6, 4, 9.25], rotation: [0, 35, 90], material: { color: '#ff9b3d', specular: 2 } },
    { name: 'Planet', shape: { type: 'sphere', radius: 40, segments: 64, rings: 32 }, position: [-60, -38, -95], material: { color: '#2f6db5', specular: 0.3 } },
    { name: 'Planet ring', shape: { type: 'torus', radius: 62, tube: 0.9, segments: 160, sides: 8 }, position: [-60, -38, -95], rotation: [14, 0, 9], material: { color: '#c8a46a' } },
  );
  const stars = [], idx = [];
  for (let i = 0; i < 400; i++) {
    const u = rand() * 2 - 1, t = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u), R = 260;
    const c = [Math.cos(t) * s * R, u * R, Math.sin(t) * s * R], k = 0.5 + rand() * 0.6, b = stars.length / 3;
    stars.push(...P(c[0], c[1] + k, c[2]), ...P(c[0] - k, c[1] - k, c[2]), ...P(c[0] + k, c[1] - k, c[2] + k));
    idx.push(b, b + 1, b + 2);
  }
  o.push({ name: 'Stars', shape: { type: 'mesh', positions: stars, indices: idx }, material: { color: '#ffffff', doubleSided: true, specular: 0 } });
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 38, pitch: 24, distance: 40, target: [2, 0, 0] });
});

scene('city', 'City block', 'A procedural downtown: 36 blocks, towers with setbacks, round glass towers, rooftop details and a park with a pond.', async (doc) => {
  const rand = rng(42);
  await tool(doc, 'set_environment', { background: { top: '#7fa6d6', bottom: '#e6edf3' }, fog: { near: 45, far: 120 }, ground: false, light: { direction: [0.6, 0.75, 0.3], color: '#fff6e8' } });
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
        o.push({ name: 'Pond', shape: { type: 'lathe', profile: [[1.7, 0.21], [0, 0.21]], segments: 40 }, position: [cx + 1, 0, cz + 0.8], material: { color: '#3b6f99', specular: 1.2, shininess: 70 } });
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
          o.push({ name: 'Glass tower', shape: { type: 'cylinder', radiusTop: 1.4, radiusBottom: 1.6, height: h, segments: 28 }, position: [x, h / 2 + 0.15, z], material: { color: g, specular: 1.4, shininess: 80 } });
          o.push({ name: 'Crown', shape: { type: 'cylinder', radiusTop: 0.9, radiusBottom: 1.4, height: 1.2, segments: 28 }, position: [x, h + 0.75, z], material: { color: '#d9dde2' } });
          o.push({ name: 'Spire', shape: { type: 'cylinder', radiusTop: 0.02, radiusBottom: 0.08, height: 3, segments: 6 }, position: [x, h + 2.85, z], material: { color: '#d9dde2' } });
          continue;
        }
        const w = r4(2.6 + rand() * 0.8), d = r4(2.6 + rand() * 0.8);
        o.push({ name: 'Building', shape: { type: 'box', width: w, height: h, depth: d }, position: [x, h / 2 + 0.15, z], material: { color: col, specular: 0.15 } });
        if (h > 8) {
          const h2 = r4(h * (0.25 + rand() * 0.3));
          o.push({ name: 'Setback', shape: { type: 'box', width: r4(w * 0.7), height: h2, depth: r4(d * 0.7) }, position: [x, r4(h + h2 / 2 + 0.15), z], material: { color: col, specular: 0.15 } });
          if (rand() < 0.5) o.push({ name: 'Antenna', shape: { type: 'cylinder', radiusTop: 0.03, radiusBottom: 0.06, height: 2.5, segments: 6 }, position: [x, r4(h + h2 + 1.4), z], material: { color: '#cfd3d8' } });
        } else if (rand() < 0.6) {
          o.push({ name: 'Rooftop unit', shape: { type: 'box', width: 0.8, height: 0.4, depth: 0.6 }, position: [r4(x + 0.4), r4(h + 0.35), z], material: { color: '#8a8f96' } });
        }
      }
    }
  }
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 35, pitch: 27, distance: 82, target: [0, 8, 0] });
});

scene('garden', 'Alien garden', 'Tapered sweeps along procedural curves, glowing mushrooms, spiral shells and crystals, all placed on the terrain with probe_height.', async (doc) => {
  const rand = rng(3);
  await tool(doc, 'set_environment', { background: { top: '#061620', bottom: '#1d4b57' }, fog: { near: 16, far: 55 }, ground: false, light: { direction: [-0.4, 0.8, 0.5], color: '#d4f1ff' } });
  await add(doc, [{ name: 'Ground', shape: { type: 'terrain', width: 56, resolution: 140, height: 3.2, scale: 0.07, seed: 3, waterLevel: 0.15, colorize: false }, material: { color: '#3a2f55', specular: 0.2 } }]);
  const neon = ['#ff4fa3', '#58f2c6', '#ffd166', '#8c7bff', '#4fd1ff'];
  const spots = Array.from({ length: 70 }, () => { const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * 15; return P(Math.cos(a) * d, Math.sin(a) * d); });
  const ys = await probe(doc, spots);
  const o = [];
  spots.forEach(([x, z], i) => {
    const y = r4(ys[i] - 0.05), col = neon[i % neon.length];
    if (i < 30) {
      const h = 2 + rand() * 4, ph = rand() * 6, path = [];
      for (let k = 0; k <= 24; k++) { const t = k / 24; path.push(P(Math.sin(t * 3 + ph) * 0.7 * t, h * t, Math.cos(t * 2.4 + ph) * 0.7 * t)); }
      o.push({ name: 'Tentacle', shape: { type: 'sweep', shape: { type: 'circle', radius: r4(0.14 + rand() * 0.12), points: 10 }, path, scaleEnd: 0.08 }, position: [x, y, z], material: { color: col, specular: 1, shininess: 50 } });
    } else if (i < 42) {
      const s = r4(0.6 + rand() * 0.9);
      o.push({ name: 'Mushroom stem', shape: { type: 'cylinder', radiusTop: 0.12, radiusBottom: 0.18, height: 1.3, segments: 12 }, position: [x, r4(y + 0.65 * s), z], scale: s, material: { color: '#e8e0f0' } });
      o.push({ name: 'Mushroom cap', shape: { type: 'lathe', profile: [[0, 0], [0.85, 0.02], [0.8, 0.22], [0.5, 0.45], [0, 0.55]], segments: 28 }, position: [x, r4(y + 1.25 * s), z], scale: s, material: { color: col, specular: 1.2, shininess: 40 } });
    } else if (i < 50) {
      const path = [];
      for (let k = 0; k <= 80; k++) { const t = k / 80, a = t * Math.PI * 7, r = 0.9 * (1 - t) + 0.05; path.push(P(Math.cos(a) * r, t * 1.6, Math.sin(a) * r)); }
      o.push({ name: 'Spiral shell', shape: { type: 'sweep', shape: { type: 'circle', radius: 0.32, points: 12 }, path, scaleEnd: 0.1 }, position: [x, r4(y + 0.2), z], material: { color: '#f2d4b6', specular: 0.9 } });
    } else {
      o.push({ name: 'Crystal', shape: { type: 'cone', radius: r4(0.18 + rand() * 0.25), height: r4(1 + rand() * 2), segments: 5 }, position: [x, r4(y + 0.6), z], rotation: P(rand() * 40 - 20, rand() * 360, rand() * 40 - 20), material: { color: '#7fe8ff', specular: 1.6, shininess: 90, flat: true } });
    }
  });
  await add(doc, o);
  await tool(doc, 'set_camera', { yaw: 15, pitch: 16, distance: 22, target: [0, 2.2, 0] });
});

scene('lighthouse', 'Lighthouse island', 'A noise terrain island; the lighthouse and boat were placed on the surface and on the water with probe_height.', async (doc) => {
  await tool(doc, 'set_environment', { background: { top: '#3a5f95', bottom: '#c9d6e3' }, fog: { near: 30, far: 80 }, ground: false, light: { direction: [-0.6, 0.7, 0.4], color: '#fff1dc' } });
  await add(doc, [{ name: 'Island', shape: { type: 'terrain', width: 60, resolution: 160, height: 7, scale: 0.05, seed: 7, waterLevel: 0.42 }, position: [0, -0.2, 0] }]);
  const [hill] = await probe(doc, [[0, 0]]);
  const y = r4(hill);
  const rail = Array.from({ length: 17 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return P(Math.cos(a) * 1.15, 0, Math.sin(a) * 1.15); });
  await add(doc, [
    { name: 'Rock base', shape: { type: 'cylinder', radiusTop: 2.2, radiusBottom: 2.8, height: 1.2, segments: 9 }, position: [0, y, 0], material: { color: '#6e6a66', flat: true } },
    { name: 'Tower', shape: { type: 'lathe', profile: [[0, 0], [1.1, 0], [1.0, 1.5], [0.8, 5.2], [0, 5.2]], segments: 40 }, position: [0, r4(y + 0.6), 0], material: { color: '#f2f0ea' } },
    { name: 'Red band', shape: { type: 'cylinder', radiusTop: 0.93, radiusBottom: 0.97, height: 1.0, segments: 40, caps: false }, position: [0, r4(y + 3.2), 0], material: { color: '#c7362f' } },
    { name: 'Gallery', shape: { type: 'cylinder', radiusTop: 1.25, radiusBottom: 1.25, height: 0.15, segments: 40 }, position: [0, r4(y + 5.85), 0], material: { color: '#2c2f36' } },
    { name: 'Railing', shape: { type: 'tube', path: rail, radius: 0.035, sides: 6, closed: true }, position: [0, r4(y + 6.35), 0], material: { color: '#2c2f36' } },
    { name: 'Lantern', shape: { type: 'cylinder', radiusTop: 0.6, radiusBottom: 0.6, height: 0.9, segments: 8 }, position: [0, r4(y + 6.4), 0], material: { color: '#ffd166', specular: 1.4, shininess: 80, flat: true, emissive: 1.2 } },
    { name: 'Roof', shape: { type: 'cone', radius: 0.8, height: 0.8, segments: 24 }, position: [0, r4(y + 7.25), 0], material: { color: '#c7362f' } },
    { name: 'Boat hull', shape: { type: 'extrude', shape: [[-1.1, 0.3], [-0.8, -0.2], [0.8, -0.2], [1.3, 0.35]], depth: 0.7 }, position: [-4, -0.05, 16], rotation: [0, 35, 0], material: { color: '#8a4b2a', flat: true } },
    { name: 'Mast', shape: { type: 'cylinder', radiusTop: 0.04, radiusBottom: 0.05, height: 1.8 }, position: [-4, 1.05, 16], material: { color: '#d8cbb0' } },
  ]);
  await tool(doc, 'set_camera', { yaw: 20, pitch: 14, distance: 27, target: [0, 4, 7] });
});

// ------------------------------------------------------------------------------------ build
mkdirSync(join(DIR, 'thumbs'), { recursive: true });
const manifest = [];
for (const s of SCENES) {
  const t0 = performance.now();
  const doc = new SceneDocument();
  await s.build(doc);
  const json = pretty(doc.data) + '\n';
  writeFileSync(join(DIR, `${s.id}.json`), json);
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
