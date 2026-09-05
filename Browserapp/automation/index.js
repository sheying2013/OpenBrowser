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
const { ApiKeyStore, KEY_FILE, TXT_FILE } = require('./api-key-store');

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

  const userDataPath = app.getPath('userData');
  const keyStore = new ApiKeyStore(userDataPath);
  let effectiveApiKey = await keyStore.resolve(context.apiKey || process.env.OPENBROWSER_API_KEY);
  const keyFilePath = keyStore.filePath;

  const storePath = path.join(userDataPath, 'rpa-store.json');
  const rpaStore = new RpaStore(storePath);
  await rpaStore.load();

  const proxyStore = new ProxyStore(path.join(userDataPath, 'proxy-library.json'));
  await proxyStore.load();
  await engine?.setProxyStore?.(proxyStore);

  const rpaEngine = new RpaEngine({
    engine,
    store: rpaStore,
    emit: (event) => emit(event),
    userDataPath,
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
    apiKey: effectiveApiKey,
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
    keyStore,
    info,
    apiKey: effectiveApiKey,
    apiKeyFile: keyFilePath,
    async rotateApiKey() {
      const newKey = await keyStore.rotate();
      localApi.setApiKey(newKey);
      return newKey;
    },
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
  ApiKeyStore,
};
