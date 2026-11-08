'use strict';

/**
 * Port Exposure Hardening Selftest.
 *
 * Verifies:
 * (a) Random high-range port selection (41000-59999, !== 50325, no known debug ports) when env is not set.
 * (b) OPENBROWSER_API_PORT environment variable is strictly respected when set.
 * (c) Atomic write of automation-info.json in userData, matching actual listening port and process info.
 * (d) UI/MCP consumer discovery mechanism reads the actual listening port from file / info.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const vm = require('vm');
const http = require('http');

const {
  LocalApiServer,
  selectRandomApiPort,
  resolveDefaultApiPort,
  writeAutomationInfo,
  writeAutomationInfoSync,
  readAutomationInfo,
  readAutomationInfoSync,
  readDiscoveryPort,
  removeAutomationInfo,
  AUTOMATION_INFO_FILE,
  DYNAMIC_PORT_MIN,
  DYNAMIC_PORT_MAX,
  EXCLUDED_PORTS,
} = require('./local-api-server');

const results = [];
function record(name, ok, err) {
  results.push({ name, ok, err });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  -> ${err}`}`);
}
function check(name, fn) {
  try { fn(); record(name, true); }
  catch (e) { record(name, false, e.message || String(e)); }
}
async function checkAsync(name, fn) {
  try { await fn(); record(name, true); }
  catch (e) { record(name, false, e.message || String(e)); }
}

function httpGet(port, pathname, apiKey) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: apiKey ? { 'api-key': apiKey } : {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

(async () => {
  const originalEnvPort = process.env.OPENBROWSER_API_PORT;
  delete process.env.OPENBROWSER_API_PORT;

  try {
    // =========================================================================
    // (a) 无 env 时端口随机且≠50325 (Random high-range, never 50325, no known debug ports)
    // =========================================================================
    check('(a) selectRandomApiPort produces ports strictly within [41000, 59999]', () => {
      for (let i = 0; i < 100; i += 1) {
        const port = selectRandomApiPort();
        assert.ok(Number.isInteger(port), `port should be integer: ${port}`);
        assert.ok(port >= DYNAMIC_PORT_MIN, `port ${port} below min ${DYNAMIC_PORT_MIN}`);
        assert.ok(port <= DYNAMIC_PORT_MAX, `port ${port} above max ${DYNAMIC_PORT_MAX}`);
      }
    });

    check('(a) selectRandomApiPort never generates excluded debug/fingerprint ports', () => {
      for (let i = 0; i < 200; i += 1) {
        const port = selectRandomApiPort();
        assert.notStrictEqual(port, 50325, 'port must never be ThirdPartySuite/legacy 50325');
        assert.ok(!EXCLUDED_PORTS.has(port), `port ${port} must not be in excluded list`);
      }
    });

    check('(a) selectRandomApiPort displays high entropy across multiple samplings', () => {
      const samples = new Set();
      for (let i = 0; i < 60; i += 1) {
        samples.add(selectRandomApiPort());
      }
      assert.ok(samples.size >= 45, `expected >=45 distinct ports out of 60, got ${samples.size}`);
    });

    check('(a) LocalApiServer defaults to random high-range port when env is unset', () => {
      const server1 = new LocalApiServer();
      const server2 = new LocalApiServer({});
      assert.ok(server1.requestedPort >= DYNAMIC_PORT_MIN && server1.requestedPort <= DYNAMIC_PORT_MAX);
      assert.notStrictEqual(server1.requestedPort, 50325);
      assert.ok(server2.requestedPort >= DYNAMIC_PORT_MIN && server2.requestedPort <= DYNAMIC_PORT_MAX);
      assert.notStrictEqual(server2.requestedPort, 50325);
    });

    // =========================================================================
    // (b) env 时严格生效 (OPENBROWSER_API_PORT env override honored)
    // =========================================================================
    await checkAsync('(b) explicit OPENBROWSER_API_PORT is strictly honored', async () => {
      const customPort = 46892;
      process.env.OPENBROWSER_API_PORT = String(customPort);
      try {
        const server = new LocalApiServer({ apiKey: 'env-test-key' });
        assert.strictEqual(server.requestedPort, customPort);
        const info = await server.start();
        assert.strictEqual(info.port, customPort);
        assert.strictEqual(info.requestedPort, customPort);
        assert.strictEqual(info.portFallback, null);

        const res = await httpGet(customPort, '/status', 'env-test-key');
        assert.strictEqual(res.status, 200);
        await server.stop();
      } finally {
        delete process.env.OPENBROWSER_API_PORT;
      }
    });

    check('(b) invalid port option falls back to OPENBROWSER_API_PORT when set', () => {
      process.env.OPENBROWSER_API_PORT = '47123';
      try {
        const server = new LocalApiServer({ port: 'not-a-number' });
        assert.strictEqual(server.requestedPort, 47123);
      } finally {
        delete process.env.OPENBROWSER_API_PORT;
      }
    });

    check('(b) OPENBROWSER_API_PORT=50325 is strictly honored if user explicitly configures it', () => {
      process.env.OPENBROWSER_API_PORT = '50325';
      try {
        const server = new LocalApiServer({});
        assert.strictEqual(server.requestedPort, 50325, 'explicit env=50325 must be respected for backwards compatibility');
      } finally {
        delete process.env.OPENBROWSER_API_PORT;
      }
    });

    await checkAsync('(b) OPENBROWSER_API_PORT=0 binds to ephemeral port without falsy fallback', async () => {
      process.env.OPENBROWSER_API_PORT = '0';
      try {
        assert.strictEqual(resolveDefaultApiPort(), 0, 'resolveDefaultApiPort must preserve 0');
        const server = new LocalApiServer();
        assert.strictEqual(server.requestedPort, 0, 'port 0 must not be replaced by random port');
        const info = await server.start();
        assert.ok(info.port > 0, 'server should bind to an OS-allocated port');
        assert.strictEqual(info.requestedPort, 0);
        await server.stop();
      } finally {
        delete process.env.OPENBROWSER_API_PORT;
      }
    });

    // =========================================================================
    // (c) 发现文件内容与实际监听一致且为原子写 (Atomic write of automation-info.json)
    // =========================================================================
    await checkAsync('(c) automation-info.json is written atomically and matches listening port', async () => {
      const tempUserData = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-api-port-disc-'));
      try {
        const server = new LocalApiServer({
          userDataPath: tempUserData,
          apiKey: 'disc-test-key',
        });
        const info = await server.start();

        const discFile = path.join(tempUserData, AUTOMATION_INFO_FILE);
        assert.ok(fs.existsSync(discFile), 'automation-info.json must exist in userData');

        const contentRaw = await fsp.readFile(discFile, 'utf8');
        const content = JSON.parse(contentRaw);

        assert.strictEqual(content.port, info.port, 'file port must match server listening port');
        assert.strictEqual(content.pid, process.pid, 'file pid must match current process');
        assert.strictEqual(typeof content.startedAt, 'number', 'startedAt must be timestamp');
        assert.ok(content.startedAt > 0);
        assert.strictEqual(content.host, '127.0.0.1');
        assert.strictEqual(content.url, `http://127.0.0.1:${info.port}/`);
        assert.strictEqual(content.apiKeyRequired, true);

        // Verify no leftover .tmp files from atomic rename
        const entries = await fsp.readdir(tempUserData);
        const tmpFiles = entries.filter((e) => e.startsWith('.automation-info.json.tmp'));
        assert.strictEqual(tmpFiles.length, 0, 'temporary atomic files must be cleaned up');

        await server.stop();
        assert.ok(!fs.existsSync(discFile), 'automation-info.json should be removed on server stop');
      } finally {
        await fsp.rm(tempUserData, { recursive: true, force: true }).catch(() => {});
      }
    });

    await checkAsync('(c) writeAutomationInfo performs atomic write via tmp file and rename', async () => {
      const tempUserData = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-atomic-test-'));
      try {
        const testInfo = { port: 48999, startedAt: Date.now(), host: '127.0.0.1', apiKeyRequired: true };
        const writtenPath = await writeAutomationInfo(tempUserData, testInfo);
        assert.ok(fs.existsSync(writtenPath));

        const readBack = readAutomationInfoSync(tempUserData);
        assert.strictEqual(readBack.port, 48999);
        assert.strictEqual(readBack.pid, process.pid);

        // Multiple rapid writes should not corrupt or collide
        const writePromises = [];
        for (let i = 0; i < 20; i += 1) {
          writePromises.push(writeAutomationInfo(tempUserData, { port: 48000 + i }));
        }
        await Promise.all(writePromises);

        const finalData = await readAutomationInfo(tempUserData);
        assert.ok(finalData.port >= 48000 && finalData.port <= 48020, 'file should remain valid JSON');
      } finally {
        await fsp.rm(tempUserData, { recursive: true, force: true }).catch(() => {});
      }
    });

    await checkAsync('(c) stale discovery file with dead pid is ignored', async () => {
      const tempUserData = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-dead-pid-test-'));
      try {
        const discPath = path.join(tempUserData, AUTOMATION_INFO_FILE);
        // Write file with PID that definitely does not exist
        const deadPid = 99999999;
        await fsp.writeFile(discPath, JSON.stringify({
          port: 49555,
          pid: deadPid,
          startedAt: Date.now() - 100000,
        }));
        const discovered = readDiscoveryPort(tempUserData);
        assert.strictEqual(discovered, null, 'dead PID must be ignored to prevent connecting to dead port');

        const asyncDiscovered = await readAutomationInfo(tempUserData);
        assert.strictEqual(asyncDiscovered, null, 'async read should also ignore dead PID');
      } finally {
        await fsp.rm(tempUserData, { recursive: true, force: true }).catch(() => {});
      }
    });

    await checkAsync('(c) removeAutomationInfo matches PID before deleting', async () => {
      const tempUserData = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-pid-del-test-'));
      try {
        const discPath = path.join(tempUserData, AUTOMATION_INFO_FILE);
        await fsp.writeFile(discPath, JSON.stringify({
          port: 49777,
          pid: 77777,
          startedAt: Date.now(),
        }));

        // Another PID attempts deletion
        await removeAutomationInfo(tempUserData, 88888);
        assert.ok(fs.existsSync(discPath), 'removeAutomationInfo must not delete file owned by another PID');

        // Expected PID deletes
        await removeAutomationInfo(tempUserData, 77777);
        assert.ok(!fs.existsSync(discPath), 'removeAutomationInfo must delete when PID matches');
      } finally {
        await fsp.rm(tempUserData, { recursive: true, force: true }).catch(() => {});
      }
    });

    // =========================================================================
    // (d) UI/MCP 消费方读到实际端口 (Consumer reads actual port from discovery)
    // =========================================================================
    await checkAsync('(d) readDiscoveryPort and readAutomationInfo read real port from discovery file', async () => {
      const tempUserData = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-consumer-test-'));
      try {
        const livePort = 49123;
        writeAutomationInfoSync(tempUserData, { port: livePort, startedAt: Date.now() });

        const discoveredPort = readDiscoveryPort(tempUserData);
        assert.strictEqual(discoveredPort, livePort);

        const asyncDiscovered = await readAutomationInfo(tempUserData);
        assert.strictEqual(asyncDiscovered.port, livePort);
      } finally {
        await fsp.rm(tempUserData, { recursive: true, force: true }).catch(() => {});
      }
    });

    await checkAsync('(d) UI/MCP page generates configuration from discovered actual port', async () => {
      const tempUserData = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-ui-consumer-'));
      try {
        const livePort = 47891;
        writeAutomationInfoSync(tempUserData, { port: livePort, startedAt: Date.now() });

        // Simulate UI environment loading ui-api-mcp.js
        const uiSource = fs.readFileSync(path.join(__dirname, '..', 'ui', 'ui-api-mcp.js'), 'utf8');

        class MockEl {
          constructor() {
            this.textContent = '';
            this.value = '';
            this.listeners = {};
            this.classList = {
              classes: new Set(),
              add(c) { this.classes.add(c); },
              remove(c) { this.classes.delete(c); },
              toggle(c, f) { if (f ?? !this.classes.has(c)) this.classes.add(c); else this.classes.delete(c); },
            };
          }
          addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
          removeEventListener() {}
        }
        const elements = new Map();
        const document = {
          getElementById(id) {
            if (!elements.has(id)) elements.set(id, new MockEl());
            return elements.get(id);
          },
          querySelector() { return null; },
          querySelectorAll() { return []; },
        };
        const window = {
          ops: {
            localApiInfo: async () => null, // Server process info not directly queried
            mcpPaths: async () => ({
              mcpScript: '/app/automation/mcp-server.js',
              port: readDiscoveryPort(tempUserData), // Discovered from file!
              apiKey: 'test-key-ui',
              apiKeyFile: '/app/local-api-key.txt',
            }),
            localApiVersion: async () => ({ version: '1.0.0' }),
            onEvent: () => {},
          },
          tx: (s) => s,
          toast: () => {},
          afterUiRender: () => {},
        };
        window.window = window;
        const sandbox = {
          window, document, console, setTimeout, clearTimeout, JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Error, RegExp, Set, Map,
        };
        sandbox.globalThis = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(uiSource, sandbox);

        await window.refreshApiMcpPage();

        const mcpJson = JSON.parse(elements.get('mcp-config-json').textContent);
        const serverEnv = mcpJson.mcpServers['openbrowser-local-api'].env;
        assert.strictEqual(serverEnv.OPENBROWSER_API_PORT, String(livePort), 'MCP config must use discovered port');
        assert.strictEqual(serverEnv.PORT, String(livePort));
        assert.ok(elements.get('api-status-url').textContent.includes(String(livePort)));
        assert.ok(!elements.get('api-status-url').textContent.includes('50325'), 'must not contain 50325');
      } finally {
        await fsp.rm(tempUserData, { recursive: true, force: true }).catch(() => {});
      }
    });

    await checkAsync('(d) mcp-server.js connects via discovered port or reports actionable error', async () => {
      const { resolveMcpPort, getApiPort } = require('./mcp-server');
      const tempUserData = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-mcp-standalone-'));
      try {
        const livePort = 48654;
        writeAutomationInfoSync(tempUserData, { port: livePort, startedAt: Date.now(), pid: process.pid });

        // When OPENBROWSER_USER_DATA points to tempUserData, resolveMcpPort discovers it
        process.env.OPENBROWSER_USER_DATA = tempUserData;
        delete process.env.OPENBROWSER_API_PORT;
        delete process.env.PORT;

        assert.strictEqual(resolveMcpPort(), livePort, 'mcp-server must discover port from automation-info.json');
        assert.strictEqual(getApiPort(true), livePort);

        // When env is explicitly set, env wins over discovery
        process.env.OPENBROWSER_API_PORT = '49991';
        assert.strictEqual(resolveMcpPort(), 49991, 'env must take precedence over discovery');
        assert.strictEqual(getApiPort(true), 49991);
        delete process.env.OPENBROWSER_API_PORT;

        // When discovery file is removed and env is unset, getApiPort throws clear error
        await fsp.rm(path.join(tempUserData, AUTOMATION_INFO_FILE));
        assert.strictEqual(resolveMcpPort(), null);
        assert.throws(() => getApiPort(true), /Local API port not found/);
      } finally {
        delete process.env.OPENBROWSER_USER_DATA;
        await fsp.rm(tempUserData, { recursive: true, force: true }).catch(() => {});
      }
    });

  } finally {
    if (originalEnvPort !== undefined) {
      process.env.OPENBROWSER_API_PORT = originalEnvPort;
    } else {
      delete process.env.OPENBROWSER_API_PORT;
    }
  }

  // ================= report =================
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\nAPI_PORT_HARDENING_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
