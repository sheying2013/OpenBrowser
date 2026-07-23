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
  assert.strictEqual(fields.deviceMemory, 16);
  assert.strictEqual(fields.webrtc_policy, 3);
  assert.strictEqual(fields.is_webgl_finger_printing_enable, true);
  assert.strictEqual(fields.machine, 'OB-Test-Host-01');
  assert.strictEqual(fields.webrtc_fake_ip, '203.0.113.44');
  assert.strictEqual(fields.webrtc_local_ip, fp.webrtcLocalIp);
  assert.strictEqual(fields.geoposition, '35.6762,139.6503,50');
  assert.strictEqual(fields.is_font_finger_printing_enable, true);
  assert.ok(fields.user_agent_data.uaFullVersion);
  assert.ok(fields.user_agent_data.brands.length >= 2);
  assert.ok(fields._cmdLinePatch['user-agent'].includes('Windows NT'));
  assert.ok(fields.webgl_vendor || fields.webgl_renderer);

  const stripped = fingerprintForNativeKernelInject(fp);
  assert.strictEqual(stripped.canvas.mode, 'real');
  // Pixel noise stripped for native; WebGL meta spoof must remain (not real-only wipe).
  assert.strictEqual(stripped.webgl.mode, 'real');
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
    assert.strictEqual(init.deviceMemory, 16);
    assert.strictEqual(init.local_port.type, 0);
    assert.strictEqual(init.black_white_list.type, 1);
    assert.strictEqual(init.is_garble_dom_event_trusted, false);
    assert.strictEqual(init.launcher_page, 'about:blank');
    assert.strictEqual(init.ipc.is_pipe, true);
    assert.strictEqual(init.ipc.browser_window_name, written.windowName);
    assert.ok(String(init.cmd_line['user-agent']).includes('Windows NT'));
    assert.strictEqual(init.webrtc_policy, 3);
    assert.strictEqual(init.machine, 'OB-Test-Host-01');
    assert.strictEqual(init.webrtc_fake_ip, '203.0.113.44');
    assert.strictEqual(init.webrtc_local_ip, fp.webrtcLocalIp);
    assert.strictEqual(init.geoposition, '35.6762,139.6503,50');
    assert.strictEqual(init.is_font_finger_printing_enable, true);
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

  console.log('kernel-init-sync-selftest: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
