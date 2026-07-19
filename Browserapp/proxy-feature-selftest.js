'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  extractProxyFromApi,
  extractProxyStrings,
  invokeProxyRefresh,
  classifyProxyError,
  parseProxy,
} = require('./proxy-forwarder');
const { ProxyStore } = require('./automation/proxy-store');

function makeEngineStub() {
  // Lightweight stub around real methods by requiring engine and monkeypatching heavy deps is hard.
  // Instead re-implement prepare flow checks via public helpers + a minimal harness of BrowserEngine methods.
  const { BrowserEngine } = require('./engine');
  const engine = Object.create(BrowserEngine.prototype);
  engine.profiles = new Map();
  engine.networkInfo = new Map();
  engine.running = new Map();
  engine.listeners = new Set();
  engine.persist = async () => {};
  engine.emit = () => {};
  // bind methods that use this
  engine.sanitizeProfile = BrowserEngine.prototype.sanitizeProfile.bind(engine);
  engine.resolveProfileProxyConfig = BrowserEngine.prototype.resolveProfileProxyConfig.bind(engine);
  engine.fingerprintPatchFromNetwork = BrowserEngine.prototype.fingerprintPatchFromNetwork.bind(engine);
  engine.applyNetworkToProfile = BrowserEngine.prototype.applyNetworkToProfile.bind(engine);
  engine.testProxy = BrowserEngine.prototype.testProxy.bind(engine);
  engine.checkProxy = BrowserEngine.prototype.checkProxy.bind(engine);
  engine.prepareProfileProxyForStart = BrowserEngine.prototype.prepareProfileProxyForStart.bind(engine);
  engine.refreshProfileProxy = BrowserEngine.prototype.refreshProfileProxy.bind(engine);
  engine.applyResolvedLocale = BrowserEngine.prototype.applyResolvedLocale.bind(engine);
  return engine;
}

