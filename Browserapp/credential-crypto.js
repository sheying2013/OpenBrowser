'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAGIC_SAFESTORAGE_V1 = 'OBS1'; // OpenBrowser SafeStorage v1
const MAGIC_AES_GCM_V1 = 'OBE1';      // OpenBrowser Encrypted v1 (compatible with cloud-sync .obpack)

const HEADER_LENGTH = 4;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

let _safeStorageMock = null;
let _cachedMasterKey = null;

/**
 * Returns true if Electron safeStorage is available and configured on this system.
 * Allows override via mock for testing environments.
 */
function isSafeStorageAvailable() {
  if (_safeStorageMock !== null) {
    try {
      return Boolean(_safeStorageMock.isEncryptionAvailable?.());
    } catch (_) {
      return false;
    }
  }
  try {
    const electron = require('electron');
    const safeStorage = electron?.safeStorage;
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function') {
      return Boolean(safeStorage.isEncryptionAvailable());
    }
  } catch (_) {}
  return false;
}

function getSafeStorage() {
  if (_safeStorageMock !== null) {
    return _safeStorageMock;
  }
  try {
    const electron = require('electron');
    return electron?.safeStorage || null;
  } catch (_) {
    return null;
  }
}

/**
 * Test hook to mock Electron's safeStorage in pure Node.js environments.
 * Pass null to restore default discovery.
 */
function setSafeStorageMock(mock) {
  _safeStorageMock = mock;
}

/**
 * Resolve the path to the offline master key file.
 * Stored strictly outside the application's userData directory (in user home with 0600 mode).
 */
function getMasterKeyFilePath() {
  if (process.env.OPENBROWSER_MASTER_KEY_FILE) {
    return path.resolve(process.env.OPENBROWSER_MASTER_KEY_FILE);
  }
  return path.join(os.homedir(), '.openbrowser-master.key');
}

/**
 * Retrieve or generate the local master key for offline AES-256-GCM fallback encryption.
 * Security trade-off:
 * - Stored in ~/.openbrowser-master.key outside userData to prevent credential leakage if userData is copied/exported.
 * - Mode 0600 restricts access to the current OS user.
 * - Provides guaranteed offline/headless availability when OS Keyring/DPAPI is unavailable.
 */
function getLocalMasterKey() {
  if (process.env.OPENBROWSER_MASTER_KEY) {
    return String(process.env.OPENBROWSER_MASTER_KEY).trim();
  }
  if (_cachedMasterKey) {
    return _cachedMasterKey;
  }

  const keyPath = getMasterKeyFilePath();
  try {
    if (fs.existsSync(keyPath)) {
      const content = fs.readFileSync(keyPath, 'utf8').trim();
      if (content && content.length >= 32) {
        _cachedMasterKey = content;
        return _cachedMasterKey;
      }
    }
  } catch (_) {}

  // Generate a new 256-bit cryptographically secure key
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    const dir = path.dirname(keyPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(keyPath, generated, { encoding: 'utf8', mode: 0o600 });
    _cachedMasterKey = generated;
    return _cachedMasterKey;
  } catch (writeErr) {
    // If the filesystem is read-only (e.g. strict container sandbox), derive deterministically
    // from system/user identity seed so the offline startup never crashes.
    const user = (typeof os.userInfo === 'function') ? (os.userInfo().username || 'user') : 'user';
    const fallbackSeed = `openbrowser-offline-seed:${os.hostname()}:${user}:${os.homedir()}`;
    const derived = crypto.createHash('sha256').update(fallbackSeed).digest('hex');
    _cachedMasterKey = derived;
    return _cachedMasterKey;
  }
}

/**
 * Reset cached master key (useful in unit tests).
 */
function resetLocalMasterKeyCache() {
  _cachedMasterKey = null;
}

/**
 * Check if the given buffer or string starts with a recognized encryption header.
 */
function isEncrypted(bufferOrString) {
  if (!bufferOrString) return false;
  const buf = Buffer.isBuffer(bufferOrString)
    ? bufferOrString
    : Buffer.from(String(bufferOrString), 'binary');
  if (buf.length < HEADER_LENGTH) return false;
  const header = buf.subarray(0, HEADER_LENGTH).toString('ascii');
  return header === MAGIC_SAFESTORAGE_V1 || header === MAGIC_AES_GCM_V1;
}

/**
 * Return format name: 'OBS1', 'OBE1', or 'plaintext'.
 */
function getFormat(bufferOrString) {
  if (!bufferOrString) return 'plaintext';
  const buf = Buffer.isBuffer(bufferOrString)
    ? bufferOrString
    : Buffer.from(String(bufferOrString), 'binary');
  if (buf.length >= HEADER_LENGTH) {
    const header = buf.subarray(0, HEADER_LENGTH).toString('ascii');
    if (header === MAGIC_SAFESTORAGE_V1) return MAGIC_SAFESTORAGE_V1;
    if (header === MAGIC_AES_GCM_V1) return MAGIC_AES_GCM_V1;
  }
  return 'plaintext';
}

/**
 * Encrypt buffer using AES-256-GCM in OBE1 format.
 * Exactly compatible with cloud-sync.js encryptPayload format.
 */
