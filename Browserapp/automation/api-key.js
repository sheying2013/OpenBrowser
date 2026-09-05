'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function cleanApiKey(value) {
  let key = String(value ?? '').trim();
  for (let index = 0; index < 2; index += 1) {
    if (key.length >= 2 && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) {
      key = key.slice(1, -1).trim();
    } else {
      break;
    }
  }
  return key;
}

function isApiKeyPlaceholder(value) {
  const key = cleanApiKey(value);
  if (!key) return true;
  if (/^<[^>\r\n]{1,200}>$/.test(key)) return true;
  return /^(?:your|replace|change|set|copy|paste|enter|todo)(?:[-_ ]|$)/i.test(key);
}

function defaultUserDataPaths() {
  const paths = [];
  const home = os.homedir();
  if (process.platform === 'darwin') {
    paths.push(path.join(home, 'Library', 'Application Support', 'OpenBrowser'));
    paths.push(path.join(home, 'Library', 'Application Support', 'openbrowser'));
    paths.push(path.join(home, 'Library', 'Application Support', 'Electron'));
  } else if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      paths.push(path.join(process.env.APPDATA, 'OpenBrowser'));
      paths.push(path.join(process.env.APPDATA, 'openbrowser'));
      paths.push(path.join(process.env.APPDATA, 'Electron'));
    }
    paths.push(path.join(home, 'AppData', 'Roaming', 'OpenBrowser'));
    paths.push(path.join(home, 'AppData', 'Roaming', 'openbrowser'));
    paths.push(path.join(home, 'AppData', 'Roaming', 'Electron'));
  } else {
    if (process.env.XDG_CONFIG_HOME) {
      paths.push(path.join(process.env.XDG_CONFIG_HOME, 'OpenBrowser'));
      paths.push(path.join(process.env.XDG_CONFIG_HOME, 'openbrowser'));
      paths.push(path.join(process.env.XDG_CONFIG_HOME, 'Electron'));
    }
    paths.push(path.join(home, '.config', 'OpenBrowser'));
    paths.push(path.join(home, '.config', 'openbrowser'));
    paths.push(path.join(home, '.config', 'Electron'));
  }
  return paths;
}

function apiKeyFileCandidates({ env = process.env, userDataPath = '' } = {}) {
  const candidates = [
    env.OPENBROWSER_API_KEY_FILE,
    env.OPENBROWSER_LOCAL_API_KEY_FILE,
    env.API_KEY_FILE,
    userDataPath ? path.join(userDataPath, 'mcp-key.json') : '',
    userDataPath ? path.join(userDataPath, 'local-api-key.txt') : '',
    env.OPENBROWSER_USER_DATA ? path.join(env.OPENBROWSER_USER_DATA, 'mcp-key.json') : '',
    env.OPENBROWSER_USER_DATA ? path.join(env.OPENBROWSER_USER_DATA, 'local-api-key.txt') : '',
  ];
  for (const base of defaultUserDataPaths()) {
    candidates.push(path.join(base, 'mcp-key.json'));
    candidates.push(path.join(base, 'local-api-key.txt'));
  }
  candidates.push(path.join(process.cwd(), 'mcp-key.json'));
  candidates.push(path.join(process.cwd(), 'local-api-key.txt'));
  candidates.push(path.join(__dirname, '..', 'mcp-key.json'));
  candidates.push(path.join(__dirname, '..', 'local-api-key.txt'));
  return [...new Set(candidates.map((value) => String(value || '').trim()).filter(Boolean))];
}

function resolveApiKey({ configured = '', env = process.env, userDataPath = '', ignoreEnv = false } = {}) {
  if (!ignoreEnv) {
  for (const value of [configured, env.OPENBROWSER_API_KEY, env.API_KEY]) {
    const direct = cleanApiKey(value);
    if (direct && !isApiKeyPlaceholder(direct)) return { key: direct, filePath: null, source: 'environment' };
  }
  }

  for (const filePath of apiKeyFileCandidates({ env, userDataPath })) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      let key = cleanApiKey(raw);
      if (key.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.apiKey === 'string') {
            key = cleanApiKey(parsed.apiKey);
          }
        } catch (_) {}
      }
      if (key && !isApiKeyPlaceholder(key)) return { key, filePath, source: 'file' };
    } catch (_) {}
  }
  return { key: '', filePath: null, source: 'none' };
}

module.exports = { cleanApiKey, isApiKeyPlaceholder, defaultUserDataPaths, apiKeyFileCandidates, resolveApiKey };
