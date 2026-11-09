'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MAGIC_SAFESTORAGE_V1 = 'OBS1'; // OpenBrowser SafeStorage v1
const MAGIC_AES_GCM_V1 = 'OBE1';      // OpenBrowser Encrypted v1 (compatible with cloud-sync .obpack)
const MAGIC_AES_GCM_V2 = 'OBE2';      // OpenBrowser Encrypted v2 (high-performance HKDF + AES-GCM)

const HEADER_LENGTH = 4;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const OBE2_INFO = Buffer.from('openbrowser-obe2-v1');

let _safeStorageMock = null;
let _cachedMasterKey = null;

// LRU Cache for OBE1 scrypt derived keys (capacity: 1000)
const _obe1KeyCache = new Map();
const MAX_OBE1_CACHE = 1000;

function getObe1Key(passphrase, salt) {
  const passStr = String(passphrase);
  const keyHash = crypto.createHash('sha256').update(passStr).digest('hex');
  const cacheKey = keyHash + ':' + (Buffer.isBuffer(salt) ? salt.toString('hex') : String(salt));
  if (_obe1KeyCache.has(cacheKey)) {
    const k = _obe1KeyCache.get(cacheKey);
    // Refresh LRU order
    _obe1KeyCache.delete(cacheKey);
    _obe1KeyCache.set(cacheKey, k);
    return k;
  }
  const derived = crypto.scryptSync(passStr, salt, KEY_LENGTH);
  if (_obe1KeyCache.size >= MAX_OBE1_CACHE) {
    const oldestKey = _obe1KeyCache.keys().next().value;
    _obe1KeyCache.delete(oldestKey);
  }
  _obe1KeyCache.set(cacheKey, derived);
  return derived;
}

function clearObe1KeyCache() {
  _obe1KeyCache.clear();
}

/**
 * Derives a 256-bit symmetric key from a 256-bit master key using HKDF-SHA256.
 * Bypasses heavy scrypt computation when using high-entropy random master keys.
 */
function deriveObe2Key(masterKey, salt) {
  const mk = String(masterKey);
  const ikm = /^[a-fA-F0-9]{64}$/.test(mk)
    ? Buffer.from(mk, 'hex')
    : crypto.createHash('sha256').update(mk).digest();
  const rawKey = crypto.hkdfSync('sha256', ikm, salt, OBE2_INFO, KEY_LENGTH);
  return Buffer.from(rawKey);
}

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
 * Synchronous sleep using Atomics.wait or busy-wait fallback.
 */
function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);
    Atomics.wait(int32, 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

/**
 * Derive deterministic fallback master key used by legacy versions when filesystem was read-only.
 * Retained ONLY for backward-compatible decryption of existing legacy ciphertexts.
 * NEVER used for creating new master keys or writing new ciphertexts.
 */
function getLegacyDeterministicMasterKey() {
  const user = (typeof os.userInfo === 'function') ? (os.userInfo().username || 'user') : 'user';
  const fallbackSeed = `openbrowser-offline-seed:${os.hostname()}:${user}:${os.homedir()}`;
  return crypto.createHash('sha256').update(fallbackSeed).digest('hex');
}

/**
 * Read existing master key from disk.
 * Handles process race conditions where the file may be concurrently being written.
 * If the file exists but reading fails or the key is invalid, throws an error rather than
 * allowing the existing key file to be overwritten.
 */
function readMasterKeyFile(keyPath, maxRetries = 40, retryDelayMs = 25) {
  let sawExistingFile = false;
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (!fs.existsSync(keyPath)) {
        if (!sawExistingFile) {
          return null;
        }
        if (attempt < maxRetries) {
          sleepSync(retryDelayMs);
          continue;
        }
        return null;
      }

      sawExistingFile = true;
      const raw = fs.readFileSync(keyPath, 'utf8');
      const content = raw.trim();
      if (content && content.length >= 32) {
        return content;
      }

      // File exists on disk but is incomplete (< 32 chars): another process may be writing it.
      if (attempt < maxRetries) {
        sleepSync(retryDelayMs);
        continue;
      }

      throw new Error(
        `Master key file at "${keyPath}" exists but contains an invalid key (length < 32); refusing to overwrite to prevent data loss`
      );
    } catch (err) {
      if (err.code === 'ENOENT') {
        if (!sawExistingFile) {
          return null;
        }
        if (attempt < maxRetries) {
          sleepSync(retryDelayMs);
          continue;
        }
        return null;
      }

      if (err.message && err.message.includes('refusing to overwrite')) {
        throw err;
      }

      lastErr = err;
      if (attempt < maxRetries) {
        sleepSync(retryDelayMs);
        continue;
      }

      throw new Error(
        `Master key file at "${keyPath}" exists but cannot be read (${lastErr.code || lastErr.message}); refusing to overwrite to prevent data loss`
      );
    }
  }

  return null;
}

