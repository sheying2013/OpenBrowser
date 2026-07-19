'use strict';

/**
 * Functional tests for multi-open isolation + fingerprint determinism.
 * No desktop host process required.
 *
 *   node automation/isolation-fingerprint-selftest.js
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { PersistentConnection } = require('../cdp');

const {
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
  chromeArgsForFingerprint,
  fingerprintConsistencyIssues,
  createMediaDevicesFromSeed,
  createSpeechVoicesFromSeed,
  buildWebglFpPayload,
  audioMarkFromSeed,
  clientRectMarkFromSeed,
} = require('./fingerprint');
const {
  buildUaProfile,
  buildUserAgentMetadata,
  cdpUserAgentOverride,
  chromeArgsForUa,
  parseChromeVersion,
} = require('./user-agent');
const {
  acquireProfileLock,
  releaseProfileLock,
  auditIsolation,
  systemBrowserDataRoots,
  systemBrowserExecutablePaths,
  isSystemBrowserExecutable,
  validateDataRootIsolation,
  validateProfileRoot,
  validateProfileRootSecure,
  assertProfileId,
} = require('./isolation');

function pass(name) { console.log('  PASS  ' + name); }

async function main() {
  console.log('Isolation + fingerprint selftest\n');

  // deterministic fingerprints per profile id
  const a1 = buildFingerprint({ id: 'env-aaa', name: 'A', width: 1280, height: 800, language: 'en-US', privacy: {} });
  const a2 = buildFingerprint({ id: 'env-aaa', name: 'A', width: 1280, height: 800, language: 'en-US', privacy: {} });
  const b1 = buildFingerprint({ id: 'env-bbb', name: 'B', width: 1280, height: 800, language: 'zh-CN', privacy: {} });
  assert.strictEqual(a1.seed, a2.seed);
  assert.notStrictEqual(a1.seed, b1.seed);
  pass('fingerprint seed deterministic & unique per profile');

  const launchA1 = buildFingerprint({
    id: 'env-refresh',
    fingerprintLaunchSeed: 'launch-a',
    privacy: { fingerprint: { canvasId: 4321 } },
  });
  const launchA2 = buildFingerprint({
    id: 'env-refresh',
    fingerprintLaunchSeed: 'launch-a',
    privacy: { fingerprint: { canvasId: 4321 } },
  });
  const launchB = buildFingerprint({
    id: 'env-refresh',
    fingerprintLaunchSeed: 'launch-b',
    privacy: { fingerprint: { canvasId: 4321 } },
  });
  assert.deepStrictEqual(launchA1, launchA2);
  assert.notStrictEqual(launchA1.seed, launchB.seed);
  assert.notStrictEqual(launchA1.webgl.mark, launchB.webgl.mark);
  assert.strictEqual(launchA1.canvas.mark, 4321);
  assert.strictEqual(launchB.canvas.mark, 4321);
  pass('launch seed refreshes generated values while preserving manual overrides');

  assert.ok(a1.hardwareConcurrency >= 4);
  assert.ok(a1.deviceMemory >= 4);
  assert.ok(a1.userAgent.includes('Chrome'));
  assert.ok(a1.uaProfile && a1.uaProfile.metadata);
  assert.ok(a1.userAgentMetadata && a1.userAgentMetadata.brands?.length >= 2);
  assert.ok(a1.clientHints && a1.clientHints.ua_full_version);
  assert.ok(['noise', 'real', 'blocked'].includes(a1.canvas.mode));
  pass('fingerprint fields populated');

  // Custom UA + Client Hints consistency
  const customUa = buildFingerprint({
    id: 'env-ua',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    privacy: {},
  });
  assert.ok(customUa.userAgent.includes('Chrome/131'));
  assert.strictEqual(customUa.uaProfile.chromeMajor, 131);
  assert.strictEqual(customUa.clientHints.platform, 'Windows');
  assert.ok(customUa.userAgentMetadata.brands.some((b) => b.brand === 'Chromium' || b.brand === 'Google Chrome'));
  const cdp = cdpUserAgentOverride(customUa.uaProfile, 'en-US');
  assert.ok(cdp.userAgentMetadata.fullVersionList?.length >= 2);
  assert.strictEqual(cdp.platform, 'Win32');
  pass('custom UA builds Client Hints / CDP metadata');

  const uaScript = buildInjectionScript(customUa);
  assert.ok(uaScript.includes('userAgentData'));
  assert.ok(uaScript.includes('getHighEntropyValues'));
  assert.ok(!uaScript.includes('__openbrowserUaPatched'));
  pass('UA injection includes navigator.userAgentData');

  const tlsArgs = chromeArgsForUa(buildUaProfile({ chromeMajor: 131, os: 'windows' }));
  assert.ok(tlsArgs.some((a) => a.includes('PermuteTLSExtensions')));
  const oldTls = chromeArgsForUa(buildUaProfile({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36',
  }));
  assert.ok(oldTls.some((a) => a.startsWith('--disable-features=') && a.includes('PermuteTLSExtensions')));
  pass('TLS PermuteTLSExtensions follows Chrome major');

  const meta = buildUserAgentMetadata(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
  );
  assert.strictEqual(meta.platform, 'macOS');
  assert.ok(parseChromeVersion(customUa.userAgent).major === 131);
  pass('UA metadata platform maps from UA string');

  const kernelAligned = buildFingerprint({ id: 'env-kernel', kernelVersion: '151.0.7922.34', privacy: {} });
  assert.strictEqual(kernelAligned.uaProfile.chromeMajor, 151);
  assert.strictEqual(kernelAligned.userAgentMetadata.fullVersionList.find((item) => item.brand === 'Google Chrome')?.version.split('.')[0], '151');
  pass('automatic UA and Client Hints align with installed kernel major');

  // OS-facing fingerprint values must follow the UA OS, not a separate random choice.
  const osCases = [
    {
      id: 'env-windows',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Win32',
      hintPlatform: 'Windows',
      renderer: /Direct3D|D3D11/i,
    },
    {
      id: 'env-macos',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      hintPlatform: 'macOS',
      renderer: /Apple|OpenGL 4\.1/i,
    },
    {
      id: 'env-linux',
      ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
      hintPlatform: 'Linux',
      renderer: /Mesa|RADV|OpenGL/i,
    },
  ];
  for (const item of osCases) {
    const fp = buildFingerprint({ id: item.id, userAgent: item.ua, privacy: {} });
    assert.strictEqual(fp.platform, item.platform);
    assert.strictEqual(fp.userAgentMetadata.platform, item.hintPlatform);
    assert.match(fp.webgl.renderer, item.renderer);
    assert.deepStrictEqual(fp.consistency.issues, []);
  }
  pass('UA, navigator platform, Client Hints and WebGL remain OS-consistent');

  const contradictory = buildFingerprint({
    id: 'env-contradictory',
    userAgent: osCases[0].ua,
    privacy: {
      fingerprint: {
        platform: 'MacIntel',
        webglRenderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)',
      },
    },
  });
  const contradictionCodes = fingerprintConsistencyIssues(contradictory).issues.map((issue) => issue.code);
  assert.ok(contradictionCodes.includes('platform-ua-mismatch'));
  assert.ok(contradictionCodes.includes('webgl-ua-mismatch'));
  pass('manual fingerprint overrides are retained but contradictory values are diagnosed');

  // different profiles should diverge on marks
  assert.notStrictEqual(a1.canvas.mark, b1.canvas.mark);
  pass('canvas marks differ across profiles');

  // MediaDevices / speech / WebGL payload / audio+clientRect marks / static-dynamic layers
  const md1 = createMediaDevicesFromSeed('env-aaa');
  const md2 = createMediaDevicesFromSeed('env-aaa');
  const md3 = createMediaDevicesFromSeed('env-bbb');
  assert.deepStrictEqual(md1, md2);
  assert.notStrictEqual(md1[0].label, md3[0].label);
  assert.ok(md1.some((d) => d.kind === 'audioinput'));
  assert.ok(md1.some((d) => d.kind === 'videoinput' && /Integrated Camera/.test(d.label)));
  assert.ok(Array.isArray(a1.mediaDevices.devices) && a1.mediaDevices.devices.length >= 3);
  assert.ok(a1.webgl.fpPayload.UNMASKED_VENDOR_WEBGL);
  assert.ok(a1.webgl.fpPayload.UNMASKED_RENDERER_WEBGL);
  assert.ok(a1.webgl.gpu && a1.webgl.gpu.vendor);
  assert.ok(a1.staticConfig && a1.staticConfig.canvasMark === a1.canvas.mark);
  assert.ok(a1.dynamicConfig && 'timezone' in a1.dynamicConfig);
  assert.strictEqual(typeof audioMarkFromSeed('abc'), 'number');
  assert.ok(Math.abs(clientRectMarkFromSeed('abc')) <= 10000);
  const voices = createSpeechVoicesFromSeed('env-aaa', ['zh-CN'], 'noise');
  assert.ok(Array.isArray(voices) && voices.length >= 1);
  assert.ok(voices.some((v) => v.default === true));
  const blockedSpeech = buildFingerprint({ id: 'env-speech', privacy: { speech: 'blocked' } });
  assert.strictEqual(blockedSpeech.speech.mode, 'blocked');
  assert.deepStrictEqual(blockedSpeech.speech.voices, []);
  const payload = buildWebglFpPayload(a1.webgl);
  assert.strictEqual(payload.UNMASKED_VENDOR_WEBGL, a1.webgl.vendor);
  pass('mediaDevices / speech / webgl payload / static-dynamic layers');

  const scriptA = buildInjectionScript(a1);
  const scriptB = buildInjectionScript(b1);
  assert.ok(scriptA.includes(String(a1.canvas.mark)));
  assert.ok(!scriptA.includes(String(b1.canvas.mark)) || a1.canvas.mark === b1.canvas.mark);
  assert.ok(scriptA.length > 500);
  assert.notStrictEqual(scriptA, scriptB);
  assert.ok(scriptA.includes('enumerateDevices') || scriptA.includes('mediaDevices'));
  assert.ok(scriptA.includes('Integrated Camera') || scriptA.includes('Microphone Array') || scriptA.includes('audioinput'));
  const speechNoise = buildFingerprint({ id: 'env-speech-noise', language: 'en-US', privacy: { speech: 'noise' } });
  const speechScript = buildInjectionScript(speechNoise);
  assert.ok(speechScript.includes('getVoices'));
  pass('injection scripts profile-specific');

  const args = chromeArgsForFingerprint(a1, { privacy: { dnt: true } });
  assert.ok(args.some((a) => a.startsWith('--user-agent=')));
  assert.ok(args.some((a) => a.startsWith('--window-size=')));
  assert.ok(args.some((a) => a.includes('webrtc') || a.includes('WebRTC') || a.includes('webrtc-ip')));
  assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(!args.some((a) => a.includes('enable-automation')));
  assert.ok(scriptA.includes('webdriver') && scriptA.includes('false'));
  assert.ok(scriptA.includes('OffscreenCanvas'));
  assert.ok(scriptA.includes('OffscreenCanvasRenderingContext2D'));
  assert.ok(scriptA.includes('convertToBlob'));
  assert.ok(scriptA.includes('nativeSource') && scriptA.includes('Function.prototype.toString'));
  pass('chrome launch args for fingerprint');

  const workerScript = buildWorkerInjectionScript(a1);
  assert.doesNotThrow(() => new Function(workerScript));
  assert.ok(workerScript.includes('WorkerNavigator'));
  assert.ok(workerScript.includes('userAgentData'));
  assert.ok(workerScript.includes('getHighEntropyValues'));
  assert.ok(workerScript.includes('OffscreenCanvas'));
  assert.ok(workerScript.includes('WebGLRenderingContext'));
  assert.ok(!workerScript.includes('window.') && !workerScript.includes('document.'));
  pass('worker injection is worker-safe and covers navigator, canvas and WebGL');

  const sent = [];
  const events = [];
  const persistent = new PersistentConnection('ws://unit.test', {
    socket: { send: (message) => sent.push(JSON.parse(message)), close() {} },
    onEvent: (event) => events.push(event),
  });
  const routed = persistent.command('Runtime.evaluate', { expression: '1' }, { sessionId: 'worker-session', timeout: 1000 });
  assert.strictEqual(sent[0].sessionId, 'worker-session');
  persistent.handleMessage({ data: JSON.stringify({ id: sent[0].id, result: { result: { value: 1 } } }) });
  assert.strictEqual((await routed).result.value, 1);
  persistent.handleMessage({ data: JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'worker-session' } }) });
  assert.strictEqual(events[0].method, 'Target.attachedToTarget');
  persistent.close();
  pass('persistent CDP connection routes flattened worker sessions and events');

  assert.ok(a1.screen.availLeft >= 0 && a1.screen.availTop >= 0);
  assert.ok(a1.screen.availWidth <= a1.screen.width);
  assert.ok(a1.screen.availHeight <= a1.screen.height);
  assert.ok(a1.screen.screenX >= a1.screen.availLeft);
  assert.ok(a1.screen.screenY >= a1.screen.availTop);
  assert.ok(scriptA.includes('screenLeft') && scriptA.includes('availLeft'));
  pass('screen, available area and window origin remain internally consistent');

  // blocked modes
  const blocked = buildFingerprint({
    id: 'env-block',
    name: 'X',
    privacy: { canvas: 'blocked', webgl: 'blocked', webrtc: 'disabled', audio: 'muted' },
  });
  assert.strictEqual(blocked.canvas.mode, 'blocked');
  assert.strictEqual(blocked.webgl.mode, 'blocked');
  assert.strictEqual(blocked.webrtc, 'disabled');
  const blockedScript = buildInjectionScript(blocked);
  assert.ok(blockedScript.includes('Canvas reading is disabled') || blockedScript.includes('blocked'));
  pass('blocked/disabled modes');

  // isolation roots
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-iso-'));
  const p1 = path.join(dataRoot, 'p1');
  const p2 = path.join(dataRoot, 'p2');
  assert.ok(validateProfileRoot(dataRoot, p1, 'p1').ok);
  assert.ok(!validateProfileRoot(dataRoot, path.join(dataRoot, 'other'), 'p1').ok);
  assert.ok(!validateProfileRoot(dataRoot, dataRoot, 'p1').ok, 'profile root must not equal dataRoot');
  assert.ok(!validateProfileRoot(dataRoot, p1, 'p1!').ok, 'invalid profile id rejected');
  const systemRoot = systemBrowserDataRoots()[0];
  const systemExecutable = systemBrowserExecutablePaths()[0];
  assert.ok(isSystemBrowserExecutable(systemExecutable));
  assert.ok(!isSystemBrowserExecutable(path.join(dataRoot, 'kernels', 'custom', 'chrome')));
  assert.ok(!validateDataRootIsolation(systemRoot).ok);
  assert.ok(!validateDataRootIsolation(path.join(systemRoot, 'Profile 1')).ok);
  assert.ok(validateDataRootIsolation(path.join(dataRoot, 'openbrowser-data')).ok);
  pass('validateProfileRoot enforces {dataRoot}/{id}');

  // Windows Chrome User Data lives under LOCALAPPDATA (not APPDATA/Roaming)
  {
    const fakeHome = path.join(dataRoot, 'win-home');
    const env = {
      LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
      APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    };
    const roots = systemBrowserDataRoots(env, fakeHome, 'win32');
    const chromeLocal = path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
    assert.ok(roots.some((r) => path.resolve(r) === path.resolve(chromeLocal)), 'Windows Chrome root must include LOCALAPPDATA path');
    assert.ok(!validateDataRootIsolation(chromeLocal, { env, home: fakeHome, browserRoots: roots }).ok);
    assert.ok(!validateDataRootIsolation(path.join(chromeLocal, 'Default'), { env, home: fakeHome, browserRoots: roots }).ok);
  }
  pass('Windows Chrome LOCALAPPDATA user-data blocked');

  // injection must not expose legacy public fingerprint marker
  assert.ok(!scriptA.includes('__openbrowserFingerprint'));
  assert.ok(!scriptA.includes('__openbrowserUaPatched'));
  assert.ok(!scriptA.includes('Symbol.for'));
  assert.ok(!scriptA.includes('ob.fp'));
  assert.ok(scriptA.includes("patchList(Element.prototype, 'getClientRects')"));
  assert.ok(scriptA.includes("patchList(Range.prototype, 'getClientRects')"));
  pass('fingerprint injection avoids public __openbrowserFingerprint marker');

  // locks
  const firstLock = await acquireProfileLock(p1, { profileId: 'p1' });
  let locked = false;
  try {
    await acquireProfileLock(p1, { profileId: 'p1' });
  } catch (error) {
    locked = error.code === 'PROFILE_LOCKED';
  }
  assert.ok(locked);
  pass('profile lock prevents double open');
  assert.strictEqual(await releaseProfileLock(p1, { ...firstLock, token: 'wrong-owner' }), false);
  assert.strictEqual(await releaseProfileLock(p1, firstLock), true);
  const secondLock = await acquireProfileLock(p1, { profileId: 'p1' });
  await releaseProfileLock(p1, secondLock);
  pass('profile lock release allows reopen');

  const raceRoot = path.join(dataRoot, 'race');
  const race = await Promise.allSettled([
    acquireProfileLock(raceRoot, { profileId: 'race' }),
    acquireProfileLock(raceRoot, { profileId: 'race' }),
  ]);
  assert.strictEqual(race.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.strictEqual(race.filter((entry) => entry.status === 'rejected' && entry.reason.code === 'PROFILE_LOCKED').length, 1);
  const raceOwner = race.find((entry) => entry.status === 'fulfilled').value;
  await releaseProfileLock(raceRoot, raceOwner);
  pass('profile lock acquisition is atomic');

  assert.throws(() => assertProfileId('p1!'), /Invalid profile id/);
  assert.strictEqual(assertProfileId('p1_valid-2'), 'p1_valid-2');
  pass('profile ids are rejected instead of rewritten');

  if (process.platform !== 'win32') {
    const outside = path.join(dataRoot, 'outside');
    const linkedProfile = path.join(dataRoot, 'linked');
    await fsp.mkdir(outside);
    await fsp.symlink(outside, linkedProfile, 'dir');
    const secure = await validateProfileRootSecure(dataRoot, linkedProfile, 'linked');
    assert.ok(!secure.ok, 'symlinked profile root must be rejected');
    pass('profile root symlink escape rejected');
  }

  // audit
  const auditOk = auditIsolation([
    { id: 'p1', root: p1, port: 9222, pid: 1 },
    { id: 'p2', root: p2, port: 9223, pid: 2 },
  ]);
  assert.ok(auditOk.ok);
  assert.strictEqual(auditOk.distinctRoots, 2);
  assert.strictEqual(auditOk.distinctPorts, 2);
  pass('isolation audit ok for distinct roots/ports');

  const auditBad = auditIsolation([
    { id: 'p1', root: p1, port: 9222 },
    { id: 'p2', root: p1, port: 9222 },
  ]);
  assert.ok(!auditBad.ok);
  assert.ok(auditBad.issues.some((i) => /collision/.test(i.message)));
  pass('isolation audit detects root/port collision');

  await fsp.rm(dataRoot, { recursive: true, force: true });

  console.log('\nAll isolation+fingerprint selftests passed.');
}

main().catch((error) => {
  console.error('\nFAIL', error);
  process.exit(1);
});
