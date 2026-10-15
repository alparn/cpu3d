import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SceneDocument } from '../src/document.js';
import { createServer } from '../server/http.js';
import { renderBase64 } from '../server/render.js';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const render = async (d, o) => renderBase64(d, o);

async function withServer(fn) {
  const doc = new SceneDocument();
  const server = createServer({ doc, root, version: 'test', render });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, doc); } finally { server.closeAllConnections?.(); server.close(); }
}

const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('MCP over Streamable HTTP: initialize, list, call, sessions', async () => {
  await withServer(async (base, doc) => {
    const init = await post(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } });
    const sid = init.headers.get('mcp-session-id');
    assert.ok(sid);
    assert.equal((await init.json()).result.serverInfo.name, 'cpu3d');
    const h = { 'Mcp-Session-Id': sid };
    assert.equal((await post(`${base}/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' }, h)).status, 202);
    const list = await (await post(`${base}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, h)).json();
    assert.ok(list.result.tools.some((t) => t.name === 'render_view'));

    const seen = [];
    doc.on((e) => e.activity && seen.push(e.activity.source));
    const call = await (await post(`${base}/mcp`, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_objects', arguments: { objects: [{ shape: { type: 'box' } }] } } }, h)).json();
    assert.equal(call.result.isError, undefined);
    assert.equal(doc.data.objects.length, 1);
    assert.deepEqual(seen, ['claude-code'], 'activity is attributed to the MCP client');

    assert.equal((await post(`${base}/mcp`, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { 'Mcp-Session-Id': 'nope' })).status, 404);
  });
});

test('REST tools API and origin protection', async () => {
  await withServer(async (base) => {
    const tools = await (await fetch(`${base}/api/tools?format=openai`)).json();
    assert.equal(tools[0].type, 'function');
    const r = await post(`${base}/api/tools/add_objects`, { objects: [{ shape: { type: 'sphere' } }] }, { 'X-Cpu3d-Client': 'my-agent' });
    assert.equal(r.status, 200);
    assert.equal((await post(`${base}/api/tools/add_objects`, { objects: [] })).status, 400);
    assert.equal((await post(`${base}/mcp`, {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 200);
  });
});

test('MCP over stdio (standalone process)', async () => {
  const child = spawn(process.execPath, [`${root}/bin/cpu3d.js`, 'mcp', '--port', '0', '--quiet'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(...d.toString().split('\n').filter(Boolean)));
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_objects', arguments: { objects: [{ shape: { type: 'torus' } }] } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'render_view', arguments: { width: 64, height: 64 } } },
  ];
  child.stdin.end(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  await new Promise((ok) => child.on('exit', ok));
  const res = lines.map((l) => JSON.parse(l));
  assert.deepEqual(res.map((r) => r.id), [1, 2, 3]);
  assert.equal(res[2].result.content[0].type, 'image');
});
