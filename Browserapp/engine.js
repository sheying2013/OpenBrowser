const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const cdp = require('./cdp');
const { addChromeStoreExtension } = require('./store-extension');
const { reconcileOnConnection, portConnection } = require('./extension-pipe');
const { parseProxy, displayProxy, startAuthenticatedProxy, lookupProxyCountry, lookupDirectCountry, extractProxyFromApi, invokeProxyRefresh, classifyProxyError } = require('./proxy-forwarder');
const { resolveProfileLanguage, localeFromCountryCode } = require('./automation/locale-from-country');
const { mergeLoadExtensionArgs } = require('./automation/protocol/app-center-protocol');
const { toFileUrl, killProcessTree } = require('./automation/protocol/cross-platform');
const { buildFingerprint, buildWorkerInjectionScript, chromeArgsForFingerprint, applyFingerprintToTab } = require('./automation/fingerprint');
const { acquireProfileLock, releaseProfileLock, auditIsolation, isSystemBrowserExecutable, isPathInsideOrEqual, validateDataRootIsolationSecure, validateProfileRootSecure, assertProfileId, assertSafeProfileChild } = require('./automation/isolation');
const { BrowserKernelManager } = require('./automation/browser-kernel');
const { ensureStartPageServer, getStartPageServer } = require('./automation/start-page-server');

const KERNEL_POLICY_VERSION = 2;

async function retryProxyOperation(operation, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (/authentication failed|username or password|rejected available authentication/i.test(String(error?.message || '')) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}

async function assertExtensionTreeSafe(root) {
  const resolved = path.resolve(root);
  const rootStat = await fsp.lstat(resolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Extension root must be a real directory');
  const pending = [resolved];
  let entriesSeen = 0;
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      entriesSeen += 1;
      if (entriesSeen > 20000) throw new Error('Extension contains too many files');
      const target = path.join(current, entry.name);
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) throw new Error('Extension must not contain symbolic links or junctions');
      if (stat.isDirectory()) pending.push(target);
    }
  }
  return fsp.realpath(resolved);
}

class BrowserEngine {
  constructor(app, options = {}) {
    this.app = app;
    this.profiles = new Map();
    this.running = new Map();
    this.networkInfo = new Map();
    this.extensions = new Map();
    this.assignments = new Map();
    this.listeners = new Set();
    this.stateFile = path.join(app.getPath('userData'), 'openbrowser-engine.json');
    const profileDataRoot = String(options.profileDataRoot || path.join(app.getPath('userData'), 'browser-profiles-v2'));
    const profileDataRootCheck = validateDataRootIsolationSecure(profileDataRoot);
    if (!profileDataRootCheck.ok) throw new Error(profileDataRootCheck.message);
    this.profileDataRootPath = profileDataRootCheck.root;
    this.kernelManager = new BrowserKernelManager(app.getPath('userData'), {
      onProgress: (p) => this.emit({ type: 'kernel-progress', ...p }),
    });
    this.preferIndependentKernel = options.preferIndependentKernel !== false;
    // A fingerprint environment must never launch the user's installed browser.
    this.allowSystemBrowserFallback = false;
    this.kernelBootstrapPromise = null;
    this.startPageServer = null;
  }

  async ensureStartPage() {
    if (this.startPageServer?.server) {
      this.startPageServer.setEngine?.(this);
      return this.startPageServer;
    }
    this.startPageServer = await ensureStartPageServer({ engine: this });
    this.startPageServer.setEngine?.(this);
    return this.startPageServer;
  }

