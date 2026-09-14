#!/usr/bin/env node
'use strict';

/**
 * Mobile Persona OS Detection & Font Isolation Selftest
 *
 * Verifies P0 fixes for:
 *  1. kernel-init-sync.js: detectOs / detectInitOs recognition of iOS / iPhone / iPad,
 *     MEDIA_POOLS_BY_OS iOS pool, active filtering of PC hardware, and invariant enforcement.
 *  2. device-personas.js: fontsForOs('ios') Apple/iOS font catalogue (no Menlo, no Segoe UI),
 *     exclusiveFontsForOtherOs('ios') protection of Apple fonts, and cross-OS stability.
 */

const assert = require('assert');
const path = require('path');

const {
  detectOs,
  detectInitOs,
  mediaLabelsFromFp,
  mapFingerprintToInitFields,
  validateKernelInitInvariants,
  MEDIA_POOLS_BY_OS,
} = require('./kernel-init-sync');

const {
  OS_FONTS,
  fontsForOs,
  exclusiveFontsForOtherOs,
  personasForOs,
  getHostWebglLimits,
  isCoherent,
} = require('./device-personas');

const { buildFingerprint } = require('./fingerprint');

let passedChecks = 0;
function check(description, fn) {
  try {
    fn();
    passedChecks += 1;
    console.log(`  PASS: ${description}`);
  } catch (err) {
    console.error(`  FAIL: ${description}`);
    console.error(err);
    process.exit(1);
  }
}

console.log('=== Running mobile-persona-os-font-fix-selftest ===\n');

// ============================================================================
// Section 1: kernel-init-sync.js - detectOs & detectInitOs for iOS/iPhone/iPad
// ============================================================================
console.log('--- Section 1: OS Detection (detectOs & detectInitOs) ---');

check('detectOs recognizes platform: iPhone as ios', () => {
  assert.strictEqual(detectOs({ platform: 'iPhone' }), 'ios');
});

check('detectOs recognizes platform: iPad as ios', () => {
  assert.strictEqual(detectOs({ platform: 'iPad' }), 'ios');
});

check('detectOs recognizes profile os: iOS as ios', () => {
  assert.strictEqual(detectOs({}, { os: 'iOS' }), 'ios');
  assert.strictEqual(detectOs({}, { os: 'ios' }), 'ios');
});

check('detectOs recognizes fp.uaProfile.os: ios as ios', () => {
  assert.strictEqual(detectOs({ uaProfile: { os: 'ios' } }), 'ios');
});

check('detectOs recognizes iOS User-Agent containing CPU iPhone OS ... like Mac OS X as ios', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/148.0.0.0 Mobile/15E148 Safari/604.1';
  assert.strictEqual(detectOs({}, { userAgent: ua }), 'ios');
});

check('detectInitOs recognizes init.platform: iPhone as ios', () => {
  assert.strictEqual(detectInitOs({ platform: 'iPhone' }), 'ios');
  assert.strictEqual(detectInitOs({ platform: 'iPad' }), 'ios');
});

check('detectInitOs recognizes init.user_agent_data.platform: iOS as ios', () => {
  assert.strictEqual(detectInitOs({ user_agent_data: { platform: 'iOS' } }), 'ios');
});

check('detectInitOs recognizes cmd_line user-agent as ios', () => {
  const init = {
    cmd_line: {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1',
    },
  };
  assert.strictEqual(detectInitOs(init), 'ios');
});

check('Non-regression: detectOs & detectInitOs for desktop and Android personas', () => {
  assert.strictEqual(detectOs({ platform: 'Win32' }), 'windows');
  assert.strictEqual(detectOs({ platform: 'MacIntel' }), 'macos');
  assert.strictEqual(detectOs({ platform: 'Linux x86_64' }), 'linux');
  assert.strictEqual(detectOs({ platform: 'Linux armv8l', uaProfile: { os: 'android' } }), 'android');

  assert.strictEqual(detectInitOs({ platform: 'Win32' }), 'windows');
  assert.strictEqual(detectInitOs({ platform: 'MacIntel' }), 'macos');
  assert.strictEqual(detectInitOs({ user_agent_data: { platform: 'Android' } }), 'android');
});

// ============================================================================
// Section 2: kernel-init-sync.js - MEDIA_POOLS_BY_OS & webrtc_media_labels
// ============================================================================
console.log('\n--- Section 2: Media Pools & Invariant Enforcement ---');

check('MEDIA_POOLS_BY_OS contains genuine iOS device pool', () => {
  assert.ok(MEDIA_POOLS_BY_OS.ios, 'MEDIA_POOLS_BY_OS.ios must be defined');
  assert.deepStrictEqual(MEDIA_POOLS_BY_OS.ios.audio_input, ['Built-in Microphone']);
  assert.deepStrictEqual(MEDIA_POOLS_BY_OS.ios.audio_output, ['Built-in Speaker']);
  assert.deepStrictEqual(MEDIA_POOLS_BY_OS.ios.video_input, ['Back Camera', 'Front Camera']);
});

