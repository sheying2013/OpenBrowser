'use strict';

/**
 * Self-test for the directory integrity manifest.
 * Uses a real temporary directory so the filesystem behaviour is exercised.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const {
  buildManifest,
  verifyManifest,
  writeManifest,
  readManifest,
  ensureManifest,
  listFiles,
  toPosix,
  MANIFEST_FILENAME,
} = require('./asset-integrity');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

async function makeDir(files) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'integrity-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
  return root;
}

const flush = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  // ---- helpers ----

  check('toPosix converts separators to forward slashes', () => {
    assert.strictEqual(toPosix(path.join('a', 'b', 'c')), 'a/b/c');
  });

  // ---- listing ----

  await checkAsync('listFiles walks subdirectories and sorts', async () => {
    const root = await makeDir({ 'b.txt': 'b', 'a.txt': 'a', 'sub/c.txt': 'c' });
    const files = await listFiles(root);
    assert.deepStrictEqual(files, ['a.txt', 'b.txt', 'sub/c.txt']);
  });

  await checkAsync('listFiles honours a filter', async () => {
    const root = await makeDir({ 'keep.js': '1', 'drop.txt': '2', 'sub/keep.js': '3' });
    const files = await listFiles(root, { filter: (rel) => rel.endsWith('.js') });
    assert.deepStrictEqual(files, ['keep.js', 'sub/keep.js']);
  });

  await checkAsync('listFiles respects maxEntries', async () => {
    const root = await makeDir({ 'a': '1', 'b': '2', 'c': '3', 'd': '4' });
    const files = await listFiles(root, { maxEntries: 2 });
    assert.strictEqual(files.length, 2);
  });

  await checkAsync('listFiles returns nothing for a missing directory', async () => {
    assert.deepStrictEqual(await listFiles(path.join(os.tmpdir(), 'does-not-exist-xyz')), []);
  });

  // ---- manifest ----

  await checkAsync('buildManifest records relative paths, size and mtime', async () => {
    const root = await makeDir({ 'a.txt': 'hello', 'sub/b.txt': 'world!' });
    const manifest = await buildManifest(root);
    assert.strictEqual(manifest.files.length, 2);
    const a = manifest.files.find((f) => f.filePath === 'a.txt');
    assert.strictEqual(a.size, 5);
    assert.ok(Number.isFinite(a.mtimeMs) && a.mtimeMs > 0);
    assert.strictEqual(manifest.root, root);
  });

  await checkAsync('buildManifest can exclude specific paths', async () => {
    const root = await makeDir({ 'keep.txt': '1', 'skip.txt': '2' });
    const manifest = await buildManifest(root, { exclude: ['skip.txt'] });
    assert.deepStrictEqual(manifest.files.map((f) => f.filePath), ['keep.txt']);
  });

  // ---- verification ----

  await checkAsync('an unchanged directory verifies clean', async () => {
    const root = await makeDir({ 'a.txt': 'hello', 'sub/b.txt': 'world' });
    const manifest = await buildManifest(root);
    const report = await verifyManifest(root, manifest);
    assert.strictEqual(report.ok, true);
    assert.deepStrictEqual(report.missing, []);
    assert.deepStrictEqual(report.changed, []);
    assert.strictEqual(report.checked, 2);
  });

  await checkAsync('a deleted file is reported as missing', async () => {
    const root = await makeDir({ 'a.txt': 'a', 'b.txt': 'b' });
    const manifest = await buildManifest(root);
    await fsp.rm(path.join(root, 'b.txt'));
    const report = await verifyManifest(root, manifest);
    assert.strictEqual(report.ok, false);
    assert.deepStrictEqual(report.missing, ['b.txt']);
  });

  await checkAsync('a modified file is reported as changed', async () => {
    const root = await makeDir({ 'a.txt': 'original' });
    const manifest = await buildManifest(root);
    await flush();
    await fsp.writeFile(path.join(root, 'a.txt'), 'replaced-with-more-content');
    const report = await verifyManifest(root, manifest);
    assert.strictEqual(report.ok, false);
    assert.deepStrictEqual(report.changed, ['a.txt']);
  });

  await checkAsync('size-only checks are enough for truncated files', async () => {
    const root = await makeDir({ 'a.bin': 'x'.repeat(1000) });
    const manifest = await buildManifest(root);
    await flush();
    await fsp.writeFile(path.join(root, 'a.bin'), 'x'.repeat(10));
    const bySize = await verifyManifest(root, manifest, { checkMtime: false });
    assert.deepStrictEqual(bySize.changed, ['a.bin'], 'size difference detected');
  });

  await checkAsync('an added file shows up as extra without failing the check', async () => {
    const root = await makeDir({ 'a.txt': 'a' });
    const manifest = await buildManifest(root);
    await fsp.writeFile(path.join(root, 'new.txt'), 'new');
    const report = await verifyManifest(root, manifest);
    assert.strictEqual(report.ok, true, 'extra files do not invalidate the manifest');
    assert.deepStrictEqual(report.extra, ['new.txt']);
  });

  await checkAsync('checks can be relaxed for a specific call', async () => {
    const root = await makeDir({ 'a.txt': 'a' });
    const manifest = await buildManifest(root);
    await flush();
    await fsp.writeFile(path.join(root, 'a.txt'), 'ab');
    const strict = await verifyManifest(root, manifest);
    assert.strictEqual(strict.ok, false);
    const relaxed = await verifyManifest(root, manifest, { checkMtime: false, checkSize: false });
    assert.strictEqual(relaxed.ok, true, 'both checks disabled');
  });

  await checkAsync('verify treats an empty manifest as clean', async () => {
    const root = await makeDir({ 'a.txt': 'a' });
    const report = await verifyManifest(root, { files: [] });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.checked, 0);
  });

  await checkAsync('verify tolerates a malformed manifest', async () => {
    const root = await makeDir({ 'a.txt': 'a' });
    const report = await verifyManifest(root, null);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.checked, 0);
  });

  // ---- persistence ----

  await checkAsync('writeManifest then readManifest round-trips', async () => {
    const root = await makeDir({ 'a.txt': 'hello' });
    const manifest = await buildManifest(root);
    const file = await writeManifest(root, manifest);
    assert.strictEqual(path.basename(file), MANIFEST_FILENAME);

    const loaded = await readManifest(root);
    assert.deepStrictEqual(loaded.files, manifest.files);
  });

  await checkAsync('readManifest returns null when absent or corrupt', async () => {
    const root = await makeDir({ 'a.txt': 'a' });
    assert.strictEqual(await readManifest(root), null);

    await fsp.writeFile(path.join(root, MANIFEST_FILENAME), '{not json');
    assert.strictEqual(await readManifest(root), null);

    await fsp.writeFile(path.join(root, MANIFEST_FILENAME), '{"files":"nope"}');
    assert.strictEqual(await readManifest(root), null);
  });

  await checkAsync('ensureManifest creates on first call and confirms after', async () => {
    const root = await makeDir({ 'a.txt': 'a', 'sub/b.txt': 'b' });

    const first = await ensureManifest(root);
    assert.strictEqual(first.status, 'created');
    assert.ok(await readManifest(root), 'manifest written');

    const second = await ensureManifest(root);
    assert.strictEqual(second.status, 'ok');
    assert.strictEqual(second.report.ok, true);
  });

  await checkAsync('ensureManifest reports a mismatch and clears the manifest', async () => {
    const root = await makeDir({ 'a.txt': 'original' });
    await ensureManifest(root);

    await flush();
    await fsp.writeFile(path.join(root, 'a.txt'), 'tampered-content-here');

    const result = await ensureManifest(root);
    assert.strictEqual(result.status, 'mismatch');
    assert.deepStrictEqual(result.report.changed, ['a.txt']);
    assert.strictEqual(await readManifest(root), null, 'stale manifest removed so it can rebuild');

    const rebuilt = await ensureManifest(root);
    assert.strictEqual(rebuilt.status, 'created');
  });

  await checkAsync('ensureManifest ignores its own manifest file when verifying', async () => {
    const root = await makeDir({ 'a.txt': 'a' });
    await ensureManifest(root);
    const files = await listFiles(root, { filter: (rel) => rel !== MANIFEST_FILENAME });
    assert.deepStrictEqual(files, ['a.txt']);
  });

  await checkAsync('a relocated directory verifies when timestamps are ignored', async () => {
    // Copying a directory rewrites modification times, so a portable check
    // must be based on structure and size rather than mtime.
    const source = await makeDir({ 'a.txt': 'a', 'sub/b.txt': 'b' });
    const manifest = await buildManifest(source);
    const target = await makeDir({ 'a.txt': 'a', 'sub/b.txt': 'b' });

    // Give the copy an unmistakably different timestamp: two directories
    // created in quick succession can share the same millisecond, which would
    // otherwise let the strict comparison pass by accident.
    const bumped = Date.now() / 1000 + 120;
    await fsp.utimes(path.join(target, 'a.txt'), bumped, bumped);
    await fsp.utimes(path.join(target, 'sub', 'b.txt'), bumped, bumped);

    const strict = await verifyManifest(target, manifest);
    assert.strictEqual(strict.ok, false, 'timestamps differ after the copy');

    const portable = await verifyManifest(target, manifest, { checkMtime: false });
    assert.strictEqual(portable.ok, true, 'relative paths plus size make it portable');
    assert.deepStrictEqual(portable.missing, []);
    assert.deepStrictEqual(portable.changed, []);
  });

  await checkAsync('a relocated copy still detects a size change', async () => {
    const source = await makeDir({ 'a.txt': 'a' });
    const manifest = await buildManifest(source);
    const target = await makeDir({ 'a.txt': 'much longer content' });
    const report = await verifyManifest(target, manifest, { checkMtime: false });
    assert.strictEqual(report.ok, false, 'truncation and replacement remain detectable');
    assert.deepStrictEqual(report.changed, ['a.txt']);
  });

  // ---- report ----
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  console.log(`\nASSET_INTEGRITY_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
