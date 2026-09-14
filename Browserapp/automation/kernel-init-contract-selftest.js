'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  mapFingerprintToInitFields,
  applyFingerprintFields,
  writeOpenBrowserKernelInit,
  canvasSkipHostsFromFp,
  fontListFromFp,
  loadInitObject,
  validateKernelInitInvariants,
} = require('./kernel-init-sync');
const { buildFingerprint } = require('./fingerprint');

async function main() {
  console.log('=== Running kernel-init-contract-selftest ===');

  // =========================================================================
  // Section A: Font fingerprint switch and list paired invariant
  // =========================================================================
  console.log('Testing Section A: Font fingerprint switch and list paired invariant...');

  // 1. Profile with explicit fontFingerprinting: true -> switch on + non-empty font_list
  const fontEnabledProfile = {
    id: 'font-enabled-profile',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0',
    privacy: {
      fontFingerprinting: true,
    },
    kernelVersion: '148.0.7778.165',
  };
  const fontEnabledFp = buildFingerprint(fontEnabledProfile);
  const fontEnabledFields = mapFingerprintToInitFields(fontEnabledFp, fontEnabledProfile);
  assert.strictEqual(fontEnabledFields.is_font_finger_printing_enable, true,
    'fontFingerprinting=true must set is_font_finger_printing_enable to true');
  assert.ok(Array.isArray(fontEnabledFields.font_list) && fontEnabledFields.font_list.length > 0,
    'fontFingerprinting=true must provide a non-empty font_list');
  assert.ok(fontEnabledFields.font_list.includes('Segoe UI'),
    'Windows profile must include Segoe UI');

  // 2. Profile with fontMode: 'noise' / 'spoof'
  for (const mode of ['noise', 'spoof']) {
    const p = {
      id: `font-mode-${mode}`,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0',
      privacy: { fontMode: mode },
    };
    const f = mapFingerprintToInitFields(buildFingerprint(p), p);
    assert.strictEqual(f.is_font_finger_printing_enable, true,
      `fontMode=${mode} must enable font fingerprinting`);
    assert.ok(Array.isArray(f.font_list) && f.font_list.length > 0,
      `fontMode=${mode} must supply non-empty font_list`);
  }

  // 3. Default / plain profile -> switch off + no font_list
  const plainProfile = {
    id: 'plain-profile',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0',
    privacy: {},
  };
  const plainFields = mapFingerprintToInitFields(buildFingerprint(plainProfile), plainProfile);
  assert.strictEqual(plainFields.is_font_finger_printing_enable, false,
    'default profile must keep font fingerprinting disabled');
  assert.strictEqual(plainFields.font_list, undefined,
    'default profile must NOT contain font_list in fields');

  // 4. fontListFromFp with blank/invalid entries falls back to OS fonts
  const blankFontListFp = {
    platform: 'windows',
    fonts: { list: ['', '   ', null, undefined] },
  };
  const recoveredList = fontListFromFp(blankFontListFp);
  assert.ok(Array.isArray(recoveredList) && recoveredList.length > 0,
    'blank persona list must safely fall back to OS fonts rather than empty');

  // 5. Invariant in applyFingerprintFields: existing init with font_list must be cleaned up when disabled
  const dirtyInit = {
    is_font_finger_printing_enable: true,
    font_list: ['OldFontA', 'OldFontB'],
    full_font_list: ['OldFontA', 'OldFontB'],
  };
  applyFingerprintFields(dirtyInit, plainFields);
  assert.strictEqual(dirtyInit.is_font_finger_printing_enable, false,
    'applyFingerprintFields must turn switch to false for plain profile');
  assert.strictEqual(dirtyInit.font_list, undefined,
    'applyFingerprintFields must remove existing font_list when switch is false');
  assert.strictEqual(dirtyInit.full_font_list, undefined,
    'applyFingerprintFields must remove existing full_font_list when switch is false');

  // 6. Contradiction defense: switch true with empty list -> forced to false and cleaned
  const contradictoryInit = {};
  applyFingerprintFields(contradictoryInit, {
    is_font_finger_printing_enable: true,
    font_list: [],
  });
  assert.strictEqual(contradictoryInit.is_font_finger_printing_enable, false,
    'switch true with empty list must be downgraded to false');
  assert.strictEqual(contradictoryInit.font_list, undefined,
    'switch true with empty list must not retain font_list');

  // 7. Contradiction defense: switch true with missing font_list -> forced to false
  const missingListInit = {};
  applyFingerprintFields(missingListInit, {
    is_font_finger_printing_enable: true,
  });
  assert.strictEqual(missingListInit.is_font_finger_printing_enable, false,
    'switch true with missing font_list must be downgraded to false');
  assert.strictEqual(missingListInit.font_list, undefined);

  // 8. Contradiction defense: switch false with non-empty list -> list removed
  const switchOffWithListInit = {};
  applyFingerprintFields(switchOffWithListInit, {
    is_font_finger_printing_enable: false,
    font_list: ['Arial', 'Tahoma'],
  });
  assert.strictEqual(switchOffWithListInit.is_font_finger_printing_enable, false);
  assert.strictEqual(switchOffWithListInit.font_list, undefined,
    'switch false must never retain font_list');

  console.log('Section A: OK');

  // =========================================================================
  // Section B: canvas / webgl exemption list co-source invariant
  // =========================================================================
  console.log('Testing Section B: canvas / webgl exemption list co-source invariant...');

  // 1. Normal mapping: _canvasSkipHosts and _webglSkipHosts must be identical
  const fpWithSkip = {
    stability: {
      skipHosts: ['sephora.com', 'bybit.com', 'whatsapp.com'],
    },
  };
  const fieldsWithSkip = mapFingerprintToInitFields(fpWithSkip, {});
  assert.deepStrictEqual(fieldsWithSkip._canvasSkipHosts, fieldsWithSkip._webglSkipHosts,
    'fields._canvasSkipHosts and _webglSkipHosts must be identical');

  const initWithSkip = {};
  applyFingerprintFields(initWithSkip, fieldsWithSkip);
  assert.deepStrictEqual(initWithSkip.canvas_fingerprint_skip_hosts, initWithSkip.webgl_fingerprint_skip_hosts,
    'init.canvas_fingerprint_skip_hosts and webgl_fingerprint_skip_hosts must be identical');

  // 2. Boundary: Empty array skipHosts: []
  const fpEmptySkip = {
    stability: {
      skipHosts: [],
    },
  };
  const fieldsEmptySkip = mapFingerprintToInitFields(fpEmptySkip, {});
  assert.deepStrictEqual(fieldsEmptySkip._canvasSkipHosts, [], 'empty skipHosts yields []');
  assert.deepStrictEqual(fieldsEmptySkip._webglSkipHosts, [], 'empty skipHosts yields []');
  const initEmptySkip = {};
  applyFingerprintFields(initEmptySkip, fieldsEmptySkip);
  assert.deepStrictEqual(initEmptySkip.canvas_fingerprint_skip_hosts, []);
  assert.deepStrictEqual(initEmptySkip.webgl_fingerprint_skip_hosts, []);
  assert.deepStrictEqual(initEmptySkip.canvas_fingerprint_skip_hosts, initEmptySkip.webgl_fingerprint_skip_hosts);

  // 3. Boundary: Invalid items handling
  const dirtySkipInput = [
    null,
    undefined,
    '',
    '   ',
    {},
    [],
    true,
    false,
    'https://',
    '*.',
    'https://*.',
    'foo bar.com',
    'HTTPS://*.SEPHORA.COM/path/to/cart?id=123#checkout',
    'bybit.com',
    'https://bybit.com/',
  ];
  const cleanedSkip = canvasSkipHostsFromFp({ stability: { skipHosts: dirtySkipInput } });
  assert.deepStrictEqual(cleanedSkip, ['sephora.com', 'bybit.com'],
    'dirty skipHosts must be normalized, deduplicated, and free of invalid/corrupt entries');

  const dirtyInitObj = {};
  applyFingerprintFields(dirtyInitObj, { _canvasSkipHosts: cleanedSkip, _webglSkipHosts: cleanedSkip });
  assert.deepStrictEqual(dirtyInitObj.canvas_fingerprint_skip_hosts, dirtyInitObj.webgl_fingerprint_skip_hosts);
  assert.deepStrictEqual(dirtyInitObj.canvas_fingerprint_skip_hosts, ['sephora.com', 'bybit.com']);

  // 4. Boundary: Super long list
  const longList = [];
  for (let i = 0; i < 500; i++) {
    longList.push(`https://*.DOMAIN-${i % 50}.COM/page/${i}`);
  }
  const longCleaned = canvasSkipHostsFromFp({ stability: { skipHosts: longList } });
  assert.strictEqual(longCleaned.length, 50, '500 items across 50 domains must deduplicate to exactly 50');
  const longInit = {};
  applyFingerprintFields(longInit, { _canvasSkipHosts: longCleaned, _webglSkipHosts: longCleaned });
  assert.deepStrictEqual(longInit.canvas_fingerprint_skip_hosts, longInit.webgl_fingerprint_skip_hosts);
  assert.strictEqual(longInit.canvas_fingerprint_skip_hosts.length, 50);

  // 5. Boundary: Case and wildcard normalization
  const normInput = [
    'HTTPS://Example.COM:8080/path',
    '*.Foo.Bar.Com',
    'EXAMPLE.com:8080',
    '  *.BAZ.NET/sub  ',
  ];
  const normOutput = canvasSkipHostsFromFp({ stability: { skipHosts: normInput } });
  assert.deepStrictEqual(normOutput, ['example.com:8080', 'foo.bar.com', 'baz.net']);

  // 6. Boundary: Template with asymmetrical skip hosts (simulating init_clean_standalone.json)
  const templateAsymInit = {
    canvas_fingerprint_skip_hosts: ['sephora.com', 'bybit.com', 'whatsapp.com', 'dhgate.com'],
    // webgl_fingerprint_skip_hosts is MISSING
  };
  applyFingerprintFields(templateAsymInit, {});
  assert.ok(Array.isArray(templateAsymInit.webgl_fingerprint_skip_hosts),
    'asymmetric canvas_fingerprint_skip_hosts in template must populate webgl_fingerprint_skip_hosts');
  assert.deepStrictEqual(templateAsymInit.canvas_fingerprint_skip_hosts, templateAsymInit.webgl_fingerprint_skip_hosts,
    'template skip hosts must be synchronized to identical values');

  // 7. Boundary: Asymmetrical fields passed to applyFingerprintFields
  const asymCanvasInit = {};
  applyFingerprintFields(asymCanvasInit, { _canvasSkipHosts: ['only-canvas.com'] });
  assert.deepStrictEqual(asymCanvasInit.canvas_fingerprint_skip_hosts, asymCanvasInit.webgl_fingerprint_skip_hosts);
  assert.deepStrictEqual(asymCanvasInit.canvas_fingerprint_skip_hosts, ['only-canvas.com']);

  const asymWebglInit = {};
  applyFingerprintFields(asymWebglInit, { _webglSkipHosts: ['only-webgl.com'] });
  assert.deepStrictEqual(asymWebglInit.canvas_fingerprint_skip_hosts, asymWebglInit.webgl_fingerprint_skip_hosts);
  assert.deepStrictEqual(asymWebglInit.canvas_fingerprint_skip_hosts, ['only-webgl.com']);

  console.log('Section B: OK');

  // =========================================================================
  // Section C: validateKernelInitInvariants checker verification
  // =========================================================================
  console.log('Testing Section C: validateKernelInitInvariants validator...');

  // Valid init
  assert.strictEqual(validateKernelInitInvariants({
    is_font_finger_printing_enable: false,
    canvas_fingerprint_skip_hosts: ['a.com'],
    webgl_fingerprint_skip_hosts: ['a.com'],
  }).valid, true);

  assert.strictEqual(validateKernelInitInvariants({
    is_font_finger_printing_enable: true,
    font_list: ['Arial'],
    canvas_fingerprint_skip_hosts: ['a.com'],
    webgl_fingerprint_skip_hosts: ['a.com'],
  }).valid, true);

  // Invalid: font switch on without list
  const inv1 = validateKernelInitInvariants({
    is_font_finger_printing_enable: true,
    font_list: [],
  });
  assert.strictEqual(inv1.valid, false);
  assert.ok(inv1.issues.some((i) => i.includes('font_list is missing or empty')));

  // Invalid: font switch off with list
  const inv2 = validateKernelInitInvariants({
    is_font_finger_printing_enable: false,
    font_list: ['Arial'],
  });
  assert.strictEqual(inv2.valid, false);
  assert.ok(inv2.issues.some((i) => i.includes('font_list is present')));

  // Invalid: skip hosts asymmetry
  const inv3 = validateKernelInitInvariants({
    is_font_finger_printing_enable: false,
    canvas_fingerprint_skip_hosts: ['a.com'],
    webgl_fingerprint_skip_hosts: ['b.com'],
  });
  assert.strictEqual(inv3.valid, false);
  assert.ok(inv3.issues.some((i) => i.includes('must have identical items')));

  const inv4 = validateKernelInitInvariants({
    is_font_finger_printing_enable: false,
    canvas_fingerprint_skip_hosts: ['a.com'],
  });
  assert.strictEqual(inv4.valid, false);
  assert.ok(inv4.issues.some((i) => i.includes('both be present or both absent')));

  console.log('Section C: OK');

  // =========================================================================
  // Section D: writeOpenBrowserKernelInit round-trip & readback verification
  // =========================================================================
  console.log('Testing Section D: writeOpenBrowserKernelInit disk round-trip...');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-contract-test-'));
  try {
    // 1. Write profile with font enabled
    const res1 = await writeOpenBrowserKernelInit(tmpDir, {
      fingerprint: fontEnabledFp,
      profile: fontEnabledProfile,
    });
    const diskInit1 = loadInitObject(await fsp.readFile(res1.path));
    assert.strictEqual(diskInit1.is_font_finger_printing_enable, true);
    assert.ok(Array.isArray(diskInit1.font_list) && diskInit1.font_list.length > 0);
    assert.deepStrictEqual(diskInit1.canvas_fingerprint_skip_hosts, diskInit1.webgl_fingerprint_skip_hosts);
    assert.strictEqual(validateKernelInitInvariants(diskInit1).valid, true);

    // 2. Update same profile to font disabled -> disk must reflect switch=false and NO font_list
    const res2 = await writeOpenBrowserKernelInit(tmpDir, {
      fingerprint: buildFingerprint(plainProfile),
      profile: plainProfile,
    });
    const diskInit2 = loadInitObject(await fsp.readFile(res2.path));
    assert.strictEqual(diskInit2.is_font_finger_printing_enable, false);
    assert.strictEqual(diskInit2.font_list, undefined,
      'updating profile from enabled to disabled must purge font_list from disk init.json');
    assert.deepStrictEqual(diskInit2.canvas_fingerprint_skip_hosts, diskInit2.webgl_fingerprint_skip_hosts);
    assert.strictEqual(validateKernelInitInvariants(diskInit2).valid, true);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  console.log('Section D: OK');
  console.log('kernel-init-contract-selftest: ALL TESTS PASSED!');
}

main().catch((err) => {
  console.error('kernel-init-contract-selftest FAILED:', err);
  process.exit(1);
});
