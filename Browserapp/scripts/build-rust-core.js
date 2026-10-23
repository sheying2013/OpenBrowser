'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');

function readProductVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  return pkg.version || '1.0.26';
}

function buildRustCore() {
  const isWin = process.platform === 'win32';
  const executable = isWin ? 'openbrowser-core.exe' : 'openbrowser-core';
  const cargoCmd = isWin ? 'cargo.exe' : 'cargo';

  console.log('[build-rust-core] Building openbrowser-core in release mode (--locked)...');
  const buildResult = spawnSync(cargoCmd, ['build', '--package', 'openbrowser-core', '--release', '--locked'], {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (buildResult.error) {
    throw new Error(`Failed to execute cargo build: ${buildResult.error.message}`);
  }
  if (buildResult.status !== 0) {
    throw new Error(`cargo build exited with code ${buildResult.status}`);
  }

  const releaseBin = path.join(repoRoot, 'target', 'release', executable);
  if (!fs.existsSync(releaseBin)) {
    throw new Error(`Cargo build succeeded but binary not found at ${releaseBin}`);
  }

  const destDir = path.join(appRoot, 'rust-core');
  fs.mkdirSync(destDir, { recursive: true });
  const destBin = path.join(destDir, executable);

  fs.copyFileSync(releaseBin, destBin);
  if (!isWin) {
    fs.chmodSync(destBin, 0o755);
  }

  const expectedVersion = readProductVersion();
  console.log(`[build-rust-core] Verifying ${destBin} against application version ${expectedVersion}...`);
  const verifyResult = spawnSync(destBin, ['version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });

  if (verifyResult.error || verifyResult.status !== 0) {
    const detail = verifyResult.error ? verifyResult.error.message : (verifyResult.stderr || `exit ${verifyResult.status}`);
    throw new Error(`Failed to verify built openbrowser-core binary: ${detail}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(verifyResult.stdout.trim());
  } catch (err) {
    throw new Error(`Invalid JSON emitted by openbrowser-core version: ${verifyResult.stdout}`);
  }

  if (parsed.name !== 'openbrowser-core') {
    throw new Error(`Expected binary name 'openbrowser-core', got '${parsed.name}'`);
  }
  if (parsed.control_protocol !== 1) {
    throw new Error(`Expected control_protocol 1, got ${parsed.control_protocol}`);
  }
  if (parsed.version !== expectedVersion) {
    throw new Error(`Rust core version mismatch: expected ${expectedVersion}, got ${parsed.version}`);
  }
  if (!Array.isArray(parsed.capabilities) || !parsed.capabilities.includes('socks5-upstream') || !parsed.capabilities.includes('http-upstream')) {
    throw new Error(`Rust core missing required capabilities: ${JSON.stringify(parsed.capabilities)}`);
  }

  console.log(`[build-rust-core] Verified ${parsed.name} v${parsed.version} (protocol ${parsed.control_protocol}) at ${destBin}`);
  return { binaryPath: destBin, version: parsed };
}

if (require.main === module) {
  try {
    buildRustCore();
  } catch (err) {
    console.error(`[build-rust-core] FATAL: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { buildRustCore };
