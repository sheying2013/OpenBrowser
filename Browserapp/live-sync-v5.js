const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const cdp = require('./cdp');
const { LiveSyncController: LiveSyncV4, injection } = require('./live-sync-v4');
const { planFanoutFromPayload } = require('./automation/protocol/sync-fanout');
const { settingsToOperateList } = require('./automation/protocol/event-map');
const { syncCapabilities } = require('./automation/protocol/cross-platform');

const masterMarker = String.raw`(() => {
  const install = () => { if (!document.documentElement) return requestAnimationFrame(install); if (document.getElementById('openbrowser-master-marker')) return; const marker = document.createElement('div'); marker.id='openbrowser-master-marker'; marker.textContent='\u4e3b\u63a7\u7a97\u53e3'; marker.style.cssText='position:fixed;left:12px;top:12px;z-index:2147483647;background:#123a8c;color:white;padding:8px 14px;border-radius:8px;font:700 14px Segoe UI,sans-serif;box-shadow:0 4px 18px #0005;pointer-events:none'; document.documentElement.appendChild(marker); document.documentElement.style.boxShadow='inset 0 0 0 5px #123a8c'; };
  install();
})();`;

const fullscreenInjection = String.raw`(() => {
  // Install in every execution context. A player inside an iframe (including an
  // OOPIF) owns its own fullscreen document, so restricting this to window.top
  // silently loses fullscreenchange events from otherwise valid players.
  if (window.__openBrowserFullscreenSyncV5) return;
  window.__openBrowserFullscreenSyncV5 = true;
  const escape = (value) => {
    try { return CSS.escape(String(value)); } catch (_) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  };
  const localSelector = (element) => {
    if (!(element instanceof Element)) return '';
    if (element.id) return '#' + escape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      if (current.parentElement) {
        const siblings = [...current.parentElement.children].filter((item) => item.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const selector = (element) => {
    const segments = [];
    let current = element;
    while (current instanceof Element) {
      segments.unshift(localSelector(current));
      const root = current.getRootNode();
      current = root instanceof ShadowRoot ? root.host : null;
    }
    return segments.filter(Boolean).join(' >>> ');
  };
  const fullscreenElement = () => {
    let root = document;
    let element = null;
    const seen = new Set();
    while (root && !seen.has(root)) {
      seen.add(root);
      element = root.fullscreenElement || root.webkitFullscreenElement || null;
      if (!element || !element.shadowRoot) return element;
      root = element.shadowRoot;
    }
    return element;
  };
  const frameInfo = () => {
    const info = { frameUrl: String(location.href || ''), frameName: String(window.name || ''), frameDepth: 0, framePath: '' };
    try {
      // frameElement can be blocked for a cross-origin frame. Chromium still
      // exposes ancestorOrigins, which is enough to route the request through
      // Page.getFrameTree even when a CSS path cannot be recovered.
      try { info.frameDepth = Number(location.ancestorOrigins?.length) || 0; } catch (_) {}
      const segments = [];
      let current = window;
      let traversedDepth = 0;
      while (current !== current.top) {
        const frame = current.frameElement;
        if (!(frame instanceof Element)) break;
        segments.unshift(localSelector(frame));
        traversedDepth += 1;
        current = current.parent;
      }
      info.frameDepth = Math.max(info.frameDepth, traversedDepth);
      info.framePath = segments.filter(Boolean).join(' >>> ');
    } catch (_) {}
    return info;
  };
  let queued = false;
  let lastReport = '';
  let lastReportAt = 0;
  const report = (error) => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const element = fullscreenElement();
      try {
        const payload = {
          type: 'fullscreen',
          active: Boolean(element),
          selector: selector(element),
          tag: String(element?.tagName || '').toLowerCase(),
          id: String(element?.id || ''),
          ...frameInfo(),
          error: error ? String(error.message || error) : '',
        };
        const signature = JSON.stringify(payload);
        const now = Date.now();
        if (signature === lastReport && now - lastReportAt < 50) return;
        lastReport = signature; lastReportAt = now;
        window.openBrowserSync(JSON.stringify(payload));
      } catch (_) {}
    });
  };
  const installShadowRoot = (root) => {
    if (!root || root.__openBrowserFullscreenSyncV5) return;
    try { Object.defineProperty(root, '__openBrowserFullscreenSyncV5', { value: true }); } catch (_) {}
    root.addEventListener('fullscreenchange', () => report(), true);
    root.addEventListener('webkitfullscreenchange', () => report(), true);
    root.addEventListener('fullscreenerror', () => report('Fullscreen request was rejected'), true);
    root.addEventListener('webkitfullscreenerror', () => report('Fullscreen request was rejected'), true);
  };
  try {
    const attachShadow = Element.prototype.attachShadow;
    if (typeof attachShadow === 'function') {
      Element.prototype.attachShadow = function (...args) {
        const root = attachShadow.apply(this, args);
        installShadowRoot(root);
        return root;
      };
    }
  } catch (_) {}
  const scanShadowRoots = (root) => {
    for (const element of root.querySelectorAll?.('*') || []) {
      if (!element.shadowRoot) continue;
      installShadowRoot(element.shadowRoot);
      scanShadowRoots(element.shadowRoot);
    }
  };
  try { scanShadowRoots(document); } catch (_) {}
  document.addEventListener('fullscreenchange', () => report(), true);
  document.addEventListener('webkitfullscreenchange', () => report(), true);
  document.addEventListener('fullscreenerror', () => report('Fullscreen request was rejected'), true);
  document.addEventListener('webkitfullscreenerror', () => report('Fullscreen request was rejected'), true);
})();`;

function fullscreenExpression(payload = {}) {
  const active = payload.active === true;
  const selector = JSON.stringify(String(payload.selector || ''));
  const tag = JSON.stringify(String(payload.tag || '').toLowerCase());
  const id = JSON.stringify(String(payload.id || ''));
  return `(async () => {
    try {
      const current = document.fullscreenElement || document.webkitFullscreenElement || null;
      if (!${active}) {
        if (!current) return { active: false, changed: false };
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (!exit) return { active: true, changed: false, unsupported: true };
        await exit.call(document);
        return { active: Boolean(document.fullscreenElement || document.webkitFullscreenElement), changed: true };
      }
      if (document.fullscreenEnabled === false) return { active: Boolean(current), changed: false, unsupported: true, reason: 'fullscreen-disabled' };
      const deep = (path) => {
        if (!path) return null;
        let root = document;
        let element = null;
        for (const part of path.split(/\\s*>>>\\s*/)) {
          try { element = root.querySelector(part); } catch (_) { return null; }
          if (!element) return null;
          root = element.shadowRoot || element;
        }
        return element;
      };
      let element = deep(${selector});
      if (!element && ${id}) element = document.getElementById(${id});
      if (!element && !${selector} && !${id} && ${tag}) element = document.querySelector(${tag});
      if (!element && (${selector} || ${id} || ${tag})) return { active: Boolean(current), changed: false, unsupported: true, reason: 'fullscreen-target-not-found' };
      if (!element) element = document.documentElement;
      if (current === element) return { active: true, changed: false };
      const request = element.requestFullscreen || element.webkitRequestFullscreen
        || (String(element.tagName || '').toLowerCase() === 'video' && element.webkitEnterFullscreen);
      if (!request) return { active: Boolean(current), changed: false, unsupported: true };
      await Promise.resolve(request.call(element));
      return { active: Boolean(document.fullscreenElement || document.webkitFullscreenElement), changed: true };
    } catch (error) {
      return { active: Boolean(document.fullscreenElement || document.webkitFullscreenElement), changed: false, error: String(error && error.message || error) };
    }
  })()`;
}

function flattenFrameTree(node, result = [], depth = 0) {
  if (!node) return result;
  const frame = node.frame || node;
  result.push({ frame, depth });
  for (const child of node.childFrames || []) flattenFrameTree(child, result, depth + 1);
  return result;
}

function frameUrlKey(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    return url.href.replace(/\/$/, '').toLowerCase();
  } catch (_) {
    return String(value || '').split('#')[0].replace(/\/$/, '').toLowerCase();
  }
}

