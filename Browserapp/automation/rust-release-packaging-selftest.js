'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const { copyRustCore } = require('../scripts/package-portable');

async function check(name, fn) {
  await fn();
  console.log('PASS ' + name);
}

function readProductVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  return pkg.version || '1.0.26';
}

(async () => {
  const isWin = process.platform === 'win32';
  const executable = isWin ? 'openbrowser-core.exe' : 'openbrowser-core';
  const sourceBin = path.join(appRoot, 'rust-core', executable);
  const reportsDir = path.join(appRoot, 'reports', 'rust-packaging-selftest');
  fs.mkdirSync(reportsDir, { recursive: true });

  await check('rust-core source binary existence and version contract', async () => {
    assert(fs.existsSync(sourceBin), `Expected ${sourceBin} to exist. Run npm run build:rustcore first.`);
    const res = spawnSync(sourceBin, ['version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(res.status, 0, `openbrowser-core version failed: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.name, 'openbrowser-core');
    assert.equal(parsed.control_protocol, 1);
    assert.equal(parsed.version, readProductVersion());
    assert(Array.isArray(parsed.capabilities));
    assert(parsed.capabilities.includes('socks5-upstream'));
    assert(parsed.capabilities.includes('http-upstream'));
    assert(parsed.capabilities.includes('layout-planner'));
    assert(parsed.capabilities.includes('file-lock'));
  });

  await check('copyRustCore stages binary into resources/rust-core and preserves execution', async () => {
    const mockResources = path.join(reportsDir, 'mock-runtime', 'resources');
    const mockApp = path.join(mockResources, 'app');
    fs.mkdirSync(mockApp, { recursive: true });

    copyRustCore(mockApp);

    const stagedBin = path.join(mockResources, 'rust-core', executable);
    assert(fs.existsSync(stagedBin), `Expected staged binary at ${stagedBin}`);

    // Verify executable permission on Unix
    if (!isWin) {
      fs.accessSync(stagedBin, fs.constants.X_OK);
    }

    // Verify execution from staged destination
    const verRes = spawnSync(stagedBin, ['version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(verRes.status, 0);
    const verData = JSON.parse(verRes.stdout.trim());
    assert.equal(verData.name, 'openbrowser-core');
    assert.equal(verData.version, readProductVersion());

    // Verify layout command works from staged location
    const layoutRes = spawnSync(stagedBin, ['layout', '--screen-w', '1920', '--screen-h', '1080', '--taskbar', '40', '--count', '4', '--margin', '8', '--gap', '8'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.equal(layoutRes.status, 0);
    const layoutData = JSON.parse(layoutRes.stdout.trim());
    assert.equal(layoutData.count, 4);
    assert.equal(layoutData.windows.length, 4);

    // Verify app directory does NOT contain rust-core (no duplicate staging)
    const duplicateInApp = path.join(mockApp, 'rust-core');
    assert(!fs.existsSync(duplicateInApp), `Duplicate rust-core found in app resource: ${duplicateInApp}`);
  });

  await check('copyRustCore enforces binary validation and throws on missing or invalid source', async () => {
    const mockResources = path.join(reportsDir, 'mock-invalid', 'resources');
    const mockApp = path.join(mockResources, 'app');
    fs.mkdirSync(mockApp, { recursive: true });

    // Test with missing source directory
    const missingSourceDir = path.join(reportsDir, 'nonexistent-source');
    assert.throws(() => {
      copyRustCore(mockApp, missingSourceDir);
    }, /Build the native Rust core before packaging/);

    // Test with corrupt/non-executable source
    const badSourceDir = path.join(reportsDir, 'bad-source');
    fs.mkdirSync(badSourceDir, { recursive: true });
    fs.writeFileSync(path.join(badSourceDir, executable), 'corrupt binary', { mode: 0o755 });
    assert.throws(() => {
      copyRustCore(mockApp, badSourceDir);
    }, /Build the native Rust core before packaging/);
  });

  console.log('RUST_RELEASE_PACKAGING_SELFTEST_OK 3/3');
})();
