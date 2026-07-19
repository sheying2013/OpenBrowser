const { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, session, shell } = require('./host-bridge');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const { spawn, execFile } = require('child_process');
const { randomUUID } = require('crypto');
const cdp = require('./cdp');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const { startAutomation } = require('./automation');
const cloudSync = require('./automation/cloud-sync');
const { validateDataRootIsolationSecure, ensureDataRootIsolationSecure, assertProfileId } = require('./automation/isolation');

const appDataRoot = app.getPath('appData');
const userDataRoot = path.join(appDataRoot, 'openbrowser');
app.setName('OpenBrowser');
try { process.title = 'OpenBrowser'; } catch (_) { /* ignore */ }
app.setPath('userData', userDataRoot);

const defaultProfileDataRoot = path.join(app.getPath('userData'), 'browser-profiles-v2');
const localSettingsFile = path.join(app.getPath('userData'), 'openbrowser-local-settings.json');

const UPDATE_REPOSITORY = 'lyu0805/OpenBrowser';
const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const UPDATE_ASSETS = Object.freeze({
  'darwin:x64': 'OpenBrowser-macOS-x86_64.dmg',
  'darwin:arm64': 'OpenBrowser-macOS-arm64.dmg',
  'win32:x64': 'OpenBrowser-Windows-x86_64.exe',
});
const UPDATE_MAX_BYTES = 1024 * 1024 * 1024;
const UPDATE_TIMEOUT_MS = 20000;
const UPDATE_ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com']);

function updatePlatformKey() {
  return `${process.platform}:${process.arch}`;
}

function updateAssetName() {
  return UPDATE_ASSETS[updatePlatformKey()] || null;
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
    if (!match) return null;
    return { numbers: [match[1], match[2], match[3]].map((part) => Number(part || 0)), pre: match[4] ? match[4].split('.') : [] };
  };
  const a = parse(left); const b = parse(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    if (a.pre[index] == null) return -1;
    if (b.pre[index] == null) return 1;
    if (a.pre[index] === b.pre[index]) continue;
    const aNumber = /^\d+$/.test(a.pre[index]); const bNumber = /^\d+$/.test(b.pre[index]);
    if (aNumber && bNumber) return Number(a.pre[index]) > Number(b.pre[index]) ? 1 : -1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.pre[index] > b.pre[index] ? 1 : -1;
  }
  return 0;
}

function updateUrlIsAllowed(value, assetName) {
  try {
    const url = new URL(String(value || ''));
    return (url.protocol === 'https:' && UPDATE_ALLOWED_HOSTS.has(url.hostname)
      && decodeURIComponent(url.pathname).endsWith('/' + assetName));
  } catch (_) {
    return false;
  }
}

