#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function packageRoot(appRoot) {
  for (const name of ['desktop-shell', 'electron']) {
    const candidate = path.join(appRoot, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function hasRuntime(root) {
  if (!root) return false;
  const dist = path.join(root, 'dist');
  if (!fs.existsSync(dist)) return false;
  const entries = fs.readdirSync(dist);
  if (process.platform === 'darwin') return entries.some((entry) => entry.endsWith('.app'));
  if (process.platform === 'win32') return entries.some((entry) => /\.exe$/i.test(entry));
  return entries.length > 0;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`);
}

function ensureHostRuntime(appRoot) {
  let root = packageRoot(appRoot);
  if (hasRuntime(root)) return root;

  if (!root) {
    console.log('[runtime] installing OpenBrowser dependencies');
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--force', '--include=dev'], appRoot);
    root = packageRoot(appRoot);
  }

  if (!root) throw new Error('缺少桌面运行时 npm 包。请在 Browserapp 目录执行 npm install --force --include=dev。');

  const installer = path.join(root, 'install.js');
  if (fs.existsSync(installer)) {
    console.log('[runtime] downloading platform runtime');
    run(process.execPath, [installer], appRoot);
  }

  if (!hasRuntime(root)) {
    throw new Error('当前平台的桌面运行时安装失败。请在 Browserapp 目录执行 npm install --force --include=dev。');
  }
  return root;
}

if (require.main === module) ensureHostRuntime(path.resolve(__dirname, '..'));

module.exports = { ensureHostRuntime, hasRuntime };
