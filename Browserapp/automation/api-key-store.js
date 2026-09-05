'use strict';

const path = require('path');
const crypto = require('crypto');
const fsp = require('fs').promises;

const KEY_FILE = 'mcp-key.json';
const TXT_FILE = 'local-api-key.txt';

function generateKey() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Persists the Local API / MCP shared key in userData/mcp-key.json and
 * userData/local-api-key.txt so the key survives app restarts and works
 * with both JSON-aware and plain-text MCP clients.
 *
 * An explicit key (OPENBROWSER_API_KEY env) always wins and never touches
 * the file, so unsetting the env later falls back to the previously stored
 * key instead of minting a new one.
 */
class ApiKeyStore {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.filePath = path.join(userDataPath, KEY_FILE);
    this.txtPath = path.join(userDataPath, TXT_FILE);
    this.apiKey = '';
  }

  async resolve(explicitKey) {
    if (explicitKey) {
      this.apiKey = String(explicitKey);
      return this.apiKey;
    }
    try {
      const saved = JSON.parse(await fsp.readFile(this.filePath, 'utf8'));
      if (typeof saved.apiKey === 'string' && saved.apiKey) {
        this.apiKey = saved.apiKey;
        // Keep txt in sync if missing
        try {
          await fsp.writeFile(this.txtPath, `${this.apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
        } catch (_) {}
        return this.apiKey;
      }
    } catch (_) {
      // Try local-api-key.txt fallback before minting new key
      try {
        const txtKey = (await fsp.readFile(this.txtPath, 'utf8')).trim();
        if (txtKey && /^[A-Za-z0-9_-]{16,128}$/.test(txtKey)) {
          this.apiKey = txtKey;
          await this.save();
          return this.apiKey;
        }
      } catch (_) {}
    }
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

module.exports = { ApiKeyStore, KEY_FILE, TXT_FILE };
