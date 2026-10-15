// Headless benchmark: node bench.mjs [scene] [width] [height] [frames] [shading]
// Renders on the CPU without any browser, prints timings and writes out/<scene>.png
import { mkdirSync, writeFileSync } from 'node:fs';
import { Renderer, Camera } from './src/renderer.js';
import { scenes, orbitCamera } from './demo/scenes.js';
import { encodePNG } from './server/png.js';

const [name = 'showcase', W = '1280', H = '720', F = '120', shading = 'gouraud', quality = 'fast'] = process.argv.slice(2);
const renderer = new Renderer({ width: +W, height: +H });
renderer.shading = shading;
renderer.quality = quality;
const scene = scenes[name]();
const camera = orbitCamera(new Camera(), scene.view);

const frame = (t) => { scene.update?.(t); renderer.render(scene, camera); };
for (let i = 0; i < 20; i++) frame(i / 60); // JIT warm-up

const times = [];
for (let i = 0; i < +F; i++) {
  const t0 = performance.now();
  frame(i / 60);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / times.length, med = times[times.length >> 1];
const s = renderer.stats;
console.log(`${name} ${W}x${H} ${shading} ${quality}: avg ${avg.toFixed(2)} ms, median ${med.toFixed(2)} ms (${(1000 / avg).toFixed(0)} fps)`);
console.log(`  triangles ${s.triangles}, rasterized ${s.drawn}, clipped ${s.clipped}, pixels ${s.pixels}, meshes ${s.meshes}`);
console.log(`  ${(s.triangles / avg / 1000).toFixed(2)} M tris/s submitted, ${(s.pixels / avg / 1000).toFixed(1)} M px/s`);

mkdirSync('out', { recursive: true });
writeFileSync(`out/${name}-${shading}-${quality}.png`, encodePNG(renderer.pixels, renderer.width, renderer.height));
