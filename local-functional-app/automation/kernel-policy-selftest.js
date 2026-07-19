'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { BrowserKernelManager, validateArchiveMemberName, safeInstalledBinary } = require('./browser-kernel');
const { BrowserEngine } = require('../engine');

function cftBinary(root) {
  const platform = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64')
    : process.platform === 'win32'
      ? 'chrome-win64'
      : 'chrome-linux64';
  if (process.platform === 'darwin') {
    return path.join(root, 'kernels', 'chrome-for-testing', platform, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  }
  return path.join(root, 'kernels', 'chrome-for-testing', platform, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openbrowser-kernel-'));
  try {
    const binary = cftBinary(root);
    await fsp.mkdir(path.dirname(binary), { recursive: true });
    await fsp.writeFile(binary, '', 'utf8');
    await fsp.writeFile(path.join(root, 'kernels', 'kernel-meta.json'), JSON.stringify({
      binary: path.join(root, 'old-app-name', 'kernels', 'missing-browser'),
      source: 'chrome-for-testing',
      version: '123.0.0.0',
    }), 'utf8');

    const manager = new BrowserKernelManager(root);
    await manager.loadMeta();
    assert.strictEqual(manager.status().kernel.path, binary);
    assert.strictEqual(manager.meta.binary, binary);
    console.log('  PASS  stale kernel metadata repaired to current data root');

    assert.throws(() => validateArchiveMemberName('../outside/chrome'));
    assert.throws(() => validateArchiveMemberName('/tmp/chrome'));
    assert.throws(() => validateArchiveMemberName('C:\\Windows\\chrome.exe'));
    assert.throws(() => validateArchiveMemberName('chrome.exe:payload'));
    assert.throws(() => validateArchiveMemberName('NUL.txt'));
    assert.strictEqual(validateArchiveMemberName('chrome dir/chrome'), 'chrome dir/chrome');
    console.log('  PASS  kernel archive path traversal rejected');

    if (process.platform !== 'win32') {
      const link = path.join(root, 'kernels', 'chrome-for-testing', 'linked-chrome');
      await fsp.symlink(binary, link);
      assert.strictEqual(safeInstalledBinary(link, path.join(root, 'kernels')), null);
      console.log('  PASS  linked kernel binary rejected');
    }

    const app = { getPath: (name) => name === 'userData' ? root : '' };
    await fsp.writeFile(path.join(root, 'openbrowser-engine.json'), JSON.stringify({
      kernelPolicyVersion: 1,
      preferIndependentKernel: true,
      allowSystemBrowserFallback: true,
    }), 'utf8');
    const engine = new BrowserEngine(app);
    await engine.init(null);
    assert.strictEqual(engine.allowSystemBrowserFallback, false);
    assert.strictEqual(engine.browserSelection().mode, 'independent');
    assert.strictEqual(engine.chooseBrowser().path, binary);
    console.log('  PASS  legacy fallback policy migrates to independent-only');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
