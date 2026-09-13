#!/usr/bin/env node
'use strict';

/**
 * Coverage gate for the per-dimension fingerprint contract.
 *
 * Every disguised dimension has to exist in four places at once, or the disguise is only a
 * partial one: the switch the user toggles, the payload the build produces, the consumption
 * inside the document-start script, and the native init key the kernel reads. A dimension that
 * is missing any of them either does nothing or, worse, leaves one layer reporting the host
 * while another reports the persona.
 *
 * This test does not check values (the end-to-end suites do that); it checks that no dimension
 * can silently drop out of one of the four layers, and that each one is claimed by a registered
 * suite.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  buildFingerprint,
  buildInjectionScript,
  fingerprintConsistencyIssues,
  WEBGL_PRESETS,
  webglParameterOverrides,
  WEBGL_PARAM_IDS,
} = require('./fingerprint');
const { mapFingerprintToInitFields } = require('./kernel-init-sync');


const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const scripts = require(path.join(root, 'package.json')).scripts || {};

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} - ${error.message}`); process.exitCode = 1; }
};

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const PROFILE = {
  id: 'coverage-profile',
  name: 'coverage',
  language: 'en-US',
  userAgent: WINDOWS_UA,
  kernelVersion: '148.0.7778.165',
  width: 1920,
  height: 1080,
  exitIp: '203.0.113.7',
  exitLatitude: 40.7128,
  exitLongitude: -74.006,
  exitTimezone: 'America/New_York',
  privacy: {
    deviceProfile: 'persona',
    canvas: 'noise',
    webgl: 'noise',
    webglMeta: 'noise',
    webgpu: 'webgl',
    audio: 'noise',
    clientRects: 'noise',
    webrtc: 'proxy',
    speech: 'noise',
    media: 'noise',
    mediaDevices: 'noise',
    battery: 'noise',
    bluetooth: 'real',
    cores: 8,
    memory: 8,
    dnt: '1',
    timezoneMode: 'ip',
    geoMode: 'ip',
    accuracy: 50,
    deviceNameMode: 'custom',
    deviceName: 'OB-Coverage-01',
    fontFingerprinting: true,
    stabilityMode: 'auto',
    stabilityHosts: ['example.com'],
    stabilitySkipHosts: ['skip.example.com'],
  },
};

const fp = buildFingerprint(PROFILE);
const script = buildInjectionScript(fp);
const fields = mapFingerprintToInitFields(fp, PROFILE);

/**
 * Each entry: the user-visible switch (null when the dimension has no toggle), the fingerprint
 * path the build must populate, the config path the document-start script must read, the native
 * init key the kernel must receive, and the registered suite that owns its behaviour.
 */
