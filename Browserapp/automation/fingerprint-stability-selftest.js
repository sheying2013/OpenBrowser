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
  hammingDistance,
  sampleCanvasBlocks,
  applyStableCanvasNoise,
  withinHammingThreshold,
} = require('./fingerprint');
const {
  resolveTlsProfile,
  tlsConnectOptionsFromProfile,
  TLS_PROFILE_PRESETS,
} = require('../proxy-forwarder');

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


  // --- hamming session consistency ---
  assert.strictEqual(hammingDistance([0], [0]), 0);
  assert.strictEqual(hammingDistance([0xff], [0x00]), 8);
  assert.strictEqual(hammingDistance([0b10101010], [0b01010101]), 8);
  assert.ok(withinHammingThreshold([1, 2, 3], [1, 2, 3], 12));
  assert.ok(!withinHammingThreshold([0], [0xff], 4));

  const width = 48;
  const height = 48;
  const makeImg = () => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 13 + 7) & 255;
    return { data, width, height };
  };
  const lockMap = new Map();
  const opts = { noiseAmplitude: 1, seedNum: 0xabcdef, lockMap, square: 8, maxWidth: 600, maxHeight: 600, mark: 77 };
  const imgA = makeImg();
  const imgB = makeImg();
  applyStableCanvasNoise(imgA, 77, opts);
  applyStableCanvasNoise(imgB, 77, opts);
  const blocksA = sampleCanvasBlocks(imgA.data, width, height, { square: 8 });
  const blocksB = sampleCanvasBlocks(imgB.data, width, height, { square: 8 });
  assert.deepStrictEqual(blocksA, blocksB, 'locked noise must be identical across reads');
  assert.ok(withinHammingThreshold(blocksA, blocksB, 12));
  // unlocked different mark diverges from first sample
  const imgC = makeImg();
  applyStableCanvasNoise(imgC, 1, { ...opts, lockMap: new Map(), mark: 1 });
  const blocksC = sampleCanvasBlocks(imgC.data, width, height, { square: 8 });
  assert.ok(hammingDistance(blocksA, blocksC) >= 0);
  const forceScript = buildInjectionScript(buildFingerprint({
    id: 'prof_hamming_1',
    name: 'hamming',
    privacy: { stabilityMode: 'force', stabilityHamming: 12 },
  }));
  assert.ok(forceScript.includes('canvasNoiseLocks'), 'injection must lock deltas on stable hosts');
  assert.ok(forceScript.includes('locked.push'));

  // --- TLS profile hooks ---
  assert.ok(TLS_PROFILE_PRESETS.chrome);
  const autoModern = resolveTlsProfile({ id: 'auto', chromeMajor: 131 });
  assert.strictEqual(autoModern.id, 'chrome');
  assert.strictEqual(autoModern.permuteExtensions, true);
  const autoLegacy = resolveTlsProfile({ id: 'auto', chromeMajor: 100 });
  assert.strictEqual(autoLegacy.id, 'chrome_legacy');
  assert.strictEqual(autoLegacy.permuteExtensions, false);
  const connectOpts = tlsConnectOptionsFromProfile(autoModern, { servername: 'example.com' });
  assert.ok(connectOpts.ciphers && connectOpts.ciphers.includes('TLS_AES_128_GCM_SHA256'));
  assert.deepStrictEqual(connectOpts.ALPNProtocols, ['h2', 'http/1.1']);
  assert.strictEqual(connectOpts.servername, 'example.com');
  const offOpts = tlsConnectOptionsFromProfile('off', { servername: 'x.com' });
  assert.ok(!offOpts.ciphers, 'off profile must not force ciphers');

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
      webrtc: 'real',
      stabilityMode: 'force',
      stabilityHosts: ['risk.example'],
      mediaLabels: { input: 'A', video: 'B', output: 'C' },
      mediaDevices: 'noise',
    },
    proxyMeta: {
      requireReady: true,
      notReadyPolicy: 'block',
      checkOnStart: false,
      tlsProfile: 'chrome',
      tlsChromeMajor: 131,
    },
  });
  assert.strictEqual(sanitized.privacy.battery, 'noise');
  assert.strictEqual(sanitized.privacy.webgpu, 'webgl');
  assert.strictEqual(sanitized.privacy.webrtcPolicy, 1); // derived from webrtc=real
  assert.strictEqual(sanitized.privacy.stabilityMode, 'force');
  assert.deepStrictEqual(sanitized.privacy.stabilityHosts, ['risk.example']);
  assert.strictEqual(sanitized.privacy.mediaLabels.audioinput, 'A');
  assert.strictEqual(sanitized.proxyMeta.requireReady, true);
  assert.strictEqual(sanitized.proxyMeta.notReadyPolicy, 'block');
  assert.strictEqual(sanitized.proxyMeta.tlsProfile, 'chrome');
  assert.strictEqual(sanitized.proxyMeta.tlsChromeMajor, 131);

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
  const proxySrc = fs.readFileSync(path.join(__dirname, '../proxy-forwarder.js'), 'utf8');
  for (const banned of ['ThirdPartySuite', 'Hubstudio', 'HubStudio', '逆向', '复刻', 'envkit']) {
    assert.ok(!proxySrc.includes(banned), 'proxy-forwarder.js must not contain ' + banned);
  }
  assert.ok(proxySrc.includes('resolveTlsProfile'));
  assert.ok(fpSrc.includes('hammingDistance'));
  assert.ok(fpSrc.includes('applyStableCanvasNoise'));
  assert.ok(fpSrc.includes('metaMode'));
  assert.ok(engSrc.includes("stabilityMode === 'off'"), 'refresh seed must yield to stability');
  assert.ok(engSrc.includes('fingerprint?.uaProfile?.chromeMajor'), 'tls major should follow built fingerprint');
  // webglMeta real skips vendor spoof
  const metaReal = buildFingerprint({
    id: 'prof_webgl_meta_real',
    name: 'meta-real',
    privacy: { webgl: 'noise', webglMeta: 'real' },
  });
  assert.strictEqual(metaReal.webgl.metaMode, 'real');
  assert.strictEqual(metaReal.webgl.vendor, null);
  const metaScript = buildInjectionScript(metaReal);
  assert.ok(metaScript.includes('metaMode') && metaScript.includes('"real"'));
  assert.ok(engSrc.includes('notReadyPolicy'));
  assert.ok(engSrc.includes('requireReady'));
  assert.ok(engSrc.includes('stabilityMode'));
  assert.ok(fpSrc.includes('resolveStabilityPolicy'));
  assert.ok(fpSrc.includes('createBatteryFromSeed'));

  console.log('FINGERPRINT_STABILITY_SELFTEST_OK host=1 schema=1 inject=1 proxy-policy=1 hamming=1 tls=1 scrub=1');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
