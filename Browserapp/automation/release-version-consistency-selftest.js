#!/usr/bin/env node
'use strict';

/**
 * Release Version Consistency Selftest
 *
 * Verifies strict version alignment across all canonical delivery artifacts:
 * 1. Browserapp/package.json (semver root definition)
 * 2. Browserapp/package-lock.json (root package and packages[""])
 * 3. Browserapp/index.html (#app-version tag)
 * 4. Browserapp/scripts/brand-exe.mjs (PE file-version and product-version)
 * 5. README.md (release badge)
 * 6. README_CN.md (release badge)
 * 7. crates/openbrowser-core/Cargo.toml (Rust crate version)
 * 8. Cargo.lock (openbrowser-core package locked version)
 * 9. .github/workflows/build-installers.yml (workflow dispatch release_tag default & notes)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appRoot = path.join(__dirname, '..');
const repoRoot = path.join(appRoot, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const EXPECTED_VERSION = pkg.version;

assert.ok(
  typeof EXPECTED_VERSION === 'string' && /^\d+\d*\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(EXPECTED_VERSION),
  'Browserapp/package.json version must be a valid semver string'
);

console.log(`[Version Audit] Target release version: v${EXPECTED_VERSION}`);

let passCount = 0;
let failCount = 0;

function check(desc, fn) {
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passCount++;
  } catch (err) {
    console.error(`  ✗ ${desc}: ${err.message}`);
    failCount++;
  }
}

// 1. Browserapp/package.json
check('1. Browserapp/package.json semver is set', () => {
  assert.strictEqual(pkg.version, EXPECTED_VERSION);
});

// 2. Browserapp/package-lock.json
check('2. Browserapp/package-lock.json root and packages[""] match target', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(appRoot, 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.version, EXPECTED_VERSION, 'package-lock.json root version mismatch');
  assert.ok(lock.packages && lock.packages[''], 'package-lock.json packages[""] missing');
  assert.strictEqual(lock.packages[''].version, EXPECTED_VERSION, 'packages[""].version mismatch');
});

// 3. Browserapp/index.html
check('3. Browserapp/index.html #app-version display matches v' + EXPECTED_VERSION, () => {
  const html = fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8');
  const targetTag = `id="app-version">v${EXPECTED_VERSION}<`;
  assert.ok(html.includes(targetTag), `Missing ${targetTag} in index.html`);
});

// 4. Browserapp/scripts/brand-exe.mjs
check('4. Browserapp/scripts/brand-exe.mjs PE metadata matches ' + EXPECTED_VERSION + '.0', () => {
  const brand = fs.readFileSync(path.join(appRoot, 'scripts/brand-exe.mjs'), 'utf8');
  const expectedFourPart = `${EXPECTED_VERSION}.0`;
  assert.ok(
    brand.includes(`'file-version': '${expectedFourPart}'`),
    `file-version does not match ${expectedFourPart}`
  );
  assert.ok(
    brand.includes(`'product-version': '${expectedFourPart}'`),
    `product-version does not match ${expectedFourPart}`
  );
});

// 5. README.md
check('5. README.md version badge matches ' + EXPECTED_VERSION, () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const expectedBadge = `badge/version-${EXPECTED_VERSION}-blue`;
  assert.ok(readme.includes(expectedBadge), `Missing ${expectedBadge} in README.md`);
});

// 6. README_CN.md
check('6. README_CN.md version badge matches ' + EXPECTED_VERSION, () => {
  const readmeCn = fs.readFileSync(path.join(repoRoot, 'README_CN.md'), 'utf8');
  const expectedBadge = `badge/version-${EXPECTED_VERSION}-blue`;
  assert.ok(readmeCn.includes(expectedBadge), `Missing ${expectedBadge} in README_CN.md`);
});

// 7. crates/openbrowser-core/Cargo.toml
check('7. crates/openbrowser-core/Cargo.toml package version matches ' + EXPECTED_VERSION, () => {
  const cargoToml = fs.readFileSync(path.join(repoRoot, 'crates/openbrowser-core/Cargo.toml'), 'utf8');
  const match = cargoToml.match(/\[package\][\s\S]*?\bversion\s*=\s*"([^"]+)"/);
  assert.ok(match, 'Failed to extract package version from Cargo.toml');
  assert.strictEqual(match[1], EXPECTED_VERSION, `Cargo.toml version ${match[1]} !== ${EXPECTED_VERSION}`);
});

// 8. Cargo.lock
check('8. Cargo.lock openbrowser-core locked version matches ' + EXPECTED_VERSION, () => {
  const cargoLock = fs.readFileSync(path.join(repoRoot, 'Cargo.lock'), 'utf8');
  const match = cargoLock.match(/\[\[package\]\]\s*\nname\s*=\s*"openbrowser-core"\s*\nversion\s*=\s*"([^"]+)"/);
  assert.ok(match, 'Failed to locate openbrowser-core in Cargo.lock');
  assert.strictEqual(match[1], EXPECTED_VERSION, `Cargo.lock openbrowser-core version ${match[1]} !== ${EXPECTED_VERSION}`);
});

// 9. .github/workflows/build-installers.yml
check('9. .github/workflows/build-installers.yml release_tag default matches v' + EXPECTED_VERSION, () => {
  const wf = fs.readFileSync(path.join(repoRoot, '.github/workflows/build-installers.yml'), 'utf8');
  const expectedTag = `v${EXPECTED_VERSION}`;
  const defaultMatch = wf.match(/release_tag:[\s\S]*?default:\s*['"]([^'"]+)['"]/);
  assert.ok(defaultMatch, 'Failed to locate release_tag default in workflow');
  assert.strictEqual(defaultMatch[1], expectedTag, `Workflow release_tag default ${defaultMatch[1]} !== ${expectedTag}`);
  assert.ok(wf.includes(`**${expectedTag}**`), `Workflow RELEASE_NOTES missing **${expectedTag}**`);
});

console.log(`\n[Version Audit Result] Passed: ${passCount}, Failed: ${failCount}`);

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
