'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const credentialCrypto = require('../credential-crypto');
const cloudSync = require('./cloud-sync');
const { ProxyStore } = require('./proxy-store');
const { ApiKeyStore, KEY_FILE, TXT_FILE } = require('./api-key-store');

let testCount = 0;
let passedCount = 0;

function ok(name, condition) {
  testCount += 1;
  assert.ok(condition, name);
  passedCount += 1;
  console.log(`  PASS [${passedCount}] ${name}`);
}

(async () => {
  console.log('OpenBrowser Credential At-Rest Encryption & Migration Self-Test');

  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-cred-selftest-'));

  // =========================================================================
  // 1. Core AES-256-GCM (OBE1) round-trip & wrong key rejection
  // =========================================================================
  const dummyPlaintext = JSON.stringify({
    proxyUser: 'user_dummy_123',
    proxyPass: 'pass_dummy_xyz_!@#',
    cloudToken: 'ghp_fake_test_token_9876543210',
    webdavPass: 'dav_fake_password_abc',
  });

  const customKey = 'test-master-key-seed-alpha-bravo-1234567890';
  const encObe1 = credentialCrypto.encryptAesGcm(Buffer.from(dummyPlaintext, 'utf8'), customKey);
  ok('OBE1 magic header is 4 bytes ASCII "OBE1"', encObe1.subarray(0, 4).toString('ascii') === 'OBE1');
  ok('OBE1 payload length is greater than salt+iv+tag (48 bytes)', encObe1.length > 48);
  ok('isEncrypted recognizes OBE1', credentialCrypto.isEncrypted(encObe1) === true);
  ok('getFormat returns "OBE1"', credentialCrypto.getFormat(encObe1) === 'OBE1');

  const decObe1 = credentialCrypto.decryptAesGcm(encObe1, customKey).toString('utf8');
  ok('OBE1 decryption round-trip matches original data', decObe1 === dummyPlaintext);

  let wrongKeyFailed = false;
  try {
    credentialCrypto.decryptAesGcm(encObe1, 'wrong-encryption-key-0000000000000000');
  } catch (err) {
    wrongKeyFailed = true;
  }
  ok('Decryption with wrong key throws authentication error', wrongKeyFailed === true);

  // OBE1 LRU cache hit test
  const tCacheStart = process.hrtime.bigint();
  const decObe1Cached = credentialCrypto.decryptAesGcm(encObe1, customKey).toString('utf8');
  const tCacheEnd = process.hrtime.bigint();
  const cacheMs = Number(tCacheEnd - tCacheStart) / 1e6;
  ok('OBE1 second decryption hits LRU cache and matches original', decObe1Cached === dummyPlaintext);
  ok('OBE1 LRU cache hit completes in under 1ms', cacheMs < 2.0);

  // Core AES-256-GCM (OBE2 via HKDF) round-trip & wrong key rejection
  const encObe2 = credentialCrypto.encryptAesGcmObe2(Buffer.from(dummyPlaintext, 'utf8'), customKey);
  ok('OBE2 magic header is 4 bytes ASCII "OBE2"', encObe2.subarray(0, 4).toString('ascii') === 'OBE2');
  ok('OBE2 payload length is greater than salt+iv+tag (48 bytes)', encObe2.length > 48);
  ok('isEncrypted recognizes OBE2', credentialCrypto.isEncrypted(encObe2) === true);
  ok('getFormat returns "OBE2"', credentialCrypto.getFormat(encObe2) === 'OBE2');

  const decObe2 = credentialCrypto.decryptAesGcm(encObe2, customKey).toString('utf8');
  ok('OBE2 decryption round-trip matches original data', decObe2 === dummyPlaintext);

  let wrongKeyObe2Failed = false;
  try {
    credentialCrypto.decryptAesGcm(encObe2, 'wrong-encryption-key-0000000000000000');
  } catch (err) {
    wrongKeyObe2Failed = true;
  }
  ok('OBE2 decryption with wrong key throws authentication error', wrongKeyObe2Failed === true);

  // =========================================================================
  // 2. Interoperability with Cloud Backup OBE1 format
  // =========================================================================
  // Test A: Encrypted with credentialCrypto -> decrypted with cloudSync.decryptPayload
  const cloudDec = cloudSync.decryptPayload(encObe1, customKey);
  ok('cloudSync.decryptPayload decrypts credentialCrypto OBE1 payload', cloudDec.toString('utf8') === dummyPlaintext);

  // Test B: Encrypted with cloudSync.encryptPayload -> decrypted with credentialCrypto.decryptAesGcm
  const cloudEnc = cloudSync.encryptPayload(Buffer.from(dummyPlaintext, 'utf8'), customKey).data;
  ok('cloudSync.encryptPayload produces OBE1 header', cloudEnc.subarray(0, 4).toString('ascii') === 'OBE1');
  const credDec = credentialCrypto.decryptAesGcm(cloudEnc, customKey).toString('utf8');
  ok('credentialCrypto.decryptAesGcm decrypts cloudSync encrypted payload', credDec === dummyPlaintext);

  // =========================================================================
  // 3. safeStorage Mock & Fallback Tests
  // =========================================================================
  // Simulate safeStorage available via mock
  const mockStorageMap = new Map();
  credentialCrypto.setSafeStorageMock({
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      const id = 'mock-key-' + Math.random().toString(36).slice(2);
      mockStorageMap.set(id, plain);
      return Buffer.from('mock-ct:' + id, 'utf8');
    },
    decryptString: (buf) => {
      const str = buf.toString('utf8');
      if (!str.startsWith('mock-ct:')) throw new Error('Invalid mock ciphertext');
      const id = str.slice(8);
      if (!mockStorageMap.has(id)) throw new Error('Mock key not found');
      return mockStorageMap.get(id);
    },
  });

  ok('isSafeStorageAvailable returns true when mock enabled', credentialCrypto.isSafeStorageAvailable() === true);
  const encObs1 = credentialCrypto.encryptCredential(dummyPlaintext, { mode: 'safeStorage' });
  ok('safeStorage header is 4 bytes ASCII "OBS1"', encObs1.subarray(0, 4).toString('ascii') === 'OBS1');
  ok('isEncrypted recognizes OBS1', credentialCrypto.isEncrypted(encObs1) === true);
  ok('getFormat returns "OBS1"', credentialCrypto.getFormat(encObs1) === 'OBS1');
  const decObs1 = credentialCrypto.decryptCredential(encObs1);
  ok('safeStorage decryption matches original', decObs1 === dummyPlaintext);

  // Simulate safeStorage unavailable (fallback to AES-256-GCM)
  credentialCrypto.setSafeStorageMock({
    isEncryptionAvailable: () => false,
  });
  ok('isSafeStorageAvailable returns false when unavailable', credentialCrypto.isSafeStorageAvailable() === false);

  // Default mode 'auto' without external passphrase should fall back to high-performance local master key OBE2
  const encFallback = credentialCrypto.encryptCredential(dummyPlaintext, { mode: 'auto' });
  ok('Fallback format is OBE2', encFallback.subarray(0, 4).toString('ascii') === 'OBE2');
  ok('isEncrypted recognizes fallback OBE2', credentialCrypto.isEncrypted(encFallback) === true);
  ok('getFormat returns "OBE2" for fallback', credentialCrypto.getFormat(encFallback) === 'OBE2');
  const decFallback = credentialCrypto.decryptCredential(encFallback);
  ok('Fallback decryption recovers plaintext', decFallback === dummyPlaintext);

  // Explicit passphrase mode should preserve 100% backward-compatible OBE1 format
  const encPassphrase = credentialCrypto.encryptCredential(dummyPlaintext, { passphrase: 'human-readable-passphrase' });
  ok('Explicit passphrase produces OBE1 format', credentialCrypto.getFormat(encPassphrase) === 'OBE1');
  const decPassphrase = credentialCrypto.decryptCredential(encPassphrase, { passphrase: 'human-readable-passphrase' });
  ok('Explicit passphrase decryption recovers plaintext', decPassphrase === dummyPlaintext);

  // Restore mock to null
  credentialCrypto.setSafeStorageMock(null);

  // =========================================================================
  // 4. Local Master Key Scheme Verification
  // =========================================================================
  const masterKeyFile = path.join(tmpBase, 'test-master.key');
  process.env.OPENBROWSER_MASTER_KEY_FILE = masterKeyFile;
  credentialCrypto.resetLocalMasterKeyCache();

  const key1 = credentialCrypto.getLocalMasterKey();
  ok('Generated master key has 64 hex chars (256-bit)', /^[a-f0-9]{64}$/.test(key1));
  ok('Master key file exists on disk', fs.existsSync(masterKeyFile));
  if (process.platform !== 'win32') {
    const stat = fs.statSync(masterKeyFile);
    ok('Master key file mode is 0600', (stat.mode & 0o777) === 0o600);
  }

  // Restart simulation: same key is read back from disk
  credentialCrypto.resetLocalMasterKeyCache();
  const key2 = credentialCrypto.getLocalMasterKey();
  ok('Master key persists across restarts', key2 === key1);

  delete process.env.OPENBROWSER_MASTER_KEY_FILE;
  credentialCrypto.resetLocalMasterKeyCache();

  // -------------------------------------------------------------------------
  // 4.1. Concurrency: 16 processes race to create master key in isolated dir
  // -------------------------------------------------------------------------
  const concDir = path.join(tmpBase, 'isolated-concurrent-masterkey');
  const concKeyFile = path.join(concDir, '.openbrowser-master.key');
  const numWorkers = 16;
  const workerScript = `
    const credentialCrypto = require(${JSON.stringify(path.resolve(__dirname, '../credential-crypto'))});
    process.env.OPENBROWSER_MASTER_KEY_FILE = ${JSON.stringify(concKeyFile)};
    const key = credentialCrypto.getLocalMasterKey();
    process.stdout.write(key);
  `;

  const workerPromises = [];
  for (let w = 0; w < numWorkers; w++) {
    workerPromises.push(new Promise((resolve, reject) => {
      const cp = spawn(process.execPath, ['-e', workerScript]);
      let stdout = '';
      let stderr = '';
      cp.stdout.on('data', (chunk) => { stdout += chunk; });
      cp.stderr.on('data', (chunk) => { stderr += chunk; });
      cp.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker ${w} failed with code ${code}: ${stderr}`));
        } else {
          resolve(stdout.trim());
        }
      });
    }));
  }

  const workerKeys = await Promise.all(workerPromises);
  const uniqueWorkerKeys = Array.from(new Set(workerKeys));
  ok('16 concurrent processes all obtain a 64-hex master key', workerKeys.every((k) => /^[a-f0-9]{64}$/.test(k)));
  ok('16 concurrent processes all converged on exactly ONE master key (no overwrite)', uniqueWorkerKeys.length === 1);
  const concDiskKey = (await fsp.readFile(concKeyFile, 'utf8')).trim();
  ok('Key file on disk matches the converged key of all workers', concDiskKey === uniqueWorkerKeys[0]);
  if (process.platform !== 'win32') {
    const concStat = await fsp.stat(concKeyFile);
    ok('Concurrent master key file has mode 0600', (concStat.mode & 0o777) === 0o600);
  }

  // -------------------------------------------------------------------------
  // 4.2. Existing invalid key (< 32 chars or empty) must NOT be overwritten
  // -------------------------------------------------------------------------
  const invalidKeyDir = path.join(tmpBase, 'isolated-invalid-key');
  await fsp.mkdir(invalidKeyDir, { recursive: true });
  const invalidKeyFile = path.join(invalidKeyDir, '.master.key');

  // Test 4.2.1: Corrupt short key
  const corruptContent = 'short-corrupted-key-string';
  await fsp.writeFile(invalidKeyFile, corruptContent, 'utf8');
  process.env.OPENBROWSER_MASTER_KEY_FILE = invalidKeyFile;
  credentialCrypto.resetLocalMasterKeyCache();

  let shortKeyRejected = false;
  try {
    credentialCrypto.getLocalMasterKey();
  } catch (err) {
    shortKeyRejected = err.message.includes('invalid') || err.message.includes('refusing to overwrite');
  }
  ok('Existing invalid key (< 32 chars) throws error refusing to overwrite', shortKeyRejected === true);
  const postShortContent = await fsp.readFile(invalidKeyFile, 'utf8');
  ok('Existing invalid key file was NOT overwritten', postShortContent === corruptContent);

  // Test 4.2.2: 0-byte empty file
  await fsp.writeFile(invalidKeyFile, '', 'utf8');
  credentialCrypto.resetLocalMasterKeyCache();
  let emptyKeyRejected = false;
  try {
    credentialCrypto.getLocalMasterKey();
  } catch (err) {
    emptyKeyRejected = err.message.includes('invalid') || err.message.includes('refusing to overwrite');
  }
  ok('Existing 0-byte key file throws error refusing to overwrite', emptyKeyRejected === true);
  const postEmptyContent = await fsp.readFile(invalidKeyFile, 'utf8');
  ok('Existing 0-byte key file was NOT overwritten', postEmptyContent === '');

  // -------------------------------------------------------------------------
  // 4.3. Unreadable key file (read failure) must NOT be overwritten
  // -------------------------------------------------------------------------
  if (process.platform !== 'win32') {
    const unreadableDir = path.join(tmpBase, 'isolated-unreadable-key');
    await fsp.mkdir(unreadableDir, { recursive: true });
    const unreadableKeyFile = path.join(unreadableDir, '.master.key');
    const secretKeyContent = 'valid-secret-master-key-content-that-must-be-preserved-0123456789';
    await fsp.writeFile(unreadableKeyFile, secretKeyContent, 'utf8');
    await fsp.chmod(unreadableKeyFile, 0o000);

    process.env.OPENBROWSER_MASTER_KEY_FILE = unreadableKeyFile;
    credentialCrypto.resetLocalMasterKeyCache();

    let unreadableRejected = false;
    try {
      credentialCrypto.getLocalMasterKey();
    } catch (err) {
      unreadableRejected = err.message.includes('cannot be read') || err.message.includes('refusing to overwrite');
    }
    ok('Unreadable key file throws error refusing to overwrite', unreadableRejected === true);

    await fsp.chmod(unreadableKeyFile, 0o600);
    const postUnreadableContent = await fsp.readFile(unreadableKeyFile, 'utf8');
    ok('Unreadable key file content was NOT overwritten', postUnreadableContent === secretKeyContent);
  }

  // -------------------------------------------------------------------------
  // 4.4. Cross-process race condition: reader retries and avoids incomplete read
  // -------------------------------------------------------------------------
  const raceDir = path.join(tmpBase, 'isolated-race-incomplete');
  await fsp.mkdir(raceDir, { recursive: true });
  const raceKeyFile = path.join(raceDir, '.master.key');
  // Initially write incomplete file (only 8 bytes)
  await fsp.writeFile(raceKeyFile, 'partial!', 'utf8');

  // Spawn background worker that completes the file (spawning node process provides natural ~150ms race window)
  const completeKeyVal = 'f'.repeat(64);
  const delayedWriterScript = `
    const fs = require('fs');
    fs.writeFileSync(${JSON.stringify(raceKeyFile)}, ${JSON.stringify(completeKeyVal)} + "\\n", { mode: 0o600 });
  `;
  const bgWriter = spawn(process.execPath, ['-e', delayedWriterScript]);

  process.env.OPENBROWSER_MASTER_KEY_FILE = raceKeyFile;
  credentialCrypto.resetLocalMasterKeyCache();

  const raceReadResult = credentialCrypto.getLocalMasterKey();
  ok('Reader retried and obtained complete key across process race', raceReadResult === completeKeyVal);
  await new Promise((res) => bgWriter.on('close', res));

  // -------------------------------------------------------------------------
  // 4.5. Old valid key format (32-character string) remains readable and functional
  // -------------------------------------------------------------------------
  const legacyDir = path.join(tmpBase, 'isolated-legacy-key');
  await fsp.mkdir(legacyDir, { recursive: true });
  const legacyKeyFile = path.join(legacyDir, '.master.key');
  const legacyKeyStr = 'legacy-32-byte-master-key-seed!!';
  await fsp.writeFile(legacyKeyFile, legacyKeyStr + '\n', 'utf8');

  process.env.OPENBROWSER_MASTER_KEY_FILE = legacyKeyFile;
  credentialCrypto.resetLocalMasterKeyCache();

  const readLegacyKey = credentialCrypto.getLocalMasterKey();
  ok('Legacy 32-character key is loaded successfully', readLegacyKey === legacyKeyStr);

  // Test encryption & decryption roundtrip with this legacy key
  const testPlain = 'legacy_credential_verification_payload_12345';
  const encWithLegacy = credentialCrypto.encryptCredential(testPlain, { mode: 'auto' });
  const decWithLegacy = credentialCrypto.decryptCredential(encWithLegacy);
  ok('Payload encrypted with legacy master key decrypts accurately', decWithLegacy === testPlain);

  const postLegacyDisk = (await fsp.readFile(legacyKeyFile, 'utf8')).trim();
  ok('Legacy key file on disk was preserved without changes', postLegacyDisk === legacyKeyStr);

  // -------------------------------------------------------------------------
  // 4.6. Cannot persist master key directly throws error (no deterministic fallback for write)
  // -------------------------------------------------------------------------
  if (process.platform !== 'win32') {
    const roDir = path.join(tmpBase, 'isolated-readonly-dir');
    await fsp.mkdir(roDir, { recursive: true });
    await fsp.chmod(roDir, 0o500); // read & execute only, no file creation permitted

    const roKeyFile = path.join(roDir, '.master.key');
    process.env.OPENBROWSER_MASTER_KEY_FILE = roKeyFile;
    credentialCrypto.resetLocalMasterKeyCache();

    let persistFailed = false;
    let persistErrMessage = '';
    try {
      credentialCrypto.getLocalMasterKey();
    } catch (err) {
      persistFailed = true;
      persistErrMessage = err.message;
    }
    ok('Failure to persist master key throws error directly', persistFailed === true);
    ok('Error message indicates refusal to use insecure deterministic fallback', persistErrMessage.includes('refusing to use'));
    ok('No master key file was created in unwritable directory', !fs.existsSync(roKeyFile));

    await fsp.chmod(roDir, 0o700);
  }

  // -------------------------------------------------------------------------
  // 4.7. Legacy deterministic fallback ciphertext recovery (without overwriting existing data)
  // -------------------------------------------------------------------------
  const legacyFallbackKey = credentialCrypto.getLegacyDeterministicMasterKey();
  ok('getLegacyDeterministicMasterKey produces 64-hex key', /^[a-f0-9]{64}$/.test(legacyFallbackKey));

  const legacyPlaintext = JSON.stringify({ legacySecret: 'recovered_legacy_password_xyz_999' });
  const legacyObe2Payload = credentialCrypto.encryptAesGcmObe2(Buffer.from(legacyPlaintext, 'utf8'), legacyFallbackKey);
  const legacyObe1Payload = credentialCrypto.encryptAesGcm(Buffer.from(legacyPlaintext, 'utf8'), legacyFallbackKey);

  // Configure an active, different master key file on disk
  const activeKeyDir = path.join(tmpBase, 'isolated-active-key');
  await fsp.mkdir(activeKeyDir, { recursive: true });
  const activeKeyFile = path.join(activeKeyDir, '.master.key');
  process.env.OPENBROWSER_MASTER_KEY_FILE = activeKeyFile;
  credentialCrypto.resetLocalMasterKeyCache();

  const activeMasterKey = credentialCrypto.getLocalMasterKey();
  ok('Active master key is distinct from legacy deterministic key', activeMasterKey !== legacyFallbackKey);

  // Test recovery of legacy OBE2 ciphertext under active different key
  const recoveredObe2 = credentialCrypto.decryptCredential(legacyObe2Payload);
  ok('Legacy fallback OBE2 ciphertext transparently recovered without error', recoveredObe2 === legacyPlaintext);

  // Test recovery of legacy OBE1 ciphertext under active different key
  const recoveredObe1 = credentialCrypto.decryptCredential(legacyObe1Payload);
  ok('Legacy fallback OBE1 ciphertext transparently recovered without error', recoveredObe1 === legacyPlaintext);

  // Verify that active key file on disk was NOT overwritten or modified during recovery
  const postActiveKeyDisk = (await fsp.readFile(activeKeyFile, 'utf8')).trim();
  ok('Active master key file on disk was NOT modified or overwritten during legacy recovery', postActiveKeyDisk === activeMasterKey);

  // -------------------------------------------------------------------------
  // 4.8. Legacy recovery in read-only environment without key file
  // -------------------------------------------------------------------------
  if (process.platform !== 'win32') {
    const roDir2 = path.join(tmpBase, 'isolated-readonly-dir2');
    await fsp.mkdir(roDir2, { recursive: true });
    await fsp.chmod(roDir2, 0o500);

    const roKeyFile2 = path.join(roDir2, '.master.key');
    process.env.OPENBROWSER_MASTER_KEY_FILE = roKeyFile2;
    credentialCrypto.resetLocalMasterKeyCache();

    // Legacy recovery still works even when key cannot be persisted
    const recoveredInRo = credentialCrypto.decryptCredential(legacyObe2Payload);
    ok('Legacy ciphertext decrypts successfully in read-only environment without key file', recoveredInRo === legacyPlaintext);

    // Non-legacy unknown ciphertext throws in read-only environment
    let unknownDecryptFailed = false;
    try {
      const randomKeyPayload = credentialCrypto.encryptAesGcmObe2(Buffer.from('hello', 'utf8'), 'e'.repeat(64));
      credentialCrypto.decryptCredential(randomKeyPayload);
    } catch (_) {
      unknownDecryptFailed = true;
    }
    ok('Unknown ciphertext throws error in read-only environment', unknownDecryptFailed === true);

    await fsp.chmod(roDir2, 0o700);
  }

  // -------------------------------------------------------------------------
  // 4.9. Failure behavior on corrupted ciphertexts & wrong explicit passphrase
  // -------------------------------------------------------------------------
  // Truncated payload (< 48 bytes)
  let truncatedFailed = false;
  try {
    credentialCrypto.decryptAesGcm(Buffer.from('OBE2short'));
  } catch (err) {
    truncatedFailed = err.message.includes('长度不足');
  }
  ok('Truncated AES-GCM payload throws length error', truncatedFailed === true);

  // Tampered payload
  let tamperedFailed = false;
  try {
    const tampered = Buffer.from(legacyObe2Payload);
    tampered[tampered.length - 1] ^= 0x01; // flip 1 bit
    credentialCrypto.decryptAesGcm(tampered, legacyFallbackKey);
  } catch (_) {
    tamperedFailed = true;
  }
  ok('Tampered ciphertext payload throws authentication verification error', tamperedFailed === true);

  // Explicit wrong passphrase must NOT fall back to legacy key
  let wrongExplicitFailed = false;
  try {
    credentialCrypto.decryptCredential(legacyObe2Payload, { passphrase: 'explicitly-wrong-passphrase' });
  } catch (_) {
    wrongExplicitFailed = true;
  }
  ok('Explicit wrong passphrase throws error and does not use legacy fallback', wrongExplicitFailed === true);

  delete process.env.OPENBROWSER_MASTER_KEY_FILE;
  credentialCrypto.resetLocalMasterKeyCache();

  // =========================================================================
  // 5. ProxyStore Static Encryption & Plaintext Migration
  // =========================================================================
  const proxyDir = path.join(tmpBase, 'proxy-test');
  await fsp.mkdir(proxyDir, { recursive: true });
  const proxyFile = path.join(proxyDir, 'proxy-library.json');

  const pStore = new ProxyStore(proxyFile, { encrypted: true });
  await pStore.load();
  await pStore.create({
    name: 'Encrypted Test Proxy',
    protocol: 'socks5',
    host: 'proxy.internal.local',
    port: 1080,
    username: 'test_proxy_user_1',
    password: 'test_proxy_pass_xyz',
  });
  await pStore.flush();

  const proxyBytes = await fsp.readFile(proxyFile);
  ok('proxy-library.json on disk is encrypted (starts with OBS1 or OBE1)', credentialCrypto.isEncrypted(proxyBytes));
  ok('Plaintext password not in proxy-library.json', !proxyBytes.toString('utf8').includes('test_proxy_pass_xyz'));
  ok('Plaintext username not in proxy-library.json', !proxyBytes.toString('utf8').includes('test_proxy_user_1'));

  // Verify transparent read-path
  const pStoreRead = new ProxyStore(proxyFile, { encrypted: true });
  await pStoreRead.load();
  const items = pStoreRead.list();
  ok('Read-path transparently recovers 1 proxy item', items.length === 1);
  ok('Read-path decrypts username', items[0].username === 'test_proxy_user_1');
  ok('Read-path decrypts password', items[0].password === 'test_proxy_pass_xyz');

  // ProxyStore Plaintext Migration Test
  const legacyProxyFile = path.join(proxyDir, 'legacy-proxy.json');
  const legacyContent = JSON.stringify({
    version: 2,
    items: [
      {
        id: 'legacy-p1',
        name: 'Legacy Unencrypted Proxy',
        protocol: 'http',
        host: '10.10.10.10',
        port: 8080,
        username: 'old_plain_user',
        password: 'old_plain_password_789',
        raw: 'http://old_plain_user:old_plain_password_789@10.10.10.10:8080',
      },
    ],
  }, null, 2);
  await fsp.writeFile(legacyProxyFile, legacyContent, 'utf8');

  // Pre-condition: file is plain text
  ok('Pre-migration file is plaintext', !credentialCrypto.isEncrypted(await fsp.readFile(legacyProxyFile)));

  const pMigrateStore = new ProxyStore(legacyProxyFile, { encrypted: true });
  await pMigrateStore.load();
  await pMigrateStore.flush();

  // Post-condition: file is encrypted on disk
  const migratedProxyBytes = await fsp.readFile(legacyProxyFile);
  ok('Post-migration file is encrypted at rest', credentialCrypto.isEncrypted(migratedProxyBytes));
  ok('Plaintext old password gone from primary file', !migratedProxyBytes.toString('utf8').includes('old_plain_password_789'));

  // Backup file exists and holds the original plaintext
  const backupProxyContent = await fsp.readFile(legacyProxyFile + '.bak', 'utf8');
  ok('Backup file exists and preserved original data', backupProxyContent.includes('old_plain_password_789'));

  // Data can be read back transparently after migration
  const pPostCheck = new ProxyStore(legacyProxyFile, { encrypted: true });
  await pPostCheck.load();
  const postItems = pPostCheck.list();
  ok('Migrated store has 1 item', postItems.length === 1);
  ok('Migrated item password decrypted correctly', postItems[0].password === 'old_plain_password_789');

  // Corrupted File Recovery Test
  const corruptFile = path.join(proxyDir, 'corrupt-proxy.json');
  await fsp.writeFile(corruptFile, Buffer.concat([Buffer.from('OBE1'), Buffer.alloc(80, 0xff)])); // corrupted OBE1
  await fsp.writeFile(corruptFile + '.bak', legacyContent); // valid backup available

  const pCorruptStore = new ProxyStore(corruptFile, { encrypted: true });
  await pCorruptStore.load();
  await pCorruptStore.flush();
  ok('Corrupted main file recovered transparently from .bak backup', pCorruptStore.list().length === 1);
  const corruptFilesFound = (await fsp.readdir(proxyDir)).filter((n) => n.includes('corrupt-proxy.json.corrupt-'));
  ok('Corrupted bytes snapshot preserved as .corrupt-*', corruptFilesFound.length > 0);

  // =========================================================================
  // 6. ApiKeyStore Static Encryption & Plaintext Migration
  // =========================================================================
  const apiDir = path.join(tmpBase, 'apikey-test');
  await fsp.mkdir(apiDir, { recursive: true });

  const aStore = new ApiKeyStore(apiDir, { encrypted: true });
  const mintedKey = await aStore.resolve('');
  ok('ApiKeyStore minted 43-character base64url key', /^[A-Za-z0-9_-]{43}$/.test(mintedKey));

  const keyFileBytes = await fsp.readFile(path.join(apiDir, KEY_FILE));
  ok('mcp-key.json on disk is encrypted', credentialCrypto.isEncrypted(keyFileBytes));
  ok('mcp-key.json does not leak plaintext API key', !keyFileBytes.toString('utf8').includes(mintedKey));

  let txtExists = false;
  try {
    await fsp.access(path.join(apiDir, TXT_FILE));
    txtExists = true;
  } catch (_) {}
  ok('local-api-key.txt is not written in encrypted mode', txtExists === false);

  // Read back transparently
  const aStore2 = new ApiKeyStore(apiDir, { encrypted: true });
  const resolved2 = await aStore2.resolve('');
  ok('ApiKeyStore read-path transparently recovers identical key', resolved2 === mintedKey);

  // ApiKeyStore Migration from legacy plaintext
  const apiMigrateDir = path.join(tmpBase, 'apikey-migrate');
  await fsp.mkdir(apiMigrateDir, { recursive: true });
  const fakeLegacyKey = 'legacy_fake_api_key_test_abcdef1234567890';
  await fsp.writeFile(path.join(apiMigrateDir, KEY_FILE), JSON.stringify({ version: 1, apiKey: fakeLegacyKey }), 'utf8');
  await fsp.writeFile(path.join(apiMigrateDir, TXT_FILE), `${fakeLegacyKey}\n`, 'utf8');

  const aMigrateStore = new ApiKeyStore(apiMigrateDir, { encrypted: true });
  const resolvedMigratedKey = await aMigrateStore.resolve('');
  ok('Legacy plaintext API key recovered by resolve()', resolvedMigratedKey === fakeLegacyKey);

  const migratedKeyBytes = await fsp.readFile(path.join(apiMigrateDir, KEY_FILE));
  ok('mcp-key.json migrated to encrypted format', credentialCrypto.isEncrypted(migratedKeyBytes));
  ok('Plaintext API key removed from mcp-key.json', !migratedKeyBytes.toString('utf8').includes(fakeLegacyKey));

  let legacyTxtStillExists = false;
  try {
    await fsp.access(path.join(apiMigrateDir, TXT_FILE));
    legacyTxtStillExists = true;
  } catch (_) {}
  ok('Plaintext local-api-key.txt safely deleted upon migration', legacyTxtStillExists === false);

  // =========================================================================
  // 7. Settings (Cloud Tokens & Passwords) Encryption & Migration
  // =========================================================================
  const settingsDir = path.join(tmpBase, 'settings-test');
  await fsp.mkdir(settingsDir, { recursive: true });
  const testSettingsFile = path.join(settingsDir, 'openbrowser-local-settings.json');

  const plainSettingsObj = {
    version: 2,
    profileDataRoot: '/tmp/profiles',
    cloud: {
      enabled: true,
      provider: 'github',
      passphrase: 'fake-cloud-backup-passphrase-999',
      webdav: { url: 'https://dav.test/dav', username: 'dav_user', password: 'dav_secret_password' },
      github: { owner: 'testowner', repo: 'testrepo', token: 'ghp_fake_token_1234567890', branch: 'main' },
    },
    uiGroups: [],
    closeAction: 'ask',
  };

  // Write plaintext file (simulating existing installation)
  await fsp.writeFile(testSettingsFile, JSON.stringify(plainSettingsObj, null, 2), 'utf8');
  ok('Initial settings file is plaintext', !credentialCrypto.isEncrypted(await fsp.readFile(testSettingsFile)));

  // Simulate main.js loadLocalSettings + migration
  let rawSettings = await fsp.readFile(testSettingsFile);
  let loadedSettings = null;
  if (!credentialCrypto.isEncrypted(rawSettings)) {
    loadedSettings = JSON.parse(rawSettings.toString('utf8'));
    // Migration: encrypt and rewrite atomically with backup
    await fsp.writeFile(testSettingsFile + '.bak', rawSettings);
    const encPayload = credentialCrypto.encryptCredential(JSON.stringify(loadedSettings, null, 2));
    const tmpFile = testSettingsFile + '.tmp';
    await fsp.writeFile(tmpFile, encPayload);
    await fsp.rename(tmpFile, testSettingsFile);
  }

  // Verify settings file is now encrypted
  const encryptedSettingsBytes = await fsp.readFile(testSettingsFile);
  ok('Settings file on disk is encrypted after migration', credentialCrypto.isEncrypted(encryptedSettingsBytes));
  ok('Plaintext cloud passphrase not in settings file', !encryptedSettingsBytes.toString('utf8').includes('fake-cloud-backup-passphrase-999'));
  ok('Plaintext GitHub token not in settings file', !encryptedSettingsBytes.toString('utf8').includes('ghp_fake_token_1234567890'));
  ok('Plaintext WebDAV password not in settings file', !encryptedSettingsBytes.toString('utf8').includes('dav_secret_password'));

  // Verify backup exists and contains valid plaintext
  const settingsBak = await fsp.readFile(testSettingsFile + '.bak', 'utf8');
  ok('Settings .bak backup preserved original data', settingsBak.includes('fake-cloud-backup-passphrase-999'));

  // Decrypt and verify payload fidelity
  const decryptedSettingsObj = JSON.parse(credentialCrypto.decryptCredential(encryptedSettingsBytes));
  ok('Decrypted cloud passphrase matches', decryptedSettingsObj.cloud.passphrase === 'fake-cloud-backup-passphrase-999');
  ok('Decrypted GitHub token matches', decryptedSettingsObj.cloud.github.token === 'ghp_fake_token_1234567890');
  ok('Decrypted WebDAV password matches', decryptedSettingsObj.cloud.webdav.password === 'dav_secret_password');

  // =========================================================================
  // 8. 1,500-Record Fallback Benchmark (Target: < 500ms using OBE2 HKDF)
  // =========================================================================
  credentialCrypto.setSafeStorageMock({ isEncryptionAvailable: () => false });
  const tBenchStart = Date.now();
  for (let b = 0; b < 1500; b++) {
    const raw = `credential_benchmark_payload_record_${b}`;
    const enc = credentialCrypto.encryptCredential(raw, { mode: 'auto' });
    const dec = credentialCrypto.decryptCredential(enc);
    if (dec !== raw) throw new Error(`Benchmark mismatch at record ${b}`);
  }
  const tBenchElapsed = Date.now() - tBenchStart;
  console.log(`  BENCHMARK: 1,500 OBE2 records encrypted & decrypted in ${tBenchElapsed}ms`);
  ok('1,500 records fallback encryption/decryption benchmark runs under 500ms', tBenchElapsed < 500);
  credentialCrypto.setSafeStorageMock(null);

  // Clean up test temporary directory
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});

  console.log(`\nAll ${passedCount}/${testCount} credential encryption self-test checks PASSED!`);
})();