  candidates() {
    const list = [];
    // 1) Independent kernel (Donut Wayfern / CfT / custom) — first priority
    const independent = this.kernelManager.resolveInstalled();
    if (independent) list.push({ name: independent.name, path: independent.path, independent: true, version: independent.version, source: independent.source });

    // 2) Optional system browsers (fallback only if allowed)
    if (this.allowSystemBrowserFallback) {
      const home = process.env.HOME || '';
      const local = process.env.LOCALAPPDATA || '';
      const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
      const pfx = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const system = process.platform === 'darwin' ? [
        { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
        { name: 'Google Chrome', path: path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') },
        { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
        { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' }
      ] : process.platform === 'linux' ? [
        { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
        { name: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
        { name: 'Chromium', path: '/usr/bin/chromium' },
        { name: 'Chromium', path: '/usr/bin/chromium-browser' }
      ] : [
        { name: 'Google Chrome', path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
        { name: 'Google Chrome', path: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') },
        { name: 'Chromium', path: path.join(local, 'Chromium', 'Application', 'chrome.exe') },
        { name: 'Microsoft Edge', path: path.join(pfx, 'Microsoft', 'Edge', 'Application', 'msedge.exe') }
      ];
      for (const item of system) list.push({ ...item, independent: false });
    }
    return list.filter((item, index, all) => fs.existsSync(item.path) && all.findIndex((other) => other.path === item.path) === index);
  }

  async init(bundledExtensionPath) {
    await this.kernelManager.loadMeta();
    let migrateKernelPolicy = false;
    try {
      const saved = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
      for (const extension of saved.extensions || []) if (fs.existsSync(extension.path)) this.extensions.set(extension.id, extension);
      for (const [profileId, ids] of Object.entries(saved.assignments || {})) this.assignments.set(profileId, new Set(ids));
      if (typeof saved.preferIndependentKernel === 'boolean') this.preferIndependentKernel = saved.preferIndependentKernel;
      if (saved.kernelPolicyVersion !== KERNEL_POLICY_VERSION || saved.allowSystemBrowserFallback === true) {
        // Prior releases enabled fallback by default. Do not silently launch a
        // local browser after the OpenBrowser migration.
        this.allowSystemBrowserFallback = false;
        migrateKernelPolicy = true;
      }
    } catch (_) {}
    if (bundledExtensionPath && fs.existsSync(path.join(bundledExtensionPath, 'manifest.json'))) {
      const builtIn = await this.readExtension(bundledExtensionPath, true);
      const obsoleteBuiltInIds = [...this.extensions.values()]
        .filter((extension) => extension.builtIn && path.basename(extension.path) === 'bundled-extension' && extension.id !== builtIn.id)
        .map((extension) => extension.id);

      if (obsoleteBuiltInIds.length) {
        for (const assigned of this.assignments.values()) {
          const hadOldMarker = obsoleteBuiltInIds.some((id) => assigned.has(id));
          for (const id of obsoleteBuiltInIds) assigned.delete(id);
          if (hadOldMarker) assigned.add(builtIn.id);
        }
        for (const id of obsoleteBuiltInIds) this.extensions.delete(id);
      }
      this.extensions.set(builtIn.id, builtIn);
      await this.persist();
    }
    if (migrateKernelPolicy) await this.persist();
  }

  async persist() {
    await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
    const assignments = Object.fromEntries([...this.assignments].map(([id, values]) => [id, [...values]]));
    await fsp.writeFile(this.stateFile, JSON.stringify({
      extensions: [...this.extensions.values()],
      assignments,
      kernelPolicyVersion: KERNEL_POLICY_VERSION,
      preferIndependentKernel: this.preferIndependentKernel,
      allowSystemBrowserFallback: this.allowSystemBrowserFallback,
    }, null, 2), 'utf8');
  }

  kernelStatus() {
    return this.kernelManager.status();
  }

  async ensureKernelBootstrap() {
    if (this.kernelStatus().installed) return this.kernelStatus().kernel;
    if (!this.kernelBootstrapPromise) {
      this.emit({ type: 'kernel-progress', phase: 'bootstrap', message: '首次启动：正在准备独立浏览器内核…' });
      this.kernelBootstrapPromise = this.ensureIndependentKernel(false)
        .catch((error) => {
          this.emit({ type: 'kernel-error', message: '自动下载独立内核失败：' + error.message });
          throw error;
        })
        .finally(() => { this.kernelBootstrapPromise = null; });
    }
    return this.kernelBootstrapPromise;
  }

  async ensureIndependentKernel(force = false) {
    const kernel = await this.kernelManager.ensureLatest(force);
    this.emit({ type: 'kernel-ready', kernel });
    return kernel;
  }

  async checkKernelUpdate() {
    return this.kernelManager.checkUpdate();
  }

  async setCustomKernel(binaryPath) {
    const kernel = await this.kernelManager.setCustomBinary(binaryPath);
    this.emit({ type: 'kernel-ready', kernel });
    return kernel;
  }

  async setKernelPolicy({ preferIndependentKernel, allowSystemBrowserFallback } = {}) {
    if (typeof preferIndependentKernel === 'boolean') this.preferIndependentKernel = preferIndependentKernel;
    this.allowSystemBrowserFallback = false;
    await this.persist();
    return {
      preferIndependentKernel: this.preferIndependentKernel,
      allowSystemBrowserFallback: this.allowSystemBrowserFallback,
      status: this.kernelStatus(),
    };
  }

  sanitizeProfile(value) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.name !== 'string') throw new Error('Invalid profile');
    const id = assertProfileId(value.id);
    const privacyValue = value.privacy && typeof value.privacy === 'object' ? value.privacy : {};
    const advancedValue = value.advanced && typeof value.advanced === 'object' ? value.advanced : {};
    const proxyMetaValue = value.proxyMeta && typeof value.proxyMeta === 'object' ? value.proxyMeta : {};
    const platformValue = value.platform && typeof value.platform === 'object' ? value.platform : {};
    const allowed = (candidate, values, fallback) => values.includes(String(candidate || '')) ? String(candidate) : fallback;
    const finite = (candidate) => candidate !== '' && candidate !== null && candidate !== undefined && Number.isFinite(Number(candidate)) ? Number(candidate) : null;
    const width = Math.min(7680, Math.max(640, Number(value.width) || 1280)); const height = Math.min(4320, Math.max(480, Number(value.height) || 820));
    const number = Number.parseInt(value.number, 10);
    const parseLimitedOption = (candidate, values) => {
      if (candidate === '' || candidate === null || candidate === undefined) return null;
      const value = Number(candidate);
      return values.includes(value) ? value : null;
    };
    const cpuCandidate = privacyValue.cores === '' || privacyValue.cores === null || privacyValue.cores === undefined
      ? privacyValue.fingerprint?.cores
      : privacyValue.cores;
    const memoryCandidate = privacyValue.memory === '' || privacyValue.memory === null || privacyValue.memory === undefined
      ? privacyValue.fingerprint?.memory
      : privacyValue.memory;
    const cores = parseLimitedOption(cpuCandidate, [0, 2, 4, 6, 8, 10, 12, 16]);
    const memory = parseLimitedOption(memoryCandidate, [0, 2, 4, 6, 8]);
    const rawProxy = String(value.proxy || '').trim().slice(0, 500);
    const networkMode = value.networkMode === 'direct' || !rawProxy || /^(direct|offline|none)$/i.test(rawProxy) ? 'direct' : 'proxy';
    return {
      id, number: Number.isInteger(number) && number > 0 ? number : null, name: value.name.slice(0, 100),
      title: String(value.title || value.displayName || '').slice(0, 120),
      browser: 'Google Chrome', os: String(value.os || 'Windows').slice(0, 40), location: String(value.location || 'Local').slice(0, 80),
      networkMode,
      proxy: networkMode === 'direct' ? 'Direct' : rawProxy,
      tag: String(value.tag || '').slice(0, 40),
      groupId: String(value.groupId || '').slice(0, 64),
      group_name: String(value.group_name || value.groupName || '').slice(0, 40),
      language: String(value.language || 'en-US').slice(0, 20), width, height,
      userAgent: String(value.userAgent || '').replace(/[\r\n]/g, ' ').slice(0, 1000), cookies: String(value.cookies || '').slice(0, 500000), note: String(value.note || '').slice(0, 2000),
      exitIp: String(value.exitIp || '').slice(0, 80), exitCountryCode: String(value.exitCountryCode || '').slice(0, 4), exitTimezone: String(value.exitTimezone || '').slice(0, 100),
      exitLatitude: finite(value.exitLatitude), exitLongitude: finite(value.exitLongitude),
      exitLatencyMs: finite(value.exitLatencyMs),
      exitNetworkType: String(value.exitNetworkType || '').slice(0, 40),
      platform: {
        type: String(platformValue.type || 'other').slice(0, 40),
        startUrl: String(platformValue.startUrl || value.startUrl || '').slice(0, 2000),
        username: String(platformValue.username || '').slice(0, 200),
        password: String(platformValue.password || '').slice(0, 500),
        totpSecret: String(platformValue.totpSecret || platformValue.otp || '').slice(0, 200),
      },
      proxyMeta: {
        ipChannel: allowed(proxyMetaValue.ipChannel, ['ip-api', 'ip2location'], 'ip-api'),
        refreshUrl: String(proxyMetaValue.refreshUrl || '').slice(0, 1000),
        checkOnStart: Boolean(proxyMetaValue.checkOnStart),
        refreshOnStart: Boolean(proxyMetaValue.refreshOnStart),
        systemProxy: allowed(proxyMetaValue.systemProxy, ['global', 'use', 'off'], 'global'),
        directBypass: Boolean(proxyMetaValue.directBypass),
        bypassList: String(proxyMetaValue.bypassList || '').slice(0, 4000),
        apiExtractUrl: String(proxyMetaValue.apiExtractUrl || '').slice(0, 2000),
        backupProxies: Array.isArray(proxyMetaValue.backupProxies)
          ? proxyMetaValue.backupProxies.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
          : (typeof proxyMetaValue.backupProxies === 'string'
            ? String(proxyMetaValue.backupProxies).split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8)
            : []),
        fillFingerprint: proxyMetaValue.fillFingerprint !== false,
        requireReady: proxyMetaValue.requireReady !== false,
        notReadyPolicy: allowed(proxyMetaValue.notReadyPolicy, ['block', 'direct', 'continue'], proxyMetaValue.requireReady === false ? 'continue' : 'block'),
        tlsProfile: allowed(proxyMetaValue.tlsProfile, ['auto', 'chrome', 'chrome_legacy', 'node', 'off'], 'auto'),
        tlsChromeMajor: (() => {
          const n = Number(proxyMetaValue.tlsChromeMajor);
          return Number.isFinite(n) && n >= 1 && n <= 999 ? Math.round(n) : null;
        })(),
      },
      privacy: {
        webrtc: allowed(privacyValue.webrtc, ['proxy', 'disabled', 'real'], 'proxy'),
        timezoneMode: allowed(privacyValue.timezoneMode, ['ip', 'real', 'custom'], 'ip'),
        timezone: String(privacyValue.timezone || '').slice(0, 100),
        geoMode: allowed(privacyValue.geoMode, ['ip', 'disabled', 'custom', 'prompt', 'allow'], privacyValue.geoMode === 'prompt' ? 'prompt' : (privacyValue.geoMode === 'allow' ? 'ip' : 'ip')),
        latitude: finite(privacyValue.latitude),
        longitude: finite(privacyValue.longitude),
        accuracy: Math.min(100000, Math.max(1, Number(privacyValue.accuracy) || 100)),
        uiLanguage: String(privacyValue.uiLanguage || 'profile').slice(0, 20),
        langFromIp: privacyValue.langFromIp !== false,
        languageMode: String(privacyValue.languageMode || (privacyValue.langFromIp !== false ? 'ip' : (privacyValue.uiLanguage || 'profile'))).slice(0, 20),
        timezoneFromIp: privacyValue.timezoneFromIp !== false,
        geoFromIp: privacyValue.geoFromIp !== false,
        fontMode: allowed(privacyValue.fontMode, ['default', 'custom'], 'default'),
        fontSize: Math.min(36, Math.max(9, Number(privacyValue.fontSize) || 16)),
        canvas: allowed(privacyValue.canvas, ['real', 'noise', 'blocked'], privacyValue.canvas === 'blocked' ? 'blocked' : (privacyValue.canvas === 'real' ? 'real' : 'noise')),
        webgl: allowed(privacyValue.webgl, ['real', 'noise', 'blocked'], privacyValue.webgl === 'blocked' ? 'blocked' : (privacyValue.webgl === 'real' ? 'real' : 'noise')),
        webglMeta: allowed(privacyValue.webglMeta, ['noise', 'custom', 'real', 'blocked'], 'noise'),
        webgpu: allowed(privacyValue.webgpu, ['real', 'blocked', 'webgl'], privacyValue.webgpu === 'webgl' ? 'webgl' : (privacyValue.webgpu === 'blocked' ? 'blocked' : 'real')),
        audio: allowed(privacyValue.audio, ['real', 'noise', 'muted'], privacyValue.audio === 'muted' ? 'muted' : (privacyValue.audio === 'real' ? 'real' : 'noise')),
        media: allowed(privacyValue.media, ['real', 'blocked', 'noise'], privacyValue.media === 'blocked' ? 'blocked' : (privacyValue.media === 'noise' ? 'noise' : 'real')),
        mediaDevices: allowed(privacyValue.mediaDevices, ['real', 'noise', 'empty'], privacyValue.mediaDevices === 'real' ? 'real' : (privacyValue.mediaDevices === 'empty' ? 'empty' : (privacyValue.media === 'noise' ? 'noise' : (privacyValue.media === 'blocked' ? 'empty' : 'noise')))),
        mediaLabels: privacyValue.mediaLabels && typeof privacyValue.mediaLabels === 'object' ? {
          audioinput: String(privacyValue.mediaLabels.audioinput || privacyValue.mediaLabels.input || '').slice(0, 200),
          videoinput: String(privacyValue.mediaLabels.videoinput || privacyValue.mediaLabels.video || '').slice(0, 200),
          audiooutput: String(privacyValue.mediaLabels.audiooutput || privacyValue.mediaLabels.output || '').slice(0, 200),
        } : null,
        battery: allowed(privacyValue.battery, ['real', 'noise', 'blocked'], privacyValue.battery === 'blocked' ? 'blocked' : (privacyValue.battery === 'real' ? 'real' : 'noise')),
        batterySnapshot: privacyValue.batterySnapshot && typeof privacyValue.batterySnapshot === 'object' ? {
          charging: privacyValue.batterySnapshot.charging !== false,
          level: Math.min(1, Math.max(0, Number(privacyValue.batterySnapshot.level) || 0.87)),
          chargingTime: Number.isFinite(Number(privacyValue.batterySnapshot.chargingTime)) ? Number(privacyValue.batterySnapshot.chargingTime) : null,
          dischargingTime: Number.isFinite(Number(privacyValue.batterySnapshot.dischargingTime)) ? Number(privacyValue.batterySnapshot.dischargingTime) : null,
        } : null,
        // Derived from webrtc mode only; independent numeric override removed to avoid dual controls.
        webrtcPolicy: privacyValue.webrtc === 'disabled' ? 0 : (privacyValue.webrtc === 'real' ? 1 : 3),
        stabilityMode: allowed(privacyValue.stabilityMode, ['off', 'auto', 'force'], 'auto'),
        stabilityHamming: Math.min(64, Math.max(1, Number(privacyValue.stabilityHamming) || 12)),
        stabilityMaxWidth: Math.min(4096, Math.max(64, Number(privacyValue.stabilityMaxWidth) || 600)),
        stabilityMaxHeight: Math.min(4096, Math.max(64, Number(privacyValue.stabilityMaxHeight) || 600)),
        stabilitySquare: Math.min(64, Math.max(2, Number(privacyValue.stabilitySquare) || 8)),
        stabilityHosts: Array.isArray(privacyValue.stabilityHosts)
          ? privacyValue.stabilityHosts.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean).slice(0, 800)
          : (typeof privacyValue.stabilityHosts === 'string'
            ? String(privacyValue.stabilityHosts).split(/[\r\n,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 800)
            : null),
        stabilitySkipHosts: Array.isArray(privacyValue.stabilitySkipHosts)
          ? privacyValue.stabilitySkipHosts.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean).slice(0, 200)
          : (typeof privacyValue.stabilitySkipHosts === 'string'
            ? String(privacyValue.stabilitySkipHosts).split(/[\r\n,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 200)
            : null),
        clientRects: allowed(privacyValue.clientRects, ['real', 'noise'], privacyValue.clientRects === 'real' ? 'real' : 'noise'),
        speech: allowed(privacyValue.speech, ['real', 'blocked', 'noise'], privacyValue.speech === 'blocked' ? 'blocked' : (privacyValue.speech === 'noise' ? 'noise' : 'real')),
        deviceNameMode: allowed(privacyValue.deviceNameMode, ['noise', 'custom', 'real'], 'noise'),
        deviceName: String(privacyValue.deviceName || '').slice(0, 120),
        dnt: privacyValue.dnt === true || privacyValue.dnt === 'on' ? true : (privacyValue.dnt === false || privacyValue.dnt === 'off' ? false : Boolean(privacyValue.dnt)),
        dntMode: allowed(privacyValue.dntMode, ['default', 'on', 'off'], privacyValue.dnt === true ? 'on' : (privacyValue.dnt === false ? 'off' : 'default')),
        portScanProtect: Boolean(privacyValue.portScanProtect),
        portScanAllow: String(privacyValue.portScanAllow || '').slice(0, 500),
        cfOptimize: privacyValue.cfOptimize !== false,
        refreshFingerprintOnStart: Boolean(privacyValue.refreshFingerprintOnStart),
        cores,
        memory,
        fingerprint: privacyValue.fingerprint && typeof privacyValue.fingerprint === 'object' ? {
          ...privacyValue.fingerprint,
          cores: cores || privacyValue.fingerprint.cores,
          memory: memory || privacyValue.fingerprint.memory,
        } : { cores, memory },
      },
      advanced: {
        saveCookies: advancedValue.saveCookies !== false, savePasswords: Boolean(advancedValue.savePasswords), saveBookmarks: advancedValue.saveBookmarks !== false,
        saveLocalStorage: advancedValue.saveLocalStorage !== false, saveIndexedDB: advancedValue.saveIndexedDB !== false, saveHistory: advancedValue.saveHistory !== false,
        allowSignin: Boolean(advancedValue.allowSignin),
        restoreSession: Boolean(advancedValue.restoreSession) || advancedValue.tabMode === 'restore',
        blockVideo: Boolean(advancedValue.blockVideo || advancedValue.blockSound),
        blockImages: Boolean(advancedValue.blockImages), clearCacheOnStart: Boolean(advancedValue.clearCacheOnStart),
        // opt-in per environment (each profile chooses cloud sync)
        cloudBackup: Boolean(advancedValue.cloudBackup),
        syncCookiesOnClose: advancedValue.syncCookiesOnClose !== false,
        syncIndexedDB: Boolean(advancedValue.syncIndexedDB),
        syncLocalStorage: Boolean(advancedValue.syncLocalStorage),
        syncPasswords: Boolean(advancedValue.syncPasswords),
        syncExtensionData: Boolean(advancedValue.syncExtensionData),
        multiOpen: Boolean(advancedValue.multiOpen),
        tabMode: allowed(advancedValue.tabMode, ['fixed', 'restore'], advancedValue.restoreSession ? 'restore' : 'fixed'),
        startUrls: String(advancedValue.startUrls || '').slice(0, 8000),
        blockUrls: String(advancedValue.blockUrls || '').slice(0, 8000),
        blockSound: Boolean(advancedValue.blockSound),
        blockPasswordPrompt: Boolean(advancedValue.blockPasswordPrompt),
        blockRestoreDialog: advancedValue.blockRestoreDialog !== false,
        blockNotifications: advancedValue.blockNotifications !== false,
        blockPopups: Boolean(advancedValue.blockPopups),
        jsHeapMax: Boolean(advancedValue.jsHeapMax),
        showInfoPage: advancedValue.showInfoPage !== false,
        showPasswordOnInfo: Boolean(advancedValue.showPasswordOnInfo),
        loadGlobalBookmarks: Boolean(advancedValue.loadGlobalBookmarks),
        showBookmarkBar: Boolean(advancedValue.showBookmarkBar),
        uploadBookmarks: Boolean(advancedValue.uploadBookmarks),
      },
    };
  }

  syncProfiles(values) {
    if (!Array.isArray(values) || values.length > 1000) throw new Error('Invalid profile list');
    const existingIds = [...this.profiles.keys()];
    const globallyEnabled = existingIds.length ? [...this.extensions.keys()].filter((extensionId) => existingIds.every((profileId) => (this.assignments.get(profileId) || new Set()).has(extensionId))) : [];
    let assignmentsChanged = false;
    for (const value of values) {
      const profile = this.sanitizeProfile(value); const previous = this.profiles.get(profile.id); const isNew = !previous;
      if (previous && previous.proxy !== profile.proxy) this.networkInfo.delete(profile.id);
      this.profiles.set(profile.id, profile);
      const hasSavedAssignment = this.assignments.has(profile.id);
      if (isNew || !hasSavedAssignment) {
        const assigned = this.assignments.get(profile.id) || new Set();
        for (const extensionId of globallyEnabled) assigned.add(extensionId);
        // The bundled marker is part of the environment contract.
        for (const [extensionId, extension] of this.extensions) {
          if (extension.builtIn) assigned.add(extensionId);
        }
        this.assignments.set(profile.id, assigned); assignmentsChanged = true;
      }
    }
    if (assignmentsChanged) this.persist().catch((error) => this.emit({ type: 'sync-error', action: 'persist-profiles', message: error.message }));
    return this.status();
  }

  getProfileDataRoot() { return this.profileDataRootPath; }

  setProfileDataRoot(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Environment data directory is required');
    if (this.running.size) throw new Error('Stop all browser environments before changing the data directory');
    const check = validateDataRootIsolationSecure(raw);
    if (!check.ok) throw new Error(check.message);
    this.profileDataRootPath = check.root;
    return this.profileDataRootPath;
  }

  profileRoot(id) { return path.join(this.profileDataRootPath, assertProfileId(id)); }

  browserSelection() {
    const list = this.candidates();
    const independent = list.find((item) => item.independent);
    if (this.preferIndependentKernel) {
      if (independent) return { mode: 'independent', browser: independent };
      if (this.allowSystemBrowserFallback) {
        const fallback = list.find((item) => !item.independent) || list[0];
        if (fallback) return { mode: 'system-fallback', browser: fallback };
      }
      return { mode: 'blocked', browser: null, message: '未安装独立浏览器内核。请到「本地设置」下载或选择独立内核。' };
    }
    const browser = independent || list[0];
    if (!browser) return { mode: 'blocked', browser: null, message: '未找到可用浏览器内核' };
    return { mode: browser.independent ? 'independent' : 'system', browser };
  }

  chooseBrowser() {
    const selection = this.browserSelection();
    if (selection.browser) {
      if (!selection.browser.independent || isSystemBrowserExecutable(selection.browser.path)) {
        throw new Error('已阻止使用本机浏览器。请安装或选择独立 Chromium 内核。');
      }
      if (selection.mode === 'system-fallback') {
        this.emit({ type: 'kernel-fallback', message: '独立内核未安装，临时使用系统浏览器。请到「本地设置」下载独立内核。', browser: selection.browser.path });
      }
      return selection.browser;
    }
    throw new Error(selection.message);
  }

  proxyArg(value) {
    const proxy = String(value || '').trim();
    if (!proxy || /^(direct|offline|none)/i.test(proxy)) return null;
    if (/^(https?|socks4|socks5):\/\/[a-zA-Z0-9._-]+:\d{1,5}$/i.test(proxy)) return proxy;
    if (/^[a-zA-Z0-9._-]+:\d{1,5}$/.test(proxy)) return `http://${proxy}`;
    return null;
  }

  proxyConfig(value) { return parseProxy(value); }

  async resetZoom(root) {
    const file = path.join(root, 'Default', 'Preferences');
    try { const prefs = JSON.parse(await fsp.readFile(file, 'utf8')); if (prefs.partition) prefs.partition.per_host_zoom_levels = {}; if (prefs.browser && 'default_zoom_level' in prefs.browser) prefs.browser.default_zoom_level = 0; await fsp.writeFile(file, JSON.stringify(prefs), 'utf8'); } catch (_) {}
  }

  async resetTabs(root) {
    const profile = path.join(root, 'Default');
    for (const name of ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
      const target = await assertSafeProfileChild(root, path.join(profile, name));
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    }
  }

  async clearProfileCache(root) {
    const base = path.join(root, 'Default');
    for (const name of ['Cache', 'Code Cache', 'GPUCache', path.join('Service Worker', 'CacheStorage')]) {
      const target = await assertSafeProfileChild(root, path.join(base, name));
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Clear cache + cookies on disk for a stopped profile. */
  async clearProfileCacheAndCookies(profileId) {
    const id = assertProfileId(profileId);
    if (this.running.has(id)) throw new Error('请先关闭窗口再清除缓存及 Cookie');
    const root = this.profileRoot(id);
    await this.clearProfileCache(root);
    const base = path.join(root, 'Default');
    for (const name of [
      path.join('Network', 'Cookies'),
      path.join('Network', 'Cookies-journal'),
      'Cookies',
      'Cookies-journal',
    ]) {
      const target = await assertSafeProfileChild(root, path.join(base, name));
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    }
    const profile = this.profiles.get(id);
    if (profile) {
      profile.cookies = '';
      profile.updatedAt = new Date().toISOString();
      this.profiles.set(id, profile);
      await this.persist().catch(() => {});
    }
    return { success: true, id };
  }

  async enforceDataRetention(root, profile) {
    const base = path.join(root, 'Default'); const targets = [];
    const add = (...names) => targets.push(...names.map((name) => path.join(base, name)));
    if (!profile.advanced.saveCookies) add(path.join('Network', 'Cookies'), path.join('Network', 'Cookies-journal'), 'Cookies', 'Cookies-journal');
    if (!profile.advanced.savePasswords) add('Login Data', 'Login Data-journal', 'Login Data For Account', 'Login Data For Account-journal');
    if (!profile.advanced.saveBookmarks) add('Bookmarks', 'Bookmarks.bak');
    if (!profile.advanced.saveLocalStorage) add('Local Storage');
    if (!profile.advanced.saveIndexedDB) add('IndexedDB');
    if (!profile.advanced.saveHistory) add('History', 'History-journal', 'Visited Links', 'Top Sites', 'Top Sites-journal');
    for (const target of targets) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  }

  async applyProfilePreferences(root, profile) {
    const defaultRoot = path.join(root, 'Default'); const file = path.join(defaultRoot, 'Preferences'); await fsp.mkdir(defaultRoot, { recursive: true });
    let prefs = {}; try { prefs = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) {}
    prefs.profile ||= {}; prefs.profile.default_content_setting_values ||= {};
    prefs.profile.exit_type = 'Normal'; prefs.profile.exited_cleanly = true;
    const content = prefs.profile.default_content_setting_values;
    if (profile.advanced.blockImages) content.images = 2; else delete content.images;
    if (profile.advanced.blockSound) content.sound = 2; else delete content.sound;
    if (profile.advanced.blockNotifications) content.notifications = 2; else delete content.notifications;
    // 「完全禁用弹窗拦截」= 允许弹窗 (ALLOW=1)，不是屏蔽弹窗 (BLOCK=2)
    if (profile.advanced.blockPopups) content.popups = 1; else delete content.popups;
    if (profile.privacy.media === 'blocked') { content.media_stream_mic = 2; content.media_stream_camera = 2; } else { delete content.media_stream_mic; delete content.media_stream_camera; }
    if (profile.privacy.geoMode === 'disabled') content.geolocation = 2;
    else if (profile.privacy.geoMode === 'prompt') content.geolocation = 3;
    else delete content.geolocation;
    const allowPasswords = Boolean(profile.advanced.savePasswords) && !profile.advanced.blockPasswordPrompt;
    prefs.credentials_enable_service = allowPasswords;
    prefs.profile.password_manager_enabled = allowPasswords;
    prefs.signin ||= {}; prefs.signin.allowed = Boolean(profile.advanced.allowSignin);
    prefs.intl ||= {};
    // e.g. ja-JP,ja  so Accept-Language matches IP-derived locale
    {
      const lang = String(profile.language || 'en-US').trim();
      const primary = lang.split(',')[0].trim();
      const base = primary.split('-')[0];
      prefs.intl.accept_languages = base && base !== primary ? `${primary},${base}` : primary;
    }
    prefs.webkit ||= {}; prefs.webkit.webprefs ||= {};
    if (profile.privacy.fontMode === 'custom') prefs.webkit.webprefs.default_font_size = profile.privacy.fontSize;
    else delete prefs.webkit.webprefs.default_font_size;
    prefs.bookmark_bar ||= {};
    prefs.bookmark_bar.show_on_all_tabs = Boolean(profile.advanced.showBookmarkBar);
    if (profile.advanced.blockRestoreDialog) {
      prefs.session ||= {};
      prefs.session.restore_on_startup = profile.advanced.tabMode === 'restore' || profile.advanced.restoreSession ? 1 : 5;
    }
    await fsp.writeFile(file, JSON.stringify(prefs), 'utf8');
  }

  resolveStartupUrls(profile) {
    const urls = [];
    // blank page: no platform URL
    if (String(profile.platform?.type || '') !== 'blank') {
      const platformUrl = String(profile.platform?.startUrl || '').trim();
      if (platformUrl) urls.push(platformUrl);
    }
    const lines = String(profile.advanced?.startUrls || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const line of lines) if (!urls.includes(line)) urls.push(line);
    if (String(profile.platform?.type || '') === 'blank' && !urls.length) urls.push('about:blank');
    return urls.slice(0, 20);
  }

  async importProfileCookies(connection, raw) {
    if (!raw) return 0; const values = JSON.parse(raw); if (!Array.isArray(values)) throw new Error('Cookie JSON must be an array');
    const sameSite = (value) => ({ strict: 'Strict', lax: 'Lax', none: 'None', no_restriction: 'None', unspecified: undefined })[String(value || '').toLowerCase()];
    const cookies = values.slice(0, 5000).map((item) => {
      if (!item || typeof item.name !== 'string' || typeof item.value !== 'string') throw new Error('Cookie entries require name and value');
      const cookie = { name: item.name, value: item.value, path: String(item.path || '/'), secure: Boolean(item.secure), httpOnly: Boolean(item.httpOnly ?? item.http_only) };
      if (item.url) cookie.url = String(item.url); else if (item.domain) cookie.domain = String(item.domain);
      if (!cookie.url && !cookie.domain) throw new Error('Cookie entry requires url or domain');
      const site = sameSite(item.sameSite ?? item.same_site); if (site) cookie.sameSite = site;
      const expires = Number(item.expires ?? item.expirationDate ?? item.expiration_date); if (Number.isFinite(expires) && expires > 0) cookie.expires = expires > 1e12 ? expires / 1000 : expires;
      return cookie;
    });
    if (cookies.length) await connection.command('Storage.setCookies', { cookies }, 30000); return cookies.length;
  }

  /** Export live cookies via CDP for cloud backup on close. */
  async exportProfileCookies(connection) {
    if (!connection?.command) return '';
    try {
      const result = await connection.command('Storage.getCookies', {}, 15000);
      const list = Array.isArray(result?.cookies) ? result.cookies : [];
      const compact = list.slice(0, 5000).map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
        sameSite: c.sameSite,
        expires: c.expires,
      }));
      return JSON.stringify(compact);
    } catch (_) {
      return '';
    }
  }

  async applyRuntimeSettings(port, profile, fingerprint = null, options = {}) {
    const tabs = await cdp.tabs(port);
    const network = this.networkInfo.get(profile.id) || {};
    // merge IP-detected geo/tz into profile for fingerprint apply
    const enriched = {
      ...profile,
      exitTimezone: profile.exitTimezone || network.timezone || '',
      exitLatitude: profile.exitLatitude ?? network.latitude,
      exitLongitude: profile.exitLongitude ?? network.longitude,
    };
    const fp = fingerprint || buildFingerprint(enriched);
    // Track which CDP page targets already received inject (new tabs must not skip FP)
    const applied = options.appliedTargetIds instanceof Set ? options.appliedTargetIds : new Set();
    const blocked = [];
    if (profile.advanced.blockVideo) blocked.push('*.mp4', '*.webm', '*.m3u8', '*.mov', '*.avi');
    const customBlock = String(profile.advanced.blockUrls || '')
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    for (const u of customBlock) if (!blocked.includes(u)) blocked.push(u);
    // Port scan protection: block common localhost probe ports unless allow-listed
    // Speech voices: fingerprint injection (speech.mode blocked/noise/real)
    let portScanScript = null;
    if (profile.privacy.portScanProtect) {
      const allow = String(profile.privacy.portScanAllow || '')
        .split(/[,\s]+/)
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
      portScanScript = `(() => {
        const allow = new Set(${JSON.stringify(allow)});
        const isLocal = (h) => !h || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local');
        const Orig = globalThis.WebSocket;
        if (Orig) {
          globalThis.WebSocket = function(url, protocols) {
            try {
              const u = new URL(url, location.href);
              const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
              if (isLocal(u.hostname) && !allow.has(port) && port !== 80 && port !== 443) {
                throw new Error('Port scan blocked');
              }
            } catch (e) { if (String(e.message||'').includes('Port scan')) throw e; }
            return protocols !== undefined ? new Orig(url, protocols) : new Orig(url);
          };
          globalThis.WebSocket.prototype = Orig.prototype;
        }
      })();`;
    }

    for (const tab of tabs) {
      if (applied.has(tab.id)) continue;
      await applyFingerprintToTab(cdp.call, tab.webSocketDebuggerUrl, fp, enriched);
      if (blocked.length) {
        await cdp.call(tab.webSocketDebuggerUrl, 'Network.enable');
        await cdp.call(tab.webSocketDebuggerUrl, 'Network.setBlockedURLs', { urls: blocked });
      }
      if (portScanScript) {
        await cdp.call(tab.webSocketDebuggerUrl, 'Page.addScriptToEvaluateOnNewDocument', { source: portScanScript });
        await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: portScanScript });
      }
      applied.add(tab.id);
    }
    // Drop closed targets so Set does not grow forever
    const liveIds = new Set(tabs.map((t) => t.id));
    for (const id of [...applied]) {
      if (!liveIds.has(id)) applied.delete(id);
    }
    if (options.trackOn) {
      options.trackOn.fpAppliedTargets = applied;
      options.trackOn.fingerprint = fp;
    }
    return fp;
  }

  async startWorkerFingerprintInjection(item, fingerprint) {
    const source = buildWorkerInjectionScript(fingerprint);
    const browserWs = await cdp.browserSocket(item.port);
    const workerTypes = new Set(['worker', 'shared_worker', 'service_worker']);
    const internalUrl = /^(chrome|chrome-extension|edge|edge-extension|devtools):/i;
    const report = (error, targetInfo = {}) => {
      item.workerFingerprintError = error.message;
      this.emit({
        type: 'worker-fingerprint-injection-failed',
        id: item.profile.id,
        targetType: targetInfo.type || '',
        message: error.message,
      });
    };
    const onAttached = (event, connection) => {
      if (event.method !== 'Target.attachedToTarget') return;
      const { sessionId, targetInfo = {}, waitingForDebugger } = event.params || {};
      if (!sessionId) return;
      (async () => {
        try {
          if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
            await connection.command('Target.setAutoAttach', {
              autoAttach: true,
              waitForDebuggerOnStart: true,
              flatten: true,
            }, { sessionId });
          } else if (workerTypes.has(targetInfo.type) && !internalUrl.test(String(targetInfo.url || ''))) {
            await connection.command('Runtime.evaluate', { expression: source }, { sessionId, timeout: 10000 });
          }
        } catch (error) {
          report(error, targetInfo);
        } finally {
          if (waitingForDebugger) {
            await connection.command('Runtime.runIfWaitingForDebugger', {}, { sessionId })
              .catch((error) => report(error, targetInfo));
          }
        }
      })();
    };
    const connection = await cdp.connect(browserWs, { onEvent: onAttached, timeout: 8000 });
    try {
      await connection.command('Target.setDiscoverTargets', { discover: true });
      await connection.command('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
    } catch (error) {
      connection.close();
      throw error;
    }
    item.workerFingerprintConnection = connection;
    return connection;
  }

  fingerprintFor(profileOrId) {
    const profile = typeof profileOrId === 'string'
      ? (this.profiles.get(profileOrId) || this.running.get(profileOrId)?.profile)
      : profileOrId;
    if (!profile) throw new Error('profile not found');
    return buildFingerprint(profile);
  }

  isolationAudit() {
    const running = [...this.running.entries()].map(([id, item]) => ({
      id,
      root: item.root,
      port: item.port,
      pid: item.pid,
    }));
    return auditIsolation(running);
  }

  async suppressStartupExtensionPages(connection, installed, durationMs = 7000) {
    const popupPaths = new Map();
    for (const extension of installed || []) {
      const chromeId = String(extension.chromeExtensionId || '').toLowerCase();
      if (!chromeId) continue;
      let popup = '';
      try {
        const manifest = JSON.parse(await fsp.readFile(path.join(extension.path, 'manifest.json'), 'utf8'));
        popup = String(manifest.action?.default_popup || manifest.browser_action?.default_popup || '').replace(/^\/+/, '').toLowerCase();
      } catch (_) {}
      popupPaths.set(chromeId, popup);
    }
    if (!popupPaths.size) return { closed: 0 };

    const blockedOpeners = new Set(); const closedTargets = new Set(); const started = Date.now();
    while (Date.now() - started < durationMs) {
      let values;
      try { values = (await connection.command('Target.getTargets', {}, 3000)).targetInfos || []; }
      catch (_) { break; }

      for (const target of values) {
        if (target.type !== 'page' || closedTargets.has(target.targetId)) continue;
        let shouldClose = blockedOpeners.has(String(target.openerId || ''));
        if (!shouldClose) {
          try {
            const url = new URL(String(target.url || ''));
            if (url.protocol === 'chrome-extension:' || url.protocol === 'edge-extension:') {
              const popup = popupPaths.get(url.hostname.toLowerCase());
              if (popup !== undefined) {
                const currentPath = decodeURIComponent(url.pathname).replace(/^\/+/, '').toLowerCase();
                const isToolbarPopup = Boolean(popup) && currentPath === popup;
                shouldClose = !isToolbarPopup;
              }
            }
          } catch (_) {}
        }
        if (!shouldClose) continue;
        blockedOpeners.add(target.targetId); closedTargets.add(target.targetId);
        await connection.command('Target.closeTarget', { targetId: target.targetId }, 3000).catch(() => {});
      }
      await new Promise((resolve) => { const timer = setTimeout(resolve, 120); timer.unref?.(); });
    }
    if (closedTargets.size) this.emit({ type: 'startup-extension-pages-suppressed', count: closedTargets.size });
    return { closed: closedTargets.size };
  }
  isStartPageUrl(url) {
    if (this.startPageServer?.isStartPageUrl?.(url)) return true;
    const s = String(url || '').toLowerCase();
    // 仅识别 OpenBrowser 原生启动页端口 / 本地文件回退，不绑定其它软件端口
    return s.includes('openbrowser-start.html')
      || s.includes('openbrowser-start')
      || s.includes('openbrowser-native')
      || /https?:\/\/127\.0\.0\.1:5032[6-9]\/?/.test(s);
  }

  envWindowTitle(profile) {
    const number = profile.number || profile.name || profile.id || '';
    const title = profile.title && String(profile.title).trim() && String(profile.title) !== String(number)
      ? String(profile.title).trim()
      : '';
    return title ? `环境 ${number} · ${title}` : `环境 ${number}`;
  }

  needsExitNetworkForLocale(profile) {
    const privacy = profile.privacy || {};
    const langMode = privacy.languageMode || (privacy.langFromIp !== false ? 'ip' : '');
    const tzMode = privacy.timezoneMode || 'ip';
    const geoMode = privacy.geoMode || 'ip';
    return langMode === 'ip' || tzMode === 'ip' || geoMode === 'ip' || geoMode === 'allow';
  }

  async ensureExitNetworkForLocale(profile) {
    if (!this.needsExitNetworkForLocale(profile)) return null;
    let network = this.networkInfo.get(profile.id);
    if (network?.countryCode || network?.ip) return network;
    const proxyRaw = String(profile.proxy || '');
    const isDirect = profile.networkMode === 'direct' || !proxyRaw || /^(direct|offline|none)$/i.test(proxyRaw);
    try {
      if (!isDirect) {
        network = await this.checkProxy(profile, { allowExtract: false });
      } else {
        // Local direct exit: geo lookup is best-effort for language/timezone only.
        network = await lookupDirectCountry();
        this.networkInfo.set(profile.id, network);
        this.emit({ type: 'status', id: profile.id, running: this.running.has(profile.id), network });
      }
      if (network) {
        profile.exitIp = network.ip || profile.exitIp;
        profile.exitCountryCode = network.countryCode || profile.exitCountryCode;
        profile.exitTimezone = network.timezone || profile.exitTimezone;
        profile.exitLatitude = network.latitude ?? profile.exitLatitude;
        profile.exitLongitude = network.longitude ?? profile.exitLongitude;
        profile.exitCheckedAt = network.checkedAt || profile.exitCheckedAt;
      }
      return network;
    } catch (error) {
      // Direct start succeeded without proxy; geo API failure must not surface as proxy error.
      if (!isDirect) {
        this.emit({ type: 'proxy-error', id: profile.id, message: '出口信息检测失败（语言/时区可能回退）：' + error.message });
      }
      return this.networkInfo.get(profile.id) || null;
    }
  }

  applyResolvedLocale(profile) {
    const network = this.networkInfo.get(profile.id) || {
      countryCode: profile.exitCountryCode,
      timezone: profile.exitTimezone,
      latitude: profile.exitLatitude,
      longitude: profile.exitLongitude,
      ip: profile.exitIp,
    };
    const privacy = { ...(profile.privacy || {}) };
    const language = resolveProfileLanguage(profile, network);
    const next = {
      ...profile,
      language,
      privacy: {
        ...privacy,
        languageMode: privacy.languageMode || (privacy.langFromIp !== false ? 'ip' : (privacy.uiLanguage || 'profile')),
        langFromIp: (privacy.languageMode || 'ip') === 'ip' || privacy.langFromIp !== false,
      },
      exitIp: network.ip || profile.exitIp || '',
      exitCountryCode: network.countryCode || profile.exitCountryCode || '',
      exitTimezone: network.timezone || profile.exitTimezone || '',
      exitLatitude: network.latitude ?? profile.exitLatitude,
      exitLongitude: network.longitude ?? profile.exitLongitude,
    };
    if ((privacy.timezoneMode === 'ip' || !privacy.timezoneMode) && network.timezone) {
      next.privacy = { ...next.privacy, timezone: network.timezone };
    }
    if ((privacy.geoMode === 'ip' || privacy.geoMode === 'allow' || !privacy.geoMode)
      && Number.isFinite(Number(network.latitude))
      && Number.isFinite(Number(network.longitude))) {
      next.exitLatitude = Number(network.latitude);
      next.exitLongitude = Number(network.longitude);
    }
    return next;
  }

  async applyEnvWindowTitle(port, profile) {
    if (!port) return;
    const title = this.envWindowTitle(profile);
    const tabs = await cdp.tabs(port).catch(() => []);
    for (const tab of tabs) {
      if (!tab.webSocketDebuggerUrl) continue;
      // Prefer page title so Dock/window list shows 环境 N instead of bare site name at start
      await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: `(() => { try { document.title = ${JSON.stringify(title)}; } catch (_) {} })()`,
      }).catch(() => {});
    }
  }