check('mediaLabelsFromFp generates authentic iOS media labels without PC/Windows hardware', () => {
  const fp = { os: 'ios', platform: 'iPhone' };
  const labels = mediaLabelsFromFp(fp, { os: 'iOS' }, true);

  const allLabels = [
    ...labels.audio_input_labels,
    ...labels.audio_output_labels,
    ...labels.video_input_labels,
  ].join(' ');

  assert.ok(!/realtek/i.test(allLabels), 'Must not contain Realtek');
  assert.ok(!/conexant/i.test(allLabels), 'Must not contain Conexant');
  assert.ok(!/synaptics/i.test(allLabels), 'Must not contain Synaptics');
  assert.ok(!/integrated camera/i.test(allLabels), 'Must not contain Integrated Camera');
  assert.ok(!/macbook/i.test(allLabels), 'Must not contain MacBook');

  assert.deepStrictEqual(labels.audio_input_labels, ['Built-in Microphone']);
  assert.deepStrictEqual(labels.audio_output_labels, ['Built-in Speaker']);
  assert.deepStrictEqual(labels.video_input_labels, ['Back Camera', 'Front Camera']);
});

check('mediaLabelsFromFp filters out cross-platform Windows devices injected in fp.mediaDevices.devices', () => {
  const dirtyFp = {
    os: 'ios',
    platform: 'iPhone',
    mediaDevices: {
      devices: [
        { kind: 'audioinput', label: 'Microphone Array (Realtek(R) Audio)' },
        { kind: 'audiooutput', label: 'Speaker (Realtek(R) Audio)' },
        { kind: 'videoinput', label: 'Integrated Camera (2ef2:6ce3)' },
      ],
    },
  };
  const labels = mediaLabelsFromFp(dirtyFp, { os: 'iOS' }, true);
  assert.deepStrictEqual(labels.audio_input_labels, ['Built-in Microphone']);
  assert.deepStrictEqual(labels.audio_output_labels, ['Built-in Speaker']);
  assert.deepStrictEqual(labels.video_input_labels, ['Back Camera', 'Front Camera']);
});

check('validateKernelInitInvariants accepts valid iOS persona with Apple media devices', () => {
  const init = {
    platform: 'iPhone',
    is_webrtc_enable: true,
    webrtc_policy: 1,
    webrtc_local_ip: '192.168.1.100',
    is_enumerate_devices_enable: true,
    webrtc_media_labels: {
      audio_input_labels: ['Built-in Microphone'],
      audio_output_labels: ['Built-in Speaker'],
      communications_text: 'Communications - ',
      default_text: 'Default - ',
      video_input_labels: ['Back Camera', 'Front Camera'],
    },
  };
  const res = validateKernelInitInvariants(init);
  assert.strictEqual(res.valid, true, `Expected valid, got issues: ${res.issues.join('; ')}`);
});

check('validateKernelInitInvariants rejects Windows device on iOS persona', () => {
  const init = {
    platform: 'iPhone',
    is_webrtc_enable: true,
    webrtc_policy: 1,
    webrtc_local_ip: '192.168.1.100',
    is_enumerate_devices_enable: true,
    webrtc_media_labels: {
      audio_input_labels: ['Microphone Array (2- Realtek High Definition Audio)'],
      audio_output_labels: ['Built-in Speaker'],
      communications_text: 'Communications - ',
      default_text: 'Default - ',
      video_input_labels: ['Back Camera'],
    },
  };
  const res = validateKernelInitInvariants(init);
  assert.strictEqual(res.valid, false);
  assert.ok(res.issues.some((i) => i.includes('contains Windows device')), `Expected Windows device violation, got: ${res.issues}`);
});

check('validateKernelInitInvariants rejects Integrated Camera on iOS persona', () => {
  const init = {
    platform: 'iPhone',
    is_webrtc_enable: true,
    webrtc_policy: 1,
    webrtc_local_ip: '192.168.1.100',
    is_enumerate_devices_enable: true,
    webrtc_media_labels: {
      audio_input_labels: ['Built-in Microphone'],
      audio_output_labels: ['Built-in Speaker'],
      communications_text: 'Communications - ',
      default_text: 'Default - ',
      video_input_labels: ['Integrated Camera (a314:f306)'],
    },
  };
  const res = validateKernelInitInvariants(init);
  assert.strictEqual(res.valid, false);
  assert.ok(res.issues.some((i) => i.includes('contains Windows device')), `Expected Windows device violation, got: ${res.issues}`);
});

