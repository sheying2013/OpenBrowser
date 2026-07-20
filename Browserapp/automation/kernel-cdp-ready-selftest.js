#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  isIntegratedKernelCdpReady,
  companionLibraryForKernelBinary,
  isWayfernKernel,
} = require('./browser-kernel');

const appRoot = path.join(__dirname, '..');
const winExe = path.join(appRoot, 'kernels', 'windows-x64', 'chrome.exe');
const macBin = path.join(appRoot, 'kernels', 'macos-arm64', 'Wayfern.app', 'Contents', 'MacOS', 'Wayfern');

function main() {
  if (fs.existsSync(winExe)) {
    assert.strictEqual(isWayfernKernel({ path: winExe, source: 'donut-wayfern' }), true);
    const dll = companionLibraryForKernelBinary(winExe);
    assert.ok(dll && /chrome\.dll$/i.test(dll), 'windows companion chrome.dll');
    assert.strictEqual(isIntegratedKernelCdpReady({ path: winExe, source: 'donut-wayfern' }), true);
    console.log('  PASS  windows-x64 seed is CDP-ready');
  } else {
    console.log('  SKIP  windows-x64 seed missing');
  }

  if (fs.existsSync(macBin)) {
    assert.strictEqual(isWayfernKernel({ path: macBin, source: 'donut-wayfern' }), true);
    const fw = companionLibraryForKernelBinary(macBin);
    assert.ok(fw && /Framework$/i.test(path.basename(fw)), 'macos companion framework');
    assert.strictEqual(isIntegratedKernelCdpReady({ path: macBin, source: 'donut-wayfern' }), true);
    console.log('  PASS  macos-arm64 seed is CDP-ready');
  } else {
    console.log('  SKIP  macos-arm64 seed missing');
  }

  // Negative: missing binary
  assert.strictEqual(isIntegratedKernelCdpReady({ path: path.join(appRoot, 'nope.exe') }), false);
  console.log('  PASS  missing binary is not CDP-ready');
  console.log('kernel-cdp-ready-selftest: ok');
}

main();