/**
 * Retrieve or generate the local master key for offline AES-256-GCM fallback encryption.
 * Security & concurrency notes:
 * - Stored in ~/.openbrowser-master.key outside userData to prevent credential leakage if userData is copied/exported.
 * - Mode 0600 restricts access to the current OS user.
 * - Primary creation uses tempFile + linkSync for atomic directory publication (no partial-read window).
 * - Fallback creation on filesystems without hardlink support uses fs.openSync('wx'); note that 'wx' is
 *   exclusive creation but NOT atomic publication (a partial-read window exists between openSync and closeSync,
 *   which is mitigated on the reader side by readMasterKeyFile's retry loop).
 * - If the key file cannot be safely persisted to disk, getLocalMasterKey throws directly; it never generates
 *   a predictable deterministic fallback key for writing new ciphertexts.
 * - Existing keys that cannot be read or are invalid are never overwritten to prevent credential loss.
 */
function getLocalMasterKey() {
  if (process.env.OPENBROWSER_MASTER_KEY) {
    return String(process.env.OPENBROWSER_MASTER_KEY).trim();
  }
  if (_cachedMasterKey) {
    return _cachedMasterKey;
  }

  const keyPath = getMasterKeyFilePath();

  // 1. Check if the key file already exists and is readable
  const existingKey = readMasterKeyFile(keyPath);
  if (existingKey) {
    _cachedMasterKey = existingKey;
    return _cachedMasterKey;
  }

  // 2. The key file does not exist yet. Ensure directory exists.
  const dir = path.dirname(keyPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  } catch (dirErr) {
    if (!fs.existsSync(dir)) {
      throw new Error(
        `Failed to create directory "${dir}" for master key: ${dirErr.message}; refusing to use unpersisted fallback key`
      );
    }
  }

  // 3. Generate candidate 256-bit key
  const generated = crypto.randomBytes(32).toString('hex');

  // 4. Concurrently safe creation:
  // Write to a unique temporary file with 0600 mode first, sync to disk, and then link atomically.
  // When linkSync is supported, keyPath appears atomically in the directory without a partial-read window.
  const tempFile = path.join(
    dir,
    `.${path.basename(keyPath)}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`
  );

  let tempWritten = false;
  try {
    const fd = fs.openSync(tempFile, 'wx', 0o600);
    try {
      fs.writeSync(fd, generated + '\n', undefined, 'utf8');
      try {
        fs.fsyncSync(fd);
      } catch (_) {}
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(tempFile, 0o600);
    } catch (_) {}
    tempWritten = true;
  } catch (writeErr) {
    // If temp file cannot be written (e.g. read-only filesystem),
    // check if another process created keyPath right before us
    const key = readMasterKeyFile(keyPath);
    if (key) {
      _cachedMasterKey = key;
      return _cachedMasterKey;
    }
    throw new Error(
      `Cannot persist new master key file at "${keyPath}": ${writeErr.message}; refusing to use insecure deterministic fallback`
    );
  }

  // Attempt atomic linkSync to target path
  try {
    fs.linkSync(tempFile, keyPath);
    try { fs.unlinkSync(tempFile); } catch (_) {}
    try { fs.chmodSync(keyPath, 0o600); } catch (_) {}
    _cachedMasterKey = generated;
    return _cachedMasterKey;
  } catch (linkErr) {
    try { fs.unlinkSync(tempFile); } catch (_) {}

    if (linkErr.code === 'EEXIST') {
      // Another process won the creation race! Read the winner's key from keyPath.
      const winnerKey = readMasterKeyFile(keyPath);
      if (winnerKey) {
        _cachedMasterKey = winnerKey;
        return _cachedMasterKey;
      }
      throw new Error(`Master key file "${keyPath}" was created concurrently but could not be read`);
    }

    // Hardlink not supported on this filesystem (e.g. EXDEV, ENOSYS, ENOTSUP, EPERM, EINVAL)
    // Fall back to exclusive creation via fs.openSync('wx').
    // Note: 'wx' provides exclusive creation but NOT atomic publication; a brief partial-read window exists
    // between openSync and closeSync, which is mitigated on the reader side by readMasterKeyFile's retry loop.
    try {
      const fd = fs.openSync(keyPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, generated + '\n', undefined, 'utf8');
        try { fs.fsyncSync(fd); } catch (_) {}
      } finally {
        fs.closeSync(fd);
      }
      try { fs.chmodSync(keyPath, 0o600); } catch (_) {}
      _cachedMasterKey = generated;
      return _cachedMasterKey;
    } catch (openErr) {
      if (openErr.code === 'EEXIST') {
        const winnerKey = readMasterKeyFile(keyPath);
        if (winnerKey) {
          _cachedMasterKey = winnerKey;
          return _cachedMasterKey;
        }
        throw new Error(`Master key file "${keyPath}" was created concurrently but could not be read`);
      }
      // Filesystem is read-only or permission denied: refuse to use unpersisted fallback key
      const key = readMasterKeyFile(keyPath);
      if (key) {
        _cachedMasterKey = key;
        return _cachedMasterKey;
      }
      throw new Error(
        `Cannot persist master key file at "${keyPath}": ${openErr.message}; refusing to use insecure deterministic fallback`
      );
    }
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
  return header === MAGIC_SAFESTORAGE_V1 || header === MAGIC_AES_GCM_V1 || header === MAGIC_AES_GCM_V2;
}

