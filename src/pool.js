// A pool of render threads that runs whole frames: vertex stage, raster, AO, lighting and the post stage.
//
//   - One message per thread and frame. Inside the frame the threads meet at barriers in shared memory
//     (Atomics.wait), so a frame costs no extra round trips to the main thread, which only prepares the draw
//     list and stays free for the UI.
//   - Work is claimed, not dealt: every stage hands out small chunks (vertex ranges, triangle chunks, band
//     groups, AO and pixel row blocks) from an atomic counter, so a thread that gets cheap work takes more of it.
//   - Shadow maps of moving objects are drawn by the threads too, alongside the vertex and binning stages.
//   - The raster stage splits the rows into interleaved band groups (a few per thread). A binning stage first
//     sorts every triangle, once, into the lists of the groups whose rows it covers (sort-middle), so a thread
//     drawing a group only touches its triangles. Triangles keep their order, so frames are pixel-identical to
//     one thread (raster.js).
//   - Frames are queued (several renderers can share one pool), geometry and textures are copied to shared
//     memory once and dropped again when no frame used them for a while.
//   - A failing or crashing thread aborts the frame on all threads (no thread is left waiting at a barrier) and
//     the error reaches the caller; Renderer#renderAsync then goes back to one thread. A watchdog does the same
//     for a frame that does not finish within FRAME_TIMEOUT_MS.
//
// Needs SharedArrayBuffer: always there in Node; in browsers only on cross-origin isolated pages.

import { triangleChunks, bandFor } from './raster.js';

// control words (Int32Array over shared memory)
export const CTRL = { ARRIVE: 0, GEN: 1, ABORT: 2, VERTEX: 3, BIN: 4, RASTER: 5, AO: 6, SHADE: 7, POST: 8, SHADOW_A: 9, SHADOW_B: 10, SIZE: 12 };
export const ROW_CHUNK = 2; // AO block rows (4 pixel rows) per claimed chunk of the shading stages
export const GROUPS_PER_THREAD = 3; // raster band groups per thread (claimed like everything else)
export const PHASES = ['vertex', 'bin', 'raster', 'ao', 'shade', 'post'];
const KEEP_FRAMES = 300; // geometry / textures no frame used for this long are released
export const FRAME_TIMEOUT_MS = 10000; // watchdog: a frame taking longer is aborted and the pool retired

export class RenderPool {
  constructor(workers) {
    this.workers = workers; // [{ post(msg), pending: { resolve, reject } | null, terminate() }]
    this.size = workers.length;
    this.ctrl = new Int32Array(new SharedArrayBuffer(CTRL.SIZE * 4));
    this.counters = new Int32Array(new SharedArrayBuffer(this.size * 3 * 4)); // drawn, clipped, pixels per thread
    this.profileBuf = new Float64Array(new SharedArrayBuffer(this.size * PHASES.length * 8)); // ms per thread and phase
    this.profile = null; // last frame: { phase: [slowest thread ms, average ms] }, see _frame
    this.frames = 0;
    this.broken = null;
    this.timeout = FRAME_TIMEOUT_MS;
    this._queue = Promise.resolve();
    this._ids = new WeakMap(); // geometry or texture -> id
    this._live = new Map(); // id -> { obj, last frame used, kind }
    this._nextId = 1;
    this._drop = [];
  }

