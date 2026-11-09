'use strict';

/**
 * OpenBrowser CookieRobot - Account Warm-up Automation Engine
 *
 * Implements automated human-like random walk across target domains to accumulate
 * authentic session cookies, browsing history, and cache.
 *
 * Design constraints:
 * - Fail-closed: Never issues direct network requests from Node.js. All navigations,
 *   queries, and interactions run strictly through the browser CDP session,
 *   honoring the profile's proxy and network isolation.
 * - Human-like pacing: Uses Bezier mouse curves, randomized scroll bursts,
 *   probabilistic link exploration, and jittered dwell intervals.
 * - Resilient: Site-level retries and skips without failing the entire run.
 * - Audit artifacts: Appends visit logs to JSONL (domain, timestamp, pages, cookie delta).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cdp = require('../cdp');

/** Default configuration parameters */
const DEFAULT_CONFIG = Object.freeze({
  domains: ['example.com', 'wikipedia.org'],
  stayDurationMin: 5,
  stayDurationMax: 15,
  walkDepth: 2,
  scrollProbability: 0.8,
  clickProbability: 0.7,
  maxRetries: 1,
  navigationTimeoutMs: 20000,
});

/**
 * Normalizes input domain string into a clean target URL.
 * Honors explicit http/https schemes and localhost/loopback addresses.
 */
function normalizeTargetUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return { url: parsed.href, domain: parsed.hostname };
    } catch (_) {
      return null;
    }
  }
  // Hostname or host:port or host:port/path
  const isLoopback = /^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(trimmed);
  const scheme = isLoopback ? 'http://' : 'https://';
  try {
    const parsed = new URL(`${scheme}${trimmed}`);
    return { url: parsed.href, domain: parsed.hostname };
  } catch (_) {
    return null;
  }
}

/**
 * Parses and normalizes user configuration into validated types and bounds.
 */
function normalizeRobotConfig(raw = {}, context = {}) {
  const rawProfileId = raw.profileId !== undefined ? raw.profileId : context?.profileId;
  if (rawProfileId !== undefined && rawProfileId !== null && rawProfileId !== '') {
    const strPid = String(rawProfileId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(strPid)) {
      throw new Error(`Invalid profile id: ${strPid}`);
    }
  }

  const profileRoot = raw.profileRoot || context?.profileRoot || context?.root || null;
  let recordFile = null;
  if (raw.recordFile) {
    const rawRecordStr = String(raw.recordFile);
    if (profileRoot) {
      const safeRoot = path.resolve(profileRoot);
      const resolvedRecord = path.resolve(safeRoot, rawRecordStr);
      const rel = path.relative(safeRoot, resolvedRecord);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('recordFile must be located within profileRoot');
      }
      recordFile = resolvedRecord;
    } else {
      if (rawRecordStr.includes('..')) {
        throw new Error('Path traversal detected in recordFile');
      }
      recordFile = path.resolve(rawRecordStr);
    }
  }

  let domains = [];
  if (Array.isArray(raw.domains)) {
    domains = raw.domains;
  } else if (typeof raw.domains === 'string') {
    domains = raw.domains.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (!domains.length && raw.urls) {
    if (Array.isArray(raw.urls)) domains = raw.urls;
    else if (typeof raw.urls === 'string') domains = raw.urls.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (!domains.length) {
    domains = [...DEFAULT_CONFIG.domains];
  }

  const parseNum = (v, fallback, min = -Infinity, max = Infinity) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };

  const stayMin = parseNum(raw.stayDurationMin ?? raw.stayMin, DEFAULT_CONFIG.stayDurationMin, 0.1);
  const stayMax = parseNum(raw.stayDurationMax ?? raw.stayMax, Math.max(stayMin, DEFAULT_CONFIG.stayDurationMax), stayMin);

  const walkDepth = Math.round(parseNum(raw.walkDepth, DEFAULT_CONFIG.walkDepth, 1, 10));
  const scrollProb = parseNum(raw.scrollProbability ?? raw.scrollProb, DEFAULT_CONFIG.scrollProbability, 0, 1);
  const clickProb = parseNum(raw.clickProbability ?? raw.clickProb, DEFAULT_CONFIG.clickProbability, 0, 1);
  const maxRetries = Math.round(parseNum(raw.maxRetries, DEFAULT_CONFIG.maxRetries, 0, 5));
  const navTimeout = Math.round(parseNum(raw.navigationTimeoutMs, DEFAULT_CONFIG.navigationTimeoutMs, 3000, 60000));

  return {
    domains,
    stayDurationMin: stayMin,
    stayDurationMax: stayMax,
    walkDepth,
    scrollProbability: scrollProb,
    clickProbability: clickProb,
    maxRetries,
    navigationTimeoutMs: navTimeout,
    recordFile,
    profileId: rawProfileId ? String(rawProfileId) : null,
    profileRoot: profileRoot ? path.resolve(profileRoot) : null,
  };
}

