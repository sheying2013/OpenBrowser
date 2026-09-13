'use strict';

/**
 * Installed-kernel integrity record.
 *
 * Drives the REAL BrowserKernelManager through the whole cycle: record the tree
 * right after an install, then notice a file that disappeared or was truncated.
 *
 * The comparison is size-based on purpose - a tree copied into place by an
 * installer has fresh timestamps, so a timestamp check would report every file
 * as changed. That property is pinned below.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { BrowserKernelManager } = require('./browser-kernel');
const { MANIFEST_FILENAME } = require('./asset-integrity');


/** Every file under the wayfern_fonts directories, grouped by OS subdirectory. */
function countFontFiles(platformDir) {
  const byOs = {};
  let total = 0;
  const stack = [platformDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    const isFontRoot = path.basename(dir) === 'wayfern_fonts';
    const insideFontRoot = isFontRoot || dir.includes(path.sep + 'wayfern_fonts' + path.sep);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!insideFontRoot && path.basename(path.dirname(full)) !== 'wayfern_fonts') continue;
      if (!/^wayfern_fonts/.test(path.basename(dir)) && path.basename(path.dirname(full)) !== 'wayfern_fonts' && !insideFontRoot) continue;
      total += 1;
      const parts = full.split(path.sep);
      const idx = parts.lastIndexOf('wayfern_fonts');
      if (idx >= 0 && parts[idx + 1]) byOs[parts[idx + 1]] = (byOs[parts[idx + 1]] || 0) + 1;
    }
  }
  return { total, byOs };
}

/** Streaming marker test so a 250 MB framework is never read into memory at once. */
function fileContainsMarker(file, marker) {
  const needle = Buffer.from(marker);
  const chunkSize = 8 * 1024 * 1024;
  const buf = Buffer.alloc(chunkSize);
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.statSync(file).size;
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, buf, 0, chunkSize, offset);
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

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-kernel-integrity-'));

