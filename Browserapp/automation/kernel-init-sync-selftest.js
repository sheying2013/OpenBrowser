'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  mapFingerprintToInitFields,
  writeOpenBrowserKernelInit,
  fingerprintForNativeKernelInject,
  loadInitObject,
  stableBrowserWindowName,
  isOpenBrowser148,
  canvasSkipHostsFromFp,
  fontListFromFp,
} = require('./kernel-init-sync');
const { buildFingerprint } = require('./fingerprint');

async function main() {
  assert.strictEqual(isOpenBrowser148({ source: 'openbrowser-148' }), true);
  assert.strictEqual(isOpenBrowser148({ path: '/x/kernels/openbrowser/chrome_148/openbrowser_148/OpenBrowser.app/Contents/MacOS/OpenBrowser' }), true);
  assert.strictEqual(isOpenBrowser148({ source: 'donut-wayfern' }), false);

  const a = stableBrowserWindowName('env-001');
  const b = stableBrowserWindowName('env-001');
  const c = stableBrowserWindowName('env-002');
  assert.ok(/^SB\d{9}$/.test(a));
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);

  const profile = {
    id: 'env-sync-test',
    name: 'sync-test',
    language: 'ja-JP',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    exitIp: '203.0.113.44',
    exitLatitude: 35.6762,
    exitLongitude: 139.6503,
    privacy: {
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      webrtc: 'proxy',
      cores: 8,
      memory: 16,
      speech: 'noise',
      deviceNameMode: 'custom',
      deviceName: 'OB-Test-Host-01',
      fontFingerprinting: true,
      geoMode: 'ip',
      accuracy: 50,
    },
    kernelVersion: '148.0.7778.165',
  };
  const fp = buildFingerprint(profile);
  assert.strictEqual(fp.deviceName, 'OB-Test-Host-01');
  assert.ok(fp.webrtcLocalIp);
  assert.ok(Array.isArray(fp.speech.voices) && fp.speech.voices.length >= 18);
  const fields = mapFingerprintToInitFields(fp, profile);
  assert.strictEqual(fields.platform, 'Win32');
  assert.ok(String(fields.accept_languages).includes('ja'));
  assert.strictEqual(fields.hardwareConcurrency, 8);
  // navigator.deviceMemory is spec-quantised to {0.25,0.5,1,2,4,8}; 16 GB hardware reports 8.
  assert.ok(Number(fields.deviceMemory) >= 1 && Number(fields.deviceMemory) <= 8,
    'deviceMemory must stay within the measurable spec range');
  assert.strictEqual(fields.webrtc_policy, 3);
  assert.strictEqual(fields.is_canvas_finger_printing_enable, true);
  assert.strictEqual(fields.is_webgl_finger_printing_enable, true);
  assert.strictEqual(fields.machine, 'OB-Test-Host-01');
  assert.strictEqual(fields.webrtc_fake_ip, '203.0.113.44');
  assert.strictEqual(fields.webrtc_local_ip, fp.webrtcLocalIp);
  assert.strictEqual(fields.geoposition, '35.6762,139.6503,50');
  assert.strictEqual(fields.is_font_finger_printing_enable, true);
  // The switch and the list have to travel together, or a build that honours the switch has
  // nothing to answer from and a build that reads the list alone would activate unasked for.
  assert.ok(Array.isArray(fields.font_list) && fields.font_list.length > 0,
    'an enabled font switch must ship the font list it answers from');
  assert.ok(fields.font_list.includes('Segoe UI'), 'a Windows profile must model Windows families');
  assert.deepStrictEqual(
    fontListFromFp({ fonts: { list: [' Arial ', 'arial', '', 'Segoe UI', null, 'Tahoma'] } }),
    ['Arial', 'Segoe UI', 'Tahoma'],
    'font families must be trimmed and de-duplicated case-insensitively'
  );
  assert.ok(fontListFromFp({}).length > 0, 'a fingerprint without a persona still models its claimed platform');
  assert.strictEqual(fields.webgpu_parameter, undefined,
    'webgpu=real must not write a native WebGPU parameter');

  assert.ok(fields.user_agent_data.uaFullVersion);
  assert.ok(fields.user_agent_data.brands.length >= 2);
  assert.ok(fields._cmdLinePatch['user-agent'].includes('Windows NT'));
  assert.ok(fields.webgl_vendor || fields.webgl_renderer);

  // The native canvas layer and the page script must exempt the same sites.
  assert.deepStrictEqual(fields._canvasSkipHosts, fp.stability.skipHosts,
    'the mapped init skip list must mirror the stability policy');
  assert.deepStrictEqual(fields._webglSkipHosts, fp.stability.skipHosts,
    'the mapped init skip list must also feed the separate WebGL exempt list');
  assert.deepStrictEqual(fields._webglSkipHosts, fields._canvasSkipHosts,
    'canvas and webgl exempt lists must stay identical');
  assert.deepStrictEqual(
    canvasSkipHostsFromFp({ stability: { skipHosts: ['HTTPS://Example.COM/path', '*.foo.com', 'example.com', '', 42] } }),
    ['example.com', 'foo.com', '42'],
    'skip hosts must be normalised, de-duplicated and scheme-free'
  );
  assert.deepStrictEqual(canvasSkipHostsFromFp({}), [], 'a fingerprint without a policy yields no skip list');

  const plainProfile = {
    id: 'env-sync-plain',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    privacy: {},
    kernelVersion: '148.0.7778.165',
  };
  const plainFields = mapFingerprintToInitFields(buildFingerprint(plainProfile), plainProfile);
  assert.strictEqual(plainFields.is_font_finger_printing_enable, false, 'font spoofing stays off unless asked for');
  assert.strictEqual(plainFields.font_list, undefined, 'no switch means no list');
  const webglGpuProfile = {
    ...plainProfile,
    id: 'env-sync-webgpu-webgl',
    privacy: { ...plainProfile.privacy, webgpu: 'webgl' },
  };
  const webglGpuFields = mapFingerprintToInitFields(buildFingerprint(webglGpuProfile), webglGpuProfile);
  assert.ok(webglGpuFields.webgpu_parameter,
    'webgpu=webgl must publish a native WebGPU parameter');
  assert.ok(webglGpuFields.webgpu_parameter.vendor,
    'webgpu=webgl must publish a vendor');
  assert.ok(webglGpuFields.webgpu_parameter.architecture,
    'webgpu=webgl must publish an architecture');

  const blockedGpuProfile = {
    ...plainProfile,
    id: 'env-sync-webgpu-blocked',
    privacy: { ...plainProfile.privacy, webgpu: 'blocked' },
  };
  const blockedGpuFields = mapFingerprintToInitFields(buildFingerprint(blockedGpuProfile), blockedGpuProfile);
  assert.strictEqual(blockedGpuFields.webgpu_parameter, undefined,
    'webgpu=blocked must not publish a synthetic native identity');


  const stripped = fingerprintForNativeKernelInject(fp);
  assert.strictEqual(stripped.canvas.mode, 'noise');
  // Pixel noise stripped for native; WebGL meta spoof must remain (not real-only wipe).
  assert.strictEqual(stripped.webgl.mode, 'noise');
  assert.notStrictEqual(stripped.webgl.metaMode, 'real', 'native inject must keep webgl metaMode for UNMASKED_* spoof');
  assert.ok(stripped.webgl.vendor || stripped.webgl.renderer, 'native inject must keep webgl vendor/renderer strings');
  assert.strictEqual(fp.canvas.mode, 'noise');

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-kernel-init-'));
  try {
    const template = path.join(__dirname, '../kernels/macos-x64/init_template.json');
    const written = await writeOpenBrowserKernelInit(tmp, {
      fingerprint: fp,
      profile,
      templatePath: fs.existsSync(template) ? template : null,
    });
    assert.ok(fs.existsSync(written.path));
    const init = loadInitObject(await fsp.readFile(written.path));
    assert.strictEqual(init.platform, 'Win32');
    assert.strictEqual(init.hardwareConcurrency, 8);
    assert.ok(Number(init.deviceMemory) >= 1 && Number(init.deviceMemory) <= 8,
      'written init.deviceMemory must stay within the measurable spec range');
    assert.strictEqual(init.is_canvas_finger_printing_enable, true);
    assert.strictEqual(init.local_port.type, 0);
    assert.strictEqual(init.black_white_list.type, 1);
    assert.strictEqual(init.is_garble_dom_event_trusted, false);
    assert.strictEqual(init.launcher_page, 'about:blank');
    assert.strictEqual(init.ipc.is_pipe, true);
    assert.strictEqual(init.ipc.browser_window_name, written.windowName);
    assert.ok(String(init.cmd_line['user-agent']).includes('Windows NT'));
    assert.strictEqual(init.webrtc_policy, 3);
    // Identity and allowlists that belong to the bundled template's origin must not reach a profile:
    // an inherited account token blob, an inherited native-messaging allowlist, and a proxy bypass
    // list whose feature switch is off.
    assert.ok(init.token && typeof init.token === 'object' && init.token.browser_token && init.token.user_token,
      'profiles must carry a token blob of the shape the platform service requires');
    assert.ok(!init.token.user_id,
      'profiles must not carry an account-bound token');
    assert.deepStrictEqual(init.native_messaging, [],
      'native-messaging allowlists tied to other builds must not be inherited');
    assert.deepStrictEqual(init.async_proxy_data_exception_list, [],
      'a bypass list without its feature switch would be a latent direct-connection path');
    assert.strictEqual(init.async_proxy_data, 0);
    assert.strictEqual(init.machine, 'OB-Test-Host-01');
    assert.strictEqual(init.webrtc_fake_ip, '203.0.113.44');
    assert.strictEqual(init.webrtc_local_ip, fp.webrtcLocalIp);
    assert.strictEqual(init.geoposition, '35.6762,139.6503,50');
    assert.strictEqual(init.is_font_finger_printing_enable, true);
    assert.ok(Array.isArray(init.font_list) && init.font_list.length > 0,
      'written init must carry the font list next to the switch');
    assert.deepStrictEqual(init.font_list, fields.font_list,
      'the written list must be the one the mapper produced');
    assert.deepStrictEqual(init.canvas_fingerprint_skip_hosts, fp.stability.skipHosts,
      'written init must carry the policy skip list into the native canvas layer');
    assert.deepStrictEqual(init.webgl_fingerprint_skip_hosts, fp.stability.skipHosts,
      'written init must carry the same policy skip list into the native webgl layer');
    assert.deepStrictEqual(init.webgl_fingerprint_skip_hosts, init.canvas_fingerprint_skip_hosts,
      'native canvas and webgl exempt lists must match what the page script uses');
    assert.strictEqual(init._webglSkipHosts, undefined,
      'internal mapping helpers must not leak into the written init');
    assert.strictEqual(init.is_watermark_with_machine_id, false,
      'a machine-id watermark must never be enabled: it burns the profile id into screenshots');
    assert.strictEqual(init.is_watermark_with_window_name, false,
      'a window-name watermark must never be enabled');
    assert.ok(init.user_agent_data.platform === 'Windows' || init.user_agent_data.platform);
    // second write preserves unique window name
    const written2 = await writeOpenBrowserKernelInit(tmp, {
      fingerprint: fp,
      profile,
      templatePath: fs.existsSync(template) ? template : null,
    });
    assert.strictEqual(written2.windowName, written.windowName);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  // The shipped template itself must be free of those inherited values, not just the written result.
  {
    const templatePath = path.join(__dirname, '../kernels/macos-x64/init_template.json');
    if (fs.existsSync(templatePath)) {
      const template = loadInitObject(await fsp.readFile(templatePath));
      assert.ok(template, 'bundled init template must parse');
      assert.ok(template.token && typeof template.token === 'object',
        'template must carry a token blob of the shape the platform service requires');
      assert.ok(!template.token.user_id, 'template must not carry an account-bound token');
      assert.deepStrictEqual(template.native_messaging, [],
        'template must not carry a native-messaging allowlist for extensions this build does not ship');
      assert.deepStrictEqual(template.async_proxy_data_exception_list, [],
        'template must not carry a proxy bypass list');
      const serialized = JSON.stringify(template);
      assert.ok(!/env-kit/i.test(serialized), 'template must not carry inherited runtime names');
      assert.ok(!/52\.80\.142\.150/.test(serialized), 'template must not carry fixed bypass hosts');
    }
  }

  console.log('kernel-init-sync-selftest: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
