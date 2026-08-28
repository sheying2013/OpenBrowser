const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn, execFileSync } = require('child_process');
const cdp = require('./cdp');
const { addChromeStoreExtension } = require('./store-extension');
const { reconcileOnConnection, portConnection } = require('./extension-pipe');
const { parseProxy, displayProxy, startAuthenticatedProxy, lookupProxyCountry, lookupDirectCountry, extractProxyFromApi, invokeProxyRefresh, classifyProxyError, normalizeIpLookupChannel } = require('./proxy-forwarder');
const { resolveProfileLanguage, localeFromCountryCode } = require('./automation/locale-from-country');
const { mergeLoadExtensionArgs } = require('./automation/protocol/app-center-protocol');
const { prepareMarkerExtension, prepareMacDockWrapper, normalizeEnvNumber } = require('./automation/env-icon');
const { toFileUrl, killProcessTree } = require('./automation/protocol/cross-platform');
const { platformPreflight } = require('./automation/platform-preflight');
const { buildFingerprint, buildWorkerInjectionScript, chromeArgsForFingerprint, applyFingerprintToTab } = require('./automation/fingerprint');
const { acquireProfileLock, updateProfileLock, releaseProfileLock, terminateProcessesUsingProfile, auditIsolation, isSystemBrowserExecutable, isPathInsideOrEqual, validateDataRootIsolationSecure, validateProfileRootSecure, assertProfileId, assertSafeProfileChild } = require('./automation/isolation');
const { BrowserKernelManager, ensureKernelReadyForLaunch } = require('./automation/browser-kernel');
const { ensureStartPageServer, getStartPageServer } = require('./automation/start-page-server');
const {
  isOpenBrowser148,
  writeOpenBrowserKernelInit,
  fingerprintForNativeKernelInject,
} = require('./automation/kernel-init-sync');
const { fpLog, summarizeFp, LIVE_PROBE_EXPRESSION, logPath: fingerprintLogPath } = require('./automation/fingerprint-debug-log');

const KERNEL_POLICY_VERSION = 4;
const MAX_PROFILE_PROXY_LENGTH = 64 * 1024;

function parsedProxy(value) {
  try {
    return parseProxy(String(value || '').trim());
  } catch (_) {
    return null;
  }
}

function proxyHasCredentials(value) {
  return Boolean(parsedProxy(value)?.authenticated);
}

function sameProxyEndpoint(left, right) {
  const a = parsedProxy(left);
  const b = parsedProxy(right);
  return Boolean(a && b && a.protocol === b.protocol && a.host === b.host && a.port === b.port);
}

/** Kill options that match both kernel binary and macOS env Dock shell (OpenBrowser.bin). */
function managedBrowserKillOptions(itemOrBrowser, root, launchBinary = null) {
  const browserPath = itemOrBrowser?.browser?.path || itemOrBrowser?.path || itemOrBrowser || null;
  const launch = launchBinary || itemOrBrowser?.launchBinary || null;
  const executables = [launch, browserPath, 'OpenBrowser.bin', 'OpenBrowser'].filter(Boolean);
  return {
    force: true,
    expectedExecutables: [...new Set(executables.map((v) => String(v)))],
    expectedUserDataDir: root || itemOrBrowser?.root || null,
  };
}

const STARTUP_DIAGNOSTIC_LIMIT = 16 * 1024;