/**
 * Pure function: Generates a planned random-walk execution sequence from configuration.
 * Fully deterministic given seed/mock inputs for unit test verification.
 */
function generateWalkPlan(rawConfig = {}, options = {}) {
  const config = normalizeRobotConfig(rawConfig);
  const random = typeof options.random === 'function' ? options.random : Math.random;

  const sites = [];
  for (let i = 0; i < config.domains.length; i += 1) {
    const raw = config.domains[i];
    const target = normalizeTargetUrl(raw);
    if (!target) continue;

    // Sample stay duration uniformly in [stayDurationMin, stayDurationMax]
    const stayDelta = config.stayDurationMax - config.stayDurationMin;
    const stayDurationSec = Math.round((config.stayDurationMin + random() * stayDelta) * 10) / 10;

    sites.push({
      index: sites.length + 1,
      rawDomain: raw,
      domain: target.domain,
      url: target.url,
      stayDurationSec,
      walkDepth: config.walkDepth,
      scrollProbability: config.scrollProbability,
      clickProbability: config.clickProbability,
      maxRetries: config.maxRetries,
    });
  }

  const totalEstimatedDurationSec = sites.reduce((sum, site) => sum + site.stayDurationSec, 0);

  return {
    config,
    sites,
    totalSites: sites.length,
    totalEstimatedDurationSec,
  };
}

/**
 * Cubic Bezier point calculation:
 * B(t) = (1-t)^3 * P0 + 3*(1-t)^2 * t * P1 + 3*(1-t) * t^2 * P2 + t^3 * P3
 */
function bezierPoint(t, p0, p1, p2, p3) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return uuu * p0 + 3 * uu * t * p1 + 3 * u * tt * p2 + ttt * p3;
}

/**
 * Generates human-like curved mouse trajectory points between two coordinates.
 */
function generateMouseTrajectory(fromX, fromY, toX, toY, options = {}) {
  const steps = Math.max(5, Math.min(30, Math.round(Number(options.steps) || 12)));
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.hypot(dx, dy);

  if (distance < 5) {
    return [{ x: Math.round(toX), y: Math.round(toY) }];
  }

  // Perpendicular perturbation for natural hand curvature
  const deviation = Math.min(100, Math.max(15, distance * 0.25));
  const sign = Math.random() < 0.5 ? -1 : 1;
  const perpX = -dy / distance * deviation * sign;
  const perpY = dx / distance * deviation * sign;

  // Two control points with pseudo-random deviation
  const c1x = fromX + dx * 0.25 + perpX * (0.8 + Math.random() * 0.4);
  const c1y = fromY + dy * 0.25 + perpY * (0.8 + Math.random() * 0.4);
  const c2x = fromX + dx * 0.75 + perpX * (0.3 + Math.random() * 0.4);
  const c2y = fromY + dy * 0.75 + perpY * (0.3 + Math.random() * 0.4);

  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    // Ease-in-out easing parameter
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const px = bezierPoint(ease, fromX, c1x, c2x, toX);
    const py = bezierPoint(ease, fromY, c1y, c2y, toY);
    // Micro-jitter: 0.5 - 1.5px
    const jitterX = (Math.random() - 0.5) * 1.5;
    const jitterY = (Math.random() - 0.5) * 1.5;
    points.push({
      x: Math.round(px + jitterX),
      y: Math.round(py + jitterY),
    });
  }
  return points;
}

/** Sleep with abort-checking */
function cancellableSleep(ms, isAborted) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const interval = Math.min(100, ms);
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += interval;
      if (isAborted() || elapsed >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, interval);
  });
}

/**
 * CookieRobot runner for a managed browser environment.
 */