  // Returns null when threads are not available (renderers then work on their own thread).
  static async create({ threads } = {}) {
    if (typeof SharedArrayBuffer === 'undefined') return null;
    const url = new URL('./render-worker.js', import.meta.url);
    const isNode = typeof process !== 'undefined' && !!process.versions?.node;
    try {
      let pool;
      if (!isNode) {
        if (!globalThis.crossOriginIsolated || typeof Worker === 'undefined') return null;
        const n = threads ?? Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
        pool = new RenderPool(Array.from({ length: n }, (_, k) => {
          const w = new Worker(url, { type: 'module', name: `cpu3d render ${k + 1}` });
          const slot = { pending: null, post: (m) => w.postMessage(m), terminate: () => w.terminate() };
          w.onmessage = (e) => pool._reply(slot, e.data);
          w.onerror = (e) => pool._crash(slot, new Error(`render thread ${k + 1}: ${e.message}`));
          return slot;
        }));
        return pool;
      }
      const { Worker: NodeWorker } = await import('node:worker_threads');
      const os = await import('node:os');
      const n = threads ?? Math.min(8, Math.max(2, (os.availableParallelism?.() ?? os.cpus().length) - 1));
      pool = new RenderPool(Array.from({ length: n }, (_, k) => {
        // referenced only while it has work, so an idle pool does not keep the process alive
        const w = new NodeWorker(url, { name: `cpu3d render ${k + 1}` });
        const slot = { pending: null, post: (m) => w.postMessage(m), terminate: () => w.terminate(), hold: (on) => (on ? w.ref() : w.unref()) };
        w.on('message', (m) => pool._reply(slot, m));
        w.on('error', (e) => pool._crash(slot, new Error(`render thread ${k + 1}: ${e.message}`)));
        w.on('exit', (code) => { if (!pool.closed) pool._crash(slot, new Error(`render thread ${k + 1} exited (${code})`)); });
        w.unref();
        return slot;
      }));
      return pool;
    } catch (e) {
      console.warn('cpu3d: no worker threads, rendering on one thread:', e.message);
      return null;
    }
  }

  // Render one frame prepared by Renderer#_begin (geometry and, in high quality, shading). Frames run one after
  // the other in the order they were requested.
  frame(job) {
    const run = this._queue.then(() => this._frame(job));
    this._queue = run.catch(() => {});
    return run;
  }

  async _frame(job) {
    if (this.closed) throw new Error('render pool terminated');
    if (this.broken) throw this.broken;
    const msg = this._message(job), ctrl = this.ctrl;
    for (let i = 0; i < CTRL.SIZE; i++) Atomics.store(ctrl, i, 0);
    // watchdog: never let a stuck frame freeze the caller (threads waiting at a barrier see the abort flag)
    const watchdog = setTimeout(() => this._crash(null, new Error(`render frame took longer than ${this.timeout} ms`)), this.timeout);
    watchdog.unref?.();
    // Node: the threads keep the process alive only while a frame runs (released however the frame ends)
    for (const w of this.workers) w.hold?.(true);
    let results;
    try {
      results = await Promise.allSettled(this.workers.map((w, k) => new Promise((resolve, reject) => {
        w.pending = { resolve, reject };
        w.post({ ...msg, k });
      })));
    } finally {
      clearTimeout(watchdog);
      for (const w of this.workers) w.hold?.(false);
    }
    const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (errors.length) throw errors.find((e) => e.message !== 'frame aborted') ?? errors[0]; // the cause, not the echoes
    // raster statistics of all threads
    const c = this.counters, st = { drawn: 0, clipped: 0, pixels: 0 };
    for (let k = 0; k < this.size; k++) { st.drawn += c[k * 3]; st.clipped += c[k * 3 + 1]; st.pixels += c[k * 3 + 2]; }
    job.rasterStats = st;
    // per phase: the slowest thread (what the frame waited for) and the average (how evenly the work was spread)
    const pb = this.profileBuf, prof = {};
    PHASES.forEach((name, j) => {
      let max = 0, sum = 0;
      for (let k = 0; k < this.size; k++) { const v = pb[k * PHASES.length + j]; sum += v; if (v > max) max = v; }
      if (max > 0) prof[name] = [+max.toFixed(2), +(sum / this.size).toFixed(2)];
    });
    this.profile = prof;
  }