  async keepDefaultTab(port, startUrl) {
    const values = await cdp.tabs(port); if (!values.length) return;
    const expected = String(startUrl || '');
    let keep = values.find((tab) => this.isStartPageUrl(tab.url)) || values[0];
    if (!this.isStartPageUrl(keep.url) && expected) {
      await cdp.call(keep.webSocketDebuggerUrl, 'Page.navigate', { url: expected });
    }
    for (const tab of values) if (tab.id !== keep.id) await cdp.closeTab(port, tab.id).catch(() => {});
    await cdp.activateTab(port, keep.id).catch(() => {});
  }

  /**
   * OpenBrowser 原生启动页 URL：http://127.0.0.1:50326/?pid=...&id=...&name=...
   * 会话与网络信息由本引擎写入启动页服务，不依赖其它指纹浏览器。
   */
  async buildStartPageUrl(profile, root, browserName, extensionCount) {
    let pageNetwork = this.networkInfo.get(profile.id) || null;
    // 启动前尽量用本引擎代理检测补全出口（有代理且尚未检测时）
    const hasProxy = profile.proxy && !/^(direct|offline|none)$/i.test(String(profile.proxy));
    if (hasProxy && !pageNetwork?.ip) {
      try {
        pageNetwork = await this.checkProxy(profile);
      } catch (_) {
        pageNetwork = this.networkInfo.get(profile.id) || null;
      }
    }
    const timezone = profile.exitTimezone
      || pageNetwork?.timezone
      || (profile.privacy?.timezoneMode === 'custom' ? profile.privacy.timezone : '')
      || '';
    const uaFromFp = (() => {
      try {
        return buildFingerprint(profile).userAgent;
      } catch (_) {
        return profile.userAgent || '';
      }
    })();
    try {
      const server = await this.ensureStartPage();
      const url = server.registerSession({
        ...profile,
        exitTimezone: timezone,
        exitIp: pageNetwork?.ip || profile.exitIp || '',
        exitCountryCode: pageNetwork?.countryCode || profile.exitCountryCode || '',
        userAgent: profile.userAgent || uaFromFp,
        group_name: profile.group_name || profile.groupName || '',
      }, {
        timezone,
        network: pageNetwork,
        userAgent: profile.userAgent || uaFromFp,
        group_name: profile.group_name || profile.groupName || '',
        browserName,
        extensionCount,
        time: Math.floor(Date.now() / 1000),
      });
      await fsp.writeFile(
        path.join(root, 'openbrowser-start.url.txt'),
        url + '\n# OpenBrowser 原生启动页（非其它软件）\n',
        'utf8'
      ).catch(() => {});
      return url;
    } catch (error) {
      // 最后回退：写本地 HTML，仍标 OpenBrowser 原生
      const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
      const number = escape(profile.number || profile.name || profile.id);
      const name = escape(profile.name || number);
      const ip = escape(pageNetwork?.ip || profile.exitIp || '未检测');
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="openbrowser-native" content="1"><title>环境 ${number}</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#12141a;color:#e8eaf0;display:grid;place-items:center;min-height:100vh}
.card{width:min(720px,94vw);background:#1c1f28;border-radius:14px;overflow:hidden;border:1px solid #2a3040;box-shadow:0 20px 50px rgba(0,0,0,.35)}
.brand{display:flex;align-items:center;gap:14px;padding:22px 22px 8px}
.badge{width:52px;height:52px;border-radius:14px;display:grid;place-items:center;font-size:22px;font-weight:800;color:#fff;background:linear-gradient(145deg,#2563eb,#1d4ed8)}
.head{background:linear-gradient(90deg,#1e3a5f,#243b55);color:#fff;text-align:center;padding:28px 16px;font-size:28px;font-weight:600;letter-spacing:.02em}
.body{padding:18px 22px 24px;line-height:1.8}.k{color:#8b93a7;display:inline-block;width:88px;text-align:right;margin-right:12px}</style></head>
<body><div class="card">
<div class="brand"><div class="badge">${number}</div><div><div style="font-size:18px;font-weight:700">环境 ${number}</div><div style="color:#8b93a7;font-size:12px">OpenBrowser · 本地环境标识</div></div></div>
<div class="head">${ip}</div><div class="body">
<div><span class="k">环境</span>环境 ${number}</div>
<div><span class="k">窗口名称</span>${name}</div>
<div><span class="k">说明</span>启动页服务异常：${escape(error.message)}（仍为 OpenBrowser 本地页）</div>
</div></div></body></html>`;
      const file = path.join(root, 'openbrowser-start.html');
      await fsp.writeFile(file, html, 'utf8');
      return toFileUrl(file);
    }
  }

  assignedExtensions(profileId) {
    const ids = this.assignments.get(profileId) || new Set();
    return [...ids].map((id) => this.extensions.get(id)).filter((item) => item && fs.existsSync(item.path));
  }

  async markProfileCleanExit(root) {
    const file = path.join(root, 'Default', 'Preferences');
    try {
      const prefs = JSON.parse(await fsp.readFile(file, 'utf8')); prefs.profile ||= {};
      prefs.profile.exit_type = 'Normal'; prefs.profile.exited_cleanly = true;
      await fsp.writeFile(file, JSON.stringify(prefs), 'utf8');
    } catch (_) {}
  }

  startNativeProfileMarker(pid, profileId) {
    if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
    const executable = path.join(__dirname, 'native-profile-marker.exe'); if (!fs.existsSync(executable)) return null;
    try { return spawn(executable, [String(pid), String(profileId)], { windowsHide: true, stdio: 'ignore' }); } catch (_) { return null; }
  }

  clearRunningWatch(item) {
    if (!item) return;
    if (item.watchTimer) {
      clearTimeout(item.watchTimer);
      item.watchTimer = null;
    }
    item.watchEmptyTicks = 0;
    item.watchDeadTicks = 0;
  }

  /**
   * Watch launched browser: user clicking window X often leaves Chrome helpers alive
   * or never fires child 'exit'. Poll CDP — if port dies or all pages are gone, stop env.
   */
  startRunningWatch(item) {
    if (!item || item.watchTimer) return;
    const profileId = item.profile?.id;
    const tick = async () => {
      item.watchTimer = null;
      if (item.cleanedUp || item.stopping || !this.running.has(profileId)) return;
      let pageCount = -1;
      let cdpAlive = false;
      let processAlive = true;
      if (item.pid) {
        try {
          process.kill(item.pid, 0);
        } catch (_) {
          processAlive = false;
        }
      }
      try {
        // /json/version proves browser process still exposes CDP
        await cdp.json(`http://127.0.0.1:${item.port}/json/version`);
        cdpAlive = true;
        const pages = await cdp.tabs(item.port).catch(() => []);
        pageCount = Array.isArray(pages) ? pages.length : 0;
      } catch (_) {
        cdpAlive = false;
      }

      if (!processAlive || !cdpAlive) {
        item.watchDeadTicks = (item.watchDeadTicks || 0) + 1;
        item.watchEmptyTicks = 0;
        // pid gone: stop immediately; CDP flaky: need 2 consecutive fails
        if (!processAlive || item.watchDeadTicks >= 2) {
          this.handleBrowserGone(profileId, item, processAlive ? 'cdp-dead' : 'process-exit');
          return;
        }
      } else {
        item.watchDeadTicks = 0;
        // All windows closed (X on last window): no page targets remain
        if (pageCount === 0) {
          item.watchEmptyTicks = (item.watchEmptyTicks || 0) + 1;
          if (item.watchEmptyTicks >= 2) {
            // Gracefully stop environment so UI matches closed browser
            this.stop(profileId).catch((error) => {
              this.emit({ type: 'sync-error', action: 'auto-stop-empty', id: profileId, message: error.message });
              this.handleBrowserGone(profileId, item, 'empty-windows');
            });
            return;
          }
        } else {
          item.watchEmptyTicks = 0;
          // New tabs must receive the same fingerprint inject as the launch tab
          if (item.fingerprint && item.profile && !item.fpEnsureBusy) {
            item.fpEnsureBusy = true;
            this.applyRuntimeSettings(item.port, item.profile, item.fingerprint, {
              appliedTargetIds: item.fpAppliedTargets || new Set(),
              trackOn: item,
            }).catch((error) => {
              item.cdpError = `fingerprint injection failed: ${error.message}`;
              this.emit({
                type: 'fingerprint-injection-failed',
                id: profileId,
                message: error.message,
              });
            }).finally(() => { item.fpEnsureBusy = false; });
          }
        }
      }
      item.watchTimer = setTimeout(tick, 1200);
    };
    // Delay first check so startup tabs can settle
    item.watchTimer = setTimeout(tick, 2500);
  }

  handleBrowserGone(profileId, item, reason = 'browser-gone') {
    if (!item || item.cleanedUp) return;
    this.clearRunningWatch(item);
    const expected = item.stopping === true;
    if (item.markerProcess && !item.markerProcess.killed) {
      try { item.markerProcess.kill(); } catch (_) {}
    }
    item.proxyForwarder?.close().catch(() => {});
    releaseProfileLock(item.root, item.profileLock).catch(() => {});
    // Best-effort kill remaining helpers when CDP already dead
    if (item.child && item.child.exitCode === null && item.pid) {
      killProcessTree(item.pid, {
        force: true,
        expectedExecutable: item.browser?.path,
        expectedUserDataDir: item.root,
      }).catch(() => {});
    }
    if (!expected) this.markProfileCleanExit(item.root).catch(() => {});
    item.cleanedUp = true;
    this.running.delete(profileId);
    const live = this.profiles.get(profileId) || item.profile;
    this.emit({
      type: 'status',
      id: profileId,
      running: false,
      error: null,
      reason,
    });
    if (live?.advanced?.cloudBackup && !item.stopping) {
      this.emit({
        type: 'profile-closed',
        id: profileId,
        cloudBackup: true,
        cookieExported: false,
        profile: live,
        reason,
      });
    }
  }

  async waitForPort(root, timeout = 12000) {
    const file = path.join(root, 'DevToolsActivePort');
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try { const content = await fsp.readFile(file, 'utf8'); const port = Number(content.split(/\r?\n/)[0]); if (Number.isInteger(port) && port > 0) return port; } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    throw new Error('Browser started but CDP port was not ready');
  }

  async start(raw) {
    // let: language/timezone resolution reassigns profile via applyResolvedLocale
    let profile = this.sanitizeProfile(raw); this.profiles.set(profile.id, profile);
    if (this.running.has(profile.id)) {
      if (!profile.advanced.multiOpen) return this.publicRunning(profile.id);
      return this.publicRunning(profile.id);
    }
    profile = await this.prepareProfileProxyForStart(profile);
    this.profiles.set(profile.id, profile);
    await this.ensureExitNetworkForLocale(profile).catch(() => {});
    profile = this.applyResolvedLocale(profile);
    this.profiles.set(profile.id, profile);
    const extensions = this.assignedExtensions(profile.id);
    if (!this.kernelStatus().installed && this.preferIndependentKernel) await this.ensureKernelBootstrap();
    const browser = this.chooseBrowser(profile);
    const root = this.profileRoot(profile.id);
    const rootCheck = await validateProfileRootSecure(this.profileDataRootPath, root, profile.id, { create: true });
    if (!rootCheck.ok) throw new Error('Isolation error: ' + rootCheck.message);
    const profileLock = await acquireProfileLock(root, { profileId: profile.id, browser: browser.path });
    const restoreSession = profile.advanced.tabMode === 'restore' || profile.advanced.restoreSession;
    if (!restoreSession) await this.resetTabs(root); await this.resetZoom(root);
    if (profile.advanced.clearCacheOnStart) await this.clearProfileCache(root); await this.enforceDataRetention(root, profile); await this.applyProfilePreferences(root, profile);
    await fsp.rm(path.join(root, 'DevToolsActivePort'), { force: true }).catch(() => {});
    const pageNetwork = this.networkInfo.get(profile.id) || {};
    const customStartUrls = this.resolveStartupUrls(profile);
    const infoStartUrl = profile.advanced.showInfoPage !== false
      ? await this.buildStartPageUrl(
        { ...profile, exitIp: pageNetwork.ip || profile.exitIp || '', title: profile.title || profile.name },
        root,
        browser.name,
        extensions.length
      )
      : null;
    const startUrl = customStartUrls[0] || infoStartUrl;
    const proxyConfig = this.proxyConfig(profile.proxy); let proxyForwarder = null;
    // Site-stability keeps static marks; refresh-on-start only when stability is off.
    const allowSeedRefresh = profile.privacy.refreshFingerprintOnStart && profile.privacy.stabilityMode === 'off';
    const fingerprint = buildFingerprint({
      ...profile,
      fingerprintLaunchSeed: allowSeedRefresh ? crypto.randomBytes(16).toString('hex') : '',
      kernelVersion: browser.version,
      exitTimezone: profile.exitTimezone || pageNetwork.timezone || '',
      exitLatitude: profile.exitLatitude ?? pageNetwork.latitude,
      exitLongitude: profile.exitLongitude ?? pageNetwork.longitude,
    });
    if (proxyConfig) {
      const meta = profile.proxyMeta || {};
      const major = Number(meta.tlsChromeMajor)
        || Number(fingerprint?.uaProfile?.chromeMajor)
        || Number(String(profile.userAgent || fingerprint?.userAgent || '').match(/Chrome\/(\d+)/)?.[1])
        || 0;
      proxyConfig.tlsProfile = {
        id: meta.tlsProfile || 'auto',
        chromeMajor: major || undefined,
      };
    }
    if (proxyConfig?.authenticated) {
      proxyForwarder = await startAuthenticatedProxy(proxyConfig, (value) => this.emit({ type: 'proxy-error', id: profile.id, code: value.code, message: value.message }));
    }
    const args = [
      `--user-data-dir=${root}`,
      `--disk-cache-dir=${path.join(root, 'OpenBrowserCache')}`,
      `--crash-dumps-dir=${path.join(root, 'OpenBrowserCrashReports')}`,
      '--profile-directory=Default',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      '--disable-background-mode',
      '--enable-unsafe-extension-debugging',
      // Random loopback port only; never bind 0.0.0.0. Restrict CDP WebSocket origins
      // (was * — any local page that learns the port could attach and steal session).
      '--remote-debugging-port=0',
      '--remote-allow-origins=http://127.0.0.1,http://localhost',
    ];
    // Fingerprint chrome flags (UA / webrtc / webgl / lang / window-size)
    for (const flag of chromeArgsForFingerprint(fingerprint, profile)) {
      if (!args.some((a) => a.split('=')[0] === flag.split('=')[0])) args.push(flag);
    }
    if (!profile.advanced.allowSignin) args.push('--disable-sync');
    if (profile.privacy.webgpu === 'blocked') args.push('--disable-features=WebGPU');
    if (profile.advanced.blockImages) args.push('--blink-settings=imagesEnabled=false');
    if (profile.advanced.blockVideo || profile.advanced.blockSound) args.push('--autoplay-policy=user-gesture-required');
    if (profile.advanced.jsHeapMax) args.push('--js-flags=--max-old-space-size=8192');
    if (restoreSession) args.push('--restore-last-session');
    const disabledFeatures = [];
    // Authenticated proxies must be exposed to Chrome through the local bridge.
    let proxy = proxyForwarder ? proxyForwarder.url : this.proxyArg(profile.proxy);
    // systemProxy: off = 强制本机直连(不走系统代理)；use/global + Direct = 不传 --proxy-server（跟随系统路由）
    const sysMode = profile.proxyMeta?.systemProxy || 'global';
    if (!proxy && sysMode === 'off') {
      proxy = 'direct://';
    }
    if (proxy) {
      args.push(`--proxy-server=${proxy}`);
      // 本机启动页必须直连，不走代理；可叠加用户直连白名单
      let bypass = '<-loopback>;127.0.0.1;localhost';
      if (profile.proxyMeta?.directBypass && profile.proxyMeta.bypassList) {
        const extra = String(profile.proxyMeta.bypassList).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
        if (extra.length) bypass += ';' + extra.join(';');
      }
      const existingBypass = args.findIndex((a) => a.startsWith('--proxy-bypass-list='));
      if (existingBypass >= 0) args[existingBypass] = args[existingBypass] + ';' + bypass;
      else args.push(`--proxy-bypass-list=${bypass}`);
    }
    // startup URLs: fixed list or info page (skip when restoring session)
    if (!restoreSession) {
      if (startUrl) args.push(startUrl);
      for (const extra of customStartUrls.slice(1)) args.push(extra);
    }
    if (proxyConfig) {
      args.push('--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-client-side-phishing-detection', '--disable-domain-reliability', '--disable-quic', '--dns-prefetch-disable', '--no-pings', '--metrics-recording-only');
      disabledFeatures.push('OptimizationHints', 'MediaRouter', 'Translate', 'AutofillServerCommunication', 'NetworkPrediction');
    }
    if (disabledFeatures.length) {
      const existing = args.findIndex((a) => a.startsWith('--disable-features='));
      if (existing >= 0) args[existing] = args[existing] + ',' + [...new Set(disabledFeatures)].join(',');
      else args.push(`--disable-features=${[...new Set(disabledFeatures)].join(',')}`);
    }
    // --load-extension for assigned unpacked apps (Win/macOS)
    const loadPaths = extensions.map((entry) => entry.path).filter((p) => p && fs.existsSync(p));
    const finalArgs = loadPaths.length ? mergeLoadExtensionArgs(args, loadPaths) : args;
    let child;
    let connection;
    let port;
    try {
      child = spawn(browser.path, finalArgs, {
        detached: process.platform !== 'win32',
        windowsHide: process.platform === 'win32',
        stdio: 'ignore',
      });
      port = await this.waitForPort(root);
      connection = await portConnection(port);
    } catch (error) {
      if (child && child.exitCode === null) await killProcessTree(child.pid, { force: true, expectedExecutable: browser.path, expectedUserDataDir: root }).catch(() => {});
      await proxyForwarder?.close().catch(() => {});
      await releaseProfileLock(root, profileLock);
      throw error;
    }
    if (profile.cookies && profile.advanced.saveCookies) { try { await this.importProfileCookies(connection, profile.cookies); } catch (error) { this.emit({ type: 'sync-error', action: 'import-cookies', id: profile.id, message: 'Cookie 导入失败：' + error.message }); } }
    let reconciled;
    try { const managedPaths = [...this.extensions.values()].map((item) => item.path).filter(Boolean); reconciled = await reconcileOnConnection(connection, extensions, managedPaths); }
    catch (error) {
      await connection.command('Browser.close').catch(() => {});
      await proxyForwarder?.close().catch(() => {});
      await releaseProfileLock(root, profileLock);
      throw error;
    }
    const markerProcess = this.startNativeProfileMarker(child.pid, profile.number || profile.name || profile.id);
    const item = {
      child, cdpConnection: connection, proxyForwarder, markerProcess, profileLock,
      pid: child.pid, browser, root, profile, port,
      startedAt: new Date().toISOString(),
      extensions: extensions.map((entry) => entry.id),
      loadedExtensions: reconciled.extensions,
      fingerprint,
    };
    const cleanup = (exitedNormally = false) => {
      if (item.cleanedUp) return;
      item.cleanedUp = true;
      this.clearRunningWatch(item);
      item.workerFingerprintConnection?.close();
      if (item.markerProcess && !item.markerProcess.killed) { try { item.markerProcess.kill(); } catch (_) {} }
      item.proxyForwarder?.close().catch(() => {});
      releaseProfileLock(root, profileLock).catch(() => {});
      if (exitedNormally) this.markProfileCleanExit(item.root).catch(() => {});
      this.running.delete(profile.id);
    };
    this.running.set(profile.id, item);
    child.once('exit', (code, signal) => {
      const expected = item.stopping === true || code === 0;
      // If closed by user (not via stop()), still try cloud cookie snapshot while connection may be dead —
      // rely on profile data files on disk; emit close for auto cloud push of opted-in envs.
      const live = this.profiles.get(profile.id) || profile;
      cleanup(expected);
      this.emit({
        type: 'status', id: profile.id, running: false,
        error: expected ? null : `浏览器异常退出${signal ? ` (${signal})` : ` (code ${code})`}`,
        reason: 'browser-exit',
      });
      if (live?.advanced?.cloudBackup && !item.stopping) {
        this.emit({
          type: 'profile-closed',
          id: profile.id,
          cloudBackup: true,
          cookieExported: false,
          profile: live,
          reason: 'browser-exit',
        });
      }
    });
    child.once('error', (error) => { cleanup(false); this.emit({ type: 'status', id: profile.id, running: false, error: error.message }); });
    item.startupExtensionGuard = this.suppressStartupExtensionPages(connection, reconciled.installed).catch((error) => this.emit({ type: 'sync-error', action: 'startup-extension-pages', id: profile.id, message: error.message }));
    try {
      item.startUrl = startUrl;
      if (!restoreSession && startUrl) await this.keepDefaultTab(item.port, startUrl);
      item.fpAppliedTargets = new Set();
      item.fingerprint = await this.applyRuntimeSettings(item.port, profile, fingerprint, {
        appliedTargetIds: item.fpAppliedTargets,
        trackOn: item,
      }) || fingerprint;
      await this.startWorkerFingerprintInjection(item, item.fingerprint).catch((error) => {
        item.workerFingerprintError = error.message;
        this.emit({ type: 'worker-fingerprint-injection-failed', id: profile.id, message: error.message });
      });
      // Brand window title as 环境 N (not generic Chrome)
      await this.applyEnvWindowTitle(item.port, profile).catch(() => {});
    } catch (error) { item.cdpError = error.message; }
    if (!this.running.has(profile.id)) {
      throw new Error(item.cdpError || '浏览器在启动过程中异常退出');
    }
    // Detect user closing browser with X (process may stay alive; CDP/pages are source of truth)
    this.startRunningWatch(item);
    this.emit({ type: 'status', id: profile.id, running: true, ...this.publicRunning(profile.id) });
    return this.publicRunning(profile.id);
  }

  publicRunning(id) {
    const item = this.running.get(id); if (!item) return { id, running: false };
    return {
      id, running: true, pid: item.pid, port: item.port,
      browser: item.browser.name, executable: item.browser.path,
      profileDirectory: item.root,
      extensionCount: item.extensions.length,
      loadedExtensions: item.loadedExtensions || [],
      cdpError: item.cdpError || null,
      fingerprint: item.fingerprint ? {
        platform: item.fingerprint.platform,
        hardwareConcurrency: item.fingerprint.hardwareConcurrency,
        deviceMemory: item.fingerprint.deviceMemory,
        canvas: item.fingerprint.canvas?.mode,
        webgl: item.fingerprint.webgl?.mode,
        webrtc: item.fingerprint.webrtc,
      } : null,
    };
  }

  async stop(id) {
    const safe = assertProfileId(id); const item = this.running.get(safe);
    if (!item) return { id: safe, running: false, alreadyStopped: true };
    item.stopping = true;
    this.clearRunningWatch(item);
    item.workerFingerprintConnection?.close();
    item.workerFingerprintConnection = null;
    const profile = this.profiles.get(safe) || item.profile || {};
    // Snapshot cookies before close when this env opts into cloud backup (close-time Cookie sync)
    let cookieExport = '';
    const wantCookieSnap = profile.advanced?.cloudBackup && profile.advanced?.syncCookiesOnClose !== false;
    if (wantCookieSnap && item.cdpConnection) {
      cookieExport = await this.exportProfileCookies(item.cdpConnection).catch(() => '');
      if (cookieExport) {
        profile.cookies = cookieExport;
        profile.updatedAt = new Date().toISOString();
        this.profiles.set(safe, profile);
        await this.persist().catch(() => {});
      }
    }
    let graceful = item.child.exitCode !== null;
    if (!graceful) {
      // Prefer Browser.close so window-X / empty-window auto-stop fully quits Chromium helpers
      try {
        await Promise.race([
          (async () => {
            try {
              await item.cdpConnection?.command?.('Browser.close', {}, 5000);
            } catch (_) {
              const ws = await cdp.browserSocket(item.port).catch(() => null);
              if (ws) await cdp.call(ws, 'Browser.close', {}, 4000).catch(() => {});
            }
          })(),
          new Promise((resolve) => setTimeout(resolve, 1800)),
        ]);
      } catch (_) {}
      graceful = await new Promise((resolve) => {
        if (item.child.exitCode !== null) return resolve(true);
        const timer = setTimeout(() => { item.child.removeListener('exit', exited); resolve(false); }, 6500);
        const exited = () => { clearTimeout(timer); resolve(true); };
        item.child.once('exit', exited);
      });
    }
    if (!graceful && item.child.exitCode === null) {
      await killProcessTree(item.pid, { force: true, expectedExecutable: item.browser.path, expectedUserDataDir: item.root });
    }
    if (item.markerProcess && !item.markerProcess.killed) { try { item.markerProcess.kill(); } catch (_) {} }
    await item.proxyForwarder?.close().catch(() => {});
    await releaseProfileLock(item.root, item.profileLock);
    await this.markProfileCleanExit(item.root);
    await this.enforceDataRetention(item.root, this.profiles.get(safe) || item.profile).catch(() => {});
    item.cleanedUp = true;
    this.running.delete(safe);
    this.emit({ type: 'status', id: safe, running: false, reason: 'stop' });
    if (profile.advanced?.cloudBackup) {
      this.emit({
        type: 'profile-closed',
        id: safe,
        cloudBackup: true,
        cookieExported: Boolean(cookieExport),
        profile: this.profiles.get(safe) || profile,
      });
    }
    return { id: safe, running: false, graceful, cookieExported: Boolean(cookieExport) };
  }

  async stopAll() { await Promise.all([...this.running.keys()].map((id) => this.stop(id))); }

  async deleteProfiles(ids, deleteData = true) {
    if (!Array.isArray(ids) || ids.length > 200) throw new Error('Invalid profile selection');
    const safeIds = [...new Set(ids.map(assertProfileId))];
    const deleted = []; let stopped = 0;
    for (const id of safeIds) {
      if (!this.profiles.has(id)) continue;
      if (this.running.has(id)) { await this.stop(id); stopped += 1; }
      this.profiles.delete(id); this.assignments.delete(id); this.networkInfo.delete(id); deleted.push(id);
      if (deleteData) {
        const profileRoot = this.profileRoot(id);
        const rootCheck = await validateProfileRootSecure(this.profileDataRootPath, profileRoot, id);
        if (!rootCheck.ok) throw new Error('Isolation error: ' + rootCheck.message);
        if (fs.existsSync(profileRoot)) await fsp.rm(profileRoot, { recursive: true, force: true });
      }
    }
    await this.persist();
    this.emit({ type: 'profiles', action: 'delete', ids: deleted }); this.emit({ type: 'extensions' });
    return { success: true, deleted: deleted.length, stopped, dataDeleted: Boolean(deleteData), ids: deleted };
  }

  status() { return [...this.profiles.values()].map((profile) => ({ ...profile, ...this.publicRunning(profile.id), network: this.networkInfo.get(profile.id) || null, assignedExtensions: [...(this.assignments.get(profile.id) || [])] })); }

  async resolveProfileProxyConfig(profile, { allowExtract = true } = {}) {
    const working = this.sanitizeProfile(profile);
    let lastError = null;
    const candidates = [];
    const pushCandidate = (value, source) => {
      const raw = String(value || '').trim();
      if (!raw || /^(direct|offline|none)$/i.test(raw)) return;
      if (candidates.some((item) => item.raw === raw)) return;
      candidates.push({ raw, source });
    };
    pushCandidate(working.proxy, 'primary');
    for (const item of working.proxyMeta?.backupProxies || []) pushCandidate(item, 'backup');
    if (allowExtract) {
      const extractUrl = String(working.proxyMeta?.apiExtractUrl || '').trim();
      if (extractUrl) {
        try {
          const extracted = await extractProxyFromApi(extractUrl);
          const raw = extracted.raw || (
            extracted.protocol + '://'
            + (extracted.username ? (encodeURIComponent(extracted.username) + ':' + encodeURIComponent(extracted.password) + '@') : '')
            + extracted.host + ':' + extracted.port
          );
          pushCandidate(raw, 'api');
        } catch (error) {
          lastError = error;
        }
      }
    }
    if (!candidates.length) {
      if (lastError) throw lastError;
      throw new Error('Direct environments do not have a proxy exit to inspect');
    }
    const errors = [];
    for (const candidate of candidates) {
      try {
        const config = parseProxy(candidate.raw);
        if (!config) continue;
        return { profile: working, config, raw: candidate.raw, source: candidate.source };
      } catch (error) {
        errors.push(String(error.message || error));
      }
    }
    throw new Error(errors[0] || '代理配置无效');
  }

  fingerprintPatchFromNetwork(network = {}, profile = {}) {
    const privacy = { ...(profile.privacy || {}) };
    const language = resolveProfileLanguage({
      ...profile,
      privacy: { ...privacy, languageMode: privacy.languageMode || 'ip' },
    }, network);
    const patch = {
      exitIp: network.ip || '',
      exitCountryCode: network.countryCode || '',
      exitTimezone: network.timezone || '',
      exitLatitude: network.latitude ?? null,
      exitLongitude: network.longitude ?? null,
      exitCheckedAt: network.checkedAt || new Date().toISOString(),
      language,
      privacy: { ...privacy },
    };
    if ((privacy.timezoneMode === 'ip' || !privacy.timezoneMode) && network.timezone) {
      patch.privacy.timezoneMode = 'ip';
      patch.privacy.timezone = network.timezone;
    }
    if ((privacy.languageMode === 'ip' || privacy.langFromIp !== false) && language) {
      patch.privacy.languageMode = privacy.languageMode || 'ip';
      patch.language = language;
    }
    return patch;
  }

  applyNetworkToProfile(profile, network, { persist = false } = {}) {
    const patch = this.fingerprintPatchFromNetwork(network, profile);
    const next = this.sanitizeProfile({
      ...profile,
      ...patch,
      privacy: {
        ...(profile.privacy || {}),
        ...(patch.privacy || {}),
      },
    });
    this.profiles.set(next.id, next);
    this.networkInfo.set(next.id, network);
    if (persist) this.persist().catch(() => {});
    this.emit({ type: 'status', id: next.id, running: this.running.has(next.id), network, profile: next });
    return { profile: next, network, patch };
  }

  async testProxy(raw, options = {}) {
    const profile = this.sanitizeProfile(raw);
    const forcedRaw = String(options.proxy || options.forcedProxy || '').trim();
    let resolved;
    if (forcedRaw && !/^(direct|offline|none)$/i.test(forcedRaw)) {
      const config = parseProxy(forcedRaw);
      if (!config) throw new Error('代理配置无效');
      resolved = { profile, config, raw: forcedRaw, source: options.proxySource || 'forced' };
    } else {
      resolved = await this.resolveProfileProxyConfig(profile, { allowExtract: options.allowExtract !== false });
    }
    try {
      const result = await retryProxyOperation(() => lookupProxyCountry(resolved.config));
      return {
        ...result,
        protocol: resolved.config.protocol,
        endpoint: resolved.config.host + ':' + resolved.config.port,
        proxySource: resolved.source,
        proxyRaw: resolved.raw,
        errorClass: null,
      };
    } catch (error) {
      const err = new Error(error.message || String(error));
      err.errorClass = error.errorClass || classifyProxyError(error);
      err.latencyMs = error.latencyMs;
      throw err;
    }
  }

  async checkProxy(raw, options = {}) {
    const profile = this.sanitizeProfile(raw);
    const network = await this.testProxy(profile, options);
    const applied = this.applyNetworkToProfile(profile, network, { persist: Boolean(options.persist) });
    return {
      ...network,
      appliedFingerprint: applied.patch,
      profile: applied.profile,
    };
  }

  async refreshProfileProxy(raw) {
    const profile = this.sanitizeProfile(raw);
    const refreshUrl = String(profile.proxyMeta?.refreshUrl || '').trim();
    const extractUrl = String(profile.proxyMeta?.apiExtractUrl || '').trim();
    const url = refreshUrl || extractUrl;
    if (!url) throw new Error('未配置刷新 URL');
    const refresh = await invokeProxyRefresh(url);
    let nextProfile = profile;
    let extractError = null;
    if (extractUrl) {
      try {
        const extracted = await extractProxyFromApi(extractUrl);
        const rawProxy = extracted.raw || (
          extracted.protocol + '://'
          + (extracted.username ? (encodeURIComponent(extracted.username) + ':' + encodeURIComponent(extracted.password) + '@') : '')
          + extracted.host + ':' + extracted.port
        );
        nextProfile = this.sanitizeProfile({ ...profile, networkMode: 'proxy', proxy: rawProxy });
        this.profiles.set(nextProfile.id, nextProfile);
      } catch (error) {
        extractError = error;
        if (!profile.proxy || /^(direct|offline|none)$/i.test(String(profile.proxy))) {
          throw new Error('动态代理提取失败：' + (error.message || error));
        }
      }
    }
    const network = await this.checkProxy(nextProfile, { allowExtract: false, persist: true });
    return {
      refresh,
      network,
      profile: this.profiles.get(nextProfile.id),
      extractError: extractError ? String(extractError.message || extractError) : null,
    };
  }

  async prepareProfileProxyForStart(profile) {
    let working = this.sanitizeProfile(profile);
    const meta = working.proxyMeta || {};
    const hasProxy = working.proxy && !/^(direct|offline|none)$/i.test(String(working.proxy));
    const extractUrl = String(meta.apiExtractUrl || '').trim();
    if (extractUrl) {
      try {
        const extracted = await extractProxyFromApi(extractUrl);
        const rawProxy = extracted.raw || (
          extracted.protocol + '://'
          + (extracted.username ? (encodeURIComponent(extracted.username) + ':' + encodeURIComponent(extracted.password) + '@') : '')
          + extracted.host + ':' + extracted.port
        );
        working = this.sanitizeProfile({ ...working, networkMode: 'proxy', proxy: rawProxy });
      } catch (error) {
        if (!hasProxy) throw new Error('动态代理提取失败：' + (error.message || error));
      }
    }
    if (meta.refreshOnStart && String(meta.refreshUrl || '').trim()) {
      try {
        await invokeProxyRefresh(meta.refreshUrl);
      } catch (error) {
        this.emit({ type: 'proxy-error', id: working.id, message: '启动前刷新代理失败：' + (error.message || error) });
        throw new Error('启动前刷新代理失败：' + (error.message || error));
      }
    }
    const shouldCheck = meta.checkOnStart || meta.refreshOnStart || Boolean(extractUrl);
    if (shouldCheck && working.proxy && !/^(direct|offline|none)$/i.test(String(working.proxy))) {
      const candidates = [];
      const push = (value) => {
        const raw = String(value || '').trim();
        if (!raw || /^(direct|offline|none)$/i.test(raw)) return;
        if (!candidates.includes(raw)) candidates.push(raw);
      };
      push(working.proxy);
      for (const item of meta.backupProxies || []) push(item);
      let lastError = null;
      let ok = false;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        try {
          const network = await this.testProxy(working, {
            allowExtract: false,
            proxy: candidate,
            proxySource: index === 0 ? 'primary' : 'backup',
          });
          working = this.sanitizeProfile({ ...working, networkMode: 'proxy', proxy: network.proxyRaw || candidate });
          this.applyNetworkToProfile(working, network, { persist: false });
          ok = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!ok && lastError) {
        const policy = String(meta.notReadyPolicy || (meta.requireReady === false ? 'continue' : 'block'));
        const message = '启动前代理未就绪：' + (lastError.message || lastError);
        this.emit({ type: 'proxy-error', id: working.id, code: 'proxy-not-ready', message, policy });
        if (policy === 'direct') {
          working = this.sanitizeProfile({ ...working, networkMode: 'direct', proxy: 'Direct' });
          this.emit({ type: 'proxy-fallback', id: working.id, message: '代理未就绪，已按策略回落直连' });
        } else if (policy === 'continue') {
          this.emit({ type: 'proxy-warn', id: working.id, message: message + '（continue 策略，继续启动）' });
        } else {
          throw new Error(message);
        }
      }
    } else if (
      working.networkMode === 'proxy'
      && working.proxy
      && !/^(direct|offline|none)$/i.test(String(working.proxy))
      && meta.requireReady !== false
      && meta.notReadyPolicy === 'block'
      && !shouldCheck
      && !this.networkInfo.get(working.id)?.ip
    ) {
      // Soft gate: proxy mode without any known exit IP and without deferred check still starts,
      // but mark not-ready so callers/UI can surface it. Hard block only when check was requested.
      this.emit({ type: 'proxy-warn', id: working.id, code: 'proxy-unchecked', message: '代理模式尚未检测出口，继续启动' });
    }
    return working;
  }

  async readExtension(directory, builtIn = false) {
    const extensionPath = await assertExtensionTreeSafe(directory);
    const manifestPath = path.join(extensionPath, 'manifest.json'); const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (![2, 3].includes(manifest.manifest_version) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('The selected folder does not contain a valid Chrome extension manifest');
    let messages = {}; const locale = String(manifest.default_locale || 'en').replace(/[^a-zA-Z0-9_-]/g, '');
    for (const candidate of [locale, 'en', 'en_US', 'zh_CN']) { try { messages = JSON.parse(await fsp.readFile(path.join(extensionPath, '_locales', candidate, 'messages.json'), 'utf8')); if (Object.keys(messages).length) break; } catch (_) {} }
    const localized = (text) => { const match = String(text || '').match(/^__MSG_([^_].*?)__$/i); return match && messages[match[1]]?.message ? String(messages[match[1]].message) : String(text || ''); };
    const iconSource = this.extensionIconSource(manifest);
    let iconUrl = null;
    if (iconSource) {
      const iconPath = path.resolve(extensionPath, iconSource.replace(/^[/\\]+/, ''));
      if (isPathInsideOrEqual(iconPath, extensionPath)) {
        try {
          const iconRealPath = await fsp.realpath(iconPath);
          const iconStat = await fsp.lstat(iconPath);
          if (!iconStat.isSymbolicLink() && iconStat.isFile() && isPathInsideOrEqual(iconRealPath, extensionPath)) iconUrl = pathToFileURL(iconRealPath).toString();
        } catch (_) {}
      }
    }
    const id = crypto.createHash('sha256').update(extensionPath.toLowerCase()).digest('hex').slice(0, 20);
    return { id, name: localized(manifest.name), version: manifest.version, description: localized(manifest.description), manifestVersion: manifest.manifest_version, path: extensionPath, iconUrl, builtIn, addedAt: new Date().toISOString() };
  }

  extensionIconSource(manifest) {
    const iconSets = [manifest.icons, manifest.action?.default_icon, manifest.browser_action?.default_icon, manifest.page_action?.default_icon];
    for (const iconSet of iconSets) {
      if (typeof iconSet === 'string') return iconSet;
      if (!iconSet || typeof iconSet !== 'object') continue;
      const candidates = Object.entries(iconSet)
        .filter(([, value]) => typeof value === 'string')
        .sort(([left], [right]) => Number(right) - Number(left));
      if (candidates[0]) return candidates[0][1];
    }
    return null;
  }

  async addExtension(directory) { const value = await this.readExtension(directory, false); this.extensions.set(value.id, value); await this.persist(); this.emit({ type: 'extensions' }); return value; }
  async addStoreExtension(url, fetchPackage) { const value = await addChromeStoreExtension(url, this.app.getPath('userData'), (directory, builtIn) => this.readExtension(directory, builtIn), fetchPackage); this.extensions.set(value.id, value); await this.persist(); this.emit({ type: 'extensions' }); return value; }
  listExtensions() {
    const profileIds = [...this.profiles.keys()];
    return [...this.extensions.values()].map((item) => {
      const assignedProfileIds = profileIds.filter((id) => (this.assignments.get(id) || new Set()).has(item.id));
      return { ...item, assignedProfiles: assignedProfileIds.length, assignedProfileIds, enabledAll: profileIds.length > 0 && assignedProfileIds.length === profileIds.length };
    });
  }
  async assignExtension(extensionId, profileIds, enabled) {
    if (!this.extensions.has(extensionId)) throw new Error('Unknown extension');
    if (!Array.isArray(profileIds) || profileIds.length > 1000) throw new Error('Invalid profile list');
    for (const profileId of profileIds) { const safe = assertProfileId(profileId); const set = this.assignments.get(safe) || new Set(); if (enabled) set.add(extensionId); else set.delete(extensionId); this.assignments.set(safe, set); }
    await this.persist(); this.emit({ type: 'extensions' }); return { success: true, restartRequired: profileIds.filter((id) => this.running.has(id)) };
  }
  async removeExtension(id) { const value = this.extensions.get(id); if (!value || value.builtIn) throw new Error('Built-in extension cannot be removed'); this.extensions.delete(id); for (const set of this.assignments.values()) set.delete(id); await this.persist(); return { success: true }; }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(value) { for (const listener of this.listeners) listener(value); }
  runningWithCdp(ids) { return ids.map((id) => ({ id, item: this.running.get(id) })).filter((entry) => entry.item?.port); }
  async sessions() { const result = []; for (const { id, item } of this.runningWithCdp([...this.running.keys()])) { try { result.push({ id, profile: this.profiles.get(id), port: item.port, browser: item.browser.name, tabs: await cdp.tabs(item.port) }); } catch (error) { result.push({ id, profile: this.profiles.get(id), port: item.port, browser: item.browser.name, tabs: [], error: error.message }); } } return result; }
}

module.exports = { BrowserEngine };