/** Create a stand-in install tree with a handful of files. */
async function makeInstallTree(name, files = { binary: 'x'.repeat(2048), 'libs/icudtl.dat': 'y'.repeat(512), 'kernel.json': '{"version":"1.0"}', 'locales/zh-CN.pak': 'z'.repeat(64) }) {
  const root = path.join(scratch, 'kernels', name);
  await fsp.rm(root, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
  return root;
}

function newManager(events) {
  return new BrowserKernelManager(scratch, { onProgress: (p) => events.push(p) });
}

(async () => {
  const root = await makeInstallTree('wayfern');

  // ---------- baseline ----------
  const events = [];
  const manager = newManager(events);

  await checkAsync('recording an install tree writes a manifest beside it', async () => {
    const summary = await manager.recordInstallBaseline(root);
    assert.strictEqual(summary.status, 'baselined', JSON.stringify(summary));
    assert.ok(fs.existsSync(path.join(root, MANIFEST_FILENAME)), 'manifest missing');
    assert.strictEqual(path.resolve(manager.meta.installRoot), path.resolve(root));
  });

  await checkAsync('a freshly recorded tree verifies clean', async () => {
    const summary = await manager.checkInstalledKernelIntegrity();
    assert.strictEqual(summary.status, 'ok', JSON.stringify(summary));
    assert.ok(summary.checked >= 4, `expected the files to be covered, got ${summary.checked}`);
    assert.strictEqual(events.filter((e) => e.code === 'KERNEL_INTEGRITY_MISMATCH').length, 0);
  });

  await checkAsync('the manifest does not count as its own extra file', async () => {
    const summary = await manager.checkInstalledKernelIntegrity();
    assert.strictEqual(summary.status, 'ok');
  });

  await checkAsync('status() exposes the latest result', async () => {
    const status = manager.status();
    assert.ok(status.integrity && status.integrity.status === 'ok', JSON.stringify(status.integrity));
  });

  // ---------- deletions and truncation ----------
  await checkAsync('a removed file is reported as missing', async () => {
    await fsp.rm(path.join(root, 'libs', 'icudtl.dat'));
    const summary = await manager.checkInstalledKernelIntegrity();
    assert.strictEqual(summary.status, 'mismatch', JSON.stringify(summary));
    assert.strictEqual(summary.missing, 1);
    assert.ok(summary.missingPaths.some((p) => p.endsWith('icudtl.dat')), JSON.stringify(summary.missingPaths));
  });

  await checkAsync('the mismatch is surfaced as a warning event that explains itself', async () => {
    const warnings = events.filter((e) => e.code === 'KERNEL_INTEGRITY_MISMATCH');
    assert.strictEqual(warnings.length, 1, 'expected exactly one warning');
    const warning = warnings[0];
    assert.strictEqual(warning.phase, 'integrity');
    assert.strictEqual(warning.level, 'warning');
    assert.ok(/缺失 1 个/.test(warning.message), warning.message);
    assert.ok(/重新安装内核/.test(warning.message), warning.message);
  });

  await checkAsync('a truncated file is reported as changed', async () => {
    // Restore the missing file so only the truncation is under test.
    await fsp.writeFile(path.join(root, 'libs', 'icudtl.dat'), 'y'.repeat(512));
    // Wait out the filesystem timestamp granularity, then shorten one file.
    await new Promise((r) => setTimeout(r, 20));
    await fsp.writeFile(path.join(root, 'binary'), 'x'.repeat(1024));
    const summary = await manager.checkInstalledKernelIntegrity();
    assert.strictEqual(summary.status, 'mismatch', JSON.stringify(summary));
    assert.strictEqual(summary.changed, 1, JSON.stringify(summary));
    assert.ok(summary.changedPaths.includes('binary'), JSON.stringify(summary.changedPaths));
  });

  await checkAsync('touch alone is not reported as a change', async () => {
    // Rewrite the file with identical content and a fresh timestamp.
    const binary = path.join(root, 'binary');
    await fsp.writeFile(binary, 'x'.repeat(2048));
    const summary = await manager.checkInstalledKernelIntegrity();
    assert.strictEqual(summary.status, 'ok', `timestamps must not be compared: ${JSON.stringify(summary)}`);
  });

  await checkAsync('an extra file is tolerated', async () => {
    await fsp.writeFile(path.join(root, 'chrome_debug.log'), 'noise');
    const summary = await manager.checkInstalledKernelIntegrity();
    assert.strictEqual(summary.status, 'ok', JSON.stringify(summary));
  });

  // ---------- scope ----------
  await checkAsync('unrelated siblings under the data root are not covered', async () => {
    const sibling = await makeInstallTree('some-other-tree', { 'share/data.bin': 'q'.repeat(32) });
    await fsp.rm(path.join(sibling, 'share', 'data.bin'));
    const summary = await manager.checkInstalledKernelIntegrity();
    assert.strictEqual(summary.status, 'ok', 'the record must describe the installed tree only');
  });

  await checkAsync('a tree outside the data root is refused', async () => {
    const outside = path.join(scratch, 'elsewhere');
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(outside, 'binary'), 'x'.repeat(16));
    const summary = await manager.recordInstallBaseline(outside);
    assert.strictEqual(summary.status, 'skipped');
    assert.strictEqual(summary.reason, 'outside-data-root');
  });

  await checkAsync('a recorded path outside the data root is ignored at check time', async () => {
    const outside = path.join(scratch, 'elsewhere');
    manager.meta.installRoot = outside;
    const summary = await manager.checkInstalledKernelIntegrity();
    assert.strictEqual(summary.status, 'unbaselined', JSON.stringify(summary));
  });

  await checkAsync('the data root itself is not treated as an install tree', async () => {
    manager.meta.installRoot = path.join(scratch, 'kernels');
    const summary = await manager.checkInstalledKernelIntegrity();
    assert.strictEqual(summary.status, 'unbaselined');
  });

  await checkAsync('a missing record reports unbaselined instead of a mismatch', async () => {
    manager.meta.installRoot = root;
    await fsp.rm(path.join(root, MANIFEST_FILENAME), { force: true });
    const summary = await manager.checkInstalledKernelIntegrity();
    assert.strictEqual(summary.status, 'unbaselined');
  });

  await checkAsync('recording a nonexistent tree never throws', async () => {
    const summary = await manager.recordInstallBaseline(path.join(scratch, 'kernels', 'not-installed'));
    assert.ok(summary && typeof summary.status === 'string', JSON.stringify(summary));
  });

  await checkAsync('choosing a custom binary clears the record', async () => {
    const fresh = newManager([]);
    fresh.meta.installRoot = root;
    fresh.integritySummary = { status: 'ok' };
    fresh.probeBrowserBinary = async (p) => ({ path: path.resolve(p), version: '9.9.9' });
    const probeRoot = path.join(scratch, 'custom-binary');
    await fsp.writeFile(probeRoot, '#!/bin/sh\n');
    await fresh.setCustomBinary(probeRoot);
    assert.strictEqual(fresh.meta.installRoot, null);
    assert.strictEqual(fresh.integritySummary, null);
  });

  // ---------- the install flows must call the baseline ----------
  check('every install flow records a baseline for the tree it unpacked', () => {
    const source = fs.readFileSync(path.join(__dirname, 'browser-kernel.js'), 'utf8');
    const calls = source.match(/await this\.recordInstallBaseline\(work\);/g) || [];
    assert.strictEqual(calls.length, 3, `expected 3 install flows to record a baseline, found ${calls.length}`);
    // Each one must sit next to a "done" progress report for that flow.
    for (const marker of ["独立内核就绪", "Google Chrome Stable 已就绪", "Chrome for Testing 就绪"]) {
      assert.ok(source.includes(marker), marker);
    }
  });

  check('the shipped sources call the check from the host process', () => {
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.ok(/kernelIntegrityCheck\?\.\(\)/.test(mainSource), 'main.js does not run the check');
    const engineSource = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
    assert.ok(/kernelIntegrityCheck\(\)/.test(engineSource), 'engine does not expose the check');
    assert.ok(/checkInstalledKernelIntegrity/.test(engineSource), 'engine does not delegate to the manager');
  });

  // ---- bundled font assets vs native font control ----
  check('a kernel with font-control natives ships the matching font pack', () => {
    const kernelsRoot = path.resolve(__dirname, '..', 'kernels');
    for (const plan of [{ platform: 'macos-arm64', osDir: 'macos' }, { platform: 'windows-x64', osDir: 'win11' }]) {
      const base = path.join(kernelsRoot, plan.platform);
      if (!fs.existsSync(base)) continue;
      const fonts = countFontFiles(base);
      let nativeWithControl = 0;
      const stack = [base];
      while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { stack.push(full); continue; }
          if (!/(Framework|chrome\.dll|chrome\.exe|libskit)/.test(entry.name)) continue;
          let size = 0; try { size = fs.statSync(full).size; } catch (_) { continue; }
          if (size < 1e6) continue;
          if (fileContainsMarker(full, 'BundledFontRegistry')) nativeWithControl += 1;
        }
      }
      if (nativeWithControl > 0) {
        assert.ok(fonts.total > 0, `${plan.platform} carries font-control natives but ships no wayfern_fonts`);
        assert.ok((fonts.byOs[plan.osDir] || 0) > 100,
          `${plan.platform} must ship the ${plan.osDir} font pack (found ${fonts.byOs[plan.osDir] || 0})`);
      }
    }
  });

  // ================= report =================
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nKERNEL_INTEGRITY_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${results.filter((r) => r.ok).length}/${results.length}`);
  if (failed.length) process.exitCode = 1;
  await fsp.rm(scratch, { recursive: true, force: true });
})();