async function fetchUpdateRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  try {
    const response = await fetch(UPDATE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `OpenBrowser/${app.getVersion()}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub Releases request failed (${response.status})`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function checkAppUpdate() {
  const assetName = updateAssetName();
  const currentVersion = app.getVersion();
  if (!assetName) {
    return { supported: false, repository: UPDATE_REPOSITORY, currentVersion, platform: process.platform, arch: process.arch };
  }
  const release = await fetchUpdateRelease();
  const remoteVersion = String(release.tag_name || release.name || '').replace(/^v/i, '');
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => item?.name === assetName)
    : null;
  if (!remoteVersion) throw new Error('GitHub Release has no version tag');
  if (!asset || !updateUrlIsAllowed(asset.browser_download_url, assetName)) {
    throw new Error(`Release is missing the ${assetName} package`);
  }
  return {
    supported: true,
    repository: UPDATE_REPOSITORY,
    currentVersion,
    remoteVersion,
    upToDate: compareVersions(remoteVersion, currentVersion) <= 0,
    releaseName: String(release.name || release.tag_name || remoteVersion),
    releaseUrl: String(release.html_url || `https://github.com/${UPDATE_REPOSITORY}/releases`),
    platform: process.platform,
    arch: process.arch,
    asset: { name: asset.name, size: Number(asset.size) || 0 },
  };
}

async function downloadAppUpdate() {
  const result = await checkAppUpdate();
  if (!result.supported) throw new Error('This platform is not supported by the published OpenBrowser packages');
  if (result.upToDate) return { success: false, upToDate: true, version: result.currentVersion, assetName: result.asset.name };
  const release = await fetchUpdateRelease();
  const asset = Array.isArray(release.assets) ? release.assets.find((item) => item?.name === result.asset.name) : null;
  const downloadUrl = asset?.browser_download_url;
  if (!asset || !updateUrlIsAllowed(downloadUrl, result.asset.name)) throw new Error('The selected update package URL is not trusted');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  const extension = path.extname(result.asset.name).toLowerCase();
  const baseName = path.basename(result.asset.name, extension);
  const temporaryPath = path.join(app.getPath('downloads'), `${baseName}-${randomUUID()}${extension}`);
  let received = 0;
  try {
    const response = await fetch(downloadUrl, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': `OpenBrowser/${app.getVersion()}` },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Update download failed (${response.status})`);
    const contentLength = Number(response.headers.get('content-length')) || 0;
    if (contentLength > UPDATE_MAX_BYTES) throw new Error('Update package is too large');
    await fsp.mkdir(path.dirname(temporaryPath), { recursive: true });
    const file = await fsp.open(temporaryPath, 'w');
    try {
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > UPDATE_MAX_BYTES) throw new Error('Update package is too large');
        await file.write(Buffer.from(chunk.value));
        emit({ type: 'app-update-progress', received, total: contentLength || result.asset.size || 0, percent: contentLength ? Math.min(100, Math.round(received / contentLength * 100)) : null, version: result.remoteVersion });
      }
    } finally {
      await file.close();
    }
    emit({ type: 'app-update-progress', received, total: contentLength || result.asset.size || received, percent: 100, version: result.remoteVersion });
    const openError = await shell.openPath(temporaryPath);
    if (openError) shell.showItemInFolder(temporaryPath);
    return { success: true, path: temporaryPath, version: result.remoteVersion, assetName: result.asset.name };
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeProfileDataRoot(value) {
  const raw = String(value || '').trim();
  const candidate = path.resolve(raw || defaultProfileDataRoot);
  const check = validateDataRootIsolationSecure(candidate);
  if (!check.ok) throw new Error(check.message);
  return check.root;
}

let localSettingsCache = {
  profileDataRoot: defaultProfileDataRoot,
  cloud: cloudSync.defaultCloudConfig(),
  uiGroups: [],
};

async function loadLocalSettings() {
  try {
    const saved = JSON.parse(await fsp.readFile(localSettingsFile, 'utf8'));
    localSettingsCache = {
      profileDataRoot: normalizeProfileDataRoot(saved.profileDataRoot),
      cloud: { ...cloudSync.defaultCloudConfig(), ...(saved.cloud || {}) },
      uiGroups: Array.isArray(saved.uiGroups) ? saved.uiGroups : [],
    };
    return localSettingsCache;
  } catch (_) {
    localSettingsCache = {
      profileDataRoot: defaultProfileDataRoot,
      cloud: cloudSync.defaultCloudConfig(),
      uiGroups: [],
    };
    return localSettingsCache;
  }
}

async function saveLocalSettings(value) {
  localSettingsCache = {
    profileDataRoot: normalizeProfileDataRoot(value.profileDataRoot || localSettingsCache.profileDataRoot),
    cloud: value.cloud || localSettingsCache.cloud || cloudSync.defaultCloudConfig(),
    uiGroups: Array.isArray(value.uiGroups) ? value.uiGroups : (localSettingsCache.uiGroups || []),
  };
  await fsp.mkdir(path.dirname(localSettingsFile), { recursive: true });
  const temporary = localSettingsFile + '.tmp';
  await fsp.writeFile(temporary, JSON.stringify({ version: 2, ...localSettingsCache }, null, 2), 'utf8');
  await fsp.rm(localSettingsFile, { force: true });
  await fsp.rename(temporary, localSettingsFile);
}

async function updateProfileDataRoot(value) {
  if (!engine) throw new Error('Browser engine is not ready');
  if (engine.running.size) throw new Error('\u8bf7\u5148\u505c\u6b62\u6240\u6709\u73af\u5883\uff0c\u518d\u4fee\u6539\u6570\u636e\u4fdd\u5b58\u4f4d\u7f6e');
  const profileDataRoot = normalizeProfileDataRoot(value);
  const secureCheck = await ensureDataRootIsolationSecure(profileDataRoot);
  if (!secureCheck.ok) throw new Error(secureCheck.message);
  engine.setProfileDataRoot(profileDataRoot);
  await saveLocalSettings({ ...localSettingsCache, profileDataRoot });
  emit({ type: 'storage-settings', profileRoot: profileDataRoot });
  return { success: true, profileRoot: profileDataRoot, defaultProfileRoot: defaultProfileDataRoot };
}

function providerConfigFromCloud(cloud) {
  const provider = String(cloud.provider || 'local').toLowerCase();
  if (provider === 'webdav') return cloud.webdav || {};
  if (provider === 'github') return cloud.github || {};
  if (provider === 'gdrive' || provider === 'google' || provider === 'gcs') return cloud.gdrive || {};
  if (provider === 'onedrive' || provider === 'microsoft' || provider === 'mscloud') return cloud.onedrive || cloud.webdav || {};
  if (provider === 'quark' || provider === 'kuake') return cloud.quark || cloud.webdav || {};
  if (provider === 'baidu' || provider === 'baiduyun' || provider === 'pan') return cloud.baidu || cloud.webdav || {};
  if (cloudSync.isWebDavBridgeProvider?.(provider)) {
    return cloud[provider] || cloud.webdav || {};
  }
  return cloud.local || {};
}

async function runCloudBackup(payload = {}) {
  const cloud = { ...localSettingsCache.cloud, ...(payload.cloud || {}) };
  const allProfiles = Array.isArray(payload.profiles)
    ? payload.profiles
    : [...(engine?.profiles?.values?.() || [])];
  const profileIds = Array.isArray(payload.profileIds) ? payload.profileIds.map(String) : null;
  const groups = Array.isArray(payload.groups) ? payload.groups : (localSettingsCache.uiGroups || []);
  let proxies = [];
  try { proxies = automation?.proxyStore?.list?.({}) || []; } catch (_) {}
  const { buffer, meta } = await cloudSync.buildBackupPackage({
    profiles: allProfiles,
    groups,
    proxies,
    settings: { cloud: { ...cloud, passphrase: cloud.passphrase ? '***' : '' } },
    profileDataRoot: engine?.getProfileDataRoot?.() || localSettingsCache.profileDataRoot,
    includeBrowserData: cloud.includeBrowserData !== false,
    passphrase: cloud.passphrase || '',
    profileIds,
  });
  const remoteName = payload.remoteName || cloudSync.REMOTE_NAME;
  const result = await cloudSync.upload(cloud.provider, providerConfigFromCloud(cloud), buffer, remoteName);
  cloud.lastSyncAt = new Date().toISOString();
  cloud.lastError = '';
  await saveLocalSettings({ ...localSettingsCache, cloud });
  emit({ type: 'cloud-sync', action: 'backup', ...meta, ...result });
  return { success: true, meta, result, cloud };
}

async function applyBackupBody(body, { mode = 'merge', localProfiles = null, localGroups = null } = {}) {
  const profileRoot = engine?.getProfileDataRoot?.() || localSettingsCache.profileDataRoot;
  const remoteProfiles = (body.profiles || []).map((p) => {
    const copy = { ...p };
    return copy;
  });
  let restoredFiles = 0;
  const dataById = new Map();
  for (const profile of remoteProfiles) {
    assertProfileId(profile?.id);
    if (profile._dataFiles && profile.id) {
      dataById.set(profile.id, profile._dataFiles);
      delete profile._dataFiles;
    }
  }

  const localList = Array.isArray(localProfiles)
    ? localProfiles
    : [...(engine?.profiles?.values?.() || [])];
  const localGroupList = Array.isArray(localGroups) ? localGroups : (localSettingsCache.uiGroups || []);

  const merged = cloudSync.mergeProfiles(localList, remoteProfiles, mode);
  const groups = cloudSync.mergeGroups(localGroupList, body.groups || [], mode);

  // restore browser data files for profiles that came from remote package
  for (const profile of merged.profiles) {
    const files = dataById.get(profile.id);
    if (files) {
      restoredFiles += await cloudSync.restoreProfileDataFiles(path.join(profileRoot, profile.id), files);
    }
  }

  let proxies = body.proxies || [];
  if (Array.isArray(proxies) && proxies.length) {
    let localProxies = [];
    try { localProxies = automation?.proxyStore?.list?.({}) || []; } catch (_) {}
    proxies = cloudSync.mergeProxies(localProxies, proxies, mode);
    if (automation?.proxyStore?.replaceAll) {
      await automation.proxyStore.replaceAll(proxies).catch(() => {});
    } else if (automation?.proxyStore) {
      for (const item of proxies) {
        try { await automation.proxyStore.create(item); } catch (_) {}
      }
    }
  }

  await saveLocalSettings({ ...localSettingsCache, uiGroups: groups });
  if (engine) engine.syncProfiles(merged.profiles);

  return {
    profiles: merged.profiles,
    groups,
    proxies,
    restoredFiles,
    mergeStats: merged.stats,
    createdAt: body.createdAt,
  };
}

async function runCloudRestore(payload = {}) {
  const cloud = { ...localSettingsCache.cloud, ...(payload.cloud || {}) };
  const mode = String(payload.mode || cloud.restoreMode || 'merge');
  const remoteName = payload.remoteName || cloudSync.REMOTE_NAME;
  const buffer = await cloudSync.download(cloud.provider, providerConfigFromCloud(cloud), remoteName);
  const body = await cloudSync.parseBackupPackage(buffer, cloud.passphrase || payload.passphrase || '');

  // optional: only restore subset of profile ids from the pack
  if (Array.isArray(payload.profileIds) && payload.profileIds.length) {
    const allow = new Set(payload.profileIds.map(String));
    body.profiles = (body.profiles || []).filter((p) => allow.has(String(p.id)));
  }

  const applied = await applyBackupBody(body, {
    mode,
    localProfiles: payload.localProfiles,
    localGroups: payload.localGroups,
  });

  cloud.lastSyncAt = new Date().toISOString();
  cloud.lastError = '';
  cloud.restoreMode = mode;
  await saveLocalSettings({ ...localSettingsCache, cloud, uiGroups: applied.groups });
  emit({
    type: 'cloud-sync',
    action: 'restore',
    mode,
    profileCount: applied.profiles.length,
    restoredFiles: applied.restoredFiles,
    mergeStats: applied.mergeStats,
  });
  return { success: true, mode, ...applied, cloud };
}

/** Push one or more environments as individual remote packs + refresh full pack optional */
async function runCloudProfilePush(payload = {}) {
  const cloud = { ...localSettingsCache.cloud, ...(payload.cloud || {}) };
  const ids = sanitizeIds(payload.profileIds || (payload.profileId ? [payload.profileId] : []));
  if (!ids.length) throw new Error('请指定要同步的环境');
  const allProfiles = Array.isArray(payload.profiles)
    ? payload.profiles
    : [...(engine?.profiles?.values?.() || [])];
  const results = [];
  for (const id of ids) {
    const profile = allProfiles.find((p) => p.id === id);
    if (!profile) throw new Error('环境不存在：' + id);
    const { buffer, meta } = await cloudSync.buildBackupPackage({
      profiles: [{ ...profile, updatedAt: profile.updatedAt || new Date().toISOString() }],
      groups: Array.isArray(payload.groups) ? payload.groups : (localSettingsCache.uiGroups || []),
      proxies: [],
      settings: { kind: 'profile', profileId: id },
      profileDataRoot: engine?.getProfileDataRoot?.() || localSettingsCache.profileDataRoot,
      includeBrowserData: cloud.includeBrowserData !== false,
      passphrase: cloud.passphrase || '',
      profileIds: [id],
    });
    const remoteName = cloudSync.profileRemoteName(id);
    const result = await cloudSync.upload(cloud.provider, providerConfigFromCloud(cloud), buffer, remoteName);
    results.push({ id, meta, result, remoteName });
  }
  cloud.lastSyncAt = new Date().toISOString();
  cloud.lastError = '';
  await saveLocalSettings({ ...localSettingsCache, cloud });
  emit({ type: 'cloud-sync', action: 'profile-push', count: results.length, ids });
  return { success: true, results, cloud };
}

async function runCloudProfilePull(payload = {}) {
  const cloud = { ...localSettingsCache.cloud, ...(payload.cloud || {}) };
  const mode = String(payload.mode || cloud.restoreMode || 'merge');
  const ids = sanitizeIds(payload.profileIds || (payload.profileId ? [payload.profileId] : []));
  if (!ids.length) throw new Error('请指定要拉取的环境');
  const localProfiles = Array.isArray(payload.localProfiles)
    ? payload.localProfiles
    : [...(engine?.profiles?.values?.() || [])];
  let combinedRemote = [];
  let restoredFiles = 0;
  const per = [];
  for (const id of ids) {
    const remoteName = cloudSync.profileRemoteName(id);
    const buffer = await cloudSync.download(cloud.provider, providerConfigFromCloud(cloud), remoteName);
    const body = await cloudSync.parseBackupPackage(buffer, cloud.passphrase || payload.passphrase || '');
    combinedRemote = combinedRemote.concat(body.profiles || []);
    per.push({ id, remoteName, count: (body.profiles || []).length, createdAt: body.createdAt });
  }
  const applied = await applyBackupBody(
    { profiles: combinedRemote, groups: payload.groups || localSettingsCache.uiGroups || [], proxies: [] },
    { mode, localProfiles, localGroups: payload.localGroups }
  );
  restoredFiles = applied.restoredFiles;
  cloud.lastSyncAt = new Date().toISOString();
  cloud.lastError = '';
  await saveLocalSettings({ ...localSettingsCache, cloud, uiGroups: applied.groups });
  emit({ type: 'cloud-sync', action: 'profile-pull', count: ids.length, mode, mergeStats: applied.mergeStats });
  return { success: true, mode, ...applied, per, restoredFiles, cloud };
}

let engine;
let liveSync;
let automation = null;
let quitting = false;
let syncSelection = [];
let syncState = { active: false, master: null, selected: [] };
const windows = new Set();
let mainWindow = null;

function assertTrustedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event?.sender !== mainWindow.webContents) {
    throw new Error('untrusted IPC sender');
  }
  const senderUrl = String(event.sender.getURL?.() || '');
  if (!senderUrl.startsWith('file:') || !senderUrl.endsWith('/index.html')) {
    throw new Error('untrusted IPC document');
  }
}

function registerTrustedIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event);
    return handler(event, ...args);
  });
}
let shortcutBridge = null;
let shortcutFallbackRegistered = false;
let shortcutActionInFlight = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeIds(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Invalid profile selection');
  return [...new Set(value.map(assertProfileId))];
}

function emit(value) {
  for (const win of windows) if (!win.isDestroyed()) win.webContents.send('engine:event', value);
}

async function tile(ids, cascade = false) {
  const entries = engine.runningWithCdp(sanitizeIds(ids));
  if (!entries.length) throw new Error('No selected browser has a CDP session');
  const work = screen.getPrimaryDisplay().workArea;
  if (cascade) {
    // Cascade layout: left + vs * index
    const { computeCascadeBounds } = require('./automation/protocol/window-sync-protocol');
    const width = Math.max(760, work.width - 220);
    const height = Math.max(560, work.height - 180);
    const layout = computeCascadeBounds(entries.map((e) => e.id), {
      left: work.x, top: work.y, width, height, vs: 38,
    });
    await Promise.all(entries.map(({ item }, index) => {
      const bounds = layout[index]?.bounds || { left: work.x + index * 38, top: work.y + index * 34, width, height };
      return cdp.setWindowBounds(item.port, bounds);
    }));
  } else {
    const cols = Math.ceil(Math.sqrt(entries.length)); const rows = Math.ceil(entries.length / cols);
    const width = Math.floor(work.width / cols); const height = Math.floor(work.height / rows);
    await Promise.all(entries.map(({ item }, index) => cdp.setWindowBounds(item.port, { left: work.x + (index % cols) * width, top: work.y + Math.floor(index / cols) * height, width, height })));
  }
  return { success: true, count: entries.length, mode: cascade ? 'cascade' : 'tile', platform: process.platform };
}

function isEnvironmentStartUrl(value) {
  const s = String(value || '');
  if (/openbrowser-start\.html/i.test(s)) return true;
  if (/openbrowser-start|openbrowser-native/i.test(s)) return true;
  if (/https?:\/\/127\.0\.0\.1:5032[6-9]\/?/i.test(s)) return true;
  return Boolean(engine?.isStartPageUrl?.(s));
}

function environmentStartUrl(entry) {
  // Prefer live start URL from running session (http://127.0.0.1:PORT/?id=...)
  if (entry?.item?.startUrl) return entry.item.startUrl;
  if (entry?.id && engine?.running?.get?.(entry.id)?.startUrl) {
    return engine.running.get(entry.id).startUrl;
  }
  try {
    const profile = entry?.item?.profile || engine?.profiles?.get?.(entry?.id);
    if (profile && engine?.startPageServer) {
      return engine.startPageServer.buildUrl(profile);
    }
  } catch (_) {}
  const root = entry?.item?.root || entry?.root;
  return root ? 'file:///' + path.join(root, 'openbrowser-start.html').replace(/\\/g, '/') : null;
}

async function syncTabsFromMaster(ids) {
  const entries = engine.runningWithCdp(sanitizeIds(ids));
  if (entries.length < 2) throw new Error('Select at least two running browser environments');
  const masterTabs = (await cdp.tabs(entries[0].item.port)).filter((tab) => !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://'));
  const urls = masterTabs.map((tab) => tab.url).filter(Boolean).slice(0, 20);
  for (const slave of entries.slice(1)) {
    const existing = (await cdp.tabs(slave.item.port)).filter((tab) => !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://'));
    for (let index = 0; index < urls.length; index += 1) {
      const targetUrl = isEnvironmentStartUrl(urls[index]) ? (environmentStartUrl(slave) || urls[index]) : urls[index];
      if (existing[index]) await cdp.call(existing[index].webSocketDebuggerUrl, 'Page.navigate', { url: targetUrl }).catch(() => cdp.navigate(slave.item.port, targetUrl));
      else await cdp.newTab(slave.item.port, targetUrl);
    }
  }
  return { success: true, master: entries[0].id, slaves: entries.length - 1, tabCount: urls.length };
}

function syncSnapshot() { return { ...syncState, selected: [...syncState.selected] }; }

function handleLiveSyncEvent(value) {
  emit(value);
  if ((value.type === 'sync-disconnected' || (value.type === 'live-sync' && value.active === false)) && syncState.active) {
    syncState = { active: false, master: null, selected: [...syncSelection] };
    emit({ type: 'sync-state', ...syncSnapshot(), reason: value.type });
  }
}

async function beginSync(ids = syncSelection) {
  let selected = sanitizeIds(ids);
  if (selected.length < 2) selected = engine.runningWithCdp([...engine.running.keys()]).map((entry) => entry.id);
  if (selected.length < 2) throw new Error('\u8bf7\u81f3\u5c11\u9009\u62e9\u4e24\u4e2a\u8fd0\u884c\u4e2d\u7684\u6d4f\u89c8\u5668\u73af\u5883');
  syncSelection = selected;
  await tile(selected, false);
  const tabs = await syncTabsFromMaster(selected);
  await liveSync.start(selected);
  syncState = { active: true, master: selected[0], selected };
  emit({ type: 'sync-state', ...syncSnapshot() });
  return { success: true, ...tabs, state: syncSnapshot() };
}

function endSync() {
  liveSync?.stop();
  syncState = { active: false, master: null, selected: [...syncSelection] };
  emit({ type: 'sync-state', ...syncSnapshot() });
  return { success: true, state: syncSnapshot() };
}

async function restartSync() {
  endSync();
  return beginSync(syncSelection);
}

async function runShortcut(action) {
  if (shortcutActionInFlight) return;
  shortcutActionInFlight = true;
  emit({ type: 'shortcut-triggered', action });
  try {
    if (action === 'start') await beginSync(syncSelection);
    else if (action === 'stop') endSync();
    else await restartSync();
  } catch (error) {
    emit({ type: 'sync-error', action, message: error.message });
  } finally { shortcutActionInFlight = false; }
}

function registerShortcutFallback() {
  if (shortcutFallbackRegistered) return;
  shortcutFallbackRegistered = true;
  const mod = process.platform === 'darwin' ? 'Command' : 'Control';
  const shortcuts = [
    [`${mod}+Alt+A`, 'start'],
    [`${mod}+Alt+S`, 'start'],
    [`${mod}+Alt+D`, 'stop'],
    [`${mod}+Alt+R`, 'restart'],
  ];
  // Keep Windows-style Control+Alt bindings available on macOS too.
  if (process.platform === 'darwin') {
    shortcuts.push(
      ['Control+Alt+A', 'start'],
      ['Control+Alt+S', 'start'],
      ['Control+Alt+D', 'stop'],
      ['Control+Alt+R', 'restart'],
    );
  }
  const registered = shortcuts.map(([accelerator, action]) => ({
    accelerator,
    registered: globalShortcut.register(accelerator, () => runShortcut(action)),
  }));
  emit({ type: 'shortcut-status', mode: process.platform === 'darwin' ? 'macos-global' : 'host-fallback', registered });
}

function registerTextShortcuts() {
  const mod = process.platform === 'darwin' ? 'Command' : 'Control';
  const shortcuts = [
    [`${mod}+Alt+F`, 'random-number'],
    [process.platform === 'darwin' ? 'Command+Option+Q' : 'Control+Q', 'same-text'],
    ['Shift+F1', 'specified-text'],
  ];
  if (process.platform === 'darwin') {
    shortcuts.push(
      ['Control+Alt+F', 'random-number'],
      ['Control+Q', 'same-text'],
    );
  }
  const registered = shortcuts.map(([accelerator, action]) => ({ accelerator, registered: globalShortcut.register(accelerator, () => emit({ type: 'text-shortcut', action })) }));
  emit({ type: 'text-shortcut-status', registered });
}

function startShortcutBridge() {
  const executable = path.join(__dirname, 'native-sync-hotkeys.exe');
  if (process.platform !== 'win32' || !fs.existsSync(executable)) {
    registerShortcutFallback();
    return;
  }
  const child = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  shortcutBridge = child;
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    const lines = output.split(/\r?\n/); output = lines.pop() || '';
    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      if (line === 'READY') emit({ type: 'shortcut-status', mode: 'windows-hook', active: true, accelerators: ['Ctrl+Alt+A', 'Ctrl+Alt+S', 'Ctrl+Alt+D', 'Ctrl+Alt+R'] });
      else if (line === 'start' || line === 'stop' || line === 'restart') runShortcut(line);
    }
  });
  let errorOutput = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errorOutput = (errorOutput + chunk).slice(-1000); });
  child.once('error', (error) => {
    if (shortcutBridge !== child) return;
    shortcutBridge = null;
    emit({ type: 'sync-error', action: 'shortcut-bridge', message: error.message });
    if (!quitting) registerShortcutFallback();
  });
  child.once('exit', (code) => {
    if (shortcutBridge !== child) return;
    shortcutBridge = null;
    if (!quitting) {
      emit({ type: 'sync-error', action: 'shortcut-bridge', message: errorOutput.trim() || ('Windows shortcut bridge exited: ' + code) });
      registerShortcutFallback();
    }
  });
}

