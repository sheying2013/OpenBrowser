'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  BrowserKernelManager,
  validateArchiveMemberName,
  safeInstalledBinary,
  findOpenBrowserKernelBinary,
  isOpenBrowser148SupportedHost,
  isMacX64Host,
  SOURCE_OPENBROWSER,
} = require('./browser-kernel');
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

    // Manager without resourceRoots: only scans this temp userData.
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

    // Platform gate: openbrowser-148 is macOS x86_64 only
    assert.strictEqual(isOpenBrowser148SupportedHost('darwin', 'x64'), true);
    assert.strictEqual(isOpenBrowser148SupportedHost('darwin', 'x86_64'), true);
    assert.strictEqual(isOpenBrowser148SupportedHost('darwin', 'arm64'), false);
    assert.strictEqual(isOpenBrowser148SupportedHost('win32', 'x64'), false);
    assert.strictEqual(isOpenBrowser148SupportedHost('win32', 'x86_64'), false);
    assert.strictEqual(isOpenBrowser148SupportedHost('linux', 'x64'), false);
    assert.strictEqual(isMacX64Host(), process.platform === 'darwin' && process.arch === 'x64');
    console.log('  PASS  openbrowser-148 supported only on macOS x86_64');

    // Source-tree discovery: Browserapp/kernels/openbrowser (when present)
    const appRoot = path.join(__dirname, '..');
    const repoKernel = findOpenBrowserKernelBinary(path.join(root, 'kernels'), [appRoot, path.join(appRoot, 'kernels')]);
    if (!isOpenBrowser148SupportedHost()) {
      assert.strictEqual(repoKernel, null);
      console.log('  PASS  non-mac-x64 host never discovers openbrowser-148');
    } else if (repoKernel) {
      assert.ok(fs.existsSync(repoKernel));
      assert.ok(String(repoKernel).includes(`${path.sep}kernels${path.sep}openbrowser${path.sep}`));
      console.log('  PASS  source-tree OpenBrowser 148 binary discovered');
    } else {
      console.log('  SKIP  source-tree OpenBrowser 148 not present');
    }

    // Stale meta pointing at openbrowser-148 must not win on non-mac-x64 hosts.
    if (!isOpenBrowser148SupportedHost()) {
      const fakeBin = path.join(root, 'kernels', 'openbrowser', 'fake-openbrowser');
      await fsp.mkdir(path.dirname(fakeBin), { recursive: true });
      await fsp.writeFile(fakeBin, '', 'utf8');
      await fsp.writeFile(path.join(root, 'kernels', 'kernel-meta.json'), JSON.stringify({
        binary: fakeBin,
        source: SOURCE_OPENBROWSER,
        version: '148.0.0.0',
      }), 'utf8');
      const mgr = new BrowserKernelManager(root);
      await mgr.loadMeta();
      const st = mgr.status();
      assert.notStrictEqual(st.kernel && st.kernel.source, SOURCE_OPENBROWSER);
      assert.strictEqual(st.kernel.path, binary);
      console.log('  PASS  non-mac-x64 rejects stale openbrowser-148 meta');
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
    const chosen = engine.chooseBrowser();
    // On mac x64 with in-repo 148 kernel, engine prefers openbrowser-148 over temp CfT.
    if (repoKernel && isOpenBrowser148SupportedHost()) {
      assert.strictEqual(chosen.path, path.resolve(repoKernel));
      assert.strictEqual(chosen.source, SOURCE_OPENBROWSER);
      console.log('  PASS  engine prefers source OpenBrowser 148 on mac x64');
    } else {
      assert.notStrictEqual(chosen.source, SOURCE_OPENBROWSER);
      assert.strictEqual(chosen.path, binary);
      console.log('  PASS  legacy fallback policy migrates to independent-only');
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
