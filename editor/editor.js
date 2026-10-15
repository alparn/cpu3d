// cpu3d editor. Every action goes through the same tools agents use:
//   live mode  -> POST /api/tools/<name> on the cpu3d server, changes stream back over SSE
//   local mode -> no server (e.g. GitHub Pages): an in-browser SceneDocument runs the tools
import { Renderer, Camera } from '../src/renderer.js';
import { SceneDocument, worldBounds } from '../src/document.js';
import { buildShape } from '../src/recipes.js';
import { callTool, pretty } from '../src/tools.js';
import { buildRenderScene, cameraFromState, pick, frameBounds, unionBounds, exportOBJ } from '../src/scene.js';

const $ = (id) => document.getElementById(id);
const canvas = $('viewport');
const renderer = new Renderer({ canvas });
const camera = new Camera();

const state = {
  mode: 'connecting',     // 'live' | 'local'
  scene: null,
  revision: -1,
  selected: null,
  view: { yaw: 35, pitch: 25, distance: 9, target: [0, 0.8, 0] },
  sceneCameraKey: '',
  renderScene: null,
  dirty: true,
  activity: [],
  lastAgentAt: 0,
};
let localDoc = null;

// ---------------------------------------------------------------- geometry cache (client side)
const geoCache = new Map();
function geometryFor(shape) {
  const key = JSON.stringify(shape);
  let g = geoCache.get(key);
  if (!g) {
    g = buildShape(shape);
    geoCache.set(key, g);
    if (geoCache.size > 128) geoCache.delete(geoCache.keys().next().value);
  }
  return g;
}

// ---------------------------------------------------------------- tools
async function browserRender(doc, o) {
  const r = new Renderer({ width: o.width, height: o.height });
  r.shading = o.shading || 'gouraud';
  r.wireframe = !!o.wireframe;
  r.render(buildRenderScene(doc.data, (s) => doc.geometry(s), { selected: o.highlight }), cameraFromState(o.camera));
  const c = document.createElement('canvas');
  c.width = o.width; c.height = o.height;
  c.getContext('2d').putImageData(new ImageData(r.pixels, o.width, o.height), 0, 0);
  return c.toDataURL('image/png').split(',')[1];
}