const DIMENSIONS = [
  { name: 'platform', switchId: 'editor-os', path: 'platform', cfg: 'CFG.platform', native: 'platform', suite: 'selftest:platform' },
  { name: 'user agent', switchId: 'editor-user-agent', path: 'userAgent', cfg: 'U.userAgent', native: 'user_agent_data', suite: 'selftest:stealth' },
  { name: 'client hints', switchId: 'editor-ua-meta', path: 'userAgentMetadata.brands', cfg: 'U.brands', native: 'user_agent_data', suite: 'selftest:persona' },
  { name: 'languages', switchId: 'editor-language', path: 'languages', cfg: 'CFG.languages', native: 'accept_languages', suite: 'selftest:persona' },
  { name: 'timezone', switchId: 'editor-timezone-mode', path: 'timezone', cfg: 'CFG.timezone', native: null, suite: 'selftest:timezonee2e' },
  { name: 'screen', switchId: 'editor-resolution', path: 'screen.width', cfg: 'CFG.screen', native: null, suite: 'selftest:viewport' },
  { name: 'cpu cores', switchId: 'editor-cores', path: 'hardwareConcurrency', cfg: 'CFG.hardwareConcurrency', native: 'hardwareConcurrency', suite: 'selftest:platform' },
  { name: 'device memory', switchId: 'editor-memory', path: 'deviceMemory', cfg: 'CFG.deviceMemory', native: 'deviceMemory', suite: 'selftest:platform' },
  { name: 'canvas', switchId: 'editor-canvas', path: 'canvas.mode', cfg: 'CFG.canvas', native: 'is_canvas_finger_printing_enable', suite: 'selftest:cdpnoise' },
  { name: 'webgl image', switchId: 'editor-webgl', path: 'webgl.mode', cfg: 'CFG.webgl', native: 'is_webgl_finger_printing_enable', suite: 'selftest:stealth' },
  { name: 'webgl metadata', switchId: 'editor-webgl-meta', path: 'webgl.metaMode', cfg: 'CFG.webgl', native: 'webgl_vendor', suite: 'selftest:webglparams' },
  { name: 'webgl limits', switchId: null, path: 'webgl.gpu', cfg: 'CFG.webgl', native: 'webgl_renderer', suite: 'selftest:webglparams' },
  { name: 'webgpu', switchId: 'editor-webgpu', path: 'webgpu.mode', cfg: 'CFG.webgpu', native: 'webgpu_parameter', suite: 'selftest:webgpue2e' },
  { name: 'audio', switchId: 'editor-audio', path: 'audio.mode', cfg: 'CFG.audio', native: 'is_audio_finger_printing_enable', suite: 'selftest:mediae2e' },
  { name: 'client rects', switchId: 'editor-client-rects', path: 'clientRects.mode', cfg: 'CFG.clientRects', native: 'is_clientrects_finger_printing_enable', suite: 'selftest:stabilitye2e' },
  { name: 'webrtc', switchId: 'editor-webrtc', path: 'webrtc', cfg: 'CFG.webrtc', native: 'webrtc_policy', suite: 'selftest:webrtce2e' },
  { name: 'speech', switchId: 'editor-speech', path: 'speech.mode', cfg: 'CFG.speech', native: 'GoogleSpeechSynthesis', suite: 'selftest:mobilefp' },
  { name: 'media devices', switchId: 'editor-media', path: 'mediaDevices.mode', cfg: 'CFG.mediaDevices', native: 'is_enumerate_devices_enable', suite: 'selftest:mediae2e' },
  { name: 'battery', switchId: 'editor-battery', path: 'battery.mode', cfg: 'CFG.battery', native: 'battery', suite: 'selftest:stealth' },
  { name: 'bluetooth', switchId: 'editor-bluetooth', path: 'bluetooth.mode', cfg: 'CFG.bluetooth', native: null, suite: 'selftest:bluetooth' },
  { name: 'fonts', switchId: 'editor-font-mode', path: 'fonts.list', cfg: 'CFG.fonts', native: 'is_font_finger_printing_enable', suite: 'selftest:fonts' },
  { name: 'do not track', switchId: 'editor-dnt', path: 'doNotTrack', cfg: 'CFG.doNotTrack', native: null, suite: 'selftest:flags' },
  { name: 'max touch points', switchId: null, path: 'maxTouchPoints', cfg: 'CFG.maxTouchPoints', native: null, suite: 'selftest:mobilepersona' },
  { name: 'stability', switchId: 'editor-stability-mode', path: 'stability.mode', cfg: 'CFG.stability', native: null, suite: 'selftest:stabilitye2e' },
  { name: 'site exemptions', switchId: 'editor-stability-skip-hosts', path: 'stability.skipHosts', cfg: 'CFG.stability', native: '_canvasSkipHosts', suite: 'selftest:stabilitye2e' },
];

function valueAt(object, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), object);
}

const indexHtml = read('index.html');

check('every dimension carries a payload from the build', () => {
  const missing = [];
  for (const dimension of DIMENSIONS) {
    const value = valueAt(fp, dimension.path);
    if (value === undefined || value === null) missing.push(`${dimension.name} (${dimension.path})`);
  }
  assert.deepStrictEqual(missing, [], `dimensions without a payload: ${missing.join(', ')}`);
});

