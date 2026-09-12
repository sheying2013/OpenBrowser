'use strict';

/**
 * Self-test for the zip reader and crx reader.
 * Archives and packages are synthesised byte-by-byte so the test is offline
 * and independent of any external fixture.
 */

const assert = require('assert');
const zlib = require('zlib');
const crypto = require('crypto');

const zipReader = require('./zip-reader');
const {
  crc32, buildZip, writeVarint, pbLengthDelimited, pbMessage, buildCrx2, buildCrx3, expectedExtensionId,
} = require('./crx-fixtures');
const crxReader = require('./crx-reader');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

// ---------- fixtures ----------

const FAKE_KEY = crypto.randomBytes(294); // plausible DER length
const FAKE_SIG = crypto.randomBytes(256);
const CRX_ID_BYTES = crypto.createHash('sha256').update(FAKE_KEY).digest().slice(0, 16);

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'Example Extension',
  version: '2.4.1',
  description: 'fixture',
});

const SAMPLE_ZIP = buildZip([
  { name: 'manifest.json', data: MANIFEST, method: 'deflate' },
  { name: 'scripts/content.js', data: 'console.log(1);', method: 'deflate' },
  { name: 'assets/raw.bin', data: Buffer.from([0, 1, 2, 3, 4]), method: 'store' },
]);

// ---------- zip reader ----------

check('zip reader enumerates every entry', () => {
  const archive = zipReader.open(SAMPLE_ZIP);
  const names = archive.entries.map((e) => e.name).sort();
  assert.deepStrictEqual(names, ['assets/raw.bin', 'manifest.json', 'scripts/content.js']);
});

check('zip reader inflates deflate entries', () => {
  const archive = zipReader.open(SAMPLE_ZIP);
  assert.strictEqual(archive.readText('manifest.json'), MANIFEST);
  assert.strictEqual(archive.readText('scripts/content.js'), 'console.log(1);');
});

check('zip reader reads stored entries byte-exact', () => {
  const archive = zipReader.open(SAMPLE_ZIP);
  assert.deepStrictEqual([...archive.read('assets/raw.bin')], [0, 1, 2, 3, 4]);
});

check('zip reader parses json entries', () => {
  const archive = zipReader.open(SAMPLE_ZIP);
  assert.strictEqual(archive.readJson('manifest.json').version, '2.4.1');
});

check('zip reader reports missing entries', () => {
  const archive = zipReader.open(SAMPLE_ZIP);
  assert.strictEqual(archive.has('manifest.json'), true);
  assert.strictEqual(archive.has('nope.txt'), false);
  assert.throws(() => archive.read('nope.txt'), /entry not found/);
});

check('zip reader handles a trailing archive comment', () => {
  const comment = Buffer.from('note', 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 8);
  eocd.writeUInt16LE(0, 10);
  eocd.writeUInt32LE(0, 12);
  eocd.writeUInt32LE(SAMPLE_ZIP.length - 22, 16);
  eocd.writeUInt16LE(comment.length, 20);
  const withComment = Buffer.concat([SAMPLE_ZIP.slice(0, -22), eocd, comment]);
  const archive = zipReader.open(withComment);
  assert.strictEqual(archive.entries.length, 0, 'empty archive still parses');
});

check('zip reader rejects non-zip buffers', () => {
  assert.throws(() => zipReader.open(Buffer.alloc(8)), /too small|not found/);
  assert.throws(() => zipReader.open(Buffer.alloc(64)), /not found/);
});

