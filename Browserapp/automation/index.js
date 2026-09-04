'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LocalApiServer } = require('./local-api-server');
const { RpaEngine } = require('./rpa-engine');
const { RpaStore } = require('./rpa-store');
const { WindowSyncBridge } = require('./window-sync-bridge');
const { AppCenter } = require('./app-center');
const { ProxyStore } = require('./proxy-store');
const { resolveApiKey } = require('./api-key');

function writeApiKeyAtomically(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${String(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch (_) {}
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    return true;
  } catch (_) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    return false;
  }
}

/**
 * Mount automation stack (Local API + RPA + window-sync + app center + proxy library).
 * MCP is a separate stdio process: `node automation/mcp-server.js`.
 * Fully self-contained — does not call or embed external browser binaries.
 */
async function startAutomation(context = {}) {
  const {
    app,
    engine,
    liveSync,
    beginSync,
    endSync,
    restartSync,
    getSyncState,
    setSelection,
    tile,
    emit = () => {},
    port = Number(process.env.OPENBROWSER_API_PORT || 50325),
  } = context;

  const defaultKeyFilePath = path.join(app.getPath('userData'), 'local-api-key.txt');
  const keyResolution = resolveApiKey({
    configured: context.apiKey,
    userDataPath: app.getPath('userData'),
  });
  let effectiveApiKey = keyResolution.key;
  const keyFilePath = keyResolution.filePath || defaultKeyFilePath;
  if (keyResolution.filePath) {
    try { fs.chmodSync(keyResolution.filePath, 0o600); } catch (_) {}
  }
  if (!effectiveApiKey) {
    effectiveApiKey = crypto.randomBytes(32).toString("base64url");
    if (!writeApiKeyAtomically(keyFilePath, effectiveApiKey)) {
      const error = new Error(`Failed to persist local API key: ${keyFilePath}`);
      error.code = 'API_KEY_PERSIST_FAILED';
      throw error;
    }
  }
  const apiKey = effectiveApiKey;

  const storePath = path.join(app.getPath('userData'), 'rpa-store.json');
  const rpaStore = new RpaStore(storePath);
  await rpaStore.load();

  const proxyStore = new ProxyStore(path.join(app.getPath('userData'), 'proxy-library.json'));
  await proxyStore.load();
  await engine?.setProxyStore?.(proxyStore);

  const rpaEngine = new RpaEngine({
    engine,
    store: rpaStore,
    emit: (event) => emit(event),
    userDataPath: app.getPath('userData'),
  });

  const syncBridge = new WindowSyncBridge({
    getLiveSync: () => liveSync,
    beginSync,
    endSync,
    restartSync,
    getSyncState,
    setSelection,
    tile,
    getSettings: () => liveSync.getSettings(),
    updateSettings: (value) => liveSync.updateSettings(value),
  });

  const appCenter = new AppCenter({ engine });

  const localApi = new LocalApiServer({
    host: '127.0.0.1',
    port,
    apiKey,
    engine,
    rpaEngine,
    rpaStore,
    syncBridge,
    appCenter,
    proxyStore,
    getVersion: () => app.getVersion(),
  });

  const info = await localApi.start();
  emit({ type: 'local-api', ...info });

  return {
    localApi,
    rpaEngine,
    rpaStore,
    syncBridge,
    appCenter,
    proxyStore,
    info,
    apiKey,
    apiKeyFile: keyFilePath,
    async stop() {
      await rpaEngine.stop();
      await localApi.stop();
      // Proxy credentials are written through a serialized queue. Wait for the
      // queue before Electron is allowed to tear down the main process.
      await proxyStore.flush?.();
    },
  };
}

module.exports = {
  startAutomation,
  LocalApiServer,
  RpaEngine,
  RpaStore,
  WindowSyncBridge,
  AppCenter,
  ProxyStore,
};
