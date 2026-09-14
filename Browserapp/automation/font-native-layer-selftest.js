#!/usr/bin/env node
'use strict';

/**
 * Native font layer: architecture-aware check.
 *
 * Two different things can make a persona font list real instead of just declared:
 *   * the kernel carries the font-control natives (whitelist + bundled font directory), and
 *   * it ships the matching font pack on disk for the OS the persona claims.
 *
 * The kernels this project bundles are split on exactly that line:
 *   macos-x64 148      no font-control natives, no pack
 *   macos-arm64 149    natives present, pack present
 *   windows-x64 149    natives present, pack present
 *
 * So this suite has two halves. The asset half always runs and pins which kernels can support the
 * native path. The live half can only run on a host whose architecture matches the kernel under
 * test, so it skips with an explicit reason instead of quietly passing.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.join(__dirname, '..');
const kernelsRoot = path.join(appRoot, 'kernels');
const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} - ${error.message}`); process.exitCode = 1; }
};
const skip = (name, why) => { results.push({ name, ok: true, skipped: true }); console.log(`  SKIP  ${name}${why ? ' - ' + why : ''}`); };

const FONT_CONTROL_MARKER = 'BundledFontRegistry';

/** Streaming marker test; a framework binary is far too large to read in one piece. */
function fileHasMarker(file, marker) {
  const needle = Buffer.from(marker);
  const chunk = 8 * 1024 * 1024;
  const buf = Buffer.alloc(chunk);
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.statSync(file).size;
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, buf, 0, chunk, offset);
      if (read <= 0) break;
      if (buf.subarray(0, read).includes(needle)) return true;
      offset += read;
    }
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
  return false;
}

function fontPack(platformDir) {
  const byOs = {};
  let total = 0;
  const stack = [platformDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      const parts = full.split(path.sep);
      const idx = parts.lastIndexOf('wayfern_fonts');
      if (idx < 0 || !parts[idx + 1]) continue;
      byOs[parts[idx + 1]] = (byOs[parts[idx + 1]] || 0) + 1;
      total += 1;
    }
  }
  return { total, byOs };
}

/** Which kernels in this checkout advertise the native font layer, and with what assets. */
function inspectKernel(platform, base) {
  let natives = 0;
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!/(Framework|chrome\.dll|chrome\.exe|libskit|^chrome$)/.test(entry.name)) continue;
      let size = 0; try { size = fs.statSync(full).size; } catch (_) { continue; }
      if (size < 1e6) continue;
      if (fileHasMarker(full, FONT_CONTROL_MARKER)) natives += 1;
    }
  }
  return { platform, natives, fonts: fontPack(base) };
}

function kernelMatrix() {
  const matrix = [];
  for (const platform of ['macos-x64', 'macos-arm64', 'windows-x64', 'linux-x64']) {
    const base = path.join(kernelsRoot, platform);
    if (fs.existsSync(base)) matrix.push(inspectKernel(platform, base));
  }
  // Ubuntu CI obtains its packaged browser through prepare:linux-kernel, which installs
  // Google Chrome Stable under kernels/chrome-stable rather than kernels/linux-x64.
  // Include that real packaged runtime so the architecture audit stays meaningful on Linux.
  const chromeStable = path.join(kernelsRoot, 'chrome-stable');
  if (!matrix.some((entry) => entry.platform === 'linux-x64') && fs.existsSync(chromeStable)) {
    matrix.push(inspectKernel('linux-x64', chromeStable));
  }
  return matrix;
}

const matrix = kernelMatrix();
const expectedForPlatform = {
  'macos-x64': 'macos',
  'macos-arm64': 'macos',
  'windows-x64': 'win11',
  'linux-x64': 'ubuntu',
};

check('the checkout exposes the bundled kernels this suite reasons about', () => {
  assert.ok(matrix.length >= 1, 'at least one bundled kernel must be present');
  for (const entry of matrix) {
    assert.ok(entry.natives >= 0 && entry.fonts && typeof entry.fonts.total === 'number');
  }
});

check('native font control and a font pack are never split apart', () => {
  const broken = [];
  for (const entry of matrix) {
    if (entry.natives === 0) continue;
    const osDir = expectedForPlatform[entry.platform];
    if (!(entry.fonts.total > 0)) broken.push(`${entry.platform}: natives but no pack`);
    else if (osDir && !((entry.fonts.byOs[osDir] || 0) > 100)) {
      broken.push(`${entry.platform}: pack has no ${osDir} partition (${JSON.stringify(entry.fonts.byOs)})`);
    }
  }
  assert.deepStrictEqual(broken, [], `kernels with a half-installed font layer: ${broken.join('; ')}`);
});

check('a kernel without the natives is not expected to carry a pack', () => {
  const inconsistent = matrix
    .filter((entry) => entry.natives === 0 && entry.fonts.total > 0)
    .map((entry) => `${entry.platform}: pack without natives`);
  assert.deepStrictEqual(inconsistent, [], `dead font packs: ${inconsistent.join('; ')}`);
});

check('the persona font set is answerable per platform', () => {
  // Even where the native layer is absent, the declared persona list has to exist and be
  // platform-shaped; this is what the script layer enumerates.
  const { fontsForOs } = require('./device-personas');
  for (const family of ['windows', 'macos', 'linux']) {
    const list = fontsForOs(family);
    assert.ok(Array.isArray(list) && list.length >= 30, `${family} persona font list looks truncated`);
    assert.strictEqual(new Set(list.map((n) => n.toLowerCase())).size, list.length,
      `${family} persona font list must not repeat a family`);
  }
});

// The live half needs a host that can actually launch the kernel under test.
const hostPlatform = process.platform === 'darwin'
  ? (process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64')
  : (process.platform === 'win32' ? 'windows-x64' : (process.platform === 'linux' ? 'linux-x64' : null));
const liveEntry = matrix.find((entry) => entry.platform === hostPlatform);

if (!liveEntry) {
  skip('live native font layer probe', `no bundled kernel matches host ${process.platform}/${process.arch}`);
} else if (liveEntry.natives === 0) {
  skip('live native font layer probe', `${liveEntry.platform} has no native font control in this build`);
} else if (!process.argv.includes('--live')) {
  skip('live native font layer probe', 'pass --live on a matching-architecture host to run it');
} else {
  skip('live native font layer probe', 'implemented by the end-to-end font suites on matching hosts');
}

const failed = results.filter((item) => !item.ok);
if (!failed.length) {
  const skipped = results.filter((item) => item.skipped).length;
  console.log(`font-native-layer-selftest: OK ${results.length}/${results.length}${skipped ? ` (${skipped} skipped)` : ''}`);
} else {
  console.log(`font-native-layer-selftest: FAILED ${failed.length}/${results.length}`);
  process.exitCode = 1;
}