class CookieRobot {
  constructor(options = {}) {
    this.port = Number(options.port) || 0;
    this.profileId = String(options.profileId || options.profile?.id || '');
    if (this.profileId && !/^[A-Za-z0-9_-]{1,64}$/.test(this.profileId)) {
      throw new Error(`Invalid profile id: ${this.profileId}`);
    }
    this.profile = options.profile || null;
    this.profileRoot = options.root || options.profileRoot || null;
    this.browserConnection = options.cdpConnection || null;
    this.emitFn = typeof options.emit === 'function' ? options.emit : (() => {});
    this.config = normalizeRobotConfig(options.config || {}, {
      profileRoot: this.profileRoot,
      profileId: this.profileId,
    });

    // Default record file: strictly inside profileRoot if provided
    this.recordFile = this.config.recordFile || (this.profileRoot
      ? path.join(path.resolve(this.profileRoot), 'cookie-robot-history.jsonl')
      : path.join(os.tmpdir(), `cookie-robot-${this.profileId || 'session'}.jsonl`));

    this.aborted = false;
    this.running = false;
    this.pageConnection = null;
    this.activeTabId = null;
    this.ownedTabIds = new Set();
    this._currentNavStopReject = null;
    this._runPromise = null;
    this._cleaningUpTabs = null;
    this.pageEventListeners = new Map();
    this.records = [];
    this.currentStep = 0;
    this.totalSteps = 0;
    this.currentDomain = '';
    this.mouseX = 300;
    this.mouseY = 300;
    this.totalCookiesAccumulated = 0;
    this.totalPagesVisited = 0;
  }

  handlePageDisconnect(err) {
    if (this.pageConnection) {
      try { this.pageConnection.close(); } catch (_) {}
      this.pageConnection = null;
    }
    if (this._currentNavStopReject) {
      try { this._currentNavStopReject(err || new Error('Page connection disconnected')); } catch (_) {}
      this._currentNavStopReject = null;
    }
    this.aborted = true;
    this.emit('robot-disconnected', {
      profileId: this.profileId,
      error: err?.message || 'Page connection disconnected',
    });
  }

  handlePageEvent(event) {
    if (!event?.method) return;
    const listeners = this.pageEventListeners.get(event.method);
    if (listeners && listeners.size) {
      for (const fn of listeners) {
        try { fn(event.params || {}); } catch (_) {}
      }
    }
  }

  oncePageEvent(method, callback) {
    if (!this.pageEventListeners.has(method)) {
      this.pageEventListeners.set(method, new Set());
    }
    const set = this.pageEventListeners.get(method);
    const wrapper = (params) => {
      set.delete(wrapper);
      callback(params);
    };
    set.add(wrapper);
    return () => set.delete(wrapper);
  }

