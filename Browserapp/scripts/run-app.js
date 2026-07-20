#!/usr/bin/env node
/**
 * Dev launcher: fully brand host bundle, then start OpenBrowser.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  resolveHostDist,
  findHostAppBundle,
  findHostWindowsExe,
  findMacBinary,
} = require('./resolve-host-dist.js');
const { ensureHostRuntime } = require('./ensure-host-runtime.js');

const appRoot = path.resolve(__dirname, '..');

// Never start as root: Electron appData would become /var/root/... and split
// profile/fingerprint config from the normal user UI (~/Library/...).
function assertNonRootDevUser() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  const isRoot = uid === 0 || euid === 0 || process.env.USER === 'root' || process.env.LOGNAME === 'root';
  if (!isRoot) return;
  const hintUser = process.env.SUDO_USER || process.env.USER || 'your-user';
  console.error([
    '[run] refuse to start OpenBrowser as root/sudo.',
    '      Root writes userData to /var/root/Library/Application Support/openbrowser',
    '      while the UI you edit lives under ~/Library/Application Support/openbrowser.',
    `      Start as a normal user, e.g.: sudo -u ${hintUser} -H npm start`,
    `      home now would be: ${os.homedir()}`,
  ].join('\n'));
  process.exit(2);
}

assertNonRootDevUser();
ensureHostRuntime(appRoot);

if (process.platform === 'darwin') {
  // Must brand BEFORE resolving binary (renames Electron.app -> OpenBrowser.app).
  require('./brand-host-dev.js');
}

function resolveHostBinary() {
  if (process.platform === 'darwin') {
    const distRoot = resolveHostDist(appRoot);
    const appBundle = findHostAppBundle(distRoot);
    const binary = findMacBinary(path.join(appBundle, 'Contents', 'MacOS'));
    if (fs.existsSync(binary)) return binary;
  }

  if (process.platform === 'win32') {
    try {
      const binary = require('desktop-shell');
      if (typeof binary === 'string' && fs.existsSync(binary)) return binary;
    } catch (_) { /* fall through */ }
    const distRoot = resolveHostDist(appRoot);
    const binary = findHostWindowsExe(distRoot);
    if (fs.existsSync(binary)) return binary;
  }

  throw new Error('缺少当前平台的应用运行环境。请在 Browserapp 目录执行 npm install --force --include=dev。');
}

const hostBin = resolveHostBinary();
console.log('[run] starting', hostBin);

const child = spawn(hostBin, [appRoot], {
  stdio: 'inherit',
  env: process.env,
  cwd: appRoot,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code == null ? 1 : code);
});
