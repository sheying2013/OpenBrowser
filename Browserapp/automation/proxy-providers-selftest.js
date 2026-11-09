'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const {
  fetchUrlText,
  isCloudMetadataHostname,
  isPrivateOrLocalHostname,
  createPinnedLookup,
} = require('../proxy-forwarder');

const {
  fetchProviderProxies,
  parseProviderResponse,
  buildCanonicalProxyItem,
  batchSpeedTest,
  clearProviderCooldowns,
  getProviderCooldownRemaining,
  MAX_PROVIDER_BATCH_SIZE,
  MAX_BATCH_SPEED_TEST,
  PROVIDER_COOLDOWN_MS,
  MAX_PROBE_CONCURRENCY,
} = require('./proxy-providers');

const {
  ProxyStore,
  normalizeProxyRecord,
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

    if (url.pathname === '/redirect-to-metadata') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
      return;
    }

    if (url.pathname === '/slow-chain-1') {
      setTimeout(() => {
        res.writeHead(302, { Location: '/slow-chain-2' });
        res.end();
      }, 40);
      return;
    }

    if (url.pathname === '/slow-chain-2') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('chain-ok');
      }, 40);
      return;
    }

    if (url.pathname === '/redirect-to-domain') {
      res.writeHead(302, { Location: 'http://redirect-metadata.test/meta' });
      res.end();
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
        allowPrivate: true,
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
        allowPrivate: true,
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
        allowPrivate: true,
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
        allowPrivate: true,
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
        allowPrivate: true,
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
      const first = await fetchProviderProxies(testUrl, { template: 'text_ip_port', allowPrivate: true });
      assert.strictEqual(first.ok, true);

      // Immediate second fetch must throw ERR_COOLDOWN
      let thrown = null;
      try {
        await fetchProviderProxies(testUrl, { template: 'text_ip_port', allowPrivate: true });
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
        allowPrivate: true,
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

    // --- Test 9: SSRF Guard on metadata endpoints and loopback defaults ---
    await check('fetchProviderProxies blocks cloud metadata addresses (anti-SSRF)', async () => {
      // 1. Default allowPrivate: false blocks loopback
      let defaultLoopbackBlocked = null;
      try {
        await fetchProviderProxies(`${baseUrl}/format-ip-port`, { bypassCooldown: true });
      } catch (err) {
        defaultLoopbackBlocked = err;
      }
      assert.ok(defaultLoopbackBlocked, 'Default allowPrivate must block loopback without explicit allowPrivate: true');
      assert.match(defaultLoopbackBlocked.message, /防 SSRF|本机|内网/i);

      // 2. Standard IPv4 metadata
      let thrownMeta = null;
      try {
        await fetchProviderProxies('http://169.254.169.254/latest/meta-data', { bypassCooldown: true });
      } catch (err) {
        thrownMeta = err;
      }
      assert.ok(thrownMeta, 'Should have blocked 169.254.169.254');
      assert.match(thrownMeta.message, /防 SSRF|metadata/i);

      // 3. IPv4-mapped IPv6 metadata (::ffff:169.254.169.254)
      let thrownMapped = null;
      try {
        await fetchProviderProxies('http://[::ffff:169.254.169.254]/latest/meta-data', { bypassCooldown: true });
      } catch (err) {
        thrownMapped = err;
      }
      assert.ok(thrownMapped, 'Should have blocked ::ffff:169.254.169.254');
      assert.match(thrownMapped.message, /防 SSRF|metadata/i);

      // 4. CGNAT metadata endpoint (100.100.100.200)
      let thrownAli = null;
      try {
        await fetchProviderProxies('http://100.100.100.200/latest/meta-data', { bypassCooldown: true });
      } catch (err) {
        thrownAli = err;
      }
      assert.ok(thrownAli, 'Should have blocked 100.100.100.200');
      assert.match(thrownAli.message, /防 SSRF|metadata/i);

      // 5. IPv6 IMDS endpoint (fd00:ec2::254)
      let thrownAwsV6 = null;
      try {
        await fetchProviderProxies('http://[fd00:ec2::254]/latest/meta-data', { bypassCooldown: true });
      } catch (err) {
        thrownAwsV6 = err;
      }
      assert.ok(thrownAwsV6, 'Should have blocked fd00:ec2::254');
      assert.match(thrownAwsV6.message, /防 SSRF|metadata/i);

      // 6. Internal metadata hostname with trailing dot (metadata.google.internal.)
      let thrownDot = null;
      try {
        await fetchProviderProxies('http://metadata.google.internal./computeMetadata/v1/', { bypassCooldown: true });
      } catch (err) {
        thrownDot = err;
      }
      assert.ok(thrownDot, 'Should have blocked metadata.google.internal.');
      assert.match(thrownDot.message, /防 SSRF|metadata/i);

      // 7. Loopback 302 redirecting to metadata must be blocked even when allowPrivate: true
      let thrownRedirect = null;
      try {
        await fetchProviderProxies(`${baseUrl}/redirect-to-metadata`, {
          bypassCooldown: true,
          allowPrivate: true,
        });
      } catch (err) {
        thrownRedirect = err;
      }
      assert.ok(thrownRedirect, 'Loopback redirect to metadata must be blocked');
      assert.match(thrownRedirect.message, /防 SSRF|metadata/i);
    });

    // --- Test 10: IPv6 address formatting in buildCanonicalProxyItem ---
    await check('buildCanonicalProxyItem formats IPv6 host with brackets', async () => {
      const item = buildCanonicalProxyItem({ host: '2001:db8::1', port: 8080 });
      assert.ok(item);
      assert.strictEqual(item.raw, 'socks5://[2001:db8::1]:8080');
      assert.strictEqual(item.name, '[2001:db8::1]:8080');

      const itemWithBrackets = buildCanonicalProxyItem({ host: '[2001:db8::2]', port: 9090 });
      assert.ok(itemWithBrackets);
      assert.strictEqual(itemWithBrackets.raw, 'socks5://[2001:db8::2]:9090');
      assert.strictEqual(itemWithBrackets.name, '[2001:db8::2]:9090');
    });

    // --- Test 11: normalizeProxyRecord clears failure status when node parameters change ---
    await check('normalizeProxyRecord clears failure status when node configuration changes', async () => {
      const existing = normalizeProxyRecord({
        id: 'p1',
        host: '198.51.100.1',
        port: 1080,
        protocol: 'socks5',
        username: 'u1',
        password: 'p1',
        lastCheck: '2026-01-01T00:00:00.000Z',
        lastCheckOk: false,
        lastProbeOk: false,
        lastErrorClass: 'unreachable',
        lastError: 'ECONNREFUSED',
        lastIp: '1.2.3.4',
        lastCountry: 'US',
        lastCountryCode: 'US',
        lastLatencyMs: 999,
      });

      // 1. Changing host must reset failure state
      const updatedHost = normalizeProxyRecord({
        id: 'p1',
        host: '198.51.100.2',
      }, existing);
      assert.strictEqual(updatedHost.lastCheck, null);
      assert.strictEqual(updatedHost.lastCheckOk, null);
      assert.strictEqual(updatedHost.lastProbeOk, null);
      assert.strictEqual(updatedHost.lastErrorClass, '');
      assert.strictEqual(updatedHost.lastIp, '');
      assert.strictEqual(updatedHost.lastCountry, '');

      // 2. Changing port must reset failure state
      const updatedPort = normalizeProxyRecord({
        id: 'p1',
        port: 1081,
      }, existing);
      assert.strictEqual(updatedPort.lastCheckOk, null);
      assert.strictEqual(updatedPort.lastErrorClass, '');

      // 3. Changing password must reset failure state
      const updatedPass = normalizeProxyRecord({
        id: 'p1',
        password: 'new-password',
      }, existing);
      assert.strictEqual(updatedPass.lastCheckOk, null);
      assert.strictEqual(updatedPass.lastErrorClass, '');

      // 4. proxyAuthAction: clear must reset failure state
      const clearedAuth = normalizeProxyRecord({
        id: 'p1',
        proxyAuthAction: 'clear',
      }, existing);
      assert.strictEqual(clearedAuth.lastCheckOk, null);
      assert.strictEqual(clearedAuth.lastErrorClass, '');

      // 5. Unchanged node details preserve check state
      const unchanged = normalizeProxyRecord({
        id: 'p1',
        remark: 'new remark only',
      }, existing);
      assert.strictEqual(unchanged.lastCheckOk, false);
      assert.strictEqual(unchanged.lastErrorClass, 'unreachable');
    });

    // --- Test 12: probe-unavailable does NOT block opening windows in checkProxyLaunchHealth ---
    await check('checkProxyLaunchHealth passes when lastErrorClass is probe-unavailable', async () => {
      const probeUnavailProxy = {
        id: 'p-probe-unavail',
        name: '限频节点',
        host: '198.51.100.5',
        port: 1080,
        protocol: 'socks5',
        raw: 'socks5://198.51.100.5:1080',
        lastProbeOk: false,
        lastErrorClass: 'probe-unavailable',
        lastProbeAt: new Date(Date.now() - 90 * 1000).toISOString(),
      };
      const health = checkProxyLaunchHealth(probeUnavailProxy);
      assert.strictEqual(health.ok, true, 'probe-unavailable must allow launch for dynamic re-probing');
      assert.strictEqual(health.probeUnavailable, true);
    });

    // --- Test 13: sanitizeProfile allowFailedProxy toggle uncheck ---
    await check('sanitizeProfile allows unchecking allowFailedProxy without stale override', async () => {
      const profileWithStaleTopLevel = {
        id: 'prof-test-toggle',
        name: 'Toggle Test Profile',
        networkMode: 'proxy',
        allowFailedProxy: true,
        proxyMeta: {
          allowFailedProxy: false,
        },
      };
      const sanitized = sanitizeProfile(profileWithStaleTopLevel);
      assert.strictEqual(sanitized.allowFailedProxy, false, 'Explicit false in proxyMeta must take precedence over stale top-level true');
      assert.strictEqual(sanitized.proxyMeta.allowFailedProxy, false);
    });

    // --- Test 14: ProxyStore batchMarkCheck updates multiple entries in a single commit ---
    await check('ProxyStore batchMarkCheck updates multiple entries in a single commit', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'proxy-batch-test-'));
      const storePath = path.join(tempDir, 'proxy-store.json');
      const store = new ProxyStore(storePath, { encrypted: false });
      await store.load();

      const p1 = await store.create({ host: '198.51.100.10', port: 1080, protocol: 'socks5' });
      const p2 = await store.create({ host: '198.51.100.11', port: 1080, protocol: 'socks5' });

      const updated = await store.batchMarkCheck([
        { id: p1.id, ok: true, ip: '1.2.3.4', countryCode: 'US', country: 'United States', latencyMs: 50 },
        { id: p2.id, ok: false, errorClass: 'unreachable', error: 'ECONNREFUSED', latencyMs: 20 },
      ]);

      assert.strictEqual(updated.length, 2);
      const reloaded1 = store.get(p1.id);
      assert.strictEqual(reloaded1.lastCheckOk, true);
      assert.strictEqual(reloaded1.lastIp, '1.2.3.4');
      assert.strictEqual(reloaded1.lastCountry, 'United States');

      const reloaded2 = store.get(p2.id);
      assert.strictEqual(reloaded2.lastCheckOk, false);
      assert.strictEqual(reloaded2.lastErrorClass, 'unreachable');

      await fsp.rm(tempDir, { recursive: true, force: true });
    });

    // --- Test 15: NAT64 and 6to4 embedded metadata and private address classification ---
    await check('NAT64 64:ff9b::/96 and 6to4 2002::/16 embedded metadata and private IP handling', async () => {
      // 1. NAT64 metadata (dotted-quad and hex)
      assert.strictEqual(isCloudMetadataHostname('64:ff9b::169.254.169.254'), true);
      assert.strictEqual(isCloudMetadataHostname('64:ff9b::a9fe:a9fe'), true);
      assert.strictEqual(isCloudMetadataHostname('64:ff9b::100.100.100.200'), true);
      assert.strictEqual(isCloudMetadataHostname('64:ff9b::6464:64c8'), true);
      assert.strictEqual(isCloudMetadataHostname('64:ff9b::169.254.170.2'), true);

      // RFC 6052 /48 layout for 64:ff9b:1::/48
      assert.strictEqual(isCloudMetadataHostname('64:ff9b:1:a9fe:a9:fe00::'), true);
      assert.strictEqual(isCloudMetadataHostname('64:ff9b:1:a9fe:a9:fe00::1'), true);
      assert.strictEqual(isCloudMetadataHostname('64:ff9b:1:6464:64:c800::'), true);
      assert.strictEqual(isCloudMetadataHostname('64:ff9b:1:a9fe:aa:200::'), true);
      assert.strictEqual(isCloudMetadataHostname('64:ff9b:1:c0a8:1:100::'), false);
      assert.strictEqual(isPrivateOrLocalHostname('64:ff9b:1:c0a8:1:100::'), true);
      assert.strictEqual(isCloudMetadataHostname('64:ff9b:1::a9fe:a9fe'), true);

      // 2. 6to4 metadata
      assert.strictEqual(isCloudMetadataHostname('2002:a9fe:a9fe::1'), true);
      assert.strictEqual(isCloudMetadataHostname('2002:a9fe:a9fe::'), true);
      assert.strictEqual(isCloudMetadataHostname('2002:6464:64c8::1'), true);
      assert.strictEqual(isCloudMetadataHostname('2002:a9fe:aa02::1'), true);

      // 3. NAT64 and 6to4 private IPs (not metadata, but isPrivate)
      assert.strictEqual(isCloudMetadataHostname('64:ff9b::192.168.1.1'), false);
      assert.strictEqual(isPrivateOrLocalHostname('64:ff9b::192.168.1.1'), true);
      assert.strictEqual(isCloudMetadataHostname('64:ff9b::127.0.0.1'), false);
      assert.strictEqual(isPrivateOrLocalHostname('64:ff9b::127.0.0.1'), true);

      assert.strictEqual(isCloudMetadataHostname('2002:c0a8:0101::1'), false);
      assert.strictEqual(isPrivateOrLocalHostname('2002:c0a8:0101::1'), true);
      assert.strictEqual(isCloudMetadataHostname('2002:7f00:0001::'), false);
      assert.strictEqual(isPrivateOrLocalHostname('2002:7f00:0001::'), true);
      assert.strictEqual(isCloudMetadataHostname('2002:0a00:0001::'), false);
      assert.strictEqual(isPrivateOrLocalHostname('2002:0a00:0001::'), true);

      // 4. NAT64 and 6to4 public IPs (neither metadata nor private)
      assert.strictEqual(isCloudMetadataHostname('64:ff9b::8.8.8.8'), false);
      assert.strictEqual(isPrivateOrLocalHostname('64:ff9b::8.8.8.8'), false);
      assert.strictEqual(isCloudMetadataHostname('2002:0808:0808::1'), false);
      assert.strictEqual(isPrivateOrLocalHostname('2002:0808:0808::1'), false);

      // 5. fetchProviderProxies blocks NAT64 and 6to4 metadata even with allowPrivate: true
      let errNat64 = null;
      try {
        await fetchProviderProxies('http://[64:ff9b::169.254.169.254]/meta', {
          bypassCooldown: true,
          allowPrivate: true,
        });
      } catch (err) {
        errNat64 = err;
      }
      assert.ok(errNat64, 'NAT64 metadata must be blocked even when allowPrivate: true');
      assert.match(errNat64.message, /防 SSRF|metadata/i);

      let errNat6448 = null;
      try {
        await fetchProviderProxies('http://[64:ff9b:1:a9fe:a9:fe00::]/meta', {
          bypassCooldown: true,
          allowPrivate: true,
        });
      } catch (err) {
        errNat6448 = err;
      }
      assert.ok(errNat6448, 'NAT64 /48 layout metadata must be blocked even when allowPrivate: true');
      assert.match(errNat6448.message, /防 SSRF|metadata/i);

      let err6to4 = null;
      try {
        await fetchProviderProxies('http://[2002:a9fe:a9fe::1]/meta', {
          bypassCooldown: true,
          allowPrivate: true,
        });
      } catch (err) {
        err6to4 = err;
      }
      assert.ok(err6to4, '6to4 metadata must be blocked even when allowPrivate: true');
      assert.match(err6to4.message, /防 SSRF|metadata/i);
    });

    // --- Test 16: fetchUrlText DNS check and pinning rejects cloud metadata even when allowPrivate is true ---
    await check('fetchUrlText performs DNS check and pinning to reject metadata even when allowPrivate is true', async () => {
      // 1. Hostname resolving to IPv4 metadata (169.254.169.254) with allowPrivate: true
      let errV4Meta = null;
      try {
        await fetchUrlText('http://fake-meta-host.local/info', {
          allowPrivate: true,
          dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }],
        });
      } catch (err) {
        errV4Meta = err;
      }
      assert.ok(errV4Meta, 'Hostname resolving to 169.254.169.254 must be blocked even with allowPrivate: true');
      assert.match(errV4Meta.message, /防 SSRF|metadata/i);

      // 2. Hostname resolving to 100.100.100.200 with allowPrivate: true
      let errAliMeta = null;
      try {
        await fetchUrlText('http://fake-ali-meta.local/info', {
          allowPrivate: true,
          dnsLookup: async () => [{ address: '100.100.100.200', family: 4 }],
        });
      } catch (err) {
        errAliMeta = err;
      }
      assert.ok(errAliMeta, 'Hostname resolving to 100.100.100.200 must be blocked');
      assert.match(errAliMeta.message, /防 SSRF|metadata/i);

      // 3. Hostname resolving to fd00:ec2::254
      let errAwsV6 = null;
      try {
        await fetchUrlText('http://fake-awsv6-meta.local/info', {
          allowPrivate: true,
          dnsLookup: async () => [{ address: 'fd00:ec2::254', family: 6 }],
        });
      } catch (err) {
        errAwsV6 = err;
      }
      assert.ok(errAwsV6, 'Hostname resolving to fd00:ec2::254 must be blocked');
      assert.match(errAwsV6.message, /防 SSRF|metadata/i);

      // 4. Hostname resolving to NAT64 metadata (64:ff9b::a9fe:a9fe)
      let errNat64Dns = null;
      try {
        await fetchUrlText('http://fake-nat64-meta.local/info', {
          allowPrivate: true,
          dnsLookup: async () => [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
        });
      } catch (err) {
        errNat64Dns = err;
      }
      assert.ok(errNat64Dns, 'Hostname resolving to NAT64 metadata must be blocked');
      assert.match(errNat64Dns.message, /防 SSRF|metadata/i);

      // 5. Hostname resolving to 6to4 metadata (2002:a9fe:a9fe::1)
      let err6to4Dns = null;
      try {
        await fetchUrlText('http://fake-6to4-meta.local/info', {
          allowPrivate: true,
          dnsLookup: async () => [{ address: '2002:a9fe:a9fe::1', family: 6 }],
        });
      } catch (err) {
        err6to4Dns = err;
      }
      assert.ok(err6to4Dns, 'Hostname resolving to 6to4 metadata must be blocked');
      assert.match(err6to4Dns.message, /防 SSRF|metadata/i);

      // 6. Dual resolution containing both safe loopback and metadata address -> MUST throw
      let errDual = null;
      try {
        await fetchUrlText('http://fake-dual-rebind.local/info', {
          allowPrivate: true,
          dnsLookup: async () => [
            { address: '127.0.0.1', family: 4 },
            { address: '169.254.169.254', family: 4 },
          ],
        });
      } catch (err) {
        errDual = err;
      }
      assert.ok(errDual, 'Dual-record resolution with metadata must be blocked');
      assert.match(errDual.message, /防 SSRF|metadata/i);

      // 7. Non-metadata loopback resolution succeeds when allowPrivate: true (compatibility preserved)
      const loopbackResult = await fetchUrlText(`http://local-test-domain.test:${serverPort}/format-ip-port`, {
        allowPrivate: true,
        dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
      });
      assert.strictEqual(loopbackResult.status, 200);
      assert.match(loopbackResult.body, /127\.0\.0\.1:8081/);

      // 8. Non-metadata loopback resolution rejected when allowPrivate: false
      let errPrivateBlocked = null;
      try {
        await fetchUrlText(`http://local-test-domain.test:${serverPort}/format-ip-port`, {
          allowPrivate: false,
          dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
        });
      } catch (err) {
        errPrivateBlocked = err;
      }
      assert.ok(errPrivateBlocked, 'Loopback resolution must be blocked when allowPrivate: false');
      assert.match(errPrivateBlocked.message, /本机|内网/i);
    });

    // --- Test 17: createPinnedLookup supports multi-record returns with opts.all and family filtering ---
    await check('createPinnedLookup supports multi-record returns and family filtering', async () => {
      const records = [
        { address: '192.0.2.1', family: 4 },
        { address: '192.0.2.2', family: 4 },
        { address: '2001:db8::1', family: 6 },
      ];
      const lookup = createPinnedLookup(records, 'test.example.com');

      // 1. opts.all: true returns all matched records
      await new Promise((resolve, reject) => {
        lookup('test.example.com', { all: true }, (err, results) => {
          if (err) return reject(err);
          assert.strictEqual(Array.isArray(results), true);
          assert.strictEqual(results.length, 3);
          assert.strictEqual(results[0].address, '192.0.2.1');
          assert.strictEqual(results[0].family, 4);
          assert.strictEqual(results[2].address, '2001:db8::1');
          assert.strictEqual(results[2].family, 6);
          resolve();
        });
      });

      // 2. opts.all: true with family: 4 filters to IPv4 only
      await new Promise((resolve, reject) => {
        lookup('test.example.com', { family: 4, all: true }, (err, results) => {
          if (err) return reject(err);
          assert.strictEqual(results.length, 2);
          assert.strictEqual(results.every((r) => r.family === 4), true);
          resolve();
        });
      });

      // 3. opts.all: true with family: 6 filters to IPv6 only
      await new Promise((resolve, reject) => {
        lookup('test.example.com', { family: 6, all: true }, (err, results) => {
          if (err) return reject(err);
          assert.strictEqual(results.length, 1);
          assert.strictEqual(results[0].address, '2001:db8::1');
          assert.strictEqual(results[0].family, 6);
          resolve();
        });
      });

      // 4. opts.family: 4 (single address)
      await new Promise((resolve, reject) => {
        lookup('test.example.com', { family: 4 }, (err, address, family) => {
          if (err) return reject(err);
          assert.strictEqual(address, '192.0.2.1');
          assert.strictEqual(family, 4);
          resolve();
        });
      });

      // 5. opts.family: 6 (single address)
      await new Promise((resolve, reject) => {
        lookup('test.example.com', { family: 6 }, (err, address, family) => {
          if (err) return reject(err);
          assert.strictEqual(address, '2001:db8::1');
          assert.strictEqual(family, 6);
          resolve();
        });
      });

      // 6. Family filtering error when no matching records
      const ipv4Only = [{ address: '192.0.2.1', family: 4 }];
      const lookupV4Only = createPinnedLookup(ipv4Only, 'v4.example.com');
      await new Promise((resolve, reject) => {
        lookupV4Only('v4.example.com', { family: 6 }, (err) => {
          assert.ok(err, 'Family 6 request on IPv4-only records must fail');
          assert.strictEqual(err.code, 'ENOTFOUND');
          resolve();
        });
      });
    });

    // --- Test 18: Redirect re-validation and HTTPS downgrade prohibition ---
    await check('fetchUrlText re-validates redirects and prohibits HTTPS downgrade to HTTP', async () => {
      // 1. HTTPS downgrade to HTTP prohibition
      const origHttpsRequest = https.request;
      try {
        https.request = (url, opts, cb) => {
          const fakeRes = new EventEmitter();
          fakeRes.statusCode = 302;
          fakeRes.headers = { location: `http://127.0.0.1:${serverPort}/format-ip-port` };
          fakeRes.resume = () => {};
          const fakeReq = new EventEmitter();
          fakeReq.end = () => process.nextTick(() => cb(fakeRes));
          fakeReq.destroy = () => {};
          return fakeReq;
        };

        let errDowngrade = null;
        try {
          await fetchUrlText(`https://127.0.0.1:${serverPort}/secure`, { allowPrivate: true });
        } catch (err) {
          errDowngrade = err;
        }
        assert.ok(errDowngrade, 'HTTPS to HTTP downgrade must be rejected');
        assert.match(errDowngrade.message, /禁止 HTTPS 降级到 HTTP/);
      } finally {
        https.request = origHttpsRequest;
      }

      // 2. Redirect destination DNS re-validation against metadata
      let errRedirectMeta = null;
      try {
        await fetchUrlText(`${baseUrl}/redirect-to-domain`, {
          allowPrivate: true,
          dnsLookup: async (h) => {
            if (h === 'redirect-metadata.test') {
              return [{ address: '169.254.169.254', family: 4 }];
            }
            return [{ address: '127.0.0.1', family: 4 }];
          },
        });
      } catch (err) {
        errRedirectMeta = err;
      }
      assert.ok(errRedirectMeta, 'Redirect to domain resolving to metadata must be blocked');
      assert.match(errRedirectMeta.message, /防 SSRF|metadata/i);
    });

    // --- Test 19: Unified absolute deadline across DNS, redirects, and responses ---
    await check('fetchUrlText enforces unified absolute deadline across DNS, redirects, and responses', async () => {
      // 1. Slow redirect chain exceeding overall timeout must fail with 请求超时
      // Chain takes 40ms + 40ms = 80ms. With timeout: 50, it must timeout.
      const t0 = Date.now();
      let errChainTimeout = null;
      try {
        await fetchUrlText(`${baseUrl}/slow-chain-1`, {
          timeout: 50,
          allowPrivate: true,
        });
      } catch (err) {
        errChainTimeout = err;
      }
      const elapsedChain = Date.now() - t0;
      assert.ok(errChainTimeout, 'Chain exceeding cumulative timeout must fail');
      assert.strictEqual(errChainTimeout.message, '请求超时');
      assert.ok(elapsedChain < 200, `Timed out in reasonable time: ${elapsedChain}ms`);

      // 2. Same chain within sufficient timeout must succeed
      const okChain = await fetchUrlText(`${baseUrl}/slow-chain-1`, {
        timeout: 300,
        allowPrivate: true,
      });
      assert.strictEqual(okChain.status, 200);
      assert.strictEqual(okChain.body, 'chain-ok');

      // 3. Slow DNS lookup exceeding unified timeout must fail with 请求超时
      const t1 = Date.now();
      let errDnsTimeout = null;
      try {
        await fetchUrlText(`http://fake-slow-dns.test:${serverPort}/format-ip-port`, {
          timeout: 50,
          allowPrivate: true,
          dnsLookup: () => new Promise((resolve) => setTimeout(() => resolve([{ address: '127.0.0.1', family: 4 }]), 150)),
        });
      } catch (err) {
        errDnsTimeout = err;
      }
      const elapsedDns = Date.now() - t1;
      assert.ok(errDnsTimeout, 'Slow DNS lookup exceeding unified timeout must fail');
      assert.strictEqual(errDnsTimeout.message, '请求超时');
      assert.ok(elapsedDns < 150, `DNS timed out in reasonable time: ${elapsedDns}ms`);
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
