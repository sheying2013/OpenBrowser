#!/usr/bin/env node
'use strict';

/**
 * Isolated unit and integration test suite for Browserapp/scripts/package-portable.js
 *
 * Verifies:
 * 1. Prohibited artifacts are strictly excluded:
 *    - reports/ directories and nested reports
 *    - ui-audit-artifacts/ and nested artifacts
 *    - Markdown development documentation (*.md)
 *    - Preview report HTML/PNG files (preview-*.html, preview-*.png, test-select*)
 *    - Test report snapshots (test-logs-*.png, shot-*.png, light-*.png, final-preview-*.png)
 *    - Bytecode, cache, and scratch dirs (__pycache__, *.pyc, .DS_Store, .playwright-cli, .tmp*, .trash*, functional-selftest-data)
 * 2. Essential runtime deliverables and licenses are preserved:
 *    - Core runtime JS (main.js, engine.js, renderer.js, preload.js, i18n.js)
 *    - Core UI (index.html, index.json, package.json)
 *    - Themes & CSS skins (nes-light.css, pixel-workstation.css, oceanic-fingerprint.css, retro-desktop.css, styles.css, etc.)
 *    - Fonts (arial.woff2, pingfang-sc.woff2)
 *    - Product brand assets & icons (logo.png, logo.ico, logo.icns, OpenBrowser.iconset, bundled-extension/icon-*.png)
 *    - Licenses & notices (THIRD-PARTY-NOTICES.md, LICENSE, LICENSE.chrome-power.txt, OFL-ark-pixel.txt)
 * 3. Isolated sandbox copyRecursive hierarchy verification
 * 4. Verification that cloud checkout (git-tracked files) does not contain untracked reports,
 *    ui-audit-artifacts, preview files, or test snapshots.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const packager = require('../scripts/package-portable');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('Running package-portable isolation selftest...');

// Test 1: appResourceExcludes contains required entries
test('appResourceExcludes contains all expected top-level directories and files', () => {
  const excludes = packager.appResourceExcludes();
  const required = [
    'node_modules',
    'dist',
    '.git',
    'CODE_OVERVIEW.md',
    'bundled-kernels',
    'rust-core',
    'reports',
    'ui-audit-artifacts',
    'functional-selftest-data',
    '__pycache__',
    '.DS_Store',
    '.playwright-cli',
  ];
  for (const item of required) {
    assert.ok(excludes.has(item), `appResourceExcludes missing expected item: ${item}`);
  }
});

// Test 2: isPackagingExcluded correctly excludes reports and audit artifacts
test('isPackagingExcluded filters reports and ui-audit-artifacts', () => {
  assert.strictEqual(packager.isPackagingExcluded('reports'), true);
  assert.strictEqual(packager.isPackagingExcluded('reports', '/path/to/reports'), true);
  assert.strictEqual(packager.isPackagingExcluded('some-file.txt', '/path/to/reports/sub/some-file.txt'), true);
  assert.strictEqual(packager.isPackagingExcluded('ui-audit-artifacts'), true);
  assert.strictEqual(packager.isPackagingExcluded('ui-audit-artifacts', 'automation/ui-audit-artifacts'), true);
  assert.strictEqual(packager.isPackagingExcluded('trace.json', 'automation/ui-audit-artifacts/run-1/trace.json'), true);
  assert.strictEqual(packager.isPackagingExcluded('functional-selftest-data'), true);
});

// Test 2b: dist directory handling - allow runtime root dist while excluding appRoot/dist
test('dist directory handling allows runtime root with basename dist and excludes appRoot/dist', () => {
  const appRoot = path.resolve(__dirname, '..');
  const appRootDist = path.join(appRoot, 'dist');
  const hostDistCandidates = [
    path.join(appRoot, 'node_modules', 'desktop-shell', 'dist'),
    path.join(appRoot, 'node_modules', 'electron', 'dist'),
    '/opt/hostedtoolcache/node_modules/desktop-shell/dist',
  ];

  // appRoot/dist (the packager build destination) must be excluded
  assert.strictEqual(packager.isPackagingExcluded('dist', appRootDist), true, 'appRoot/dist must be excluded');

  // Actual host runtime distribution directories (whose basename is dist) must NOT be excluded
  for (const candidate of hostDistCandidates) {
    assert.strictEqual(
      packager.isPackagingExcluded('dist', candidate),
      false,
      `Host runtime dist at ${candidate} must NOT be excluded`
    );
  }

  // Without fullPath, generic dist should not be excluded so external copy roots succeed
  assert.strictEqual(packager.isPackagingExcluded('dist'), false, 'generic dist without fullPath must not be excluded');
});

// Test 3: isPackagingExcluded filters markdown dev docs but preserves licenses/notices
test('isPackagingExcluded excludes markdown dev docs while preserving licenses', () => {
  // Excluded dev docs
  assert.strictEqual(packager.isPackagingExcluded('README.md'), true);
  assert.strictEqual(packager.isPackagingExcluded('README_CN.md'), true);
  assert.strictEqual(packager.isPackagingExcluded('CODE_OVERVIEW.md'), true);
  assert.strictEqual(packager.isPackagingExcluded('2026-10-14_ui-audit-report.md'), true);
  assert.strictEqual(packager.isPackagingExcluded('cross-realm-detection-adversarial-audit.md'), true);
  assert.strictEqual(packager.isPackagingExcluded('some-guide.md'), true);

  // Preserved licenses and legal notices
  assert.strictEqual(packager.isPackagingExcluded('THIRD-PARTY-NOTICES.md'), false);
  assert.strictEqual(packager.isPackagingExcluded('LICENSE'), false);
  assert.strictEqual(packager.isPackagingExcluded('LICENSE.chrome-power.txt'), false);
  assert.strictEqual(packager.isPackagingExcluded('LICENSE.txt'), false);
  assert.strictEqual(packager.isPackagingExcluded('OFL-ark-pixel.txt'), false);
  assert.strictEqual(packager.isPackagingExcluded('DISCLAIMER.md'), false);
});

// Test 4: isPackagingExcluded filters preview report files and test report snapshots
test('isPackagingExcluded excludes preview files and test snapshots', () => {
  const previews = [
    'preview-editor.html',
    'preview-full.html',
    'preview-mock-light.html',
    'preview-mock.html',
    'preview-oceanic-dark.html',
    'preview-privacy.html',
    'preview-sync.html',
    'preview-theme-picker.html',
    'preview-basic-full.html',
    'preview-editor-basic.png',
    'preview-editor-privacy.png',
    'test-select.html',
    'test-select.png',
    'test-select-light.html',
    'test-select-light.png',
    'test-logs-dark.png',
    'test-logs-light.png',
    'shot-basic.png',
    'shot-privacy.png',
    'light-basic.png',
    'light-privacy.png',
    'final-preview-basic.png',
    'final-preview-privacy.png',
  ];

  for (const p of previews) {
    assert.strictEqual(packager.isPackagingExcluded(p), true, `Expected ${p} to be excluded`);
  }
});

// Test 5: isPackagingExcluded preserves product runtime deliverables
test('isPackagingExcluded preserves all runtime deliverables, themes, and assets', () => {
  const deliverables = [
    'main.js',
    'engine.js',
    'renderer.js',
    'preload.js',
    'index.html',
    'package.json',
    'index.json',
    'i18n.js',
    'styles.css',
    'themes.css',
    'nes-light.css',
    'pixel-workstation.css',
    'oceanic-fingerprint.css',
    'retro-desktop.css',
    'element-admin.css',
    'xai-console.css',
    'ui-shell.css',
    'arial.woff2',
    'pingfang-sc.woff2',
    'logo.png',
    'logo.ico',
    'logo.icns',
    'icon_128x128.png',
    'icon-128.png',
    'lucide.min.js',
  ];

  for (const d of deliverables) {
    assert.strictEqual(packager.isPackagingExcluded(d), false, `Expected deliverable ${d} to NOT be excluded`);
  }
});

// Test 6: Sandbox copyRecursive isolation test
test('copyRecursive filters prohibited files and preserves deliverables in isolated sandbox', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-package-isolation-'));
  try {
    const src = path.join(tmp, 'src');
    const dst = path.join(tmp, 'dst');

    // Create realistic folder structure
    fs.mkdirSync(path.join(src, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(src, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(src, 'automation/ui-audit-artifacts/run-1'), { recursive: true });
    fs.mkdirSync(path.join(src, 'scripts/__pycache__'), { recursive: true });
    fs.mkdirSync(path.join(src, '.tmp-profile-selftest'), { recursive: true });

    // Runtime deliverables
    fs.writeFileSync(path.join(src, 'main.js'), 'console.log("main");');
    fs.writeFileSync(path.join(src, 'index.html'), '<!DOCTYPE html><html><body>OpenBrowser</body></html>');
    fs.writeFileSync(path.join(src, 'nes-light.css'), 'html[data-ui-theme="nes-light"] {}');
    fs.writeFileSync(path.join(src, 'assets/logo.png'), 'PNG_LOGO');
    fs.writeFileSync(path.join(src, 'assets/arial.woff2'), 'WOFF2_FONT');
    fs.writeFileSync(path.join(src, 'THIRD-PARTY-NOTICES.md'), '# Third-Party Notices');
    fs.writeFileSync(path.join(src, 'LICENSE.chrome-power.txt'), 'AGPL-3.0');

    // Prohibited files
    fs.writeFileSync(path.join(src, 'preview-mock.html'), '<html>preview</html>');
    fs.writeFileSync(path.join(src, 'test-logs-dark.png'), 'PNG_LOG');
    fs.writeFileSync(path.join(src, 'reports/audit-report.md'), '# Audit Report');
    fs.writeFileSync(path.join(src, 'reports/raw.json'), '{}');
    fs.writeFileSync(path.join(src, 'automation/ui-audit-artifacts/run-1/screenshot.png'), 'PNG');
    fs.writeFileSync(path.join(src, 'automation/README.md'), '# Automation docs');
    fs.writeFileSync(path.join(src, 'automation/2026-10-14_ui-audit-report.md'), '# Report');
    fs.writeFileSync(path.join(src, 'automation/preview-basic-full.html'), '<html>preview</html>');
    fs.writeFileSync(path.join(src, 'automation/shot-basic.png'), 'PNG');
    fs.writeFileSync(path.join(src, 'automation/test-select.html'), '<html></html>');
    fs.writeFileSync(path.join(src, 'scripts/__pycache__/cache.pyc'), 'PYC');
    fs.writeFileSync(path.join(src, '.tmp-profile-selftest/state.json'), '{}');
    fs.writeFileSync(path.join(src, '.DS_Store'), 'DS_STORE');

    packager.copyRecursive(src, dst);

    // Verify required deliverables ARE present
    assert.ok(fs.existsSync(path.join(dst, 'main.js')), 'main.js must exist in dst');
    assert.ok(fs.existsSync(path.join(dst, 'index.html')), 'index.html must exist in dst');
    assert.ok(fs.existsSync(path.join(dst, 'nes-light.css')), 'nes-light.css must exist in dst');
    assert.ok(fs.existsSync(path.join(dst, 'assets/logo.png')), 'assets/logo.png must exist in dst');
    assert.ok(fs.existsSync(path.join(dst, 'assets/arial.woff2')), 'assets/arial.woff2 must exist in dst');
    assert.ok(fs.existsSync(path.join(dst, 'THIRD-PARTY-NOTICES.md')), 'THIRD-PARTY-NOTICES.md must exist in dst');
    assert.ok(fs.existsSync(path.join(dst, 'LICENSE.chrome-power.txt')), 'LICENSE.chrome-power.txt must exist in dst');

    // Verify prohibited files are NOT present
    assert.strictEqual(fs.existsSync(path.join(dst, 'reports')), false, 'reports must NOT exist in dst');
    assert.strictEqual(fs.existsSync(path.join(dst, 'automation/ui-audit-artifacts')), false, 'ui-audit-artifacts must NOT exist in dst');
    assert.strictEqual(fs.existsSync(path.join(dst, 'preview-mock.html')), false, 'preview-mock.html must NOT exist in dst');
    assert.strictEqual(fs.existsSync(path.join(dst, 'test-logs-dark.png')), false, 'test-logs-dark.png must NOT exist in dst');
    assert.strictEqual(fs.existsSync(path.join(dst, 'automation/README.md')), false, 'automation/README.md must NOT exist in dst');
    assert.strictEqual(fs.existsSync(path.join(dst, 'automation/2026-10-14_ui-audit-report.md')), false, 'audit md must NOT exist in dst');
    assert.strictEqual(fs.existsSync(path.join(dst, 'automation/preview-basic-full.html')), false, 'automation preview html must NOT exist in dst');
    assert.strictEqual(fs.existsSync(path.join(dst, 'automation/shot-basic.png')), false, 'shot-basic.png must NOT exist in dst');
    assert.strictEqual(fs.existsSync(path.join(dst, 'automation/test-select.html')), false, 'test-select.html must NOT exist in dst');
    assert.strictEqual(fs.existsSync(path.join(dst, 'scripts/__pycache__')), false, '__pycache__ must NOT exist in dst');
    assert.strictEqual(fs.existsSync(path.join(dst, '.tmp-profile-selftest')), false, '.tmp-profile-selftest must NOT exist in dst');
    assert.strictEqual(fs.existsSync(path.join(dst, '.DS_Store')), false, '.DS_Store must NOT exist in dst');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Test 6b: Runtime root copying from a directory named 'dist' (e.g. desktop-shell/dist or electron/dist)
test('copyRecursive(resolvedHostDist, runtimeRoot) copies complete runtime when source basename is dist', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-runtime-copy-'));
  try {
    // Simulate desktop-shell/dist or electron/dist layout
    const mockHostDist = path.join(tmp, 'node_modules', 'desktop-shell', 'dist');
    const runtimeRoot = path.join(tmp, 'packageRoot', 'runtime');

    fs.mkdirSync(mockHostDist, { recursive: true });
    fs.mkdirSync(path.join(mockHostDist, 'resources'), { recursive: true });
    fs.mkdirSync(path.join(mockHostDist, 'locales'), { recursive: true });

    // Linux / Windows executable
    fs.writeFileSync(path.join(mockHostDist, 'electron'), 'ELF_OR_EXE_BINARY', { mode: 0o755 });
    fs.writeFileSync(path.join(mockHostDist, 'resources', 'default_app.asar'), 'ASAR');
    fs.writeFileSync(path.join(mockHostDist, 'LICENSE'), 'MIT');
    fs.writeFileSync(path.join(mockHostDist, 'version'), '43.1.1');

    assert.strictEqual(path.basename(mockHostDist), 'dist', 'Mock source basename must be dist');

    // Run copyRecursive with the dist directory as source
    packager.copyRecursive(mockHostDist, runtimeRoot);

    // Verify electron binary and runtime components exist in runtimeRoot
    assert.ok(fs.existsSync(runtimeRoot), 'runtimeRoot must be created');
    assert.ok(fs.existsSync(path.join(runtimeRoot, 'electron')), 'runtime/electron must exist');
    assert.ok(fs.existsSync(path.join(runtimeRoot, 'resources', 'default_app.asar')), 'runtime/resources/default_app.asar must exist');
    assert.ok(fs.existsSync(path.join(runtimeRoot, 'LICENSE')), 'runtime/LICENSE must exist');
    assert.ok(fs.existsSync(path.join(runtimeRoot, 'version')), 'runtime/version must exist');

    // Verify rename simulation (what packageLinux does) succeeds without ENOENT
    const mainBinary = path.join(runtimeRoot, 'OpenBrowser');
    const copiedHostBinary = path.join(runtimeRoot, 'electron');
    fs.renameSync(copiedHostBinary, mainBinary);
    assert.ok(fs.existsSync(mainBinary), 'Renamed OpenBrowser binary must exist');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Test 7: Cloud checkout verification - git tracking invariants
test('git tracked files verify cloud checkout does not contain untracked reports or snapshots', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  try {
    const gitFiles = execSync('git ls-files Browserapp/', { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    // Verify reports/ has 0 tracked files
    const trackedReports = gitFiles.filter((f) => /^Browserapp\/reports\//i.test(f));
    assert.deepStrictEqual(trackedReports, [], 'Git must track 0 files in Browserapp/reports/');

    // Verify ui-audit-artifacts has 0 tracked files
    const trackedArtifacts = gitFiles.filter((f) => /ui-audit-artifacts/i.test(f));
    assert.deepStrictEqual(trackedArtifacts, [], 'Git must track 0 files in ui-audit-artifacts');

    // Verify preview-*.html has 0 tracked files
    const trackedPreviews = gitFiles.filter((f) => /^Browserapp\/preview-[^/]+\.html$/i.test(f));
    assert.deepStrictEqual(trackedPreviews, [], 'Git must track 0 preview-*.html files in Browserapp root');

    // Verify test-logs-*.png has 0 tracked files
    const trackedLogs = gitFiles.filter((f) => /test-logs/i.test(f));
    assert.deepStrictEqual(trackedLogs, [], 'Git must track 0 test-logs PNG files');
  } catch (err) {
    if (err.message.includes('not a git repository')) {
      console.log('    (Skipping git ls-files check: not a git repo)');
    } else {
      throw err;
    }
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
