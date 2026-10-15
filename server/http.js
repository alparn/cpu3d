// HTTP server: editor (static files), live sync (SSE), REST tools API and MCP (Streamable HTTP).
// Binds to localhost and rejects foreign Origin/Host headers (DNS rebinding protection).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { callTool, toolList, toolListOpenAI } from '../src/tools.js';
import { createMcpHandler } from './mcp.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.obj': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
const STATIC = ['/index.html', '/editor/', '/src/', '/demo/', '/examples/', '/docs/'];
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BODY = 64 * 1024 * 1024;

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('request body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// renderers: { render, renderSheet, saveGif } (see server/render.js), passed to the tools as context
export function createServer({ doc, root, version, ...renderers }) {
  const mcp = createMcpHandler({ doc, version, ...renderers });
  const sessions = new Map();
  const clients = new Set();

  const recent = []; // last activities, so a freshly opened editor shows what happened so far
  doc.on((ev) => {
    if (ev.activity) { recent.push(ev.activity); if (recent.length > 60) recent.shift(); }
    const payload = JSON.stringify(ev.type === 'change' ? { ...ev, scene: doc.data } : ev);
    for (const res of clients) res.write(`data: ${payload}\n\n`);
  });
  const keepAlive = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);
  keepAlive.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const host = req.headers.host || '';
    const origin = req.headers.origin;
    if (!LOCAL.test(host) || (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin))) {
      return json(res, 403, { error: 'forbidden origin' });
    }
    try {
      // ---- MCP, Streamable HTTP (JSON responses, no server-initiated stream)
      if (path === '/mcp') {
        if (req.method === 'DELETE') { sessions.delete(req.headers['mcp-session-id']); res.writeHead(200).end(); return; }
        if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST, DELETE' }).end(); return; }
        const body = await readBody(req);
        const msgs = Array.isArray(body) ? body : [body];
        const headers = {};
        let session;
        if (msgs.some((m) => m?.method === 'initialize')) {
          const sid = randomUUID();
          session = { client: req.headers['x-cpu3d-client'] };
          sessions.set(sid, session);
          headers['Mcp-Session-Id'] = sid;
        } else {
          const sid = req.headers['mcp-session-id'];
          session = sid ? sessions.get(sid) : { client: req.headers['x-cpu3d-client'] || 'agent' };
          if (!session) return json(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found, initialize again' } });
        }
        const out = (await Promise.all(msgs.map((m) => mcp(m, session)))).filter(Boolean);
        if (req.headers['x-cpu3d-client'] && session.client === 'agent') session.client = req.headers['x-cpu3d-client'];
        if (!out.length) { res.writeHead(202, headers).end(); return; }
        return json(res, 200, Array.isArray(body) ? out : out[0], headers);
      }

      // ---- REST
      if (path === '/api/health') return json(res, 200, { app: 'cpu3d', version, revision: doc.revision });
      if (path === '/api/scene' && req.method === 'GET') return json(res, 200, doc.summary());
      if (path === '/api/tools' && req.method === 'GET') {
        return json(res, 200, url.searchParams.get('format') === 'openai' ? toolListOpenAI() : toolList());
      }
      if (path.startsWith('/api/tools/') && req.method === 'POST') {
        const name = decodeURIComponent(path.slice('/api/tools/'.length));
        const args = await readBody(req);
        const result = await callTool(doc, name, args, { source: req.headers['x-cpu3d-client'] || 'http-agent', ...renderers });
        return json(res, result.isError ? 400 : 200, result);
      }
      if (path === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', revision: doc.revision, scene: doc.data, version, recent })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      // ---- static files
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      const rel = path === '/' ? '/index.html' : decodeURIComponent(path);
      const file = normalize(join(root, rel));
      if (!STATIC.some((p) => rel === p || (p.endsWith('/') && rel.startsWith(p))) || !file.startsWith(root + sep)) {
        return json(res, 404, { error: 'not found' });
      }
      const data = await readFile(file).catch(() => null);
      if (!data) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
  server.on('close', () => clearInterval(keepAlive));
  return server;
}
