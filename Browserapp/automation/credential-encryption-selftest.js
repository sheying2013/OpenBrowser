'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
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

  // Default mode 'auto' should now fall back to local master key AES-256-GCM
  const encFallback = credentialCrypto.encryptCredential(dummyPlaintext, { mode: 'auto' });
  ok('Fallback format is OBE1', encFallback.subarray(0, 4).toString('ascii') === 'OBE1');
  const decFallback = credentialCrypto.decryptCredential(encFallback);
  ok('Fallback decryption recovers plaintext', decFallback === dummyPlaintext);

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

  // Clean up test temporary directory
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});

  console.log(`\nAll ${passedCount}/${testCount} credential encryption self-test checks PASSED!`);
})();
