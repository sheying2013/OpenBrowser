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
  loadInitObject,
  encodeInitObject,
  validateKernelInitInvariants,
  isValidPrivateIpv4,
  verifyKernelInitReadback,
  mediaLabelsFromFp,
} = require('./kernel-init-sync');
const { buildFingerprint } = require('./fingerprint');

async function main() {
  console.log('=== Running kernel-init-webrtc-contract-selftest ===');

  // =========================================================================
  // Section 1: Invariant 1 - is_webrtc_enable === false and no leftover fields
  // =========================================================================
  console.log('Testing Section 1: WebRTC disabled invariants (policy=0 and no leftover IPs)...');

  // 1.1 Positive: clean disabled init object
  const cleanDisabledInit = {
    is_webrtc_enable: false,
    webrtc_policy: 0,
  };
  const resCleanDisabled = validateKernelInitInvariants(cleanDisabledInit);
  assert.strictEqual(resCleanDisabled.valid, true,
    'Clean disabled init object must be valid');

  // 1.2 Negative: is_webrtc_enable === false but webrtc_policy !== 0
  const badPolicyDisabled = {
    is_webrtc_enable: false,
    webrtc_policy: 3,
  };
  const resBadPolicy = validateKernelInitInvariants(badPolicyDisabled);
  assert.strictEqual(resBadPolicy.valid, false);
  assert.ok(resBadPolicy.issues.some((i) => i.includes('webrtc_policy is not 0')),
    'Disabled WebRTC with non-zero policy must be invalid');

  // 1.3 Negative: is_webrtc_enable === false with leftover webrtc_fake_ip
  const leftoverFakeIpInit = {
    is_webrtc_enable: false,
    webrtc_policy: 0,
    webrtc_fake_ip: '203.0.113.1',
  };
  const resLeftoverFake = validateKernelInitInvariants(leftoverFakeIpInit);
  assert.strictEqual(resLeftoverFake.valid, false);
  assert.ok(resLeftoverFake.issues.some((i) => i.includes('webrtc_fake_ip is present')),
    'Disabled WebRTC with leftover webrtc_fake_ip must be invalid');

  // 1.4 Negative: is_webrtc_enable === false with leftover webrtc_local_ip
  const leftoverLocalIpInit = {
    is_webrtc_enable: false,
    webrtc_policy: 0,
    webrtc_local_ip: '192.168.1.1',
  };
  const resLeftoverLocal = validateKernelInitInvariants(leftoverLocalIpInit);
  assert.strictEqual(resLeftoverLocal.valid, false);
  assert.ok(resLeftoverLocal.issues.some((i) => i.includes('webrtc_local_ip is present')),
    'Disabled WebRTC with leftover webrtc_local_ip must be invalid');

  // 1.5 Negative: is_webrtc_enable === false with leftover webrtc_stun_servers
  const leftoverStunInit = {
    is_webrtc_enable: false,
    webrtc_policy: 0,
    webrtc_stun_servers: ['stun:stun.l.google.com:19302'],
  };
  const resLeftoverStun = validateKernelInitInvariants(leftoverStunInit);
  assert.strictEqual(resLeftoverStun.valid, false);
  assert.ok(resLeftoverStun.issues.some((i) => i.includes('webrtc_stun_servers is present')),
    'Disabled WebRTC with leftover webrtc_stun_servers must be invalid');

  // 1.6 Cleared on disable in applyFingerprintFields:
  const dirtyInitBeforeDisable = {
    is_webrtc_enable: true,
    webrtc_policy: 3,
    webrtc_fake_ip: '198.51.100.99',
    webrtc_local_ip: '10.0.0.2',
    webrtc_stun_servers: ['stun:stun1.example.com'],
  };
  applyFingerprintFields(dirtyInitBeforeDisable, {
    is_webrtc_enable: false,
  });
  assert.strictEqual(dirtyInitBeforeDisable.is_webrtc_enable, false);
  assert.strictEqual(dirtyInitBeforeDisable.webrtc_policy, 0);
  assert.strictEqual(dirtyInitBeforeDisable.webrtc_fake_ip, undefined,
    'webrtc_fake_ip must be pruned when switched to disabled');
  assert.strictEqual(dirtyInitBeforeDisable.webrtc_local_ip, undefined,
    'webrtc_local_ip must be pruned when switched to disabled');
  assert.strictEqual(dirtyInitBeforeDisable.webrtc_stun_servers, undefined,
    'webrtc_stun_servers must be pruned when switched to disabled');

  console.log('Section 1: OK');

  // =========================================================================
  // Section 2: Invariant 2 - webrtc_policy === 3 exit IP requirement & defense
  // =========================================================================
  console.log('Testing Section 2: Policy 3 fake exit IP invariant & missing exit IP defense...');

  // 2.1 Positive: policy 3 with legitimate exit IP matching profile
  const profileWithExit = {
    id: 'profile-exit-ip-test',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0',
    exitIp: '203.0.113.88',
    privacy: { webrtc: 'proxy' },
  };
  const fpWithExit = buildFingerprint(profileWithExit);
  const fieldsWithExit = mapFingerprintToInitFields(fpWithExit, profileWithExit);
  assert.strictEqual(fieldsWithExit.is_webrtc_enable, true);
  assert.strictEqual(fieldsWithExit.webrtc_policy, 3);
  assert.strictEqual(fieldsWithExit.webrtc_fake_ip, '203.0.113.88',
    'webrtc_fake_ip must equal profile exitIp');

  const validPolicy3Init = {
    is_webrtc_enable: true,
    webrtc_policy: 3,
    webrtc_fake_ip: '203.0.113.88',
    webrtc_local_ip: '192.168.1.50',
  };
  assert.strictEqual(validateKernelInitInvariants(validPolicy3Init).valid, true);

  // 2.2 Negative: policy 3 with missing webrtc_fake_ip
  const missingFakeIpInit = {
    is_webrtc_enable: true,
    webrtc_policy: 3,
    webrtc_local_ip: '192.168.1.50',
  };
  const resMissingFake = validateKernelInitInvariants(missingFakeIpInit);
  assert.strictEqual(resMissingFake.valid, false);
  assert.ok(resMissingFake.issues.some((i) => i.includes('webrtc_policy is 3 (fake exit IP) but webrtc_fake_ip is missing')));

  // 2.3 Negative: policy 3 with empty string webrtc_fake_ip
  const emptyFakeIpInit = {
    is_webrtc_enable: true,
    webrtc_policy: 3,
    webrtc_fake_ip: '',
    webrtc_local_ip: '192.168.1.50',
  };
  const resEmptyFake = validateKernelInitInvariants(emptyFakeIpInit);
  assert.strictEqual(resEmptyFake.valid, false);
  assert.ok(resEmptyFake.issues.some((i) => i.includes('webrtc_fake_ip is missing, empty, or placeholder')));

  // 2.4 Negative: policy 3 with 0.0.0.0 placeholder webrtc_fake_ip
  const zeroFakeIpInit = {
    is_webrtc_enable: true,
    webrtc_policy: 3,
    webrtc_fake_ip: '0.0.0.0',
    webrtc_local_ip: '192.168.1.50',
  };
  const resZeroFake = validateKernelInitInvariants(zeroFakeIpInit);
  assert.strictEqual(resZeroFake.valid, false);
  assert.ok(resZeroFake.issues.some((i) => i.includes('webrtc_fake_ip is missing, empty, or placeholder')));

  // 2.5 Defense: Exit IP missing when webrtc=proxy requested -> must NOT write empty/placeholder fake ip
  const profileMissingExit = {
    id: 'profile-missing-exit-ip',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0',
    privacy: { webrtc: 'proxy' },
  };
  const fieldsMissingExit = mapFingerprintToInitFields(buildFingerprint(profileMissingExit), profileMissingExit);
  assert.strictEqual(fieldsMissingExit.is_webrtc_enable, true);
  assert.strictEqual(fieldsMissingExit.webrtc_policy, 1,
    'missing exit IP must safely downgrade webrtc_policy to 1 (real)');
  assert.strictEqual(fieldsMissingExit.webrtc_fake_ip, undefined,
    'missing exit IP must NOT set webrtc_fake_ip (neither empty nor placeholder)');

  console.log('Section 2: OK');

  // =========================================================================
  // Section 3: Invariant 3 - webrtc_local_ip private IPv4 validation & boundary
  // =========================================================================
  console.log('Testing Section 3: webrtc_local_ip private IPv4 validity boundary...');

  // 3.1 Positive: standard private address spaces
  const validPrivateIps = [
    '10.0.0.1',
    '10.254.12.3',
    '172.16.0.1',
    '172.20.100.5',
    '172.31.255.254',
    '192.168.0.1',
    '192.168.1.100',
    '192.168.254.254',
  ];
  for (const ip of validPrivateIps) {
    assert.strictEqual(isValidPrivateIpv4(ip), true, `IP ${ip} must be identified as valid private IPv4`);
    const testInit = {
      is_webrtc_enable: true,
      webrtc_policy: 1,
      webrtc_local_ip: ip,
    };
    assert.strictEqual(validateKernelInitInvariants(testInit).valid, true,
      `Init with valid private IP ${ip} must pass validation`);
  }

  // 3.2 Negative: invalid / public / loopback / out-of-range addresses
  const invalidIps = [
    '8.8.8.8',          // Public DNS
    '1.1.1.1',          // Public Cloudflare
    '203.0.113.50',     // Public TEST-NET
    '0.0.0.0',          // Any / unspecified
    '',                 // Empty string
    '   ',              // Whitespace
    '127.0.0.1',        // Loopback
    '172.15.255.254',   // Below 172.16
    '172.32.0.1',       // Above 172.31
    '192.167.1.1',      // Not 192.168
    '192.169.1.1',      // Not 192.168
    '10.0.0.256',       // Octet > 255
    '10.0.0.01',        // Leading zero
    'invalid-ip',       // Non-IP string
  ];
  for (const badIp of invalidIps) {
    assert.strictEqual(isValidPrivateIpv4(badIp), false, `IP "${badIp}" must be identified as INVALID private IPv4`);
    const testInit = {
      is_webrtc_enable: true,
      webrtc_policy: 1,
      webrtc_local_ip: badIp,
    };
    const res = validateKernelInitInvariants(testInit);
    assert.strictEqual(res.valid, false, `Init with invalid IP "${badIp}" must fail validation`);
    assert.ok(res.issues.some((i) => i.includes('webrtc_local_ip must be a valid private IPv4 address')));
  }

  // 3.3 Defense: Profile with invalid local IP is corrected rather than leaking invalid value
  for (const badIp of ['8.8.8.8', '0.0.0.0', '']) {
    const prof = {
      id: 'bad-local-ip-profile',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0',
      privacy: { webrtcLocalIp: badIp },
    };
    const f = mapFingerprintToInitFields(buildFingerprint(prof), prof);
    assert.ok(isValidPrivateIpv4(f.webrtc_local_ip),
      `mapFingerprintToInitFields must sanitize "${badIp}" to a valid private IP, got: ${f.webrtc_local_ip}`);

    const targetInit = {};
    applyFingerprintFields(targetInit, {
      is_webrtc_enable: true,
      webrtc_policy: 1,
      webrtc_local_ip: badIp,
    });
    assert.ok(isValidPrivateIpv4(targetInit.webrtc_local_ip),
      `applyFingerprintFields must sanitize "${badIp}" to a valid private IP, got: ${targetInit.webrtc_local_ip}`);
  }

  console.log('Section 3: OK');

  // =========================================================================
  // Section 4: Invariant 4 - webrtc_media_labels co-source and prefixes
  // =========================================================================
  console.log('Testing Section 4: webrtc_media_labels OS co-source and enumeration switch...');

  // 4.1 Positive: Windows persona with Windows media labels
  const winLabels = {
    audio_input_labels: ['Microphone Array (Realtek High Definition Audio)'],
    audio_output_labels: ['Speaker/Headphone (Realtek High Definition Audio)'],
    video_input_labels: ['Integrated Camera'],
    default_text: 'Default - ',
    communications_text: 'Communications - ',
  };
  const winInit = {
    platform: 'Win32',
    user_agent_data: { platform: 'Windows' },
    is_enumerate_devices_enable: true,
    webrtc_media_labels: winLabels,
  };
  assert.strictEqual(validateKernelInitInvariants(winInit).valid, true,
    'Windows persona with Realtek media labels must pass');

  // 4.2 Positive: macOS persona with macOS media labels
  const macLabels = {
    audio_input_labels: ['Built-in Microphone'],
    audio_output_labels: ['MacBook Pro Speakers'],
    video_input_labels: ['FaceTime HD Camera'],
    default_text: 'Default - ',
    communications_text: 'Communications - ',
  };
  const macInit = {
    platform: 'MacIntel',
    user_agent_data: { platform: 'macOS' },
    is_enumerate_devices_enable: true,
    webrtc_media_labels: macLabels,
  };
  assert.strictEqual(validateKernelInitInvariants(macInit).valid, true,
    'macOS persona with FaceTime/MacBook media labels must pass');

  // 4.3 Positive: Android persona with Android media labels
  const androidLabels = {
    audio_input_labels: ['Built-in Microphone'],
    audio_output_labels: ['Built-in Speaker'],
    video_input_labels: ['Back Camera'],
    default_text: 'Default - ',
    communications_text: 'Communications - ',
  };
  const androidInit = {
    platform: 'Linux armv81',
    user_agent_data: { platform: 'Android' },
    is_enumerate_devices_enable: true,
    webrtc_media_labels: androidLabels,
  };
  assert.strictEqual(validateKernelInitInvariants(androidInit).valid, true,
    'Android persona with Back Camera media labels must pass');

  // 4.4 Positive: is_enumerate_devices_enable === false has empty label arrays
  const enumDisabledInit = {
    platform: 'Win32',
    is_enumerate_devices_enable: false,
    webrtc_media_labels: {
      audio_input_labels: [],
      audio_output_labels: [],
      video_input_labels: [],
      default_text: 'Default - ',
      communications_text: 'Communications - ',
    },
  };
  assert.strictEqual(validateKernelInitInvariants(enumDisabledInit).valid, true,
    'Enumeration disabled with empty label arrays must pass');

  // 4.5 Negative: Windows persona with macOS device (FaceTime)
  const crossOsMacOnWin = {
    platform: 'Win32',
    user_agent_data: { platform: 'Windows' },
    is_enumerate_devices_enable: true,
    webrtc_media_labels: {
      audio_input_labels: ['Microphone Array (Realtek High Definition Audio)'],
      audio_output_labels: ['Speaker (Realtek High Definition Audio)'],
      video_input_labels: ['FaceTime HD Camera'],
      default_text: 'Default - ',
      communications_text: 'Communications - ',
    },
  };
  const resMacOnWin = validateKernelInitInvariants(crossOsMacOnWin);
  assert.strictEqual(resMacOnWin.valid, false);
  assert.ok(resMacOnWin.issues.some((i) => i.includes('contains macOS device')));

  // 4.6 Negative: Windows persona with Android device (Back Camera)
  const crossOsAndroidOnWin = {
    platform: 'Win32',
    user_agent_data: { platform: 'Windows' },
    is_enumerate_devices_enable: true,
    webrtc_media_labels: {
      audio_input_labels: ['Microphone Array (Realtek High Definition Audio)'],
      audio_output_labels: ['Speaker (Realtek High Definition Audio)'],
      video_input_labels: ['Back Camera'],
      default_text: 'Default - ',
      communications_text: 'Communications - ',
    },
  };
  const resAndroidOnWin = validateKernelInitInvariants(crossOsAndroidOnWin);
  assert.strictEqual(resAndroidOnWin.valid, false);
  assert.ok(resAndroidOnWin.issues.some((i) => i.includes('contains Android device')));

  // 4.7 Negative: macOS persona with Windows device (Realtek)
  const crossOsWinOnMac = {
    platform: 'MacIntel',
    user_agent_data: { platform: 'macOS' },
    is_enumerate_devices_enable: true,
    webrtc_media_labels: {
      audio_input_labels: ['Microphone Array (Realtek High Definition Audio)'],
      audio_output_labels: ['MacBook Pro Speakers'],
      video_input_labels: ['FaceTime HD Camera'],
      default_text: 'Default - ',
      communications_text: 'Communications - ',
    },
  };
  const resWinOnMac = validateKernelInitInvariants(crossOsWinOnMac);
  assert.strictEqual(resWinOnMac.valid, false);
  assert.ok(resWinOnMac.issues.some((i) => i.includes('contains Windows device')));

  // 4.8 Negative: is_enumerate_devices_enable === false but non-empty labels remain
  const dirtyEnumDisabledInit = {
    platform: 'Win32',
    is_enumerate_devices_enable: false,
    webrtc_media_labels: {
      audio_input_labels: ['Microphone Array (Realtek High Definition Audio)'],
      audio_output_labels: [],
      video_input_labels: [],
      default_text: 'Default - ',
      communications_text: 'Communications - ',
    },
  };
  const resDirtyEnumDisabled = validateKernelInitInvariants(dirtyEnumDisabledInit);
  assert.strictEqual(resDirtyEnumDisabled.valid, false);
  assert.ok(resDirtyEnumDisabled.issues.some((i) => i.includes('is_enumerate_devices_enable is false but webrtc_media_labels contains non-empty label lists')));

  // 4.9 Negative: missing default_text or communications_text
  const missingPrefixInit = {
    platform: 'Win32',
    is_enumerate_devices_enable: true,
    webrtc_media_labels: {
      audio_input_labels: ['Microphone Array (Realtek High Definition Audio)'],
      audio_output_labels: ['Speaker (Realtek High Definition Audio)'],
      video_input_labels: ['Integrated Camera'],
    },
  };
  const resMissingPrefix = validateKernelInitInvariants(missingPrefixInit);
  assert.strictEqual(resMissingPrefix.valid, false);
  assert.ok(resMissingPrefix.issues.some((i) => i.includes('default_text must be a non-empty string')));
  assert.ok(resMissingPrefix.issues.some((i) => i.includes('communications_text must be a non-empty string')));

  // 4.10 Defense: applyFingerprintFields purges labels when is_enumerate_devices_enable === false
  const dirtyInitBeforeMediaDisable = {
    is_enumerate_devices_enable: true,
    webrtc_media_labels: { ...winLabels },
  };
  applyFingerprintFields(dirtyInitBeforeMediaDisable, {
    is_enumerate_devices_enable: false,
  });
  assert.deepStrictEqual(dirtyInitBeforeMediaDisable.webrtc_media_labels.audio_input_labels, []);
  assert.deepStrictEqual(dirtyInitBeforeMediaDisable.webrtc_media_labels.audio_output_labels, []);
  assert.deepStrictEqual(dirtyInitBeforeMediaDisable.webrtc_media_labels.video_input_labels, []);
  assert.strictEqual(dirtyInitBeforeMediaDisable.webrtc_media_labels.default_text, 'Default - ');
  assert.strictEqual(dirtyInitBeforeMediaDisable.webrtc_media_labels.communications_text, 'Communications - ');

  console.log('Section 4: OK');

  // =========================================================================
  // Section 5: Invariant 5 - Active correction and contradiction rejection
  // =========================================================================
  console.log('Testing Section 5: Contradiction correction and rejection...');

  // 5.1 Defense: applyFingerprintFields cleans conflicting disabled state
  const contradictoryWebRtcInit = {
    is_webrtc_enable: false,
    webrtc_policy: 3,
    webrtc_fake_ip: '203.0.113.1',
    webrtc_local_ip: '10.0.0.1',
  };
  applyFingerprintFields(contradictoryWebRtcInit, { is_webrtc_enable: false });
  assert.strictEqual(contradictoryWebRtcInit.is_webrtc_enable, false);
  assert.strictEqual(contradictoryWebRtcInit.webrtc_policy, 0);
  assert.strictEqual(contradictoryWebRtcInit.webrtc_fake_ip, undefined);
  assert.strictEqual(contradictoryWebRtcInit.webrtc_local_ip, undefined);

  // 5.2 Defense: applyFingerprintFields corrects policy 3 without fake IP to policy 1
  const contradictoryPolicy3Init = {
    is_webrtc_enable: true,
    webrtc_policy: 3,
  };
  applyFingerprintFields(contradictoryPolicy3Init, {
    is_webrtc_enable: true,
    webrtc_policy: 3,
    // NO fake IP
  });
  assert.strictEqual(contradictoryPolicy3Init.webrtc_policy, 1,
    'Policy 3 without fake IP must be downgraded to 1');
  assert.strictEqual(contradictoryPolicy3Init.webrtc_fake_ip, undefined);

  // 5.3 Rejection: validator rejects raw contradictory state
  const rawContradictory = {
    is_webrtc_enable: true,
    webrtc_policy: 0,
  };
  assert.strictEqual(validateKernelInitInvariants(rawContradictory).valid, false);

  console.log('Section 5: OK');

  // =========================================================================
  // Section 6: End-to-end Lifecycle: "Enabled -> Changed to Disabled" clears disk
  // =========================================================================
  console.log('Testing Section 6: Full round-trip "Enabled -> Changed to Disabled" disk cleanup...');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-webrtc-lifecycle-'));
  try {
    const enabledProfile = {
      id: 'lifecycle-profile-01',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0',
      exitIp: '203.0.113.77',
      privacy: {
        webrtc: 'proxy',
        webrtcLocalIp: '192.168.2.15',
        webrtcStunServers: ['stun:stun.l.google.com:19302'],
      },
      kernelVersion: '148.0.7778.165',
    };

    // Step 1: Write enabled WebRTC profile to disk
    const res1 = await writeOpenBrowserKernelInit(tmpDir, {
      fingerprint: buildFingerprint(enabledProfile),
      profile: enabledProfile,
    });
    const diskInit1 = loadInitObject(await fsp.readFile(res1.path));
    assert.strictEqual(diskInit1.is_webrtc_enable, true);
    assert.strictEqual(diskInit1.webrtc_policy, 3);
    assert.strictEqual(diskInit1.webrtc_fake_ip, '203.0.113.77');
    assert.strictEqual(diskInit1.webrtc_local_ip, '192.168.2.15');
    assert.deepStrictEqual(diskInit1.webrtc_stun_servers, ['stun:stun.l.google.com:19302']);
    assert.strictEqual(validateKernelInitInvariants(diskInit1).valid, true);

    // Step 2: Change profile to WebRTC disabled and write back to same dir
    const disabledProfile = {
      ...enabledProfile,
      privacy: {
        ...enabledProfile.privacy,
        webrtc: 'disabled',
      },
    };
    const res2 = await writeOpenBrowserKernelInit(tmpDir, {
      fingerprint: buildFingerprint(disabledProfile),
      profile: disabledProfile,
    });
    const diskInit2 = loadInitObject(await fsp.readFile(res2.path));
    assert.strictEqual(diskInit2.is_webrtc_enable, false, 'WebRTC switch must be false on disk');
    assert.strictEqual(diskInit2.webrtc_policy, 0, 'WebRTC policy must be 0 on disk');
    assert.strictEqual(diskInit2.webrtc_fake_ip, undefined,
      'webrtc_fake_ip must be completely eliminated from disk init.json');
    assert.strictEqual(diskInit2.webrtc_local_ip, undefined,
      'webrtc_local_ip must be completely eliminated from disk init.json');
    assert.strictEqual(diskInit2.webrtc_stun_servers, undefined,
      'webrtc_stun_servers must be completely eliminated from disk init.json');
    assert.strictEqual(validateKernelInitInvariants(diskInit2).valid, true);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  console.log('Section 6: OK');

  // =========================================================================
  // Section 7: Task B - Readback verification & Tamper detection on all 16 fields
  // =========================================================================
  console.log('Testing Section 7: Readback verification and tamper detection on all critical fields...');

  const tamperDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-tamper-test-'));
  try {
    const baseProfile = {
      id: 'tamper-profile',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0.0.0',
      exitIp: '203.0.113.99',
      language: 'en-US',
      privacy: {
        webrtc: 'proxy',
        webrtcLocalIp: '192.168.10.20',
        fontFingerprinting: true,
        canvas: 'noise',
        webgl: 'noise',
      },
      kernelVersion: '148.0.7778.165',
    };

    // 7.1 Normal untampered write must succeed
    const normalRes = await writeOpenBrowserKernelInit(tamperDir, {
      fingerprint: buildFingerprint(baseProfile),
      profile: baseProfile,
    });
    assert.ok(fs.existsSync(normalRes.path));

    // 7.2 Tamper tests on all 16 critical leak fields
    const fieldsToTamper = [
      { name: 'platform', modify: (obj) => { obj.platform = 'HackedPlatform'; } },
      { name: 'user_agent_data', modify: (obj) => { obj.user_agent_data.platform = 'Linux'; } },
      { name: 'webgl_vendor', modify: (obj) => { obj.webgl_vendor = 'Hacked Vendor Inc.'; } },
      { name: 'webgl_renderer', modify: (obj) => { obj.webgl_renderer = 'Hacked Renderer 9000'; } },
      { name: 'webgpu_parameter', modify: (obj) => { obj.webgpu_parameter = { vendor: 'hacked', architecture: 'tampered' }; } },
      { name: 'accept_languages', modify: (obj) => { obj.accept_languages = 'fr-FR,fr'; } },
      { name: 'cmd_line user-agent', modify: (obj) => { obj.cmd_line['user-agent'] = 'TamperedUA/1.0'; } },
      { name: 'cmd_line lange', modify: (obj) => { obj.cmd_line.lange = 'ru-RU'; } },
      { name: 'is_font_finger_printing_enable', modify: (obj) => { obj.is_font_finger_printing_enable = false; } },
      { name: 'font_list', modify: (obj) => { obj.font_list = ['TamperedFont']; } },
      { name: 'canvas_fingerprint_skip_hosts', modify: (obj) => { obj.canvas_fingerprint_skip_hosts = ['tampered.com']; } },
      { name: 'webgl_fingerprint_skip_hosts', modify: (obj) => { obj.webgl_fingerprint_skip_hosts = ['tampered.com']; } },
      { name: 'is_webrtc_enable', modify: (obj) => { obj.is_webrtc_enable = false; } },
      { name: 'webrtc_policy', modify: (obj) => { obj.webrtc_policy = 1; } },
      { name: 'webrtc_fake_ip', modify: (obj) => { obj.webrtc_fake_ip = '1.1.1.1'; } },
      { name: 'webrtc_local_ip', modify: (obj) => { obj.webrtc_local_ip = '10.99.99.99'; } },
      { name: 'webrtc_media_labels', modify: (obj) => { obj.webrtc_media_labels.default_text = 'Tampered - '; } },
    ];

    for (const item of fieldsToTamper) {
      let threw = false;
      try {
        await writeOpenBrowserKernelInit(tamperDir, {
          fingerprint: buildFingerprint(baseProfile),
          profile: baseProfile,
          _beforeReadback: async (filePath) => {
            const diskObj = loadInitObject(await fsp.readFile(filePath));
            item.modify(diskObj);
            await fsp.writeFile(filePath, encodeInitObject(diskObj), 'utf8');
          },
        });
      } catch (err) {
        threw = true;
        assert.ok(err.message.includes('readback verification failed') || err.message.includes('readback mismatch'),
          `Tampering ${item.name} must trigger readback verification failure: got ${err.message}`);
      }
      assert.strictEqual(threw, true, `Tampering ${item.name} on disk must be caught and throw an error`);
    }

    // 7.3 Direct verifyKernelInitReadback unit test
    const dummyInit = {
      platform: 'Win32',
      cmd_line: { 'user-agent': 'TestUA', lange: 'en-US' },
      is_webrtc_enable: true,
      webrtc_policy: 3,
      webrtc_fake_ip: '203.0.113.1',
      webrtc_local_ip: '192.168.1.1',
    };
    const tamperedCopy = JSON.parse(JSON.stringify(dummyInit));
    tamperedCopy.webrtc_fake_ip = '8.8.8.8';

    let directThrew = false;
    try {
      verifyKernelInitReadback(dummyInit, tamperedCopy, '/dummy/init.json');
    } catch (e) {
      directThrew = true;
      assert.ok(e.message.includes('readback verification failed'));
      assert.ok(e.message.includes('webrtc_fake_ip'));
    }
    assert.strictEqual(directThrew, true, 'verifyKernelInitReadback must throw on mismatch');
  } finally {
    await fsp.rm(tamperDir, { recursive: true, force: true });
  }

  console.log('Section 7: OK');
  console.log('kernel-init-webrtc-contract-selftest: ALL TESTS PASSED!');
}

main().catch((err) => {
  console.error('kernel-init-webrtc-contract-selftest FAILED:', err);
  process.exit(1);
});
