'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  BrowserKernelManager,
  downloadFile,
  validateArchiveMemberName,
  safeInstalledBinary,
  findOpenBrowserKernelBinary,
  findBundledWayfernKernel,
  isOpenBrowser148SupportedHost,
  isMacX64Host,
  isWayfernKernel,
  termsAcceptanceArgsForKernel,
  SOURCE_OPENBROWSER,
} = require('./browser-kernel');
const { BrowserEngine, systemBrowserCandidatesForPlatform } = require('../engine');

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

    const bundledRoot = path.join(root, 'bundled-kernels', 'wayfern');
    const bundledBinary = path.join(bundledRoot, process.platform === 'win32' ? 'wayfern.exe' : 'wayfern');
    await fsp.mkdir(bundledRoot, { recursive: true });
    await fsp.writeFile(bundledBinary, '', 'utf8');
    await fsp.writeFile(path.join(bundledRoot, 'kernel.json'), JSON.stringify({ version: '149.0.0.0' }), 'utf8');
    const bundled = findBundledWayfernKernel([root]);
    assert.strictEqual(path.resolve(bundled.binary), path.resolve(bundledBinary));
    assert.strictEqual(isWayfernKernel({ path: bundledBinary }), true);
    assert.deepStrictEqual(termsAcceptanceArgsForKernel({ path: bundledBinary }), ['--accept-terms-and-conditions']);
    assert.deepStrictEqual(termsAcceptanceArgsForKernel({ path: binary, source: 'chrome-for-testing' }), []);
    console.log('  PASS  bundled Wayfern kernel discovered from packaged resource root');

    assert.throws(() => validateArchiveMemberName('../outside/chrome'));
    assert.throws(() => validateArchiveMemberName('/tmp/chrome'));
    assert.throws(() => validateArchiveMemberName('C:\\Windows\\chrome.exe'));
    assert.throws(() => validateArchiveMemberName('chrome.exe:payload'));
    assert.throws(() => validateArchiveMemberName('NUL.txt'));
    assert.strictEqual(validateArchiveMemberName('chrome dir/chrome'), 'chrome dir/chrome');
    console.log('  PASS  kernel archive path traversal rejected');

    const existingArchive = path.join(root, 'kernels', 'existing-wayfern.zip');
    await fsp.mkdir(path.dirname(existingArchive), { recursive: true });
    await fsp.writeFile(existingArchive, 'stale archive', 'utf8');
    const originalGet = https.get;
    https.get = (_url, _options, callback) => {
      const req = new EventEmitter();
      req.destroy = (error) => { if (error) req.emit('error', error); };
      process.nextTick(() => {
        const res = new PassThrough();
        res.statusCode = 200;
        res.headers = { 'content-length': '11' };
        callback(res);
        res.end(Buffer.from('fresh bytes'));
      });
      return req;
    };
    try {
      await downloadFile('https://download.wayfern.com/test/wayfern.zip', existingArchive);
    } finally {
      https.get = originalGet;
    }
    assert.strictEqual(await fsp.readFile(existingArchive, 'utf8'), 'fresh bytes');
    console.log('  PASS  kernel download overwrites stale archive files');

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

    const windowsCandidates = systemBrowserCandidatesForPlatform('win32', {
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      PROGRAMW6432: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    });
    assert.ok(windowsCandidates.some((item) => item.name === 'Google Chrome' && item.path === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
    assert.ok(windowsCandidates.some((item) => item.name === 'Google Chrome' && item.path === 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'));
    assert.ok(windowsCandidates.some((item) => item.name === 'Google Chrome' && item.path === 'C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
    assert.ok(windowsCandidates.some((item) => item.name === 'Microsoft Edge' && item.path === 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'));
    assert.ok(windowsCandidates.some((item) => item.name === 'Microsoft Edge' && item.path === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'));
    assert.ok(windowsCandidates.some((item) => item.name === 'Microsoft Edge' && item.path === 'C:\\Users\\Test\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'));
    assert.ok(windowsCandidates.every((item) => item.name === 'Google Chrome' || item.name === 'Microsoft Edge'));
    console.log('  PASS  Windows system-browser choices include Chrome and Edge install locations');

    // Source-tree discovery: Browserapp/kernels/macos-x64 (or compat openbrowser/)
    const appRoot = path.join(__dirname, '..');
    const repoKernel = findOpenBrowserKernelBinary(path.join(root, 'kernels'), [appRoot, path.join(appRoot, 'kernels')]);
    if (!isOpenBrowser148SupportedHost()) {
      assert.strictEqual(repoKernel, null);
      console.log('  PASS  non-mac-x64 host never discovers openbrowser-148');
    } else if (repoKernel) {
      assert.ok(fs.existsSync(repoKernel));
      const norm = String(repoKernel);
      assert.ok(
        norm.includes(`${path.sep}kernels${path.sep}macos-x64${path.sep}`)
        || norm.includes(`${path.sep}kernels${path.sep}openbrowser${path.sep}`),
        `unexpected kernel path: ${norm}`
      );
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

    await engine.setKernelPolicy({ allowSystemBrowserFallback: true });
    assert.strictEqual(engine.allowSystemBrowserFallback, true);
    assert.strictEqual(engine.systemBrowserPath, null);
    const resolveInstalled = engine.kernelManager.resolveInstalled;
    engine.kernelManager.resolveInstalled = () => null;
    assert.strictEqual(engine.browserSelection().mode, 'blocked');
    const manualBrowser = path.join(root, 'manual-system-browser');
    await fsp.writeFile(manualBrowser, '', 'utf8');
    engine.systemBrowserCandidates = () => [{ name: 'Test system browser', path: manualBrowser }];
    await engine.setKernelPolicy({ systemBrowserPath: manualBrowser });
    assert.strictEqual(engine.browserSelection().mode, 'system-manual');
    assert.strictEqual(engine.browserSelection().browser.path, manualBrowser);
    engine.kernelManager.resolveInstalled = resolveInstalled;
    const reloaded = new BrowserEngine(app);
    await reloaded.init(null);
    assert.strictEqual(reloaded.allowSystemBrowserFallback, true);
    console.log('  PASS  system-browser fallback requires explicit manual selection');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
