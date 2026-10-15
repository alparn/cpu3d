// Model Context Protocol (JSON-RPC 2.0) without dependencies. Transport agnostic:
// used by the stdio transport (bin/cpu3d.js mcp) and the Streamable HTTP endpoint (/mcp).
import { callTool, toolList, AGENT_GUIDE } from '../src/tools.js';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// session: mutable object per connection, remembers the client name for the activity feed
export function createMcpHandler({ doc, render, version }) {
  return async function handle(msg, session = {}) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return err(msg?.id, -32600, 'Invalid Request');
    if (typeof msg.method !== 'string') return null; // a response from the client, nothing to do
    const { id, method, params = {} } = msg;
    const notification = id === undefined;
    try {
      switch (method) {
        case 'initialize':
          session.client = params.clientInfo?.name || 'agent';
          return ok(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'cpu3d', title: 'cpu3d - agentic 3D modeling', version },
            instructions: AGENT_GUIDE,
          });
        case 'ping':
          return notification ? null : ok(id, {});
        case 'tools/list':
          return ok(id, { tools: toolList() });
        case 'tools/call':
          return ok(id, await callTool(doc, params.name, params.arguments, { source: session.client || 'agent', render }));
        default:
          return notification ? null : err(id, -32601, `Method not found: ${method}`);
      }
    } catch (e) {
      return notification ? null : err(id, -32603, e.message);
    }
  };
}