function chooseFullscreenFrame(frameTree, payload = {}) {
  const entries = flattenFrameTree(frameTree?.frameTree || frameTree);
  if (!entries.length) return null;
  const requestedUrl = frameUrlKey(payload.frameUrl);
  const requestedName = String(payload.frameName || '');
  const requestedDepth = Number.isInteger(payload.frameDepth) ? payload.frameDepth : null;
  const requestedPath = String(payload.framePath || '');
  const pathOnlyRequest = Boolean(requestedPath && !requestedUrl && !requestedName);
  let candidates = entries;
  if (requestedUrl) {
    const exact = candidates.filter((entry) => frameUrlKey(entry.frame?.url) === requestedUrl);
    candidates = exact.length
      ? exact
      : candidates.filter((entry) => frameUrlKey(entry.frame?.url).split('?')[0] === requestedUrl.split('?')[0]);
    if (!candidates.length) return null;
  }
  if (requestedName) {
    candidates = candidates.filter((entry) => String(entry.frame?.name || '') === requestedName);
    if (!candidates.length) return null;
  }
  if (requestedDepth !== null) {
    candidates = candidates.filter((entry) => entry.depth === requestedDepth);
    if (!candidates.length) return null;
  }
  let best = null;
  let bestScore = -Infinity;
  for (const entry of candidates) {
    const frame = entry.frame || {};
    let score = 0;
    if (requestedUrl && frameUrlKey(frame.url) === requestedUrl) score += 1000;
    else if (requestedUrl) score += 250;
    if (requestedName) score += 300;
    if (requestedDepth !== null) score += 120;
    if (requestedPath) score += 1;
    if (entry.depth === 0 && !requestedUrl && requestedDepth === null) score += 10;
    if (score > bestScore) { best = entry; bestScore = score; }
  }
  if (pathOnlyRequest) {
    const depth = requestedDepth === null ? 0 : requestedDepth;
    return candidates.length === 1 && candidates[0].depth === depth ? candidates[0].frame : null;
  }
  return bestScore > 0 ? best.frame : null;
}

function environmentMarker(id, master) { const text = (master ? '\u4e3b\u63a7 | ' : '') + '\u73af\u5883\u7f16\u53f7: ' + id; const color = master ? '#123a8c' : '#334155'; return `(() => { const install=()=>{if(!document.documentElement)return requestAnimationFrame(install);let e=document.getElementById('openbrowser-environment-marker');if(!e){e=document.createElement('div');e.id='openbrowser-environment-marker';document.documentElement.appendChild(e);}e.textContent=${JSON.stringify(text)};e.style.cssText='position:fixed;right:12px;top:12px;z-index:2147483646;background:${color};color:white;padding:7px 12px;border-radius:8px;font:700 13px Segoe UI,sans-serif;box-shadow:0 4px 16px #0004;pointer-events:none';};install();})()`; }