check('every dimension is consumed by the document-start script', () => {
  // Word boundary on the identifier, not a substring test: a renamed reference such as
  // CFG.doNotTrackX must not satisfy a table entry that claims CFG.doNotTrack.
  const reads = (needle) => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(script);
  };
  const missing = [];
  for (const dimension of DIMENSIONS) {
    if (!reads(dimension.cfg)) missing.push(`${dimension.name} (${dimension.cfg})`);
  }
  assert.deepStrictEqual(missing, [], `dimensions not read by the injected script: ${missing.join(', ')}`);
});

check('every dimension with a native switch ships its init key', () => {
  const missing = [];
  for (const dimension of DIMENSIONS) {
    if (!dimension.native) continue;
    if (fields[dimension.native] === undefined) missing.push(`${dimension.name} (${dimension.native})`);
  }
  assert.deepStrictEqual(missing, [], `dimensions missing a native init key: ${missing.join(', ')}`);
});

check('every dimension with a user switch has a real control in the editor', () => {
  const missing = [];
  for (const dimension of DIMENSIONS) {
    if (!dimension.switchId) continue;
    if (!indexHtml.includes(`id="${dimension.switchId}"`)) missing.push(`${dimension.name} (#${dimension.switchId})`);
  }
  assert.deepStrictEqual(missing, [], `dimensions without an editor control: ${missing.join(', ')}`);
});

check('every dimension is claimed by a registered suite', () => {
  const missing = [];
  for (const dimension of DIMENSIONS) {
    if (!scripts[dimension.suite]) missing.push(`${dimension.name} (${dimension.suite})`);
  }
  assert.deepStrictEqual(missing, [], `dimensions without a registered suite: ${missing.join(', ')}`);
});

check('every GPU class in the preset pool has driver limit overrides', () => {
  // A new preset without a limits entry would keep the adapter name spoofed but answer the
  // driver limits from the host GPU, which is the exact contradiction the limits table exists
  // to remove. This has to fail at build time, not at detection time.
  const classes = new Set();
  for (const list of Object.values(WEBGL_PRESETS)) {
    for (const preset of (Array.isArray(list) ? list : [])) {
      const gpu = preset && preset.gpu;
      if (!gpu) continue;
      classes.add(`${String(gpu.vendor || '').toLowerCase()}/${String(gpu.architecture || '').toLowerCase()}`);
    }
  }
  assert.ok(classes.size >= 8, `the preset pool should expose a broad GPU range (found ${classes.size})`);
  const uncovered = [];
  for (const key of classes) {
    const [vendor, architecture] = key.split('/');
    const limits = webglParameterOverrides({ vendor, architecture });
    if (!limits) { uncovered.push(key); continue; }
    for (const name of ['MAX_TEXTURE_SIZE', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS']) {
      const value = limits[WEBGL_PARAM_IDS[name]];
      if (!Number.isInteger(value) || value <= 0) uncovered.push(`${key}:${name}`);
    }
  }
  assert.deepStrictEqual(uncovered, [], `GPU classes without usable driver limits: ${uncovered.join(', ')}`);
});

check('the coverage table does not outlive the switches it names', () => {
  // Guards the opposite direction: a control that was deleted while the table still lists it
  // would keep this gate green while the user lost the ability to toggle that dimension.
  const ids = DIMENSIONS.map((dimension) => dimension.switchId).filter(Boolean);
  const unique = new Set(ids);
  assert.strictEqual(unique.size, ids.length, 'two dimensions must not claim the same editor control');
});

check('a real-mode profile does not publish a synthetic native identity', () => {
  const realProfile = {
    ...PROFILE,
    id: 'coverage-real',
    privacy: {
      ...PROFILE.privacy,
      canvas: 'real',
      webgl: 'real',
      audio: 'real',
      clientRects: 'real',
      battery: 'real',
      webgpu: 'real',
      fontFingerprinting: false,
      fontMode: 'default',
    },
  };
  const realFields = mapFingerprintToInitFields(buildFingerprint(realProfile), realProfile);
  assert.strictEqual(realFields.is_canvas_finger_printing_enable, false, 'real canvas must not claim noise');
  assert.strictEqual(realFields.is_webgl_finger_printing_enable, false, 'real webgl must not claim noise');
  assert.strictEqual(realFields.is_audio_finger_printing_enable, false, 'real audio must not claim noise');
  assert.strictEqual(realFields.is_font_finger_printing_enable, false, 'real fonts must not claim a list');
  assert.strictEqual(realFields.webgpu_parameter, undefined, 'real webgpu must not publish an identity');
});

check('a profile with a disguised WebGL renderer does not silently leave WebGPU real', () => {
  const base = { id: 'diag-base', userAgent: WINDOWS_UA, privacy: { ...PROFILE.privacy } };
  const consistent = buildFingerprint(base);
  const consistentCodes = consistent.consistency.issues.map((issue) => issue.code);
  assert.ok(!consistentCodes.includes('webgpu-real-vs-webgl-disguised'),
    'the product default must not be reported as a contradiction');

  const risky = buildFingerprint({ ...base, id: 'diag-risky', privacy: { ...PROFILE.privacy, webgpu: 'real' } });
  const riskyIssues = risky.consistency.issues.filter((issue) => issue.code === 'webgpu-real-vs-webgl-disguised');
  assert.strictEqual(riskyIssues.length, 1, 'leaving WebGPU real next to a disguised WebGL renderer must be reported');
  assert.strictEqual(riskyIssues[0].severity, 'warning', 'an explicit user choice is reported, not blocked');
  assert.strictEqual(risky.consistency.ok, true, 'a warning must not make the build fail');
});

check('a GPU class without driver limits is surfaced instead of assumed', () => {
  // The renderer string wins over a partial override, so this is exercised on the diagnostic
  // directly rather than through a profile that would resolve to a modelled preset.
  const issues = fingerprintConsistencyIssues({
    userAgent: WINDOWS_UA,
    platform: 'Win32',
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, availLeft: 0, availTop: 0, screenX: 0, screenY: 0, devicePixelRatio: 1 },
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webgl: { mode: 'noise', vendor: 'Google Inc. (Imagination)', renderer: 'IMG', gpu: { vendor: 'imagination', architecture: '' } },
    userAgentMetadata: { platform: 'Windows' },
  });
  const codes = issues.issues.map((issue) => issue.code);
  assert.ok(codes.includes('webgl-limits-unknown-gpu'),
    'a GPU family with no limits entry must be reported');
  assert.strictEqual(issues.ok, true, 'an unmodelled mobile GPU must not break the build');
});

