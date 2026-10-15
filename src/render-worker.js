// Render thread: runs its share of every stage of a frame (pool.js) and meets the other threads at barriers.
// Works as a browser module worker and as a Node worker thread; all big buffers are shared memory.
import { aoRows, blurRows, shadeRows, atmosphereRows, accumulateRows, temporalRows, shadowUnitA, shadowUnitB } from './lighting.js';
import { RasterCore, ownedRows } from './raster.js';
import { CTRL, ROW_CHUNK, PHASES, barrier } from './pool.js';

const core = new RasterCore();
const store = new Map(); // id -> shared geometry or texture

function frame(m) {
  for (const [id, obj] of m.uploads) store.set(id, obj);
  for (const id of m.drop) store.delete(id);
  const { job, k, n, ctrl } = m;
  for (const d of job.draws) { d.geo = store.get(d.geo); if (d.tex !== null) d.tex = store.get(d.tex); }
  const sp = job.shadowPlan;
  if (sp) for (const t of sp.tasks) for (const c of t.casters) c.geo = store.get(c.geo);
  m.profile.fill(0, k * PHASES.length, (k + 1) * PHASES.length);
  // time of this thread per phase (work only, without waiting at barriers), for the pool's profile
  const prof = m.profile, p0 = k * PHASES.length;
  let t = performance.now();
  const lap = (phase) => { const now = performance.now(); prof[p0 + phase] = now - t; t = now; };
  const wait = () => { barrier(ctrl, n); t = performance.now(); };
  try {
    // 1. vertex stage: ranges of vertices claimed from a shared counter
    core.begin(job, ownedRows(job.H, n, k));
    const ch = job.chunks, nc = ch.length / 3;
    for (let c; (c = Atomics.add(ctrl, CTRL.VERTEX, 1)) < nc;) core.vertices(job.draws[ch[c * 3]], ch[c * 3 + 1], ch[c * 3 + 2]);
    // shadow maps, part 1: clear or copy rows, casters into light space
    if (sp) for (let u, na = sp.A.length / 4; (u = Atomics.add(ctrl, CTRL.SHADOW_A, 1)) < na;) shadowUnitA(sp, u);
    lap(0);
    wait();
    // 2. binning: chunks of triangles sorted into the lists of the band groups covering their rows
    const tc = job.tchunks.length / 4, G = job.groups;
    for (let c; (c = Atomics.add(ctrl, CTRL.BIN, 1)) < tc;) core.bin(c, G);
    // shadow maps, part 2: casters rasterized into blocks of rows (done long before the lighting stage reads them)
    if (sp) for (let u, nb = sp.B.length / 3; (u = Atomics.add(ctrl, CTRL.SHADOW_B, 1)) < nb;) shadowUnitB(sp, u);
    lap(1);
    wait();
    // 3. raster: band groups claimed one by one, each drawn from its lists in draw order
    for (let g; (g = Atomics.add(ctrl, CTRL.RASTER, 1)) < G;) {
      core.own = ownedRows(job.H, G, g, job.band);
      core.clear();
      core.binned(g, G);
    }
    const st = core.stats;
    m.counters[k * 3] = st.drawn; m.counters[k * 3 + 1] = st.clipped; m.counters[k * 3 + 2] = st.pixels;
    lap(2);
    if (!job.hq) return { k };
    // 4. shading stages on row blocks, each stage after all threads finished the previous one
    const blocks = (job.H + 1) >> 1, nb = Math.ceil(blocks / ROW_CHUNK), H = job.H;
    const rows = (slot, fn) => {
      for (let c; (c = Atomics.add(ctrl, slot, 1)) < nb;) {
        const b0 = c * ROW_CHUNK, b1 = Math.min(blocks, b0 + ROW_CHUNK);
        fn(b0, b1, Math.min(H, b0 * 2), Math.min(H, b1 * 2));
      }
    };
    wait();
    if (job.ao) {
      rows(CTRL.AO, (b0, b1) => aoRows(job, b0, b1));
      lap(3);
      wait();
    }
    rows(CTRL.SHADE, (b0, b1, y0, y1) => {
      if (job.ao) blurRows(job, b0, b1);
      shadeRows(job, y0, y1);
      if (job.atmos) atmosphereRows(job, y0, y1);
    });
    lap(4);
    wait();
    rows(CTRL.POST, (b0, b1, y0, y1) => (job.post === 'accumulate' ? accumulateRows : temporalRows)(job, y0, y1));
    lap(5);
    return { k };
  } catch (e) {
    // let the other threads out of their barriers, then report
    Atomics.store(ctrl, CTRL.ABORT, 1);
    Atomics.notify(ctrl, CTRL.GEN);
    return { k, error: e.message === 'frame aborted' ? e.message : `${e.message}\n${e.stack}` };
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof process === 'undefined') {
  self.onmessage = (e) => self.postMessage(frame(e.data));
} else {
  const { parentPort } = await import('node:worker_threads');
  parentPort.on('message', (m) => parentPort.postMessage(frame(m)));
}
