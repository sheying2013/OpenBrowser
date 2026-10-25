#!/usr/bin/env node
'use strict';

/**
 * OpenBrowser Blue Team P0/P1 Fingerprint Remediation Selftest
 *
 * Covers 4 core remediation areas:
 * 1. [P0] Device Persona: Hardware topology tuples (CPU/RAM/GPU/DPR/Screen/Fonts) + micro-perturbations.
 * 2. [P1] Canvas measureText width jitter: deterministic same-origin noise + host font isolation.
 * 3. [P1] WebRTC fallback: production pipeline integration into buildInjectionScript + live fallback contracts.
 * 4. [P1] Injection flaw fixes:
 *    - navigator.keyboard.getLayoutMap() iterator native shape (no Generator leakage).
 *    - iOS window.chrome suppression and introspection interception.
 */

const assert = require('assert');
const vm = require('vm');

const {
  buildFingerprint,
  buildInjectionScript,
} = require('./fingerprint');

const {
  PERSONAS_BY_OS,
  WINDOWS_PERSONAS,
  MACOS_APPLE_PERSONAS,
  pickPersona,
  isCoherent,
  fontsForOs,
  applyPersonaPerturbations,
} = require('./device-personas');

const { createWebRtcFallbackSource } = require('./webrtc-fallback');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

