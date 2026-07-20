'use strict';

/**
 * macOS Dock shell + process identity regressions (CODE_OVERVIEW §4B / Bug H3 follow-ups).
 *   node dock-shell-selftest.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  commandMatchesExecutable,
  processIdentity,
  normalizeExpectedExecutables,
} = require('./automation/protocol/cross-platform');

function main() {
  // --- executable matching: kernel path vs env Dock shell ---
  const kernelPath = path.join(__dirname, 'kernels/macos-x64/chrome_148/openbrowser_148/OpenBrowser.app/Contents/MacOS/OpenBrowser');
  const dockCmd = '/Users/x/Library/Application Support/openbrowser/env-apps/id/环境 1.app/Contents/MacOS/OpenBrowser.bin --user-data-dir=/tmp/p --remote-debugging-port=0';
  const kernelCmd = `${kernelPath} --user-data-dir=/tmp/p`;

  assert.strictEqual(commandMatchesExecutable(dockCmd, kernelPath), true, 'kernel OpenBrowser basename should match OpenBrowser.bin dock process');
  assert.strictEqual(commandMatchesExecutable(dockCmd, 'OpenBrowser.bin'), true);
  assert.strictEqual(commandMatchesExecutable(dockCmd, 'OpenBrowser'), true);
  assert.strictEqual(commandMatchesExecutable(dockCmd, path.dirname(dockCmd) + '/OpenBrowser.bin'), true);
  assert.strictEqual(commandMatchesExecutable(kernelCmd, kernelPath), true);
  assert.strictEqual(commandMatchesExecutable('Safari --foo', kernelPath), false);
  assert.strictEqual(commandMatchesExecutable(dockCmd, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), false);

  // multi-hint list (what engine.managedBrowserKillOptions produces)
  const hints = normalizeExpectedExecutables({
    expectedExecutables: [
      '/Users/x/Library/Application Support/openbrowser/env-apps/id/环境 1.app/Contents/MacOS/OpenBrowser',
      kernelPath,
      'OpenBrowser.bin',
      'OpenBrowser',
    ],
  });
  assert.ok(hints.length >= 3);
  assert.ok(hints.some((h) => commandMatchesExecutable(dockCmd, h)));

  // processIdentity with multi executables + user-data-dir (live pid hard to fake — unit via normalize only on non-darwin may skip)
  // Ensure options shape accepted without throw
  const fake = processIdentity(process.pid, {
    expectedExecutables: [process.execPath, 'node'],
  });
  // Our own node process should match execPath or 'node'
  if (process.platform !== 'win32') {
    assert.strictEqual(fake.ok, true, 'self node process should match expectedExecutables, got ' + JSON.stringify(fake));
  }

  // --- env-icon refuses symlink fallback (static source check) ---
  const envIcon = fs.readFileSync(path.join(__dirname, 'automation/env-icon.js'), 'utf8');
  assert.ok(envIcon.includes('refusing kernel symlink'), 'must refuse symlink fallback for OpenBrowser.bin');
  assert.ok(!/copyFile\(src, dest\);\s*await fsp\.chmod\(dest, 0o755\);\s*\}\s*catch \(_\) \{\s*await forceSymlink\(src, dest\);/s.test(envIcon), 'must not symlink OpenBrowser.bin on copy failure');

  // --- engine records launchBinary + kills with multi executables + stops ipc stub ---
  const engineSrc = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
  assert.ok(engineSrc.includes('managedBrowserKillOptions'), 'engine must use managed kill options');
  assert.ok(engineSrc.includes('launchBinary'), 'item must record launchBinary');
  assert.ok(engineSrc.includes('stopIpcStubForWindow'), 'engine must stop ipc-stub on stop/cleanup');
  assert.ok(engineSrc.includes('expectedExecutables'), 'kill options must use multi executables');
  assert.ok(!/killProcessTree\([^)]*expectedExecutable:\s*(item\.browser|browser)\.path/.test(engineSrc), 'must not pass only browser.path as expectedExecutable');
  assert.ok(engineSrc.includes('isOpenBrowser148(browser)'), 'Dock shell only for openbrowser-148');
  assert.ok(engineSrc.includes('ipc-stub\\\\.py') || engineSrc.includes('ipc-stub\\.py'), 'pkill pattern must be anchored');
  assert.ok(engineSrc.includes('preferredId'), 'keepDefaultTab must retain navigated tab id');

  // --- env-icon: xml escape + no loose pkill ---
  assert.ok(envIcon.includes('xmlEscape'), 'Info.plist patch must XML-escape display name');
  assert.ok(envIcon.includes('looksLikeXmlPlist'), 'must not rewrite binary plists as utf8 blindly');
  assert.ok(envIcon.includes('ipc-stub\\\\.py') || envIcon.includes('ipc-stub\\.py'), 'launcher pkill must be anchored');

  // --- ipc-stub still present and install script syncs it ---
  const stub = path.join(__dirname, 'kernels/macos-x64/ipc-stub.py');
  assert.ok(fs.existsSync(stub), 'ipc-stub.py must ship in kernels/macos-x64');
  const install = fs.readFileSync(path.join(__dirname, 'scripts/install-kernel-macx86.sh'), 'utf8');
  assert.ok(install.includes('ipc-stub.py'), 'install-kernel-macx86 must sync ipc-stub');

  console.log('dock-shell-selftest: ok');
}

main();