function stopShortcutBridge() {
  const child = shortcutBridge;
  shortcutBridge = null;
  if (child && !child.killed) { try { child.kill(); } catch (_) {} }
  globalShortcut.unregisterAll();
  shortcutFallbackRegistered = false;
}
async function fetchStorePackage(url, proxyValue = null) {
  const initial = new URL(url);
  if (initial.protocol !== 'https:' || initial.hostname !== 'clients2.google.com') throw new Error('Chrome 商店下载地址无效');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const storeSession = session.fromPartition('persist:openbrowser-extension-store');
    if (proxyValue === 'system') await storeSession.setProxy({ mode: 'system' });
    else if (proxyValue) await storeSession.setProxy({ mode: 'fixed_servers', proxyRules: proxyValue });
    else await storeSession.setProxy({ mode: 'direct' });
    const response = await storeSession.fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 OpenBrowserLocal/3.0' } });
    const finalUrl = new URL(String(response.url || url));
    if (finalUrl.protocol !== 'https:' || !['clients2.google.com', 'clients2.googleusercontent.com'].includes(finalUrl.hostname)) throw new Error('Chrome 商店返回了不受信任的下载地址');
    if (!response.ok) throw new Error('Chrome 商店下载失败（HTTP ' + response.status + '）');
    const declared = Number(response.headers.get('content-length') || 0); if (declared > 120 * 1024 * 1024) throw new Error('扩展包超过 120 MB 限制');
    const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > 120 * 1024 * 1024) throw new Error('扩展包超过 120 MB 限制');
    return buffer;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接 Chrome 应用商店超时，请检查系统代理/VPN，或先给任一目标环境配置可访问 Google 的代理');
    throw error;
  } finally { clearTimeout(timer); }
}

const chromeStoreIconRequests = new Map();

function validChromeStoreId(value) {
  return /^[a-p]{32}$/i.test(String(value || '')) ? String(value).toLowerCase() : null;
}

