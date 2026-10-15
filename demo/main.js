import { Renderer, Camera } from '../src/renderer.js';
import { parseOBJ } from '../src/geometry.js';
import { scenes, orbitCamera } from './scenes.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const renderer = new Renderer({ canvas });
const camera = new Camera();

let scene, view, time = 0, last = performance.now();
let objGeometry = null;

function load(name) {
  scene = name === 'stress' ? scenes.stress({ count: +$('count').value })
    : name === 'obj' ? scenes.obj({ geometry: objGeometry })
      : scenes[name]();
  view = { ...scene.view, target: [...scene.view.target] };
  $('countRow').hidden = name !== 'stress';
}

function resize() {
  const v = $('res').value, s = v === 'dpr' ? devicePixelRatio : +v;
  const w = Math.max(1, Math.round(canvas.clientWidth * s)), h = Math.max(1, Math.round(canvas.clientHeight * s));
  if (w !== renderer.width || h !== renderer.height) renderer.setSize(w, h);
}

// ---- controls
$('scene').onchange = (e) => load(e.target.value);
$('count').oninput = () => load('stress');
$('shading').onchange = (e) => { renderer.shading = e.target.value; };
$('wire').onchange = (e) => { renderer.wireframe = e.target.checked; };
$('cull').onchange = (e) => { renderer.cullBack = e.target.checked; };
$('fog').onchange = (e) => { renderer.fog = e.target.checked; };

// orbit: drag to rotate, wheel / pinch to zoom
const pointers = new Map();
let pinch = 0;
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); });
canvas.addEventListener('pointerup', (e) => { pointers.delete(e.pointerId); pinch = 0; });
canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = 0; });
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 1) {
    view.yaw -= (e.clientX - p[0]) * 0.006;
    view.pitch = Math.max(-1.45, Math.min(1.45, view.pitch + (e.clientY - p[1]) * 0.006));
  }
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinch) view.dist = Math.max(1, Math.min(200, view.dist * (pinch / d)));
    pinch = d;
  }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  view.dist = Math.max(1, Math.min(200, view.dist * Math.exp(e.deltaY * 0.001)));
}, { passive: false });

// drag & drop .obj
const drop = $('drop');
addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('on'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('on'); });
addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('on');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  objGeometry = parseOBJ(await file.text());
  $('scene').value = 'obj';
  load('obj');
});

// ---- loop
let fps = 0, renderMs = 0, statsAt = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if ($('anim').checked) {
    time += dt;
    if (scene.spin && !pointers.size) view.yaw += scene.spin * dt;
  }
  scene.update?.(time);
  resize();
  renderer.render(scene, orbitCamera(camera, view));

  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.08;
  renderMs += (renderer.stats.ms - renderMs) * 0.08;
  if (now - statsAt > 250) {
    statsAt = now;
    const s = renderer.stats, k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' k' : String(n));
    $('stats').innerHTML =
      `<b>${fps.toFixed(0)} fps</b>   frame ${renderMs.toFixed(2)} ms (CPU)\n` +
      `Resolution  ${renderer.width} × ${renderer.height}\n` +
      `Triangles   ${k(s.triangles)}\n` +
      `Rasterized  ${k(s.drawn)}   clipped ${s.clipped}\n` +
      `Pixels      ${k(s.pixels)}\n` +
      `Throughput  ${(s.triangles / renderMs / 1000).toFixed(1)} M △/s`;
  }
}

load('showcase');
requestAnimationFrame(frame);
