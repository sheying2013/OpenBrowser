'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');

const {
  fetchProviderProxies,
  parseProviderResponse,
  batchSpeedTest,
  clearProviderCooldowns,
  getProviderCooldownRemaining,
  MAX_PROVIDER_BATCH_SIZE,
  PROVIDER_COOLDOWN_MS,
  MAX_PROBE_CONCURRENCY,
} = require('./proxy-providers');

const {
  ProxyStore,
  checkProxyLaunchHealth,
  assertProxyLaunchAvailable,
} = require('./proxy-store');

const { BrowserEngine } = require('../engine');
const { sanitizeProfile } = require('../engine/profile-sanitizer');

const results = [];
async function check(name, action) {
  try {
    await action();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

(async () => {
  console.log('Starting Proxy Providers & Batch Probe Selftest...\n');

  // --- 1. Set up loopback mock server for extraction formats ---
  const mockServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    if (url.pathname === '/format-ip-port') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`
        127.0.0.1:8081
        127.0.0.1:8082
        127.0.0.1:8081 # duplicate line should be deduped
      `);
      return;
    }

    if (url.pathname === '/format-ip-port-user-pass') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`
        127.0.0.1:8083:alice:secret123#TagA
        127.0.0.1:8084:bob:pass456#TagB
        socks5://charlie:pass789@127.0.0.1:8085#TagC
      `);
      return;
    }

    if (url.pathname === '/format-json-nested') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: {
          list: [
            { ip: '127.0.0.1', port: 8086, user: 'usr1', pass: 'pwd1', proto: 'http', remark: 'node-json-1' },
            { ip: '127.0.0.1', port: 8087, user: 'usr2', pass: 'pwd2', proto: 'socks5', remark: 'node-json-2' },
            { ip: '127.0.0.1', port: 8086, user: 'usr1', pass: 'pwd1', proto: 'http' }, // duplicate
          ],
        },
      }));
      return;
    }

    if (url.pathname === '/format-json-custom-mapping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        proxies: [
          { proxy_ip: '127.0.0.1', proxy_port: 8088, account: 'custom_u', auth_pass: 'custom_p', type: 'https' },
        ],
      }));
      return;
    }

    if (url.pathname === '/format-overflow') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      // Generate 600 unique proxies to test upper limit protection
      const lines = [];
      for (let i = 1; i <= 600; i++) {
        lines.push(`127.0.0.1:${1000 + i}`);
      }
      res.end(lines.join('\n'));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const serverPort = mockServer.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}`;

  try {
    // --- Test 1: Format 1 (ip:port) extraction and deduplication ---
    await check('Format 1 (ip:port) parsed correctly with default protocol and deduplication', async () => {
      clearProviderCooldowns();
      const res = await fetchProviderProxies(`${baseUrl}/format-ip-port`, {
        protocol: 'socks5',
        template: 'text_ip_port',
      });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.proxies.length, 2, 'Duplicates should be removed');
      assert.strictEqual(res.proxies[0].host, '127.0.0.1');
      assert.strictEqual(res.proxies[0].port, 8081);
      assert.strictEqual(res.proxies[0].protocol, 'socks5');
      assert.strictEqual(res.proxies[0].username, '');
      assert.strictEqual(res.proxies[0].password, '');
      assert.strictEqual(res.proxies[1].port, 8082);
    });

    // --- Test 2: Format 2 (ip:port:user:pass) extraction ---
    await check('Format 2 (ip:port:user:pass & URL format) parsed correctly with auth', async () => {
      clearProviderCooldowns();
      const res = await fetchProviderProxies(`${baseUrl}/format-ip-port-user-pass`, {
        protocol: 'socks5',
        template: 'text_ip_port_user_pass',
      });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.proxies.length, 3);
      assert.strictEqual(res.proxies[0].host, '127.0.0.1');
      assert.strictEqual(res.proxies[0].port, 8083);
      assert.strictEqual(res.proxies[0].username, 'alice');
      assert.strictEqual(res.proxies[0].password, 'secret123');
      assert.strictEqual(res.proxies[0].remark, 'TagA');

      assert.strictEqual(res.proxies[1].username, 'bob');
      assert.strictEqual(res.proxies[1].password, 'pass456');

      assert.strictEqual(res.proxies[2].username, 'charlie');
      assert.strictEqual(res.proxies[2].password, 'pass789');
      assert.strictEqual(res.proxies[2].remark, 'TagC');
    });

    // --- Test 3: Format 3 (JSON array nested & field mapping) ---
    await check('Format 3 (nested JSON array) parsed correctly with field mapping and deduplication', async () => {
      clearProviderCooldowns();
      const res = await fetchProviderProxies(`${baseUrl}/format-json-nested`, {
        template: 'json',
      });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.proxies.length, 2, 'Duplicate entry should be filtered');
      assert.strictEqual(res.proxies[0].host, '127.0.0.1');
      assert.strictEqual(res.proxies[0].port, 8086);
      assert.strictEqual(res.proxies[0].username, 'usr1');
      assert.strictEqual(res.proxies[0].password, 'pwd1');
      assert.strictEqual(res.proxies[0].protocol, 'http');
      assert.strictEqual(res.proxies[0].remark, 'node-json-1');

      assert.strictEqual(res.proxies[1].port, 8087);
      assert.strictEqual(res.proxies[1].protocol, 'socks5');
    });

    await check('Format 3 with custom JSON field mappings', async () => {
      clearProviderCooldowns();
      const res = await fetchProviderProxies(`${baseUrl}/format-json-custom-mapping`, {
        template: 'json',
        fieldMapping: {
          ip: 'proxy_ip',
          port: 'proxy_port',
          user: 'account',
          pass: 'auth_pass',
          protocol: 'type',
        },
      });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.proxies.length, 1);
      assert.strictEqual(res.proxies[0].host, '127.0.0.1');
      assert.strictEqual(res.proxies[0].port, 8088);
      assert.strictEqual(res.proxies[0].username, 'custom_u');
      assert.strictEqual(res.proxies[0].password, 'custom_p');
      assert.strictEqual(res.proxies[0].protocol, 'https');
    });

    // --- Test 4: Upper limit protection (单次 <= 500 条) ---
    await check('Single fetch upper limit protection clamps to 500 items', async () => {
      clearProviderCooldowns();
      const res = await fetchProviderProxies(`${baseUrl}/format-overflow`, {
        template: 'text_ip_port',
      });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.proxies.length, 500, `Expected exactly 500 items, got ${res.proxies.length}`);
      assert.strictEqual(MAX_PROVIDER_BATCH_SIZE, 500);
    });

    // --- Test 5: Cooldown / Rate Limiting (频控生效：同一 URL 冷却 60s) ---
    await check('Cooldown rate limiting enforces 60s cooldown per URL and throws ERR_COOLDOWN', async () => {
      clearProviderCooldowns();
      const testUrl = `${baseUrl}/format-ip-port`;

      // First fetch must succeed
      const first = await fetchProviderProxies(testUrl, { template: 'text_ip_port' });
      assert.strictEqual(first.ok, true);

      // Immediate second fetch must throw ERR_COOLDOWN
      let thrown = null;
      try {
        await fetchProviderProxies(testUrl, { template: 'text_ip_port' });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, 'Should have thrown cooldown error');
      assert.strictEqual(thrown.code, 'ERR_COOLDOWN');
      assert.match(thrown.message, /冷却时间为 60 秒/);
      assert.ok(getProviderCooldownRemaining(testUrl) > 55000);

      // Bypass flag must allow immediate re-fetch
      const bypass = await fetchProviderProxies(testUrl, {
        template: 'text_ip_port',
        bypassCooldown: true,
      });
      assert.strictEqual(bypass.ok, true);
    });

    // --- Test 6: Batch Speed Test concurrency & latency sorting ---
    await check('Batch speed test measures RTT, respects <= 16 concurrency, and sorts fast before slow', async () => {
      // Mock fast and slow proxy targets
      const fastProxy = { id: 'p-fast', host: '127.0.0.1', port: 9001, protocol: 'socks5', raw: 'socks5://127.0.0.1:9001' };
      const slowProxy = { id: 'p-slow', host: '127.0.0.1', port: 9002, protocol: 'socks5', raw: 'socks5://127.0.0.1:9002' };
      const errProxy = { id: 'p-err', host: '127.0.0.1', port: 9003, protocol: 'socks5', raw: 'socks5://127.0.0.1:9003' };

      let activeConcurrent = 0;
      let maxSeenConcurrent = 0;

      // Mock probe function simulating realistic RTT delays
      async function mockProbeFn(proxy) {
        activeConcurrent++;
        if (activeConcurrent > maxSeenConcurrent) maxSeenConcurrent = activeConcurrent;
        try {
          if (proxy.id === 'p-fast') {
            await new Promise((r) => setTimeout(r, 15));
            return { ip: '1.1.1.1', countryCode: 'US', latencyMs: 15 };
          }
          if (proxy.id === 'p-slow') {
            await new Promise((r) => setTimeout(r, 70));
            return { ip: '2.2.2.2', countryCode: 'JP', latencyMs: 70 };
          }
          if (proxy.id === 'p-err') {
            await new Promise((r) => setTimeout(r, 10));
            const err = new Error('ECONNREFUSED');
            err.errorClass = 'unreachable';
            err.latencyMs = 10;
            throw err;
          }
          return { ip: '3.3.3.3', countryCode: 'HK', latencyMs: 30 };
        } finally {
          activeConcurrent--;
        }
      }

      // Test with ProxyStore integration
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'proxy-test-'));
      const storePath = path.join(tempDir, 'proxy-store.json');
      const store = new ProxyStore(storePath, { encrypted: false });
      await store.load();

      const createdFast = await store.create(fastProxy);
      const createdSlow = await store.create(slowProxy);
      const createdErr = await store.create(errProxy);

      const batchResult = await batchSpeedTest([createdSlow, createdFast, createdErr], {
        concurrency: 16,
        probeFn: mockProbeFn,
        store,
      });

      assert.strictEqual(batchResult.total, 3);
      assert.strictEqual(batchResult.okCount, 2);
      assert.strictEqual(batchResult.failCount, 1);
      assert.ok(maxSeenConcurrent <= MAX_PROBE_CONCURRENCY, `Max concurrency exceeded limit 16: ${maxSeenConcurrent}`);

      // Verify sorting: fast (15ms) must precede slow (70ms)
      assert.strictEqual(batchResult.sorted[0].id, createdFast.id, 'Fastest proxy must be sorted first');
      assert.strictEqual(batchResult.sorted[1].id, createdSlow.id, 'Slower proxy must be sorted second');
      assert.strictEqual(batchResult.sorted[2].id, createdErr.id, 'Failed proxy sorted last');

      // Verify records written to ProxyStore
      const updatedFast = store.get(createdFast.id);
      assert.strictEqual(updatedFast.lastCheckOk, true);
      assert.strictEqual(updatedFast.lastProbeOk, true);
      assert.ok(updatedFast.lastProbeAt);
      assert.strictEqual(updatedFast.lastIp, '1.1.1.1');
      assert.strictEqual(updatedFast.lastCountryCode, 'US');

      const updatedErr = store.get(createdErr.id);
      assert.strictEqual(updatedErr.lastCheckOk, false);
      assert.strictEqual(updatedErr.lastProbeOk, false);
      assert.strictEqual(updatedErr.lastErrorClass, 'unreachable');

      // Clean up temp dir
      await fsp.rm(tempDir, { recursive: true, force: true });
    });

    // --- Test 7: Failure Blocking Logic (探测失败自动阻断 + 覆盖开关) ---
    await check('Proxy launch check blocks failed probe past retry window and respects override', async () => {
      const now = Date.now();
      const expiredFailProxy = {
        id: 'proxy-fail-expired',
        name: '失效节点',
        host: '10.0.0.1',
        port: 1080,
        protocol: 'socks5',
        raw: 'socks5://10.0.0.1:1080',
        lastProbeOk: false,
        lastProbeAt: new Date(now - 75 * 1000).toISOString(), // 75 seconds ago (> 60s retry window)
      };

      const freshFailProxy = {
        id: 'proxy-fail-fresh',
        name: '新近失败节点',
        host: '10.0.0.2',
        port: 1080,
        protocol: 'socks5',
        raw: 'socks5://10.0.0.2:1080',
        lastProbeOk: false,
        lastProbeAt: new Date(now - 10 * 1000).toISOString(), // 10 seconds ago (< 60s retry window)
      };

      const healthyProxy = {
        id: 'proxy-ok',
        name: '健康节点',
        host: '10.0.0.3',
        port: 1080,
        protocol: 'socks5',
        raw: 'socks5://10.0.0.3:1080',
        lastProbeOk: true,
        lastProbeAt: new Date(now - 80 * 1000).toISOString(),
      };

      // 1. Healthy proxy launch assertion succeeds
      const okResult = checkProxyLaunchHealth(healthyProxy);
      assert.strictEqual(okResult.ok, true);
      assert.doesNotThrow(() => assertProxyLaunchAvailable(healthyProxy));

      // 2. Fresh failure within retry window does not hard block
      const freshResult = checkProxyLaunchHealth(freshFailProxy, { retryWindowMs: 60000 });
      assert.strictEqual(freshResult.ok, true, 'Fresh failure within retry window should not hard block');

      // 3. Expired failure past retry window is blocked with code proxy-required
      const blockedResult = checkProxyLaunchHealth(expiredFailProxy, { retryWindowMs: 60000 });
      assert.strictEqual(blockedResult.ok, false);
      assert.strictEqual(blockedResult.code, 'proxy-required');
      assert.match(blockedResult.reason, /探测失败且已过重试窗口/);

      let launchError = null;
      try {
        assertProxyLaunchAvailable(expiredFailProxy, { retryWindowMs: 60000 });
      } catch (err) {
        launchError = err;
      }
      assert.ok(launchError, 'Should throw launch error');
      assert.strictEqual(launchError.code, 'proxy-required');
      assert.match(launchError.message, /仍要启动/);

      // 4. Override switch allows launch despite failure
      const overrideResult1 = checkProxyLaunchHealth(expiredFailProxy, { allowFailedProxy: true });
      assert.strictEqual(overrideResult1.ok, true, 'allowFailedProxy override must succeed');

      const overrideResult2 = checkProxyLaunchHealth(expiredFailProxy, { ignoreBrokenProxy: true });
      assert.strictEqual(overrideResult2.ok, true, 'ignoreBrokenProxy override must succeed');

      assert.doesNotThrow(() => {
        assertProxyLaunchAvailable(expiredFailProxy, { allowFailed: true });
      });
    });

    // --- Test 8: Engine prepareProfileProxyForStart integration with failure blocking ---
    await check('Engine.prepareProfileProxyForStart blocks failed proxy and honors override switch', async () => {
      const now = Date.now();
      const mockProxy = {
        id: 'engine-linked-proxy',
        name: '坏节点',
        host: '192.0.2.10',
        port: 1080,
        protocol: 'socks5',
        raw: 'socks5://192.0.2.10:1080',
        lastProbeOk: false,
        lastProbeAt: new Date(now - 90 * 1000).toISOString(), // 90s ago
      };

      const mockStore = {
        get: (id) => (id === mockProxy.id ? mockProxy : null),
        assertLaunchAvailable: (proxy, opts) => assertProxyLaunchAvailable(proxy, opts),
      };

      const engine = Object.create(BrowserEngine.prototype);
      engine.networkInfo = new Map();
      engine.profiles = new Map();
      engine.emit = () => {};
      engine.sanitizeProfile = (p) => sanitizeProfile(p);
      engine.resolveStoredProxyProfile = (profile) => ({
        ...profile,
        proxy: mockProxy.raw,
        proxyId: mockProxy.id,
      });
      engine.proxyStore = mockStore;

      // Profile without override -> must be blocked
      const normalProfile = {
        id: 'test-fail-profile',
        name: 'Blocked Profile',
        networkMode: 'proxy',
        proxyId: mockProxy.id,
        proxyMeta: {
          proxyId: mockProxy.id,
          allowFailedProxy: false,
        },
      };

      let blockedErr = null;
      try {
        await engine.prepareProfileProxyForStart(normalProfile);
      } catch (err) {
        blockedErr = err;
      }
      assert.ok(blockedErr, 'Normal profile must be blocked by failed proxy');
      assert.strictEqual(blockedErr.code, 'proxy-required');
      assert.match(blockedErr.message, /探测失败且已过重试窗口/);

      // Profile with allowFailedProxy = true -> override succeeds
      const overrideProfile = {
        id: 'test-override-profile',
        name: 'Override Profile',
        networkMode: 'proxy',
        proxyId: mockProxy.id,
        proxyMeta: {
          proxyId: mockProxy.id,
          allowFailedProxy: true,
        },
      };

      // Mock testProxy for network check if engine proceeds
      engine.testProxy = async () => ({ ip: '192.0.2.10', countryCode: 'US' });
      engine.applyNetworkToProfile = () => {};

      const prepared = await engine.prepareProfileProxyForStart(overrideProfile);
      assert.ok(prepared, 'Override profile must successfully prepare');
      assert.strictEqual(prepared.networkMode, 'proxy');
    });

    // --- Test 9: SSRF Guard on metadata endpoints ---
    await check('fetchProviderProxies blocks cloud metadata addresses (anti-SSRF)', async () => {
      let thrown = null;
      try {
        await fetchProviderProxies('http://169.254.169.254/latest/meta-data', { bypassCooldown: true });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, 'Should have blocked SSRF target');
      assert.match(thrown.message, /防 SSRF|metadata/i);
    });

  } finally {
    await new Promise((resolve) => mockServer.close(resolve));
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n========================================`);
  console.log(`Proxy Providers Selftest Results: ${passed}/${total} passed`);
  console.log(`========================================\n`);

  if (passed !== total) {
    process.exitCode = 1;
  }
})();
