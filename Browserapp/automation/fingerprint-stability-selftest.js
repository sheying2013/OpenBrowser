'use strict';

/**
 * Site-aware canvas/webgl stability + privacy schema selftest.
 *   node automation/fingerprint-stability-selftest.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
  resolveStabilityPolicy,
  matchStabilityHost,
  createBatteryFromSeed,
  createMediaDevicesFromSeed,
  DEFAULT_STABILITY_HOSTS,
} = require('./fingerprint');

function main() {
  // --- host matching ---
  const auto = resolveStabilityPolicy({ stabilityMode: 'auto' }, { host: 'www.amazon.com' });
  assert.strictEqual(auto.active, true, 'amazon should activate stability');
  assert.strictEqual(auto.matched, true);
  assert.strictEqual(auto.noiseAmplitude, 1);

  const skip = resolveStabilityPolicy({ stabilityMode: 'auto' }, { host: 'www.sephora.com' });
  assert.strictEqual(skip.active, false, 'sephora is skip-listed');
  assert.strictEqual(skip.skipped, true);

  const ordinary = resolveStabilityPolicy({ stabilityMode: 'auto' }, { host: 'example.com' });
  assert.strictEqual(ordinary.active, false);
  assert.strictEqual(ordinary.noiseAmplitude, 3);

  const force = resolveStabilityPolicy({ stabilityMode: 'force' }, { host: 'example.com' });
  assert.strictEqual(force.active, true);
  assert.strictEqual(force.noiseAmplitude, 1);

  const off = resolveStabilityPolicy({ stabilityMode: 'off' }, { host: 'www.amazon.com' });
  assert.strictEqual(off.active, false);

  const custom = resolveStabilityPolicy({
    stabilityMode: 'auto',
    stabilityHosts: ['risk.test'],
    stabilitySkipHosts: [],
  }, { host: 'a.risk.test' });
  assert.strictEqual(custom.active, true);
  assert.ok(matchStabilityHost('login.paypal.com', { stabilityMode: 'auto' }));
  assert.ok(DEFAULT_STABILITY_HOSTS.includes('amazon.com'));

  // --- fingerprint schema surfaces ---
  const fp = buildFingerprint({
    id: 'prof_stability_1',
    name: 'stability',
    privacy: {
      stabilityMode: 'auto',
      stabilityHost: 'accounts.google.com',
      battery: 'noise',
      media: 'noise',
      mediaLabels: {
        audioinput: 'Custom Mic Label',
        videoinput: 'Custom Cam Label',
        audiooutput: 'Custom Speaker Label',
      },
      webrtc: 'proxy',
      webrtcPolicy: 3,
      webgpu: 'webgl',
      fingerprint: {
        canvasId: 111,
        webglId: 222,
      },
    },
  });
  assert.strictEqual(fp.canvas.mark, 111);
  assert.strictEqual(fp.webgl.mark, 222);
  assert.strictEqual(fp.stability.active, true);
  assert.strictEqual(fp.canvas.stability.active, true);
  assert.strictEqual(fp.stability.noiseAmplitude, 1);
  assert.strictEqual(fp.battery.mode, 'noise');
  assert.ok(fp.battery.value && typeof fp.battery.value.level === 'number');
  assert.strictEqual(fp.webrtcPolicy, 3);
  assert.strictEqual(fp.webgpu.mode, 'webgl');
  assert.ok(fp.mediaDevices.devices.some((d) => d.label === 'Custom Mic Label'));
  assert.ok(fp.staticConfig.stability.active);

  const batteryA = createBatteryFromSeed('same-seed');
  const batteryB = createBatteryFromSeed('same-seed');
  assert.deepStrictEqual(batteryA, batteryB);
  assert.notDeepStrictEqual(batteryA, createBatteryFromSeed('other-seed'));

  const labeled = createMediaDevicesFromSeed('lab', {
    labels: { input: 'Mic X', video: 'Cam X', output: 'Spk X' },
  });
  assert.strictEqual(labeled[0].label, 'Mic X');
  assert.strictEqual(labeled[1].label, 'Cam X');
  assert.strictEqual(labeled[2].label, 'Spk X');

  // --- injection embeds host-aware amplitude ---
  const script = buildInjectionScript(fp);
  assert.ok(script.includes('stabilityActiveNow'));
  assert.ok(script.includes('noiseAmplitudeNow'));
  assert.ok(script.includes('accounts.google.com') || script.includes('"active":true'));
  assert.ok(script.includes('getBattery') || script.includes('battery'));
  assert.ok(script.includes('hamming'));

  const worker = buildWorkerInjectionScript(fp);
  assert.ok(worker.includes('noiseAmplitude'));
  assert.ok(worker.includes('CFG.stability'));

  // force-off host should not set active
  const quiet = buildFingerprint({
    id: 'prof_stability_2',
    name: 'quiet',
    privacy: { stabilityMode: 'off', stabilityHost: 'amazon.com' },
  });
  assert.strictEqual(quiet.stability.active, false);
  assert.strictEqual(quiet.stability.noiseAmplitude, 3);

  // --- engine sanitize schema ---
  const { BrowserEngine } = require('../engine');
  const engine = Object.create(BrowserEngine.prototype);
  engine.profiles = new Map();
  engine.networkInfo = new Map();
  engine.running = new Map();
  engine.listeners = new Set();
  engine.persist = async () => {};
  engine.emit = () => {};
  engine.sanitizeProfile = BrowserEngine.prototype.sanitizeProfile.bind(engine);
  engine.prepareProfileProxyForStart = BrowserEngine.prototype.prepareProfileProxyForStart.bind(engine);
  engine.testProxy = BrowserEngine.prototype.testProxy.bind(engine);

  const sanitized = engine.sanitizeProfile({
    id: 'prof_stability_3',
    name: 'schema',
    networkMode: 'proxy',
    proxy: 'socks5://127.0.0.1:1080',
    privacy: {
      battery: 'noise',
      webgpu: 'webgl',
      webrtcPolicy: 2,
      stabilityMode: 'force',
      stabilityHosts: ['risk.example'],
      mediaLabels: { input: 'A', video: 'B', output: 'C' },
      mediaDevices: 'noise',
    },
    proxyMeta: {
      requireReady: true,
      notReadyPolicy: 'block',
      checkOnStart: false,
    },
  });
  assert.strictEqual(sanitized.privacy.battery, 'noise');
  assert.strictEqual(sanitized.privacy.webgpu, 'webgl');
  assert.strictEqual(sanitized.privacy.webrtcPolicy, 2);
  assert.strictEqual(sanitized.privacy.stabilityMode, 'force');
  assert.deepStrictEqual(sanitized.privacy.stabilityHosts, ['risk.example']);
  assert.strictEqual(sanitized.privacy.mediaLabels.audioinput, 'A');
  assert.strictEqual(sanitized.proxyMeta.requireReady, true);
  assert.strictEqual(sanitized.proxyMeta.notReadyPolicy, 'block');

  // proxy not-ready: block
  const engineBlock = Object.create(BrowserEngine.prototype);
  engineBlock.profiles = new Map();
  engineBlock.networkInfo = new Map();
  engineBlock.emit = () => {};
  engineBlock.sanitizeProfile = BrowserEngine.prototype.sanitizeProfile.bind(engineBlock);
  engineBlock.prepareProfileProxyForStart = BrowserEngine.prototype.prepareProfileProxyForStart.bind(engineBlock);
  engineBlock.applyNetworkToProfile = () => {};
  engineBlock.testProxy = async () => {
    const err = new Error('dead proxy');
    err.errorClass = 'unreachable';
    throw err;
  };

  return runProxyPolicies(engineBlock, BrowserEngine);
}

async function runProxyPolicies(engineBlock, BrowserEngine) {
  let blockedErr = null;
  try {
    await engineBlock.prepareProfileProxyForStart({
      id: 'prof_stability_4',
      name: 'block',
      networkMode: 'proxy',
      proxy: 'socks5://127.0.0.1:1',
      proxyMeta: { checkOnStart: true, notReadyPolicy: 'block', requireReady: true },
      privacy: {},
    });
  } catch (error) {
    blockedErr = error;
  }
  assert.ok(blockedErr, 'block policy must throw');
  assert.ok(String(blockedErr.message).includes('未就绪') || String(blockedErr.message).includes('检测失败') || String(blockedErr.message).includes('dead'));

  // continue policy
  const engineCont = Object.create(BrowserEngine.prototype);
  engineCont.profiles = new Map();
  engineCont.networkInfo = new Map();
  const events = [];
  engineCont.emit = (e) => events.push(e);
  engineCont.sanitizeProfile = BrowserEngine.prototype.sanitizeProfile.bind(engineCont);
  engineCont.prepareProfileProxyForStart = BrowserEngine.prototype.prepareProfileProxyForStart.bind(engineCont);
  engineCont.applyNetworkToProfile = () => {};
  engineCont.testProxy = async () => {
    throw Object.assign(new Error('dead'), { errorClass: 'unreachable' });
  };
  const continued = await engineCont.prepareProfileProxyForStart({
    id: 'prof_stability_5',
    name: 'continue',
    networkMode: 'proxy',
    proxy: 'socks5://127.0.0.1:1',
    proxyMeta: { checkOnStart: true, notReadyPolicy: 'continue', requireReady: false },
    privacy: {},
  });
  assert.ok(String(continued.proxy).includes('127.0.0.1:1'));
  assert.ok(events.some((e) => e.type === 'proxy-warn' || e.type === 'proxy-error'));

  // direct fallback
  const engineDirect = Object.create(BrowserEngine.prototype);
  engineDirect.profiles = new Map();
  engineDirect.networkInfo = new Map();
  const events2 = [];
  engineDirect.emit = (e) => events2.push(e);
  engineDirect.sanitizeProfile = BrowserEngine.prototype.sanitizeProfile.bind(engineDirect);
  engineDirect.prepareProfileProxyForStart = BrowserEngine.prototype.prepareProfileProxyForStart.bind(engineDirect);
  engineDirect.applyNetworkToProfile = () => {};
  engineDirect.testProxy = async () => {
    throw Object.assign(new Error('dead'), { errorClass: 'unreachable' });
  };
  const direct = await engineDirect.prepareProfileProxyForStart({
    id: 'prof_stability_6',
    name: 'direct-fallback',
    networkMode: 'proxy',
    proxy: 'socks5://127.0.0.1:1',
    proxyMeta: { checkOnStart: true, notReadyPolicy: 'direct', requireReady: true },
    privacy: {},
  });
  assert.strictEqual(direct.networkMode, 'direct');
  assert.ok(/direct/i.test(direct.proxy));
  assert.ok(events2.some((e) => e.type === 'proxy-fallback'));

  // source integrity: no provenance claims
  const fpSrc = fs.readFileSync(path.join(__dirname, 'fingerprint.js'), 'utf8');
  for (const banned of ['ThirdPartySuite', 'Hubstudio', 'HubStudio', '逆向', '复刻', 'ThirdPartyKernel']) {
    assert.ok(!fpSrc.includes(banned), 'fingerprint.js must not contain ' + banned);
  }
  const engSrc = fs.readFileSync(path.join(__dirname, '../engine.js'), 'utf8');
  for (const banned of ['ThirdPartySuite', 'Hubstudio', 'HubStudio', '逆向', '复刻']) {
    assert.ok(!engSrc.includes(banned), 'engine.js must not contain ' + banned);
  }
  assert.ok(engSrc.includes('notReadyPolicy'));
  assert.ok(engSrc.includes('requireReady'));
  assert.ok(engSrc.includes('stabilityMode'));
  assert.ok(fpSrc.includes('resolveStabilityPolicy'));
  assert.ok(fpSrc.includes('createBatteryFromSeed'));

  console.log('FINGERPRINT_STABILITY_SELFTEST_OK host=1 schema=1 inject=1 proxy-policy=1 scrub=1');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
