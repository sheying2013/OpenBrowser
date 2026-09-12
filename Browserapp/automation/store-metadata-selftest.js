'use strict';

/**
 * Extension metadata read straight out of a package.
 *
 * The host used to write the downloaded package to a temporary file and shell
 * out to an external unpacker to read two entries from it. The package is now
 * read in memory, and the signed id is checked before anything is cached under
 * the requested store entry.
 *
 * Packages are synthesised here, so the test needs no network and no fixtures.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { buildZip, buildCrx3, expectedExtensionId } = require('./crx-fixtures');
const { parseCrx, readManifest, readFile } = require('./crx-reader');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const MANIFEST = {
  manifest_version: 3,
  name: 'Example Extension',
  version: '1.4.2',
  description: 'fixture description',
  icons: { 16: 'icons/icon16.png', 128: 'icons/icon128.png' },
};
const ICON_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function makePackage({ withIcon = true } = {}) {
  const publicKey = crypto.randomBytes(294);
  const signature = crypto.randomBytes(256);
  const idBytes = crypto.createHash('sha256').update(publicKey).digest().slice(0, 16);
  const files = [{ name: 'manifest.json', data: JSON.stringify(MANIFEST), method: 'store' }];
  if (withIcon) {
    files.push({ name: 'icons/icon16.png', data: Buffer.from([9, 9]) });
    files.push({ name: 'icons/icon128.png', data: ICON_BYTES });
  }
  const zip = buildZip(files);
  return { crx: buildCrx3(publicKey, signature, zip, idBytes), publicKey, storeId: expectedExtensionId(publicKey) };
}

// ---------- reading the package in memory ----------
{
  const pkg = makePackage();

  check('the signed id of a package is derivable from its key', () => {
    assert.strictEqual(parseCrx(pkg.crx).extensionId, pkg.storeId);
    assert.strictEqual(pkg.storeId.length, 32);
  });

  check('the manifest is read without unpacking to disk', () => {
    const parsed = parseCrx(pkg.crx);
    const manifest = readManifest(parsed.zipBuffer);
    assert.strictEqual(manifest.name, MANIFEST.name);
    assert.strictEqual(manifest.version, MANIFEST.version);
    assert.strictEqual(manifest.description, MANIFEST.description);
  });

  check('the largest declared icon is readable byte-exact', () => {
    const parsed = parseCrx(pkg.crx);
    const chosen = Object.entries(MANIFEST.icons).sort(([a], [b]) => Number(b) - Number(a))[0][1];
    const image = readFile(parsed.zipBuffer, chosen);
    assert.ok(Buffer.compare(image, ICON_BYTES) === 0, 'icon bytes differ');
  });

  check('a package with no icon still yields a manifest', () => {
    const bare = makePackage({ withIcon: false });
    const parsed = parseCrx(bare.crx);
    const manifest = readManifest(parsed.zipBuffer);
    assert.strictEqual(manifest.name, MANIFEST.name);
    assert.throws(() => readFile(parsed.zipBuffer, 'icons/icon128.png'), /not found/);
  });

  check('a package signed by another key reports a different id', () => {
    const other = makePackage();
    assert.notStrictEqual(parseCrx(other.crx).extensionId, pkg.storeId);
  });

  check('a truncated package is rejected rather than half-read', () => {
    assert.throws(() => parseCrx(pkg.crx.slice(0, 20)));
    assert.throws(() => parseCrx(Buffer.from('not a package')));
  });
}

// ---------- the host wiring ----------
{
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  check('the host reads the package with the in-memory reader', () => {
    assert.ok(/require\('\.\/automation\/crx-reader'\)/.test(source), 'reader is not required');
    assert.ok(/const parsed = parseCrx\(buffer\)/.test(source), 'package is not parsed');
    assert.ok(/readManifest\(parsed\.zipBuffer\)/.test(source), 'manifest is not read from the payload');
    assert.ok(/readFile\(parsed\.zipBuffer, iconPath\)/.test(source), 'icon is not read from the payload');
  });

  check('the signed id is checked before anything is cached', () => {
    const guard = source.indexOf('parsed.extensionId !== safeId');
    const read = source.indexOf('readManifest(parsed.zipBuffer)');
    assert.ok(guard > 0, 'the signed id is not compared with the requested entry');
    assert.ok(read > guard, 'the manifest is read before the id is checked');
    assert.ok(/签名 ID/.test(source), 'the mismatch is not reported to the caller');
  });

  check('the external unpacker is no longer involved', () => {
    assert.ok(!/runArchiveCommand/.test(source), 'an archive command helper is still present');
    assert.ok(!/tar\.exe/.test(source), 'the metadata path still shells out to tar');
  });

  check('no temporary copy of the package is written any more', () => {
    assert.ok(!/metadata-\$\{safeId\}/.test(source), 'a temporary package path is still built');
    assert.ok(!/fsp\.writeFile\(zipFile/.test(source), 'the package is still written to disk');
  });

  check('the previous guards survive the rewrite', () => {
    assert.ok(/iconPath\.split\('\/'\)\.includes\('\.\.'\)/.test(source), 'the traversal guard is gone');
    assert.ok(/image\.length <= 2 \* 1024 \* 1024/.test(source), 'the icon size cap is gone');
  });

  check('the store-page fallback is still reachable', () => {
    assert.ok(/catch \(_\) \{\n    \/\/ CRX download often blocked; fall through to store page scrape/.test(source),
      'the fallback comment/behaviour is gone');
    assert.ok(/fetchChromeStoreIcon\(safeId\)/.test(source), 'the fallback scrape is gone');
  });
}

// ================= report =================
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\nSTORE_METADATA_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${results.filter((r) => r.ok).length}/${results.length}`);
if (failed.length) process.exitCode = 1;
