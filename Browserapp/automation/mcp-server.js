'use strict';

/**
 * Full-control stdio MCP server for OpenBrowser.
 *
 * Permission model:
 *   admin  - every tool, including API key / permission policy changes
 *   manage - profile CRUD, proxy library, extensions, sync, RPA plans/templates
 *   run    - start/stop profiles, run sync/RPA, assign extensions
 *   read   - list/status/fingerprint/audit/get operations
 *
 * Env overrides:
 *   OPENBROWSER_MCP_MODE=admin|manage|run|read
 *   OPENBROWSER_MCP_TOOL_BLACKLIST=json array of tool names
 *   OPENBROWSER_MCP_TOOL_WHITELIST=json array of tool names
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.OPENBROWSER_API_PORT || process.env.PORT || 50325);
const HOST = process.env.OPENBROWSER_API_HOST || '127.0.0.1';

function cleanApiKey(value) {
  let key = String(value || '').trim();
  if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1).trim();
  if (key.startsWith("'") && key.endsWith("'")) key = key.slice(1, -1).trim();
  return key;
}

function loadApiKey() {
  const configured = cleanApiKey(process.env.OPENBROWSER_API_KEY || process.env.API_KEY);
  if (configured) return configured;

  const candidates = [
    process.env.OPENBROWSER_API_KEY_FILE,
    process.env.OPENBROWSER_LOCAL_API_KEY_FILE,
    process.env.API_KEY_FILE,
    process.env.OPENBROWSER_USER_DATA ? path.join(process.env.OPENBROWSER_USER_DATA, 'local-api-key.txt') : '',
  ].filter(Boolean);
  for (const filePath of candidates) {
    try {
      const key = cleanApiKey(fs.readFileSync(filePath, 'utf8'));
      if (key) return key;
    } catch (_) {}
  }
  return '';
}

const API_KEY = loadApiKey();
let MCP_MODE = ['admin', 'manage', 'run', 'read'].includes(String(process.env.OPENBROWSER_MCP_MODE || 'admin').toLowerCase())
  ? String(process.env.OPENBROWSER_MCP_MODE || 'admin').toLowerCase()
  : 'admin';
let TOOL_BLACKLIST = parseJsonEnv(process.env.OPENBROWSER_MCP_TOOL_BLACKLIST, []);
let TOOL_WHITELIST = parseJsonEnv(process.env.OPENBROWSER_MCP_TOOL_WHITELIST, []);

const LEVEL_ORDER = { read: 1, run: 2, manage: 3, admin: 4 };

function parseJsonEnv(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : fallback;
  } catch (_) {
    return fallback;
  }
}

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
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data || '{}'); }
        catch (_) { return reject(new Error(`Invalid JSON from Local API (HTTP ${res.statusCode}): ${data.slice(0, 200)}`)); }
        if (res.statusCode === 401) return reject(new Error('MCP: Local API rejected the API key (401). Set OPENBROWSER_API_KEY or OPENBROWSER_API_KEY_FILE to the key shown on the OpenBrowser API & MCP page.'));
        if (res.statusCode >= 400) return reject(new Error(`Local API error (HTTP ${res.statusCode}): ${parsed.msg || parsed.message || res.statusCode}`));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Local API timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function toolsMeta() {
  return [
    // system
    ['status', 'Get OpenBrowser runtime status, profile count, active sync and RPA state', { type: 'object', properties: {}, additionalProperties: false }, 'read', 'GET', '/', null],
    ['mcp_policy', 'Get the current MCP permission policy: mode, level, blacklist, whitelist and effective tools', { type: 'object', properties: {}, additionalProperties: false }, 'read', 'GET', '/', null],
    ['mcp_update_policy', 'Update MCP permission policy. All changes require an admin-level MCP mode and are ephemeral for the running MCP process', { type: 'object', properties: { mode: { type: 'string', enum: ['admin', 'manage', 'run', 'read'], description: 'Effective permission level' }, tool_blacklist: { type: 'array', items: { type: 'string' }, description: 'Tool names to disable' }, tool_whitelist: { type: 'array', items: { type: 'string' }, description: 'Only these tools remain enabled' } }, additionalProperties: false }, 'admin', 'POST', '/', null],
    ['check_api_key', 'Verify the API key configured for this MCP process without exposing the key', { type: 'object', properties: {}, additionalProperties: false }, 'read', 'GET', '/', null],
    ['list_extensions', 'List installed browser extensions and their assigned profiles', { type: 'object', properties: {}, additionalProperties: false }, 'read', 'GET', '/api/extension/list', null],
    ['list_applications', 'List Application Center apps', { type: 'object', properties: { tab: { type: 'string', enum: ['team', 'recommended', 'local', 'all'] }, q: { type: 'string' } }, additionalProperties: false }, 'read', 'GET', '/api/v1/application/list', null],
    ['get_fingerprint', 'Get the deterministic fingerprint configuration for a profile', { type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id'], additionalProperties: false }, 'read', 'GET', '/api/fingerprint', null],
    ['fingerprint_set', 'Set fingerprint overrides for a profile. Values are persisted and applied on the next launch', { type: 'object', properties: {
      profile_id: { type: 'string' },
      fingerprint: { type: 'object', description: 'Direct privacy.fingerprint overrides: canvasId, audioId, clientRectsId, webglVendor, webglRenderer, hardwareConcurrency, deviceMemory, clientHints, etc.' },
      os: { type: 'string' },
      user_agent: { type: 'string' },
      resolution: { type: 'string', description: 'For example 1920x1080' },
      hardware_concurrency: { type: 'integer' },
      device_memory: { type: 'integer' },
      webgl_vendor: { type: 'string' },
      webgl_renderer: { type: 'string' },
      timezone: { type: 'string', description: 'IANA timezone such as Asia/Shanghai' },
      locale: { type: 'string' },
    }, required: ['profile_id'], additionalProperties: false }, 'manage', 'POST', '/api/v2/browser-profile/update', null],
    ['fingerprint_reset', 'Clear fingerprint overrides so the profile returns to its deterministic generated fingerprint', { type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id'], additionalProperties: false }, 'manage', 'POST', '/api/v2/browser-profile/update', null],
    ['fingerprint_regenerate', 'Enable per-launch fingerprint refresh for a profile (requires stability mode off), so every next launch gets a new fingerprint', { type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id'], additionalProperties: false }, 'manage', 'POST', '/api/v2/browser-profile/update', null],
    ['isolation_audit', 'Audit isolation collisions (user-data dirs and CDP ports)', { type: 'object', properties: {}, additionalProperties: false }, 'read', 'GET', '/api/isolation/audit', null],
    ['window_sync_settings_get', 'Get current multi-window sync settings', { type: 'object', properties: {}, additionalProperties: false }, 'read', 'GET', '/api/sync/settings', null],
    ['rpa_plans_list', 'List saved RPA plans', { type: 'object', properties: {}, additionalProperties: false }, 'read', 'GET', '/api/rpa/plans', null],
    ['rpa_tasks_list', 'List RPA tasks', { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false }, 'read', 'GET', '/api/rpa/tasks', null],
    ['rpa_task_result', 'Get one RPA task by id, including process_result (variables / exports / remarks) and persisted logs', { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false }, 'read', 'GET', '/api/rpa/tasks/', null],
    ['rpa_tasks', 'List RPA tasks newest first (optionally filtered by status)', { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false }, 'read', 'GET', '/api/rpa/tasks', null],
    ['rpa_templates_list', 'List RPA templates and categories', { type: 'object', properties: { category: { type: 'string' } }, additionalProperties: false }, 'read', 'GET', '/api/rpa/templates', null],
    ['proxy_list', 'List proxy library entries', { type: 'object', properties: { q: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false }, 'read', 'GET', '/api/proxy/list', null],
    ['list_profiles', 'List browser profiles, running status and CDP debug ports', { type: 'object', properties: {}, additionalProperties: false }, 'read', 'GET', '/api/v1/user/list', null],
    ['list_active_browsers', 'List currently active browser profiles', { type: 'object', properties: {}, additionalProperties: false }, 'read', 'GET', '/api/v1/browser/active', null],
    ['window_sync_status', 'Get multi-window sync status', { type: 'object', properties: {}, additionalProperties: false }, 'read', 'GET', '/api/sync/status', null],
    ['rpa_status', 'Get RPA engine status and running tasks', { type: 'object', properties: {}, additionalProperties: false }, 'read', 'GET', '/api/rpa/status', null],
    // profiles
    ['create_profile', 'Create a browser environment with OS/UA/window/fingerprint/privacy/start URL settings', { type: 'object', properties: {
      profile_id: { type: 'string', description: 'Optional explicit id. Generated when omitted.' },
      name: { type: 'string', description: 'Environment display name' },
      number: { type: 'integer' },
      language: { type: 'string', description: 'Locale such as en-US or zh-CN' },
      proxy: { type: 'string', description: 'proxy://user:pass@host:port or Direct' },
      start_url: { type: 'string', description: 'Page opened when the profile starts' },
      os: { type: 'string' }, platform: { type: 'string' }, browser: { type: 'string' },
      user_agent: { type: 'string' }, resolution: { type: 'string' }, window_size: { type: 'string' },
      timezone: { type: 'string' }, locale: { type: 'string' }, language_code: { type: 'string' },
      geolocation: { type: 'string' }, webgl_vendor: { type: 'string' }, webgl_renderer: { type: 'string' },
      hardware_concurrency: { type: 'integer' }, device_memory: { type: 'integer' },
      do_not_track: { type: 'boolean' }, privacy_extra: { type: 'object' }, notes: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      user_proxy_config: { type: 'object', description: 'Structured proxy config' },
      fingerprint: { type: 'object', description: 'Override fingerprint values (generated deterministically when omitted)' },
    }, additionalProperties: false }, 'manage', 'POST', '/api/v1/user/create', null],
    ['update_profile', 'Update an existing browser environment (stops nothing; profile persists)', { type: 'object', properties: {
      profile_id: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' }, number: { type: 'integer' },
      language: { type: 'string' }, proxy: { type: 'string' }, network_mode: { type: 'string' }, start_url: { type: 'string' },
      os: { type: 'string' }, platform: { type: 'string' }, browser: { type: 'string' }, user_agent: { type: 'string' },
      resolution: { type: 'string' }, window_size: { type: 'string' }, timezone: { type: 'string' }, locale: { type: 'string' },
      language_code: { type: 'string' }, geolocation: { type: 'string' }, webgl_vendor: { type: 'string' },
      webgl_renderer: { type: 'string' }, hardware_concurrency: { type: 'integer' }, device_memory: { type: 'integer' },
      do_not_track: { type: 'boolean' }, privacy_extra: { type: 'object' }, notes: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      fingerprint: { type: 'object' }, user_proxy_config: { type: 'object' },
    }, required: ['profile_id'], additionalProperties: false }, 'manage', 'POST', '/api/v2/browser-profile/update', null],
    ['delete_profiles', 'Delete one or more browser environments and optionally their data directories', { type: 'object', properties: {
      profile_ids: { type: 'array', items: { type: 'string' } }, delete_data: { type: 'boolean', description: 'Default true' },
    }, required: ['profile_ids'], additionalProperties: false }, 'manage', 'POST', '/api/v1/user/delete', null],
    ['duplicate_profile', 'Clone an existing browser environment. Cookies, credentials and exit detection results are not copied', { type: 'object', properties: {
      source_profile_id: { type: 'string' }, name: { type: 'string' }, start_url: { type: 'string' },
    }, required: ['source_profile_id'], additionalProperties: false }, 'manage', 'POST', '/api/v2/browser-profile/duplicate', null],
    ['start_profile', 'Start a browser profile by id', { type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id'], additionalProperties: false }, 'run', 'POST', '/api/v1/browser/start', null],
    ['stop_profile', 'Stop a browser profile by id', { type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id'], additionalProperties: false }, 'run', 'POST', '/api/v1/browser/stop', null],
    ['stop_all_profiles', 'Stop every running browser profile', { type: 'object', properties: {}, additionalProperties: false }, 'run', 'POST', '/api/v1/browser/stop-all', null],
    ['check_profile_proxy', 'Check and persist the exit IP/country/timezone for an existing profile', { type: 'object', properties: { profile_id: { type: 'string' } }, required: ['profile_id'], additionalProperties: false }, 'run', 'POST', '/api/proxy/check-profile', null],
    // proxy library
    ['proxy_create', 'Add a proxy entry to the proxy library', { type: 'object', properties: {
      raw: { type: 'string', description: 'proxy://user:pass@host:port' }, name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      group: { type: 'string' }, note: { type: 'string' }, ip_channel: { type: 'string' },
    }, required: ['raw'], additionalProperties: false }, 'manage', 'POST', '/api/proxy/create', null],
    ['proxy_create_many', 'Batch import proxy entries', { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } }, required: ['data'], additionalProperties: false }, 'manage', 'POST', '/api/proxy/create', null],
    ['proxy_update', 'Update a proxy library entry', { type: 'object', properties: { proxy_id: { type: 'string' }, raw: { type: 'string' }, name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, group: { type: 'string' }, note: { type: 'string' }, ip_channel: { type: 'string' } }, required: ['proxy_id'], additionalProperties: false }, 'manage', 'POST', '/api/proxy/update', null],
    ['proxy_delete', 'Delete proxy library entries', { type: 'object', properties: { proxy_ids: { type: 'array', items: { type: 'string' } } }, required: ['proxy_ids'], additionalProperties: false }, 'manage', 'POST', '/api/proxy/delete', null],
    ['proxy_check', 'Test a proxy raw string or library entry and return exit network details', { type: 'object', properties: { proxy: { type: 'string' }, proxy_id: { type: 'string' }, ip_channel: { type: 'string' } }, additionalProperties: false }, 'run', 'POST', '/api/proxy/check', null],
    // extensions
    ['extension_assign', 'Assign or remove an extension for profiles', { type: 'object', properties: {
      extension_id: { type: 'string' }, profile_ids: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean', description: 'Default true' },
    }, required: ['extension_id', 'profile_ids'], additionalProperties: false }, 'run', 'POST', '/api/extension/assign', null],
    // sync
    ['window_sync_start', 'Start multi-window sync. First profile is master', { type: 'object', properties: {
      profile_ids: { type: 'array', items: { type: 'string' } }, operate: { type: 'string', description: 'comma list: click,move,scroll,keyboard' },
      tile: { type: 'boolean' }, cascade: { type: 'boolean' }, settings: { type: 'object' },
    }, required: ['profile_ids'], additionalProperties: false }, 'run', 'POST', '/api/sync/start', null],
    ['window_sync_stop', 'Stop multi-window sync', { type: 'object', properties: {}, additionalProperties: false }, 'run', 'POST', '/api/sync/stop', null],
    ['window_sync_restart', 'Restart multi-window sync', { type: 'object', properties: {}, additionalProperties: false }, 'run', 'POST', '/api/sync/restart', null],
    ['window_sync_arrange', 'Arrange windows in tile or cascade mode', { type: 'object', properties: { profile_ids: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['tile', 'cascade'] } }, additionalProperties: false }, 'run', 'POST', '/api/sync/arrange', null],
    ['window_sync_settings_update', 'Update multi-window sync settings', { type: 'object', properties: { settings: { type: 'object' } }, required: ['settings'], additionalProperties: false }, 'manage', 'POST', '/api/sync/settings', null],
    // RPA
    ['rpa_run_steps', 'Run RPA steps on a running profile', { type: 'object', properties: {
      profile_id: { type: 'string' }, steps: { type: 'array', items: { type: 'object' } }, name: { type: 'string' },
    }, required: ['profile_id', 'steps'], additionalProperties: false }, 'run', 'POST', '/api/rpa/run', null],
    ['rpa_run_plan', 'Run a saved RPA plan', { type: 'object', properties: { plan_id: { type: 'string' }, name: { type: 'string' } }, required: ['plan_id'], additionalProperties: false }, 'run', 'POST', '/api/rpa/run', null],
    ['rpa_stop', 'Stop RPA task(s)', { type: 'object', properties: { task_id: { type: 'string' } }, additionalProperties: false }, 'run', 'POST', '/api/rpa/stop', null],
    ['rpa_plan_save', 'Create or update an RPA plan', { type: 'object', properties: {
      plan_name: { type: 'string' }, profile_ids: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'object' } }, plan_id: { type: 'string' },
    }, required: ['plan_name', 'profile_ids', 'steps'], additionalProperties: false }, 'manage', 'POST', '/api/rpa/plans', null],
    ['rpa_plan_delete', 'Delete an RPA plan', { type: 'object', properties: { plan_id: { type: 'string' } }, required: ['plan_id'], additionalProperties: false }, 'manage', 'DELETE', '/api/rpa/plans/', null],
    ['rpa_template_install', 'Install an RPA template as a plan', { type: 'object', properties: { template_id: { type: 'string' }, plan_name: { type: 'string' } }, required: ['template_id'], additionalProperties: false }, 'manage', 'POST', '/api/rpa/templates', null],
    ['rpa_template_save_as', 'Save steps as a reusable RPA template', { type: 'object', properties: { name: { type: 'string' }, cat: { type: 'string' }, desc: { type: 'string' }, steps: { type: 'array', items: { type: 'object' } } }, required: ['name', 'steps'], additionalProperties: false }, 'manage', 'POST', '/api/rpa/templates', null],
    ['rpa_template_import', 'Import RPA templates from a payload', { type: 'object', properties: { payload: { type: 'object' } }, required: ['payload'], additionalProperties: false }, 'manage', 'POST', '/api/rpa/templates', null],
    ['rpa_template_delete', 'Delete an RPA template', { type: 'object', properties: { template_id: { type: 'string' } }, required: ['template_id'], additionalProperties: false }, 'manage', 'DELETE', '/api/rpa/templates/', null],
  ];
}

function toTool(meta) {
  return {
    name: meta[0],
    description: `${meta[1]} [permission: ${meta[3]}]`,
    inputSchema: meta[2],
  };
}

function queryString(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const text = qs.toString();
  return text ? '?' + text : '';
}

function toolsForMode() {
  return toolsMeta().filter((meta) => {
    const name = meta[0];
    if (TOOL_BLACKLIST.includes(name)) return false;
    if (TOOL_WHITELIST.length && !TOOL_WHITELIST.includes(name)) return false;
    return LEVEL_ORDER[meta[3]] <= LEVEL_ORDER[MCP_MODE];
  });
}

async function callTool(name, args = {}) {
  const meta = toolsMeta().find((item) => item[0] === name);
  if (!meta) throw new Error('Unknown tool: ' + name);
  if (LEVEL_ORDER[meta[3]] > LEVEL_ORDER[MCP_MODE]) {
    throw new Error(`Tool ${name} requires permission level ${meta[3]}; MCP mode is ${MCP_MODE}`);
  }
  if (TOOL_BLACKLIST.includes(name) || (TOOL_WHITELIST.length && !TOOL_WHITELIST.includes(name))) {
    throw new Error(`Tool ${name} is disabled by MCP policy`);
  }
  const level = meta[3];
  const method = meta[5];
  const path = meta[6];

  switch (name) {
    case 'status':
      return request('GET', '/');
    case 'mcp_policy':
      return {
        mode: MCP_MODE,
        tool_blacklist: TOOL_BLACKLIST,
        tool_whitelist: TOOL_WHITELIST,
        effective_tools: toolsForMode().map((item) => item[0]),
        server: 'openbrowser-mcp',
        api_key_configured: Boolean(API_KEY),
      };
    case 'mcp_update_policy':
      if (MCP_MODE !== 'admin') throw new Error('mcp_update_policy requires admin MCP mode');
      if (args.mode !== undefined) {
        const next = String(args.mode).toLowerCase();
        if (!['admin', 'manage', 'run', 'read'].includes(next)) throw new Error('mode must be admin|manage|run|read');
        MCP_MODE = next;
      }
      if (Array.isArray(args.tool_blacklist)) TOOL_BLACKLIST = args.tool_blacklist.map(String);
      if (Array.isArray(args.tool_whitelist)) TOOL_WHITELIST = args.tool_whitelist.map(String);
      return {
        accepted: true,
        note: 'Policy overrides apply to this MCP process. Set OPENBROWSER_MCP_MODE / OPENBROWSER_MCP_TOOL_BLACKLIST / OPENBROWSER_MCP_TOOL_WHITELIST in the MCP client env for persistent startup policy.',
        current: { mode: MCP_MODE, tool_blacklist: TOOL_BLACKLIST, tool_whitelist: TOOL_WHITELIST },
      };
    case 'check_api_key':
      return { ok: Boolean(API_KEY), key_configured: Boolean(API_KEY), mode: MCP_MODE };
    case 'list_profiles':
      return request('GET', '/api/v1/user/list');
    case 'list_active_browsers':
      return request('GET', '/api/v1/browser/active');
    case 'create_profile':
      return request('POST', '/api/v1/user/create', {
        ...args,
        user_id: args.profile_id,
        profile: args.profile_id ? { ...args, id: args.profile_id, user_id: args.profile_id } : { ...args },
      });
    case 'update_profile':
      return request('POST', '/api/v2/browser-profile/update', args);
    case 'delete_profiles':
      return request('POST', '/api/v1/user/delete', {
        profile_ids: args.profile_ids,
        delete_data: args.delete_data,
      });
    case 'duplicate_profile':
      return request('POST', '/api/v2/browser-profile/duplicate', args);
    case 'start_profile':
      return request('POST', '/api/v1/browser/start', { user_id: args.profile_id });
    case 'stop_profile':
      return request('POST', '/api/v1/browser/stop', { user_id: args.profile_id });
    case 'stop_all_profiles':
      return request('POST', '/api/v1/browser/stop-all', {});
    case 'check_profile_proxy':
      return request('POST', '/api/proxy/check-profile', args);
    case 'proxy_list':
      return request('GET', '/api/proxy/list' + queryString(args));
    case 'proxy_create':
      return request('POST', '/api/proxy/create', args);
    case 'proxy_create_many':
      return request('POST', '/api/proxy/create', { data: args.data });
    case 'proxy_update':
      return request('POST', '/api/proxy/update', { proxy_id: args.proxy_id, ...args });
    case 'proxy_delete':
      return request('POST', '/api/proxy/delete', { proxy_ids: args.proxy_ids });
    case 'proxy_check':
      return request('POST', '/api/proxy/check', args);
    case 'extension_assign':
      return request('POST', '/api/extension/assign', {
        extension_id: args.extension_id,
        profile_ids: args.profile_ids,
        enabled: args.enabled,
      });
    case 'list_extensions':
      return request('GET', '/api/extension/list');
    case 'list_applications':
      return request('GET', '/api/v1/application/list' + queryString(args));
    case 'get_fingerprint':
      return request('GET', '/api/fingerprint?profile_id=' + encodeURIComponent(args.profile_id));
    case 'fingerprint_set':
      return request('POST', '/api/v2/browser-profile/update', args);
    case 'fingerprint_reset':
      return request('POST', '/api/v2/browser-profile/update', { profile_id: args.profile_id, fingerprint: null });
    case 'fingerprint_regenerate':
      return request('POST', '/api/v2/browser-profile/update', {
        profile_id: args.profile_id,
        privacy: { refreshFingerprintOnStart: true, stabilityMode: 'off' },
      });
    case 'isolation_audit':
      return request('GET', '/api/isolation/audit');
    case 'window_sync_start':
      return request('POST', '/api/sync/start', {
        profile_ids: args.profile_ids,
        operate: args.operate,
        tile: args.tile,
        cascade: args.cascade,
        settings: args.settings,
      });
    case 'window_sync_stop':
      return request('POST', '/api/sync/stop', {});
    case 'window_sync_restart':
      return request('POST', '/api/sync/restart', {});
    case 'window_sync_status':
      return request('GET', '/api/sync/status');
    case 'window_sync_arrange':
      return request('POST', '/api/sync/arrange', { profile_ids: args.profile_ids, mode: args.mode });
    case 'window_sync_settings_get':
      return request('GET', '/api/sync/settings');
    case 'window_sync_settings_update':
      return request('POST', '/api/sync/settings', args.settings);
    case 'rpa_run_steps':
      return request('POST', '/api/rpa/run', {
        profile_id: args.profile_id,
        steps: args.steps,
        name: args.name || 'mcp-rpa',
      });
    case 'rpa_run_plan':
      return request('POST', '/api/rpa/run', { plan_id: args.plan_id, name: args.name });
    case 'rpa_status':
      return request('GET', '/api/rpa/status');
    case 'rpa_stop':
      return request('POST', '/api/rpa/stop', { task_id: args.task_id });
    case 'rpa_plans_list':
      return request('GET', '/api/rpa/plans');
    case 'rpa_plan_save':
      return request('POST', '/api/rpa/plans', args);
    case 'rpa_plan_delete':
      return request('DELETE', `/api/rpa/plans/${encodeURIComponent(args.plan_id)}`);
    case 'rpa_tasks_list':
      return request('GET', '/api/rpa/tasks' + queryString(args));
    case 'rpa_task_result':
      return request('GET', '/api/rpa/tasks/' + encodeURIComponent(String(args.task_id || '')));
    case 'rpa_tasks':
      return request('GET', '/api/rpa/tasks' + queryString(args));
    case 'rpa_templates_list':
      return request('GET', '/api/rpa/templates' + queryString(args));
    case 'rpa_template_install':
      return request('POST', '/api/rpa/templates', { action: 'install', id: args.template_id, plan_name: args.plan_name });
    case 'rpa_template_save_as':
      return request('POST', '/api/rpa/templates', { action: 'save_as', ...args });
    case 'rpa_template_import':
      return request('POST', '/api/rpa/templates', { action: 'import', payload: args.payload });
    case 'rpa_template_delete':
      return request('DELETE', `/api/rpa/templates/${encodeURIComponent(args.template_id)}`);
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
          serverInfo: { name: 'openbrowser-control-mcp', version: '2.0.0' },
        },
      });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'tools/list') {
      return writeMessage({ jsonrpc: '2.0', id, result: { tools: toolsForMode().map(toTool) } });
    }
    if (method === 'tools/call') {
      const data = await callTool(String(params.name || ''), params.arguments || {});
      return writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          isError: data && data.code !== 0 && data.code !== undefined,
        },
      });
    }
    if (method === 'ping') return writeMessage({ jsonrpc: '2.0', id, result: {} });
    return writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
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
      try { message = JSON.parse(line); } catch (_) { continue; }
      handleRpc(message);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { TOOLS: toolsForMode().map(toTool), callTool, request, toolsMeta, LEVEL_ORDER };
