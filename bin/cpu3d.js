#!/usr/bin/env node
// cpu3d command line: editor server, MCP stdio bridge and headless rendering.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { SceneDocument } from '../src/document.js';
import { createServer } from '../server/http.js';
import { createMcpHandler } from '../server/mcp.js';
import { renderPNG, renderBase64, preloadTextures } from '../server/render.js';
import { frameBounds, unionBounds } from '../src/scene.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const HELP = `cpu3d ${VERSION} - agentic 3D modeling with a CPU renderer

Usage
  cpu3d serve  [--port 8173] [--file scene.json] [--example name] [--empty]   start the editor + MCP endpoint
               examples: showcase, castle, chess, station, city, garden, lighthouse
  cpu3d mcp    [--port 8173] [--file scene.json]                    MCP over stdio (Claude Desktop, Cursor, ...)
  cpu3d render <scene.json> <out.png> [--width 1280] [--height 720] [--yaw deg] [--pitch deg] [--distance d]
                                      [--focus all] [--shading gouraud|flat|normals] [--wireframe]
                                      [--quality high|fast] [--samples 16] [--time seconds]

Connect an agent while "serve" runs
  Claude Code   claude mcp add --transport http cpu3d http://localhost:8173/mcp
  Other agents  GET /api/tools?format=openai  and  POST /api/tools/<name>
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2), next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else { opts[key] = next; i++; }
    } else opts._.push(a);
  }
  return opts;
}

const log = (...a) => console.error('[cpu3d]', ...a); // stdout belongs to MCP in stdio mode

function openDocument(opts) {
  let data = null;
  if (opts.file && existsSync(opts.file)) data = JSON.parse(readFileSync(opts.file, 'utf8'));
  else if (opts.example && opts.example !== true) data = JSON.parse(readFileSync(join(ROOT, 'examples', `${opts.example}.json`), 'utf8'));
  const doc = new SceneDocument(data);
  if (!opts.quiet) {
    doc.on((ev) => {
      if (ev.activity && ev.activity.source !== 'you') log(`${ev.activity.source} · ${ev.activity.tool} · ${ev.activity.summary}`);
    });
  }
  if (opts.file) {
    let timer = null;
    doc.on((ev) => {
      if (ev.type !== 'change') return;
      clearTimeout(timer);
      timer = setTimeout(() => writeFileSync(opts.file, JSON.stringify(doc.data, null, 2)), 300);
    });
    log(`scene file: ${resolve(opts.file)} (autosave)`);
  }
  return doc;
}

function listen(server, port, host) {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => { server.off('error', fail); ok(server.address().port); });
  });
}

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return (await r.json()).app === 'cpu3d';
  } catch { return false; }
}

const render = async (doc, o) => renderBase64(doc, o);

async function serve(opts) {
  const port = Number(opts.port ?? process.env.PORT ?? 8173), host = opts.host || '127.0.0.1';
  // the editor starts with a gallery scene unless a scene file is given or --empty is set
  if (!opts.file && !opts.example && !opts.empty) opts.example = 'showcase';
  const doc = openDocument(opts);
  const server = createServer({ doc, root: ROOT, version: VERSION, render });
  const actual = await listen(server, port, host).catch((e) => {
    log(e.code === 'EADDRINUSE' ? `port ${port} is already in use, try --port ${port + 1}` : e.message);
    process.exit(1);
  });
  const url = `http://localhost:${actual}`;
  console.log(`\n  cpu3d ${VERSION}\n\n  Editor        ${url}\n  MCP (HTTP)    ${url}/mcp\n  Tools (REST)  ${url}/api/tools\n\n  Claude Code:  claude mcp add --transport http cpu3d ${url}/mcp\n`);
}

// stdio MCP. If an editor server is already running on the port, forward to it so the agent edits
// the scene that is open in the browser. Otherwise start the editor server in this process.
async function mcpStdio(opts) {
  const port = Number(opts.port ?? process.env.PORT ?? 8173);
  let handle;
  if (await probe(port)) {
    log(`forwarding to the running editor at http://localhost:${port}`);
    let sessionId = null, client = 'agent';
    handle = async (msg) => {
      if (msg?.method === 'initialize') client = msg.params?.clientInfo?.name || client;
      const headers = { 'Content-Type': 'application/json', 'X-Cpu3d-Client': client };
      if (sessionId) headers['Mcp-Session-Id'] = sessionId;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(msg) });
        sessionId = r.headers.get('mcp-session-id') || sessionId;
        return r.status === 202 ? null : await r.json();
      } catch (e) {
        return msg?.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `editor server not reachable: ${e.message}` } };
      }
    };
  } else {
    const doc = openDocument(opts);
    const mcp = createMcpHandler({ doc, render, version: VERSION });
    const session = {};
    handle = (msg) => mcp(msg, session);
    const server = createServer({ doc, root: ROOT, version: VERSION, render });
    await listen(server, port, '127.0.0.1')
      .then((p) => log(`editor running at http://localhost:${p} - open it to watch live`))
      .catch((e) => log(`editor not started (${e.code || e.message}), running headless`));
  }

  // messages are handled strictly in order; on EOF we finish pending work before exiting
  let queue = Promise.resolve();
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg;
      try { msg = JSON.parse(line); } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        return;
      }
      const msgs = Array.isArray(msg) ? msg : [msg];
      const out = [];
      for (const m of msgs) { const r = await handle(m); if (r) out.push(r); }
      if (out.length) process.stdout.write(JSON.stringify(Array.isArray(msg) ? out : out[0]) + '\n');
    });
  });
  rl.on('close', () => queue.then(() => process.exit(0)));
}

async function renderCli(opts) {
  const [input, output = 'render.png'] = opts._.slice(1);
  if (!input) { console.error(HELP); process.exit(1); }
  const doc = new SceneDocument(JSON.parse(readFileSync(input, 'utf8')));
  let camera = { ...doc.data.camera };
  if (opts.focus) camera = { ...camera, ...frameBounds(unionBounds(doc.data.objects.filter((o) => o.visible).map((o) => doc.bounds(o))), camera) };
  if (opts.yaw !== undefined) camera.yaw = +opts.yaw;
  if (opts.pitch !== undefined) camera.pitch = +opts.pitch;
  if (opts.distance !== undefined) camera.distance = +opts.distance;
  const t0 = performance.now();
  await preloadTextures(doc);
  const png = renderPNG(doc, { width: +(opts.width ?? 1280), height: +(opts.height ?? 720), camera, shading: opts.shading || 'gouraud', wireframe: !!opts.wireframe,
    quality: opts.quality || 'high', samples: +(opts.samples ?? 16), time: +(opts.time ?? 0) });
  writeFileSync(output, png);
  log(`${output} written (${(performance.now() - t0).toFixed(1)} ms incl. PNG encoding)`);
}

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0];
if (opts.version) console.log(VERSION);
else if (cmd === 'serve') serve(opts);
else if (cmd === 'mcp') mcpStdio(opts);
else if (cmd === 'render') renderCli(opts);
else { console.log(HELP); if (cmd && cmd !== 'help') process.exit(1); }
