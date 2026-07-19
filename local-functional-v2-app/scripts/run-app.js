#!/usr/bin/env node
/**
 * Dev launcher: fully brand host bundle, then start OpenBrowser.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const {
  resolveHostDist,
  findHostAppBundle,
  findHostWindowsExe,
  findMacBinary,
} = require('./resolve-host-dist.js');

const appRoot = path.resolve(__dirname, '..');

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

  throw new Error('缺少当前平台的应用运行环境。请在 local-functional-v2-app 目录执行 npm install --force --include=dev。');
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
