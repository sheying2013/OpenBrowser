#!/usr/bin/env node
'use strict';

/**
 * Only OPENBROWSER_API_PORT may override discovery — a polluted generic PORT must never aim the API key at another local service; each case runs in its own child, no network.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const here = __dirname;
const mcpPath = path.join(here, 'mcp-server.js');

const results = [];
function record(name, ok, err) {
  results.push({ name, ok, err });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  -> ${err}`}`);
}
async function checkAsync(name, fn) {
  try { await fn(); record(name, true); }
  catch (e) { record(name, false, e?.message || String(e)); }
}

/**
 * Run resolveMcpPort in a clean child with exactly the given env, so a real
 * PORT/discovery-file on the host can never decide the outcome.
 */
function resolveInChild({ userDataPath = '', env = {} } = {}) {
  const script = `
    const { resolveMcpPort } = require(${JSON.stringify(mcpPath)});
    const value = resolveMcpPort(process.env.__USER_DATA_PATH || '');
    process.stdout.write(JSON.stringify({ value }));
  `;
  const stdout = execFileSync(process.execPath, ['-e', script], {
    env: { ...env, __USER_DATA_PATH: userDataPath },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout).value;
}

async function writeDiscovery(userData, port) {
  const file = path.join(userData, 'automation-info.json');
  await fsp.writeFile(file, JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }), 'utf8');
  return file;
}

(async () => {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-mcp-port-'));

  // Every case isolates discovery via OPENBROWSER_USER_DATA, and sets a
  // distinctive PORT to prove the fallback is gone.
  await checkAsync('a polluted PORT is ignored when a discovery file exists', async () => {
    const userData = await fsp.mkdtemp(path.join(scratch, 'with-disc-'));
    await writeDiscovery(userData, 48123);
    const value = resolveInChild({
      userDataPath: userData,
      env: { PORT: '59999', OPENBROWSER_USER_DATA: userData },
    });
    assert.strictEqual(value, 48123, 'discovery must win over PORT');
  });

  await checkAsync('a polluted PORT does not invent a port when discovery is absent', async () => {
    const userData = await fsp.mkdtemp(path.join(scratch, 'no-disc-'));
    const value = resolveInChild({
      userDataPath: userData,
      env: { PORT: '59999', OPENBROWSER_USER_DATA: userData },
    });
    assert.strictEqual(value, null, 'PORT alone must never yield a port');
  });

  await checkAsync('OPENBROWSER_API_PORT takes precedence over discovery', async () => {
    const userData = await fsp.mkdtemp(path.join(scratch, 'explicit-'));
    await writeDiscovery(userData, 48124);
    const value = resolveInChild({
      userDataPath: userData,
      env: { OPENBROWSER_API_PORT: '48500', PORT: '59999', OPENBROWSER_USER_DATA: userData },
    });
    assert.strictEqual(value, 48500, 'the explicit OpenBrowser variable wins');
  });

  await checkAsync('an invalid explicit OPENBROWSER_API_PORT falls through to discovery (not PORT)', async () => {
    const userData = await fsp.mkdtemp(path.join(scratch, 'invalid-'));
    await writeDiscovery(userData, 48125);
    for (const bad of ['0', '70000', 'not-a-port', '-1', '']) {
      const value = resolveInChild({
        userDataPath: userData,
        env: { OPENBROWSER_API_PORT: bad, PORT: '59999', OPENBROWSER_USER_DATA: userData },
      });
      assert.strictEqual(value, 48125, `invalid explicit "${bad}" should fall through to discovery`);
    }
  });

  await checkAsync('no explicit, no discovery, no PORT -> null (StartOpenBrowser guidance path)', async () => {
    const userData = await fsp.mkdtemp(path.join(scratch, 'empty-'));
    const value = resolveInChild({ userDataPath: userData, env: { OPENBROWSER_USER_DATA: userData } });
    assert.strictEqual(value, null);
  });

  // Cross-check the real source no longer mentions a PORT fallback.
  await checkAsync('the source only reads PORT in resolveMcpPort via an explicit variable', async () => {
    const src = fs.readFileSync(mcpPath, 'utf8');
    const body = src.slice(src.indexOf('function resolveMcpPort'), src.indexOf('let cachedPort'));
    assert.ok(!/process\.env\.PORT\b/.test(body), 'resolveMcpPort must not read process.env.PORT');
    assert.ok(/process\.env\.OPENBROWSER_API_PORT/.test(body), 'it must read OPENBROWSER_API_PORT');
  });

  await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\nMCP_PORT_DISCOVERY_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
