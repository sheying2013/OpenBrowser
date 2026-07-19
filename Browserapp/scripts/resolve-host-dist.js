#!/usr/bin/env node
/**
 * Locate the installed desktop host runtime dist folder without hardcoding vendor names.
 */
const fs = require('fs');
const path = require('path');

function resolveHostDist(appRoot) {
  const candidates = [
    path.join(appRoot, 'node_modules', 'desktop-shell', 'dist'),
    path.join(appRoot, 'node_modules', 'electron', 'dist'),
  ];
  for (const dist of candidates) {
    if (fs.existsSync(dist) && fs.readdirSync(dist).length > 0) return dist;
  }
  throw new Error('缺少应用运行环境。请在 Browserapp 目录执行 npm install --force --include=dev。');
}

function findHostAppBundle(distRoot) {
  const name = fs.readdirSync(distRoot).find((entry) => entry.endsWith('.app'));
  if (!name) throw new Error('缺少 macOS 主机应用包。请执行 npm install --force --include=dev。');
  return path.join(distRoot, name);
}

function findHostWindowsExe(distRoot) {
  const name = fs.readdirSync(distRoot).find((entry) => /\.exe$/i.test(entry));
  if (!name) throw new Error('缺少 Windows 主机可执行文件。请执行 npm install --force --include=dev。');
  return path.join(distRoot, name);
}

function findMacBinary(macosDir) {
  const entries = fs.readdirSync(macosDir);
  const preferred = entries.find((name) => name === 'OpenBrowser');
  if (preferred) return path.join(macosDir, preferred);
  // Host package ships a single main executable
  const binary = entries.find((name) => {
    const full = path.join(macosDir, name);
    try {
      return fs.statSync(full).isFile() && (fs.statSync(full).mode & 0o111);
    } catch (_) {
      return false;
    }
  }) || entries[0];
  if (!binary) throw new Error('macOS 主机二进制未找到');
  return path.join(macosDir, binary);
}

module.exports = {
  resolveHostDist,
  findHostAppBundle,
  findHostWindowsExe,
  findMacBinary,
};
