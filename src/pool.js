// A pool of shading workers. The renderer rasterizes on the calling thread, then the pool shades
// the frame in parallel: rows are cut into chunks of 8 AO block rows (16 pixel rows) that are dealt
// out round-robin, so expensive parts of the image (reflective objects, sky) spread evenly.
// Needs SharedArrayBuffer: always there in Node; in browsers only on cross-origin isolated pages.
const CHUNK = 8;

export class ShadePool {
  constructor(workers) {
    this.workers = workers; // [{ send(msg), queue: [resolve, ...] }]
    this.size = workers.length;
    this.seq = 0;
  }

  // Returns null when threads are not available (the renderer then shades on its own thread).
  static async create({ threads } = {}) {
    if (typeof SharedArrayBuffer === 'undefined') return null;
    const url = new URL('./shade-worker.js', import.meta.url);
    const isNode = typeof process !== 'undefined' && !!process.versions?.node;
    try {
      if (!isNode) {
        if (!globalThis.crossOriginIsolated || typeof Worker === 'undefined') return null;
        const n = threads ?? Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
        return new ShadePool(Array.from({ length: n }, () => {
          const w = new Worker(url, { type: 'module' }), slot = { queue: [], send: (m) => w.postMessage(m), terminate: () => w.terminate() };
          w.onmessage = () => slot.queue.shift()?.();
          w.onerror = (e) => { console.error('cpu3d shade worker:', e.message); slot.queue.splice(0).forEach((r) => r()); };
          return slot;
        }));
      }
      const { Worker: NodeWorker } = await import('node:worker_threads');
      const os = await import('node:os');
      const n = threads ?? Math.min(8, Math.max(2, (os.availableParallelism?.() ?? os.cpus().length) - 1));
      return new ShadePool(Array.from({ length: n }, () => {
        // referenced only while it has work, so an idle pool does not keep the process alive
        const w = new NodeWorker(url), slot = { queue: [], send: (m) => { w.ref(); w.postMessage(m); }, terminate: () => w.terminate() };
        w.on('message', () => { slot.queue.shift()?.(); if (!slot.queue.length) w.unref(); });
        w.on('error', (e) => { console.error('cpu3d shade worker:', e.message); slot.queue.splice(0).forEach((r) => r()); });
        w.unref();
        return slot;
      }));
    } catch (e) {
      console.warn('cpu3d: no worker threads, shading on one thread:', e.message);
      return null;
    }
  }

  // Shade one frame prepared by Renderer#_begin: AO, then blur + lighting, then the post stage.
  async shade(ctx) {
    const { _prep, ...job } = ctx;
    const blocks = (ctx.H + 1) >> 1, n = this.size, chunks = Array.from({ length: n }, () => []);
    for (let b = 0, k = 0; b < blocks; b += CHUNK, k++) chunks[k % n].push([b, Math.min(blocks, b + CHUNK)]);
    const id = ++this.seq;
    let first = true;
    const phase = (name) => {
      const p = Promise.all(this.workers.map((w, k) => new Promise((resolve) => {
        w.queue.push(resolve);
        w.send({ id, phase: name, chunks: chunks[k], job: first ? job : undefined });
      })));
      first = false;
      return p;
    };
    if (ctx.ao) await phase('ao');
    await phase('shade');
    await phase('post');
  }

  terminate() { for (const w of this.workers) w.terminate(); }
}