async function tool(name, args = {}) {
  let result;
  try {
    if (state.mode === 'live') {
      const res = await fetch(`api/tools/${name}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cpu3d-Client': 'you' }, body: JSON.stringify(args),
      });
      result = await res.json();
    } else {
      result = await callTool(localDoc, name, args, { source: 'you', render: browserRender });
    }
  } catch (e) {
    result = { isError: true, content: [{ type: 'text', text: e.message }] };
  }
  if (result.isError) toast(result.content?.[0]?.text || 'Error');
  return result;
}
const toolText = (r) => r.content?.find((c) => c.type === 'text')?.text ?? '';

// ---------------------------------------------------------------- connection
async function connect() {
  try {
    const health = await fetch('api/health', { cache: 'no-store' }).then((r) => r.json());
    if (health.app !== 'cpu3d') throw new Error('not a cpu3d server');
    state.mode = 'live';
    const es = new EventSource('events');
    es.onopen = () => setStatus('live', `live · server ${health.version}`);
    es.onerror = () => setStatus('connecting', 'reconnecting…');
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'hello' && ev.recent) {
        state.activity = ev.recent.slice().reverse();
        renderActivity();
      }
      if (ev.scene) setScene(ev.scene, ev.revision);
      if (ev.activity) pushActivity(ev.activity);
    };
  } catch {
    state.mode = 'local';
    localDoc = new SceneDocument();
    localDoc.on((ev) => {
      if (ev.type === 'change') setScene(localDoc.data, ev.revision);
      if (ev.activity) pushActivity(ev.activity);
    });
    setStatus('local', 'local mode · no server');
    setScene(localDoc.data, 0);
    const ex = await fetch('examples/showcase.json').then((r) => r.json()).catch(() => null);
    if (ex) localDoc.load(ex, { source: 'you', tool: 'load_scene', summary: 'loaded the showcase example' });
  }
}

function setStatus(cls, label) {
  const el = $('status');
  el.className = `status ${cls}`;
  el.querySelector('span').textContent = label;
}

// ---------------------------------------------------------------- scene state
function setScene(scene, revision) {
  state.scene = scene;
  state.revision = revision;
  if (state.selected && !scene.objects.some((o) => o.id === state.selected)) state.selected = null;
  const camKey = JSON.stringify(scene.camera);
  if (camKey !== state.sceneCameraKey) {
    state.sceneCameraKey = camKey;
    state.view = structuredClone(scene.camera);
  }
  rebuild();
}

function rebuild() {
  if (!state.scene) return;
  try {
    state.renderScene = buildRenderScene(state.scene, geometryFor, { selected: state.selected ? [state.selected] : [] });
  } catch (e) {
    toast(e.message);
  }
  state.dirty = true;
  updateSizes();
  renderOutliner();
  renderInspector();
  $('empty').hidden = state.scene.objects.length > 0;
}

// ---------------------------------------------------------------- sizes (download / load / memory)
const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const byteLength = (str) => new Blob([str]).size;
const sceneJSON = () => pretty(state.scene) + '\n'; // same format as the files in examples/

// Computed on every scene change: what a download of the scene would weigh, and the RAM of the geometry.
function updateSizes() {
  {
    if (!state.scene) return;
    const visible = state.scene.objects.filter((o) => o.visible);
    const unique = new Map(state.scene.objects.map((o) => [JSON.stringify(o.shape), o.shape]));
    let ram = 0;
    for (const sh of unique.values()) {
      const g = geometryFor(sh);
      ram += g.positions.byteLength + g.normals.byteLength + g.indices.byteLength + (g.colors?.byteLength ?? 0);
    }
    const sel = selectedObject();
    state.sizes = {
      json: byteLength(sceneJSON()),
      obj: exportOBJ(visible, geometryFor).length,
      ram,
      sel: sel && { name: sel.name, tris: geometryFor(sel.shape).triangleCount, recipe: byteLength(JSON.stringify(sel)), obj: exportOBJ([sel], geometryFor).length },
    };
    renderStats();
  }
}

function select(id) {
  state.selected = id;
  rebuild();
}

const selectedObject = () => state.scene?.objects.find((o) => o.id === state.selected) || null;

// ---------------------------------------------------------------- outliner
function renderOutliner() {
  const list = $('outliner');
  const objs = state.scene.objects;
  $('sceneCount').textContent = objs.length ? `· ${objs.length}` : '';
  list.replaceChildren(...(objs.length ? objs.map((o) => {
    const li = document.createElement('li');
    li.className = (o.id === state.selected ? 'sel ' : '') + (o.visible ? '' : 'off');
    li.innerHTML = `<span class="swatch"></span><span class="name"></span><span class="type"></span><button class="eye" title="Toggle visibility">${o.visible ? '◉' : '○'}</button>`;
    li.querySelector('.swatch').style.background = o.material.color;
    li.querySelector('.name').textContent = o.name;
    li.querySelector('.type').textContent = o.shape.type;
    li.onclick = () => select(o.id);
    li.ondblclick = () => focusObjects([o.id]);
    li.querySelector('.eye').onclick = (e) => { e.stopPropagation(); tool('update_object', { id: o.id, visible: !o.visible }); };
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'none', textContent: 'No objects yet' })]));
}

// ---------------------------------------------------------------- inspector
const fmt = (v) => String(Math.round(v * 1000) / 1000);

function field(label, el) {
  const row = document.createElement('div');
  row.className = 'field';
  const l = document.createElement('label');
  l.textContent = label;
  row.append(l, el);
  return row;
}

function vecInputs(values, step, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'xyz';
  const inputs = values.map((v, i) => {
    const inp = Object.assign(document.createElement('input'), { type: 'number', step, value: fmt(v), title: 'xyz'[i] });
    inp.onchange = () => onChange(inputs.map((x) => parseFloat(x.value) || 0));
    return inp;
  });
  wrap.append(...inputs);
  return wrap;
}

function renderInspector() {
  const box = $('inspector');
  if (box.contains(document.activeElement) && document.activeElement.matches('input[type=text], input[type=number], textarea')) return;
  const o = selectedObject();
  box.replaceChildren();
  if (!o) return renderSceneInfo(box);
  $('inspectorTitle').textContent = 'Inspector';
  const upd = (patch) => tool('update_object', { id: o.id, ...patch });

  const name = Object.assign(document.createElement('input'), { type: 'text', value: o.name });
  name.onchange = () => upd({ name: name.value });
  box.append(field('Name', name));
  box.append(field('Position', vecInputs(o.position, 0.1, (v) => upd({ position: v }))));
  box.append(field('Rotation°', vecInputs(o.rotation, 5, (v) => upd({ rotation: v }))));
  box.append(field('Scale', vecInputs(o.scale, 0.1, (v) => upd({ scale: v }))));

  const color = Object.assign(document.createElement('input'), { type: 'color', value: o.material.color });
  color.onchange = () => upd({ material: { color: color.value } });
  const spec = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 2, step: 0.05, value: o.material.specular, title: 'Specular' });
  spec.onchange = () => upd({ material: { specular: +spec.value } });
  const crow = document.createElement('div');
  crow.className = 'row';
  crow.append(color, spec);
  box.append(field('Material', crow));

  const checks = document.createElement('div');
  checks.className = 'checks';
  for (const [key, label] of [['flat', 'Flat'], ['doubleSided', 'Double sided']]) {
    const l = document.createElement('label');
    const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: o.material[key] });
    c.onchange = () => upd({ material: { [key]: c.checked } });
    l.append(c, label);
    checks.append(l);
  }
  box.append(field('', checks));

  const g = geometryFor(o.shape);
  const head = document.createElement('div');
  head.className = 'subhead';
  head.innerHTML = `<span>Shape recipe</span><span>${g.triangleCount.toLocaleString('en')} triangles</span>`;
  box.append(head);
  if (o.shape.type === 'mesh') {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = `Raw mesh with ${g.vertexCount.toLocaleString('en')} vertices (imported). Recipe editing is not available.`;
    box.append(p);
  } else {
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.value = pretty(o.shape);
    const apply = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Apply recipe' });
    apply.onclick = () => {
      let shape;
      try { shape = JSON.parse(ta.value); } catch (e) { return toast(`Invalid JSON: ${e.message}`); }
      ta.blur();
      upd({ shape });
    };
    box.append(ta, apply);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const mk = (label, fn, cls = '') => Object.assign(document.createElement('button'), { className: `btn ${cls}`, textContent: label, onclick: fn });
  actions.append(mk('Focus', () => focusObjects([o.id])), mk('Duplicate', duplicateSelected), mk('Delete', deleteSelected, 'danger'));
  box.append(actions);
}

function renderSceneInfo(box) {
  $('inspectorTitle').textContent = 'Scene';
  const s = state.scene, env = s.environment;
  let tris = 0;
  for (const o of s.objects) tris += geometryFor(o.shape).triangleCount;
  const kv = document.createElement('div');
  kv.className = 'kv';
  kv.innerHTML = `<span>Objects</span><span>${s.objects.length}</span><span>Triangles</span><span>${tris.toLocaleString('en')}</span>`
    + `<span>Revision</span><span>${state.revision}</span><span>Mode</span><span>${state.mode}</span>`;
  box.append(kv);

  const head = document.createElement('div');
  head.className = 'subhead';
  head.innerHTML = '<span>Environment</span>';
  box.append(head);
  const top = Object.assign(document.createElement('input'), { type: 'color', value: env.background.top, title: 'Top' });
  const bottom = Object.assign(document.createElement('input'), { type: 'color', value: env.background.bottom, title: 'Bottom' });
  top.onchange = bottom.onchange = () => tool('set_environment', { background: { top: top.value, bottom: bottom.value } });
  const bg = document.createElement('div');
  bg.className = 'row';
  bg.append(top, bottom);
  box.append(field('Background', bg));
  const checks = document.createElement('div');
  checks.className = 'checks';
  const ground = Object.assign(document.createElement('input'), { type: 'checkbox', checked: env.ground });
  ground.onchange = () => tool('set_environment', { ground: ground.checked });
  const fog = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!env.fog });
  fog.onchange = () => tool('set_environment', { fog: fog.checked ? { near: 16, far: 45 } : null });
  const l1 = document.createElement('label'), l2 = document.createElement('label');
  l1.append(ground, 'Ground');
  l2.append(fog, 'Fog');
  checks.append(l1, l2);
  box.append(field('', checks));
  const save = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Use current view as scene camera' });
  save.onclick = () => tool('set_camera', { ...state.view });
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(save);
  box.append(actions);
  const tip = document.createElement('p');
  tip.className = 'muted small';
  tip.textContent = 'Select an object in the viewport or the scene list to edit it.';
  box.append(tip);
}

// ---------------------------------------------------------------- activity feed
function pushActivity(a) {
  state.activity.unshift(a);
  state.activity.length = Math.min(state.activity.length, 150);
  if (a.source !== 'you') {
    state.lastAgentAt = Date.now();
    $('working').hidden = false;
    if (a.camera && $('follow').checked) { state.view = structuredClone(a.camera); state.dirty = true; }
  }
  renderActivity(true);
}

function renderActivity(fresh = false) {
  const ol = $('activity');
  if (!state.activity.length) {
    ol.innerHTML = '<li class="none">Nothing yet. Connect an agent and ask it to build something.</li>';
    return;
  }
  ol.replaceChildren(...state.activity.slice(0, 80).map((a, i) => {
    const li = document.createElement('li');
    li.className = (a.error ? 'err ' : '') + (fresh && i === 0 ? 'new' : '');
    const who = Object.assign(document.createElement('span'), { className: `who ${a.source === 'you' ? 'you' : ''}`, textContent: a.source });
    const what = Object.assign(document.createElement('span'), { className: 'what', textContent: a.summary });
    const meta = Object.assign(document.createElement('span'), {
      className: 'meta', textContent: `${new Date(a.time).toLocaleTimeString('en-GB')} · ${a.tool}`,
    });
    li.append(who, what, meta);
    return li;
  }));
}
setInterval(() => { if (Date.now() - state.lastAgentAt > 3000) $('working').hidden = true; }, 500);

// ---------------------------------------------------------------- actions
function focusObjects(ids) {
  const objs = state.scene.objects.filter((o) => ids.includes(o.id) && o.visible);
  if (!objs.length) return;
  const b = unionBounds(objs.map((o) => worldBounds(o, geometryFor(o.shape))));
  state.view = { ...state.view, ...frameBounds(b, state.view) };
  state.dirty = true;
}

function deleteSelected() {
  if (state.selected) tool('remove_objects', { ids: [state.selected] });
}

async function duplicateSelected() {
  const o = selectedObject();
  if (!o) return;
  const { id, ...rest } = structuredClone(o);
  const r = await tool('add_objects', { objects: [{ ...rest, name: `${o.name} copy`, position: [o.position[0] + 1, o.position[1], o.position[2]] }] });
  if (!r.isError) select(JSON.parse(toolText(r)).added[0].id);
}

const PALETTE = ['#f28c33', '#4d99d9', '#59bf73', '#d94d59', '#d9cc59', '#a673d9', '#ccd1db'];
const PRESETS = [
  ['Box', { type: 'box' }, 0.5],
  ['Sphere', { type: 'sphere', radius: 0.5 }, 0.5],
  ['Cylinder', { type: 'cylinder' }, 0.5],
  ['Cone', { type: 'cone' }, 0.5],
  ['Torus', { type: 'torus' }, 0.15],
  ['Plane', { type: 'plane', width: 2, depth: 2 }, 0.001],
  ['Vase (lathe)', { type: 'lathe', profile: [[0, 0], [0.35, 0], [0.45, 0.3], [0.25, 0.9], [0.3, 1.2]] }, 0, { doubleSided: true }],
  ['Star (extrude)', { type: 'extrude', shape: { type: 'star', points: 5, outer: 0.5, inner: 0.22 }, depth: 0.2 }, 0.5],
  ['Twisted column (sweep)', { type: 'sweep', shape: { type: 'star', points: 6, outer: 0.3, inner: 0.2 }, path: { type: 'line', to: [0, 1.5, 0], steps: 48 }, twist: 180 }, 0],
  ['Spring (tube)', { type: 'tube', path: { type: 'helix', radius: 0.3, height: 1.2, turns: 5 }, radius: 0.05 }, 0.05],
  ['Knot (tube)', { type: 'tube', path: { type: 'torusKnot', size: 0.9 }, radius: 0.09 }, 0.6],
  ['Terrain', { type: 'terrain', width: 20, resolution: 96, height: 3 }, 0],
];

function buildAddMenu() {
  const menu = $('addMenu');
  menu.replaceChildren(...PRESETS.map(([label, shape, y, material = {}], i) => {
    const b = document.createElement('button');
    b.innerHTML = `${label}<span>${shape.type}</span>`;
    b.onclick = async () => {
      menu.hidden = true;
      const n = state.scene.objects.length;
      const pos = shape.type === 'terrain' ? [0, 0, 0] : [((n % 5) - 2) * 1.4, y, Math.floor(n / 5) % 4 * 1.4 - 2];
      const r = await tool('add_objects', { objects: [{ name: label.replace(/ \(.*\)/, ''), shape, position: pos, material: { color: PALETTE[i % PALETTE.length], ...material } }] });
      if (!r.isError) select(JSON.parse(toolText(r)).added[0].id);
    };
    return b;
  }));
}

function download(name, content, type) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([content], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function fileAction(kind) {
  $('fileMenu').hidden = true;
  if (kind === 'import') return $('fileInput').click();
  if (kind === 'obj') {
    const r = await tool('export_obj', {});
    if (r.isError) return;
    const text = toolText(r);
    download('scene.obj', text, 'text/plain');
    toast(`Downloaded scene.obj · ${fmtBytes(byteLength(text))}`, 'info');
  }
  if (kind === 'json') {
    const text = sceneJSON();
    download('scene.cpu3d.json', text, 'application/json');
    toast(`Downloaded scene.cpu3d.json · ${fmtBytes(byteLength(text))}`, 'info');
  }
}

$('fileInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const t0 = performance.now();
  const content = await file.text();
  if (file.name.toLowerCase().endsWith('.json')) {
    let scene;
    try { scene = JSON.parse(content); } catch (err) { return toast(`Invalid JSON: ${err.message}`); }
    const r = await tool('load_scene', { scene });
    if (!r.isError) loadedToast(file.name, file.size, t0);
  } else {
    const r = await tool('import_obj', { text: content, name: file.name.replace(/\.obj$/i, '') });
    if (r.isError) return;
    const info = JSON.parse(toolText(r));
    select(info.id);
    toast(`Imported ${file.name} · ${fmtBytes(file.size)} · ${info.triangles.toLocaleString('en')} triangles · ${(performance.now() - t0).toFixed(0)} ms`, 'info');
  }
};

function loadedToast(name, bytes, t0) {
  const s = state.scene;
  let tris = 0;
  for (const o of s.objects) tris += geometryFor(o.shape).triangleCount;
  toast(`Loaded ${name} · ${fmtBytes(bytes)} · ${s.objects.length} objects · ${tris.toLocaleString('en')} triangles · ${(performance.now() - t0).toFixed(0)} ms`, 'info');
}

async function loadExample(id) {
  $('galleryDialog').close();
  const t0 = performance.now();
  const text = await fetch(`examples/${id}.json`).then((r) => r.text());
  const r = await tool('load_scene', { scene: JSON.parse(text) });
  if (!r.isError) loadedToast(`${id}.json`, byteLength(text), t0);
}

async function loadGallery() {
  const items = await fetch('examples/index.json').then((r) => r.json()).catch(() => []);
  $('galleryList').replaceChildren(...items.map((it) => {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span></span>';
    li.firstChild.textContent = it.title;
    li.lastChild.textContent = fmtBytes(it.jsonBytes);
    li.title = `${it.objects} objects · ${it.triangles.toLocaleString('en')} triangles`;
    li.onclick = () => loadExample(it.id);
    return li;
  }));
  $('galleryGrid').replaceChildren(...items.map((it) => {
    const card = document.createElement('button');
    card.className = 'card';
    card.innerHTML = `<img alt="" loading="lazy"><div class="body"><h3></h3><p></p><div class="stats">
      <span><b>${it.objects}</b> objects</span><span><b>${it.triangles.toLocaleString('en')}</b> tris</span>
      <span>json <b>${fmtBytes(it.jsonBytes)}</b></span><span>.obj <b>${fmtBytes(it.objBytes)}</b></span></div></div>`;
    card.querySelector('img').src = `examples/thumbs/${it.id}.png`;
    card.querySelector('h3').textContent = it.title;
    card.querySelector('p').textContent = it.description;
    card.onclick = () => loadExample(it.id);
    return card;
  }));
}

// ---------------------------------------------------------------- connect dialog
function connectSnippets() {
  const live = state.mode === 'live';
  const origin = live ? location.origin : 'http://localhost:8173';
  const start = 'npx -y github:alparn/cpu3d serve';
  const pre = live ? '' : `<p>Start the cpu3d server first (Node 18+):</p>${code(start)}`;
  return {
    'claude-code': `${pre}<p>Add cpu3d as an MCP server:</p>${code(`claude mcp add --transport http cpu3d ${origin}/mcp`)}
      <p>Every tool call the agent makes shows up live in this editor.</p>`,
    'claude-desktop': `<p>Add this to <code>claude_desktop_config.json</code> (Settings → Developer → Edit Config) and restart Claude Desktop.
      It starts cpu3d over stdio and opens the editor at <code>http://localhost:8173</code>; if a server is already running it connects to it.</p>
      ${code(JSON.stringify({ mcpServers: { cpu3d: { command: 'npx', args: ['-y', 'github:alparn/cpu3d', 'mcp'] } } }, null, 2))}`,
    mcp: `${pre}<p>For Cursor (<code>.cursor/mcp.json</code>), Windsurf, VS Code and other clients with Streamable HTTP support:</p>
      ${code(JSON.stringify({ mcpServers: { cpu3d: { url: `${origin}/mcp` } } }, null, 2))}
      <p>Clients that only speak stdio use <code>npx -y github:alparn/cpu3d mcp</code> as the command.</p>`,
    http: `${pre}<p>No MCP? Any agent framework can use plain HTTP. Tool schemas in OpenAI function-calling format:</p>
      ${code(`curl ${origin}/api/tools?format=openai`)}
      <p>Call a tool:</p>
      ${code(`curl -X POST ${origin}/api/tools/add_objects \\
  -H 'Content-Type: application/json' -H 'X-Cpu3d-Client: my-agent' \\
  -d '{"objects":[{"name":"Ball","shape":{"type":"sphere","radius":0.5},"position":[0,0.5,0]}]}'`)}`,
  };
}

function code(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<div class="code"><pre>${esc}</pre><button class="btn" data-copy>Copy</button></div>`;
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  const body = $('connectBody');
  body.innerHTML = connectSnippets()[name];
  body.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      await navigator.clipboard.writeText(b.previousElementSibling.textContent);
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy'; }, 1200);
    };
  });
}

