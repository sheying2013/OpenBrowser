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
    privacy: {
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      webrtc: 'proxy',
      cores: 8,
      memory: 16,
    },
    kernelVersion: '148.0.7778.165',
  };
  const fp = buildFingerprint(profile);
  const fields = mapFingerprintToInitFields(fp, profile);
  assert.strictEqual(fields.platform, 'Win32');
  assert.ok(String(fields.accept_languages).includes('ja'));
  assert.strictEqual(fields.hardwareConcurrency, 8);
  assert.strictEqual(fields.deviceMemory, 16);
  assert.strictEqual(fields.webrtc_policy, 3);
  assert.strictEqual(fields.is_webgl_finger_printing_enable, true);
  assert.ok(fields.user_agent_data.uaFullVersion);
  assert.ok(fields.user_agent_data.brands.length >= 2);
  assert.ok(fields._cmdLinePatch['user-agent'].includes('Windows NT'));
  assert.ok(fields.webgl_vendor || fields.webgl_renderer);

  const stripped = fingerprintForNativeKernelInject(fp);
  assert.strictEqual(stripped.canvas.mode, 'real');
  assert.strictEqual(stripped.webgl.mode, 'real');
  assert.strictEqual(fp.canvas.mode, 'noise');

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-kernel-init-'));
  try {
    const template = path.join(__dirname, '../kernels/openbrowser/init_template.json');
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