check('validateKernelInitInvariants rejects macOS MacBook device on iOS persona', () => {
  const init = {
    platform: 'iPhone',
    is_webrtc_enable: true,
    webrtc_policy: 1,
    webrtc_local_ip: '192.168.1.100',
    is_enumerate_devices_enable: true,
    webrtc_media_labels: {
      audio_input_labels: ['Built-in Microphone'],
      audio_output_labels: ['MacBook Pro Speakers'],
      communications_text: 'Communications - ',
      default_text: 'Default - ',
      video_input_labels: ['Back Camera'],
    },
  };
  const res = validateKernelInitInvariants(init);
  assert.strictEqual(res.valid, false);
  assert.ok(res.issues.some((i) => i.includes('contains macOS device')), `Expected macOS device violation, got: ${res.issues}`);
});

// ============================================================================
// Section 3: device-personas.js - fontsForOs & exclusiveFontsForOtherOs
// ============================================================================
console.log('\n--- Section 3: Font Pools & Cross-OS Isolation ---');

check('OS_FONTS.ios is defined and contains Apple font families', () => {
  assert.ok(Array.isArray(OS_FONTS.ios), 'OS_FONTS.ios must be an array');
  assert.ok(OS_FONTS.ios.length >= 30, `Expected at least 30 iOS fonts, got ${OS_FONTS.ios.length}`);
  assert.ok(OS_FONTS.ios.includes('PingFang SC'), 'Must include PingFang SC');
  assert.ok(OS_FONTS.ios.includes('Helvetica Neue'), 'Must include Helvetica Neue');
  assert.ok(OS_FONTS.ios.includes('Hiragino Sans'), 'Must include Hiragino Sans');
  assert.ok(OS_FONTS.ios.includes('Apple SD Gothic Neo ExtraBold'), 'Must include Apple SD Gothic Neo ExtraBold');
  assert.ok(OS_FONTS.ios.includes('Avenir Next'), 'Must include Avenir Next');
  assert.ok(OS_FONTS.ios.includes('Baskerville'), 'Must include Baskerville');
  assert.ok(OS_FONTS.ios.includes('Optima'), 'Must include Optima');
});

check('OS_FONTS.ios does not contain Windows exclusive fonts', () => {
  const winExclusive = ['Segoe UI', 'Calibri', 'Bahnschrift', 'SimSun', 'Malgun Gothic', 'Cambria'];
  for (const f of winExclusive) {
    assert.ok(!OS_FONTS.ios.includes(f), `iOS font pool must not contain Windows font: ${f}`);
  }
});

check('OS_FONTS.ios does not contain desktop terminal/developer fonts', () => {
  const desktopTerminal = ['Menlo', 'Monaco', 'Andale Mono', 'Geneva', 'Lucida Grande'];
  for (const f of desktopTerminal) {
    assert.ok(!OS_FONTS.ios.includes(f), `iOS font pool must not contain desktop developer font: ${f}`);
  }
});

check('fontsForOs(ios) returns Apple/iOS font catalogue', () => {
  const fonts = fontsForOs('ios');
  assert.strictEqual(fonts, OS_FONTS.ios);
  assert.ok(fonts.includes('PingFang SC'));
  assert.ok(fonts.includes('Helvetica Neue'));
  assert.ok(!fonts.includes('Segoe UI'));
  assert.ok(!fonts.includes('Calibri'));
  assert.ok(!fonts.includes('Bahnschrift'));
  assert.ok(!fonts.includes('Menlo'));
});

check('fontsForOs(iPhone) and fontsForOs(iPad) resolve to iOS font catalogue', () => {
  assert.strictEqual(fontsForOs('iPhone'), OS_FONTS.ios);
  assert.strictEqual(fontsForOs('iPad'), OS_FONTS.ios);
  assert.strictEqual(fontsForOs('iOS'), OS_FONTS.ios);
});

check('exclusiveFontsForOtherOs(ios) does NOT treat Apple fonts as foreign', () => {
  const foreign = exclusiveFontsForOtherOs('ios');
  const foreignLower = foreign.map((f) => f.toLowerCase());

  // Apple fonts must NOT be treated as foreign to iOS
  assert.ok(!foreignLower.includes('pingfang sc'), 'PingFang SC must NOT be foreign to iOS');
  assert.ok(!foreignLower.includes('pingfang hk light'), 'PingFang HK must NOT be foreign to iOS');
  assert.ok(!foreignLower.includes('helvetica neue'), 'Helvetica Neue must NOT be foreign to iOS');
  assert.ok(!foreignLower.includes('hiragino sans'), 'Hiragino Sans must NOT be foreign to iOS');
  assert.ok(!foreignLower.includes('apple sd gothic neo extrabold'), 'Apple SD Gothic Neo must NOT be foreign to iOS');
  assert.ok(!foreignLower.includes('avenir next'), 'Avenir Next must NOT be foreign to iOS');
  assert.ok(!foreignLower.includes('baskerville'), 'Baskerville must NOT be foreign to iOS');
  assert.ok(!foreignLower.includes('optima'), 'Optima must NOT be foreign to iOS');
  assert.ok(!foreignLower.includes('menlo'), 'Menlo (macOS Apple font) must NOT be foreign to iOS');
  assert.ok(!foreignLower.includes('monaco'), 'Monaco (macOS Apple font) must NOT be foreign to iOS');
});