function openConnect() {
  $('connectIntro').textContent = state.mode === 'live'
    ? `This editor is connected to a cpu3d server at ${location.origin}. Agents that connect to it edit this scene live.`
    : 'This page runs in local mode (no server). To let agents build here, run the cpu3d server locally and open the editor it prints.';
  showTab('claude-code');
  $('connectDialog').showModal();
}

// ---------------------------------------------------------------- viewport input
const pointers = new Map();
let drag = null, pinch = 0;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  drag = { x: e.clientX, y: e.clientY, moved: 0, pan: e.button === 2 || e.shiftKey };
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p[0], dy = e.clientY - p[1];
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinch) state.view.distance = Math.max(0.2, Math.min(500, state.view.distance * (pinch / d)));
    pinch = d;
    state.dirty = true;
    return;
  }
  drag.moved += Math.abs(dx) + Math.abs(dy);
  const v = state.view;
  if (drag.pan) {
    const y = (v.yaw * Math.PI) / 180, s = v.distance * 0.0016;
    const right = [Math.cos(y), 0, -Math.sin(y)];
    v.target = [v.target[0] - right[0] * dx * s, v.target[1] + dy * s, v.target[2] - right[2] * dx * s];
  } else {
    v.yaw -= dx * 0.35;
    v.pitch = Math.max(-89, Math.min(89, v.pitch + dy * 0.35));
  }
  state.dirty = true;
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  pinch = 0;
  if (drag && drag.moved < 4 && e.type === 'pointerup' && e.button === 0 && state.renderScene) {
    const r = canvas.getBoundingClientRect();
    const hit = pick(state.renderScene.meshes, camera, ((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2, r.width / r.height);
    select(hit ? hit.mesh.objectId : null);
  }
  drag = null;
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  state.view.distance = Math.max(0.2, Math.min(500, state.view.distance * Math.exp(e.deltaY * 0.001)));
  state.dirty = true;
}, { passive: false });

addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || $('connectDialog').open || $('galleryDialog').open) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); tool(e.shiftKey ? 'redo' : 'undo'); }
  else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  else if (e.key === 'Escape') select(null);
  else if (e.key === 'f' || e.key === 'F') focusObjects(state.selected ? [state.selected] : state.scene.objects.map((o) => o.id));
  else if (e.key === 'w' || e.key === 'W') { $('wire').checked = !$('wire').checked; $('wire').onchange(); }
});

// ---------------------------------------------------------------- UI wiring
function toggleMenu(btn, menu) {
  btn.onclick = (e) => { e.stopPropagation(); const open = menu.hidden; document.querySelectorAll('.dropdown').forEach((m) => { m.hidden = true; }); menu.hidden = !open; };
}
toggleMenu($('addBtn'), $('addMenu'));
toggleMenu($('fileBtn'), $('fileMenu'));
addEventListener('click', () => document.querySelectorAll('.dropdown').forEach((m) => { m.hidden = true; }));
document.querySelectorAll('[data-file]').forEach((b) => { b.onclick = () => fileAction(b.dataset.file); });
const openGallery = () => $('galleryDialog').showModal();
$('galleryBtn').onclick = openGallery;
$('galleryOpen2').onclick = openGallery;
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.tab); });
document.querySelectorAll('[data-open-connect]').forEach((b) => { b.onclick = openConnect; });
$('connectBtn').onclick = openConnect;
$('undoBtn').onclick = () => tool('undo');
$('redoBtn').onclick = () => tool('redo');
$('shading').onchange = (e) => { renderer.shading = e.target.value; state.dirty = true; };
$('wire').onchange = () => { renderer.wireframe = $('wire').checked; state.dirty = true; };
$('res').onchange = () => { state.dirty = true; };