/**
 * Return format name: 'OBS1', 'OBE1', 'OBE2', or 'plaintext'.
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
    if (header === MAGIC_AES_GCM_V2) return MAGIC_AES_GCM_V2;
  }
  return 'plaintext';
}

/**
 * Encrypt buffer using AES-256-GCM in OBE1 format (scryptSync).
 * Exactly compatible with cloud-sync.js encryptPayload format.
 */
function encryptAesGcm(plainBuf, passphraseOrKey, options = {}) {
  if (options.format === MAGIC_AES_GCM_V2) {
    return encryptAesGcmObe2(plainBuf, passphraseOrKey);
  }
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
 * Encrypt buffer using AES-256-GCM in OBE2 format (HKDF-SHA256).
 * High-performance fallback when local master key is used without external passphrase.
 */
function encryptAesGcmObe2(plainBuf, masterKey) {
  const keySource = masterKey || getLocalMasterKey();
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveObe2Key(keySource, salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(MAGIC_AES_GCM_V2, 'ascii'),
    salt,
    iv,
    tag,
    enc,
  ]);
}

/**
 * Decrypt buffer in OBE1 or OBE2 format using AES-256-GCM.
 * Supports LRU key cache for OBE1 and ultra-fast HKDF for OBE2.
 */
function decryptAesGcm(buf, passphraseOrKey) {
  if (!buf || buf.length < HEADER_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error('无效的 AES-GCM 加密数据包: 长度不足');
  }
  const header = buf.subarray(0, HEADER_LENGTH).toString('ascii');
  const salt = buf.subarray(HEADER_LENGTH, HEADER_LENGTH + SALT_LENGTH);
  const iv = buf.subarray(HEADER_LENGTH + SALT_LENGTH, HEADER_LENGTH + SALT_LENGTH + IV_LENGTH);
  const tag = buf.subarray(HEADER_LENGTH + SALT_LENGTH + IV_LENGTH, HEADER_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const enc = buf.subarray(HEADER_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  let key;
  if (header === MAGIC_AES_GCM_V2) {
    const masterKey = passphraseOrKey || getLocalMasterKey();
    key = deriveObe2Key(masterKey, salt);
  } else if (header === MAGIC_AES_GCM_V1) {
    const passphrase = String(passphraseOrKey || getLocalMasterKey());
    key = getObe1Key(passphrase, salt);
  } else {
    throw new Error(`非 OBE1/OBE2 格式头: ${header}`);
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/**
 * Unified credential encrypt function.
 * Mode:
 *  - 'auto' (default): use safeStorage if available; fall back to AES-256-GCM (OBE2 via HKDF when using local master key).
 *  - 'safeStorage': force safeStorage; throws if unavailable.
 *  - 'aes-gcm': force AES-256-GCM (OBE1 if passphrase or format=OBE1; else OBE2).
 *
 * Returns a Buffer with a 4-byte version header ('OBS1', 'OBE1', or 'OBE2').
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

  // Explicit human passphrase or options.format === 'OBE1': strictly use OBE1 + scryptSync
  if (options.passphrase || options.format === MAGIC_AES_GCM_V1) {
    const passphrase = options.passphrase || getLocalMasterKey();
    return encryptAesGcm(Buffer.from(text, 'utf8'), passphrase, { format: MAGIC_AES_GCM_V1 });
  }

  // Default AES-GCM fallback without external passphrase: high-performance OBE2 via HKDF
  const masterKey = getLocalMasterKey();
  return encryptAesGcmObe2(Buffer.from(text, 'utf8'), masterKey);
}

/**
 * Unified credential decrypt function.
 * If data starts with OBS1: decrypts via safeStorage.
 * If data starts with OBE2: decrypts via AES-256-GCM + HKDF with local master key.
 * If data starts with OBE1: decrypts via AES-256-GCM + scrypt with passphrase or local master key.
 * If data is unencrypted plaintext: returns the string as-is (for transparent legacy reading).
 *
 * Backward-compatibility:
 * If decryption with the active master key fails (or if getLocalMasterKey throws because no key can
 * be safely persisted), and no explicit passphrase was specified, evaluates whether the payload was
 * encrypted under the legacy deterministic fallback key from prior offline/container sessions.
 * Never modifies or overwrites existing key files or data during recovery.
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

  if (header === MAGIC_AES_GCM_V2 || header === MAGIC_AES_GCM_V1) {
    let keySource = options.masterKey || options.passphrase;
    let keyResolutionErr = null;
    if (!keySource) {
      try {
        keySource = getLocalMasterKey();
      } catch (err) {
        keyResolutionErr = err;
      }
    }

    if (keySource) {
      try {
        const plainBuf = decryptAesGcm(buf, keySource);
        return plainBuf.toString('utf8');
      } catch (primaryDecryptErr) {
        if (options.masterKey || options.passphrase) {
          throw primaryDecryptErr;
        }
      }
    }

    // Evaluate legacy deterministic fallback key for transparent recovery of old ciphertexts
    if (!options.masterKey && !options.passphrase) {
      try {
        const legacyKey = getLegacyDeterministicMasterKey();
        if (legacyKey && legacyKey !== keySource) {
          const fallbackBuf = decryptAesGcm(buf, legacyKey);
          return fallbackBuf.toString('utf8');
        }
      } catch (_) {}
    }

    if (keyResolutionErr) {
      throw keyResolutionErr;
    }
    return decryptAesGcm(buf, keySource).toString('utf8');
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
  MAGIC_AES_GCM_V2,
  isSafeStorageAvailable,
  setSafeStorageMock,
  getLocalMasterKey,
  getMasterKeyFilePath,
  resetLocalMasterKeyCache,
  getLegacyDeterministicMasterKey,
  isEncrypted,
  getFormat,
  encryptAesGcm,
  encryptAesGcmObe2,
  decryptAesGcm,
  encryptCredential,
  decryptCredential,
  encryptCredentialJson,
  decryptCredentialJson,
  clearObe1KeyCache,
};
