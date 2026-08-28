'use strict';

const http = require('http');
const { spawn } = require('child_process');
const { LocalApiServer } = require('./local-api-server');
const { ProxyStore } = require('./proxy-store');
const { RpaStore } = require('./rpa-store');
const { RpaEngine } = require('./rpa-engine');
const { WindowSyncBridge } = require('./window-sync-bridge');
const { AppCenter } = require('./app-center');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeEngine() {
  const profiles = new Map([
    ['fp1', { id: 'fp1', name: 'Fingerprint 1', number: 1, proxy: 'Direct', privacy: { fingerprint: { os: 'Windows' } } }],
  ]);
  const running = new Map();
  const extensions = new Map();
  return {
    profiles,
    running,
    extensions,
    sanitizeProfile(value) {
      const next = {
        ...value,
        id: String(value.id || ''),
        name: String(value.name || ''),
        startUrl: value.startUrl || value.platform?.startUrl || '',
        userAgent: String(value.userAgent || ''),
        width: Number(value.width) || 1280,
        height: Number(value.height) || 820,
        note: String(value.note || ''),
      };
      const privacy = { ...(next.privacy || {}) };
      if (next.fingerprint && typeof next.fingerprint === 'object') {
        privacy.fingerprint = { ...(privacy.fingerprint || {}), ...next.fingerprint };
        next.fingerprint = privacy.fingerprint;
      } else if (privacy.fingerprint && typeof privacy.fingerprint === 'object') {
        next.fingerprint = privacy.fingerprint;
      } else {
        privacy.fingerprint = {};
        next.fingerprint = privacy.fingerprint;
      }
      next.privacy = privacy;
      return next;
    },
    syncProfiles(values) {
      for (const value of values) profiles.set(value.id, value);
      return this.status();
    },
    async persist() { return true; },
    status() {
      return [...profiles.values()].map((profile) => ({
        ...profile,
        running: running.has(profile.id),
        port: running.get(profile.id)?.port || null,
        assignedExtensions: [],
      }));
    },
    fingerprintFor(id) {
      const profile = profiles.get(id);
      if (!profile) throw new Error('profile not found');
      return { ...(profile.privacy?.fingerprint || profile.fingerprint || {}) };
    },
    isolationAudit() {
      return { ok: true, collisions: [] };
    },
    listExtensions() { return [...extensions.values()]; },
    async assignExtension(extensionId, profileIds, enabled) {
      if (!extensions.has(extensionId)) throw new Error('missing extension');
      const set = new Set(enabled ? profileIds : []);
      for (const id of profileIds) {
        if (enabled) set.add(id);
      }
      const ext = extensions.get(extensionId);
      ext.assignedProfileIds = [...set];
      ext.assignedProfiles = set.size;
      return ext;
    },
    async start(profile) {
      const port = 9300 + Number(profile.number || 0);
      running.set(profile.id, { port });
      return { id: profile.id, running: true, port };
    },
    async stop(id) {
      running.delete(id);
      return { id, running: false };
    },
    async stopAll() {
      running.clear();
      return { stopped: true };
    },
    async checkProxy(profile, options = {}) {
      const result = { ip: '203.0.113.9', country: 'Test', countryCode: 'T1', timezone: 'Etc/UTC' };
      if (options.persist) {
        const next = this.sanitizeProfile({ ...profile, exitCheckedAt: Date.now(), exitNetwork: result });
        profiles.set(profile.id, next);
      }
      return result;
    },
  };
}