  emit(type, payload = {}) {
    const data = {
      type,
      id: this.profileId,
      profileId: this.profileId,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    try {
      this.emitFn(data);
    } catch (_) {}
  }

  isRunning() {
    return this.running;
  }

  getStatus() {
    return {
      running: this.running,
      aborted: this.aborted,
      profileId: this.profileId,
      currentStep: this.currentStep,
      totalSteps: this.totalSteps,
      currentDomain: this.currentDomain,
      totalPagesVisited: this.totalPagesVisited,
      totalCookies: this.totalCookiesAccumulated,
      recordFile: this.recordFile,
    };
  }

  getRecords() {
    if (this.records.length) return [...this.records];
    if (fs.existsSync(this.recordFile)) {
      try {
        const lines = fs.readFileSync(this.recordFile, 'utf8').trim().split('\n').filter(Boolean);
        return lines.map((l) => JSON.parse(l));
      } catch (_) {}
    }
    return [];
  }

  async stop() {
    this.aborted = true;
    if (this._currentNavStopReject) {
      try { this._currentNavStopReject(new Error('CookieRobot stopped')); } catch (_) {}
      this._currentNavStopReject = null;
    }
    if (this.pageConnection) {
      try { this.pageConnection.close(); } catch (_) {}
      this.pageConnection = null;
    }
    if (this._runPromise) {
      try { await this._runPromise; } catch (_) {}
    }
    await this.cleanupOwnedTabs();
  }

  /**
   * Reads total cookies count from the browser via CDP.
   * Tries Storage.getCookies on browser connection first, then Network.getCookies on page.
   */
  async readCookiesCount() {
    if (this.browserConnection?.command) {
      try {
        const res = await this.browserConnection.command('Storage.getCookies', {}, { timeout: 4000 });
        if (Array.isArray(res?.cookies)) return res.cookies.length;
      } catch (_) {}
    }
    if (this.pageConnection?.command) {
      try {
        const res = await this.pageConnection.command('Network.getCookies', {}, { timeout: 4000 });
        if (Array.isArray(res?.cookies)) return res.cookies.length;
      } catch (_) {}
    }
    return 0;
  }

  /**
   * Acquires or creates a CDP PersistentConnection to a dedicated page tab.
   * Never hijacks user existing tabs.
   */
  async acquirePageSession() {
    if (this.pageConnection && !this.pageConnection.closed) {
      return this.pageConnection;
    }
    // Create a dedicated tab for CookieRobot isolation
    const tab = await cdp.newTab(this.port, 'about:blank');
    if (!tab || !tab.id || !tab.webSocketDebuggerUrl) {
      throw new Error(`Failed to create dedicated browser tab on CDP port ${this.port}`);
    }
    this.activeTabId = tab.id;
    this.ownedTabIds.add(tab.id);

    if (this.aborted) {
      throw new Error('CookieRobot stopped');
    }

    const connection = await cdp.connect(tab.webSocketDebuggerUrl, {
      timeout: 8000,
      onEvent: (event) => this.handlePageEvent(event),
      onDisconnect: (err) => this.handlePageDisconnect(err),
    });
    this.pageConnection = connection;

    try {
      await connection.command('Page.enable', {}, { timeout: 3000 });
      await connection.command('Network.enable', {}, { timeout: 3000 });
      await connection.command('DOM.enable', {}, { timeout: 3000 });
    } catch (_) {}

    return connection;
  }

  /**
   * Ensures document has reached interactive or complete readyState.
   */
  async ensureDomReady(maxWaitMs = 3000) {
    if (this.aborted || !this.pageConnection) return;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs && !this.aborted) {
      try {
        const res = await this.pageConnection.command('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        }, { timeout: 1000 });
        const state = res?.result?.value;
        if (state === 'complete' || state === 'interactive') break;
      } catch (_) {
        break;
      }
      await cancellableSleep(100, () => this.aborted);
    }
  }

  /**
   * Executes smooth human mouse movement to (toX, toY).
   */
  async moveMouseSmoothly(toX, toY) {
    if (this.aborted || !this.pageConnection) return;
    const trajectory = generateMouseTrajectory(this.mouseX, this.mouseY, toX, toY);
    for (const pt of trajectory) {
      if (this.aborted) break;
      this.mouseX = pt.x;
      this.mouseY = pt.y;
      try {
        await this.pageConnection.command('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: pt.x,
          y: pt.y,
        }, { timeout: 1000 });
      } catch (_) {}
      await cancellableSleep(15 + Math.floor(Math.random() * 20), () => this.aborted);
    }
  }