function encryptAesGcm(plainBuf, passphraseOrKey) {
  const passphrase = String(passphraseOrKey || getLocalMasterKey());
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = crypto.scryptSync(passphrase, salt, KEY_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(MAGIC_AES_GCM_V1, 'ascii'),
    salt,
    iv,
    tag,
    enc,
  ]);
}

/**
 * Decrypt buffer in OBE1 format using AES-256-GCM.
 * Exactly compatible with cloud-sync.js decryptPayload format.
 */
function decryptAesGcm(buf, passphraseOrKey) {
  const passphrase = String(passphraseOrKey || getLocalMasterKey());
  if (!buf || buf.length < HEADER_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error('无效的 OBE1 加密数据包: 长度不足');
  }
  const header = buf.subarray(0, HEADER_LENGTH).toString('ascii');
  if (header !== MAGIC_AES_GCM_V1) {
    throw new Error(`非 OBE1 格式头: ${header}`);
  }
  const salt = buf.subarray(HEADER_LENGTH, HEADER_LENGTH + SALT_LENGTH);
  const iv = buf.subarray(HEADER_LENGTH + SALT_LENGTH, HEADER_LENGTH + SALT_LENGTH + IV_LENGTH);
  const tag = buf.subarray(HEADER_LENGTH + SALT_LENGTH + IV_LENGTH, HEADER_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const enc = buf.subarray(HEADER_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const key = crypto.scryptSync(passphrase, salt, KEY_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/**
 * Unified credential encrypt function.
 * Mode:
 *  - 'auto' (default): use safeStorage if available; fall back to AES-256-GCM (OBE1) with local master key.
 *  - 'safeStorage': force safeStorage; throws if unavailable.
 *  - 'aes-gcm': force AES-256-GCM (OBE1).
 *
 * Returns a Buffer with a 4-byte version header ('OBS1' or 'OBE1').
 */
function encryptCredential(plaintext, options = {}) {
  const text = typeof plaintext === 'string'
    ? plaintext
    : Buffer.isBuffer(plaintext) ? plaintext.toString('utf8') : String(plaintext ?? '');
  const mode = options.mode || 'auto';

  if (mode === 'safeStorage' || (mode === 'auto' && isSafeStorageAvailable())) {
    const safeStorage = getSafeStorage();
    if (!safeStorage || typeof safeStorage.encryptString !== 'function') {
      throw new Error('safeStorage 接口不可用');
    }
    const encrypted = safeStorage.encryptString(text);
    return Buffer.concat([Buffer.from(MAGIC_SAFESTORAGE_V1, 'ascii'), encrypted]);
  }

  // Fallback: local master key + AES-256-GCM (OBE1 format)
  const passphrase = options.passphrase || getLocalMasterKey();
  return encryptAesGcm(Buffer.from(text, 'utf8'), passphrase);
}

/**
 * Unified credential decrypt function.
 * If data starts with OBS1: decrypts via safeStorage.
 * If data starts with OBE1: decrypts via AES-256-GCM with passphrase or local master key.
 * If data is unencrypted plaintext: returns the string as-is (for transparent legacy reading).
 */
function decryptCredential(bufferOrString, options = {}) {
  if (bufferOrString == null) return '';
  const buf = Buffer.isBuffer(bufferOrString)
    ? bufferOrString
    : Buffer.from(String(bufferOrString), 'binary');

  if (buf.length < HEADER_LENGTH) {
    return buf.toString('utf8');
  }

  const header = buf.subarray(0, HEADER_LENGTH).toString('ascii');
  if (header === MAGIC_SAFESTORAGE_V1) {
    const safeStorage = getSafeStorage();
    if (!safeStorage || typeof safeStorage.decryptString !== 'function') {
      throw new Error('safeStorage 不可用，无法解密 OBS1 格式凭据');
    }
    return safeStorage.decryptString(buf.subarray(HEADER_LENGTH));
  }

  if (header === MAGIC_AES_GCM_V1) {
    const passphrase = options.passphrase || getLocalMasterKey();
    const plainBuf = decryptAesGcm(buf, passphrase);
    return plainBuf.toString('utf8');
  }

  // Plaintext legacy fallback
  return buf.toString('utf8');
}

/**
 * Encrypt a JSON serializable object.
 */
function encryptCredentialJson(data, options = {}) {
  const json = JSON.stringify(data, null, 2);
  return encryptCredential(json, options);
}

/**
 * Decrypt a JSON serializable object.
 */
function decryptCredentialJson(bufferOrString, options = {}) {
  const decrypted = decryptCredential(bufferOrString, options);
  return JSON.parse(decrypted);
}

module.exports = {
  MAGIC_SAFESTORAGE_V1,
  MAGIC_AES_GCM_V1,
  isSafeStorageAvailable,
  setSafeStorageMock,
  getLocalMasterKey,
  getMasterKeyFilePath,
  resetLocalMasterKeyCache,
  isEncrypted,
  getFormat,
  encryptAesGcm,
  decryptAesGcm,
  encryptCredential,
  decryptCredential,
  encryptCredentialJson,
  decryptCredentialJson,
};