check('exclusiveFontsForOtherOs(ios) DOES contain Windows, Linux, and Android exclusive fonts', () => {
  const foreign = exclusiveFontsForOtherOs('ios');

  // Windows fonts
  assert.ok(foreign.includes('Segoe UI'), 'Segoe UI must be foreign to iOS');
  assert.ok(foreign.includes('Calibri'), 'Calibri must be foreign to iOS');
  assert.ok(foreign.includes('Bahnschrift'), 'Bahnschrift must be foreign to iOS');
  assert.ok(foreign.includes('SimSun'), 'SimSun must be foreign to iOS');

  // Linux fonts
  assert.ok(foreign.includes('Ubuntu'), 'Ubuntu must be foreign to iOS');
  assert.ok(foreign.includes('Cantarell'), 'Cantarell must be foreign to iOS');

  // Android fonts
  assert.ok(foreign.includes('Roboto'), 'Roboto must be foreign to iOS');
  assert.ok(foreign.includes('Droid Sans'), 'Droid Sans must be foreign to iOS');
});

check('Non-regression: exclusiveFontsForOtherOs on Windows, macOS, Android', () => {
  const foreignWin = exclusiveFontsForOtherOs('windows');
  assert.ok(foreignWin.includes('PingFang SC'), 'PingFang SC must be foreign to Windows');
  assert.ok(foreignWin.includes('Helvetica Neue'), 'Helvetica Neue must be foreign to Windows');
  assert.ok(!foreignWin.includes('Segoe UI'), 'Segoe UI must NOT be foreign to Windows');

  const foreignMac = exclusiveFontsForOtherOs('macos');
  assert.ok(foreignMac.includes('Segoe UI'), 'Segoe UI must be foreign to macOS');
  assert.ok(!foreignMac.includes('PingFang SC'), 'PingFang SC must NOT be foreign to macOS');

  const foreignAndr = exclusiveFontsForOtherOs('android');
  assert.ok(foreignAndr.includes('Segoe UI'), 'Segoe UI must be foreign to Android');
  assert.ok(foreignAndr.includes('Helvetica Neue'), 'Helvetica Neue must be foreign to Android');
  assert.ok(!foreignAndr.includes('Roboto'), 'Roboto must NOT be foreign to Android');
});

// ============================================================================
// Section 4: End-to-End Mapping & Pipeline Audit
// ============================================================================
console.log('\n--- Section 4: End-to-End Fingerprint to Kernel Init Mapping ---');

check('Live mapping of iPhone profile to kernel init produces complete, invariant-clean init.json', () => {
  const iosConfig = {
    id: 'test-selftest-ios',
    name: 'iPhone 16 Plus',
    os: 'iOS',
    kernelVersion: '148.0.7778.165',
    fingerprintLaunchSeed: '42',
    canvas: 'noise',
    webgl: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    webrtc: 'proxy',
    privacy: {
      timezone: 'America/New_York',
      languages: ['en-US', 'en'],
    },
  };

  const fp = buildFingerprint(iosConfig);
  const init = mapFingerprintToInitFields(fp, iosConfig);

  assert.strictEqual(init.platform, 'iPhone');
  assert.strictEqual(detectOs(fp, iosConfig), 'ios');
  assert.strictEqual(detectInitOs(init), 'ios');

  // WebRTC media labels
  const ml = init.webrtc_media_labels;
  assert.ok(ml, 'webrtc_media_labels must be defined');
  assert.deepStrictEqual(ml.audio_input_labels, ['Built-in Microphone']);
  assert.deepStrictEqual(ml.audio_output_labels, ['Built-in Speaker']);
  assert.deepStrictEqual(ml.video_input_labels, ['Back Camera', 'Front Camera']);

  // Invariant validation must be 100% clean
  const inv = validateKernelInitInvariants(init);
  assert.strictEqual(inv.valid, true, `Invariants must hold, got issues: ${inv.issues.join('; ')}`);
  assert.strictEqual(inv.issues.length, 0);
});

console.log(`\nmobile-persona-os-font-fix-selftest: ALL ${passedChecks} CHECKS PASSED!\n`);