function managedTabs(values) { return values.filter((tab) => !/^(devtools|chrome-extension|edge-extension):/i.test(tab.url)); }
function normalTabs(values) { return values.filter((tab) => !/^(devtools|chrome-extension|edge-extension):/i.test(tab.url) && (!/^(chrome|edge):/i.test(tab.url) || /^chrome:\/\/(newtab|new-tab-page)/i.test(tab.url))); }
function extensionPages(values) { return values.filter((tab) => ['page', 'iframe'].includes(String(tab.type || 'page')) && /^(chrome|edge)-extension:\/\//i.test(String(tab.url || ''))); }
function extensionPageKey(tab) {
  try { const value = new URL(String(tab.url || '')); return (value.protocol + '//' + value.hostname + value.pathname).toLowerCase(); }
  catch (_) { return String(tab.url || '').split(/[?#]/)[0].toLowerCase(); }
}
function extensionHost(tab) {
  try { return new URL(String(tab.url || '')).hostname.toLowerCase(); }
  catch (_) { return ''; }
}
function isEnvironmentStartUrl(value) {
  const s = String(value || '');
  if (/openbrowser-start\.html/i.test(s)) return true;
  if (/openbrowser-start|openbrowser-native/i.test(s)) return true;
  if (/https?:\/\/127\.0\.0\.1:5032[6-9]\/?/i.test(s)) return true;
  return false;
}
function environmentStartUrl(engine, id) {
  const running = engine.running.get(id);
  if (running?.startUrl) return running.startUrl;
  try {
    if (engine.startPageServer && running?.profile) {
      return engine.startPageServer.buildUrl(running.profile);
    }
  } catch (_) {}
  const root = running?.root;
  if (!root) return null;
  // Must percent-encode spaces / non-ASCII (Windows user profiles often contain them).
  return pathToFileURL(path.join(root, 'openbrowser-start.html')).href;
}
function environmentNumber(engine, id) {
  const profile = engine.running?.get?.(id)?.profile || engine.profiles?.get?.(id);
  return String(profile?.number || profile?.name || id);
}

class LiveSyncController extends LiveSyncV4 {
  constructor(engine, emit) {
    super(engine, emit);
    this.tabMap = new Map();
    this.desiredUrlMap = new Map();
    this.extensionMap = new Map(); this.extensionConnections = new Map();
    this.mappingReady = false;
    this.activeMasterTab = null; this.lastWindowSync = 0; this.lastHealthCheck = 0; this.nativeInputMirror = null; this.nativePopupActive = false;
    this.geometryPausedUntil = 0; this.geometryPending = new Map(); this.fullscreenByTab = new Map(); this.fullscreenSessions = new Map(); this.fullscreenActiveSessions = new Map();
    this.browserOwnedUntil = 0; this.nativeInputStdoutBuffer = '';
    this.nativeRestartTimer = null; this.nativeRestartCount = 0; this.nativeDevToolsMode = false;
    this.nativeBridgeState = process.platform === 'win32' ? 'down' : 'disabled';
    this.nativeBridgeReadyTimer = null;
    // Keep the logical session identity separate from the live CDP objects. A
    // browser-close disconnect can clear `master` before the engine emits its
    // final status event, but the controlled environments still need closing.
    this.syncSession = null; this.syncGeneration = 0; this.masterClosePromise = null; this.masterCloseGeneration = null;
    this.syncSettings = { keyboard: true, click: true, scroll: true, track: true, delayClick: false, delayInput: false, inputMinMs: 300, inputMaxMs: 300, clickMinMs: 100, clickMaxMs: 300 };
  }

  updateSettings(value = {}) {
    const boolean = (name) => value[name] === undefined ? this.syncSettings[name] : value[name] !== false;
    const range = (name, fallback) => Math.max(0, Math.min(5000, Number(value[name] ?? fallback) || 0));
    const next = { ...this.syncSettings, keyboard: boolean('keyboard'), click: boolean('click'), scroll: boolean('scroll'), track: boolean('track'), delayClick: boolean('delayClick'), delayInput: boolean('delayInput') };
    next.inputMinMs = range('inputMinMs', next.inputMinMs); next.inputMaxMs = Math.max(next.inputMinMs, range('inputMaxMs', next.inputMaxMs));
    next.clickMinMs = range('clickMinMs', next.clickMinMs); next.clickMaxMs = Math.max(next.clickMinMs, range('clickMaxMs', next.clickMaxMs));
    this.syncSettings = next;
    if (this.master) this.startNativeInputMirror();
    this.emit({ type: 'sync-settings', settings: { ...next }, operate: settingsToOperateList(next), capabilities: syncCapabilities() });
    return { ...next, operate: settingsToOperateList(next) };
  }

  getSettings() {
    return { ...this.syncSettings, operate: settingsToOperateList(this.syncSettings), capabilities: syncCapabilities() };
  }

  /** Operate list for gates / Local API */
  getOperateList() {
    return settingsToOperateList(this.syncSettings);
  }

  /**
   * Plan fanout using protocol event types (1/2/3/20/21...).
   * Does not replace semantic forward(); validates gates + exposes command map.
   */
  planProtocolFanout(payload) {
    return planFanoutFromPayload(payload, {
      syncSettings: this.syncSettings,
      isDelay: this.syncSettings.delayClick || this.syncSettings.delayInput ? '1' : '0',
      mouseDelayMin: this.syncSettings.clickMinMs,
      mouseDelayMax: this.syncSettings.clickMaxMs,
      delayClick: this.syncSettings.delayClick,
      delayInput: this.syncSettings.delayInput,
      inputMinMs: this.syncSettings.inputMinMs,
      inputMaxMs: this.syncSettings.inputMaxMs,
      clickMinMs: this.syncSettings.clickMinMs,
      clickMaxMs: this.syncSettings.clickMaxMs,
    });
  }

  randomDelay(min, max) { return min + Math.random() * Math.max(0, max - min); }

  async start(ids) {
    const pendingClose = this.masterClosePromise;
    // Invalidate refresh/error callbacks from the previous session before
    // waiting for its controlled environments to finish closing.
    this.syncGeneration += 1;
    if (pendingClose) await pendingClose.catch(() => {});
    const result = await super.start(ids);
    this.nativeRestartCount = 0; this.startNativeInputMirror();
    const masterId = this.master?.id;
    const controlledIds = this.slaves.map((item) => item.id);
    const session = { masterId, controlledIds: [...controlledIds], generation: this.syncGeneration };
    this.syncSession = session;
    // super.start() scheduled a tick before the session identity existed.
    // Re-arm it now so every future tick carries the current generation.
    this.scheduleRefreshTick();
    this.unsubscribeMasterClose = this.engine.on((event) => {
      if (this.syncSession !== session || event?.type !== 'status' || event.running !== false || event.id !== session.masterId) return;
      this.scheduleMasterClose(session.controlledIds, session);
    });
    return result;
  }

  getRefreshGeneration() {
    return this.syncGeneration;
  }

  isRefreshGenerationCurrent(generation) {
    return generation == null || generation === this.syncGeneration;
  }

  handleWatchError(error, refreshGeneration = null) {
    if (!this.isRefreshGenerationCurrent(refreshGeneration)) return;
    const message = String(error?.message || error || 'Unknown sync error');
    const session = this.syncSession;
    if (/ECONNREFUSED|connection refused|fetch failed|CDP (?:persistent )?socket (?:error|closed)|CDP connection closed/i.test(message) && session?.masterId) {
      const master = session.masterId;
      const slaves = [...session.controlledIds];
      this.emit({ type: 'sync-disconnected', active: false, master, slaves, message: '浏览器环境已关闭或调试端口失效，同步已自动停止' });
      this.scheduleMasterClose(slaves, session);
      return;
    }
    return super.handleWatchError(error);
  }

  startNativeInputMirror() {
    const previousPopup = this.nativePopupActive;
    this.stopNativeInputMirror(false);
    this.nativePopupActive = previousPopup;
    if (!this.master) return;
    if (process.platform !== 'win32') {
      this.nativeBridgeState = 'disabled';
      this.emit({ type: 'native-input', active: false, mode: 'cdp-only', platform: process.platform, message: 'macOS/Linux 使用 CDP 页面同步；Chrome 原生 UI 输入镜像仅 Windows 支持' });
      return;
    }
    const executable = path.join(__dirname, 'native-input-mirror.exe');
    if (!fs.existsSync(executable)) { this.nativeBridgeState = 'down'; this.emit({ type: 'sync-error', action: 'native-input', message: 'Windows input bridge is missing' }); return; }
    const masterPid = this.engine.running.get(this.master.id)?.pid;
    const slavePids = this.slaves.map((slave) => this.engine.running.get(slave.id)?.pid).filter((pid) => Number.isInteger(pid) && pid > 0);
    if (!Number.isInteger(masterPid) || masterPid <= 0 || !slavePids.length) { this.nativeBridgeState = 'down'; return; }
    const nativeEnv = { ...process.env, OPENBROWSER_SYNC_KEYBOARD: this.syncSettings.keyboard ? '1' : '0', OPENBROWSER_SYNC_CLICK: this.syncSettings.click ? '1' : '0', OPENBROWSER_SYNC_SCROLL: this.syncSettings.scroll ? '1' : '0', OPENBROWSER_SYNC_TRACK: this.syncSettings.track ? '1' : '0', OPENBROWSER_DELAY_CLICK: this.syncSettings.delayClick ? '1' : '0', OPENBROWSER_DELAY_INPUT: this.syncSettings.delayInput ? '1' : '0', OPENBROWSER_INPUT_MIN_MS: String(this.syncSettings.inputMinMs), OPENBROWSER_INPUT_MAX_MS: String(this.syncSettings.inputMaxMs), OPENBROWSER_CLICK_MIN_MS: String(this.syncSettings.clickMinMs), OPENBROWSER_CLICK_MAX_MS: String(this.syncSettings.clickMaxMs) };
    const child = spawn(executable, [String(masterPid), ...slavePids.map(String)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: nativeEnv });
    this.nativeInputMirror = child;
    this.nativeBridgeState = 'starting';
    this.browserOwnedUntil = Math.max(this.browserOwnedUntil || 0, Date.now() + 1200);
    this.nativeInputStdoutBuffer = '';
    this.nativeBridgeReadyTimer = setTimeout(() => {
      if (this.nativeInputMirror === child && this.nativeBridgeState === 'starting') this.nativeBridgeState = 'ready';
    }, 1200);
    this.nativeBridgeReadyTimer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      if (this.nativeInputMirror === child) {
        this.nativeBridgeState = 'ready';
        if (this.nativeBridgeReadyTimer) clearTimeout(this.nativeBridgeReadyTimer);
        this.nativeBridgeReadyTimer = null;
      }
      this.nativeInputStdoutBuffer += String(chunk || '');
      const lines = this.nativeInputStdoutBuffer.split(/\r?\n/);
      this.nativeInputStdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const match = line.match(/^DEVTOOLS_MODE=([01])$/);
        if (match) { this.nativeDevToolsMode = match[1] === '1'; this.emit({ type: 'native-devtools', active: this.nativeDevToolsMode }); }
        const popup = line.match(/^NATIVE_POPUP_ACTIVE=([01])$/);
        if (popup) { this.nativePopupActive = popup[1] === '1'; this.emit({ type: 'native-popup', active: this.nativePopupActive }); }
      }
    });
    child.once('error', (error) => {
      if (this.nativeInputMirror === child) {
        this.nativeInputMirror = null;
        if (this.nativeBridgeReadyTimer) clearTimeout(this.nativeBridgeReadyTimer);
        this.nativeBridgeReadyTimer = null;
        this.nativeBridgeState = 'down';
        this.browserOwnedUntil = Math.max(this.browserOwnedUntil || 0, Date.now() + 1200);
        this.nativeInputStdoutBuffer = '';
        this.nativeDevToolsMode = false;
        this.nativePopupActive = false;
        this.scheduleNativeInputRestart(error.message);
      }
      this.emit({ type: 'sync-error', action: 'native-input', message: error.message });
    });
    child.once('exit', (code) => {
      if (this.nativeInputMirror !== child) return; this.nativeInputMirror = null;
      if (this.nativeBridgeReadyTimer) clearTimeout(this.nativeBridgeReadyTimer);
      this.nativeBridgeReadyTimer = null;
      this.nativeBridgeState = 'down';
      this.browserOwnedUntil = Math.max(this.browserOwnedUntil || 0, Date.now() + 1200);
      this.nativeInputStdoutBuffer = '';
      const wasDevTools = this.nativeDevToolsMode;
      const wasPopup = this.nativePopupActive;
      this.nativeDevToolsMode = false;
      this.nativePopupActive = false;
      if (wasDevTools) this.emit({ type: 'native-devtools', active: false });
      if (wasPopup) this.emit({ type: 'native-popup', active: false });
      if (code && this.master) { this.emit({ type: 'sync-error', action: 'native-input', message: 'Windows input bridge exited: ' + code }); this.scheduleNativeInputRestart('exit ' + code); }
    });
    this.emit({ type: 'native-input', active: true, master: this.master.id, slaves: this.slaves.map((slave) => slave.id) });
  }

  scheduleNativeInputRestart(reason) {
    if (this.nativeRestartTimer || !this.master) return;
    if (this.nativeRestartCount >= 3) { this.emit({ type: 'sync-error', action: 'native-input-restart', message: 'Windows input bridge could not be recovered automatically' }); return; }
    const attempt = ++this.nativeRestartCount; const delay = 350 * (2 ** (attempt - 1));
    this.emit({ type: 'sync-recovering', component: 'native-input', attempt, delay, reason });
    this.nativeRestartTimer = setTimeout(() => { this.nativeRestartTimer = null; if (this.master) this.startNativeInputMirror(); }, delay);
    this.nativeRestartTimer.unref?.();
  }

  stopNativeInputMirror(resetAttempts = true) {
    if (this.nativeRestartTimer) clearTimeout(this.nativeRestartTimer); this.nativeRestartTimer = null;
    if (this.nativeBridgeReadyTimer) clearTimeout(this.nativeBridgeReadyTimer); this.nativeBridgeReadyTimer = null;
    if (resetAttempts) this.nativeRestartCount = 0;
    const child = this.nativeInputMirror; this.nativeInputMirror = null; this.nativeDevToolsMode = false; this.nativePopupActive = false;
    this.nativeBridgeState = process.platform === 'win32' ? 'down' : 'disabled';
    if (child && !child.killed) { try { child.kill(); } catch (_) {} }
  }

  enqueueForward(tabId, payload, action = 'forward') {
    const type = payload?.type;
    if (action === 'forward') {
      if (!this.syncSettings.keyboard && ['key', 'input', 'beforeinput'].includes(type)) return;
      if (!this.syncSettings.click && (type === 'click' || type === 'focus' || (type === 'mouse' && payload?.phase !== 'move'))) return;
      if (!this.syncSettings.track && type === 'mouse' && payload?.phase === 'move') return;
      if (!this.syncSettings.scroll && ['wheel', 'scroll'].includes(type)) return;
      if (this.nativeDevToolsMode && ['click', 'mouse', 'wheel', 'scroll'].includes(type)) return;
    }
    if (['click', 'focus', 'beforeinput', 'input'].includes(type)) {
      this.pauseGeometrySync(1200, 'page-interaction');
      this.browserOwnedUntil = Math.max(this.browserOwnedUntil || 0, Date.now() + 1800);
    }
    return super.enqueueForward(tabId, payload, action);
  }

  async forward(tabId, payload) {
    if (payload?.type === 'fullscreen') return this.syncFullscreen(tabId, payload);
    // Protocol gate: operate flags (click+move / scroll+move / keyboard)
    const plan = this.planProtocolFanout(payload);
    if (plan.skip && plan.reason === 'operate-gate') return;
    if (plan.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
    else {
      const type = payload?.type;
      const clickEvent = type === 'click';
      const inputEvent = type === 'beforeinput' || (type === 'key' && payload?.phase === 'down');
      if (clickEvent && this.syncSettings.delayClick) await new Promise((resolve) => setTimeout(resolve, this.randomDelay(this.syncSettings.clickMinMs, this.syncSettings.clickMaxMs)));
      if (inputEvent && this.syncSettings.delayInput) await new Promise((resolve) => setTimeout(resolve, this.randomDelay(this.syncSettings.inputMinMs, this.syncSettings.inputMaxMs)));
    }
    // Semantic selector-based forward remains in v4 (more accurate than raw x/y on multi-resolution slaves).
    // Protocol plan is retained for Local API telemetry / debugging.
    const result = await super.forward(tabId, payload);
    if (plan && !plan.skip && this.emit) {
      this.lastProtocolPlan = { eventType: plan.eventType, proprietary: plan.proprietary?.command, standardCount: plan.standard?.length || 0, at: Date.now() };
    }
    return result;
  }

  async closeControlledAfterMaster(controlledIds = null, session = null) {
    const generation = session?.generation ?? this.syncGeneration;
    if (session && generation !== this.syncGeneration) return;
    const controlled = [...new Set((controlledIds || this.slaves.map((item) => item.id)).filter(Boolean))];
    this.stop({ invalidate: false });
    let remaining = controlled;
    for (let attempt = 0; attempt < 2 && remaining.length; attempt += 1) {
      if (session && generation !== this.syncGeneration) return;
      await Promise.allSettled(remaining.map((id) => this.engine.stop(id)));
      if (session && generation !== this.syncGeneration) return;
      const running = this.engine.running instanceof Map
        ? new Set(this.engine.running.keys())
        : new Set((this.engine.status?.() || []).filter((item) => item.running).map((item) => item.id));
      remaining = remaining.filter((id) => running.has(id));
      if (remaining.length && attempt === 0) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (remaining.length) this.emit({ type: 'sync-error', action: 'master-close', message: `从控环境停止未收敛：${remaining.join(', ')}` });
    this.emit({ type: 'master-closed', controlled, remaining });
  }

  scheduleMasterClose(controlledIds, session = null) {
    if (this.masterClosePromise) return this.masterClosePromise;
    const task = this.closeControlledAfterMaster(controlledIds, session).catch((error) => {
      this.emit({ type: 'sync-error', action: 'master-close', message: String(error?.message || error) });
    });
    this.masterClosePromise = task;
    this.masterCloseGeneration = session?.generation ?? null;
    task.finally(() => {
      // An older close task must never clear a newer session's close barrier.
      if (this.masterClosePromise === task) {
        this.masterClosePromise = null;
        this.masterCloseGeneration = null;
      }
    }).catch(() => {});
    return task;
  }

  stop(options = {}) {
    if (options.invalidate !== false) this.syncGeneration += 1;
    this.stopNativeInputMirror();
    this.unsubscribeMasterClose?.(); this.unsubscribeMasterClose = null;
    this.syncSession = null;
    this.tabMap?.clear(); this.desiredUrlMap?.clear(); this.geometryPending?.clear(); this.fullscreenByTab?.clear(); this.fullscreenSessions?.clear(); this.fullscreenActiveSessions?.clear(); this.mappingReady = false; this.activeMasterTab = null; this.geometryPausedUntil = 0; this.browserOwnedUntil = 0;
    for (const value of this.extensionConnections.values()) value.connection.close();
    this.extensionConnections.clear(); this.extensionMap.clear();
    super.stop();
  }

  async attach(tab) {
    const connection = new cdp.PersistentConnection(tab.webSocketDebuggerUrl, {
      onEvent: (event) => this.handle(tab.id, event),
    });
    await connection.open();
    const value = { tab, connection, scroll: { x: 0, y: 0 } };
    this.connections.set(tab.id, value);
    try {
      await connection.command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      await connection.command('Runtime.addBinding', { name: 'openBrowserSync' });
      await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: injection });
      await connection.command('Runtime.enable');
      await connection.command('Runtime.evaluate', { expression: injection });
      await connection.command('Page.enable');
      await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: masterMarker });
      await connection.command('Runtime.evaluate', { expression: masterMarker });
      const environment = environmentMarker(environmentNumber(this.engine, this.master.id), true);
      await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: environment });
      await connection.command('Runtime.evaluate', { expression: environment });
      await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: fullscreenInjection });
      await connection.command('Runtime.evaluate', { expression: fullscreenInjection });
      const position = await connection.command('Runtime.evaluate', { expression: '({x:scrollX,y:scrollY})', returnByValue: true }).catch(() => null);
      value.scroll = position?.result?.value || { x: 0, y: 0 };
    } catch (error) {
      connection.close(); this.connections.delete(tab.id); throw error;
    }
  }

  async configureFullscreenSession(tabId, sessionId, connection) {
    if (!sessionId || !connection) return;
    const sessions = this.fullscreenSessions.get(tabId) || new Set();
    if (sessions.has(sessionId)) return;
    sessions.add(sessionId); this.fullscreenSessions.set(tabId, sessions);
    const command = (method, params = {}) => connection.command(method, params, { sessionId, timeout: 10000 });
    await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    await command('Runtime.addBinding', { name: 'openBrowserSync' }).catch(() => {});
    await command('Page.addScriptToEvaluateOnNewDocument', { source: fullscreenInjection }).catch(() => {});
    await command('Runtime.enable').catch(() => {});
    await command('Page.enable').catch(() => {});
    await command('Runtime.evaluate', { expression: fullscreenInjection }).catch(() => {});
  }

  async handle(tabId, event) {
    const connection = this.connections.get(tabId)?.connection;
    if (event.method === 'Target.attachedToTarget') {
      this.configureFullscreenSession(tabId, event.params?.sessionId, connection).catch(() => {});
    }
    if (event.method === 'Target.detachedFromTarget') {
      const sessionId = event.params?.sessionId;
      const sessions = this.fullscreenSessions.get(tabId);
      sessions?.delete(sessionId);
      if (sessions && !sessions.size) this.fullscreenSessions.delete(tabId);
      const active = this.fullscreenActiveSessions.get(tabId);
      active?.delete(sessionId);
      if (active && !active.size) {
        this.fullscreenActiveSessions.delete(tabId);
        this.clearFullscreenState(tabId, 'oopif-detached');
      }
    }
    if (event.method === 'Page.frameNavigated') {
      this.fullscreenByTab.delete(tabId);
      this.fullscreenActiveSessions.delete(tabId);
    }
    if (event.method === 'Runtime.executionContextCreated') {
      const context = event.params?.context;
      const contextId = context?.id;
      if (contextId && connection) connection.command('Runtime.evaluate', { expression: fullscreenInjection, contextId }, event.sessionId ? { sessionId: event.sessionId } : {}).catch(() => {});
    }
    if (event.method === 'Runtime.bindingCalled' && event.params?.name === 'openBrowserSync') {
      let payload;
      try { payload = JSON.parse(event.params.payload); } catch (_) { return; }
      if (payload?.type === 'fullscreen') {
        if (payload.error) {
          const cleared = this.clearFullscreenState(tabId, 'fullscreen-error');
          this.emit({
            type: 'live-sync-fullscreen-error',
            masterTabId: tabId,
            message: String(payload.error),
            frameUrl: String(payload.frameUrl || ''),
            cleared,
          });
          return;
        }
        this.fullscreenByTab.set(tabId, payload.active === true);
        if (event.sessionId) {
          const active = this.fullscreenActiveSessions.get(tabId) || new Set();
          if (payload.active === true) active.add(event.sessionId);
          else active.delete(event.sessionId);
          if (active.size) this.fullscreenActiveSessions.set(tabId, active);
          else this.fullscreenActiveSessions.delete(tabId);
        }
        this.pauseGeometrySync(1800, 'fullscreen-transition');
      }
    }
    return super.handle(tabId, event);
  }

  pauseGeometrySync(durationMs = 1200, reason = 'interaction') {
    const duration = Math.max(0, Math.min(10000, Number(durationMs) || 0));
    this.geometryPausedUntil = Math.max(this.geometryPausedUntil || 0, Date.now() + duration);
    this.lastGeometryPauseReason = reason;
  }

  clearFullscreenState(tabId, reason = 'fullscreen-reset') {
    const cleared = this.fullscreenByTab.delete(tabId);
    // A rejected fullscreen request must not leave the geometry guard waiting
    // on a state transition that will never produce fullscreenchange.
    if (this.lastGeometryPauseReason === 'fullscreen-transition' || this.lastGeometryPauseReason === 'fullscreen-error') {
      const recoveryUntil = Date.now() + 250;
      this.geometryPausedUntil = this.geometryPausedUntil
        ? Math.min(this.geometryPausedUntil, recoveryUntil)
        : recoveryUntil;
      this.lastGeometryPauseReason = reason;
    }
    return cleared;
  }

  /**
   * Surface slaves whose debug port stopped answering, without spamming: a permanently
   * closed environment fails on every tick, so only report a given slave once per 10s.
   */
  reportUnreachableSlaves(failures) {
    const now = Date.now();
    if (!this._slaveErrorAt) this._slaveErrorAt = new Map();
    for (const failure of failures) {
      const last = this._slaveErrorAt.get(failure.id) || 0;
      if (now - last < 10000) continue;
      this._slaveErrorAt.set(failure.id, now);
      this.emit({
        type: 'sync-slave-unreachable',
        id: failure.id,
        message: failure.message,
      });
    }
    // Drop bookkeeping for slaves no longer in the session.
    const active = new Set(this.slaves.map((slave) => slave.id));
    for (const id of [...this._slaveErrorAt.keys()]) if (!active.has(id)) this._slaveErrorAt.delete(id);
  }

  async refreshMasterTabs(refreshGeneration = null) {
    if (!this.isRefreshGenerationCurrent(refreshGeneration) || !this.master) return;
    const tick = (this.tickCount || 0);
    // Heavy work (extension pages / geometry / zoom) only every N ticks to cut CDP load.
    const doHeavy = tick % 3 === 0;
    const allMasterTargets = await cdp.targets(this.master.item.port);
    if (!this.isRefreshGenerationCurrent(refreshGeneration)) return;
    const tabs = normalTabs(allMasterTargets.filter((target) => target.type === 'page'));
    const masterExtensionPages = doHeavy ? extensionPages(allMasterTargets) : null;
    const live = new Set(tabs.map((tab) => tab.id));

    for (const [id, value] of this.connections) {
      if (!live.has(id) || value.connection.socket?.readyState !== 1) {
        value.connection.close(); this.connections.delete(id);
        if (!live.has(id)) { await this.closeMappedTabs(id); this.tabMap.delete(id); this.fullscreenByTab.delete(id); }
      }
    }

    for (const id of [...this.tabMap.keys()]) if (!live.has(id)) { await this.closeMappedTabs(id); this.tabMap.delete(id); this.fullscreenByTab.delete(id); }
    this.masterTabs = tabs;
    const slaveLists = new Map(); const slaveExtensionLists = new Map();
    // Parallel slave target fetch (was sequential). Each slave is isolated: a closed or
    // hung environment throws ECONNREFUSED here, and letting that reject the batch would
    // abort the whole pass — which handleWatchError then reads as a dead debug port and
    // stops the entire session. One slave going away must not desync the others, so skip
    // it for this tick and keep going. Master death still propagates (fetched above).
    const failedSlaves = [];
    await Promise.all(this.slaves.map(async (slave) => {
      try {
        const targets = await cdp.targets(slave.port);
        slaveLists.set(slave.id, normalTabs(targets.filter((target) => target.type === 'page')));
        if (doHeavy) slaveExtensionLists.set(slave.id, extensionPages(targets));
      } catch (error) {
        failedSlaves.push({ id: slave.id, message: String(error?.message || error) });
      }
    }));
    if (!this.isRefreshGenerationCurrent(refreshGeneration)) return;
    if (failedSlaves.length) this.reportUnreachableSlaves(failedSlaves);
    for (let index = 0; index < tabs.length; index += 1) {
      if (!this.isRefreshGenerationCurrent(refreshGeneration)) return;
      await this.ensureMapping(tabs[index], index, slaveLists);
    }
    this.mappingReady = true;

    // Reconcile extras less often unless tab count changed.
    const tabCountChanged = !this._lastMasterTabCount || this._lastMasterTabCount !== tabs.length;
    this._lastMasterTabCount = tabs.length;
    if (doHeavy || tabCountChanged) await this.reconcileSlaveTabs(tabs, slaveLists);
    if (!this.isRefreshGenerationCurrent(refreshGeneration)) return;
    for (const tab of tabs) if (!this.connections.has(tab.id)) await this.attach(tab);
    if (doHeavy && masterExtensionPages) await this.refreshExtensionConnections(masterExtensionPages, slaveExtensionLists);
    if (!this.isRefreshGenerationCurrent(refreshGeneration)) return;
    await Promise.all([...this.connections.entries()].map(async ([id, value]) => {
      try { await this.pollTabState(value, { heavy: doHeavy }); }
      catch (error) {
        if (this.connections.get(id) !== value) return;
        value.connection.close(); this.connections.delete(id);
        this.emit({ type: 'live-sync-reattach', targetId: id, message: String(error?.message || error) });
      }
    }));
    if (doHeavy) await this.syncWindowGeometry().catch(() => {});
  }

  async refreshExtensionConnections(masterTargets, slaveLists) {
    const live = new Set(masterTargets.map((target) => target.id));
    for (const [id, value] of this.extensionConnections) {
      if (!live.has(id) || value.connection.socket?.readyState !== 1) {
        value.connection.close(); this.extensionConnections.delete(id);
        if (!live.has(id)) this.extensionMap.delete(id);
      }
    }
    for (const id of [...this.extensionMap.keys()]) if (!live.has(id)) this.extensionMap.delete(id);

    for (const masterTarget of masterTargets) {
      const mapping = this.extensionMap.get(masterTarget.id) || new Map();
      for (const slave of this.slaves) {
        const available = slaveLists.get(slave.id) || [];
        const current = mapping.get(slave.id);
        if (current && available.some((target) => target.id === current.id)) continue;
        if (current) mapping.delete(slave.id);
        const used = new Set([...this.extensionMap.values()].map((value) => value.get(slave.id)?.id).filter(Boolean));
        const candidates = available.filter((target) => !used.has(target.id));
        const exactKey = extensionPageKey(masterTarget); const host = extensionHost(masterTarget);
        const target = candidates.find((candidate) => extensionPageKey(candidate) === exactKey)
          || candidates.find((candidate) => extensionHost(candidate) === host);
        if (target) mapping.set(slave.id, target);
      }
      this.extensionMap.set(masterTarget.id, mapping);
      if (!this.extensionConnections.has(masterTarget.id)) {
        this.pauseGeometrySync(1200, 'extension-surface-attached');
        await this.attachExtensionPage(masterTarget);
      }
    }
  }

  async attachExtensionPage(tab) {
    const connection = new PersistentCdp(tab.webSocketDebuggerUrl, (event) => this.handleExtensionPage(tab.id, event));
    await connection.open();
    const value = { tab, connection }; this.extensionConnections.set(tab.id, value);
    try {
      await connection.command('Runtime.addBinding', { name: 'openBrowserSync' });
      await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: injection }).catch(() => {});
      await connection.command('Runtime.enable');
      await connection.command('Runtime.evaluate', { expression: injection });
      await connection.command('Page.enable').catch(() => {});
      this.emit({ type: 'live-sync-extension-attached', targetId: tab.id, url: tab.url, targets: this.extensionMap.get(tab.id)?.size || 0 });
    } catch (error) {
      connection.close(); this.extensionConnections.delete(tab.id); throw error;
    }
  }

  async handleExtensionPage(tabId, event) {
    if (event.method === 'Runtime.executionContextCreated') {
      const contextId = event.params?.context?.id; const connection = this.extensionConnections.get(tabId)?.connection;
      if (contextId && connection) connection.command('Runtime.evaluate', { expression: injection, contextId }).catch(() => {});
    }
    if (event.method === 'Runtime.bindingCalled' && event.params?.name === 'openBrowserSync') {
      let payload; try { payload = JSON.parse(event.params.payload); } catch (_) { return; }
      // V13: extension documents (including side-panel/OOPIF content) are authoritative for
      // semantic mouse, focus and text events. The native bridge remains responsible for Chrome UI.
      this.enqueueForward(tabId, payload);
    }
  }

  async ensureMapping(masterTab, index = -1, initialLists = null) {
    const mapping = this.tabMap.get(masterTab.id) || new Map();
    if (!this.desiredUrlMap) this.desiredUrlMap = new Map();
    const isStart = isEnvironmentStartUrl;
    const isBlank = (url) => /^(about:blank|chrome:\/\/(newtab|new-tab-page)\/?)/i.test(String(url || ''));
    const equivalent = (a, b) => this.urlsMatch(a, b) || (isStart(a) && isStart(b)) || (isBlank(a) && isBlank(b));
    await Promise.all(this.slaves.map(async (slave) => {
      const available = initialLists?.get(slave.id) || normalTabs(await cdp.tabs(slave.port));
      const mappedId = mapping.get(slave.id);
      const alreadyMapped = mappedId && available.some((tab) => tab.id === mappedId);
      let target = alreadyMapped ? available.find((tab) => tab.id === mappedId) : null;
      if (!alreadyMapped) {
        if (mappedId) mapping.delete(slave.id);
        const used = new Set([...this.tabMap.values()].map((value) => value.get(slave.id)).filter(Boolean));
        const candidates = available.filter((tab) => !used.has(tab.id));
        target = candidates.find((tab) => this.urlsMatch(tab.url, masterTab.url))
          || (isStart(masterTab.url) ? candidates.find((tab) => isStart(tab.url)) : null)
          || (isBlank(masterTab.url) ? candidates.find((tab) => isBlank(tab.url)) : null);
        if (!target && index >= 0 && available[index] && !used.has(available[index].id)) target = available[index];
        if (!target && candidates.length) target = candidates.find((tab) => isBlank(tab.url)) || candidates[candidates.length - 1];
      }
      const desiredUrl = isStart(masterTab.url) ? (environmentStartUrl(this.engine, slave.id) || masterTab.url) : masterTab.url;
      if (!target) target = await cdp.newTab(slave.port, desiredUrl || 'about:blank');
      mapping.set(slave.id, target.id);
      if (!alreadyMapped) await this.markSlave(target, slave.id);
      // Only navigate when the *master* desired URL changed. Re-driving navigation every tick
      // (e.g. after a redirect) causes continuous slave reloads.
      const desireKey = `${masterTab.id}:${slave.id}`;
      const previousDesired = this.desiredUrlMap.get(desireKey);
      const masterDesiredChanged = previousDesired !== this.urlKey(desiredUrl);
      const needsNavigation = desiredUrl && !equivalent(target.url, desiredUrl) && (masterDesiredChanged || !alreadyMapped);
      if (needsNavigation) {
        await cdp.call(target.webSocketDebuggerUrl, 'Page.navigate', { url: desiredUrl }).catch(() => {});
        this.desiredUrlMap.set(desireKey, this.urlKey(desiredUrl));
      } else if (desiredUrl) {
        this.desiredUrlMap.set(desireKey, this.urlKey(desiredUrl));
      }
    }));
    this.tabMap.set(masterTab.id, mapping);
  }

  async reconcileSlaveTabs(masterTabs, knownLists = null) {
    if (!masterTabs.length) return;
    let closed = 0;
    await Promise.all(this.slaves.map(async (slave) => {
      const allowed = new Set(masterTabs.map((tab) => this.tabMap.get(tab.id)?.get(slave.id)).filter(Boolean));
      const current = knownLists?.get(slave.id) || normalTabs(await cdp.tabs(slave.port));
      const extras = current.filter((tab) => !allowed.has(tab.id));
      for (const tab of extras) { await cdp.closeTab(slave.port, tab.id).catch(() => {}); closed += 1; }
    }));
    if (closed) this.emit({ type: 'live-sync-tab-reconcile', masterTabs: masterTabs.length, closed });
  }

  async markSlave(tab, id) { const source = environmentMarker(environmentNumber(this.engine, id), false); await cdp.call(tab.webSocketDebuggerUrl, 'Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => {}); await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: source }).catch(() => {}); }

  async closeMappedTabs(masterTabId) {
    const mapping = this.tabMap.get(masterTabId); if (!mapping) return;
    await Promise.all(this.slaves.map((slave) => { const targetId = mapping.get(slave.id); return targetId ? cdp.closeTab(slave.port, targetId).catch(() => {}) : Promise.resolve(); }));
  }

  async slaveTab(slave, masterTabId) {
    const masterTab = this.masterTabs.find((tab) => tab.id === masterTabId);
    if (!this.tabMap.has(masterTabId)) await this.ensureMapping(masterTab || { id: masterTabId, url: 'about:blank' });
    const mapping = this.tabMap.get(masterTabId); let targetId = mapping?.get(slave.id);
    let tabs = await cdp.tabs(slave.port); let tab = tabs.find((item) => item.id === targetId);
    if (!tab) {
      const desiredUrl = isEnvironmentStartUrl(masterTab?.url) ? (environmentStartUrl(this.engine, slave.id) || masterTab.url) : masterTab?.url;
      tab = await cdp.newTab(slave.port, desiredUrl || 'about:blank'); targetId = tab.id;
      if (!mapping) this.tabMap.set(masterTabId, new Map([[slave.id, targetId]])); else mapping.set(slave.id, targetId);
    }
    return tab;
  }

  async navigateSlaves(masterTabId, url) {
    if (!isEnvironmentStartUrl(url)) return super.navigateSlaves(masterTabId, url);
    await this.eachSlave(masterTabId, async (tab, slave) => {
      const desiredUrl = environmentStartUrl(this.engine, slave.id) || url;
      if (this.urlsMatch(tab.url, desiredUrl)) return;
      await cdp.call(tab.webSocketDebuggerUrl, 'Page.navigate', { url: desiredUrl }).catch(() => {});
    });
  }

  async eachSlave(masterTabId, action) {
    const extensionTargets = this.extensionMap.get(masterTabId);
    if (extensionTargets) {
      await Promise.all(this.slaves.map(async (slave) => { const target = extensionTargets.get(slave.id); if (target) await action(target, slave); }));
      return;
    }
    await Promise.all(this.slaves.map(async (slave) => { const tab = await this.slaveTab(slave, masterTabId); if (tab) await action(tab, slave); }));
  }

  async activateMapped(masterTabId) {
    // Target.activateTarget dismisses native menus/pickers. Keep activation out of
    // the way while browser chrome, DevTools, extension popups, or a page picker
    // owns the foreground.
    if (this.nativePopupActive || this.nativeDevToolsMode
      || await this.hasVisibleExtensionSurface()
      || await this.hasBrowserOwnedInteraction()) {
      this.emit({ type: 'live-sync-tab', masterTabId, targets: this.slaves.length, native: true });
      return;
    }
    await Promise.all(this.slaves.map(async (slave) => { const tab = await this.slaveTab(slave, masterTabId); if (tab) await cdp.activateTab(slave.port, tab.id); }));
    this.emit({ type: 'live-sync-tab', masterTabId, targets: this.slaves.length });
  }

  async syncZoom(masterTabId, factor) {
    let corrected = 0;
    const masterTab = this.masterTabs.find((tab) => tab.id === masterTabId);
    const isStartPage = (v) => {
      const s = String(v || '').toLowerCase();
      return s.includes('openbrowser-start.html')
        || s.includes('openbrowser-start')
        || s.includes('openbrowser-native')
        || /https?:\/\/127\.0\.0\.1:5032[6-9]\/?/.test(s);
    };
    const equivalentUrl = (a, b) => {
      const x = String(a || '').toLowerCase().replace(/\/$/, '');
      const y = String(b || '').toLowerCase().replace(/\/$/, '');
      const newTab = (v) => v === 'chrome://newtab' || v === 'chrome://new-tab-page';
      return x === y || (newTab(x) && newTab(y)) || (isStartPage(x) && isStartPage(y));
    };
    await Promise.all(this.slaves.map(async (slave) => {
      const mapped = await this.slaveTab(slave, masterTabId);
      const candidates = normalTabs(await cdp.tabs(slave.port));
      const targets = new Map();
      if (mapped) targets.set(mapped.id, mapped);
      if (masterTab) for (const tab of candidates) if (equivalentUrl(tab.url, masterTab.url)) targets.set(tab.id, tab);
      for (const tab of targets.values()) {
        try {
        const metrics = await cdp.call(tab.webSocketDebuggerUrl, 'Page.getLayoutMetrics');
        const viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
        const browserZoom = Number(viewport.zoom) || 1;
        const currentScale = Number(viewport.scale) || 1;
        const effective = browserZoom * currentScale;
        if (Math.abs(effective - factor) <= 0.01) continue;
        const correctedScale = Math.max(0.25, Math.min(5, factor / browserZoom));
        await cdp.call(tab.webSocketDebuggerUrl, 'Emulation.setPageScaleFactor', { pageScaleFactor: correctedScale });
        corrected += 1;
        } catch (_) {}
      }
    }));
    if (corrected) this.emit({ type: 'live-sync-zoom', masterTabId, factor, corrected });
  }

  async evaluateFullscreen(tab, payload, expression, slavePort = null, diagnostics = []) {
    const base = {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    };
    const frameDepth = Number(payload?.frameDepth);
    const frameRequested = Boolean(payload?.framePath || payload?.frameName)
      || frameDepth > 0
      || (payload?.frameDepth === undefined && Boolean(payload?.frameUrl));
    if (!frameRequested) return cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', base, 10000);

    // Site-isolated iframe targets are not always present in Page.getFrameTree
    // on the page session. When the slave port is available, route directly to
    // the matching iframe target before falling back to same-process frames.
    if (slavePort) {
      try {
        const requestedUrl = frameUrlKey(payload.frameUrl);
        const targets = await cdp.targets(slavePort);
        const candidates = targets.filter((item) => String(item.type || '') === 'iframe');
        const target = candidates.find((item) => requestedUrl && frameUrlKey(item.url) === requestedUrl)
          || candidates.find((item) => requestedUrl && frameUrlKey(item.url).split('?')[0] === requestedUrl.split('?')[0])
          || (!requestedUrl && !payload.framePath && !payload.frameName && Number(payload.frameDepth) <= 0 && candidates.length === 1 ? candidates[0] : null);
        if (target?.webSocketDebuggerUrl) {
          try {
            return await cdp.call(target.webSocketDebuggerUrl, 'Runtime.evaluate', base, 10000);
          } catch (error) {
            diagnostics.push({
              stage: 'oopif-runtime-evaluate',
              severity: 'error',
              message: String(error?.message || error),
              targetId: String(target.id || ''),
              targetUrl: String(target.url || ''),
              fallback: 'none',
            });
            throw error;
          }
        }
        if (candidates.length) {
          diagnostics.push({
            stage: 'oopif-target-mismatch',
            severity: 'warning',
            message: `No OOPIF target matched frame URL ${String(payload.frameUrl || '(unknown)')}`,
            targetCount: candidates.length,
            fallback: 'same-process-frame-tree',
          });
        }
      } catch (error) {
        if (diagnostics.some((item) => item.stage === 'oopif-runtime-evaluate')) throw error;
        if (!diagnostics.some((item) => item.stage === 'oopif-target-discovery')) {
          diagnostics.push({
            stage: 'oopif-target-discovery',
            severity: 'warning',
            message: String(error?.message || error),
            fallback: 'same-process-frame-tree',
          });
        }
      }
    }

    let frame = null;
    try {
      const tree = await cdp.call(tab.webSocketDebuggerUrl, 'Page.getFrameTree', {}, 10000);
      frame = chooseFullscreenFrame(tree, payload);
    } catch (error) {
      diagnostics.push({
        stage: 'frame-tree-discovery',
        severity: 'warning',
        message: String(error?.message || error),
        fallback: 'top-document',
      });
    }
    if (!frame || !frame.parentId) {
      const error = new Error('Fullscreen target frame could not be resolved');
      diagnostics.push({ stage: 'frame-target-not-found', severity: 'error', message: error.message, fallback: 'none' });
      throw error;
    }

    // Runtime.evaluate without a contextId always runs in the top document. An
    // isolated world gives iframe/OOPIF content its own document while retaining
    // the userGesture flag required by the Fullscreen API.
    try {
      const world = await cdp.call(tab.webSocketDebuggerUrl, 'Page.createIsolatedWorld', {
        frameId: frame.id,
        worldName: 'openbrowser-fullscreen-sync-v5',
      }, 10000);
      if (world?.executionContextId) {
        try {
          return await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { ...base, contextId: world.executionContextId }, 10000);
        } catch (error) {
          diagnostics.push({
            stage: 'frame-runtime-evaluate',
            severity: 'error',
            message: String(error?.message || error),
            frameId: String(frame.id || ''),
            fallback: 'none',
          });
          throw error;
        }
      }
    } catch (error) {
      if (diagnostics.some((item) => item.stage === 'frame-runtime-evaluate')) throw error;
      diagnostics.push({
        stage: 'frame-isolated-world',
        severity: 'warning',
        message: String(error?.message || error),
        frameId: String(frame.id || ''),
        fallback: 'none',
      });
    }
    const error = new Error('Fullscreen frame runtime is unavailable');
    diagnostics.push({ stage: 'frame-runtime-unavailable', severity: 'error', message: error.message, frameId: String(frame.id || ''), fallback: 'none' });
    throw error;
  }

  async syncFullscreen(masterTabId, payload) {
    const desired = payload?.active === true;
    const expression = fullscreenExpression(payload);
    this.pauseGeometrySync(1800, 'fullscreen-transition');
    let applied = 0;
    let failed = 0;
    await this.eachSlave(masterTabId, async (tab, slave) => {
      const diagnostics = [];
      try {
        const result = await this.evaluateFullscreen(tab, payload, expression, slave?.port, diagnostics);
        const state = result.result?.value;
        if (state && Boolean(state.active) === desired) applied += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        if (!diagnostics.length) diagnostics.push({ stage: 'fullscreen-evaluate', severity: 'error', message: String(error?.message || error), fallback: 'none' });
      }
      for (const diagnostic of diagnostics) this.emit({
        type: 'live-sync-fullscreen-route-error',
        masterTabId,
        slaveId: String(slave?.id || ''),
        tabId: String(tab?.id || ''),
        frameUrl: String(payload?.frameUrl || ''),
        frameDepth: Number.isInteger(payload?.frameDepth) ? payload.frameDepth : null,
        ...diagnostic,
      });
    });
    this.markActivity?.();
    this.emit({ type: 'live-sync-fullscreen', masterTabId, active: desired, applied, failed });
    return { active: desired, applied, failed };
  }

  async syncWindowGeometry() {
    // Mirror only size (for coordinate mapping), never left/top — so tile/cascade layouts stay put.
    const now = Date.now();
    if (!this.master || now - this.lastWindowSync < 2800 || now < (this.geometryPausedUntil || 0)) return;
    // The native bridge owns Windows-only UI input, while CDP still owns the
    // browser viewport. Pause only during bridge startup; if the bridge is
    // down, keep geometry healing so a failed helper cannot leave blank space.
    if (process.platform === 'win32' && this.nativeBridgeState === 'starting') {
      this.pauseGeometrySync(900, 'native-bridge');
      return;
    }
    if (now < (this.browserOwnedUntil || 0)) {
      this.pauseGeometrySync(900, 'browser-owned-grace');
      return;
    }
    if (this.nativePopupActive || [...this.fullscreenByTab.values()].some(Boolean)) {
      this.pauseGeometrySync(900, this.nativePopupActive ? 'native-popup' : 'fullscreen-active');
      return;
    }
    if (await this.hasVisibleExtensionSurface()) {
      this.pauseGeometrySync(900, 'extension-popup');
      return;
    }
    if (await this.hasBrowserOwnedInteraction()) {
      this.pauseGeometrySync(900, 'browser-owned-interaction');
      return;
    }

    const source = await cdp.windowForPort(this.master.item.port);
    const bounds = source.bounds || {};
    if (bounds.windowState && bounds.windowState !== 'normal') {
      this.pauseGeometrySync(900, 'master-window-state');
      return;
    }
    if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return;
    const targetWidth = Math.round(bounds.width);
    const targetHeight = Math.round(bounds.height);
    this.lastWindowSync = now;
    await Promise.all(this.slaves.map(async (slave) => {
      const current = await cdp.windowForPort(slave.port); const own = current.bounds || {};
      if (own.windowState && own.windowState !== 'normal') return;
      if (Math.abs((own.width || 0) - targetWidth) < 8 && Math.abs((own.height || 0) - targetHeight) < 8) {
        this.geometryPending.delete(slave.id);
        return;
      }
      const pending = this.geometryPending.get(slave.id);
      const desired = { width: targetWidth, height: targetHeight };
      if (pending?.width === targetWidth && pending?.height === targetHeight && (pending.attempts || 0) >= 2 && now - (pending.at || 0) < 10000) return;
      await cdp.setWindowBounds(slave.port, {
        left: Number.isFinite(own.left) ? own.left : 0,
        top: Number.isFinite(own.top) ? own.top : 0,
        ...desired,
      }, { forceNormal: false });
      // Chromium builds occasionally acknowledge setWindowBounds before the
      // native widget has applied it. Remember the desired size so the next
      // quiet tick can retry once, fixing the large blank viewport symptom
      // without issuing a second resize while a menu/picker is open.
      this.geometryPending.set(slave.id, {
        ...desired,
        attempts: pending?.width === targetWidth && pending?.height === targetHeight ? (pending.attempts || 0) + 1 : 1,
        at: now,
      });
    }));
  }

  async hasBrowserOwnedInteraction() {
    const value = this.connections.get(this.activeMasterTab)
      || [...this.connections.values()].find((item) => item?.tab?.id === this.activeMasterTab)
      || [...this.connections.values()][0];
    if (!value?.connection?.command) return false;
    try {
      const result = await value.connection.command('Runtime.evaluate', {
        expression: "(() => { const e = document.activeElement; const tag = String(e?.tagName || '').toLowerCase(); const type = String(e?.type || '').toLowerCase(); const picker = tag === 'select' || (tag === 'input' && /^(date|datetime-local|month|time|week|color|file)$/.test(type)); return { focused: typeof document.hasFocus === 'function' ? document.hasFocus() : true, picker }; })()",
        returnByValue: true,
      });
      const state = result.result?.value || {};
      return state.focused === false
        || (state.picker === true
          && ((process.platform === 'win32' && this.nativePopupActive)
            || Date.now() < (this.browserOwnedUntil || 0)));
    } catch (_) {
      // A page target that is changing focus/navigation is exactly when a
      // top-level resize is most likely to dismiss browser-owned UI.
      return true;
    }
  }

  async hasVisibleExtensionSurface() {
    const values = [...this.extensionConnections.values()];
    if (!values.length) return false;
    const states = await Promise.all(values.map(async (value) => {
      try {
        const result = await value.connection.command('Runtime.evaluate', {
          expression: "({visible:document.visibilityState==='visible',focused:typeof document.hasFocus==='function'&&document.hasFocus()})",
          returnByValue: true,
        });
        const state = result.result?.value || {};
        return state.visible === true || state.focused === true;
      } catch (_) {
        // A target that cannot be queried may be in the middle of opening or
        // closing. Suppress one geometry pass rather than risking a popup tear.
        return true;
      }
    }));
    return states.some(Boolean);
  }

  async pollTabState(value, options = {}) {
    const heavy = options.heavy !== false;
    const result = await value.connection.command('Runtime.evaluate', { expression: "({x:scrollX,y:scrollY,visible:document.visibilityState==='visible',url:location.href})", returnByValue: true });
    const state = result.result?.value; if (!state) return;
    // LayoutMetrics + zoom sync only on heavy ticks (zoom rarely changes mid-session).
    if (heavy) {
      try {
        const metrics = await value.connection.command('Page.getLayoutMetrics');
        const viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
        const zoom = (Number(viewport.scale) || 1) * (Number(viewport.zoom) || 1);
        if (!value.zoom || Math.abs((value.zoom || 1) - zoom) > 0.01) {
          value.zoom = zoom;
          await this.syncZoom(value.tab.id, zoom);
        } else {
          value.zoom = zoom;
        }
      } catch (_) {}
    }
    if (state.visible) {
      // Drive navigation only when the master URL actually changed.
      const urlKey = this.urlKey(state.url);
      if (state.url && !/^(chrome|edge|devtools|chrome-extension|edge-extension):/i.test(state.url) && value.lastSyncedUrl !== urlKey) {
        value.lastSyncedUrl = urlKey;
        this.markActivity?.();
        await this.navigateSlaves(value.tab.id, state.url);
      }
      if (this.activeMasterTab !== value.tab.id) { this.activeMasterTab = value.tab.id; await this.activateMapped(value.tab.id); }
    }
    if (state.x !== value.scroll.x || state.y !== value.scroll.y) {
      value.scroll = { x: state.x, y: state.y };
      this.markActivity?.();
      await this.forward(value.tab.id, { type: 'scroll', x: state.x, y: state.y });
    }
  }
}

module.exports = { LiveSyncController, __test: { fullscreenInjection, fullscreenExpression } };
