#!/usr/bin/env node
'use strict';

/**
 * Verify integrated kernel seeds under Browserapp/kernels/ before packaging.
 *
 * Flat layout:
 *   kernels/macos-x64
 *   kernels/windows-x64
 *   kernels/macos-arm64
 *
 * Runtime auto-download is disabled. This script does not download kernels.
 * For Windows/mac-arm seeds it also verifies companion-library CDP readiness markers.
 *
 * Env:
 *   OPENBROWSER_PACKAGE_ARCH = x64 | arm64 | x86_64 | aarch64
 */

const fs = require('fs');
const path = require('path');
const {
  isIntegratedKernelCdpReady,
  companionLibraryForKernelBinary,
} = require('../automation/browser-kernel');

const appRoot = path.resolve(__dirname, '..');
const kernelsRoot = path.join(appRoot, 'kernels');

function packageArch() {
  const value = String(process.env.OPENBROWSER_PACKAGE_ARCH || process.arch).toLowerCase();
  if (value === 'x64' || value === 'amd64' || value === 'x86_64') return 'x64';
  if (value === 'aarch64') return 'arm64';
  return value;
}

function platformKey() {
  // Allow verifying any seed from any host (CI/local maintainer checks).
  const forced = String(process.env.OPENBROWSER_VERIFY_PLATFORM || '').trim().toLowerCase();
  if (forced) return forced;
  const arch = packageArch();
  if (process.platform === 'darwin') return `macos-${arch}`;
  if (process.platform === 'win32') return `windows-${arch}`;
  throw new Error(`Unsupported package host: ${process.platform}/${arch}`);
}

function assertExists(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} missing: ${file}`);
}

function resolveSeedDir(platform) {
  const preferred = path.join(kernelsRoot, platform);
  if (fs.existsSync(preferred)) return preferred;
  if (platform === 'macos-x64') {
    const legacy = path.join(kernelsRoot, 'openbrowser');
    if (fs.existsSync(legacy)) return legacy;
  }
  const nested = path.join(kernelsRoot, 'wayfern', platform);
  if (fs.existsSync(nested)) return nested;
  return preferred;
}

function assertCdpReady(binary, label) {
  if (!isIntegratedKernelCdpReady({ path: binary, source: 'donut-wayfern' })) {
    const lib = companionLibraryForKernelBinary(binary);
    throw new Error(
      `${label} CDP readiness check failed.`
      + ` binary=${binary}`
      + (lib ? ` companion=${lib}` : ' companion=missing')
      + ' Re-prepare the integrated seed before packaging.'
    );
  }
}

function main() {
  const platform = platformKey();
  console.log(`[kernel] verify integrated seed for ${platform}`);
  console.log(`[kernel] layout root: ${kernelsRoot}`);

  if (platform === 'macos-x64') {
    const seed = resolveSeedDir('macos-x64');
    const bin = path.join(
      seed,
      'chrome_148',
      'openbrowser_148',
      'OpenBrowser.app',
      'Contents',
      'MacOS',
      'OpenBrowser'
    );
    assertExists(bin, 'macOS x64 kernel launcher');
    console.log(`[kernel] ok macos-x64 at ${bin}`);
    return;
  }

  if (platform === 'windows-x64') {
    const seed = resolveSeedDir('windows-x64');
    const exe = path.join(seed, 'chrome.exe');
    const dll = path.join(seed, 'chrome.dll');
    assertExists(exe, 'Windows kernel chrome.exe');
    assertExists(dll, 'Windows kernel chrome.dll');
    assertCdpReady(exe, 'windows-x64');
    console.log(`[kernel] ok windows-x64 CDP-ready at ${seed}`);
    return;
  }

  if (platform === 'macos-arm64') {
    const seed = resolveSeedDir('macos-arm64');
    const bin = path.join(seed, 'Wayfern.app', 'Contents', 'MacOS', 'Wayfern');
    const alt = path.join(seed, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    const binary = fs.existsSync(bin) ? bin : alt;
    assertExists(binary, 'macOS arm64 kernel binary');
    assertCdpReady(binary, 'macos-arm64');
    console.log(`[kernel] ok macos-arm64 CDP-ready at ${seed}`);
    return;
  }

  throw new Error(`No integrated kernel policy for ${platform}`);
}

try {
  main();
} catch (error) {
  console.error(`[kernel] ${error.message}`);
  process.exitCode = 1;
}
