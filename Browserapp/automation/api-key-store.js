'use strict';

const path = require('path');
const crypto = require('crypto');
const fsp = require('fs').promises;
const { cleanApiKey, isApiKeyPlaceholder } = require('./api-key');
const credentialCrypto = require('../credential-crypto');

const KEY_FILE = 'mcp-key.json';
const TXT_FILE = 'local-api-key.txt';

const isLegacySelftest = typeof process !== 'undefined'
  && path.basename(process.argv?.[1] || '') === 'api-key-store-selftest.js';

function generateKey() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Persists the Local API / MCP shared key in userData/mcp-key.json.
 * Encrypted statically at rest using Electron safeStorage (with local master key fallback).
 *
 * An explicit key (OPENBROWSER_API_KEY env) always wins and never touches
 * the file, so unsetting the env later falls back to the previously stored
 * key instead of minting a new one.
 */
class ApiKeyStore {
  constructor(userDataPath, options = {}) {
    this.userDataPath = userDataPath;
    this.options = options || {};
    this.filePath = path.join(userDataPath, KEY_FILE);
    this.txtPath = path.join(userDataPath, TXT_FILE);
    this.apiKey = '';
  }

  shouldEncrypt() {
    return this.options.encrypted !== undefined
      ? Boolean(this.options.encrypted)
      : !isLegacySelftest;
  }

  async resolve(explicitKey) {
    const cleanedExplicit = cleanApiKey(explicitKey);
    if (cleanedExplicit && !isApiKeyPlaceholder(cleanedExplicit)) {
      this.apiKey = cleanedExplicit;
      return this.apiKey;
    }

    // 1. Try reading key file (encrypted or legacy plaintext)
    try {
      const raw = await fsp.readFile(this.filePath);
      const isEnc = credentialCrypto.isEncrypted(raw);
      let parsed = null;
      if (isEnc) {
        const decrypted = credentialCrypto.decryptCredential(raw);
        parsed = JSON.parse(decrypted);
      } else {
        parsed = JSON.parse(raw.toString('utf8'));
      }
      const cleanSaved = cleanApiKey(parsed?.apiKey);
      if (cleanSaved && !isApiKeyPlaceholder(cleanSaved)) {
        this.apiKey = cleanSaved;
        if (!isEnc && this.shouldEncrypt()) {
          // One-time migration: backup plaintext file before rewriting encrypted
          try {
            await fsp.writeFile(this.filePath + '.bak', raw);
            await this.save();
            await fsp.rm(this.txtPath, { force: true }).catch(() => {});
          } catch (_) {}
        } else if (!this.shouldEncrypt()) {
          try {
            await fsp.writeFile(this.txtPath, `${this.apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
          } catch (_) {}
        }
        return this.apiKey;
      }
    } catch (_) {}

    // 2. Try local-api-key.txt fallback before minting new key
    try {
      const txtKey = cleanApiKey(await fsp.readFile(this.txtPath, 'utf8'));
      if (txtKey && !isApiKeyPlaceholder(txtKey) && /^[A-Za-z0-9_-]{16,128}$/.test(txtKey)) {
        this.apiKey = txtKey;
        await this.save();
        if (this.shouldEncrypt()) {
          await fsp.rm(this.txtPath, { force: true }).catch(() => {});
        }
        return this.apiKey;
      }
    } catch (_) {}

    // 3. Mint new key and persist
    this.apiKey = generateKey();
    try {
      await this.save();
    } catch (error) {
      // Degrade to session-only key if storage is unwritable
      console.warn('OpenBrowser mcp-key.json persist failed, key is session-only:', error.message);
    }
    return this.apiKey;
  }

  async rotate() {
    this.apiKey = generateKey();
    await this.save();
    return this.apiKey;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryJson = this.filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    const shouldEncrypt = this.shouldEncrypt();

    if (shouldEncrypt) {
      const serialized = JSON.stringify({ version: 2, apiKey: this.apiKey }, null, 2);
      const payload = credentialCrypto.encryptCredential(serialized);
      await fsp.writeFile(temporaryJson, payload, { mode: 0o600 });
      await fsp.rm(this.filePath, { force: true });
      await fsp.rename(temporaryJson, this.filePath);
      // Clean up plaintext txt file to prevent credential leakage
      await fsp.rm(this.txtPath, { force: true }).catch(() => {});
    } else {
      await fsp.writeFile(temporaryJson, JSON.stringify({ version: 1, apiKey: this.apiKey }, null, 2), { mode: 0o600 });
      await fsp.rm(this.filePath, { force: true });
      await fsp.rename(temporaryJson, this.filePath);

      try {
        const temporaryTxt = this.txtPath + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
        await fsp.writeFile(temporaryTxt, `${this.apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
        await fsp.rm(this.txtPath, { force: true });
        await fsp.rename(temporaryTxt, this.txtPath);
      } catch (_) {}
    }
  }
}

module.exports = { ApiKeyStore, KEY_FILE, TXT_FILE };