  /**
   * Performs realistic wheel scrolling on the active page.
   */
  async performHumanScroll() {
    if (this.aborted || !this.pageConnection) return;
    // Scroll 2 to 5 bursts
    const bursts = 2 + Math.floor(Math.random() * 4);
    for (let b = 0; b < bursts; b += 1) {
      if (this.aborted) break;
      const down = Math.random() > 0.15; // 85% chance scroll down, 15% roll back
      const deltaY = (down ? 1 : -1) * (100 + Math.floor(Math.random() * 250));
      try {
        await this.pageConnection.command('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: this.mouseX,
          y: this.mouseY,
          deltaX: 0,
          deltaY,
        }, { timeout: 1500 });
      } catch (_) {}
      await cancellableSleep(80 + Math.floor(Math.random() * 150), () => this.aborted);
    }
  }

  /**
   * Extracts visible internal links from current page for random walk.
   */
  async findInternalLinks() {
    if (this.aborted || !this.pageConnection) return [];
    const expression = `(() => {
      try {
        const curHost = window.location.hostname;
        const curHref = window.location.href;
        const anchors = [...document.querySelectorAll('a[href]')];
        const valid = [];
        for (const a of anchors) {
          try {
            const u = new URL(a.href, curHref);
            if (u.hostname !== curHost) continue;
            if (u.href === curHref) continue;
            if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
            const r = a.getBoundingClientRect();
            if (r.width > 2 && r.height > 2) {
              valid.push({
                href: u.href,
                text: (a.textContent || '').trim().slice(0, 60),
                target: a.getAttribute('target') || '',
              });
            }
          } catch (_) {}
        }
        return valid.slice(0, 30);
      } catch (_) {
        return [];
      }
    })()`;

    try {
      const res = await this.pageConnection.command('Runtime.evaluate', {
        expression,
        returnByValue: true,
      }, { timeout: 3000 });
      return Array.isArray(res?.result?.value) ? res.result.value : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Scrolls a target link element into the viewport center and returns fresh coordinates.
   */
  async scrollLinkIntoViewAndGetCoords(targetHref) {
    if (this.aborted || !this.pageConnection) return null;
    const expression = `(() => {
      try {
        const anchors = [...document.querySelectorAll('a[href]')];
        const a = anchors.find(el => el.href === ${JSON.stringify(targetHref)}) || anchors[0];
        if (!a) return null;
        a.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = a.getBoundingClientRect();
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        };
      } catch (_) {
        return null;
      }
    })()`;
    try {
      const res = await this.pageConnection.command('Runtime.evaluate', {
        expression,
        returnByValue: true,
      }, { timeout: 3000 });
      return res?.result?.value || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Clicks a target coordinate with plausible mouse down/up delay.
   */
  async performClick(x, y) {
    if (this.aborted || !this.pageConnection) return;
    await this.moveMouseSmoothly(x, y);
    try {
      await this.pageConnection.command('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      }, { timeout: 1500 });
      await cancellableSleep(60 + Math.floor(Math.random() * 80), () => this.aborted);
      await this.pageConnection.command('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      }, { timeout: 1500 });
    } catch (_) {}
  }

  /**
   * Clicks a target coordinate, detecting target="_blank" new-tab openings and
   * switching active navigation to the new tab while closing the old tab.
   */
  async performClickAndFollow(x, y) {
    if (this.aborted || !this.pageConnection || this.pageConnection.closed) return false;

    let beforeTabs = [];
    try { beforeTabs = await cdp.tabs(this.port); } catch (_) {}
    const beforeIds = new Set(beforeTabs.map((t) => t.id));
    const oldTabId = this.activeTabId;
    const oldConnection = this.pageConnection;

    await this.performClick(x, y);

    // The HTTP target list omits openerId; use browser-level CDP metadata to
    // distinguish our popup from tabs opened concurrently by the user.
    let newTab = null;
    let metadataConnection = this.browserConnection;
    let ownsMetadataConnection = false;
    try {
      if (!metadataConnection?.command) {
        const browserWs = await cdp.browserSocket(this.port);
        if (browserWs) {
          metadataConnection = await cdp.connect(browserWs, { timeout: 3000 });
          ownsMetadataConnection = true;
        }
      }
      for (let i = 0; i < 8; i += 1) {
        if (this.aborted) break;
        await cancellableSleep(150, () => this.aborted);
        try {
          const [currentTabs, metadata] = await Promise.all([
            cdp.tabs(this.port),
            metadataConnection?.command('Target.getTargets', {}, { timeout: 1500 }),
          ]);
          for (const target of (metadata?.targetInfos || [])) {
            if (target.openerId === oldTabId && !beforeIds.has(target.targetId)) {
              this.ownedTabIds.add(target.targetId);
            }
          }
          const ownedIds = new Set((metadata?.targetInfos || [])
            .filter((target) => target.openerId === oldTabId)
            .map((target) => target.targetId));
          newTab = currentTabs.find((tab) => !beforeIds.has(tab.id) && ownedIds.has(tab.id));
          if (newTab) break;
        } catch (_) {}
      }
    } finally {
      if (ownsMetadataConnection) {
        try { metadataConnection.close(); } catch (_) {}
      }
    }

    if (newTab && newTab.webSocketDebuggerUrl) {
      this.ownedTabIds.add(newTab.id);
      this.emit('robot-progress', {
        profileId: this.profileId,
        domain: this.currentDomain,
        phase: 'switch-tab',
        message: 'Switched walk to new tab opened by target=_blank and closed previous tab',
        newTabId: newTab.id,
      });

      let newConn = null;
      try {
        newConn = await cdp.connect(newTab.webSocketDebuggerUrl, {
          timeout: 8000,
          onEvent: (event) => this.handlePageEvent(event),
          onDisconnect: (err) => this.handlePageDisconnect(err),
        });
        await newConn.command('Page.enable', {}, { timeout: 3000 });
        await newConn.command('Network.enable', {}, { timeout: 3000 });
        await newConn.command('DOM.enable', {}, { timeout: 3000 });
      } catch (connectErr) {
        // Connect failed: do not close old tab; recover session if needed
        if (!this.pageConnection || this.pageConnection.closed) {
          await this.acquirePageSession();
        }
        return false;
      }

      // Successful connection established
      this.pageConnection = newConn;
      this.activeTabId = newTab.id;

      if (oldConnection && oldConnection !== newConn) {
        try { oldConnection.close(); } catch (_) {}
      }

      // Safely close old tab only if multiple tabs are active and old tab was owned
      try {
        const currentTabs = await cdp.tabs(this.port);
        if (currentTabs.length >= 2 && oldTabId && this.ownedTabIds.has(oldTabId)) {
          await cdp.closeTab(this.port, oldTabId);
          this.ownedTabIds.delete(oldTabId);
        }
      } catch (_) {}

      await this.ensureDomReady(3000);
      return true;
    }

    // Normal in-page navigation or DOM update
    await this.ensureDomReady(3000);
    return true;
  }

  /**
   * Closes any surplus tabs left open by popups or redirects, keeping only the active tab.
   * Strictly isolates user tabs: never touches or closes tabs not in ownedTabIds!
   */
  async pruneSurplusTabs() {
    try {
      const allTabs = await cdp.tabs(this.port);
      for (const tab of allTabs) {
        if (this.ownedTabIds.has(tab.id) && tab.id !== this.activeTabId) {
          const currentTabs = await cdp.tabs(this.port);
          if (currentTabs.length <= 1) break; // Invariant: never close the last browser tab
          try { await cdp.closeTab(this.port, tab.id); } catch (_) {}
          this.ownedTabIds.delete(tab.id);
        }
      }
    } catch (_) {}
  }

  /**
   * Cleans up all tabs created or owned by CookieRobot on completion or stop.
   * Invariants:
   * 1. Strictly protects user tabs: never touches or closes any tab not owned by this robot.
   * 2. Strictly protects the last tab: never closes a tab if currentTabs.length <= 1.
   */
  async cleanupOwnedTabs() {
    if (this._cleaningUpTabs) {
      return this._cleaningUpTabs;
    }
    const cleanupTask = (async () => {
      try {
        if (!this.port) return;
        if (this.pageConnection) {
          try { this.pageConnection.close(); } catch (_) {}
          this.pageConnection = null;
        }

        const owned = new Set(this.ownedTabIds);
        if (this.activeTabId) {
          owned.add(this.activeTabId);
        }
        if (owned.size === 0) return;

        // Candidate tabs to close: surplus owned tabs first, activeTabId last.
        // This ensures if only robot tabs exist in the browser, the active tab is preserved as the last tab.
        const candidateIds = Array.from(owned).filter((id) => id !== this.activeTabId);
        if (this.activeTabId && owned.has(this.activeTabId)) {
          candidateIds.push(this.activeTabId);
        }

        for (const tabId of candidateIds) {
          try {
            // Strictly protect user tabs: only tabs owned by this robot can ever be closed
            if (!this.ownedTabIds.has(tabId) && tabId !== this.activeTabId) {
              continue;
            }

            const currentTabs = await cdp.tabs(this.port);
            // Invariant: MUST protect the last tab in the browser (never close the last tab)
            if (!Array.isArray(currentTabs) || currentTabs.length <= 1) {
              break;
            }

            // Ensure tab still exists before attempting to close
            if (!currentTabs.some((t) => t.id === tabId)) {
              this.ownedTabIds.delete(tabId);
              if (this.activeTabId === tabId) {
                this.activeTabId = null;
              }
              continue;
            }

            await cdp.closeTab(this.port, tabId);
            this.ownedTabIds.delete(tabId);
            if (this.activeTabId === tabId) {
              this.activeTabId = null;
            }
          } catch (_) {}
        }
      } catch (_) {}
    })();

    this._cleaningUpTabs = cleanupTask;
    try {
      await cleanupTask;
    } finally {
      this._cleaningUpTabs = null;
    }
  }

  /**
   * Appends an audit record to the JSONL log file with size-based rotation.
   */
  appendRecord(record) {
    this.records.push(record);
    try {
      const dir = path.dirname(this.recordFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Rotate/truncate if file exceeds 2MB (keep recent half)
      const MAX_LOG_SIZE = 2 * 1024 * 1024;
      if (fs.existsSync(this.recordFile)) {
        try {
          const stat = fs.statSync(this.recordFile);
          if (stat.size >= MAX_LOG_SIZE) {
            const content = fs.readFileSync(this.recordFile, 'utf8');
            const lines = content.split('\n').filter(Boolean);
            const keepLines = lines.slice(Math.floor(lines.length / 2));
            fs.writeFileSync(this.recordFile, keepLines.join('\n') + '\n', 'utf8');
          }
        } catch (_) {}
      }

      fs.appendFileSync(this.recordFile, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      this.emit('robot-warning', { message: `Failed to write JSONL record: ${err.message}` });
    }
  }

  /**
   * Navigates to a URL, waiting for Page.loadEventFired (with a 5s cap) and DOM readiness.
   * Immediately unblocks if stop() is invoked mid-flight.
   */
  async navigateTo(url, timeoutMs = 20000) {
    if (this.aborted) {
      throw new Error('CookieRobot is stopped');
    }
    if (!this.pageConnection || this.pageConnection.closed) {
      throw new Error('No active page connection to navigate');
    }

    let loadResolver = null;
    const loadPromise = new Promise((resolve) => {
      loadResolver = resolve;
    });

    const unlistenLoad = this.oncePageEvent('Page.loadEventFired', () => {
      if (loadResolver) loadResolver('loadEventFired');
    });
    const unlistenStop = this.oncePageEvent('Page.frameStoppedLoading', () => {
      if (loadResolver) loadResolver('frameStoppedLoading');
    });

    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.min(5000, timeoutMs));
    });

    let stopReject = null;
    const stopPromise = new Promise((_, reject) => {
      stopReject = reject;
    });
    this._currentNavStopReject = stopReject;

    try {
      const nav = await this.pageConnection.command('Page.navigate', { url }, { timeout: timeoutMs });
      if (nav?.errorText) {
        throw new Error(nav.errorText);
      }

      await Promise.race([loadPromise, timeoutPromise, stopPromise]);
    } finally {
      if (timer) clearTimeout(timer);
      this._currentNavStopReject = null;
      unlistenLoad();
      unlistenStop();
    }

    if (this.aborted || !this.pageConnection || this.pageConnection.closed) {
      throw new Error('Page connection closed during navigation');
    }

    // Ensure DOM readyState is interactive or complete
    await this.ensureDomReady(3000);
    return true;
  }

  /**
   * Starts the warmup run across planned targets.
   */
  async start() {
    if (this.running) throw new Error('CookieRobot is already running');
    this.running = true;
    this.aborted = false;

    const runPromise = (async () => {
      const plan = generateWalkPlan(this.config);
      this.totalSteps = plan.totalSites;
      this.currentStep = 0;
      this.records = [];

      this.emit('robot-started', {
        profileId: this.profileId,
        totalSites: this.totalSteps,
        config: plan.config,
        plan: plan.sites,
      });

      let initialCookies = 0;
      try {
        await this.acquirePageSession();
        initialCookies = await this.readCookiesCount();
      } catch (err) {
        this.emit('robot-failed', {
          profileId: this.profileId,
          error: err.message,
        });
        throw err;
      }

      let priorCookies = initialCookies;

      for (let i = 0; i < plan.sites.length; i += 1) {
        if (this.aborted) break;

        const site = plan.sites[i];
        this.currentStep = i + 1;
        this.currentDomain = site.domain;
        const siteStartTime = Date.now();
        let sitePagesVisited = 0;
        let siteCompleted = false;
        let lastError = null;

        this.emit('robot-progress', {
          profileId: this.profileId,
          domain: site.domain,
          step: this.currentStep,
          totalSteps: this.totalSteps,
          phase: 'navigating',
          status: 'in_progress',
        });

        // Site-level retry loop
        for (let attempt = 0; attempt <= site.maxRetries; attempt += 1) {
          if (this.aborted) break;
          try {
            await this.navigateTo(site.url, this.config.navigationTimeoutMs);
            sitePagesVisited += 1;
            this.totalPagesVisited += 1;

            // Dwell on landing page with human pacing
            const stayMs = Math.round(site.stayDurationSec * 1000);
            const dwellStart = Date.now();

            while (Date.now() - dwellStart < stayMs && !this.aborted) {
              // Mouse jitter / trajectory
              const targetX = 100 + Math.floor(Math.random() * 600);
              const targetY = 100 + Math.floor(Math.random() * 400);
              await this.moveMouseSmoothly(targetX, targetY);

              // Probabilistic scroll
              if (Math.random() < site.scrollProbability) {
                await this.performHumanScroll();
              }

              await cancellableSleep(300 + Math.floor(Math.random() * 400), () => this.aborted);
            }

            // Multi-hop random walk deeper if depth > 1 (landing is depth 1, subpages depth 2..walkDepth)
            for (let depth = 2; depth <= site.walkDepth; depth += 1) {
              if (this.aborted) break;
              if (Math.random() >= site.clickProbability) break;

              const links = await this.findInternalLinks();
              if (!links.length) break;

              const picked = links[Math.floor(Math.random() * links.length)];
              this.emit('robot-progress', {
                profileId: this.profileId,
                domain: site.domain,
                step: this.currentStep,
                totalSteps: this.totalSteps,
                phase: 'random-walk',
                depth,
                targetLink: picked.href,
              });

              const coords = await this.scrollLinkIntoViewAndGetCoords(picked.href);
              const clickX = coords ? coords.x : 200;
              const clickY = coords ? coords.y : 200;

              const followed = await this.performClickAndFollow(clickX, clickY);
              if (!followed || this.aborted) break;

              await cancellableSleep(800 + Math.floor(Math.random() * 800), () => this.aborted);
              sitePagesVisited += 1;
              this.totalPagesVisited += 1;

              // Brief dwell on subpage
              if (Math.random() < site.scrollProbability) {
                await this.performHumanScroll();
              }
              await cancellableSleep(800 + Math.floor(Math.random() * 1000), () => this.aborted);
            }

            siteCompleted = true;
            break;
          } catch (err) {
            lastError = err;
            if (attempt < site.maxRetries && !this.aborted) {
              this.emit('robot-progress', {
                profileId: this.profileId,
                domain: site.domain,
                step: this.currentStep,
                totalSteps: this.totalSteps,
                phase: 'retry',
                attempt: attempt + 1,
                error: err.message,
              });
              await cancellableSleep(1000, () => this.aborted);
            }
          }
        }

        // Clean up any stray background tabs to enforce single-tab invariant
        await this.pruneSurplusTabs();

        // Measure cookie delta after domain visit
        const currentCookies = await this.readCookiesCount();
        const cookiesDelta = Math.max(0, currentCookies - priorCookies);
        priorCookies = currentCookies;
        this.totalCookiesAccumulated += cookiesDelta;

        const record = {
          domain: site.domain,
          timestamp: new Date().toISOString(),
          pagesVisited: sitePagesVisited,
          cookiesAdded: cookiesDelta,
          totalCookies: currentCookies,
          durationMs: Date.now() - siteStartTime,
          status: siteCompleted ? 'completed' : 'skipped',
        };
        if (!siteCompleted && lastError) {
          record.error = lastError.message;
        }

        this.appendRecord(record);

        this.emit('robot-progress', {
          profileId: this.profileId,
          domain: site.domain,
          step: this.currentStep,
          totalSteps: this.totalSteps,
          phase: 'domain-complete',
          status: record.status,
          pagesVisited: sitePagesVisited,
          cookiesAdded: cookiesDelta,
          totalCookies: currentCookies,
          record,
        });

        if (!this.aborted && i < plan.sites.length - 1) {
          // Inter-site pause
          await cancellableSleep(500 + Math.floor(Math.random() * 800), () => this.aborted);
        }
      }

      const finalStatus = this.aborted ? 'stopped' : 'completed';
      this.emit('robot-finished', {
        profileId: this.profileId,
        status: finalStatus,
        aborted: this.aborted,
        records: this.records,
        totalPagesVisited: this.totalPagesVisited,
        totalCookiesAdded: this.totalCookiesAccumulated,
        recordFile: this.recordFile,
      });

      return {
        profileId: this.profileId,
        status: finalStatus,
        records: this.records,
        totalPagesVisited: this.totalPagesVisited,
        totalCookiesAdded: this.totalCookiesAccumulated,
      };
    })();

    this._runPromise = runPromise;

    try {
      return await runPromise;
    } finally {
      this.running = false;
      this._runPromise = null;
      if (this.pageConnection) {
        try { this.pageConnection.close(); } catch (_) {}
        this.pageConnection = null;
      }
      await this.cleanupOwnedTabs();
    }
  }
}

module.exports = {
  CookieRobot,
  DEFAULT_CONFIG,
  normalizeRobotConfig,
  normalizeTargetUrl,
  generateWalkPlan,
  generateMouseTrajectory,
  bezierPoint,
};