function chromeStoreImageUrl(html) {
  const text = String(html || '');
  const match = text.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i)
    || text.match(/https:\/\/[a-z0-9.-]+\.googleusercontent\.com\/[^"'\\s>]+\.(?:png|jpe?g|webp)/i)
    || text.match(/https:\/\/lh3\.googleusercontent\.com\/[^"'\\s>]+/i);
  if (!match) return null;
  return String(match[1] || match[0]).replace(/&amp;/g, '&');
}

function isChromeStoreIconHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'chromewebstore.google.com' || host.endsWith('.googleusercontent.com') || host.endsWith('.gstatic.com') || host.endsWith('.ggpht.com');
}

function bufferToDataUrl(buffer, contentType = '') {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  let mime = type.startsWith('image/') ? type : '';
  if (!mime && buffer?.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) mime = 'image/png';
    else if (buffer[0] === 0xff && buffer[1] === 0xd8) mime = 'image/jpeg';
    else if (buffer[0] === 0x52 && buffer[1] === 0x49) mime = 'image/webp';
    else if (buffer[0] === 0x47 && buffer[1] === 0x49) mime = 'image/gif';
    else mime = 'image/png';
  }
  return `data:${mime || 'image/png'};base64,${Buffer.from(buffer).toString('base64')}`;
}

async function cachedIconDataUrl(cacheFile) {
  try {
    const data = await fsp.readFile(cacheFile);
    if (!data.length) return null;
    return bufferToDataUrl(data);
  } catch (_) {
    return null;
  }
}

function extensionIconSource(manifest) {
  const sets = [manifest?.icons, manifest?.action?.default_icon, manifest?.browser_action?.default_icon, manifest?.page_action?.default_icon];
  for (const set of sets) {
    if (typeof set === 'string') return set;
    if (!set || typeof set !== 'object') continue;
    const entry = Object.entries(set).filter(([, value]) => typeof value === 'string')
      .sort(([left], [right]) => Number(right) - Number(left))[0];
    if (entry) return entry[1];
  }
  return null;
}

function runArchiveCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: null, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

async function fetchChromeStoreMetadata(storeId) {
  const safeId = validChromeStoreId(storeId);
  if (!safeId) return null;
  const cacheDir = path.join(app.getPath('userData'), 'app-center-icons');
  const metadataFile = path.join(cacheDir, `${safeId}.json`);
  const cacheFile = path.join(cacheDir, `${safeId}.img`);
  try {
    const cached = JSON.parse(await fsp.readFile(metadataFile, 'utf8'));
    if (cached) {
      // Prefer live data URL from cached image bytes (sandbox-safe in renderer)
      const dataUrl = await cachedIconDataUrl(cacheFile);
      if (dataUrl) return { ...cached, icon_url: dataUrl };
      if (cached.icon_url && String(cached.icon_url).startsWith('data:')) return cached;
      if (cached.description) {
        // Try page icon scrape if only description was cached
        const icon = await fetchChromeStoreIcon(safeId);
        if (icon) {
          const next = { ...cached, icon_url: icon };
          await fsp.writeFile(metadataFile, JSON.stringify({ ...next, icon_url: 'file-cache' }), 'utf8').catch(() => {});
          return next;
        }
      }
      if (cached.icon_url || cached.description) return cached;
    }
  } catch (_) {}

  let metadata = { name: '', description: '', icon_url: null };
  try {
    const query = new URLSearchParams({ response: 'redirect', prodversion: '150.0.0.0', acceptformat: 'crx2,crx3', x: `id=${safeId}&installsource=ondemand&uc` });
    const buffer = await fetchStorePackage(`https://clients2.google.com/service/update2/crx?${query}`);
    const { crxDetails } = require('./store-extension');
    const zip = crxDetails(buffer).zip;
    const tempDir = path.join(cacheDir, `.metadata-${safeId}-${process.pid}-${Date.now()}`);
    const zipFile = `${tempDir}.zip`;
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(zipFile, zip);
      const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
      const manifest = JSON.parse((await runArchiveCommand(tar, ['-xOf', zipFile, 'manifest.json'])).toString('utf8'));
      metadata = {
        name: typeof manifest.name === 'string' ? manifest.name : '',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        icon_url: null,
      };
      const iconPath = extensionIconSource(manifest)?.replace(/^[/\\]+/, '');
      if (iconPath && !iconPath.split('/').includes('..')) {
        const image = await runArchiveCommand(tar, ['-xOf', zipFile, iconPath]);
        if (image.length && image.length <= 2 * 1024 * 1024) {
          await fsp.writeFile(cacheFile, image);
          metadata.icon_url = bufferToDataUrl(image);
        }
      }
    } finally {
      await fsp.rm(zipFile, { force: true }).catch(() => {});
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (_) {
    // CRX download often blocked; fall through to store page scrape
  }

  if (!metadata.icon_url) {
    const icon = await fetchChromeStoreIcon(safeId);
    if (icon) metadata.icon_url = icon;
  }
  if (metadata.icon_url || metadata.description) {
    await fsp.mkdir(cacheDir, { recursive: true }).catch(() => {});
    // Don't store huge data URLs in JSON — image is in .img cache
    await fsp.writeFile(metadataFile, JSON.stringify({
      name: metadata.name,
      description: metadata.description,
      icon_url: metadata.icon_url ? 'file-cache' : null,
    }), 'utf8').catch(() => {});
  }
  return (metadata.icon_url || metadata.description) ? metadata : null;
}

async function fetchChromeStoreIcon(storeId) {
  const safeId = validChromeStoreId(storeId);
  if (!safeId) return null;
  const cacheDir = path.join(app.getPath('userData'), 'app-center-icons');
  const cacheFile = path.join(cacheDir, `${safeId}.img`);
  const cached = await cachedIconDataUrl(cacheFile);
  if (cached) return cached;
  if (chromeStoreIconRequests.has(safeId)) return chromeStoreIconRequests.get(safeId);
  const request = (async () => {
    const storeSession = session.fromPartition('persist:openbrowser-extension-store');
    const pageUrl = `https://chromewebstore.google.com/detail/${safeId}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    let response;
    try {
      response = await storeSession.fetch(pageUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return null;
    const imageUrl = chromeStoreImageUrl(await response.text());
    if (!imageUrl) return null;
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== 'https:' || !isChromeStoreIconHost(parsed.hostname)) return null;
    const imageController = new AbortController();
    const imageTimeout = setTimeout(() => imageController.abort(), 20000);
    let imageResponse;
    try {
      imageResponse = await storeSession.fetch(parsed.toString(), {
        redirect: 'follow',
        signal: imageController.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
      });
    } finally {
      clearTimeout(imageTimeout);
    }
    const finalUrl = new URL(imageResponse.url || parsed.toString());
    const contentType = String(imageResponse.headers.get('content-type') || '').toLowerCase();
    if (!imageResponse.ok || !isChromeStoreIconHost(finalUrl.hostname)) return null;
    // Some CDNs omit content-type; accept by magic bytes later
    if (contentType && !contentType.startsWith('image/') && !contentType.includes('octet-stream')) return null;
    const data = Buffer.from(await imageResponse.arrayBuffer());
    if (!data.length || data.length > 2 * 1024 * 1024) return null;
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(cacheFile, data);
    return bufferToDataUrl(data, contentType);
  })().catch(() => null).finally(() => chromeStoreIconRequests.delete(safeId));
  chromeStoreIconRequests.set(safeId, request);
  return request;
}

/** Theme chrome colors for fused title bar (shipping-app look). */
const THEME_CHROME = {
  'pixel-workstation': { bg: '#0b1117', overlay: '#151f27', symbol: '#eef8f0' },
  'element-admin': { bg: '#e8e8ed', overlay: '#f5f5f7', symbol: '#1d1d1f' },
  'element-admin-dark': { bg: '#1c1c1e', overlay: '#2c2c2e', symbol: '#f5f5f7' },
  'retro-desktop': { bg: '#dddddd', overlay: '#eeeeee', symbol: '#000000' },
  default: { bg: '#0b1117', overlay: '#151f27', symbol: '#eef8f0' },
};

function chromeForTheme(themeId, colorMode) {
  if (themeId === 'element-admin' && colorMode === 'dark') return THEME_CHROME['element-admin-dark'];
  return THEME_CHROME[themeId] || THEME_CHROME.default;
}

function applyWindowChrome(win, themeId, colorMode) {
  if (!win || win.isDestroyed()) return;
  const chrome = chromeForTheme(themeId, colorMode);
  try { win.setBackgroundColor(chrome.bg); } catch (_) {}
  // Keep Windows caption overlay in sync with theme (light/dark native skin too)
  if (process.platform === 'win32' && typeof win.setTitleBarOverlay === 'function') {
    try {
      win.setTitleBarOverlay({
        color: chrome.overlay,
        symbolColor: chrome.symbol,
        height: 40,
      });
    } catch (_) {}
  }
}

async function createWindow() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const chrome = chromeForTheme('pixel-workstation');

  /** @type {Record<string, any>} */
  const options = {
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: 'OpenBrowser',
    icon: path.join(__dirname, 'assets', isMac && fs.existsSync(path.join(__dirname, 'assets', 'logo.icns'))
      ? 'logo.icns'
      : (fs.existsSync(path.join(__dirname, 'assets', 'logo.png')) ? 'logo.png' : 'logo.ico')),
    backgroundColor: chrome.bg,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  };

  // Fuse system title bar with in-app chrome (shipping-app style)
  if (isMac) {
    options.titleBarStyle = 'hiddenInset';
    // Sit in the empty strip above brand (brand is pushed down in CSS)
    options.trafficLightPosition = { x: 12, y: 14 };
    options.transparent = false;
  } else if (isWin) {
    // Same shipping-app fusion as macOS: custom chrome + native caption buttons
    options.titleBarStyle = 'hidden';
    options.frame = true;
    options.titleBarOverlay = {
      color: chrome.overlay,
      symbolColor: chrome.symbol,
      height: 40,
    };
  }

  const win = new BrowserWindow(options);
  mainWindow = win;
  windows.add(win);
  win.on('closed', () => { windows.delete(win); if (mainWindow === win) mainWindow = null; });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadFile('index.html');
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
}

app.whenReady().then(async () => {
  try { app.setName('OpenBrowser'); } catch (_) { /* ignore */ }
  try { process.title = 'OpenBrowser'; } catch (_) { /* ignore */ }
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = path.join(__dirname, 'assets', 'logo.png');
    try {
      if (fs.existsSync(dockIcon)) app.dock.setIcon(dockIcon);
    } catch (error) {
      console.warn('OpenBrowser Dock icon could not be applied:', error.message);
    }
  }
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = String(details.url || '');
    const allowed = url.startsWith('file:') || url.startsWith('data:') || url.startsWith('devtools:')
      || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url);
    callback({ cancel: !allowed });
  });
  const localSettings = await loadLocalSettings();
  const initialRootCheck = await ensureDataRootIsolationSecure(localSettings.profileDataRoot);
  if (!initialRootCheck.ok) throw new Error(initialRootCheck.message);
  engine = new BrowserEngine(app, { profileDataRoot: localSettings.profileDataRoot });
  liveSync = new LiveSyncController(engine, handleLiveSyncEvent);
  await engine.init(path.join(__dirname, 'bundled-extension'));
  try {
    const startPage = await engine.ensureStartPage();
    startPage.setEngine?.(engine);
    console.log('OpenBrowser start page:', startPage.info?.() || startPage.port);
  } catch (error) {
    console.error('OpenBrowser start page server failed:', error.message);
  }
  engine.on((value) => {
    emit(value);
    // Hub/ix style: when an opted-in profile closes, auto-push that env to cloud
    if (value?.type === 'profile-closed' && value.cloudBackup && value.profile?.id) {
      const cloud = localSettingsCache?.cloud || {};
      if (cloud.enabled) {
        runCloudProfilePush({
          profileIds: [value.profile.id],
          profiles: [value.profile],
          groups: localSettingsCache.uiGroups || [],
          cloud,
        }).catch((error) => {
          console.warn('OpenBrowser auto cloud push failed:', error.message);
          emit({ type: 'cloud-sync', action: 'profile-push-error', id: value.profile.id, message: error.message });
        });
      }
    }
  });
  engine.ensureKernelBootstrap().catch((error) => console.error('OpenBrowser kernel bootstrap failed:', error.message));
  startShortcutBridge();
  registerTextShortcuts();

  try {
    automation = await startAutomation({
      app,
      engine,
      liveSync,
      beginSync,
      endSync,
      restartSync,
      getSyncState: syncSnapshot,
      setSelection: (ids) => {
        syncSelection = sanitizeIds(ids);
        syncState.selected = [...syncSelection];
        emit({ type: 'sync-state', ...syncSnapshot() });
      },
      tile,
      emit,
      port: Number(process.env.OPENBROWSER_API_PORT || 50325),
      apiKey: process.env.OPENBROWSER_API_KEY || undefined,
    });
  } catch (error) {
    emit({ type: 'local-api-error', message: error.message });
    console.error('Local API failed to start:', error.message);
  }

  registerTrustedIpc('system:info', () => ({
    appVersion: app.getVersion(),
    chrome: process.versions.chrome,
    browsers: engine.candidates(),
    profileRoot: engine.getProfileDataRoot(),
    defaultProfileRoot: defaultProfileDataRoot,
    localApi: automation?.info || null,
    startPage: engine.startPageServer?.info?.() || null,
    kernel: engine.kernelStatus(),
    kernelSelection: engine.browserSelection(),
    preferIndependentKernel: engine.preferIndependentKernel,
    allowSystemBrowserFallback: engine.allowSystemBrowserFallback,
    titleBarIntegrated: process.platform === 'darwin' || process.platform === 'win32',
    platform: process.platform,
  }));
  registerTrustedIpc('app:update-check', () => checkAppUpdate());
  registerTrustedIpc('app:update-download', () => downloadAppUpdate());
  registerTrustedIpc('app:open-github', async () => {
    const url = `https://github.com/${UPDATE_REPOSITORY}`;
    await shell.openExternal(url);
    return { success: true, url };
  });
  registerTrustedIpc('system:set-ui-chrome', (_event, payload) => {
    const win = BrowserWindow.fromWebContents(_event.sender) || mainWindow;
    const themeId = typeof payload === 'string' ? payload : String(payload?.themeId || '');
    const colorMode = typeof payload === 'object' && payload ? String(payload.colorMode || 'light') : 'light';
    applyWindowChrome(win, themeId, colorMode);
    return { success: true, theme: themeId, colorMode };
  });
  registerTrustedIpc('kernel:status', () => engine.kernelStatus());
  registerTrustedIpc('kernel:download', async (_event, force) => engine.ensureIndependentKernel(Boolean(force)));
  registerTrustedIpc('kernel:check-update', async () => engine.checkKernelUpdate());
  registerTrustedIpc('kernel:set-custom', async (_event, binaryPath) => engine.setCustomKernel(String(binaryPath || '')));
  registerTrustedIpc('kernel:policy', async (_event, policy) => engine.setKernelPolicy(policy || {}));
  registerTrustedIpc('kernel:choose-custom', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择独立 Chromium / Chrome 可执行文件',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Executable', extensions: ['exe'] }]
        : [{ name: 'All', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const kernel = await engine.setCustomKernel(result.filePaths[0]);
    return { canceled: false, kernel };
  });
  registerTrustedIpc('system:get-storage', () => ({ profileRoot: engine.getProfileDataRoot(), defaultProfileRoot: defaultProfileDataRoot, running: engine.running.size }));
  registerTrustedIpc('system:choose-storage', async () => {
    if (engine.running.size) throw new Error('\u8bf7\u5148\u505c\u6b62\u6240\u6709\u73af\u5883\uff0c\u518d\u4fee\u6539\u6570\u636e\u4fdd\u5b58\u4f4d\u7f6e');
    const options = { title: '\u9009\u62e9\u73af\u5883\u6570\u636e\u4fdd\u5b58\u76ee\u5f55', defaultPath: engine.getProfileDataRoot(), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] };
    const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { canceled: true, profileRoot: engine.getProfileDataRoot(), defaultProfileRoot: defaultProfileDataRoot };
    return { canceled: false, ...(await updateProfileDataRoot(result.filePaths[0])) };
  });
  registerTrustedIpc('system:reset-storage', () => updateProfileDataRoot(defaultProfileDataRoot));
  registerTrustedIpc('system:open-storage', async () => {
    const profileRoot = engine.getProfileDataRoot(); await fsp.mkdir(profileRoot, { recursive: true });
    const message = await shell.openPath(profileRoot); if (message) throw new Error(message);
    return { success: true, profileRoot };
  });
  registerTrustedIpc('cloud:get-config', async () => {
    await loadLocalSettings();
    return localSettingsCache.cloud || cloudSync.defaultCloudConfig();
  });
  registerTrustedIpc('cloud:set-config', async (_event, cloud) => {
    await loadLocalSettings();
    const next = { ...cloudSync.defaultCloudConfig(), ...(localSettingsCache.cloud || {}), ...(cloud || {}) };
    await saveLocalSettings({ ...localSettingsCache, cloud: next });
    return next;
  });
  registerTrustedIpc('cloud:choose-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择云备份本地目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, dir: result.filePaths[0] };
  });
  registerTrustedIpc('cloud:backup', async (_event, payload) => runCloudBackup(payload || {}));
  registerTrustedIpc('cloud:restore', async (_event, payload) => runCloudRestore(payload || {}));
  registerTrustedIpc('cloud:profile-push', async (_event, payload) => runCloudProfilePush(payload || {}));
  registerTrustedIpc('cloud:profile-pull', async (_event, payload) => runCloudProfilePull(payload || {}));
  registerTrustedIpc('cloud:export-file', async (_event, payload) => {
    const cloud = { ...localSettingsCache.cloud, ...(payload?.cloud || {}) };
    const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [...(engine?.profiles?.values?.() || [])];
    const groups = Array.isArray(payload?.groups) ? payload.groups : (localSettingsCache.uiGroups || []);
    let proxies = [];
    try { proxies = automation?.proxyStore?.list?.({}) || []; } catch (_) {}
    const { buffer, meta } = await cloudSync.buildBackupPackage({
      profiles,
      groups,
      proxies,
      settings: {},
      profileDataRoot: engine?.getProfileDataRoot?.() || localSettingsCache.profileDataRoot,
      includeBrowserData: cloud.includeBrowserData !== false,
      passphrase: cloud.passphrase || '',
      profileIds: payload?.profileIds || null,
    });
    const result = await dialog.showSaveDialog({
      title: '导出 OpenBrowser 备份',
      defaultPath: `openbrowser-backup-${Date.now()}.obpack`,
      filters: [{ name: 'OpenBrowser Backup', extensions: ['obpack'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, buffer);
    return { success: true, path: result.filePath, meta };
  });
  registerTrustedIpc('cloud:import-file', async (_event, payload) => {
    const result = await dialog.showOpenDialog({
      title: '导入 OpenBrowser 备份',
      properties: ['openFile'],
      filters: [{ name: 'OpenBrowser Backup', extensions: ['obpack', 'json', 'gz'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const buffer = await fsp.readFile(result.filePaths[0]);
    const body = await cloudSync.parseBackupPackage(buffer, payload?.passphrase || localSettingsCache.cloud?.passphrase || '');
    const mode = String(payload?.mode || localSettingsCache.cloud?.restoreMode || 'merge');
    const applied = await applyBackupBody(body, {
      mode,
      localProfiles: payload?.localProfiles,
      localGroups: payload?.localGroups,
    });
    return { success: true, mode, ...applied };
  });
  registerTrustedIpc('profiles:sync', (_event, profiles) => engine.syncProfiles(profiles));
  registerTrustedIpc('profiles:delete', async (_event, payload) => {
    const ids = sanitizeIds(payload?.ids || []);
    if (syncState.active && syncState.selected.some((id) => ids.includes(id))) endSync();
    syncSelection = syncSelection.filter((id) => !ids.includes(id));
    syncState = { ...syncState, selected: syncState.selected.filter((id) => !ids.includes(id)) };
    emit({ type: 'sync-state', ...syncSnapshot() });
    return engine.deleteProfiles(ids, payload?.deleteData !== false);
  });
  registerTrustedIpc('profiles:start', (_event, profile) => engine.start(profile));
  registerTrustedIpc('profiles:stop', (_event, id) => engine.stop(id));
  registerTrustedIpc('profiles:clear-cache-cookies', (_event, id) => engine.clearProfileCacheAndCookies(id));
  registerTrustedIpc('profiles:status', () => engine.status());
  registerTrustedIpc('profiles:test-proxy', (_event, profile) => engine.testProxy(profile));
  registerTrustedIpc('profiles:check-proxy', (_event, profile) => engine.checkProxy(profile));

  registerTrustedIpc('extensions:list', () => engine.listExtensions());
  registerTrustedIpc('extensions:add-folder', async () => {
    const result = await dialog.showOpenDialog({ title: '选择已解压的 Chrome 扩展目录', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const extension = await engine.addExtension(result.filePaths[0]);
    const ids = [...engine.profiles.keys()]; const running = ids.filter((id) => engine.running.has(id));
    if (ids.length) await engine.assignExtension(extension.id, ids, true);
    for (const id of running) await engine.stop(id);
    for (const id of running) { const profile = engine.profiles.get(id); if (profile) await engine.start(profile); }
    return { canceled: false, extension, assigned: ids.length, restarted: running.length };
  });
  registerTrustedIpc('extensions:add-store', async (_event, payload) => {
    const ids = sanitizeIds(payload.profileIds || []);
    const storeUrl = String(payload.url || ''); let extension;
    try { extension = await engine.addStoreExtension(storeUrl); }
    catch (directError) {
      try { extension = await engine.addStoreExtension(storeUrl, (url) => fetchStorePackage(url, 'system')); }
      catch (systemError) { throw new Error(`Chrome 应用商店下载失败。直连：${directError.message}；系统代理：${systemError.message}`); }
    }
    const running = new Set(engine.status().filter((item) => item.running && ids.includes(item.id)).map((item) => item.id));
    if (ids.length) await engine.assignExtension(extension.id, ids, true);
    if (payload.restart) {
      for (const id of running) await engine.stop(id);
      for (const id of running) { const profile = engine.profiles.get(id); if (profile) await engine.start(profile); }
    }
    return { extension, assigned: ids.length, restarted: payload.restart ? running.size : 0 };
  });
  registerTrustedIpc('extensions:assign', (_event, payload) => engine.assignExtension(String(payload.extensionId), sanitizeIds(payload.profileIds), Boolean(payload.enabled)));
  registerTrustedIpc('extensions:toggle-all', async (_event, payload) => {
    const extensionId = String(payload.extensionId || ''); const enabled = Boolean(payload.enabled);
    const ids = [...engine.profiles.keys()]; const running = ids.filter((id) => engine.running.has(id));
    await engine.assignExtension(extensionId, ids, enabled);
    for (const id of running) await engine.stop(id);
    for (const id of running) { const profile = engine.profiles.get(id); if (profile) await engine.start(profile); }
    return { success: true, enabled, affected: ids.length, restarted: running.length };
  });
  registerTrustedIpc('extensions:remove', (_event, id) => engine.removeExtension(String(id)));

  registerTrustedIpc('sync:sessions', () => engine.sessions());
  registerTrustedIpc('sync:selection', (_event, ids) => { syncSelection = sanitizeIds(ids); syncState.selected = [...syncSelection]; emit({ type: 'sync-state', ...syncSnapshot() }); return syncSnapshot(); });
  registerTrustedIpc('sync:state', () => syncSnapshot());
  registerTrustedIpc('sync:settings:get', () => liveSync.getSettings());
  registerTrustedIpc('sync:settings:set', (_event, value) => liveSync.updateSettings(value));
  registerTrustedIpc('sync:start', (_event, ids) => beginSync(ids));
  registerTrustedIpc('sync:stop', () => endSync());
  registerTrustedIpc('sync:restart', () => restartSync());
  registerTrustedIpc('sync:window', async (_event, payload) => {
    const ids = sanitizeIds(payload.ids); const entries = engine.runningWithCdp(ids); const action = String(payload.action);
    if (action === 'tile') return tile(ids, false);
    if (action === 'cascade') return tile(ids, true);
    if (!['minimized', 'normal', 'maximized'].includes(action)) throw new Error('Unknown window action');
    await Promise.all(entries.map(({ item }) => cdp.setWindowState(item.port, action)));
    return { success: true, count: entries.length };
  });
  registerTrustedIpc('sync:text', async (_event, payload) => {
    const ids = sanitizeIds(payload.ids); const action = String(payload.action); const text = String(payload.text || '').slice(0, 100000);
    const entries = new Map(engine.runningWithCdp(ids).map((entry) => [entry.id, entry]));
    const min = Math.max(0, Math.min(5, Number(payload.delayMin) || 0)); const max = Math.max(min, Math.min(5, Number(payload.delayMax) || min));
    const profiles = []; const failures = [];
    for (const id of ids) {
      const entry = entries.get(id);
      if (!entry) { failures.push({ id, message: 'Environment is not running or has no CDP session' }); continue; }
      try {
        let result;
        if (action === 'clear') result = await cdp.clearFocused(entry.item.port); else {
          const delay = min + Math.random() * (max - min); if (delay) await sleep(delay * 1000);
          result = await cdp.insertText(entry.item.port, text);
        }
        profiles.push({ id, targetId: result.targetId, textLength: text.length });
      } catch (error) { failures.push({ id, message: error.message }); }
    }
    return { success: failures.length === 0 && profiles.length === ids.length, profiles, failures };
  });
  registerTrustedIpc('sync:text-batch', async (_event, payload) => {
    const ids = sanitizeIds(payload.ids);
    const texts = Array.isArray(payload.texts) ? payload.texts.map((value) => String(value || '').slice(0, 100000)) : [];
    if (!ids.length || texts.length !== ids.length) throw new Error('Text assignments must match the selected environments');
    const assignments = new Map(ids.map((id, index) => [id, texts[index]]));
    const entries = new Map(engine.runningWithCdp(ids).map((entry) => [entry.id, entry]));
    const min = Math.max(0, Math.min(5, Number(payload.delayMin) || 0)); const max = Math.max(min, Math.min(5, Number(payload.delayMax) || min));
    const profiles = []; const failures = [];
    for (const id of ids) {
      const entry = entries.get(id); const assignedText = assignments.get(id) || '';
      if (!entry) { failures.push({ id, message: 'Environment is not running or has no CDP session' }); continue; }
      try {
        const delay = min + Math.random() * (max - min); if (delay) await sleep(delay * 1000);
        const result = await cdp.insertText(entry.item.port, assignedText);
        profiles.push({ id, targetId: result.targetId, textLength: assignedText.length });
      } catch (error) { failures.push({ id, message: error.message }); }
    }
    return { success: failures.length === 0 && profiles.length === ids.length, profiles, failures };
  });
  registerTrustedIpc('sync:tabs', async (_event, payload) => {
    const ids = sanitizeIds(payload.ids); const entries = engine.runningWithCdp(ids); const action = String(payload.action); const value = payload.payload || {};
    if (action === 'sync') return syncTabsFromMaster(ids);
    if (action === 'list') return engine.sessions();
    for (const { item } of entries) {
      if (action === 'new') await cdp.newTab(item.port, String(value.url || 'about:blank'));
      else if (action === 'navigate') await cdp.navigate(item.port, String(value.url || 'about:blank'));
      else if (action === 'reload') await cdp.reload(item.port);
      else if (action === 'close') { const tab = await cdp.firstTab(item.port); if (tab) await cdp.closeTab(item.port, tab.id); }
      else throw new Error('Unknown tab action');
    }
    return { success: true, count: entries.length };
  });

  registerTrustedIpc('automation:local-api', () => automation?.info || null);
  registerTrustedIpc('automation:fingerprint', (_event, id) => engine.fingerprintFor(String(id || '')));
  registerTrustedIpc('automation:isolation-audit', () => engine.isolationAudit());
  registerTrustedIpc('automation:build-ua', (_event, payload = {}) => {
    const { buildUaProfile, randomUaForSeed, parseOsFromUa } = require('./automation/user-agent');
    const crypto = require('crypto');
    if (payload?.random) {
      const seed = crypto.randomBytes(4).readUInt32BE(0);
      return randomUaForSeed(seed, {
        majors: payload.chromeMajor ? [Number(payload.chromeMajor)] : undefined,
        osList: payload.os ? [payload.os] : undefined,
      });
    }
    const osMap = { Windows: 'windows', windows: 'windows', macOS: 'macos', macos: 'macos', Mac: 'macos', Linux: 'linux', linux: 'linux' };
    const os = osMap[payload.os] || payload.os || parseOsFromUa(payload.userAgent || '') || undefined;
    return buildUaProfile({
      userAgent: payload.userAgent || '',
      os,
      chromeMajor: Number(payload.chromeMajor) || undefined,
      chromeFull: payload.chromeFull || payload.fullVersion,
      reduced: payload.reduced !== false,
    });
  });

  const proxyStore = () => {
    if (!automation?.proxyStore) throw new Error('代理库未就绪');
    return automation.proxyStore;
  };
  registerTrustedIpc('proxy:list', (_event, filter) => proxyStore().list(filter || {}));
  registerTrustedIpc('proxy:get', (_event, id) => proxyStore().get(String(id || '')));
  registerTrustedIpc('proxy:create', (_event, payload) => proxyStore().create(payload || {}));
  registerTrustedIpc('proxy:update', (_event, payload) => {
    const id = String(payload?.id || payload?.proxy_id || '');
    if (!id) throw new Error('id required');
    return proxyStore().update(id, payload || {});
  });
  registerTrustedIpc('proxy:delete', (_event, ids) => proxyStore().remove(ids));
  registerTrustedIpc('proxy:check', async (_event, payload) => {
    const store = proxyStore();
    const id = String(payload?.id || payload?.proxy_id || '');
    const item = id ? store.get(id) : null;
    const raw = item?.raw || payload?.proxy || payload?.raw;
    if (!raw) throw new Error('proxy required');
    const result = await engine.testProxy({
      id: 'proxy-check',
      name: 'proxy-check',
      proxy: raw,
      proxyMeta: { ipChannel: item?.ipChannel || payload?.ipChannel || 'ip-api' },
    });
    if (item) await store.markCheck(item.id, result);
    return { ...result, proxy: item || null };
  });
  registerTrustedIpc('automation:app-center', (_event, filter) => {
    if (!automation?.appCenter) return { list: { builtin: [], recommended: [], local: [] }, counts: { builtin: 0, recommended: 0, local: 0, installed: 0 } };
    return automation.appCenter.list(filter || {});
  });
  registerTrustedIpc('automation:app-center-icons', async (_event, storeIds) => {
    const ids = [...new Set((Array.isArray(storeIds) ? storeIds : []).map(validChromeStoreId).filter(Boolean))].slice(0, 50);
    const entries = await Promise.all(ids.map(async (id) => [id, await fetchChromeStoreIcon(id)]));
    return Object.fromEntries(entries.filter(([, iconUrl]) => iconUrl));
  });
  registerTrustedIpc('automation:app-center-metadata', async (_event, storeIds) => {
    const ids = [...new Set((Array.isArray(storeIds) ? storeIds : []).map(validChromeStoreId).filter(Boolean))].slice(0, 50);
    const entries = await Promise.all(ids.map(async (id) => [id, await fetchChromeStoreMetadata(id).catch(() => null)]));
    return Object.fromEntries(entries.filter(([, metadata]) => metadata));
  });
  registerTrustedIpc('automation:rpa-status', () => automation?.rpaEngine?.getStatus?.() || { running: [], count: 0 });
  registerTrustedIpc('automation:rpa-plans', () => automation?.rpaStore?.listPlans?.() || []);
  registerTrustedIpc('automation:rpa-tasks', (_event, filter) => automation?.rpaStore?.listTasks?.(filter || {}) || []);
  registerTrustedIpc('automation:rpa-get-plan', (_event, id) => automation?.rpaStore?.getPlan?.(String(id || '')) || null);
  registerTrustedIpc('automation:rpa-save-plan', (_event, plan) => {
    if (!automation) throw new Error('Automation stack is not ready');
    return automation.rpaStore.upsertPlan(plan);
  });
  registerTrustedIpc('automation:rpa-delete-plan', (_event, id) => {
    if (!automation) throw new Error('Automation stack is not ready');
    return automation.rpaStore.deletePlan(String(id || ''));
  });
  registerTrustedIpc('automation:rpa-run', async (_event, payload) => {
    if (!automation) throw new Error('Automation stack is not ready');
    if (payload?.plan_id) return automation.rpaEngine.runPlan(String(payload.plan_id), payload);
    if (payload?.task_id) return automation.rpaEngine.runTask(String(payload.task_id), payload);
    if (Array.isArray(payload?.steps)) {
      const task = await automation.rpaStore.createTask({
        profile_id: String(payload.profile_id || ''),
        process_name: String(payload.name || 'ipc-rpa'),
        steps: payload.steps,
      });
      return automation.rpaEngine.runTask(task.id, payload);
    }
    throw new Error('plan_id, task_id or steps required');
  });
  registerTrustedIpc('automation:rpa-stop', (_event, taskId) => automation?.rpaEngine?.stop?.(taskId || null));
  registerTrustedIpc('automation:rpa-templates', (_event, filter) => {
    if (!automation?.rpaStore) return { list: [], categories: ['全部'], config: {} };
    return {
      list: automation.rpaStore.listTemplates(filter || {}),
      categories: automation.rpaStore.listTemplateCategories(),
      config: automation.rpaStore.getConfig?.() || {},
    };
  });
  registerTrustedIpc('automation:rpa-template-get', (_event, id) => automation?.rpaStore?.getTemplate?.(String(id || '')) || null);
  registerTrustedIpc('automation:rpa-template-save', (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    return automation.rpaStore.upsertTemplate(payload || {});
  });
  registerTrustedIpc('automation:rpa-template-save-as', (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    return automation.rpaStore.saveAsTemplate(payload || {});
  });
  registerTrustedIpc('automation:rpa-template-delete', (_event, id) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    return automation.rpaStore.deleteTemplate(String(id || ''));
  });
  registerTrustedIpc('automation:rpa-template-install', (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    const id = String(payload?.id || payload?.template_id || '');
    if (!id) throw new Error('template id required');
    return automation.rpaStore.installTemplate(id, payload || {});
  });
  registerTrustedIpc('automation:rpa-template-sync-remote', async (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    // Remote sync is opt-in only: caller must pass base explicitly (no hard-coded host).
    if (payload?.token || payload?.cookie || payload?.apiKey || payload?.base) {
      await automation.rpaStore.setConfig({
        remoteToken: payload.token || undefined,
        remoteCookie: payload.cookie || undefined,
        remoteApiKey: payload.apiKey || undefined,
        remoteApiBase: payload.base || undefined,
        remoteApiOrigin: payload.origin || undefined,
        remoteLang: payload.lang || 'zh-CN',
      });
    }
    return automation.rpaStore.syncRemoteTemplates(payload || {});
  });
  registerTrustedIpc('automation:rpa-template-config', async (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    if (payload && typeof payload === 'object' && Object.keys(payload).length) {
      return automation.rpaStore.setConfig(payload);
    }
    return automation.rpaStore.getConfig();
  });
  registerTrustedIpc('automation:rpa-template-import-remote', async (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    return automation.rpaStore.importRemoteTemplatePayload(payload || {});
  });
  registerTrustedIpc('automation:rpa-template-export', async (_event, id) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    const bundle = id
      ? automation.rpaStore.exportTemplate(String(id))
      : automation.rpaStore.exportAllCustomTemplates();
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, {
          title: '导出自动脚本模版',
          defaultPath: `openbrowser-rpa-template-${Date.now()}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
      : await dialog.showSaveDialog({
          title: '导出自动脚本模版',
          defaultPath: `openbrowser-rpa-template-${Date.now()}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    return { success: true, path: result.filePath, count: bundle.templates?.length || 0 };
  });
  registerTrustedIpc('automation:rpa-template-import', async () => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, {
          title: '导入自动脚本模版 JSON',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
      : await dialog.showOpenDialog({
          title: '导入自动脚本模版 JSON',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const raw = await fsp.readFile(result.filePaths[0], 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) {
      throw new Error('JSON 解析失败：' + error.message);
    }
    return automation.rpaStore.importTemplates(parsed);
  });
  registerTrustedIpc('automation:mcp-paths', () => ({
    mcpScript: path.join(__dirname, 'automation', 'mcp-server.js'),
    appRoot: __dirname,
    port: automation?.info?.port || Number(process.env.OPENBROWSER_API_PORT || 50325),
    apiKey: automation?.apiKey || process.env.OPENBROWSER_API_KEY || '',
    localApi: automation?.info || null,
  }));

  await createWindow();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  const cloud = localSettingsCache?.cloud || {};
  Promise.resolve()
    .then(async () => {
      if (cloud.enabled && cloud.autoSyncOnQuit) {
        try {
          await runCloudBackup({
            profiles: [...(engine?.profiles?.values?.() || [])],
            groups: localSettingsCache.uiGroups || [],
            cloud,
          });
        } catch (error) {
          console.warn('OpenBrowser quit auto-backup failed:', error.message);
          try {
            localSettingsCache.cloud = { ...cloud, lastError: error.message };
            await saveLocalSettings(localSettingsCache);
          } catch (_) {}
        }
      }
    })
    .then(() => automation?.stop?.())
    .then(() => (engine ? engine.stopAll() : null))
    .finally(() => app.quit());
});
app.on('will-quit', () => {
  stopShortcutBridge();
  automation?.stop?.().catch(() => {});
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