function systemBrowserCandidatesForPlatform(platform = process.platform, environment = process.env) {
  const home = environment.HOME || '';
  if (platform === 'darwin') {
    return [
      { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Google Chrome', path: path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') },
      { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
      { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    ];
  }
  if (platform === 'linux') {
    return [
      { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
      { name: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
      { name: 'Chromium', path: '/usr/bin/chromium' },
      { name: 'Chromium', path: '/usr/bin/chromium-browser' },
    ];
  }

  const windowsPath = path.win32;
  const programFiles = [
    environment.PROGRAMFILES,
    environment['PROGRAMFILES(X86)'],
    environment.PROGRAMW6432,
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter(Boolean);
  const localAppData = environment.LOCALAPPDATA ? [environment.LOCALAPPDATA] : [];
  const roots = [...new Set([...programFiles, ...localAppData])];
  return [
    ...roots.map((root) => ({ name: 'Google Chrome', path: windowsPath.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') })),
    ...roots.map((root) => ({ name: 'Microsoft Edge', path: windowsPath.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') })),
  ].filter((item, index, all) => all.findIndex((other) => other.path.toLowerCase() === item.path.toLowerCase()) === index);
}

function appendDiagnosticOutput(current, chunk) {
  const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
  return (String(current || '') + value).slice(-STARTUP_DIAGNOSTIC_LIMIT);
}

function formatBrowserStartupError(error, child, diagnostic = {}) {
  const base = String(error?.message || error || 'Browser startup failed').trim();
  if (base.includes('[executable=')) return base;
  const details = [];
  if (diagnostic.launchBinary) details.push(`executable=${diagnostic.launchBinary}`);
  if (diagnostic.profileRoot) details.push(`profile=${diagnostic.profileRoot}`);
  if (child?.pid) details.push(`pid=${child.pid}`);
  if (child?.exitCode !== null && child?.exitCode !== undefined) details.push(`exitCode=${child.exitCode}`);
  if (child?.signalCode) details.push(`signal=${child.signalCode}`);
  const output = [diagnostic.stderr, diagnostic.stdout]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (output.length) details.push(`browserOutput=${output.join(' | ')}`);
  return details.length ? `${base} [${details.join('; ')}]` : base;
}

async function writeBrowserStartupDiagnostic(userDataPath, record) {
  try {
    const logDir = path.join(userDataPath, 'logs');
    await fsp.mkdir(logDir, { recursive: true });
    const file = path.join(logDir, 'browser-startup.log');
    const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n';
    await fsp.appendFile(file, line, 'utf8');
    const stat = await fsp.stat(file);
    if (stat.size > 512 * 1024) {
      const content = await fsp.readFile(file, 'utf8');
      await fsp.writeFile(file, content.slice(-256 * 1024), 'utf8');
    }
  } catch (_) {}
}

/** Best-effort: stop detached ipc-stub.py for this env's kernel window name. */
function stopIpcStubForWindow(windowName) {
  const win = String(windowName || '').trim();
  if (!win || process.platform === 'win32') return false;
  // Only allow our stable SB* window tokens in the pkill pattern.
  if (!/^SB[0-9A-Za-z_-]{4,64}$/.test(win)) return false;
  try {
    // Anchor end-of-arg so SB123 does not pkill SB1234 / SB12345.
    const regexMode = process.platform === 'darwin' ? ['-E'] : [];
    execFileSync('pkill', [...regexMode, '-f', `ipc-stub\\.py ${win}( |$)`], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

async function writeRawAtomically(filePath, value, mode = 0o600) {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let handle = null;
  try {
    handle = await fsp.open(temporary, 'wx', mode);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, filePath);
    // A directory fsync is supported on POSIX and harmlessly skipped on Windows.
    try {
      const directoryHandle = await fsp.open(directory, 'r');
      await directoryHandle.sync();
      await directoryHandle.close();
    } catch (_) {}
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeJsonAtomically(filePath, value, mode = 0o600) {
  // Keep the last valid state available for recovery after a power loss or a
  // renderer-triggered write that is interrupted halfway through.
  let previous = null;
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    JSON.parse(raw);
    previous = raw;
  } catch (error) {
    if (error.code === 'ENOENT') previous = null;
    // A corrupt current file is deliberately not copied over the good .bak.
  }
  if (previous != null) await writeRawAtomically(`${filePath}.bak`, previous, mode);
  await writeRawAtomically(filePath, value, mode);
}

async function readEngineStateCandidate(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  const saved = JSON.parse(raw);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    throw new Error('引擎状态文件格式无效');
  }
  return { path: filePath, saved };
}

async function engineStateRecoveryCandidates(filePath) {
  const directory = path.dirname(filePath);
  const base = path.basename(filePath);
  let names = [];
  try {
    names = await fsp.readdir(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const candidates = [
    `${filePath}.bak`,
    `${filePath}.tmp`,
    ...names.filter((name) => name.startsWith(base + '.tmp-')).map((name) => path.join(directory, name)),
  ];
  const valid = [];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const state = await readEngineStateCandidate(candidate);
      const stat = await fsp.stat(candidate);
      valid.push({ ...state, mtimeMs: stat.mtimeMs });
    } catch (_) {}
  }
  return valid.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function preserveCorruptEngineState(filePath) {
  const target = `${filePath}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await fsp.rename(filePath, target);
    return target;
  } catch (_) {
    return null;
  }
}

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
    // Per-profile lifecycle barriers. A browser must finish stopping (including
    // process-tree, proxy bridge, and profile-lock cleanup) before a new start
    // can acquire the same profile.
    this.starting = new Map();
    this.stopping = new Map();
    this._persistQueue = Promise.resolve();
    this.networkInfo = new Map();
    this.extensions = new Map();
    this.assignments = new Map();
    this.listeners = new Set();
    this.stateFile = path.join(app.getPath('userData'), 'openbrowser-engine.json');
    const profileDataRoot = String(options.profileDataRoot || path.join(app.getPath('userData'), 'browser-profiles-v2'));
    const profileDataRootCheck = validateDataRootIsolationSecure(profileDataRoot);
    if (!profileDataRootCheck.ok) throw new Error(profileDataRootCheck.message);
    this.profileDataRootPath = profileDataRootCheck.root;
    // Source-tree + packaged discovery for OpenBrowser 148 kernel.
    // Layout: Browserapp/kernels/macos-x64/chrome_148/openbrowser_148/OpenBrowser.app/...
    // Env override: OPENBROWSER_KERNEL_ROOT = dir that contains openbrowser/ chrome_148 ...
    const resourceRoots = [];
    try {
      if (typeof process !== 'undefined' && process.resourcesPath) resourceRoots.push(process.resourcesPath);
    } catch (_) {}
    try {
      resourceRoots.push(__dirname);
      resourceRoots.push(path.join(__dirname, 'kernels'));
      resourceRoots.push(path.join(__dirname, 'resources'));
      resourceRoots.push(path.join(__dirname, '..', 'resources'));
    } catch (_) {}
    try {
      const envRoot = String(process.env.OPENBROWSER_KERNEL_ROOT || '').trim();
      if (envRoot) resourceRoots.push(envRoot);
    } catch (_) {}
    this.kernelManager = new BrowserKernelManager(app.getPath('userData'), {
      onProgress: (p) => this.emit({ type: 'kernel-progress', ...p }),
      resourceRoots,
    });
    this.preferIndependentKernel = options.preferIndependentKernel !== false;
    // A fingerprint environment must never launch the user's installed browser.
    this.allowSystemBrowserFallback = false;
    this.systemBrowserPath = null;
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
    // 1) Independent kernel (integrated / custom) — first priority
    const independent = this.kernelManager.resolveInstalled();
    if (independent) list.push({ name: independent.name, path: independent.path, independent: true, version: independent.version, source: independent.source });

    // 2) System browsers are exposed for explicit manual selection only.
    for (const item of this.systemBrowserCandidates()) list.push({ ...item, independent: false });
    return list.filter((item, index, all) => fs.existsSync(item.path) && all.findIndex((other) => other.path === item.path) === index);
  }

  systemBrowserCandidates() {
    return systemBrowserCandidatesForPlatform();
  }

  async init(bundledExtensionPath) {
    await this.kernelManager.loadMeta();
    let migrateKernelPolicy = false;
    let recoveredState = false;
    let state = null;
    let primaryStateError = null;
    try {
      state = await readEngineStateCandidate(this.stateFile);
    } catch (error) {
      primaryStateError = error;
    }
    if (!state) {
      const recovery = await engineStateRecoveryCandidates(this.stateFile);
      if (recovery.length) {
        state = recovery[0];
        recoveredState = true;
        if (primaryStateError && primaryStateError.code !== 'ENOENT') {
          await preserveCorruptEngineState(this.stateFile);
        }
      }
    }
    if (!state && primaryStateError && primaryStateError.code !== 'ENOENT') {
      throw new Error(`引擎状态文件损坏且没有可用备份: ${primaryStateError.message || primaryStateError}`);
    }
    if (state) {
      const saved = state.saved;
      for (const extension of saved.extensions || []) if (fs.existsSync(extension.path)) this.extensions.set(extension.id, extension);
      for (const [profileId, ids] of Object.entries(saved.assignments || {})) this.assignments.set(profileId, new Set(ids));
      // Profiles (incl. cookies / proxy auth / platform secrets) live in main-process state,
      // not renderer localStorage, so XSS cannot dump them from the UI store.
      if (Array.isArray(saved.profiles)) {
        for (const raw of saved.profiles.slice(0, 1000)) {
          try {
            const profile = this.sanitizeProfile(raw);
            this.profiles.set(profile.id, profile);
          } catch (_) {}
        }
      }
      if (typeof saved.preferIndependentKernel === 'boolean') this.preferIndependentKernel = saved.preferIndependentKernel;
      if (saved.kernelPolicyVersion !== KERNEL_POLICY_VERSION) {
        // Prior releases could select a system browser implicitly. Migrate to
        // the explicit-selection policy and keep fallback disabled by default.
        this.allowSystemBrowserFallback = false;
        this.systemBrowserPath = null;
        migrateKernelPolicy = true;
      } else if (typeof saved.allowSystemBrowserFallback === 'boolean') {
        this.allowSystemBrowserFallback = saved.allowSystemBrowserFallback;
        if (typeof saved.systemBrowserPath === 'string') this.systemBrowserPath = saved.systemBrowserPath;
      }
    }
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
    if (migrateKernelPolicy || recoveredState) await this.persist();
  }

  persist() {
    const assignments = Object.fromEntries([...this.assignments].map(([id, values]) => [id, [...values]]));
    const payload = JSON.stringify({
      extensions: [...this.extensions.values()],
      assignments,
      profiles: [...this.profiles.values()],
      kernelPolicyVersion: KERNEL_POLICY_VERSION,
      preferIndependentKernel: this.preferIndependentKernel,
      allowSystemBrowserFallback: this.allowSystemBrowserFallback,
      systemBrowserPath: this.systemBrowserPath,
    }, null, 2);
    const write = () => writeJsonAtomically(this.stateFile, payload);
    const previous = this._persistQueue || Promise.resolve();
    const queued = previous.then(write, write);
    this._persistQueue = queued.catch(() => {});
    return queued;
  }

  flushPersistence() {
    return this._persistQueue || Promise.resolve();
  }

  kernelStatus() {
    return this.kernelManager.status();
  }

  async ensureKernelBootstrap() {
    if (this.kernelStatus().installed) return this.kernelStatus().kernel;
    if (!this.kernelBootstrapPromise) {
      this.emit({ type: 'kernel-progress', phase: 'bootstrap', message: '首次启动：正在定位内置独立浏览器内核…' });
      this.kernelBootstrapPromise = this.ensureIndependentKernel(false)
        .catch((error) => {
          this.emit({ type: 'kernel-error', message: '内置独立内核不可用：' + error.message });
          throw error;
        })
        .finally(() => { this.kernelBootstrapPromise = null; });
    }
    return this.kernelBootstrapPromise;
  }

  /**
   * Resolve the integrated independent kernel only.
   * Runtime auto-download of Wayfern / Chrome for Testing is permanently disabled.
   */
  async ensureIndependentKernel(force = false) {
    const kernel = await this.kernelManager.ensureIntegrated(force);
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

  async setKernelPolicy({ preferIndependentKernel, allowSystemBrowserFallback, systemBrowserPath } = {}) {
    if (typeof preferIndependentKernel === 'boolean') this.preferIndependentKernel = preferIndependentKernel;
    if (typeof allowSystemBrowserFallback === 'boolean') this.allowSystemBrowserFallback = allowSystemBrowserFallback;
    if (systemBrowserPath !== undefined) {
      const candidate = String(systemBrowserPath || '').trim();
      if (candidate && !this.systemBrowserCandidates().some((item) => item.path === candidate)) {
        throw new Error('所选本机浏览器不存在或不是支持的浏览器');
      }
      this.systemBrowserPath = candidate || null;
    }
    await this.persist();
    return {
      preferIndependentKernel: this.preferIndependentKernel,
      allowSystemBrowserFallback: this.allowSystemBrowserFallback,
      systemBrowserPath: this.systemBrowserPath,
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
    const rawProxy = String(value.proxy || '').trim();
    if (rawProxy.length > MAX_PROFILE_PROXY_LENGTH) throw new Error('Proxy URL is too long');
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
      exitCheckedAt: String(value.exitCheckedAt || '').slice(0, 40),
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
        ipChannel: normalizeIpLookupChannel(proxyMetaValue.ipChannel),
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
        // 'persona' draws CPU/memory/GPU/display from one real-world machine instead of
        // sampling each axis on its own. Defaults to 'default' so an existing profile's
        // hardware identity never changes underneath it.
        deviceProfile: allowed(privacyValue.deviceProfile, ['default', 'persona'], 'default'),
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
        // Keep 0 (= real hardware). Do NOT use `cores || nested` — 0 is falsy and was wiped to "auto".
        fingerprint: privacyValue.fingerprint && typeof privacyValue.fingerprint === 'object' ? {
          ...privacyValue.fingerprint,
          cores: cores === null || cores === undefined
            ? (privacyValue.fingerprint.cores === 0 || privacyValue.fingerprint.cores === '0'
              ? 0
              : (privacyValue.fingerprint.cores ?? null))
            : cores,
          memory: memory === null || memory === undefined
            ? (privacyValue.fingerprint.memory === 0 || privacyValue.fingerprint.memory === '0'
              ? 0
              : (privacyValue.fingerprint.memory ?? null))
            : memory,
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

  async syncProfiles(values) {
    if (!Array.isArray(values) || values.length > 1000) throw new Error('Invalid profile list');
    const existingIds = [...this.profiles.keys()];
    const globallyEnabled = existingIds.length ? [...this.extensions.keys()].filter((extensionId) => existingIds.every((profileId) => (this.assignments.get(profileId) || new Set()).has(extensionId))) : [];
    let assignmentsChanged = false;
    const incomingIds = new Set();
    for (const value of values) {
      const profile = this.sanitizeProfile(value);
      const previous = this.profiles.get(profile.id);
      const isNew = !previous;
      // UI may send redacted proxy (no auth) after localStorage reload. Prefer previous
      // authenticated form only when host:port match and incoming lacks credentials.
      let merged = profile;
      if (previous) {
        const nextProxy = String(profile.proxy || '');
        const prevProxy = String(previous.proxy || '');
        const nextHasAuth = proxyHasCredentials(nextProxy);
        const prevHasAuth = proxyHasCredentials(prevProxy);
        const explicitlyCleared = value?.proxyAuthAction === 'clear';
        if (!explicitlyCleared && !nextHasAuth && prevHasAuth && sameProxyEndpoint(prevProxy, nextProxy)) {
          merged = this.sanitizeProfile({ ...profile, proxy: prevProxy });
        }
        // Restore cookies/platform secrets only when UI clearly redacted ALL of them
        // (post-localStorage load) while engine still holds values — not when user
        // intentionally cleared a single field in the editor.
        const uiLooksRedacted = !String(profile.cookies || '').trim()
          && !String(profile.platform?.password || '').trim()
          && !String(profile.platform?.totpSecret || '').trim()
          && (
            String(previous.cookies || '').trim()
            || String(previous.platform?.password || '').trim()
            || String(previous.platform?.totpSecret || '').trim()
          );
        if (uiLooksRedacted) {
          merged = this.sanitizeProfile({
            ...merged,
            cookies: previous.cookies || '',
            platform: {
              ...(merged.platform || {}),
              password: previous.platform?.password || '',
              totpSecret: previous.platform?.totpSecret || '',
            },
          });
        }
        // Renderer storage intentionally omits runtime exit details. Keep the engine's
        // last successful result unless the proxy itself changed (which invalidates it).
        if (previous.proxy === merged.proxy && previous.exitIp && !profile.exitIp) {
          merged = this.sanitizeProfile({
            ...merged,
            exitIp: previous.exitIp,
            exitCountryCode: previous.exitCountryCode,
            exitTimezone: previous.exitTimezone,
            exitLatitude: previous.exitLatitude,
            exitLongitude: previous.exitLongitude,
            exitCheckedAt: previous.exitCheckedAt,
            exitLatencyMs: previous.exitLatencyMs,
            exitNetworkType: previous.exitNetworkType,
          });
        }
      }
      if (previous && previous.proxy !== merged.proxy) this.networkInfo.delete(profile.id);
      this.profiles.set(merged.id, merged);
      incomingIds.add(merged.id);
      const hasSavedAssignment = this.assignments.has(merged.id);
      if (isNew || !hasSavedAssignment) {
        const assigned = this.assignments.get(merged.id) || new Set();
        for (const extensionId of globallyEnabled) assigned.add(extensionId);
        // The bundled marker is part of the environment contract.
        for (const [extensionId, extension] of this.extensions) {
          if (extension.builtIn) assigned.add(extensionId);
        }
        this.assignments.set(merged.id, assigned); assignmentsChanged = true;
      }
    }
    // Do not drop unknown engine profiles here — deleteProfiles is the explicit path.
    await this.persist();
    return this.status();
  }

  getProfileDataRoot() { return this.profileDataRootPath; }

  /**
   * Cross-platform preflight against the current data root + real profile ids.
   * Pure/cheap: surfaces Windows MAX_PATH risk, missing env, Linux sandbox, etc.
   */
  platformPreflightReport() {
    const ids = [...this.profiles.keys()];
    const maxProfileIdLen = ids.reduce((m, id) => Math.max(m, String(id).length), 0) || undefined;
    // The integrated anti-detect kernel (openbrowser-148) is x64-only by design — see
    // isOpenBrowser148SupportedHost / the macos-x64 bundle layout. Pass that fact through so
    // the arm64 advisories (mac-arm-rosetta / win-arm-kernel) can fire on Apple Silicon and
    // Windows-on-ARM; without it those branches were unreachable. The arch === 'arm64' guard
    // inside platformPreflight keeps x64 hosts silent.
    return platformPreflight({
      profileDataRoot: this.profileDataRootPath,
      maxProfileIdLen,
      kernelRequiresX64: true,
    });
  }

  setProfileDataRoot(value) {
    const raw = String(value || '').trim();
    if (!raw) throw new Error('Environment data directory is required');
    if (this.running.size || this.starting.size || this.stopping.size) {
      throw new Error('Stop all browser environments before changing the data directory');
    }
    const check = validateDataRootIsolationSecure(raw);
    if (!check.ok) throw new Error(check.message);
    this.profileDataRootPath = check.root;
    return this.profileDataRootPath;
  }

  profileRoot(id) { return path.join(this.profileDataRootPath, assertProfileId(id)); }

  browserSelection() {
    const list = this.candidates();
    const independent = list.find((item) => item.independent);
    if (this.allowSystemBrowserFallback && this.systemBrowserPath) {
      const manual = list.find((item) => !item.independent && item.path === this.systemBrowserPath);
      if (manual) return { mode: 'system-manual', browser: manual };
    }
    if (this.preferIndependentKernel) {
      if (independent) return { mode: 'independent', browser: independent };
      return { mode: 'blocked', browser: null, message: '未找到内置独立浏览器内核。请确认安装包包含 kernels/，或在「本地设置」选择自定义内核。' };
    }
    const browser = independent || list[0];
    if (!browser) return { mode: 'blocked', browser: null, message: '未找到可用浏览器内核' };
    if (!browser.independent && (!this.allowSystemBrowserFallback || browser.path !== this.systemBrowserPath)) {
      return { mode: 'blocked', browser: null, message: '未找到内置独立浏览器内核。请确认安装包包含 kernels/，或在「本地设置」选择自定义内核。' };
    }
    return { mode: browser.independent ? 'independent' : 'system-manual', browser };
  }

  chooseBrowser() {
    const selection = this.browserSelection();
    if (selection.browser) {
      if (isSystemBrowserExecutable(selection.browser.path) && !this.allowSystemBrowserFallback) {
        throw new Error('已阻止使用本机浏览器。请安装或选择独立 Chromium 内核。');
      }
      if (selection.mode === 'system-manual') {
        this.emit({ type: 'kernel-fallback', message: '用户已手动选择本机浏览器回退。', browser: selection.browser.path });
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
    if (this.running.has(id) || this.starting.has(id) || this.stopping.has(id)) throw new Error('请先关闭窗口再清除缓存及 Cookie');
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

  /**
   * Pre-spawn profile file prep, parallelized. resetZoom + applyProfilePreferences both
   * read-modify-write Default/Preferences, so they MUST stay serialized relative to each
   * other (else the later write clobbers the earlier one — lost update). Everything else
   * only rm's disjoint paths (Sessions / cache dirs / retained data files) and can overlap,
   * shortening the launch critical path (scales with disk latency and profile size).
   */
  async prepareProfileFilesForStart(root, profile, restoreSession) {
    const jobs = [
      // Shared-file chain: resetZoom then applyProfilePreferences, ordered.
      (async () => { await this.resetZoom(root); await this.applyProfilePreferences(root, profile); })(),
      this.enforceDataRetention(root, profile),
    ];
    if (!restoreSession) jobs.push(this.resetTabs(root));
    if (profile.advanced.clearCacheOnStart) jobs.push(this.clearProfileCache(root));
    await Promise.all(jobs);
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
    const phase = String(options.phase || 'applyRuntimeSettings');
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

    const force = options.force === true;
    // Steady state: the watch loop calls this every ~2.4s per running profile. When every
    // live tab already carries the inject there is nothing to do, and logging begin/skip/end
    // each time would burn disk and append tab URLs to the diagnostic log forever.
    // Prune closed targets, keep the tracked state fresh, and return quietly.
    if (!force && tabs.every((tab) => applied.has(tab.id))) {
      const liveIds = new Set(tabs.map((tab) => tab.id));
      for (const id of [...applied]) {
        if (!liveIds.has(id)) applied.delete(id);
      }
      if (options.trackOn) {
        options.trackOn.fpAppliedTargets = applied;
        options.trackOn.fingerprint = fp;
      }
      return fp;
    }

    await fpLog('inject.begin', {
      phase,
      profileId: profile.id,
      port,
      tabCount: tabs.length,
      tabUrls: tabs.map((t) => ({ id: t.id, url: String(t.url || '').slice(0, 200) })),
      intended: summarizeFp(fp),
      logFile: fingerprintLogPath(),
    });

    for (const tab of tabs) {
      if (!force && applied.has(tab.id)) {
        await fpLog('inject.skip-tab', { phase, profileId: profile.id, tabId: tab.id, url: tab.url, reason: 'already-applied' });
        continue;
      }
      try {
        await applyFingerprintToTab(cdp.call, tab.webSocketDebuggerUrl, fp, enriched);
        let live = null;
        try {
          const probe = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
            expression: LIVE_PROBE_EXPRESSION,
            returnByValue: true,
          }, 8000);
          live = probe?.result?.value || probe?.value || null;
        } catch (probeError) {
          live = { probeError: String(probeError.message || probeError) };
        }
        const mismatch = live && !live.probeError ? {
          ua: Boolean(fp.userAgent && live.userAgent && fp.userAgent !== live.userAgent),
          platform: Boolean(fp.platform && live.platform && fp.platform !== live.platform),
          cores: fp.hardwareConcurrency != null && live.hardwareConcurrency != null
            && Number(fp.hardwareConcurrency) !== Number(live.hardwareConcurrency),
          memory: fp.deviceMemory != null && live.deviceMemory != null
            && Number(fp.deviceMemory) !== Number(live.deviceMemory),
          webglRenderer: Boolean(fp.webgl?.renderer && live.webglRenderer
            && String(live.webglRenderer) !== String(fp.webgl.renderer)
            && !String(live.webglRenderer).includes(String(fp.webgl.renderer).slice(0, 24))),
        } : null;
        await fpLog('inject.tab-ok', {
          phase,
          profileId: profile.id,
          tabId: tab.id,
          url: String(tab.url || '').slice(0, 240),
          intended: summarizeFp(fp),
          live,
          mismatch,
        });
        // If probe still shows host hardware, re-evaluate inject once more immediately.
        if (mismatch && (mismatch.cores || mismatch.webglRenderer || mismatch.memory)) {
          await fpLog('inject.tab-ineffective', {
            phase,
            profileId: profile.id,
            tabId: tab.id,
            mismatch,
          });
          try {
            await applyFingerprintToTab(cdp.call, tab.webSocketDebuggerUrl, fp, enriched);
            const probe2 = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
              expression: LIVE_PROBE_EXPRESSION,
              returnByValue: true,
            }, 8000);
            const live2 = probe2?.result?.value || probe2?.value || null;
            await fpLog('inject.tab-retry', {
              phase,
              profileId: profile.id,
              tabId: tab.id,
              live: live2,
            });
            const coresOk = !(fp.hardwareConcurrency != null && live2?.hardwareConcurrency != null
              && Number(fp.hardwareConcurrency) !== Number(live2.hardwareConcurrency));
            const webglOk = !(fp.webgl?.renderer && live2?.webglRenderer
              && String(live2.webglRenderer) !== String(fp.webgl.renderer)
              && /Radeon|GeForce|W6800|GTX |RTX /i.test(String(live2.webglRenderer)));
            if (coresOk && webglOk) applied.add(tab.id);
            // else leave unmarked so force/post-startpage can try again
          } catch (retryError) {
            await fpLog('inject.tab-retry-fail', {
              phase,
              profileId: profile.id,
              tabId: tab.id,
              error: String(retryError.message || retryError),
            });
          }
        } else {
          applied.add(tab.id);
        }
      } catch (error) {
        await fpLog('inject.tab-fail', {
          phase,
          profileId: profile.id,
          tabId: tab.id,
          url: String(tab.url || '').slice(0, 240),
          error: String(error.message || error),
        });
        // Soft-fail per tab: keep trying other tabs / later phases instead of aborting start.
        const msg = String(error.message || error || '');
        if (!/Uncaught|already in effect|cannot be overridden|softInject/i.test(msg)) {
          throw error;
        }
      }
      if (blocked.length) {
        await cdp.call(tab.webSocketDebuggerUrl, 'Network.enable');
        await cdp.call(tab.webSocketDebuggerUrl, 'Network.setBlockedURLs', { urls: blocked });
      }
      if (portScanScript) {
        await cdp.call(tab.webSocketDebuggerUrl, 'Page.addScriptToEvaluateOnNewDocument', { source: portScanScript });
        await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: portScanScript });
      }
      // applied.add only when probe matched (see above)
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
    await fpLog('inject.end', { phase, profileId: profile.id, applied: applied.size, port });
    return fp;
  }

  async applyFingerprintToSession(connection, sessionId, item, fingerprint, targetInfo = {}) {
    const profile = item?.profile || {};
    const network = this.networkInfo.get(profile.id) || {};
    const enriched = {
      ...profile,
      exitTimezone: profile.exitTimezone || network.timezone || '',
      exitLatitude: profile.exitLatitude ?? network.latitude,
      exitLongitude: profile.exitLongitude ?? network.longitude,
    };
    const baseFp = fingerprint || item.fingerprint || buildFingerprint(enriched);
    const injectFp = item.nativeKernelFingerprint
      ? fingerprintForNativeKernelInject(baseFp)
      : baseFp;
    // session-scoped CDP calls for targets attached with flatten:true
    const sessionCall = async (method, params = {}, timeout = 8000) => connection.command(method, params, { sessionId, timeout });
    await applyFingerprintToTab(sessionCall, null, injectFp, enriched);
    if (!item.fpAppliedTargets) item.fpAppliedTargets = new Set();
    if (targetInfo?.targetId) item.fpAppliedTargets.add(targetInfo.targetId);
    item.fingerprint = baseFp;
    return injectFp;
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
            // Nested attach so workers/iframes under this page also pause for inject.
            await connection.command('Target.setAutoAttach', {
              autoAttach: true,
              waitForDebuggerOnStart: true,
              flatten: true,
            }, { sessionId });
            // Critical: inject fingerprint BEFORE resuming the page/iframe target.
            // Polling in startRunningWatch is only a fallback, not the primary path.
            await this.applyFingerprintToSession(connection, sessionId, item, fingerprint, targetInfo);
          } else if (workerTypes.has(targetInfo.type) && !internalUrl.test(String(targetInfo.url || ''))) {
            await connection.command('Runtime.evaluate', { expression: source }, { sessionId, timeout: 10000 });
          }
        } catch (error) {
          report(error, targetInfo);
          this.emit({
            type: 'fingerprint-injection-failed',
            id: item.profile?.id,
            targetType: targetInfo.type || '',
            message: error.message,
          });
        } finally {
          if (waitingForDebugger) {
            await connection.command('Runtime.runIfWaitingForDebugger', {}, { sessionId })
              .catch((error) => report(error, targetInfo));
          }
        }
      })();
    };
    const connection = await cdp.connect(browserWs, {
      onEvent: onAttached,
      onDisconnect: (error) => {
        if (item.cleanedUp || item.stopping) return;
        this.handleBrowserGone(item.profile.id, item, 'worker-cdp-disconnect', {
          expected: false,
          error: error?.message || String(error),
          kill: true,
          waitForExit: true,
        }).catch((cleanupError) => this.emit({
          type: 'sync-error',
          action: 'worker-cdp-disconnect-cleanup',
          id: item.profile.id,
          message: cleanupError.message,
        }));
      },
      timeout: 8000,
    });
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
        profile.exitLatencyMs = network.latencyMs ?? profile.exitLatencyMs;
        profile.exitNetworkType = network.networkType || profile.exitNetworkType;
        this.profiles.set(profile.id, this.sanitizeProfile(profile));
        await this.persist();
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
    const expected = String(startUrl || '').trim();
    let keep = values.find((tab) => this.isStartPageUrl(tab.url)) || values[0];
    const preferredId = keep?.id;
    // Always force-navigate to OpenBrowser start page when provided (148 kernel may open NTP/about:blank).
    if (expected && keep?.webSocketDebuggerUrl) {
      try {
        await cdp.call(keep.webSocketDebuggerUrl, 'Page.enable', {}).catch(() => {});
        const href = String(keep.url || '');
        // about:blank launch or wrong page → navigate; already on start page → reload so
        // document-start fingerprint scripts registered after first paint still run.
        if (this.isStartPageUrl(href) && href.includes(expected.split('?')[0])) {
          await cdp.call(keep.webSocketDebuggerUrl, 'Page.reload', { ignoreCache: true }).catch(async () => {
            await cdp.call(keep.webSocketDebuggerUrl, 'Page.navigate', { url: expected });
          });
        } else {
          await cdp.call(keep.webSocketDebuggerUrl, 'Page.navigate', { url: expected });
        }
        await new Promise((resolve) => { const t = setTimeout(resolve, 400); t.unref?.(); });
      } catch (_) {
        try { await cdp.call(keep.webSocketDebuggerUrl, 'Page.navigate', { url: expected }); } catch (__) {}
      }
    }
    const after = await cdp.tabs(port).catch(() => values);
    // Prefer: current start-page URL → same target we navigated → first tab.
    keep = after.find((tab) => this.isStartPageUrl(tab.url))
      || after.find((tab) => preferredId && tab.id === preferredId)
      || after[0]
      || keep;
    for (const tab of after) if (tab.id !== keep.id) await cdp.closeTab(port, tab.id).catch(() => {});
    await cdp.activateTab(port, keep.id).catch(() => {});
  }

  /**
   * After start-page navigation: inject fingerprint, probe live surfaces, reload once
   * if still looks like the host machine. Writes diagnostics to fingerprint-inject.log.
   */
  async ensureStartPageFingerprint(item, profile, injectFp, startUrl) {
    const port = item?.port;
    if (!port) return null;
    const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
    // Give navigation a moment to produce a target URL.
    for (let i = 0; i < 10; i += 1) {
      const tabs = await cdp.tabs(port).catch(() => []);
      if (tabs.some((t) => this.isStartPageUrl(t.url) || /about:blank/i.test(String(t.url || '')))) break;
      await sleep(100);
    }
    await this.applyRuntimeSettings(port, profile, injectFp, {
      appliedTargetIds: new Set(),
      trackOn: item,
      phase: 'post-startpage',
      force: true,
    });
    // Short settle before the first repaint request; the retry below covers a slower boot.
    await sleep(120);
    // Ask welcome page to repaint fingerprint table from spoofed navigator.
    // Retry a few times: start-page script may still be booting. Stop as soon as the page
    // confirms it ran the collector — it re-samples itself on a timer after that, so extra
    // rounds only added fixed delay to the launch (this loop always ran its full 3 rounds
    // and slept after the last one because the result was discarded).
    for (let repaint = 0; repaint < 3; repaint += 1) {
      let collected = false;
      try {
        const tabsR = await cdp.tabs(port).catch(() => []);
        for (const tab of tabsR) {
          if (!tab.webSocketDebuggerUrl) continue;
          if (!this.isStartPageUrl(tab.url) && !/about:blank/i.test(String(tab.url || ''))) continue;
          const outcome = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
            expression: `(() => { try { if (typeof window.__openbrowserCollectFingerprint === 'function') { window.__openbrowserCollectFingerprint('post-inject-${repaint}'); return 'ok'; } return 'missing'; } catch (e) { return String(e && e.message || e); } })()`,
            returnByValue: true,
          }, 3000).catch(() => null);
          if ((outcome?.result?.value ?? outcome?.value) === 'ok') collected = true;
        }
      } catch (_) {}
      if (collected) break;
      await sleep(200);
    }
    const tabs = await cdp.tabs(port).catch(() => []);
    const page = tabs.find((t) => this.isStartPageUrl(t.url)) || tabs[0];
    if (!page?.webSocketDebuggerUrl) {
      await fpLog('probe.no-tab', { profileId: profile.id, port, tabCount: tabs.length });
      return null;
    }
    let live = null;
    try {
      const probe = await cdp.call(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: LIVE_PROBE_EXPRESSION,
        returnByValue: true,
      }, 8000);
      live = probe?.result?.value || probe?.value || null;
    } catch (error) {
      live = { probeError: String(error.message || error) };
    }
    const intended = summarizeFp(injectFp);
    const hostLikeWebgl = Boolean(live?.webglRenderer && /Radeon|GeForce|Intel\(R\)|W6800|RX |GTX |RTX /i.test(String(live.webglRenderer)))
      && intended?.webglRenderer
      && String(live.webglRenderer) !== String(intended.webglRenderer);
    const hostLikeCores = intended?.hardwareConcurrency != null
      && live?.hardwareConcurrency != null
      && Number(live.hardwareConcurrency) !== Number(intended.hardwareConcurrency)
      && Number(live.hardwareConcurrency) >= 12;
    const bad = hostLikeWebgl || hostLikeCores
      || (intended?.userAgent && live?.userAgent && intended.userAgent !== live.userAgent);
    await fpLog('probe.startpage', {
      profileId: profile.id,
      port,
      url: page.url,
      intended,
      live,
      hostLikeWebgl,
      hostLikeCores,
      bad,
    });
    if (!bad) return live;

    // Hard recovery: re-register document-start script and reload start page.
    await fpLog('probe.reload-startpage', { profileId: profile.id, reason: { hostLikeWebgl, hostLikeCores } });
    try {
      await applyFingerprintToTab(cdp.call, page.webSocketDebuggerUrl, injectFp, profile);
      await cdp.call(page.webSocketDebuggerUrl, 'Page.enable', {}).catch(() => {});
      if (startUrl) await cdp.call(page.webSocketDebuggerUrl, 'Page.navigate', { url: startUrl });
      else await cdp.call(page.webSocketDebuggerUrl, 'Page.reload', { ignoreCache: true });
      await sleep(600);
      await this.applyRuntimeSettings(port, profile, injectFp, {
        appliedTargetIds: new Set(),
        trackOn: item,
        phase: 'post-reload',
        force: true,
      });
      const tabs2 = await cdp.tabs(port).catch(() => []);
      const page2 = tabs2.find((t) => this.isStartPageUrl(t.url)) || tabs2[0];
      if (page2?.webSocketDebuggerUrl) {
        const probe2 = await cdp.call(page2.webSocketDebuggerUrl, 'Runtime.evaluate', {
          expression: LIVE_PROBE_EXPRESSION,
          returnByValue: true,
        }, 8000).catch((e) => ({ result: { value: { probeError: String(e.message || e) } } }));
        const live2 = probe2?.result?.value || probe2?.value || null;
        await fpLog('probe.after-reload', { profileId: profile.id, live: live2, intended });
        return live2;
      }
    } catch (error) {
      await fpLog('probe.reload-fail', { profileId: profile.id, error: String(error.message || error) });
    }
    return live;
  }

  /**
   * OpenBrowser 原生启动页 URL：http://127.0.0.1:50326/?pid=...&id=...&name=...
   * 会话与网络信息由本引擎写入启动页服务，不依赖其它指纹浏览器。
   */
  async buildStartPageUrl(profile, root, browserName, extensionCount) {
    let pageNetwork = this.networkInfo.get(profile.id) || null;
    // 启动前尽量补全出口信息，启动页打开即可显示 IP（直连/代理同理）
    const hasProxy = profile.proxy && !/^(direct|offline|none)$/i.test(String(profile.proxy));
    if (!pageNetwork?.ip) {
      try {
        if (hasProxy) {
          pageNetwork = await this.checkProxy(profile);
        } else {
          pageNetwork = await lookupDirectCountry();
          if (pageNetwork) {
            pageNetwork = { ...pageNetwork, protocol: 'direct' };
            this.networkInfo.set(profile.id, pageNetwork);
          }
        }
      } catch (_) {
        pageNetwork = this.networkInfo.get(profile.id) || null;
      }
    }
    const timezone = profile.exitTimezone
      || pageNetwork?.timezone
      || (profile.privacy?.timezoneMode === 'custom' ? profile.privacy.timezone : '')
      || '';
    const fpForStart = (() => {
      try {
        return buildFingerprint({
          ...profile,
          kernelVersion: this.kernelStatus()?.kernel?.version || profile.kernelVersion,
          exitTimezone: timezone,
          exitLatitude: pageNetwork?.latitude ?? profile.exitLatitude,
          exitLongitude: pageNetwork?.longitude ?? profile.exitLongitude,
        });
      } catch (_) {
        return null;
      }
    })();
    const uaFromFp = fpForStart?.userAgent || profile.userAgent || '';
    try {
      const server = await this.ensureStartPage();
      const url = server.registerSession({
        ...profile,
        exitTimezone: timezone,
        exitIp: pageNetwork?.ip || profile.exitIp || '',
        exitCountryCode: pageNetwork?.countryCode || profile.exitCountryCode || '',
        userAgent: profile.userAgent || uaFromFp,
        group_name: profile.group_name || profile.groupName || '',
        privacy: {
          ...(profile.privacy || {}),
          // Prefer resolved fingerprint surfaces for welcome-page expected checks
          fingerprint: {
            ...(profile.privacy?.fingerprint || {}),
            hardwareConcurrency: fpForStart?.hardwareConcurrency ?? profile.privacy?.fingerprint?.hardwareConcurrency,
            deviceMemory: fpForStart?.deviceMemory ?? profile.privacy?.fingerprint?.deviceMemory,
          },
        },
      }, {
        timezone,
        network: pageNetwork,
        userAgent: profile.userAgent || uaFromFp,
        group_name: profile.group_name || profile.groupName || '',
        browserName,
        extensionCount,
        time: Math.floor(Date.now() / 1000),
        expectedFingerprint: fpForStart ? {
          language: (fpForStart.languages && fpForStart.languages[0]) || profile.language || '',
          userAgent: fpForStart.userAgent || uaFromFp,
          platform: fpForStart.platform || '',
          timezone,
          screenWidth: fpForStart.screen?.width || Number(profile.width) || null,
          screenHeight: fpForStart.screen?.height || Number(profile.height) || null,
          webrtc: String(profile.privacy?.webrtc || ''),
          canvas: String(fpForStart.canvas?.mode || profile.privacy?.canvas || ''),
          webgl: String(fpForStart.webgl?.mode || profile.privacy?.webgl || ''),
          webglVendor: fpForStart.webgl?.vendor || '',
          webglRenderer: fpForStart.webgl?.renderer || '',
          audio: String(fpForStart.audio?.mode || profile.privacy?.audio || ''),
          hardwareConcurrency: fpForStart.hardwareConcurrency,
          deviceMemory: fpForStart.deviceMemory,
        } : undefined,
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
        } catch (error) {
          // Windows: EPERM/EACCES means the PID still exists but is not signalable — keep watching.
          processAlive = Boolean(error && (error.code === 'EPERM' || error.code === 'EACCES'));
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

      // Stop may have started while the CDP probes were in flight. Never let a
      // stale watcher callback act on, or reschedule itself for, a torn-down item.
      if (item.cleanedUp || item.stopping || this.running.get(profileId) !== item) return;

      if (!processAlive || !cdpAlive) {
        item.watchDeadTicks = (item.watchDeadTicks || 0) + 1;
        item.watchEmptyTicks = 0;
        // pid gone: stop immediately; CDP flaky: need 2 consecutive fails
        if (!processAlive || item.watchDeadTicks >= 2) {
          this.handleBrowserGone(profileId, item, processAlive ? 'cdp-dead' : 'process-exit', {
            kill: true,
            waitForExit: true,
          }).catch((error) => this.emit({ type: 'sync-error', action: 'watch-cleanup', id: profileId, message: error.message }));
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
              this.handleBrowserGone(profileId, item, 'empty-windows', {
                kill: true,
                waitForExit: true,
              }).catch((error) => this.emit({ type: 'sync-error', action: 'auto-stop-empty-cleanup', id: profileId, message: error.message }));
            });
            return;
          }
        } else {
          item.watchEmptyTicks = 0;
          // New tabs must receive the same fingerprint inject as the launch tab.
          // Soft-fail: never throw out of the watch loop (would spam Uncaught).
          if (item.fingerprint && item.profile && !item.fpEnsureBusy) {
            item.fpEnsureBusy = true;
            const reFp = item.nativeKernelFingerprint
              ? fingerprintForNativeKernelInject(item.fingerprint)
              : item.fingerprint;
            this.applyRuntimeSettings(item.port, item.profile, reFp, {
              appliedTargetIds: item.fpAppliedTargets || new Set(),
              trackOn: item,
              phase: 'watch-ensure',
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
      // 2.4s is enough for new-tab FP inject without burning CDP every 1.2s across fleets.
      if (!item.cleanedUp && !item.stopping && this.running.get(profileId) === item) {
        item.watchTimer = setTimeout(tick, 2400);
      }
    };
    // Delay first check so startup tabs can settle
    item.watchTimer = setTimeout(tick, 2500);
  }

  waitForChildExit(child, timeout = 3000) {
    if (!child || child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener?.('exit', onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeout);
      child.once?.('exit', onExit);
    });
  }

  cleanupRunningItem(profileId, item, options = {}) {
    if (!item) return Promise.resolve({ id: profileId, running: false });
    if (item.cleanupPromise) return item.cleanupPromise;

    const expected = options.expected !== undefined ? Boolean(options.expected) : Boolean(item.stopping);
    const reason = String(options.reason || 'browser-gone');
    const cleanup = async () => {
      // Mark first so the watcher and any late startup continuation stop touching
      // a browser whose ownership is already being torn down. Keep `running` until
      // all external resources have been released; start() waits on `stopping`.
      item.cleanedUp = true;
      this.clearRunningWatch(item);
      item.workerFingerprintConnection?.close();
      item.workerFingerprintConnection = null;

      if (options.kill && item.child?.exitCode === null && item.pid) {
        await killProcessTree(item.pid, managedBrowserKillOptions(item, item.root)).catch(() => {});
      }
      if (options.waitForExit) {
        let exited = await this.waitForChildExit(item.child, Number(options.exitTimeout) || 6500);
        // A failed first kill must not release the profile lock while Chromium
        // still owns the profile. Retry the bounded kill/wait sequence once.
        if (!exited && item.child?.exitCode === null && item.pid) {
          await killProcessTree(item.pid, managedBrowserKillOptions(item, item.root)).catch(() => {});
          exited = await this.waitForChildExit(item.child, 2500);
        }
        item.childExitState = { ...(item.childExitState || {}), exited, code: item.child?.exitCode ?? null, signal: item.child?.signalCode || null };
        if (!exited) {
          // Fail closed: a live child may still own SQLite/LevelDB/profile locks.
          // Release auxiliary handles, but never release the profile lock or delete
          // the running item until a later cleanup attempt confirms child exit.
          try { item.cdpConnection?.close?.(); } catch (_) {}
          if (item.markerProcess && !item.markerProcess.killed) {
            try { item.markerProcess.kill(); } catch (_) {}
          }
          await item.proxyForwarder?.close().catch(() => {});
          stopIpcStubForWindow(item.kernelWindowName);
          item.cleanupFailed = true;
          const failure = new Error(`Browser child exit was not confirmed for profile ${profileId}; cleanup is fail-closed`);
          failure.code = 'BROWSER_EXIT_UNCONFIRMED';
          item.cleanupError = failure;
          throw failure;
        }
      }

      // The tracked browser process can exit before Chromium's renderer/GPU
      // helpers. Re-scan the exact user-data-dir and terminate only those
      // helpers before releasing the profile lock.
      if (options.kill && item.child?.exitCode !== null && item.child?.exitCode !== undefined && item.root) {
        let helpersGone = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const scan = terminateProcessesUsingProfile(item.root);
          if (!scan.known) break;
          if (!scan.pids.length) { helpersGone = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        if (!helpersGone) {
          const failure = new Error(`Chromium helper exit was not confirmed for profile ${profileId}; cleanup is fail-closed`);
          failure.code = 'BROWSER_HELPERS_EXIT_UNCONFIRMED';
          item.cleanupFailed = true;
          item.cleanupError = failure;
          throw failure;
        }
      }

      try { item.cdpConnection?.close?.(); } catch (_) {}
      if (item.markerProcess && !item.markerProcess.killed) {
        try { item.markerProcess.kill(); } catch (_) {}
      }
      await item.proxyForwarder?.close().catch(() => {});
      stopIpcStubForWindow(item.kernelWindowName);
      await releaseProfileLock(item.root, item.profileLock).catch(() => {});
      // Existing behavior intentionally marks the profile clean after watchdog
      // cleanup as well, preventing Chromium's restore bubble on the next launch.
      if (options.markCleanExit !== false) await this.markProfileCleanExit(item.root).catch(() => {});

      if (this.running.get(profileId) === item) this.running.delete(profileId);
      item.cleanupFailed = false;
      item.cleanupError = null;
      const live = this.profiles.get(profileId) || item.profile;
      const error = options.error === undefined ? null : (options.error || null);
      if (options.emitStatus !== false && !item.statusEmitted) {
        item.statusEmitted = true;
        this.emit({ type: 'status', id: profileId, running: false, stopping: false, error, reason });
      }
      if (options.emitProfileClosed && live?.advanced?.cloudBackup && !item.stopping && !item.profileClosedEmitted) {
        item.profileClosedEmitted = true;
        this.emit({
          type: 'profile-closed',
          id: profileId,
          cloudBackup: true,
          cookieExported: false,
          profile: live,
          reason,
        });
      }
      return { id: profileId, running: false, reason };
    };

    const cleanupPromise = cleanup();
    item.cleanupPromise = cleanupPromise;
    cleanupPromise.catch((error) => {
      // Keep the running item and lock visible, but allow an explicit retry after
      // the child eventually exits instead of memoizing a rejected promise forever.
      item.cleanupFailed = true;
      item.cleanupError = error;
      if (item.cleanupPromise === cleanupPromise) item.cleanupPromise = null;
    }).catch(() => {});
    return cleanupPromise;
  }

  /**
   * Clean resources acquired before a running item is published. Startup can
   * fail after Chromium has spawned but before the item has enough state for
   * cleanupRunningItem(); keep this path idempotent and use the same bounded
   * close/kill/wait ordering on every failure branch.
   */
  cleanupStartupResources(resources = {}) {
    if (resources.cleanupPromise) return resources.cleanupPromise;
    const cleanup = async () => {
      const child = resources.child;
      const connection = resources.connection;
      let exited = Boolean(child && child.exitCode !== null && child.exitCode !== undefined);

      if (connection && !exited) {
        try {
          await Promise.race([
            (async () => {
              try {
                await connection.command?.('Browser.close', {}, { timeout: 5000 });
              } catch (_) {}
            })(),
            new Promise((resolve) => {
              const timer = setTimeout(resolve, 1800);
              timer.unref?.();
            }),
          ]);
        } catch (_) {}
      }

      if (child) {
        exited = exited || await this.waitForChildExit(child, 2500);
        if (!exited && child.exitCode === null && child.pid) {
          await killProcessTree(child.pid, managedBrowserKillOptions(
            resources.browser,
            resources.root,
            resources.launchBinary,
          )).catch(() => {});
          exited = await this.waitForChildExit(child, 2500);
        }
      }

      try { connection?.close?.(); } catch (_) {}
      if (resources.markerProcess && !resources.markerProcess.killed) {
        try { resources.markerProcess.kill(); } catch (_) {}
      }
      await resources.proxyForwarder?.close().catch(() => {});
      stopIpcStubForWindow(resources.kernelWindowName);
      if (child && !exited) {
        // Startup owns the same profile lock safety rule as running cleanup: a
        // process that may still be alive must keep the lock as a tombstone.
        return { exited: false, lockReleased: false, cleanupBlocked: true };
      }
      if (resources.profileLock && resources.root) {
        await releaseProfileLock(resources.root, resources.profileLock).catch(() => {});
      }
      return { exited, lockReleased: true };
    };
    resources.cleanupPromise = cleanup();
    return resources.cleanupPromise;
  }

  handleBrowserGone(profileId, item, reason = 'browser-gone', options = {}) {
    if (!item) return Promise.resolve({ id: profileId, running: false });
    const pending = this.stopping.get(profileId);
    if (pending) return pending;
    if (item.cleanupPromise) return item.cleanupPromise;

    const cleanupPromise = this.cleanupRunningItem(profileId, item, {
      reason,
      expected: options.expected !== undefined ? options.expected : item.stopping === true,
      error: options.error,
      kill: options.kill !== false,
      waitForExit: options.waitForExit !== false,
      exitTimeout: options.exitTimeout,
      markCleanExit: options.markCleanExit,
      emitProfileClosed: options.emitProfileClosed !== false,
    });
    this.stopping.set(profileId, cleanupPromise);
    cleanupPromise.finally(() => {
      if (this.stopping.get(profileId) === cleanupPromise) this.stopping.delete(profileId);
    }).catch(() => {});
    return cleanupPromise;
  }

  async waitForPort(root, timeout = 30000, child = null) {
    const file = path.join(root, 'DevToolsActivePort');
    const started = Date.now();
    // Do not delete DevToolsActivePort here — cleared before spawn; post-spawn delete races Chromium.
    const assertChildAlive = () => {
      if (child?._startupDiagnostic?.spawnError) {
        throw new Error(`Browser process could not start: ${child._startupDiagnostic.spawnError}`);
      }
      if (child && child.exitCode !== null && child.exitCode !== undefined) {
        throw new Error(formatBrowserStartupError(
          `Browser exited before CDP was ready (code ${child.exitCode}${child.signalCode ? ', signal ' + child.signalCode : ''})`,
          child,
          child._startupDiagnostic,
        ));
      }
    };
    const tryReadPort = async () => {
      try {
        const content = await fsp.readFile(file, 'utf8');
        const port = Number(content.split(/\r?\n/)[0]);
        if (Number.isInteger(port) && port > 0) {
          try {
            await cdp.json(`http://127.0.0.1:${port}/json/version`);
            return port;
          } catch (_) {
            // File is written slightly before the DevTools endpoint answers. Measured on a
            // real launch that gap is ~600ms of Chromium coming up, not idle polling — a
            // tighter retry loop here was tried and bought nothing, so keep it simple.
          }
        }
      } catch (_) {}
      return 0;
    };
    // Event-driven fast path: watch the profile dir so we react ~1 tick after Chromium
    // writes DevToolsActivePort, instead of waiting out a fixed 200ms poll. Polling stays
    // as the fallback — fs.watch is unreliable on some network/virtual filesystems and
    // platforms, so a watcher failure just degrades to the (slightly tighter) poll.
    let watcher = null;
    let wake = null;
    try { watcher = fs.watch(root, () => { const w = wake; if (w) w(); }); } catch (_) { watcher = null; }
    try {
      assertChildAlive();
      let port = await tryReadPort();
      if (port) return port;
      while (Date.now() - started < timeout) {
        assertChildAlive();
        await new Promise((resolve) => {
          let done = false;
          const finish = () => { if (done) return; done = true; wake = null; clearTimeout(timer); resolve(); };
          wake = finish;
          // Backstop timeout: short when watching (event does the real work), tighter than
          // the old 200ms when we have no watcher to lean on.
          const timer = setTimeout(finish, watcher ? 250 : 120);
          if (timer.unref) timer.unref();
        });
        port = await tryReadPort();
        if (port) return port;
      }
    } finally {
      wake = null;
      try { watcher?.close(); } catch (_) {}
    }
    let hint = '';
    try {
      if (child && child.exitCode !== null) hint = ` childExit=${child.exitCode}`;
      else if (child && child.pid) hint = ` childPid=${child.pid} still running`;
    } catch (_) {}
    throw new Error(formatBrowserStartupError(
      'Browser started but CDP port was not ready' + hint,
      child,
      child?._startupDiagnostic,
    ));
  }

  emitStartProgress(profileId, phase, percent, message = '') {
    this.emit({
      type: 'profile-start-progress',
      id: profileId,
      phase,
      percent: Math.max(0, Math.min(100, Math.round(Number(percent) || 0))),
      message: message || '',
      starting: true,
      running: false,
    });
  }

  restoreStoredProxyCredentials(incoming) {
    const previous = this.profiles.get(incoming.id);
    if (!previous) return incoming;
    const nextProxy = String(incoming.proxy || '');
    const prevProxy = String(previous.proxy || '');
    const nextHasAuth = proxyHasCredentials(nextProxy);
    const prevHasAuth = proxyHasCredentials(prevProxy);
    if (!prevHasAuth || nextHasAuth) return incoming;
    if (sameProxyEndpoint(prevProxy, nextProxy)) {
      return this.sanitizeProfile({ ...incoming, networkMode: 'proxy', proxy: prevProxy });
    }
    return incoming;
  }

  async start(raw) {
    const candidate = this.restoreStoredProxyCredentials(this.sanitizeProfile(raw));
    const id = candidate.id;
    const pendingStart = this.starting.get(id);
    if (pendingStart) return pendingStart;

    const pendingStop = this.stopping.get(id);
    if (pendingStop) await pendingStop.catch(() => {});

    // A stop may have completed while another caller was waiting. Re-check both
    // maps before creating a second browser for the same profile.
    const afterStop = this.running.get(id);
    if (afterStop && (afterStop.cleanupFailed || afterStop.cleanedUp || afterStop.stopping)) {
      const failure = afterStop.cleanupError || Object.assign(
        new Error(`Browser environment ${id} is still stopping; child exit has not been confirmed`),
        { code: 'BROWSER_EXIT_UNCONFIRMED' },
      );
      throw failure;
    }
    if (afterStop && !afterStop.cleanedUp && !afterStop.stopping) return this.publicRunning(id);
    const existingStart = this.starting.get(id);
    if (existingStart) return existingStart;

    const task = this._start(candidate);
    this.starting.set(id, task);
    try {
      return await task;
    } finally {
      if (this.starting.get(id) === task) this.starting.delete(id);
    }
  }

  async _start(raw) {
    // let: language/timezone resolution reassigns profile via applyResolvedLocale
    let profile = this.restoreStoredProxyCredentials(this.sanitizeProfile(raw)); this.profiles.set(profile.id, profile);
    if (this.running.has(profile.id)) {
      if (!profile.advanced.multiOpen) return this.publicRunning(profile.id);
      return this.publicRunning(profile.id);
    }
    // Surface cross-platform risks (Windows MAX_PATH on a deep data root, missing env,
    // Linux sandbox, …) once — turns silent per-platform breakage into an actionable event.
    if (!this._platformPreflightDone) {
      this._platformPreflightDone = true;
      try {
        const preflight = this.platformPreflightReport();
        if (preflight.warnings.length) this.emit({ type: 'platform-preflight', ok: preflight.ok, warnings: preflight.warnings });
      } catch (_) {}
    }
    this.emitStartProgress(profile.id, 'prepare', 6, '正在准备环境…');
    // Hoisted so the outer catch can release these if start throws after they are
    // acquired. The profile lock is keyed on the live Electron pid, so a leaked lock
    // does NOT self-heal while the app runs — it blocks this environment (with a
    // misleading "Profile already running") until a full app restart.
    let root = null;
    let profileLock = null;
    let proxyForwarder = null;
    let kernelWindowName = null;
    let liveItem = null;
    const startupResources = {
      root: null,
      profileLock: null,
      proxyForwarder: null,
      kernelWindowName: null,
      browser: null,
      launchBinary: null,
      child: null,
      connection: null,
    };
    try {
      profile = await this.prepareProfileProxyForStart(profile);
    this.profiles.set(profile.id, profile);
    this.emitStartProgress(profile.id, 'proxy', 18, '正在检测代理与出口…');
    await this.ensureExitNetworkForLocale(profile).catch(() => {});
    profile = this.applyResolvedLocale(profile);
    this.profiles.set(profile.id, profile);
    // Persist the effective proxy (including credentials returned by a dynamic
    // proxy API) before launching Chromium. A quit immediately after startup
    // must not leave the renderer's redacted copy as the durable state.
    await this.persist();
    const extensions = this.assignedExtensions(profile.id);
    this.emitStartProgress(profile.id, 'kernel', 30, '正在准备浏览器内核…');
    if (!this.kernelStatus().installed && this.preferIndependentKernel) {
      // Resolve integrated seed only — never download a remote kernel at start time.
      await this.ensureKernelBootstrap();
    }
    const browser = this.chooseBrowser(profile);
    root = this.profileRoot(profile.id);
    startupResources.root = root;
    const rootCheck = await validateProfileRootSecure(this.profileDataRootPath, root, profile.id, { create: true });
    if (!rootCheck.ok) throw new Error('Isolation error: ' + rootCheck.message);
    profileLock = await acquireProfileLock(root, { profileId: profile.id, browser: browser.path });
    startupResources.profileLock = profileLock;
    const restoreSession = profile.advanced.tabMode === 'restore' || profile.advanced.restoreSession;
    // Parallelized (independent IO overlaps; Preferences writers stay serialized). See method.
    await this.prepareProfileFilesForStart(root, profile, restoreSession);
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
    const proxyConfig = this.proxyConfig(profile.proxy);
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
      startupResources.proxyForwarder = proxyForwarder;
    }
    this.emitStartProgress(profile.id, 'configure', 48, '正在配置启动参数…');
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
    // openbrowser-148: write profile/init.json so Framework native FP matches buildFingerprint
    let runtimeFingerprint = fingerprint;
    kernelWindowName = null;
    if (isOpenBrowser148(browser)) {
      try {
        const written = await writeOpenBrowserKernelInit(root, {
          fingerprint,
          profile,
          browserPath: browser.path,
          resourceRoots: [
            path.join(__dirname, 'kernels'),
            __dirname,
            path.join(this.app.getPath('userData'), 'kernels'),
          ],
        });
        kernelWindowName = written.windowName;
        startupResources.kernelWindowName = kernelWindowName;
        runtimeFingerprint = fingerprintForNativeKernelInject(fingerprint);
        this.emit({
          type: 'kernel-init-synced',
          id: profile.id,
          windowName: written.windowName,
          path: written.path,
        });
      } catch (error) {
        this.emit({
          type: 'sync-error',
          action: 'kernel-init-sync',
          id: profile.id,
          message: '内核 init 指纹同步失败：' + error.message,
        });
      }
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
      // HTTP/SOCKS proxies are IPv4; disable IPv6 so Chrome cannot skip the proxy.
      if (!args.includes('--disable-ipv6')) args.push('--disable-ipv6');
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
    // Startup URLs: do NOT put the OpenBrowser start page (or first custom URL) on the
    // CLI. The process would paint and run collectFingerprint before CDP inject.
    // Spawn on about:blank, inject via CDP, then keepDefaultTab navigates to startUrl.
    if (!restoreSession) {
      if (startUrl) args.push('about:blank');
      else if (customStartUrls.length) args.push('about:blank');
      for (const extra of customStartUrls.slice(1)) args.push(extra);
    }
    // Cross-platform process overhead reducers (safe for multi-profile fleets).
    // Applied for all envs — not only proxied ones — so Win/mac idle CPU stays low.
    const perfFlags = [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-client-side-phishing-detection',
      '--disable-domain-reliability',
      '--disable-breakpad',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--metrics-recording-only',
      '--no-pings',
      '--dns-prefetch-disable',
    ];
    for (const flag of perfFlags) {
      if (!args.some((a) => a.split('=')[0] === flag.split('=')[0])) args.push(flag);
    }
    disabledFeatures.push(
      'OptimizationHints',
      'MediaRouter',
      'Translate',
      'AutofillServerCommunication',
      'NetworkPrediction',
      'InterestFeedContentSuggestions',
      'CalculateNativeWinOcclusion',
    );
    if (proxyConfig) {
      // Extra hardening when traffic already goes through a bridge.
      if (!args.includes('--disable-quic')) args.push('--disable-quic');
    }
    // Prefer process reuse when many profiles are open (lower RAM; still one renderer isolation base).
    if (!args.some((a) => a.startsWith('--renderer-process-limit='))) {
      args.push('--renderer-process-limit=4');
    }
    if (disabledFeatures.length) {
      const existing = args.findIndex((a) => a.startsWith('--disable-features='));
      if (existing >= 0) args[existing] = args[existing] + ',' + [...new Set(disabledFeatures)].join(',');
      else args.push(`--disable-features=${[...new Set(disabledFeatures)].join(',')}`);
    }
    // Per-env marker extension: software logo + environment number (1, 2, …)
    const envNumber = normalizeEnvNumber(profile.number || profile.name || profile.id || '1');
    let markerExtensionPath = null;
    try {
      markerExtensionPath = await prepareMarkerExtension({
        profileId: profile.id,
        envNumber,
        userDataPath: this.app.getPath('userData'),
        templateDir: path.join(__dirname, 'bundled-extension'),
      });
    } catch (error) {
      this.emit({ type: 'sync-error', action: 'env-marker-icon', id: profile.id, message: error.message });
    }

    // --load-extension for assigned unpacked apps + env marker (Win/macOS)
    const loadPaths = extensions.map((entry) => entry.path).filter((p) => p && fs.existsSync(p));
    if (markerExtensionPath && fs.existsSync(markerExtensionPath) && !loadPaths.includes(markerExtensionPath)) {
      loadPaths.push(markerExtensionPath);
    }
    const finalArgs = loadPaths.length ? mergeLoadExtensionArgs(args, loadPaths) : args;
    // Never put --accept-terms-and-conditions on the long-lived browser spawn.
    // Wayfern treats that flag as a one-shot accept-and-exit command; pre-accept via
    // ensureKernelReadyForLaunch() below, then launch without it so CDP can come up.
    for (let i = finalArgs.length - 1; i >= 0; i -= 1) {
      if (String(finalArgs[i]) === '--accept-terms-and-conditions') finalArgs.splice(i, 1);
    }

    // macOS + openbrowser-148 only: Dock wrapper so process shows logo-native+number.
    // Non-148 Chromium has no OpenBrowser.bin layout; do not force a shell (would fail hard).
    let launchBinary = browser.path;
    startupResources.browser = browser;
    startupResources.launchBinary = launchBinary;
    try {
      if (process.platform === 'darwin' && isOpenBrowser148(browser)) {
        const dockBin = await prepareMacDockWrapper({
          profileId: profile.id,
          envNumber,
          userDataPath: this.app.getPath('userData'),
          realBinary: browser.path,
        });
        if (dockBin && fs.existsSync(dockBin)) {
          launchBinary = dockBin;
          startupResources.launchBinary = launchBinary;
        }
      }
    } catch (error) {
      this.emit({ type: 'sync-error', action: 'env-dock-icon', id: profile.id, message: error.message });
    }

    let child;
    let childExitState;
    let connection;
    let port;
    try {
      this.emitStartProgress(profile.id, 'spawn', 62, '正在启动浏览器进程…');
      await ensureKernelReadyForLaunch(browser);
      child = spawn(launchBinary, finalArgs, {
        detached: process.platform !== 'win32',
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      startupResources.child = child;
      // Register these listeners immediately after spawn. CDP setup can take
      // several seconds, and an early browser exit must not be lost before the
      // running item is assembled below.
      childExitState = { exited: false, code: null, signal: null, error: null };
      child.once('exit', (code, signal) => {
        childExitState.exited = true;
        childExitState.code = code;
        childExitState.signal = signal;
      });
      child.once('error', (error) => {
        childExitState.error = error;
      });
      profileLock = await updateProfileLock(root, profileLock, {
        browserPid: child.pid,
        browserProfileRoot: path.resolve(root),
        browserExecutable: launchBinary,
        browserStartedAt: new Date().toISOString(),
      });
      if (!profileLock) {
        const error = new Error('Profile lock ownership changed while starting browser');
        error.code = 'PROFILE_LOCK_LOST';
        throw error;
      }
      startupResources.profileLock = profileLock;
      const startupDiagnostic = { launchBinary, profileRoot: root, stdout: '', stderr: '' };
      child._startupDiagnostic = startupDiagnostic;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { startupDiagnostic.stdout = appendDiagnosticOutput(startupDiagnostic.stdout, chunk); });
      child.stderr?.on('data', (chunk) => { startupDiagnostic.stderr = appendDiagnosticOutput(startupDiagnostic.stderr, chunk); });
      child.on('error', (error) => { startupDiagnostic.spawnError = error.message; });
      this.emitStartProgress(profile.id, 'cdp', 76, '正在等待调试端口…');
      port = await this.waitForPort(root, 30000, child);
      connection = await portConnection(port);
      startupResources.connection = connection;
    } catch (error) {
      const diagnostic = child?._startupDiagnostic || { launchBinary, profileRoot: root };
      await writeBrowserStartupDiagnostic(this.app.getPath('userData'), {
        type: 'browser-startup-failure',
        profileId: profile.id,
        browser: browser.name,
        source: browser.source || null,
        error: formatBrowserStartupError(error, child, diagnostic),
        executable: launchBinary,
        profileRoot: root,
        exitCode: child?.exitCode ?? null,
        signal: child?.signalCode || null,
        stdout: diagnostic.stdout || '',
        stderr: diagnostic.stderr || '',
        spawnError: diagnostic.spawnError || null,
      });
      await this.cleanupStartupResources(startupResources);
      throw new Error(formatBrowserStartupError(error, child, diagnostic));
    }
    if (profile.cookies && profile.advanced.saveCookies) { try { await this.importProfileCookies(connection, profile.cookies); } catch (error) { this.emit({ type: 'sync-error', action: 'import-cookies', id: profile.id, message: 'Cookie 导入失败：' + error.message }); } }
    let reconciled;
    try {
      const managedPaths = [...this.extensions.values()].map((item) => item.path).filter(Boolean);
      reconciled = await reconcileOnConnection(connection, extensions, managedPaths);
      if (reconciled?.skipped) {
        // Expected on openbrowser-148: not an error. Extensions still load via --load-extension.
        this.emit({
          type: 'status',
          action: 'extensions-reconcile-skipped',
          id: profile.id,
          running: true,
          message: '扩展已通过 --load-extension 加载（当前内核不支持 Extensions CDP 热装）',
          reason: reconciled.reason || 'Extensions CDP unavailable',
        });
      }
    } catch (error) {
      // OpenBrowser 148 kernels may lack Extensions.* CDP — do not kill the browser.
      const msg = String(error && error.message || error || '');
      if (/not available|unknown method|was not found|not found|unsupported/i.test(msg)) {
        reconciled = { installed: extensions, extensions: [], skipped: true, reason: msg };
        this.emit({
          type: 'status',
          action: 'extensions-reconcile-skipped',
          id: profile.id,
          running: true,
          message: '扩展已通过 --load-extension 加载（当前内核不支持 Extensions CDP 热装）',
          reason: msg,
        });
      } else {
        await this.cleanupStartupResources(startupResources);
        throw error;
      }
    }
    const markerProcess = this.startNativeProfileMarker(child.pid, envNumber);
    const item = {
      child, cdpConnection: connection, proxyForwarder, markerProcess, profileLock,
      pid: child.pid, browser, root, profile, port,
      launchBinary,
      startedAt: new Date().toISOString(),
      extensions: extensions.map((entry) => entry.id),
      loadedExtensions: reconciled.extensions,
      fingerprint,
      kernelWindowName: kernelWindowName || null,
      nativeKernelFingerprint: isOpenBrowser148(browser),
      childExitState: childExitState || { exited: child.exitCode !== null, code: child.exitCode, signal: child.signalCode, error: null },
      cleanedUp: false,
      stopping: false,
      cleanupPromise: null,
      statusEmitted: false,
      profileClosedEmitted: false,
    };
    this.running.set(profile.id, item);
    liveItem = item;

    const handleChildExit = (code, signal) => {
      const expected = item.stopping === true || code === 0;
      const error = expected
        ? null
        : `浏览器异常退出${signal ? ` (${signal})` : ` (code ${code})`}`;
      this.handleBrowserGone(profile.id, item, 'browser-exit', {
        expected,
        error,
        kill: true,
        waitForExit: true,
      }).catch((cleanupError) => {
        this.emit({ type: 'sync-error', action: 'browser-exit-cleanup', id: profile.id, message: cleanupError.message });
      });
    };
    const handleChildError = (error) => {
      this.handleBrowserGone(profile.id, item, 'browser-error', {
        expected: false,
        error: error?.message || String(error),
        kill: true,
        waitForExit: true,
      }).catch(() => {});
    };
    child.once('exit', (code, signal) => {
      item.childExitState = { ...(item.childExitState || {}), exited: true, code, signal };
      handleChildExit(code, signal);
    });
    child.once('error', (error) => {
      item.childExitState = { ...(item.childExitState || {}), error };
      handleChildError(error);
    });
    // The process may have exited during CDP/bootstrap setup, before the item
    // listeners above were installed. Replay that state exactly once.
    if (item.childExitState?.exited) {
      queueMicrotask(() => handleChildExit(item.childExitState.code, item.childExitState.signal));
    } else if (item.childExitState?.error) {
      queueMicrotask(() => handleChildError(item.childExitState.error));
    }
    item.startupExtensionGuard = this.suppressStartupExtensionPages(connection, reconciled.installed).catch((error) => this.emit({ type: 'sync-error', action: 'startup-extension-pages', id: profile.id, message: error.message }));
    try {
      item.startUrl = startUrl;
      item.fpAppliedTargets = new Set();
      // Fingerprint inject BEFORE keepDefaultTab/start-page navigation so the welcome
      // page's collectFingerprint() sees spoofed navigator/WebGL (not the host GPU).
      // openbrowser-148: pixel noise may be native; JS still spoofs WebGL meta strings.
      const injectFp = item.nativeKernelFingerprint
        ? fingerprintForNativeKernelInject(fingerprint)
        : (runtimeFingerprint || fingerprint);
      await fpLog('start.inject-plan', {
        profileId: profile.id,
        port: item.port,
        launchBinary: item.launchBinary || launchBinary || browser.path,
        startUrl: startUrl || null,
        nativeKernel: Boolean(item.nativeKernelFingerprint),
        fullFp: summarizeFp(fingerprint),
        injectFp: summarizeFp(injectFp),
        logFile: fingerprintLogPath(),
      });
      this.emitStartProgress(profile.id, 'inject', 88, '正在注入指纹与运行时…');
      // Pre-inject is best-effort: must NEVER block start-page navigation.
      try {
        item.fingerprint = await this.applyRuntimeSettings(item.port, profile, injectFp, {
          appliedTargetIds: item.fpAppliedTargets,
          trackOn: item,
          phase: 'pre-startpage',
        }) || fingerprint;
      } catch (preInjectError) {
        item.fingerprint = fingerprint;
        await fpLog('start.pre-inject-fail', {
          profileId: profile.id,
          error: String(preInjectError.message || preInjectError),
        });
        this.emit({
          type: 'fingerprint-injection-failed',
          id: profile.id,
          message: 'pre-startpage inject: ' + preInjectError.message,
        });
      }
      // Keep reported modes as profile intent (not the stripped inject payload)
      if (item.nativeKernelFingerprint && fingerprint) {
        item.fingerprint = {
          ...(item.fingerprint || fingerprint),
          canvas: fingerprint.canvas,
          webgl: fingerprint.webgl,
          audio: fingerprint.audio,
          clientRects: fingerprint.clientRects,
          userAgent: fingerprint.userAgent,
          platform: fingerprint.platform,
          hardwareConcurrency: fingerprint.hardwareConcurrency,
          deviceMemory: fingerprint.deviceMemory,
        };
      }
      await this.startWorkerFingerprintInjection(item, injectFp).catch(async (error) => {
        item.workerFingerprintError = error.message;
        await fpLog('worker.inject-fail', { profileId: profile.id, error: String(error.message || error) });
        this.emit({ type: 'worker-fingerprint-injection-failed', id: profile.id, message: error.message });
      });
      // Always open the welcome/start page (even if inject failed).
      if (!restoreSession && startUrl) {
        await fpLog('start.navigate-startpage', { profileId: profile.id, startUrl });
        try {
          await this.keepDefaultTab(item.port, startUrl);
        } catch (navError) {
          await fpLog('start.navigate-fail', { profileId: profile.id, error: String(navError.message || navError) });
        }
        try {
          await this.ensureStartPageFingerprint(item, profile, injectFp, startUrl);
        } catch (reInjectError) {
          await fpLog('start.reinject-fail', { profileId: profile.id, error: String(reInjectError.message || reInjectError) });
          this.emit({
            type: 'fingerprint-injection-failed',
            id: profile.id,
            message: 'start-page re-inject: ' + reInjectError.message,
          });
        }
      }
      // Brand window title as 环境 N (not generic Chrome)
      await this.applyEnvWindowTitle(item.port, profile).catch(() => {});
      await fpLog('start.done', {
        profileId: profile.id,
        port: item.port,
        reported: summarizeFp(item.fingerprint),
      });
    } catch (error) {
      item.cdpError = error.message;
      await fpLog('start.fail', { profileId: profile.id, error: String(error.message || error) });
      // Last chance: still try to open start page so UI is not stuck on about:blank.
      if (!restoreSession && startUrl && item.port) {
        try {
          await this.keepDefaultTab(item.port, startUrl);
          await fpLog('start.navigate-after-fail', { profileId: profile.id, startUrl });
        } catch (_) {}
      }
    }
    if (this.running.get(profile.id) !== item || item.cleanedUp || item.stopping) {
      throw new Error(item.cdpError || '浏览器在启动过程中异常退出');
    }
    // Detect user closing browser with X (process may stay alive; CDP/pages are source of truth)
    this.startRunningWatch(item);
    this.emitStartProgress(profile.id, 'ready', 100, '启动完成');
    this.emit({ type: 'status', id: profile.id, running: true, ...this.publicRunning(profile.id) });
    return this.publicRunning(profile.id);
    } catch (error) {
      // Release anything acquired before the env became live. The inner spawn/extension
      // catches already release on their own failure paths (making this a safe no-op via
      // token/close idempotency); this covers the earlier steps — proxy bridge, tab reset,
      // start-page/fingerprint build — whose throws would otherwise strand the lock.
      if (liveItem) {
        // The item is published before runtime injection and start-page setup so
        // exit events can clean it up. If either step fails, run the same guarded
        // cleanup path instead of leaving a live map entry and profile lock behind.
        await this.handleBrowserGone(profile.id, liveItem, 'start-failed', {
          expected: false,
          error: error?.message || String(error),
          kill: true,
          waitForExit: true,
          emitProfileClosed: false,
        }).catch(() => {});
      } else if (!this.running.has(profile.id)) {
        await this.cleanupStartupResources(startupResources).catch(() => {});
      }
      this.emit({
        type: 'profile-start-progress',
        id: profile.id,
        phase: 'error',
        percent: 0,
        message: error?.message || String(error || '启动失败'),
        starting: false,
        running: false,
        error: true,
      });
      throw error;
    }
  }

  publicRunning(id) {
    const starting = this.starting.has(id);
    const pendingStop = this.stopping.has(id);
    const item = this.running.get(id);
    if (!item) return { id, running: false, starting, stopping: pendingStop };
    if (item.cleanedUp || item.stopping) {
      return {
        id,
        running: false,
        stopping: true,
        pid: item.pid,
        port: item.port,
        browser: item.browser?.name,
        executable: item.browser?.path,
        profileDirectory: item.root,
      };
    }
    return {
      id, running: true, starting: false, stopping: false, pid: item.pid, port: item.port,
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
    const safe = assertProfileId(id);
    const pendingStop = this.stopping.get(safe);
    if (pendingStop) return pendingStop;

    const pendingStart = this.starting.get(safe);
    if (pendingStart) await pendingStart.catch(() => {});

    const afterStartStop = this.stopping.get(safe);
    if (afterStartStop) return afterStartStop;
    const item = this.running.get(safe);
    if (!item) return { id: safe, running: false, alreadyStopped: true };
    if (item.cleanupPromise) return item.cleanupPromise;

    const task = this._stop(safe, item);
    this.stopping.set(safe, task);
    task.finally(() => {
      if (this.stopping.get(safe) === task) this.stopping.delete(safe);
    }).catch(() => {});
    return task;
  }

  async _stop(safe, item) {
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
              await item.cdpConnection?.command?.('Browser.close', {}, { timeout: 5000 });
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
    const cleanupResult = await this.cleanupRunningItem(safe, item, {
      reason: 'stop',
      expected: true,
      kill: !graceful,
      waitForExit: true,
      exitTimeout: 6500,
      emitProfileClosed: false,
    });
    await this.enforceDataRetention(item.root, this.profiles.get(safe) || item.profile).catch(() => {});
    if (profile.advanced?.cloudBackup) {
      item.profileClosedEmitted = true;
      this.emit({
        type: 'profile-closed',
        id: safe,
        cloudBackup: true,
        cookieExported: Boolean(cookieExport),
        profile: this.profiles.get(safe) || profile,
        reason: 'stop',
      });
    }
    return { ...cleanupResult, id: safe, running: false, graceful, cookieExported: Boolean(cookieExport) };
  }

  async stopAll() {
    // Drain until the lifecycle maps reach a fixed point. A one-shot snapshot can
    // miss a restart that was queued while another environment was stopping.
    // Keep the retry bounded so a permanently failing _stop cannot hang app quit.
    const failed = [];
    let previousSignature = null;
    for (let pass = 0; pass < 32; pass += 1) {
      const ids = [...new Set([...this.running.keys(), ...this.starting.keys(), ...this.stopping.keys()])];
      if (!ids.length) break;
      const signature = [...ids].sort().join('\0');
      const results = await Promise.allSettled(ids.map((id) => this.stop(id)));
      for (const result of results) {
        if (result.status === 'rejected') failed.push(String(result.reason?.message || result.reason));
      }
      const pending = [...this.stopping.values()];
      if (pending.length) await Promise.allSettled(pending);
      const remaining = [...new Set([...this.running.keys(), ...this.starting.keys(), ...this.stopping.keys()])];
      if (!remaining.length) break;
      const nextSignature = [...remaining].sort().join('\0');
      // No lifecycle key changed after a full stop attempt. Retrying would only
      // turn an isolated cleanup failure into an unbounded quit hang.
      if (nextSignature === signature || nextSignature === previousSignature) {
        failed.push(`lifecycle drain did not converge: ${remaining.join(', ')}`);
        break;
      }
      previousSignature = signature;
    }
    const remaining = [...new Set([...this.running.keys(), ...this.starting.keys(), ...this.stopping.keys()])];
    if (remaining.length) failed.push(`lifecycle resources remain: ${remaining.join(', ')}`);
    if (failed.length) this.emit({ type: 'sync-error', action: 'stop-all', message: `部分环境停止失败：${[...new Set(failed)].join('; ')}` });
  }

  async deleteProfiles(ids, deleteData = true) {
    if (!Array.isArray(ids) || ids.length > 200) throw new Error('Invalid profile selection');
    const safeIds = [...new Set(ids.map(assertProfileId))];
    const deleted = []; let stopped = 0;
    for (const id of safeIds) {
      if (!this.profiles.has(id)) continue;
      if (this.running.has(id) || this.starting.has(id) || this.stopping.has(id)) {
        await this.stop(id);
        stopped += 1;
      }
      this.profiles.delete(id); this.assignments.delete(id); this.networkInfo.delete(id); deleted.push(id);
      if (deleteData) {
        const profileRoot = this.profileRoot(id);
        const rootCheck = await validateProfileRootSecure(this.profileDataRootPath, profileRoot, id);
        if (!rootCheck.ok) throw new Error('Isolation error: ' + rootCheck.message);
        if (fs.existsSync(profileRoot)) {
          // Windows often holds Chrome locks (EBUSY/EPERM) briefly after Browser.close / taskkill.
          let lastError = null;
          for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
              await fsp.rm(profileRoot, { recursive: true, force: true });
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              if (!error || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
              await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
            }
          }
          if (lastError) throw lastError;
        }
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
      const result = await retryProxyOperation(() => lookupProxyCountry(resolved.config, {
        ipChannel: profile.proxyMeta?.ipChannel,
      }));
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
    const applied = this.applyNetworkToProfile(profile, network, { persist: false });
    // A successful manual check may be followed immediately by app shutdown. Do not
    // acknowledge it until the durable engine state contains the new exit details.
    if (options.persist) await this.persist();
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
    // refreshUrl and apiExtractUrl stay separate: refresh rotates; extract re-reads endpoint.
    if (!refreshUrl && !extractUrl) throw new Error('未配置刷新 URL 或提取 URL');
    const refresh = refreshUrl
      ? await invokeProxyRefresh(refreshUrl)
      : { ok: true, skipped: true, reason: 'no-refresh-url' };
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
    // Align with refreshProfileProxy: refresh first (rotate IP), then extract current endpoint.
    if (meta.refreshOnStart && String(meta.refreshUrl || '').trim()) {
      try {
        await invokeProxyRefresh(meta.refreshUrl);
      } catch (error) {
        this.emit({ type: 'proxy-error', id: working.id, message: '启动前刷新代理失败：' + (error.message || error) });
        throw new Error('启动前刷新代理失败：' + (error.message || error));
      }
    }
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
        this.emit({
          type: 'proxy-warn',
          id: working.id,
          code: 'extract-error',
          message: '动态代理提取失败，继续使用静态代理：' + (error.message || error),
          extractError: String(error.message || error),
        });
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
  runningWithCdp(ids) {
    return ids.map((id) => ({ id, item: this.running.get(id) }))
      .filter((entry) => entry.item?.port && !entry.item.cleanedUp && !entry.item.stopping);
  }
  async sessions() { const result = []; for (const { id, item } of this.runningWithCdp([...this.running.keys()])) { try { result.push({ id, profile: this.profiles.get(id), port: item.port, browser: item.browser.name, tabs: await cdp.tabs(item.port) }); } catch (error) { result.push({ id, profile: this.profiles.get(id), port: item.port, browser: item.browser.name, tabs: [], error: error.message }); } } return result; }
}

module.exports = {
  BrowserEngine,
  appendDiagnosticOutput,
  formatBrowserStartupError,
  writeBrowserStartupDiagnostic,
  systemBrowserCandidatesForPlatform,
};