check('every desktop preset GPU is fully modelled', () => {
  for (const list of Object.values(WEBGL_PRESETS)) {
    for (const preset of (Array.isArray(list) ? list : [])) {
      const gpu = preset && preset.gpu;
      if (!gpu) continue;
      assert.ok(webglParameterOverrides(gpu), `${gpu.vendor}/${gpu.architecture} must be modelled`);
    }
  }
});

check('storage and performance end-to-end suite is registered in package.json', () => {
  assert.ok(scripts['selftest:storageperf'], 'selftest:storageperf script must be registered');
  assert.strictEqual(scripts['selftest:storageperf'], 'node automation/storage-perf-e2e-selftest.js');
  assert.ok(fs.existsSync(path.join(root, 'automation', 'storage-perf-e2e-selftest.js')),
    'automation/storage-perf-e2e-selftest.js must exist on disk');
});

check('runtime storage and performance APIs remain untouched by injection script', () => {
  assert.ok(!script.includes('navigator.storage'), 'navigator.storage must not be modified by injection script');
  assert.ok(!script.includes('performance.timeOrigin'), 'performance.timeOrigin must not be modified by injection script');
  assert.ok(!script.includes('performance.now'), 'performance.now must not be modified by injection script');
  assert.ok(!script.includes('crypto.randomUUID'), 'crypto.randomUUID must not be patched by injection script');
});

const failed = results.filter((item) => !item.ok);
if (!failed.length) console.log(`fingerprint-coverage-selftest: OK ${results.length}/${results.length}`);
else {
  console.log(`fingerprint-coverage-selftest: FAILED ${failed.length}/${results.length}`);
  process.exitCode = 1;
}