  // The message every thread gets: the job with geometry and textures replaced by ids, plus new uploads.
  _message(job) {
    const frame = ++this.frames, uploads = [];
    const id = (obj, kind) => {
      let i = this._ids.get(obj);
      if (!i) {
        i = this._nextId++;
        this._ids.set(obj, i);
        uploads.push([i, kind === 'geo' ? shareGeometry(obj) : shareTexture(obj)]);
      }
      const e = this._live.get(i);
      if (e) e.last = frame; else this._live.set(i, { obj, last: frame });
      return i;
    };
    const draws = job.draws.map((d) => ({ ...d, geo: id(d.geo, 'geo'), tex: d.tex ? id(d.tex, 'tex') : null }));
    if (frame % 60 === 0) {
      for (const [i, e] of this._live) {
        if (frame - e.last > KEEP_FRAMES) { this._live.delete(i); this._ids.delete(e.obj); this._drop.push(i); }
      }
    }
    // triangle chunks and their bins: one list per chunk and band group, as long as the chunk (worst case)
    const tchunks = triangleChunks(job.draws), nc = tchunks.length / 4, groups = this.size * GROUPS_PER_THREAD;
    const tris = nc ? tchunks[(nc - 1) * 4 + 3] + (tchunks[(nc - 1) * 4 + 2] - tchunks[(nc - 1) * 4 + 1]) / 3 : 0;
    if (!this._bins || this._bins.length < tris * groups) this._bins = new Uint32Array(new SharedArrayBuffer(Math.ceil(tris * 1.25 + 1024) * groups * 4));
    if (!this._binCount || this._binCount.length < nc * groups) this._binCount = new Int32Array(new SharedArrayBuffer(Math.ceil(nc * 1.25 + 64) * groups * 4));
    const sp = job.shadowPlan;
    const shadowPlan = sp && { ...sp, tasks: sp.tasks.map((t) => ({ ...t, casters: t.casters.map((c) => ({ ...c, geo: id(c.geo, 'geo') })) })) };
    const { _prep, draws: _, rasterStats, ...rest } = job;
    const drop = this._drop;
    this._drop = [];
    return {
      job: { ...rest, draws, shadowPlan, tchunks, groups, band: bandFor(job.H, groups), bins: this._bins, binCount: this._binCount },
      uploads, drop, n: this.size, ctrl: this.ctrl, counters: this.counters, profile: this.profileBuf,
    };
  }

  _reply(slot, m) {
    const p = slot.pending;
    slot.pending = null;
    if (!p) return;
    if (m.error) p.reject(new Error(m.error)); else p.resolve();
  }

  // A thread died or a frame hung: stop the others waiting, fail the frame and every later one.
  _crash(slot, err) {
    console.error('cpu3d:', err.message);
    this.broken ??= err;
    Atomics.store(this.ctrl, CTRL.ABORT, 1);
    Atomics.notify(this.ctrl, CTRL.GEN);
    for (const w of this.workers) if (w.pending) { const p = w.pending; w.pending = null; p.reject(err); }
  }

  terminate() {
    this.closed = true;
    for (const w of this.workers) {
      w.terminate();
      if (w.pending) { const p = w.pending; w.pending = null; p.reject(new Error('render pool terminated')); }
    }
  }
}

// kept for code written against the shading-only pool
export { RenderPool as ShadePool };

// copies into shared memory (no copy when the array already lives there)
function share(a) {
  if (!a) return null;
  if (typeof SharedArrayBuffer !== 'undefined' && a.buffer instanceof SharedArrayBuffer) return a;
  const s = new a.constructor(new SharedArrayBuffer(a.byteLength));
  s.set(a);
  return s;
}
const shareGeometry = (g) => ({ positions: share(g.positions), normals: share(g.normals), colors: share(g.colors), indices: share(g.indices), min: [...g.min] });
const shareTexture = (t) => ({ w: t.w, h: t.h, px: share(t.px) });

// Barrier for the n threads of a frame (sense by generation). Throws when the frame was aborted.
export function barrier(ctrl, n) {
  const gen = Atomics.load(ctrl, CTRL.GEN);
  if (Atomics.add(ctrl, CTRL.ARRIVE, 1) === n - 1) {
    Atomics.store(ctrl, CTRL.ARRIVE, 0);
    Atomics.add(ctrl, CTRL.GEN, 1);
    Atomics.notify(ctrl, CTRL.GEN);
    return;
  }
  while (Atomics.load(ctrl, CTRL.GEN) === gen) {
    if (Atomics.load(ctrl, CTRL.ABORT)) throw new Error('frame aborted');
    Atomics.wait(ctrl, CTRL.GEN, gen, 100);
  }
}