async function asyncCheck(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('--- Starting Blue Team P0/P1 Fingerprint Remediation Selftest ---\n');

  // =========================================================================
  // 1. [P0] Device Persona Hardware Topology Tuples & Coherence
  // =========================================================================
  console.log('--- Section 1: [P0] Device Persona Tuple Library & Consistency ---');

  check('every shipped persona across all OS pools is internally coherent', () => {
    let count = 0;
    for (const [os, pool] of Object.entries(PERSONAS_BY_OS)) {
      for (const persona of pool) {
        count += 1;
        assert.ok(isCoherent(persona), `Persona for ${os} must be coherent: ${persona.webgl.renderer}`);
      }
    }
    assert.ok(count >= 22, `Expected at least 22 coherent personas, got ${count}`);
  });

  check('persona records bind CPU, memory, DPR, screen, WebGL GPU, and fonts', () => {
    for (const [os, pool] of Object.entries(PERSONAS_BY_OS)) {
      for (const p of pool) {
        assert.ok(Number.isInteger(p.cores) && p.cores >= 2, 'cores must be valid');
        assert.ok(Number.isInteger(p.memory) && p.memory >= 4 && p.memory <= 8, 'memory must be legal W3C tier');
        assert.ok(p.screen && p.screen.width > 0 && p.screen.height > 0, 'screen dimensions must be positive');
        assert.ok(p.devicePixelRatio >= 1, 'devicePixelRatio must be >= 1');
        assert.ok(p.webgl && p.webgl.vendor && p.webgl.renderer, 'webgl must have vendor and renderer');
        const fonts = fontsForOs(p.os);
        assert.ok(Array.isArray(fonts) && fonts.length > 0, 'platform font set must be bound');
      }
    }
  });

  check('opted-in Windows profile inherits complete tuple without contradictory axes', () => {
    const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const fp = buildFingerprint({
      id: 'test-win-persona',
      userAgent: WIN_UA,
      privacy: { deviceProfile: 'persona' },
    });
    assert.ok(/D3D11/.test(fp.webgl.renderer), 'Windows persona WebGL must use D3D11');
    assert.strictEqual(fp.platform, 'Win32');
    assert.ok(fp.hardwareConcurrency >= 4, 'Cores must match modern Windows topology');
    assert.ok(fp.deviceMemory >= 4 && fp.deviceMemory <= 8, 'Memory must match modern tier');
    assert.ok(fp.screen.width >= 1366 && fp.screen.height >= 768, 'Screen geometry bound to persona');
  });

  check('opted-in macOS profile uses Metal backend and Retina DPR >= 2', () => {
    const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const fp = buildFingerprint({
      id: 'test-mac-persona',
      userAgent: MAC_UA,
      privacy: { deviceProfile: 'persona' },
    });
    assert.ok(/Metal/.test(fp.webgl.renderer), 'macOS persona WebGL must use Metal');
    assert.ok(fp.screen.devicePixelRatio >= 2, 'macOS persona must be Retina');
    assert.strictEqual(fp.platform, 'MacIntel');
  });

  check('micro-perturbation helper applies bounded jitter within tolerance thresholds', () => {
    const baseWin = WINDOWS_PERSONAS[0];
    const perturbed1 = applyPersonaPerturbations(baseWin, 'seed-1');
    const perturbed2 = applyPersonaPerturbations(baseWin, 'seed-1');

    // Determinism
    assert.strictEqual(perturbed1.screen.taskbarHeight, perturbed2.screen.taskbarHeight, 'Perturbation must be deterministic for same seed');
    assert.strictEqual(perturbed1.screen.availHeight, perturbed2.screen.availHeight);

    // Bounded within threshold (Windows taskbar: 36px to 44px)
    assert.ok(perturbed1.screen.taskbarHeight >= 36 && perturbed1.screen.taskbarHeight <= 44, `Windows taskbar outside threshold: ${perturbed1.screen.taskbarHeight}`);
    assert.strictEqual(perturbed1.screen.availHeight, baseWin.screen.height - perturbed1.screen.taskbarHeight);

    // macOS bounded within threshold (macOS taskbar/menu: 22px to 28px)
    const baseMac = MACOS_APPLE_PERSONAS[0];
    const perturbedMac = applyPersonaPerturbations(baseMac, 'seed-mac-1');
    assert.ok(perturbedMac.screen.taskbarHeight >= 22 && perturbedMac.screen.taskbarHeight <= 28, `macOS taskbar outside threshold: ${perturbedMac.screen.taskbarHeight}`);
  });

  check('existing profiles without persona opt-in keep legacy behavior (backward compatibility)', () => {
    const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const legacyProfile = { id: 'legacy-unmodified', userAgent: WIN_UA, privacy: { deviceProfile: 'default' } };
    const fp = buildFingerprint(legacyProfile);
    assert.strictEqual(fp.platform, 'Win32');
    assert.ok(fp.hardwareConcurrency > 0);
    assert.ok(fp.seed);
  });

  // =========================================================================
  // 2. [P1] Canvas measureText Width Noise & Host Font Shielding
  // =========================================================================
  console.log('\n--- Section 2: [P1] Canvas measureText width Jitter & Font Shielding ---');

  check('measureText script implements deterministic width jitter', () => {
    const fp = buildFingerprint({
      id: 'test-canvas-measure',
      os: 'windows',
      privacy: { canvas: 'noise' },
    });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes("if (prop === 'width')"), 'measureText proxy must handle width property');
    assert.ok(script.includes('widthJitter'), 'measureText proxy must inject widthJitter');
    assert.ok(script.includes('cleanFont'), 'measureText must check and sanitize font before measurement');
  });

  check('measureText width jitter is deterministic per origin + seed + font + text', () => {
    const fp = buildFingerprint({
      id: 'test-measure-det',
      os: 'windows',
      privacy: { canvas: 'noise' },
    });
    const script = buildInjectionScript(fp);

    const sandbox = vm.createContext({
      document: { createElement: () => ({ getContext: () => null }) },
      location: { origin: 'https://example.com' },
      HTMLCanvasElement: { prototype: {} },
      CanvasRenderingContext2D: {
        prototype: {
          font: '16px Arial',
          measureText(text) {
            return {
              width: 100.0,
              actualBoundingBoxLeft: 0,
              actualBoundingBoxRight: 100,
              actualBoundingBoxAscent: 12,
              actualBoundingBoxDescent: 4,
            };
          },
        },
      },
    });
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInContext(script, sandbox);

    const ctx = Object.create(sandbox.CanvasRenderingContext2D.prototype);
    ctx.font = '16px Arial';

    const m1 = ctx.measureText('OpenBrowser Test');
    const m2 = ctx.measureText('OpenBrowser Test');
    const m3 = ctx.measureText('OpenBrowser Test');

    // Same-origin consistency: calls on identical text produce exact same width
    assert.strictEqual(m1.width, m2.width, 'measureText width must be identical across calls on same text');
    assert.strictEqual(m2.width, m3.width, 'measureText width must remain deterministic on same page');

    // Noise was applied (not raw unperturbed 100.0)
    assert.notStrictEqual(m1.width, 100.0, 'measureText width must be perturbed with micro-noise');
    assert.ok(Math.abs(m1.width - 100.0) < 0.05, 'width jitter must remain within micro-noise boundary');

    // Different text gets different jitter
    const mOther = ctx.measureText('Different String');
    const expectedRaw = 100.0;
    assert.notStrictEqual(m1.width - expectedRaw, mOther.width - expectedRaw, 'Different text strings must yield distinct jitter');

    // Zero width preserved for empty string
    sandbox.CanvasRenderingContext2D.prototype.measureText = function () { return { width: 0 }; };
    const ctxEmpty = Object.create(sandbox.CanvasRenderingContext2D.prototype);
    const mEmpty = ctxEmpty.measureText('');
    assert.strictEqual(mEmpty.width, 0, 'Empty string must keep 0 width');
  });

  check('measureText intercepts host-only foreign font and falls back to generic family', () => {
    // A Windows persona on a macOS host must sanitize Menlo/Helvetica Neue before measuring
    const fp = buildFingerprint({
      id: 'test-font-isolate',
      os: 'windows',
      privacy: { canvas: 'noise', deviceProfile: 'persona' },
    });
    const script = buildInjectionScript(fp);

    let measuredFont = null;
    const sandbox = vm.createContext({
      document: { createElement: () => ({ getContext: () => null }) },
      location: { origin: 'https://bank.example' },
      HTMLCanvasElement: { prototype: {} },
      CanvasRenderingContext2D: {
        prototype: {
          font: '72px "Menlo"',
          measureText(text) {
            measuredFont = this.font;
            return { width: 150.0, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 150 };
          },
        },
      },
    });
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInContext(script, sandbox);

    const ctx = Object.create(sandbox.CanvasRenderingContext2D.prototype);
    ctx.font = '72px "Menlo"';

    ctx.measureText('font-probe');

    // During native measurement, font must NOT be Menlo
    assert.ok(!measuredFont.includes('Menlo'), `Measured font leaked host-only Menlo: ${measuredFont}`);
    assert.ok(measuredFont.includes('monospace'), `Measured font must fall back to generic family: ${measuredFont}`);

    // Page still reads its original font setting
    assert.ok(ctx.font.includes('Menlo'), 'ctx.font getter must still report the page-assigned font');
  });

  // =========================================================================
  // 3. [P1] WebRTC Fallback Integration into Production Pipeline
  // =========================================================================
  console.log('\n--- Section 3: [P1] WebRTC Fallback Pipeline Integration ---');

  check('buildInjectionScript integrates createWebRtcFallbackSource when webrtc is not disabled', () => {
    const fp = buildFingerprint({
      id: 'test-webrtc-prod',
      os: 'windows',
      privacy: { webrtc: 'proxy', webrtcAddress: '203.0.113.9' },
    });
    const script = buildInjectionScript(fp);
    assert.ok(script.includes('PatchedRTCPeerConnection'), 'buildInjectionScript must include WebRTC fallback wrapper');
    assert.ok(script.includes('fallbackInstances'), 'buildInjectionScript must carry fallback instance management');
    assert.ok(script.includes('203.0.113.9'), 'buildInjectionScript fallback must carry configured webrtcAddress');
  });

  check('buildInjectionScript omits webrtc fallback when webrtc is disabled', () => {
    const fp = buildFingerprint({
      id: 'test-webrtc-disabled',
      os: 'windows',
      privacy: { webrtc: 'disabled' },
    });
    const script = buildInjectionScript(fp);
    assert.ok(!script.includes('PatchedRTCPeerConnection'), 'Disabled webrtc must not include fallback');
    assert.ok(script.includes('WebRTC is disabled by permissions policy'), 'Disabled webrtc must throw NotAllowedError');
  });

  await asyncCheck('WebRTC fallback recovers from NotSupportedError and provides compliant RTCPeerConnection instance', async () => {
    const fallbackSource = createWebRtcFallbackSource({
      publicIp: '198.51.100.5',
      localIp: '10.0.0.15',
      bridgeToken: 'test-bridge-token',
    });

    const sandbox = vm.createContext({
      EventTarget: globalThis.EventTarget,
      Event: globalThis.Event,
      RTCPeerConnection: function NativeBrokenRTCPeerConnection() {
        throw new Error('NotSupportedError: WebRTC peer connection disabled in this kernel build');
      },
      RTCStatsReport: function RTCStatsReport() {},
    });
    sandbox.RTCPeerConnection.prototype = {
      constructor: sandbox.RTCPeerConnection,
      createOffer() {},
      setLocalDescription() {},
      getStats() {},
      close() {},
    };
    Object.defineProperty(sandbox.RTCPeerConnection.prototype, 'signalingState', { get: () => 'stable', configurable: true });
    Object.defineProperty(sandbox.RTCStatsReport.prototype, 'size', { get: () => 0, configurable: true });
    sandbox.RTCStatsReport.prototype.forEach = function () {};
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInContext(fallbackSource, sandbox);

    // Construction does not throw
    let pc = null;
    assert.doesNotThrow(() => {
      pc = new sandbox.RTCPeerConnection();
    }, 'RTCPeerConnection construction must not throw under fallback');
    assert.ok(pc, 'Must return a peer connection instance');

    // Branding
    assert.ok(pc instanceof sandbox.RTCPeerConnection, 'Must pass instanceof RTCPeerConnection');

    // createOffer
    const offer = await pc.createOffer();
    assert.ok(offer && offer.sdp, 'createOffer must return valid session description');
    assert.ok(offer.sdp.includes('v=0'), 'SDP must have v=0');
    assert.ok(offer.sdp.includes('a=fingerprint'), 'SDP must have a=fingerprint');

    // getStats
    const stats = await pc.getStats();
    assert.ok(stats.size > 0, 'getStats must return non-empty report');
    const types = [];
    stats.forEach((v) => types.push(v.type));
    assert.ok(types.includes('local-candidate') || types.includes('remote-candidate'), 'getStats must carry candidates');

    // close
    pc.close();
    assert.strictEqual(pc.signalingState, 'closed', 'signalingState must transition to closed');
  });

  // =========================================================================
  // 4. [P1] Injection Flaws: getLayoutMap & iOS window.chrome
  // =========================================================================
  console.log('\n--- Section 4: [P1] Injection Flaw Fixes ---');

  await asyncCheck('navigator.keyboard.getLayoutMap() iterators are standard Functions, NOT Generators', async () => {
    const fp = buildFingerprint({ id: 'test-kb-getmap', os: 'windows' });
    const script = buildInjectionScript(fp);

    const sandbox = vm.createContext({
      Keyboard: function Keyboard() {},
    });
    sandbox.Keyboard.prototype = {
      async getLayoutMap() {
        return {
          get() {},
          has() {},
          entries() {},
          keys() {},
          values() {},
          forEach() {},
        };
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInContext(script, sandbox);

    const map = await vm.runInContext('(async () => { const kb = new Keyboard(); return await kb.getLayoutMap(); })()', sandbox);
    sandbox.map = map;

    // 1. entries/keys/values constructors must be Function, not GeneratorFunction
    assert.strictEqual(map.entries.constructor.name, 'Function', 'map.entries must be a standard Function');
    assert.strictEqual(map.keys.constructor.name, 'Function', 'map.keys must be a standard Function');
    assert.strictEqual(map.values.constructor.name, 'Function', 'map.values must be a standard Function');

    // 2. toString returns [native code]
    const entriesStr = vm.runInContext('Function.prototype.toString.call(map.entries)', sandbox);
    assert.ok(entriesStr.includes('[native code]'), `entries toString must show [native code]: ${entriesStr}`);

    // 3. Iterators are Map Iterators, NOT Generator instances
    const iter = map.entries();
    const tag = vm.runInContext('Object.prototype.toString.call(map.entries())', sandbox);
    assert.strictEqual(tag, '[object Map Iterator]', `Iterator tag must be [object Map Iterator], got: ${tag}`);
    assert.notStrictEqual(iter.constructor.name, 'Generator', 'Iterator constructor must not be Generator');

    // 4. US keyboard mappings returned accurately
    assert.strictEqual(map.get('KeyQ'), 'q');
    assert.strictEqual(map.get('KeyW'), 'w');
    assert.strictEqual(map.has('KeyQ'), true);
    assert.strictEqual(map.has('NonExistentKey'), false);
  });

  check('iOS persona window.chrome is suppressed with introspection interception', () => {
    const fp = buildFingerprint({
      id: 'test-ios-chrome',
      os: 'ios',
      platform: 'iPhone',
    });
    const script = buildInjectionScript(fp);

    const sandbox = vm.createContext({
      Window: function Window() {},
      chrome: {
        app: { isInstalled: false },
        loadTimes: () => {},
        csi: () => {},
      },
    });
    sandbox.Window.prototype = {};
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInContext(script, sandbox);

    // Value is undefined
    assert.strictEqual(sandbox.window.chrome, undefined, 'window.chrome value must be undefined');
    assert.strictEqual(vm.runInContext('typeof window.chrome', sandbox), 'undefined', 'typeof window.chrome must be undefined');

    // Introspection APIs return false / undefined
    assert.strictEqual(vm.runInContext("Object.prototype.hasOwnProperty.call(window, 'chrome')", sandbox), false, 'hasOwnProperty must return false for chrome');
    assert.strictEqual(vm.runInContext("typeof Object.hasOwn === 'function' ? Object.hasOwn(window, 'chrome') : false", sandbox), false, 'Object.hasOwn must return false for chrome');
    assert.strictEqual(vm.runInContext("Object.getOwnPropertyDescriptor(window, 'chrome')", sandbox), undefined, 'getOwnPropertyDescriptor must return undefined');
    assert.strictEqual(vm.runInContext("Reflect.has(window, 'chrome')", sandbox), false, 'Reflect.has must return false for chrome');
    assert.strictEqual(vm.runInContext("Object.getOwnPropertyNames(window).includes('chrome')", sandbox), false, 'getOwnPropertyNames must not include chrome');

    // Sub-properties stripped
    assert.strictEqual(sandbox.window.chrome?.app, undefined);
    assert.strictEqual(sandbox.window.chrome?.loadTimes, undefined);
    assert.strictEqual(sandbox.window.chrome?.csi, undefined);
  });

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n======================================================================`);
  console.log(`Blue Team P0/P1 Fingerprint Selftest Summary:`);
  console.log(`Passed: ${passed} | Failed: ${failed}`);
  console.log(`======================================================================`);

  if (failed > 0) {
    process.exit(1);
  }
})();