let toastTimer;
function toast(msg, kind = 'error') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind === 'info' ? 'info' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function renderStats() {
  const z = state.sizes;
  let sizes = '';
  if (z) {
    sizes = `\nscene.json ${fmtBytes(z.json)} · .obj ${fmtBytes(z.obj)} · RAM ${fmtBytes(z.ram)}`;
    if (z.sel) sizes += `\nselected "${z.sel.name}": ${z.sel.tris.toLocaleString('en')} tris · recipe ${fmtBytes(z.sel.recipe)} · .obj ${fmtBytes(z.sel.obj)}`;
  }
  $('vstats').textContent = (state.frameStats || '') + sizes;
}

// ---------------------------------------------------------------- render loop (only when something changed)
let lastMs = 0;
function frame() {
  requestAnimationFrame(frame);
  const res = $('res').value, s = res === 'dpr' ? devicePixelRatio : +res;
  const w = Math.max(1, Math.round(canvas.clientWidth * s)), h = Math.max(1, Math.round(canvas.clientHeight * s));
  if (w !== renderer.width || h !== renderer.height) { renderer.setSize(w, h); state.dirty = true; }
  if (!state.dirty || !state.renderScene) return;
  state.dirty = false;
  renderer.render(state.renderScene, cameraFromState(state.view, camera));
  lastMs = renderer.stats.ms;
  const st = renderer.stats;
  state.frameStats = `CPU ${lastMs.toFixed(1)} ms · ${st.triangles.toLocaleString('en')} tris · ${st.drawn.toLocaleString('en')} rasterized · ${w}×${h}`;
  renderStats();
}

window.cpu3d = { state, tool, renderer }; // handy in devtools

buildAddMenu();
loadGallery();
renderActivity();
connect();
requestAnimationFrame(frame);
