'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const cloud = require('./cloud-sync');

const PACK = { version: 1, soft: 'OpenBrowser', createdAt: '2026-01-01T00:00:00.000Z', profiles: [], groups: [], proxies: [], settings: {} };
const plaintextJson = Buffer.from(JSON.stringify(PACK), 'utf8');
const plaintextGz = zlib.gzipSync(plaintextJson);
const encrypted = cloud.encryptPayload(plaintextGz, 'correct-horse-battery');
assert.strictEqual(encrypted.encrypted, true);

async function expectReject(fn, code, label) {
  await assert.rejects(fn, (error) => {
    assert.strictEqual(error.code, code, `${label}: expected ${code}, got ${error.code} (${error.message})`);
    return true;
  });
}

async function main() {
  assert.throws(() => cloud.safeRemotePath('../outside.obpack'));
  assert.throws(() => cloud.safeRemotePath('/tmp/outside.obpack'));
  assert.throws(() => cloud.safeRemotePath('C:\\outside.obpack'));
  assert.strictEqual(cloud.safeRemotePath('profiles/env-1.obpack'), 'profiles/env-1.obpack');
  console.log('  PASS  remote backup path traversal rejected');

  assert.throws(() => cloud.webDavTarget({ url: 'http://example.com/dav', dir: 'OpenBrowser' }));
  assert.throws(() => cloud.webDavTarget({ url: 'https://example.com/dav', dir: '../outside' }));
  assert.ok(cloud.webDavTarget({ url: 'http://127.0.0.1:9000/dav', dir: 'OpenBrowser' }).target.startsWith('http://127.0.0.1:9000/'));
  console.log('  PASS  WebDAV requires HTTPS except loopback');

  assert.throws(() => cloud.validatedGitHubConfig({ owner: '../x', repo: 'repo', token: 't' }, cloud.REMOTE_NAME));
  assert.throws(() => cloud.validatedGitHubConfig({ owner: 'owner', repo: 'repo', token: 't', branch: '../main' }, cloud.REMOTE_NAME));
  console.log('  PASS  GitHub repository and branch validation');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-cloud-'));
  try {
    assert.throws(() => cloud.safeLocalTarget(root, '../../outside.obpack'));
    if (process.platform !== 'win32') {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-cloud-outside-'));
      const link = path.join(root, 'profiles');
      await fs.symlink(outside, link);
      await assert.rejects(() => cloud.upload('local', { dir: root }, Buffer.from('x'), 'profiles/env.obpack'));
      await fs.rm(outside, { recursive: true, force: true });
    }
    console.log('  PASS  local backup symlink escape rejected');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  // Passphrase set => plaintext packages (raw JSON and gzip) must not downgrade the contract.
  await expectReject(() => cloud.parseBackupPackage(plaintextJson, 'correct-horse-battery'), 'BACKUP_PLAINTEXT_REJECTED', 'raw JSON with passphrase');
  await expectReject(() => cloud.parseBackupPackage(plaintextGz, 'correct-horse-battery'), 'BACKUP_PLAINTEXT_REJECTED', 'gzip without passphrase header');
  console.log('  PASS  passphrase set rejects plaintext JSON and plaintext gzip backups');

  // Legacy behaviour: no passphrase, plaintext (raw or gzip) still restores.
  assert.deepStrictEqual(await cloud.parseBackupPackage(plaintextJson), PACK);
  assert.deepStrictEqual(await cloud.parseBackupPackage(plaintextGz), PACK);
  console.log('  PASS  plaintext backups still restore when no passphrase is configured');

  // Encrypted path still round-trips.
  assert.deepStrictEqual(await cloud.parseBackupPackage(encrypted.data, 'correct-horse-battery'), PACK);
  console.log('  PASS  encrypted package round-trips with the right passphrase');

  // Missing passphrase for an encrypted pack is a clear, non-auth error.
  await assert.rejects(() => cloud.parseBackupPackage(encrypted.data, ''), /请填写恢复密码/);
  console.log('  PASS  encrypted package without passphrase asks for the passphrase');

  // Wrong passphrase and tampering are rejected as auth failures that keep the cause.
  await assert.rejects(() => cloud.parseBackupPackage(encrypted.data, 'wrong-passphrase'), (error) => {
    assert.strictEqual(error.code, 'BACKUP_DECRYPT_FAILED');
    assert.ok(error.cause instanceof Error, 'decrypt failure must keep the GCM cause');
    assert.ok(/密码不正确|损坏|篡改/.test(error.message));
    return true;
  });
  const tampered = Buffer.from(encrypted.data);
  tampered[tampered.length - 1] ^= 0xff;
  await expectReject(() => cloud.parseBackupPackage(tampered, 'correct-horse-battery'), 'BACKUP_DECRYPT_FAILED', 'tampered ciphertext');
  console.log('  PASS  wrong passphrase and tampered ciphertext fail closed with cause');

  // Truncated OBE1 header is reported as truncation, not as a plaintext parse attempt.
  await expectReject(() => cloud.parseBackupPackage(encrypted.data.subarray(0, 20), 'correct-horse-battery'), 'BACKUP_TRUNCATED', 'truncated OBE1 header');
  console.log('  PASS  truncated OBE1 header rejected as truncated');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