check('zip reader rejects zip64 markers', () => {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(10, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  assert.throws(() => zipReader.readEntries(eocd), /zip64/);
});

// ---------- crx header parsing ----------

check('crx reader derives the extension id from the signing key', () => {
  const id = crxReader.extensionIdFromPublicKey(FAKE_KEY);
  assert.strictEqual(id, expectedExtensionId(FAKE_KEY));
  assert.strictEqual(id.length, 32);
  assert.ok(/^[a-p]{32}$/.test(id), 'id uses only a-p');
});

check('crx reader round-trips id bytes', () => {
  const id = crxReader.extensionIdFromPublicKey(FAKE_KEY);
  const bytes = crxReader.extensionIdToBytes(id);
  assert.deepStrictEqual([...bytes], [...CRX_ID_BYTES]);
  assert.strictEqual(crxReader.extensionIdFromBytes(bytes), id);
});

check('crx reader rejects a bad magic number', () => {
  const bad = Buffer.alloc(32);
  bad.write('NOPE', 0, 'utf8');
  assert.throws(() => crxReader.parseCrx(bad), /not a crx package/);
});

check('crx reader rejects an unsupported container version', () => {
  const bad = Buffer.alloc(32);
  bad.write('Cr24', 0, 'utf8');
  bad.writeUInt32LE(9, 4);
  assert.throws(() => crxReader.parseCrx(bad), /unsupported crx version/);
});

check('crx reader parses a crx2 container', () => {
  const crx = buildCrx2(FAKE_KEY, FAKE_SIG, SAMPLE_ZIP);
  const parsed = crxReader.parseCrx(crx);
  assert.strictEqual(parsed.version, 2);
  assert.deepStrictEqual([...parsed.publicKey], [...FAKE_KEY]);
  assert.deepStrictEqual([...parsed.signature], [...FAKE_SIG]);
  assert.strictEqual(parsed.extensionId, expectedExtensionId(FAKE_KEY));
  assert.deepStrictEqual([...parsed.zipBuffer], [...SAMPLE_ZIP], 'payload extracted intact');
});

check('crx reader parses a crx3 container with rsa proof', () => {
  const crx = buildCrx3(FAKE_KEY, FAKE_SIG, SAMPLE_ZIP, CRX_ID_BYTES);
  const parsed = crxReader.parseCrx(crx);
  assert.strictEqual(parsed.version, 3);
  assert.strictEqual(parsed.algorithm, 'RSA-SHA256');
  assert.deepStrictEqual([...parsed.publicKey], [...FAKE_KEY]);
  assert.deepStrictEqual([...parsed.signature], [...FAKE_SIG]);
  assert.strictEqual(parsed.extensionId, expectedExtensionId(FAKE_KEY));
  assert.deepStrictEqual([...parsed.zipBuffer], [...SAMPLE_ZIP]);
});

check('crx reader parses a crx3 container with ecdsa proof', () => {
  const crx = buildCrx3(FAKE_KEY, FAKE_SIG, SAMPLE_ZIP, CRX_ID_BYTES, true);
  const parsed = crxReader.parseCrx(crx);
  assert.strictEqual(parsed.algorithm, 'ecdsa-with-SHA256');
  assert.strictEqual(parsed.extensionId, expectedExtensionId(FAKE_KEY));
});

check('crx reader reads the manifest and version from the payload', () => {
  const crx = buildCrx3(FAKE_KEY, FAKE_SIG, SAMPLE_ZIP, CRX_ID_BYTES);
  const parsed = crxReader.parseCrx(crx);
  const manifest = crxReader.readManifest(parsed.zipBuffer);
  assert.strictEqual(manifest.name, 'Example Extension');
  assert.strictEqual(crxReader.readVersion(parsed.zipBuffer), '2.4.1');
  assert.strictEqual(crxReader.readVersion(Buffer.from('not a zip')), null);
});

check('crx reader lists and extracts payload files', () => {
  const crx = buildCrx3(FAKE_KEY, FAKE_SIG, SAMPLE_ZIP, CRX_ID_BYTES);
  const parsed = crxReader.parseCrx(crx);
  const names = crxReader.listFiles(parsed.zipBuffer).map((e) => e.name).sort();
  assert.deepStrictEqual(names, ['assets/raw.bin', 'manifest.json', 'scripts/content.js']);
  assert.strictEqual(crxReader.readFile(parsed.zipBuffer, 'scripts/content.js').toString(), 'console.log(1);');
  assert.throws(() => crxReader.readFile(parsed.zipBuffer, 'missing.js'), /file not found/);
});

// ---------- validation ----------

check('validate accepts a matching extension id', () => {
  const crx = buildCrx3(FAKE_KEY, FAKE_SIG, SAMPLE_ZIP, CRX_ID_BYTES);
  const id = expectedExtensionId(FAKE_KEY);
  const res = crxReader.validate(crx, id);
  assert.strictEqual(res.success, true, res.errorMessage);
});

check('validate rejects a mismatched extension id', () => {
  const crx = buildCrx3(FAKE_KEY, FAKE_SIG, SAMPLE_ZIP, CRX_ID_BYTES);
  const res = crxReader.validate(crx, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.strictEqual(res.success, false);
  assert.ok(/mismatch/.test(res.errorMessage));
});

check('validate rejects a forged declared id', () => {
  const wrongId = crypto.randomBytes(16);
  const crx = buildCrx3(FAKE_KEY, FAKE_SIG, SAMPLE_ZIP, wrongId);
  const res = crxReader.validate(crx, null);
  assert.strictEqual(res.success, false);
  assert.ok(/does not match signing key/.test(res.errorMessage));
});

check('validate reports malformed packages without throwing', () => {
  const res = crxReader.validate(Buffer.alloc(4), null);
  assert.strictEqual(res.success, false);
  assert.ok(res.errorMessage.length > 0);
});

check('signature payload exposes verification inputs', () => {
  const crx = buildCrx3(FAKE_KEY, FAKE_SIG, SAMPLE_ZIP, CRX_ID_BYTES);
  const parsed = crxReader.parseCrx(crx);
  const payload = crxReader.signaturePayload(parsed);
  assert.strictEqual(payload.algorithm, 'RSA-SHA256');
  assert.deepStrictEqual([...payload.publicKey], [...FAKE_KEY]);
  assert.deepStrictEqual([...payload.signature], [...FAKE_SIG]);
  assert.ok(Buffer.isBuffer(payload.crxIdDigest));
});

check('manifest key is injected only when absent', () => {
  const filled = crxReader.withManifestKey({ version: '1.0' }, FAKE_KEY);
  assert.strictEqual(filled.key, FAKE_KEY.toString('base64'));
  const kept = crxReader.withManifestKey({ version: '1.0', key: 'existing' }, FAKE_KEY);
  assert.strictEqual(kept.key, 'existing');
});

check('protobuf decoder reads nested fields', () => {
  const inner = pbLengthDelimited(1, Buffer.from('hi'));
  const outer = pbLengthDelimited(4, inner);
  const fields = crxReader.decodeProtobuf(outer);
  assert.strictEqual(fields.length, 1);
  assert.strictEqual(fields[0].field, 4);
  const nested = crxReader.decodeProtobuf(fields[0].data);
  assert.strictEqual(nested[0].data.toString(), 'hi');
});

check('protobuf decoder rejects truncated input', () => {
  const truncated = Buffer.from([0x0a, 0x7f, 0x01]); // claims 127 bytes, provides 1
  assert.throws(() => crxReader.decodeProtobuf(truncated), /truncated/);
});

// ---------- report ----------
(async () => {
  await checkAsync('async placeholder', async () => {});
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  console.log(`\nCRX_READER_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