async function main() {
  // --- extract / refresh local HTTP ---
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/extract-text')) {
      res.end('socks5://dynuser:dynpass@10.20.30.40:1080');
      return;
    }
    if (req.url.startsWith('/extract-json')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: { host: '10.20.30.50', port: 9090, username: 'j', password: 'k', protocol: 'http' } }));
      return;
    }
    if (req.url.startsWith('/refresh')) {
      res.end('rotated');
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const t1 = await extractProxyFromApi(`${base}/extract-text`);
  assert.strictEqual(t1.host, '10.20.30.40');
  assert.strictEqual(t1.port, 1080);
  assert.strictEqual(t1.username, 'dynuser');
  const t2 = await extractProxyFromApi(`${base}/extract-json`);
  assert.strictEqual(t2.host, '10.20.30.50');
  assert.strictEqual(t2.port, 9090);
  assert.strictEqual(t2.protocol, 'http');
  const refreshed = await invokeProxyRefresh(`${base}/refresh`);
  assert.strictEqual(refreshed.ok, true);
  assert.ok(extractProxyStrings('a\nsocks5://1.1.1.1:1\nb').some((s) => s.includes('1.1.1.1')));

  // --- sanitize keeps new fields ---
  const engine = makeEngineStub();
  const sanitized = engine.sanitizeProfile({
    id: 'prof_proxy_feature_1',
    name: 'proxy-feature',
    networkMode: 'proxy',
    proxy: 'socks5://127.0.0.1:1080',
    proxyMeta: {
      checkOnStart: true,
      refreshOnStart: true,
      apiExtractUrl: `${base}/extract-text`,
      refreshUrl: `${base}/refresh`,
      backupProxies: ['socks5://127.0.0.1:1081', 'http://127.0.0.1:8080'],
      fillFingerprint: false,
    },
    privacy: { languageMode: 'ip', timezoneMode: 'ip', geoMode: 'ip' },
  });
  assert.strictEqual(sanitized.proxyMeta.refreshOnStart, true);
  assert.strictEqual(sanitized.proxyMeta.fillFingerprint, false);
  assert.deepStrictEqual(sanitized.proxyMeta.backupProxies, ['socks5://127.0.0.1:1081', 'http://127.0.0.1:8080']);
  assert.ok(sanitized.proxyMeta.apiExtractUrl.includes('/extract-text'));

  // --- prepare without check flags must not throw for static proxy ---
  const quiet = await engine.prepareProfileProxyForStart({
    id: 'prof_proxy_feature_2',
    name: 'quiet',
    networkMode: 'proxy',
    proxy: 'socks5://127.0.0.1:1080',
    proxyMeta: { checkOnStart: false, refreshOnStart: false },
    privacy: {},
  });
  assert.strictEqual(quiet.proxy.includes('127.0.0.1:1080'), true);

  // --- prepare direct without extract must stay direct ---
  const direct = await engine.prepareProfileProxyForStart({
    id: 'prof_proxy_feature_3',
    name: 'direct',
    networkMode: 'direct',
    proxy: 'Direct',
    proxyMeta: {},
    privacy: {},
  });
  assert.ok(/direct/i.test(direct.proxy) || direct.networkMode === 'direct');

  // --- prepare with extract overwrites proxy even if check not required fails later ---
  // extract succeeds; check skipped if no checkOnStart and no refreshOnStart - wait, extractUrl forces shouldCheck true
  // So prepare with extract will try testProxy which needs real network - mock testProxy
  const engine2 = makeEngineStub();
  let tested = [];
  engine2.testProxy = async (profile, options = {}) => {
    const forced = String(options.proxy || options.forcedProxy || '').trim();
    const target = forced || profile.proxy;
    tested.push({ target, forced, source: options.proxySource || null, profileProxy: profile.proxy });
    if (String(target).includes('10.20.30.40')) {
      const err = new Error('primary dead');
      err.errorClass = 'unreachable';
      throw err;
    }
    if (String(target).includes('1081')) {
      return {
        ip: '198.51.100.2',
        countryCode: 'US',
        timezone: 'America/New_York',
        latitude: 40.7,
        longitude: -74,
        latencyMs: 88,
        networkType: 'hosting',
        checkedAt: new Date().toISOString(),
        protocol: 'socks5',
        endpoint: '127.0.0.1:1081',
        proxySource: options.proxySource || 'backup',
        proxyRaw: target,
      };
    }
    const err = new Error('fail');
    err.errorClass = 'unknown';
    throw err;
  };
  const failedOver = await engine2.prepareProfileProxyForStart({
    id: 'prof_proxy_feature_4',
    name: 'failover',
    networkMode: 'proxy',
    proxy: 'socks5://old:old@1.1.1.1:1',
    proxyMeta: {
      checkOnStart: true,
      apiExtractUrl: `${base}/extract-text`,
      backupProxies: ['socks5://127.0.0.1:1081', 'socks5://127.0.0.1:1082'],
    },
    privacy: { languageMode: 'ip', timezoneMode: 'ip', geoMode: 'ip' },
  });
  // extract replaces primary with 10.20.30.40, that fails, backup 1081 succeeds
  assert.ok(String(failedOver.proxy).includes('1081'), 'backup proxy should be selected, got ' + failedOver.proxy);
  assert.ok(tested.some((p) => String(p.target).includes('10.20.30.40')), 'extracted primary should be tested');
  assert.ok(tested.some((p) => String(p.target).includes('1081') && p.forced), 'backup must be forced-tested, not re-resolved');
  assert.ok(tested.every((p) => p.forced), 'every candidate must use forced proxy option');
  const net = engine2.networkInfo.get('prof_proxy_feature_4');
  assert.strictEqual(net.ip, '198.51.100.2');
  assert.strictEqual(net.timezone, 'America/New_York');

  // sanitize must NOT copy refreshUrl into apiExtractUrl
  const noBleed = engine.sanitizeProfile({
    id: 'prof_proxy_feature_5',
    name: 'no-bleed',
    networkMode: 'proxy',
    proxy: 'socks5://1.1.1.1:1',
    proxyMeta: { refreshUrl: 'http://example.test/refresh', apiExtractUrl: '' },
    privacy: {},
  });
  assert.strictEqual(noBleed.proxyMeta.apiExtractUrl, '');
  assert.strictEqual(noBleed.proxyMeta.refreshUrl, 'http://example.test/refresh');

  // refresh surfaces extract error when extract fails but static proxy remains
  const engine3 = makeEngineStub();
  engine3.checkProxy = async (profile) => ({
    ip: '203.0.113.9',
    countryCode: 'JP',
    timezone: 'Asia/Tokyo',
    latitude: 35,
    longitude: 139,
    latencyMs: 20,
    networkType: 'broadband',
    checkedAt: new Date().toISOString(),
    protocol: 'socks5',
    endpoint: '1.1.1.1:1',
    proxySource: 'primary',
    proxyRaw: profile.proxy,
    appliedFingerprint: engine3.fingerprintPatchFromNetwork({
      ip: '203.0.113.9', countryCode: 'JP', timezone: 'Asia/Tokyo', latitude: 35, longitude: 139,
    }, profile),
    profile,
  });
  const refreshWithWarn = await engine3.refreshProfileProxy({
    id: 'prof_proxy_feature_6',
    name: 'refresh-warn',
    networkMode: 'proxy',
    proxy: 'socks5://1.1.1.1:1',
    proxyMeta: {
      refreshUrl: `${base}/refresh`,
      apiExtractUrl: `${base}/missing-extract`,
    },
    privacy: {},
  });
  assert.ok(refreshWithWarn.extractError, 'extract failure should surface');
  assert.ok(refreshWithWarn.network?.ip === '203.0.113.9');

  // fingerprint patch
  const patch = engine2.fingerprintPatchFromNetwork(net, failedOver);
  assert.strictEqual(patch.language, 'en-US');
  assert.strictEqual(patch.privacy.timezone, 'America/New_York');

  // --- proxy store mark fields ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxf-'));
  const store = new ProxyStore(path.join(dir, 'p.json'));
  await store.load();
  const item = await store.create({ raw: 'socks5://127.0.0.1:9', name: 'x' });
  await store.markCheck(item.id, { ip: '8.8.8.8', countryCode: 'US', latencyMs: 12, networkType: 'broadband' });
  assert.strictEqual(store.get(item.id).lastLatencyMs, 12);
  assert.strictEqual(store.get(item.id).lastCheckOk, true);
  await store.markCheckError(item.id, { errorClass: 'auth', latencyMs: 9 });
  assert.strictEqual(store.get(item.id).lastCheckOk, false);
  assert.strictEqual(store.get(item.id).lastErrorClass, 'auth');
  fs.rmSync(dir, { recursive: true, force: true });

  // --- renderer wiring integrity ---
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  for (const id of [
    'editor-api-extract-url',
    'editor-backup-proxies',
    'editor-proxy-refresh-start',
    'editor-proxy-fill-fingerprint',
    'editor-test-proxy',
    'editor-apply-proxy-fp',
    'editor-refresh-proxy',
    'proxy-check-all',
  ]) {
    assert.ok(html.includes(`id="${id}"`), 'missing html id ' + id);
  }
  assert.strictEqual((renderer.match(/\$\('#editor-test-proxy'\)\?\.addEventListener\('click', testEditorProxy\);/g) || []).length, 1, 'test proxy listener should be single');
  assert.strictEqual((renderer.match(/\$\('#editor-apply-proxy-fp'\)\?\.addEventListener\('click', applyEditorProxyFingerprint\);/g) || []).length, 1);
  assert.strictEqual((renderer.match(/\$\('#editor-refresh-proxy'\)\?\.addEventListener\('click', refreshEditorProxy\);/g) || []).length, 1);
  // table headers vs cells: latency + type
  assert.ok(html.includes('<th>延迟</th>') && html.includes('<th>类型</th>'));
  assert.ok(renderer.includes("element('td', '', latency)") && renderer.includes("element('td', '', netType)"));
  assert.ok(preload.includes("profiles:refresh-proxy"));
  assert.ok(preload.includes("profiles:apply-proxy-fingerprint"));
  assert.ok(preload.includes("proxy:check-many"));
  assert.ok(main.includes("registerTrustedIpc('profiles:refresh-proxy'"));
  assert.ok(main.includes("registerTrustedIpc('profiles:apply-proxy-fingerprint'"));
  assert.ok(main.includes("registerTrustedIpc('proxy:check-many'"));
  assert.ok(renderer.includes('批量检测失败'), 'batch check should surface errors');
  assert.ok(renderer.includes('result.extractError'), 'refresh UI should surface extract warnings');
  assert.ok(renderer.includes('exitLatencyMs'), 'profile check should keep latency');
  assert.strictEqual(classifyProxyError(new Error('username or password')), 'auth');
  assert.ok(parseProxy('socks5://a:b@1.2.3.4:1080'));

  // forced proxy option must bypass resolveProfileProxyConfig
  const engineSrc = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
  assert.ok(engineSrc.includes('options.proxy || options.forcedProxy'), 'testProxy must accept forced proxy option');
  assert.ok(engineSrc.includes("proxySource: index === 0 ? 'primary' : 'backup'"), 'prepare must force-test each candidate');
  assert.ok(engineSrc.includes('extractError: extractError ? String(extractError.message || extractError) : null'), 'refresh must surface extract errors');
  assert.ok(!engineSrc.includes("apiExtractUrl: String(proxyMetaValue.apiExtractUrl || proxyMetaValue.refreshUrl || '')"), 'sanitize must not bleed refreshUrl into apiExtractUrl');

  const engine4 = makeEngineStub();
  let resolveCalled = 0;
  engine4.resolveProfileProxyConfig = async function () {
    resolveCalled += 1;
    throw new Error('resolve should not run for forced proxy');
  };
  // Exercise forced branch without network: invalid forced proxy should fail parse before resolve.
  let forcedParseError = null;
  try {
    await engine4.testProxy({
      id: 'prof_proxy_feature_7',
      name: 'forced',
      networkMode: 'proxy',
      proxy: 'socks5://primary:pw@1.1.1.1:1',
      privacy: {},
      proxyMeta: {},
    }, { proxy: 'not-a-proxy', proxySource: 'backup', allowExtract: false });
  } catch (error) {
    forcedParseError = error;
  }
  assert.ok(forcedParseError, 'invalid forced proxy should throw');
  assert.strictEqual(resolveCalled, 0, 'forced proxy must skip resolve even on parse failure');

  server.close();
  console.log('PROXY_FEATURE_SELFTEST_OK extract=1 failover=1 sanitize=1 wiring=1 store=1 refresh=1 forced=1');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