async function main() {
  const checks = [];
  const record = (name, ok) => checks.push({ name, ok });

  const engine = fakeEngine();
  const proxyStore = new ProxyStore('/tmp/openbrowser-mcp-proxy-' + process.pid + '.json');
  await proxyStore.load();
  const rpaStore = new RpaStore('/tmp/openbrowser-mcp-rpa-' + process.pid + '.json');
  await rpaStore.load();
  const rpa = new RpaEngine({ engine, store: rpaStore, emit: () => {} });
  const syncState = { active: false, selected: [] };
  let syncTileCount = 0;
  const syncBridge = new WindowSyncBridge({
    getLiveSync: () => null,
    beginSync: async (ids) => { syncState.active = Boolean(ids?.length); syncState.selected = ids || []; return syncState; },
    endSync: () => { syncState.active = false; return syncState; },
    restartSync: async () => syncState,
    getSyncState: () => syncState,
    setSelection: (ids) => { syncState.selected = ids; },
    tile: async () => { syncTileCount += 1; return true; },
    getSettings: () => ({}),
    updateSettings: (patch) => patch,
  });
  const appCenter = new AppCenter({ engine });
  const api = new LocalApiServer({
    port: 0,
    apiKey: 'mcp-selftest-key',
    engine,
    rpaEngine: rpa,
    rpaStore,
    syncBridge,
    appCenter,
    proxyStore,
    getVersion: () => '9.9.9-test',
  });
  await api.start();
  const apiPort = api.port;

  const request = (method, path, body, apiKey = 'mcp-selftest-key') => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: apiPort,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  const createResult = await request('POST', '/api/v1/user/create', {
    profile_id: 'mcp-fp',
    name: 'MCP Fingerprint',
    proxy: 'Direct',
    start_url: 'https://example.com',
    user_agent: 'Mozilla/5.0 MCP',
    resolution: '1440x900',
    timezone: 'Asia/Shanghai',
    hardware_concurrency: 8,
    device_memory: 16,
    webgl_vendor: 'Google Inc. (MCP)',
    notes: 'created via mcp selftest',
    fingerprint: { os: 'Linux' },
  });
  const createdProfile = createResult.body.data?.profile;
  record('local-api create fingerprint profile', createResult.status === 200 && createResult.body.code === 0 && createdProfile?.id === 'mcp-fp');
  record('local-api create maps snake_case fields', createdProfile?.startUrl === 'https://example.com' && createdProfile?.userAgent === 'Mozilla/5.0 MCP' && createdProfile?.width === 1440 && createdProfile?.height === 900 && createdProfile?.note === 'created via mcp selftest');
  record('local-api create merges top-level fingerprint into privacy', createdProfile?.privacy?.fingerprint?.os === 'Linux' && createdProfile?.privacy?.fingerprint?.hardwareConcurrency === 8 && createdProfile?.privacy?.timezone === 'Asia/Shanghai');

  const updateResult = await request('POST', '/api/v2/browser-profile/update', {
    profile_id: 'mcp-fp',
    name: 'MCP Fingerprint Updated',
    start_url: 'https://openai.com',
    user_agent: 'Mozilla/5.0 Updated',
    resolution: '2560x1440',
    timezone: 'America/New_York',
    webgl_renderer: 'ANGLE (MCP GPU)',
    fingerprint: { os: 'macOS', canvasId: 4242 },
  });
  const updatedProfile = updateResult.body.data?.profile;
  record('local-api update profile', updateResult.status === 200 && updateResult.body.code === 0 && updatedProfile?.name === 'MCP Fingerprint Updated' && updatedProfile?.privacy?.fingerprint?.os === 'macOS' && updatedProfile?.privacy?.fingerprint?.canvasId === 4242);
  record('local-api update maps snake_case fields', updatedProfile?.startUrl === 'https://openai.com' && updatedProfile?.userAgent === 'Mozilla/5.0 Updated' && updatedProfile?.width === 2560 && updatedProfile?.height === 1440 && updatedProfile?.privacy?.timezone === 'America/New_York' && updatedProfile?.privacy?.fingerprint?.webglRenderer === 'ANGLE (MCP GPU)');

  const duplicateResult = await request('POST', '/api/v2/browser-profile/duplicate', { source_profile_id: 'mcp-fp', name: 'MCP Fingerprint Copy' });
  record('local-api duplicate profile without exit data', duplicateResult.status === 200 && duplicateResult.body.code === 0 && duplicateResult.body.data.profile?.id !== 'mcp-fp' && duplicateResult.body.data.profile?.exitNetwork === undefined);

  const checkResult = await request('POST', '/api/proxy/check-profile', { profile_id: 'mcp-fp' });
  record('local-api check profile proxy persists', checkResult.status === 200 && checkResult.body.code === 0 && checkResult.body.data?.country === 'Test' && engine.profiles.get('mcp-fp')?.exitNetwork?.country === 'Test');

  const badKey = await request('GET', '/api/v1/user/list', undefined, 'wrong-key');
  record('local-api rejects wrong key', badKey.status === 401);

  const start = await request('POST', '/api/v1/browser/start', { profile_id: 'mcp-fp' });
  record('local-api start profile', start.status === 200 && start.body.data.debug_port > 0);

  const syncStart = await request('POST', '/api/sync/start', { profile_ids: ['mcp-fp', 'fp1'], operate: 'click,scroll' });
  record('local-api sync start', syncStart.status === 200 && syncStart.body.code === 0 && syncTileCount === 1 && syncState.active === true);

  const stopAll = await request('POST', '/api/v1/browser/stop-all', {});
  record('local-api stop all', stopAll.status === 200 && stopAll.body.data.stopped === true);

  const spawnMcp = (env, extraCalls = []) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['automation/mcp-server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, OPENBROWSER_API_PORT: String(apiPort), OPENBROWSER_API_KEY: 'mcp-selftest-key', ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let stdout = '';
    const responses = new Map();
    const calls = [
      { id: 1, method: 'initialize', params: {} },
      { id: 2, method: 'tools/list', params: {} },
      { id: 3, method: 'tools/call', params: { name: 'mcp_policy', arguments: {} } },
      { id: 4, method: 'tools/call', params: { name: 'create_profile', arguments: { profile_id: 'mcp-b', name: 'MCP B', proxy: 'Direct' } } },
      { id: 5, method: 'tools/call', params: { name: 'list_profiles', arguments: {} } },
      { id: 6, method: 'tools/call', params: { name: 'get_fingerprint', arguments: { profile_id: 'mcp-fp' } } },
      { id: 7, method: 'tools/call', params: { name: 'rpa_run_steps', arguments: { profile_id: 'fp1', steps: [{ type: 'wait', ms: 1 }] } } },
    ];
    let nextId = 8;
    for (const call of extraCalls) {
      calls.push({ id: nextId++, method: 'tools/call', params: { name: call.name, arguments: call.args } });
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let index;
      while ((index = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
      }
    });
    const finish = () => { child.kill(); resolve(responses); };
    child.stdin.on('error', () => finish());
    setTimeout(finish, 6000);
    for (const call of calls) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, method: call.method, params: call.params }) + '\n');
  });

  const admin = await spawnMcp({ OPENBROWSER_MCP_MODE: 'admin' }, [
    { name: 'fingerprint_set', args: { profile_id: 'mcp-fp', fingerprint: { os: 'Windows 11', hardwareConcurrency: 16 }, resolution: '1920x1080' } },
  ]);
  record('mcp initialize', admin.get(1)?.result?.serverInfo?.name === 'openbrowser-control-mcp');
  record('mcp tools/list >= 43', (admin.get(2)?.result?.tools?.length || 0) >= 43);
  record('mcp create_profile', admin.get(4)?.result && admin.get(4)?.result.isError === false && engine.profiles.has('mcp-b'));
  record('mcp list_profiles', admin.get(5)?.result?.isError === false);
  record('mcp get_fingerprint', admin.get(6)?.result?.isError === false);
  record('mcp fingerprint_set', admin.get(8)?.result?.isError === false && engine.profiles.get('mcp-fp')?.privacy?.fingerprint?.os === 'Windows 11' && engine.profiles.get('mcp-fp')?.width === 1920);

  const adminFp = await spawnMcp({ OPENBROWSER_MCP_MODE: 'admin' }, [
    { name: 'fingerprint_reset', args: { profile_id: 'mcp-fp' } },
    { name: 'fingerprint_regenerate', args: { profile_id: 'mcp-fp' } },
  ]);
  record('mcp fingerprint_reset', adminFp.get(8)?.result?.isError === false && Object.keys(engine.profiles.get('mcp-fp')?.privacy?.fingerprint || {}).length === 0);
  record('mcp fingerprint_regenerate', adminFp.get(9)?.result?.isError === false && engine.profiles.get('mcp-fp')?.privacy?.refreshFingerprintOnStart === true && engine.profiles.get('mcp-fp')?.privacy?.stabilityMode === 'off');

  const read = await spawnMcp({ OPENBROWSER_MCP_MODE: 'read' });
  const readTools = read.get(2)?.result?.tools || [];
  record('mcp read mode hides manage tools', readTools.length > 0 && !readTools.some((tool) => tool.name === 'create_profile'));
  record('mcp read mode hides fingerprint_set', !readTools.some((tool) => tool.name === 'fingerprint_set'));
  const blocked = read.get(4)?.error?.message || '';
  record('mcp read mode blocks create_profile', blocked.includes('requires permission level manage'));
  record('mcp read mode allows list_profiles', read.get(5)?.result?.isError === false);

  const blacklist = await spawnMcp({ OPENBROWSER_MCP_MODE: 'admin', OPENBROWSER_MCP_TOOL_BLACKLIST: JSON.stringify(['create_profile', 'rpa_run_steps']) });
  record('mcp blacklist hides tools', !(blacklist.get(2)?.result?.tools || []).some((tool) => tool.name === 'create_profile'));
  const blacklisted = blacklist.get(4)?.error?.message || '';
  record('mcp blacklist blocks call', blacklisted.includes('disabled by MCP policy'));

  const whitelist = await spawnMcp({ OPENBROWSER_MCP_MODE: 'admin', OPENBROWSER_MCP_TOOL_WHITELIST: JSON.stringify(['mcp_policy', 'list_profiles']) });
  record('mcp whitelist restricts tools', (whitelist.get(2)?.result?.tools || []).map((tool) => tool.name).sort().join(',') === 'list_profiles,mcp_policy');

  const fail = checks.filter((item) => !item.ok);
  for (const check of checks) console.log((check.ok ? 'PASS' : 'FAIL') + '  ' + check.name);
  await api.stop();
  await proxyStore.deleteFile?.();
  if (fail.length) {
    console.error(JSON.stringify({ success: false, checks: checks.length, failed: fail.map((item) => item.name) }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ success: true, checks: checks.length }, null, 2));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
