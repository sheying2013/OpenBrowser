'use strict';

/**
 * Minimal stdio MCP server for OpenBrowser Local API.
 * Protocol subset: initialize, tools/list, tools/call (JSON-RPC 2.0 over NDJSON/stdio).
 *
 * Run standalone:
 *   OPENBROWSER_API_PORT=50325 node automation/mcp-server.js
 *
 * Cursor / Claude Desktop config example:
 * {
 *   "mcpServers": {
 *     "openbrowser-local-api": {
 *       "command": "node",
 *       "args": ["/path/to/Browserapp/automation/mcp-server.js"],
 *       "env": { "OPENBROWSER_API_PORT": "50325", "OPENBROWSER_API_KEY": "" }
 *     }
 *   }
 * }
 */

const http = require('http');

const PORT = Number(process.env.OPENBROWSER_API_PORT || process.env.PORT || 50325);
const HOST = process.env.OPENBROWSER_API_HOST || '127.0.0.1';
const API_KEY = process.env.OPENBROWSER_API_KEY || process.env.API_KEY || '';

function request(method, path, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST,
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { 'api-key': API_KEY } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch (error) {
          reject(new Error(`Invalid JSON from Local API: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Local API timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'list_profiles',
    description: 'List browser profiles and running status (debug ports)',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'start_profile',
    description: 'Start a browser profile by id',
    inputSchema: {
      type: 'object',
      properties: { profile_id: { type: 'string' } },
      required: ['profile_id'],
    },
  },
  {
    name: 'stop_profile',
    description: 'Stop a browser profile by id',
    inputSchema: {
      type: 'object',
      properties: { profile_id: { type: 'string' } },
      required: ['profile_id'],
    },
  },
  {
    name: 'list_active_browsers',
    description: 'List currently active browser profiles',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'window_sync_start',
    description: 'Start multi-window sync. First profile is master.',
    inputSchema: {
      type: 'object',
      properties: {
        profile_ids: { type: 'array', items: { type: 'string' } },
        operate: { type: 'string', description: 'comma list: click,move,scroll,keyboard' },
      },
      required: ['profile_ids'],
    },
  },
  {
    name: 'window_sync_stop',
    description: 'Stop multi-window sync',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'window_sync_status',
    description: 'Get window sync status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'rpa_run_steps',
    description: 'Run RPA steps on a running profile (goto/click/type/wait/scroll/evaluate/...)',
    inputSchema: {
      type: 'object',
      properties: {
        profile_id: { type: 'string' },
        steps: { type: 'array', items: { type: 'object' } },
        name: { type: 'string' },
      },
      required: ['profile_id', 'steps'],
    },
  },
  {
    name: 'rpa_status',
    description: 'Get RPA engine status',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'rpa_stop',
    description: 'Stop RPA task(s)',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
    },
  },
  {
    name: 'list_applications',
    description: 'List application center apps (team / recommended / local)',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'team | recommended | local | all' },
        q: { type: 'string' },
      },
    },
  },
  {
    name: 'get_fingerprint',
    description: 'Get deterministic fingerprint config for a profile id',
    inputSchema: {
      type: 'object',
      properties: { profile_id: { type: 'string' } },
      required: ['profile_id'],
    },
  },
  {
    name: 'isolation_audit',
    description: 'Audit multi-open isolation (user-data-dir / CDP port collisions)',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case 'list_profiles':
      return request('GET', '/api/v1/user/list');
    case 'start_profile':
      return request('POST', '/api/v1/browser/start', { user_id: args.profile_id });
    case 'stop_profile':
      return request('POST', '/api/v1/browser/stop', { user_id: args.profile_id });
    case 'list_active_browsers':
      return request('GET', '/api/v1/browser/active');
    case 'window_sync_start':
      return request('POST', '/api/sync/start', {
        profile_ids: args.profile_ids,
        operate: args.operate,
      });
    case 'window_sync_stop':
      return request('POST', '/api/sync/stop', {});
    case 'window_sync_status':
      return request('GET', '/api/sync/status');
    case 'rpa_run_steps':
      return request('POST', '/api/rpa/run', {
        profile_id: args.profile_id,
        steps: args.steps,
        name: args.name || 'mcp-rpa',
      });
    case 'rpa_status':
      return request('GET', '/api/rpa/status');
    case 'rpa_stop':
      return request('POST', '/api/rpa/stop', { task_id: args.task_id });
    case 'list_applications': {
      const params = new URLSearchParams();
      if (args.tab) params.set('tab', args.tab);
      if (args.q) params.set('q', args.q);
      const qs = params.toString();
      return request('GET', '/api/v1/application/list' + (qs ? '?' + qs : ''));
    }
    case 'get_fingerprint':
      return request('GET', '/api/fingerprint?profile_id=' + encodeURIComponent(args.profile_id || ''));
    case 'isolation_audit':
      return request('GET', '/api/isolation/audit');
    default:
      throw new Error('Unknown tool: ' + name);
  }
}

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handleRpc(message) {
  const id = message.id;
  const method = message.method;
  const params = message.params || {};

  try {
    if (method === 'initialize') {
      return writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'openbrowser-local-api-mcp', version: '1.0.0' },
        },
      });
    }
    if (method === 'notifications/initialized' || method === 'initialized') {
      return;
    }
    if (method === 'tools/list') {
      return writeMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    }
    if (method === 'tools/call') {
      const name = params.name;
      const args = params.arguments || {};
      const data = await callTool(name, args);
      return writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: data && data.code !== 0 && data.code !== undefined,
        },
      });
    }
    if (method === 'ping') {
      return writeMessage({ jsonrpc: '2.0', id, result: {} });
    }
    return writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found: ' + method },
    });
  } catch (error) {
    if (id === undefined) return;
    return writeMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: error.message || String(error) },
    });
  }
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        continue;
      }
      handleRpc(message);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { TOOLS, callTool, request };
