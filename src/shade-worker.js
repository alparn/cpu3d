// Shading worker: runs the row-range stages of lighting.js on its share of the frame.
// Works as a browser module worker and as a Node worker thread; all big buffers are shared memory.
import { aoRows, blurRows, shadeRows, atmosphereRows, accumulateRows, temporalRows } from './lighting.js';

let job = null;

function run(m) {
  if (m.job) job = m.job;
  const H = job.H;
  for (const [b0, b1] of m.chunks) {
    const y0 = Math.min(H, b0 * 2), y1 = Math.min(H, b1 * 2);
    if (m.phase === 'ao') aoRows(job, b0, b1);
    else if (m.phase === 'shade') {
      if (job.ao) blurRows(job, b0, b1);
      shadeRows(job, y0, y1);
      if (job.atmos) atmosphereRows(job, y0, y1);
    } else if (job.post === 'accumulate') accumulateRows(job, y0, y1);
    else temporalRows(job, y0, y1);
  }
  return { id: m.id, phase: m.phase };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof process === 'undefined') {
  self.onmessage = (e) => self.postMessage(run(e.data));
} else {
  const { parentPort } = await import('node:worker_threads');
  parentPort.on('message', (m) => parentPort.postMessage(run(m)));
}
