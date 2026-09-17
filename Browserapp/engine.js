const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const cdp = require('./cdp');
const { mergeFlags, appendFlagValue, LIST_VALUE_FLAGS } = require('./automation/command-line-flags');
const { addChromeStoreExtension } = require('./store-extension');
const { reconcileOnConnection, portConnection } = require('./extension-pipe');
const { parseProxy, displayProxy, startAuthenticatedProxy, lookupProxyCountry, lookupDirectCountry, extractProxyFromApi, invokeProxyRefresh, classifyProxyError } = require('./proxy-forwarder');
const { resolveProfileLanguage, resolveProfileTimezone, localeFromCountryCode } = require('./automation/locale-from-country');
const { applyLanguagePreferences, verifyLanguagePreferences, syncProfileLocalState } = require('./automation/profile-file-consistency');
const { mergeLoadExtensionArgs } = require('./automation/protocol/app-center-protocol');
const { prepareMarkerExtension, prepareMacDockWrapper, normalizeEnvNumber } = require('./automation/env-icon');
const { toFileUrl, killProcessTree } = require('./automation/protocol/cross-platform');
const { platformPreflight } = require('./automation/platform-preflight');
const { buildFingerprint, buildWorkerInjectionScript, chromeArgsForFingerprint, applyFingerprintToTab } = require('./automation/fingerprint');
const isolation = require('./automation/isolation');
const { lockPath, acquireProfileLock, updateProfileLock, releaseProfileLock, scanProcessesUsingProfile, isPidAlive, auditIsolation, isSystemBrowserExecutable, isPathInsideOrEqual, validateDataRootIsolationSecure, validateProfileRootSecure, assertProfileId, assertSafeProfileChild } = isolation;
const { BrowserKernelManager, ensureKernelReadyForLaunch } = require('./automation/browser-kernel');
const { ensureStartPageServer, getStartPageServer } = require('./automation/start-page-server');
const {
  isOpenBrowser148,
  writeOpenBrowserKernelInit,
  fingerprintForNativeKernelInject,
} = require('./automation/kernel-init-sync');
const { fpLog, summarizeFp, LIVE_PROBE_EXPRESSION, logPath: fingerprintLogPath } = require('./automation/fingerprint-debug-log');
const { buildPortScanProtectionScript } = require('./automation/port-scan-protection');
const { buildWorkerFontPresenceSource } = require('./automation/worker-font-presence-fallback');
const { createCssFontResponseRewriter } = require('./automation/css-font-response-rewrite');
const { deriveFontPlaceholder } = require('./automation/font-placeholder');
const userAgentModule = require('./automation/user-agent');
if (!userAgentModule.__navigatorProtoHardened) {
  userAgentModule.__navigatorProtoHardened = true;
  const origBuildUa = userAgentModule.buildUaInjectionScript;
  if (typeof origBuildUa === 'function') {
    userAgentModule.buildUaInjectionScript = function (uaProfile) {
      let script = origBuildUa.call(this, uaProfile);
      script = script.replace(
        'if (typeof Navigator !== "undefined" && (receiver instanceof Navigator || Object.prototype.toString.call(receiver) === "[object Navigator]")) return true;',
        'if (typeof Navigator !== "undefined" && receiver !== Navigator.prototype && (receiver instanceof Navigator || Object.prototype.toString.call(receiver) === "[object Navigator]")) return true;'
      );
      script = script.replace(
        'if (typeof WorkerNavigator !== "undefined" && (receiver instanceof WorkerNavigator || Object.prototype.toString.call(receiver) === "[object WorkerNavigator]")) return true;',
        'if (typeof WorkerNavigator !== "undefined" && receiver !== WorkerNavigator.prototype && (receiver instanceof WorkerNavigator || Object.prototype.toString.call(receiver) === "[object WorkerNavigator]")) return true;'
      );
      script = script.replace(/typeof secret === "string" && secret\.length > 0/g, 'secret === "__UA_BRIDGE_TOKEN__"');
      return script;
    };
  }
}
const { buildUaProfile, cdpUserAgentOverride, buildAcceptLanguageHeader } = require('./automation/user-agent');
const { sanitizeUrlForLog } = require('./automation/log-sanitizer');
const { getPlatformFontPayload } = require('./automation/query-local-font-blob-gate');

// Stable identity of the document-start config. Two inject payloads built from the same
// fingerprint serialise identically, so this is what decides whether a live tab still matches
// what the runtime intends to apply.
const fingerprintConfigHash = (fp) => {
  try {
    return crypto.createHash('sha1').update(JSON.stringify(fp || {})).digest('hex').slice(0, 16);
  } catch (_) {
    return '';
  }
};

const KERNEL_POLICY_VERSION = 4;
// Chromium's Windows renderer/GPU helpers can outlive the browser process by
// several seconds while profile databases close. Keep the profile lock until
// the OS process list confirms they are gone, but give taskkill enough time to
// finish on slower RDP/VM hosts.
const HELPER_CLEANUP_ATTEMPTS = process.platform === 'win32' ? 32 : 3;
const HELPER_CLEANUP_DELAY_MS = process.platform === 'win32' ? 250 : 120;
const HELPER_CLEANUP_TIMEOUT_MS = process.platform === 'win32' ? 14000 : 3000;
const STOP_ALL_ITEM_TIMEOUT_MS = process.platform === 'win32' ? 22000 : 12000;

const {
  isChildExited,
  removeSingletonFiles,
  lifecycleTimeout,
  parsedProxy,
  proxyHasCredentials,
  hasExplicitScheme,
  sameProxyEndpoint,
  sameProxyIdentity,
  ownAliasValue,
  profileProxyAssociation,
  normalizedProxyAssociationId,
  managedBrowserKillOptions,
  systemBrowserCandidatesForPlatform,
  appendDiagnosticOutput,
  formatBrowserStartupError,
  writeBrowserStartupDiagnostic,
  stopIpcStubForWindow,
  writeRawAtomically,
  writeJsonAtomically,
  readEngineStateCandidate,
  engineStateRecoveryCandidates,
  preserveCorruptEngineState,
  retryProxyOperation,
  assertExtensionTreeSafe,
  sanitizeProfile: sanitizeProfileData,
} = require("./engine/index");

/**
 * Validate whether a string is a recognized, valid IANA time zone identifier.
 */
function isValidIanaTimezone(tz) {
  if (!tz || typeof tz !== "string") return false;
  const trimmed = tz.trim();
  if (!trimmed) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Extract an explicit --time-zone-for-testing value from launch args if present.
 */
function extractTimezoneFromArgs(args) {
  if (!Array.isArray(args)) return null;
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const item = String(args[i] || "");
    if (item.startsWith("--time-zone-for-testing=")) {
      const val = item.slice("--time-zone-for-testing=".length).trim();
      return val || null;
    }
  }
  return null;
}





function sanitizeInjectionScript(source) {
  if (typeof source !== 'string' || !source) return source;
  let out = source.split('/^Mozilla//').join('/^Mozilla\//');
  out = out.replace(/typeof secret === "string" && secret\.length > 0/g, 'secret === "__UA_BRIDGE_TOKEN__"');
  out = out.replace(
    'if (typeof Navigator !== "undefined" && (receiver instanceof Navigator || Object.prototype.toString.call(receiver) === "[object Navigator]")) return true;',
    'if (typeof Navigator !== "undefined" && receiver !== Navigator.prototype && (receiver instanceof Navigator || (Object.prototype.toString.call(receiver) === "[object Navigator]" && !Navigator.prototype.isPrototypeOf(receiver) && receiver !== Navigator.prototype))) return true;'
  );
  out = out.replace(
    'if (typeof WorkerNavigator !== "undefined" && (receiver instanceof WorkerNavigator || Object.prototype.toString.call(receiver) === "[object WorkerNavigator]")) return true;',
    'if (typeof WorkerNavigator !== "undefined" && receiver !== WorkerNavigator.prototype && (receiver instanceof WorkerNavigator || (Object.prototype.toString.call(receiver) === "[object WorkerNavigator]" && !WorkerNavigator.prototype.isPrototypeOf(receiver) && receiver !== WorkerNavigator.prototype))) return true;'
  );
  return out;
}

if (!cdp.__scriptSanitized) {
  cdp.__scriptSanitized = true;
  const origCdpCall = cdp.call;
  if (typeof origCdpCall === 'function') {
    cdp.call = function (webSocketUrl, method, params = {}, timeout) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && params && typeof params.source === 'string') {
        params.source = sanitizeInjectionScript(params.source);
      }
      if (method === 'Runtime.evaluate' && params && typeof params.expression === 'string') {
        params.expression = sanitizeInjectionScript(params.expression);
      }
      return origCdpCall.call(this, webSocketUrl, method, params, timeout);
    };
  }
  if (cdp.PersistentConnection && cdp.PersistentConnection.prototype) {
    const origCommand = cdp.PersistentConnection.prototype.command;
    cdp.PersistentConnection.prototype.command = function (method, params = {}, options = {}) {
      if (method === 'Page.addScriptToEvaluateOnNewDocument' && params && typeof params.source === 'string') {
        params.source = sanitizeInjectionScript(params.source);
      }
      if (method === 'Runtime.evaluate' && params && typeof params.expression === 'string') {
        params.expression = sanitizeInjectionScript(params.expression);
      }
      return origCommand.call(this, method, params, options);
    };
  }
}

if (!cdp.__serviceWorkerHardened) {
  cdp.__serviceWorkerHardened = true;
  const origConnect = cdp.connect;
  cdp.connect = async function (webSocketUrl, options = {}) {
    const originalOnEvent = options.onEvent;
    const attachedWorkerTargets = new Set();
    const sessionToTargetId = new Map();
    const wrappedOptions = { ...options };
    wrappedOptions.onEvent = async (event, conn) => {
      if (event?.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo = {}, waitingForDebugger } = event.params || {};
        const targetId = targetInfo.targetId;
        if (sessionId && targetId) sessionToTargetId.set(sessionId, targetId);
        if (sessionId && targetInfo.type === 'service_worker') {
          if (targetId && attachedWorkerTargets.has(targetId)) {
            if (waitingForDebugger) {
              await conn.command('Runtime.runIfWaitingForDebugger', {}, { sessionId }).catch(() => {});
            }
            return;
          }
          if (targetId) attachedWorkerTargets.add(targetId);
          const fp = RequestHeaderRewriter.latestFingerprint;
          if (fp) {
            try {
              const source = buildWorkerInjectionScript(fp);
              await conn.command('Runtime.evaluate', { expression: source }, { sessionId, timeout: 2000 }).catch((evalErr) => {
                const rewriter = RequestHeaderRewriter.latestInstance;
                if (rewriter?.logger) {
                  rewriter.logger({
                    type: 'fingerprint-injection-failed',
                    id: RequestHeaderRewriter.latestProfile?.id,
                    targetType: 'service_worker',
                    stage: 'worker-inject',
                    operation: 'sw-evaluate',
                    message: evalErr?.message || String(evalErr),
                  });
                }
              });
            } catch (err) {
              const rewriter = RequestHeaderRewriter.latestInstance;
              if (rewriter?.logger) {
                rewriter.logger({
                  type: 'fingerprint-injection-failed',
                  id: RequestHeaderRewriter.latestProfile?.id,
                  targetType: 'service_worker',
                  stage: 'worker-inject',
                  operation: 'sw-evaluate',
                  message: err?.message || String(err),
                });
              }
            }
          }
        }
      } else if (event?.method === 'Target.detachedFromTarget') {
        const sid = event.params?.sessionId;
        const tid = event.params?.targetId || (sid ? sessionToTargetId.get(sid) : null);
        if (tid) attachedWorkerTargets.delete(tid);
        if (sid) sessionToTargetId.delete(sid);
      } else if (event?.method === 'Target.targetDestroyed') {
        const tid = event.params?.targetId;
        if (tid) attachedWorkerTargets.delete(tid);
      }
      if (typeof originalOnEvent === 'function') {
        return originalOnEvent(event, conn);
      }
    };
    return origConnect.call(this, webSocketUrl, wrappedOptions);
  };
}

/**
 * Chromium 原生线缆层 HTTP 报头标准槽位序列 (Canonical Wire Header Order).
 *
 * 【背景与 JA4H / Akamai 指纹防御】：
 * JA4H (HTTP Client Fingerprinting) 与 Akamai Bot Manager 会依据线缆层请求头的名字序列（以及特定头的哈希）
 * 建立客户端指纹。原生 Chromium 在网络栈 (net::URLRequestHttpJob, ClientHints, NavigationLoader) 中
 * 按照固定的装配阶段构建报头流。若中间层重写器将 Client Hints (sec-ch-ua*) 或 User-Agent / Accept-Language
 * 错误 append 到末尾，会导致明显的顺序倒置特征（如 sec-ch-ua 跑到 user-agent 之后），被 WAF 判定为异常机器人。
 *
 * 【槽位排序原理与位置说明】：
 * 1. host: HTTP/1.1 规范要求的首个虚拟主机头，Chromium 网络栈最优先填充。
 * 2. connection: 传输层连接控制选项 (keep-alive, upgrade)，紧随 Host。
 * 3. cache-control / pragma: 条件请求/刷新时的缓存指令，由缓存层在较早阶段插入。
 * 4. sec-ch-ua 系列 (Client Hints): Chromium ClientHints 委托在请求构建极早期（before User-Agent）下发：
 *    - sec-ch-ua: 基础品牌版本列表 (GREASE + Chromium + Brand)。
 *    - sec-ch-ua-mobile: 是否移动端布尔标记 (?0 或 ?1)。
 *    - sec-ch-ua-platform: 操作系统平台名 (如 "Windows", "Android", "macOS")。
 *    - 高熵 Client Hints (当服务器通过 Accept-CH 明确请求时按标准次序出现):
 *      sec-ch-ua-arch, sec-ch-ua-bitness, sec-ch-ua-model, sec-ch-ua-platform-version,
 *      sec-ch-ua-full-version, sec-ch-ua-full-version-list, sec-ch-ua-form-factors, sec-ch-ua-wow64
 * 5. upgrade-insecure-requests: 页面导航层下发的升级请求标记，位于 User-Agent 之前。
 * 6. user-agent: 浏览器核心 UA 字符串，位于 Accept 之前。
 * 7. accept: 客户端内容协商偏好 (text/html, application/xhtml+xml, ...)。
 * 8. accept-language: 语言与区域偏好（含 RFC 9110 q-factor 权重），紧随 Accept，排在 sec-fetch-* 之前。
 * 9. sec-fetch-* 系列 (W3C Fetch Metadata): 紧随 Accept-Language 之后按规范排布：
 *    - sec-fetch-site: 请求源关系 (same-origin, cross-site, none 等)。
 *    - sec-fetch-mode: 请求模式 (navigate, cors, no-cors 等)。
 *    - sec-fetch-user: 用户手势标记 (?1)。
 *    - sec-fetch-dest: 请求目标资源类型 (document, script, empty 等)。
 *    - sec-fetch-storage-access: 存储访问权限标记。
 * 10. referer: 来源页 URL。
 * 11. origin: CORS 跨域请求的源标识。
 * 12. accept-encoding: 浏览器支持的内容编码 (gzip, deflate, br, zstd)，排在 Cookie 之前。
 * 13. cookie: 携带的持久化/会话 Cookie。
 * 14. priority: HTTP/2 与 HTTP/3 流优先级控制头。
 */
const CHROMIUM_CANONICAL_HEADER_ORDER = Object.freeze([
  "host",
  "connection",
  "cache-control",
  "pragma",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-model",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-form-factors",
  "sec-ch-ua-wow64",
  "upgrade-insecure-requests",
  "user-agent",
  "accept",
  "accept-language",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-user",
  "sec-fetch-dest",
  "sec-fetch-storage-access",
  "referer",
  "origin",
  "accept-encoding",
  "cookie",
  "priority",
]);

const CHROMIUM_CANONICAL_HEADER_INDEX = Object.freeze(
  new Map(CHROMIUM_CANONICAL_HEADER_ORDER.map((name, i) => [name, i]))
);

class RequestHeaderRewriter {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.logger = typeof options.logger === "function" ? options.logger : null;
    this.inFlight = new Set();
    this.inFlightBySession = new Map();
    this.profile = options.profile || {};
    this.fingerprint = options.fingerprint || null;
    RequestHeaderRewriter.latestInstance = this;
    if (options.fingerprint && Object.keys(options.fingerprint).length > 0) {
      RequestHeaderRewriter.latestFingerprint = options.fingerprint;
    }
    if (options.profile && Object.keys(options.profile).length > 0) {
      RequestHeaderRewriter.latestProfile = options.profile;
    }
    this.setPersona(options.profile, options.fingerprint);
  }

  setPersona(profile = {}, fingerprint = {}) {
    if (fingerprint && Object.keys(fingerprint).length > 0) {
      RequestHeaderRewriter.latestFingerprint = fingerprint;
    }
    if (profile && Object.keys(profile).length > 0) {
      RequestHeaderRewriter.latestProfile = profile;
    }
    const fp = fingerprint || {};
    const prof = profile || {};
    const ua = fp.userAgent || prof.userAgent || "";
    const rawOs = String(fp.os || prof.os || fp.platform || prof.platform || "").toLowerCase();
    const osKey = rawOs.includes("win") ? "windows"
      : rawOs.includes("andr") ? "android"
      : rawOs.includes("mac") ? "macos"
      : rawOs.includes("ios") ? "ios"
      : rawOs.includes("lin") ? "linux"
      : (ua ? undefined : "windows");

    const platformNav = osKey === "windows" ? "Win32"
      : osKey === "android" ? "Linux armv8l"
      : osKey === "macos" ? "MacIntel"
      : osKey === "ios" ? "iPhone"
      : osKey === "linux" ? "Linux x86_64"
      : undefined;

    const uaProfile = fp.uaProfile || buildUaProfile({
      userAgent: ua,
      os: osKey,
      platformNav,
    });

    const langs = (Array.isArray(fp.languages) && fp.languages.length)
      ? fp.languages
      : (Array.isArray(prof.languages) && prof.languages.length)
        ? prof.languages
        : prof.language
          ? [prof.language]
          : [];

    const acceptLanguageHeader = langs.length
      ? buildAcceptLanguageHeader(langs)
      : (uaProfile.language || "en-US,en;q=0.9");

    const override = cdpUserAgentOverride(uaProfile, acceptLanguageHeader);

    const meta = override.userAgentMetadata || {};
    const metaFormFactors = fp.formFactors || prof.formFactors || fp.clientHints?.formFactors || prof.clientHints?.formFactors || fp.form_factors || prof.form_factors;
    if (metaFormFactors && !meta.formFactors) {
      meta.formFactors = metaFormFactors;
    }

    this.persona = {
      userAgent: override.userAgent || uaProfile.userAgent || ua,
      acceptLanguage: acceptLanguageHeader || override.acceptLanguage,
      platformNav: override.platform || uaProfile.platform || platformNav || "Win32",
      platform: meta.platform || uaProfile.metadata?.platform || (osKey === "android" ? "Android" : "Windows"),
      mobile: Boolean(meta.mobile),
      brands: meta.brands || [],
      metadata: meta,
    };

    if (Array.isArray(this.persona.brands) && this.persona.brands.length) {
      this.secChUa = this.persona.brands
        .map((b) => "\"" + b.brand + "\";v=\"" + b.version + "\"")
        .join(", ");
    } else {
      this.secChUa = "\"Chromium\";v=\"148\", \"Google Chrome\";v=\"148\"";
    }

    const fvl = this.persona.metadata?.fullVersionList;
    if (Array.isArray(fvl) && fvl.length) {
      this.secChUaFullVersionList = fvl
        .map((b) => "\"" + b.brand + "\";v=\"" + b.version + "\"")
        .join(", ");
    } else {
      const fv = this.persona.metadata?.fullVersion || "148.0.0.0";
      if (Array.isArray(this.persona.brands) && this.persona.brands.length) {
        this.secChUaFullVersionList = this.persona.brands
          .map((b) => "\"" + b.brand + "\";v=\"" + fv + "\"")
          .join(", ");
      } else {
        this.secChUaFullVersionList = "\"Chromium\";v=\"" + fv + "\", \"Google Chrome\";v=\"" + fv + "\"";
      }
    }
  }

  async _sendCommand(connection, method, params = {}, options = {}) {
    if (!connection) throw new Error("No CDP connection available");
    if (typeof connection.command === "function") {
      return connection.command(method, params, options);
    }
    if (typeof connection.call === "function") {
      return connection.call(method, params, options);
    }
    if (typeof connection.send === "function") {
      return connection.send(method, params, options);
    }
    throw new Error("Unsupported connection object (missing command/call/send)");
  }

  cleanupSession(sessionId) {
    if (!sessionId) return;
    const reqs = this.inFlightBySession.get(sessionId);
    if (reqs) {
      for (const rid of reqs) {
        this.inFlight.delete(rid);
      }
      this.inFlightBySession.delete(sessionId);
    }
  }

  destroy() {
    this.inFlight.clear();
    this.inFlightBySession.clear();
  }

  handleEvent(event, connection) {
    if (!event || event.method !== "Fetch.requestPaused" || !event.params) return;
    const { requestId, request, responseStatusCode } = event.params;
    const sessionId = event.sessionId;

    // Only process requests at Request stage (where responseStatusCode is null/undefined)
    if (!requestId || responseStatusCode != null) return;

    // Prevent duplicate in-flight processing for the same requestId across sessions
    if (this.inFlight.has(requestId)) {
      this._sendCommand(connection, "Fetch.continueRequest", { requestId }, { sessionId, timeout: 3000 }).catch(() => {});
      return;
    }
    this.inFlight.add(requestId);
    if (sessionId) {
      if (!this.inFlightBySession.has(sessionId)) {
        this.inFlightBySession.set(sessionId, new Set());
      }
      this.inFlightBySession.get(sessionId).add(requestId);
    }

    (async () => {
      let settled = false;
      let safetyTimer = null;

      const doContinue = async (headers) => {
        if (settled) return;
        settled = true;
        if (safetyTimer) {
          clearTimeout(safetyTimer);
          safetyTimer = null;
        }
        this.inFlight.delete(requestId);
        if (sessionId && this.inFlightBySession.has(sessionId)) {
          const s = this.inFlightBySession.get(sessionId);
          s.delete(requestId);
          if (s.size === 0) this.inFlightBySession.delete(sessionId);
        }

        try {
          const params = { requestId };
          if (headers && Array.isArray(headers)) params.headers = headers;
          await this._sendCommand(connection, "Fetch.continueRequest", params, { sessionId, timeout: 6000 });
        } catch (_) {
          // If continuing with modified headers was rejected by CDP, fallback to raw continueRequest to avoid hanging
          try {
            await this._sendCommand(connection, "Fetch.continueRequest", { requestId }, { sessionId, timeout: 3000 });
          } catch (_) {}
        }
      };

      // Fail-open timeout guard: if anything stalls, resume after 7 seconds
      safetyTimer = setTimeout(() => {
        if (!settled) {
          doContinue().catch(() => {});
        }
      }, 7000);
      if (typeof safetyTimer.unref === "function") safetyTimer.unref();

      try {
        if (!this.enabled || !this.persona) {
          return await doContinue();
        }

        const url = String(request?.url || ""); if (url.includes("sw") || url.includes("worker")) console.log("[REWRITER URL]", url, "resourceType:", event.params?.resourceType);
        // Filter internal browser schemes: chrome, devtools, data, blob, about, etc.
        if (/^(chrome|chrome-extension|edge|edge-extension|devtools|data|blob|about|javascript|filesystem|view-source|isolated-app):/i.test(url)) {
          return await doContinue();
        }

        const reqHeaders = request?.headers || {};
        const method = String(request?.method || "GET").toUpperCase();

        // Filter WebSocket upgrades: modifying headers can break native WebSocket handshake
        let isWs = false;
        for (const [hk, hv] of Object.entries(reqHeaders)) {
          if (hk.toLowerCase() === "upgrade" && String(hv).toLowerCase() === "websocket") {
            isWs = true;
            break;
          }
        }
        if (isWs) {
          return await doContinue();
        }

        const otherHeaders = [];
        const existingKeys = new Set();
        const seenNames = new Set();

        for (const [k, v] of Object.entries(reqHeaders)) {
          const lk = k.toLowerCase();
          existingKeys.add(lk);
          // Strip all host User-Agent, Accept-Language, and any Client Hints (sec-ch-ua*)
          if (
            lk === "user-agent" ||
            lk === "accept-language" ||
            lk.startsWith("sec-ch-ua")
          ) {
            continue;
          }
          if (seenNames.has(lk)) continue;
          seenNames.add(lk);
          otherHeaders.push({ name: k, value: String(v) });
        }

        // Real iOS WebKit never implements or sends User-Agent Client Hints (sec-ch-ua*).
        // Sending sec-ch-ua-platform: "iOS" is an immediate adversarial red-team dead giveaway.
        const isIos = this.persona.platform === "iOS"
          || this.persona.platformNav === "iPhone"
          || this.persona.platformNav === "iPad"
          || /iphone|ipad|ipod|ios/i.test(this.persona.platformNav || "")
          || /iphone|ipad|ipod/i.test(this.persona.userAgent || "");

        const secChUaHeaders = [];
        if (!isIos) {
          if (this.secChUa) {
            secChUaHeaders.push({ name: "sec-ch-ua", value: this.secChUa });
          }
          secChUaHeaders.push({ name: "sec-ch-ua-mobile", value: this.persona.mobile ? "?1" : "?0" });
          if (this.persona.platform) {
            secChUaHeaders.push({ name: "sec-ch-ua-platform", value: "\"" + this.persona.platform + "\"" });
          }

          // High-entropy User-Agent Client Hints (ONLY populated if server requested via Accept-CH)
          const meta = this.persona.metadata || {};

          if (existingKeys.has("sec-ch-ua-arch")) {
            const arch = meta.architecture !== undefined ? meta.architecture : (this.persona.platform === "Android" ? "" : "x86");
            secChUaHeaders.push({ name: "sec-ch-ua-arch", value: "\"" + arch + "\"" });
          }
          if (existingKeys.has("sec-ch-ua-bitness")) {
            const bitness = meta.bitness !== undefined ? meta.bitness : (this.persona.platform === "Android" ? "" : "64");
            secChUaHeaders.push({ name: "sec-ch-ua-bitness", value: "\"" + bitness + "\"" });
          }
          if (existingKeys.has("sec-ch-ua-model")) {
            const model = meta.model !== undefined ? meta.model : "";
            secChUaHeaders.push({ name: "sec-ch-ua-model", value: "\"" + model + "\"" });
          }
          if (existingKeys.has("sec-ch-ua-platform-version")) {
            const pv = meta.platformVersion !== undefined ? meta.platformVersion : "15.0.0";
            secChUaHeaders.push({ name: "sec-ch-ua-platform-version", value: "\"" + pv + "\"" });
          }
          if (existingKeys.has("sec-ch-ua-full-version")) {
            const fv = meta.fullVersion || meta.uaFullVersion || "148.0.0.0";
            secChUaHeaders.push({ name: "sec-ch-ua-full-version", value: "\"" + fv + "\"" });
          }
          if (existingKeys.has("sec-ch-ua-full-version-list")) {
            secChUaHeaders.push({ name: "sec-ch-ua-full-version-list", value: this.secChUaFullVersionList });
          }
          if (existingKeys.has("sec-ch-ua-form-factors")) {
            const ff = meta.formFactors || meta.form_factors;
            if (ff) {
              const val = Array.isArray(ff) ? ff.map((f) => "\"" + f + "\"").join(", ") : "\"" + ff + "\"";
              secChUaHeaders.push({ name: "sec-ch-ua-form-factors", value: val });
            } else if (this.persona.mobile) {
              secChUaHeaders.push({ name: "sec-ch-ua-form-factors", value: "\"Mobile\"" });
            }
          }
          if (existingKeys.has("sec-ch-ua-wow64")) {
            secChUaHeaders.push({ name: "sec-ch-ua-wow64", value: meta.wow64 ? "?1" : "?0" });
          }
        }

        let userAgentHeader = null;
        if (this.persona.userAgent) {
          userAgentHeader = { name: "User-Agent", value: this.persona.userAgent };
        }

        let acceptLanguageHeader = null;
        if (this.persona.acceptLanguage && (method !== "OPTIONS" || existingKeys.has("accept-language"))) {
          acceptLanguageHeader = { name: "Accept-Language", value: this.persona.acceptLanguage };
        }

        const newHeaders = [...otherHeaders];
        if (secChUaHeaders.length > 0) {
          newHeaders.push(...secChUaHeaders);
        }
        if (userAgentHeader) {
          newHeaders.push(userAgentHeader);
        }
        if (acceptLanguageHeader) {
          newHeaders.push(acceptLanguageHeader);
        }

        const indexedHeaders = newHeaders.map((h, idx) => {
          const lk = (h && typeof h.name === "string") ? h.name.toLowerCase() : "";
          const canonicalRank = CHROMIUM_CANONICAL_HEADER_INDEX.has(lk)
            ? CHROMIUM_CANONICAL_HEADER_INDEX.get(lk)
            : (1000 + idx);
          return { header: h, rank: canonicalRank, originalIndex: idx };
        });

        indexedHeaders.sort((a, b) => {
          if (a.rank !== b.rank) return a.rank - b.rank;
          return a.originalIndex - b.originalIndex;
        });

        const sortedHeaders = indexedHeaders.map((item) => item.header);

        await doContinue(sortedHeaders);
      } catch (err) {
        if (this.logger) {
          try { this.logger({ type: "request-rewrite-error", error: err.message, url: request?.url }); } catch (_) {}
        }
        await doContinue();
      }
    })();
  }
}

function createRequestHeaderRewriter(options = {}) {
  return new RequestHeaderRewriter(options);
}


function normalizePlatformFamily(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  if (s.includes('win')) return 'windows';
  if (s.includes('mac') || s.includes('darwin')) return 'macos';
  if (s.includes('android')) return 'android';
  if (s.includes('linux') || s.includes('x11')) return 'linux';
  if (s.includes('iphone') || s.includes('ipad') || s.includes('ipod') || s.includes('ios')) return 'ios';
  return s;
}

function detectUaPlatform(ua) {
  if (!ua || typeof ua !== 'string') return null;
  const s = ua.toLowerCase();
  if (s.includes('windows nt') || s.includes('win64') || s.includes('wow64') || s.includes('windows')) return 'windows';
  if (s.includes('macintosh') || s.includes('mac os x') || s.includes('macos')) return 'macos';
  if (s.includes('android')) return 'android';
  if (s.includes('linux') || s.includes('x11')) return 'linux';
  if (s.includes('iphone') || s.includes('ipad') || s.includes('cpu os')) return 'ios';
  return null;
}

function extractChromeMajor(ua) {
  if (!ua || typeof ua !== 'string') return null;
  const m = String(ua).match(/Chrome\/(\d+)/i);
  return m ? Number(m[1]) : null;
}

function extractGpuBrand(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.toLowerCase();
  if (s.includes('nvidia') || s.includes('geforce') || s.includes('quadro') || s.includes('rtx') || s.includes('gtx')) return 'nvidia';
  if (s.includes('apple') || /\bm[1-9]\b/i.test(s) || s.includes('apple m')) return 'apple';
  if (s.includes('amd') || s.includes('radeon')) return 'amd';
  if (s.includes('intel') || s.includes('iris') || s.includes('arc') || s.includes('uhd') || s.includes('hd graphics')) return 'intel';
  if (s.includes('qualcomm') || s.includes('adreno')) return 'qualcomm';
  if (s.includes('mali')) return 'mali';
  if (s.includes('swiftshader') || s.includes('llvmpipe')) return 'software';
  return null;
}

function normalizeTimezone(tz) {
  if (!tz || typeof tz !== 'string') return '';
  let s = tz.trim().toLowerCase();
  if (s.startsWith('etc/')) s = s.slice(4);
  if (s === 'gmt' || s === 'utc' || s === 'z') return 'utc';
  return s;
}

function extractPrimaryLanguage(val) {
  if (Array.isArray(val)) {
    for (const item of val) {
      const res = extractPrimaryLanguage(item);
      if (res) return res;
    }
    return null;
  }
  if (!val || typeof val !== 'string') return null;
  const first = val.split(/[,;]/)[0].trim();
  if (!first || first.toLowerCase() === 'system' || first.toLowerCase() === 'real') return null;
  return first.toLowerCase().replace(/_/g, '-');
}

function evaluateFingerprintDelivery(profile = {}, fingerprint = {}, liveProbe = null) {
  const mismatches = [];
  const warnings = [];

  // 1. Probe error or missing live data: WARN only, do not fail
  if (!liveProbe || liveProbe.probeError) {
    warnings.push(liveProbe?.probeError ? ("探针返回异常: " + liveProbe.probeError) : "探针未返回数据 (undefined)");
    return { ok: true, mismatches: [], warnings };
  }

  const privacy = profile?.privacy || {};

  // 2. Platform / OS verification
  const expectedPlatform = fingerprint?.platform || profile?.platform || '';
  const expectedOs = profile?.os || fingerprint?.uaProfile?.os || '';
  const expectedFamily = normalizePlatformFamily(expectedOs) || normalizePlatformFamily(expectedPlatform);

  if (expectedFamily && liveProbe.platform) {
    const liveFamily = normalizePlatformFamily(liveProbe.platform);
    if (liveFamily && liveFamily !== expectedFamily) {
      mismatches.push({
        field: 'platform',
        expected: expectedFamily,
        actual: liveProbe.platform,
        message: "平台不符：期望 " + expectedFamily + " (" + (expectedPlatform || expectedOs) + ")，实际交付 " + liveProbe.platform,
      });
    }
  }

  // 3. User-Agent verification (Key fragments: platform segment, Chrome major)
  const expectedUa = String(fingerprint?.userAgent || profile?.userAgent || '').trim();
  const liveUa = String(liveProbe.userAgent || '').trim();

  if (expectedUa && liveUa) {
    const expectedUaPlat = detectUaPlatform(expectedUa);
    const liveUaPlat = detectUaPlatform(liveUa);
    if (expectedUaPlat && liveUaPlat && expectedUaPlat !== liveUaPlat) {
      mismatches.push({
        field: 'userAgent.platform',
        expected: expectedUaPlat,
        actual: liveUaPlat,
        message: "UA 平台段不符：期望包含 " + expectedUaPlat + "，实际交付 " + liveUaPlat,
      });
    }

    const expectedMajor = extractChromeMajor(expectedUa);
    const liveMajor = extractChromeMajor(liveUa);
    if (expectedMajor != null && liveMajor != null && expectedMajor !== liveMajor) {
      mismatches.push({
        field: 'userAgent.chromeMajor',
        expected: expectedMajor,
        actual: liveMajor,
        message: "UA Chrome 主版本不符：期望 Chrome/" + expectedMajor + "，实际交付 Chrome/" + liveMajor,
      });
    }
  }

  // 4. navigator.userAgentData?.platform vs UA / configured platform
  if (liveProbe.uaDataPlatform) {
    const liveUaDataFamily = normalizePlatformFamily(liveProbe.uaDataPlatform);
    const uaOrConfigFamily = detectUaPlatform(expectedUa) || expectedFamily;
    if (uaOrConfigFamily && liveUaDataFamily && uaOrConfigFamily !== liveUaDataFamily) {
      mismatches.push({
        field: 'userAgentData.platform',
        expected: uaOrConfigFamily,
        actual: liveProbe.uaDataPlatform,
        message: "Client Hints 平台与 UA 不符：期望 " + uaOrConfigFamily + "，实际交付 " + liveProbe.uaDataPlatform,
      });
    }
  }

  // 5. Timezone verification
  const isRealTimezone = privacy.timezoneMode === 'real' || profile?.timezoneMode === 'real';
  if (!isRealTimezone) {
    const expectedTz = String(fingerprint?.timezone || profile?.exitTimezone || privacy.timezone || '').trim();
    const liveTz = String(liveProbe.timezone || '').trim();
    if (expectedTz && liveTz && expectedTz.toLowerCase() !== 'real') {
      if (normalizeTimezone(expectedTz) !== normalizeTimezone(liveTz)) {
        mismatches.push({
          field: 'timezone',
          expected: expectedTz,
          actual: liveTz,
          message: "时区不符：期望 " + expectedTz + "，实际交付 " + liveTz,
        });
      }
    }
  }

  // 6. WebGL Vendor & Renderer
  const webglMode = String(privacy.webgl || fingerprint?.webgl?.mode || '').toLowerCase();
  const webglMetaMode = String(privacy.webglMeta || fingerprint?.webgl?.metaMode || '').toLowerCase();
  const isRealWebgl = webglMode === 'real' || webglMode === 'off' || webglMetaMode === 'real' || webglMetaMode === 'off';

  if (!isRealWebgl) {
    const liveRenderer = liveProbe.webglRenderer;
    const liveVendor = liveProbe.webglVendor;

    if (!liveRenderer && !liveVendor) {
      // No WebGL context (headless / no GPU) -> WARN ONLY
      warnings.push("WebGL 无可用上下文 (可能为无头环境或无GPU加速)，跳过 WebGL 交付校验");
    } else {
      const expectedRenderer = String(fingerprint?.webgl?.renderer || profile?.webglRenderer || '').trim();
      const expectedVendor = String(fingerprint?.webgl?.vendor || profile?.webglVendor || '').trim();

      if (expectedRenderer || expectedVendor) {
        const expBrand = extractGpuBrand(expectedRenderer) || extractGpuBrand(expectedVendor);
        const liveBrand = extractGpuBrand(liveRenderer) || extractGpuBrand(liveVendor);

        if (expBrand && liveBrand && expBrand !== liveBrand) {
          mismatches.push({
            field: 'webgl',
            expected: expBrand + " (" + (expectedRenderer || expectedVendor) + ")",
            actual: liveBrand + " (" + (liveRenderer || liveVendor) + ")",
            message: "WebGL GPU 身份不符：期望 " + expBrand + "，实际交付 " + liveBrand,
          });
        }
      }
    }
  }

  // 7. Languages (first language)
  // The language mode may arrive either as privacy.languageMode or as a profile.language
  // sentinel ('system'/'real'); a resolved profile.language value (e.g. 'ja-JP') must NOT be
  // treated as a mode. Recognise the mode from either source without letting a real value in.
  const profileLangField = String(profile?.language || '').trim().toLowerCase();
  const explicitLangMode = String(privacy.languageMode || '').trim().toLowerCase();
  const isSystemLanguage = explicitLangMode === 'system' || explicitLangMode === 'real'
    || profileLangField === 'system' || profileLangField === 'real';

  if (!isSystemLanguage) {
    const expectedLang = extractPrimaryLanguage(fingerprint?.languages || profile?.language);
    const liveLang = extractPrimaryLanguage(liveProbe.languages || liveProbe.language);

    if (expectedLang && liveLang) {
      if (expectedLang !== liveLang) {
        const expBase = expectedLang.split('-')[0];
        const liveBase = liveLang.split('-')[0];
        if (expBase !== liveBase) {
          mismatches.push({
            field: 'languages',
            expected: expectedLang,
            actual: liveLang,
            message: "首选语言不符：期望 " + expectedLang + "，实际交付 " + liveLang,
          });
        }
      }
    }
  }

  // 8. Hardware Concurrency & Device Memory (explicitly specified only)
  const rawCores = privacy.cores ?? profile?.cores ?? privacy.fingerprint?.cores;
  const explicitCores = (rawCores !== '' && rawCores !== null && rawCores !== undefined) ? Number(rawCores) : NaN;
  if (Number.isFinite(explicitCores) && explicitCores > 0) {
    const liveCores = Number(liveProbe.hardwareConcurrency);
    if (Number.isFinite(liveCores) && liveCores !== Math.round(explicitCores)) {
      mismatches.push({
        field: 'hardwareConcurrency',
        expected: Math.round(explicitCores),
        actual: liveCores,
        message: "CPU 核心数不符：期望 " + Math.round(explicitCores) + "，实际交付 " + liveCores,
      });
    }
  }

  const rawMemory = privacy.memory ?? profile?.memory ?? privacy.fingerprint?.memory;
  const explicitMemory = (rawMemory !== '' && rawMemory !== null && rawMemory !== undefined) ? Number(rawMemory) : NaN;
  if (Number.isFinite(explicitMemory) && explicitMemory > 0) {
    const liveMemory = Number(liveProbe.deviceMemory);
    if (Number.isFinite(liveMemory) && liveMemory !== Number(explicitMemory)) {
      mismatches.push({
        field: 'deviceMemory',
        expected: explicitMemory,
        actual: liveMemory,
        message: "设备内存不符：期望 " + explicitMemory + "GB，实际交付 " + liveMemory + "GB",
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    warnings,
  };
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
    this.lifecycleGenerations = new Map();
    this.lifecycleStopRequests = new Map();
    this.stopAllPromise = null;
    this.stopAllInProgress = false;
    this._persistQueue = Promise.resolve();
    this.networkInfo = new Map();
    // The proxy library is loaded by the automation layer after engine.init().
    // Keep the reference here so linked profiles always resolve their current
    // credentials at sync/start time instead of relying on renderer storage.
    this.proxyStore = null;
    this.deliveryVerificationFailures = new Map();
    this.deliveryVerificationFailureTimestamps = new Map();
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
      for (const extension of saved.extensions || []) {
        if (fs.existsSync(extension.path)) {
          try {
            const refreshed = await this.readExtension(extension.path, Boolean(extension.builtIn));
            refreshed.addedAt = extension.addedAt || refreshed.addedAt;
            this.extensions.set(refreshed.id, refreshed);
          } catch (_) {
            this.extensions.set(extension.id, extension);
          }
        }
      }
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

  resolveStoredProxyProfile(incoming) {
    const profile = incoming && typeof incoming === 'object' ? incoming : null;
    if (!profile) return profile;
    const direct = profile.networkMode === 'direct' || /^(?:direct|offline|none)$/i.test(String(profile.proxy || '').trim());
    const association = profileProxyAssociation(profile);
    const proxyId = direct ? null : normalizedProxyAssociationId(association.value);
    if (!proxyId) {
      return this.sanitizeProfile({
        ...profile,
        proxyId: null,
        proxyMeta: { ...(profile.proxyMeta || {}), proxyId: null },
      });
    }
    if (!this.proxyStore) {
      return this.sanitizeProfile({
        ...profile,
        proxyId,
        proxyMeta: { ...(profile.proxyMeta || {}), proxyId },
      });
    }
    const item = this.proxyStore.get?.(proxyId);
    if (!item?.raw) {
      // A deleted library entry must not leave a ghost association that later
      // overwrites Direct/manual proxy edits. Keep the last raw endpoint as a
      // manual proxy and remove every accepted association alias via sanitize.
      return this.sanitizeProfile({
        ...profile,
        proxyId: null,
        proxyMeta: { ...(profile.proxyMeta || {}), proxyId: null },
      });
    }
    return this.sanitizeProfile({
      ...profile,
      networkMode: 'proxy',
      proxy: item.raw,
      proxyId: item.id,
      proxyMeta: {
        ...(profile.proxyMeta || {}),
        proxyId: item.id,
        ipChannel: item.ipChannel || profile.proxyMeta?.ipChannel || 'ip-api',
        refreshUrl: item.refreshUrl || profile.proxyMeta?.refreshUrl || '',
      },
    });
  }

  async setProxyStore(proxyStore) {
    this.proxyStore = proxyStore || null;
    if (!this.proxyStore) return false;
    let changed = false;
    for (const [id, profile] of this.profiles) {
      const next = this.resolveStoredProxyProfile(profile);
      if (!next || next.proxy === profile.proxy
        && next.proxyId === profile.proxyId
        && next.proxyMeta?.ipChannel === profile.proxyMeta?.ipChannel
        && next.proxyMeta?.refreshUrl === profile.proxyMeta?.refreshUrl) continue;
      this.profiles.set(id, next);
      changed = true;
    }
    if (changed) await this.persist();
    return changed;
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

  /**
   * Compare the installed kernel tree against the record written at install
   * time. Runs in the background on purpose: a missing or truncated file is
   * worth reporting, but never worth delaying startup for.
   */
  kernelIntegrityCheck() {
    if (typeof this.kernelManager.checkInstalledKernelIntegrity !== 'function') {
      return Promise.resolve({ status: 'unsupported' });
    }
    return this.kernelManager.checkInstalledKernelIntegrity();
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
    return sanitizeProfileData(value);
  }

  async syncProfiles(values) {
    if (!Array.isArray(values) || values.length > 1000) throw new Error('Invalid profile list');
    const existingIds = [...this.profiles.keys()];
    const globallyEnabled = existingIds.length ? [...this.extensions.keys()].filter((extensionId) => existingIds.every((profileId) => (this.assignments.get(profileId) || new Set()).has(extensionId))) : [];
    let assignmentsChanged = false;
    const incomingIds = new Set();
    for (const value of values) {
      const sanitized = this.sanitizeProfile(value);
      const previous = this.profiles.get(sanitized.id);
      let profile = sanitized;
      if (previous && sanitized.proxyId && previous.proxyId === sanitized.proxyId) {
        const stored = this.proxyStore?.get?.(sanitized.proxyId);
        const matchesPrevious = sameProxyIdentity(sanitized.proxy, previous.proxy)
          || (!proxyHasCredentials(sanitized.proxy) && sameProxyEndpoint(sanitized.proxy, previous.proxy));
        const matchesStored = Boolean(stored?.raw) && (
          sameProxyIdentity(sanitized.proxy, stored.raw)
          || (!proxyHasCredentials(sanitized.proxy) && sameProxyEndpoint(sanitized.proxy, stored.raw))
        );
        if (!matchesPrevious && !matchesStored) {
          // A linked profile whose endpoint/auth was manually edited becomes a
          // manual proxy. This prevents the old library id from overwriting it.
          profile = this.sanitizeProfile({
            ...sanitized,
            proxyId: null,
            proxyMeta: { ...(sanitized.proxyMeta || {}), proxyId: null },
          });
        }
      }
      profile = this.resolveStoredProxyProfile(profile);
      const isNew = !previous;
      // UI may send redacted proxy (no auth) after localStorage reload. Prefer previous
      // authenticated form only when host:port match and incoming lacks credentials.
      let merged = profile;
      if (previous) {
        const nextProxy = String(profile.proxy || '');
        const prevProxy = String(previous.proxy || '');
        const nextHasAuth = proxyHasCredentials(nextProxy);
        const prevHasAuth = proxyHasCredentials(prevProxy);
        const explicitlyCleared = String(value?.proxyAuthAction ?? value?.proxy_auth_action ?? '').toLowerCase() === 'clear';
        if (!explicitlyCleared && !nextHasAuth && prevHasAuth && sameProxyEndpoint(prevProxy, nextProxy)) {
          merged = this.sanitizeProfile({ ...profile, proxy: prevProxy });
        }
        // Restore cookies/platform secrets only when UI clearly redacted ALL of them
        // (post-localStorage load) while engine still holds values — not when user
        // intentionally cleared a single field in the editor.
        const secretAction = String(value?.secretsAction ?? value?.credentialsAction ?? '').trim().toLowerCase();
        const explicitSecretUpdate = value?.__secretsExplicit === true
          || secretAction === 'replace'
          || secretAction === 'clear';
        const uiLooksRedacted = !explicitSecretUpdate
          && !String(profile.cookies || '').trim()
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
    prefs.devtools ||= {};
    prefs.devtools.preferences ||= {};
    prefs.policy ||= {};
    prefs.policy.developer_tools_availability = 1;
    prefs.DeveloperToolsAvailability = 1;
    const content = prefs.profile.default_content_setting_values;
    content.fullscreen = 1;
    content.automatic_fullscreen = 1;
    content.window_placement = 1;
    content.window_management = 1;
    prefs.fullscreen ||= {};
    prefs.fullscreen.allowed = true;
    prefs.profile.content_settings ||= {};
    prefs.profile.content_settings.exceptions ||= {};
    const exceptions = prefs.profile.content_settings.exceptions;
    for (const key of ['fullscreen', 'automatic_fullscreen', 'window_placement', 'window_management']) {
      exceptions[key] ||= {};
      exceptions[key]['*,*'] = { setting: 1 };
      exceptions[key]['[*.]*,*'] = { setting: 1 };
    }
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
    applyLanguagePreferences(prefs, profile);
    prefs.webkit ||= {}; prefs.webkit.webprefs ||= {};
    if (profile.privacy.fontMode === 'custom') prefs.webkit.webprefs.default_font_size = profile.privacy.fontSize;
    else delete prefs.webkit.webprefs.default_font_size;
    prefs.bookmark_bar ||= {};
    prefs.bookmark_bar.show_on_all_tabs = Boolean(profile.advanced.showBookmarkBar);
    if (profile.advanced.blockRestoreDialog) {
      prefs.session ||= {};
      prefs.session.restore_on_startup = profile.advanced.tabMode === 'restore' || profile.advanced.restoreSession ? 1 : 5;
    }
    await writeRawAtomically(file, JSON.stringify(prefs), 0o600);
    try {
      const persisted = JSON.parse(await fsp.readFile(file, 'utf8'));
      const issues = verifyLanguagePreferences(persisted, profile);
      if (issues.length && typeof this.emit === 'function') {
        this.emit({ type: 'profile-file-sync-error', id: profile.id, key: 'language', issues });
      }
      return { issues };
    } catch (error) {
      if (typeof this.emit === 'function') {
        this.emit({ type: 'profile-file-sync-error', id: profile.id, key: 'language', message: error.message });
      }
      return { issues: [{ key: 'profile.preferences', expected: 'readable', actual: error.message }] };
    }
  }

  /**
   * Pre-spawn profile file prep, parallelized. resetZoom + applyProfilePreferences both
   * read-modify-write Default/Preferences, so they MUST stay serialized relative to each
   * other (else the later write clobbers the earlier one — lost update). Everything else
   * only rm's disjoint paths (Sessions / cache dirs / retained data files) and can overlap,
   * shortening the launch critical path (scales with disk latency and profile size).
   */
  async prepareProfileFilesForStart(root, profile, restoreSession) {
    await removeSingletonFiles(root, { attempts: 6, delayMs: 40 });
    const lockF = path.join(root, '.openbrowser-instance.lock');
    if (fs.existsSync(lockF)) {
      try {
        const content = JSON.parse(await fsp.readFile(lockF, 'utf8'));
        if (content?.pid && !isPidAlive(content.pid)) {
          await fsp.rm(lockF, { force: true }).catch(() => {});
        }
      } catch (_) {
        await fsp.rm(lockF, { force: true }).catch(() => {});
      }
    }
    const jobs = [
      // Shared-file chain: resetZoom then applyProfilePreferences, ordered.
      (async () => { await this.resetZoom(root); await this.applyProfilePreferences(root, profile); })(),
      this.enforceDataRetention(root, profile),
      (async () => {
        try {
          await syncProfileLocalState(root, profile);
        } catch (err) {
          if (typeof this.emit === 'function') {
            this.emit({
              type: 'profile-file-sync-error',
              id: profile.id,
              key: 'local_state',
              code: err.code || 'PROFILE_LOCAL_STATE_MISMATCH',
              message: err.message,
              issues: err.issues,
            });
          }
          throw err;
        }
      })(),
    ];
    if (!restoreSession) jobs.push(this.resetTabs(root));
    if (profile.advanced.clearCacheOnStart) jobs.push(this.clearProfileCache(root));
    await Promise.all(jobs);
  }

  resolveStartupUrls(profile) {
    const urls = [];
    // blank page: no platform URL
    if (String(profile.platform?.type || '') !== 'blank') {
      const rootStartUrl = String(profile.startUrl || '').trim();
      if (rootStartUrl) urls.push(rootStartUrl);
      const platformUrl = String(profile.platform?.startUrl || '').trim();
      if (platformUrl && !urls.includes(platformUrl)) urls.push(platformUrl);
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
    const fpHash = fingerprintConfigHash(fp);
    // Track which CDP page targets already received inject (new tabs must not skip FP)
    const applied = options.appliedTargetIds instanceof Set ? options.appliedTargetIds : new Set();
    // Only a recorded hash may invalidate the cache: callers that never tracked one keep the
    // previous behaviour, while a real config change forces every live tab to be re-applied.
    const configChanged = Boolean(options.appliedFingerprintHash)
      && options.appliedFingerprintHash !== fpHash;
    if (configChanged) applied.clear();
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
      portScanScript = buildPortScanProtectionScript(profile.privacy.portScanAllow);
    }

    // Re-injecting a document that already carries this exact config stacks a second layer of
    // noise on the readers, which moves canvas / clientRects while the profile is already in use,
    // so a pass only covers tabs that are unmarked or that carry a different config. Recovery of
    // a single suspect tab goes through applyFingerprintToTab directly instead.
    const force = configChanged;
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
        options.trackOn.fpAppliedHash = fpHash;
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
        const fontBlobBridge = fp?.fontBlobBridge || options?.trackOn?.fontBlobBridge || options?.trackOn?.fingerprint?.fontBlobBridge;
        if (fontBlobBridge?.channelName && tab.webSocketDebuggerUrl) {
          if (options?.trackOn) { options.trackOn.fontBlobBridge = fontBlobBridge; options.trackOn.fingerprint = fp; }
          try {
            await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.enable', {}).catch(() => {});
            await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.addBinding', { name: fontBlobBridge.channelName }).catch((err) => {
              const msg = String(err?.message || err);
              if (!/already exists/i.test(msg)) {}
            });
          } catch (_) {}
        }
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
          url: sanitizeUrlForLog(tab.url).slice(0, 240),
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
            await applyFingerprintToTab(cdp.call, tab.webSocketDebuggerUrl, fp, enriched, { force: true });
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
          url: sanitizeUrlForLog(tab.url).slice(0, 240),
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
      options.trackOn.fpAppliedHash = fpHash;
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
    const isSubframe = targetInfo?.type === 'iframe';
    const isWaiting = Boolean(targetInfo?.waitingForDebugger || targetInfo?.isWaiting || !targetInfo?.url || targetInfo?.url === 'about:blank');
    const sessionCall = async (method, params = {}, timeout = 8000) => {
      try {
        // Optimization: on targets paused waiting for debugger at startup, Runtime.evaluate
        // blocks until Runtime.runIfWaitingForDebugger is called, hanging for 6-8s timeout.
        // Page.addScriptToEvaluateOnNewDocument already guarantees sync execution on document start.
        if (isWaiting && method === 'Runtime.evaluate') {
          return {};
        }
        return await connection.command(method, params, { sessionId, timeout });
      } catch (err) {
        if (isSubframe && /Command can only be executed on top-level targets|Cannot find default execution context/i.test(String(err?.message || err))) {
          return {};
        }
        throw err;
      }
    };
    const fontBlobBridge = injectFp?.fontBlobBridge || baseFp?.fontBlobBridge || item?.fontBlobBridge || item?.fingerprint?.fontBlobBridge;
    if (fontBlobBridge?.channelName) {
      if (!item.fontBlobBridge) item.fontBlobBridge = fontBlobBridge;
      try {
        await sessionCall('Runtime.enable', {}).catch(() => {});
        await sessionCall('Runtime.addBinding', { name: fontBlobBridge.channelName }).catch((err) => {
          const msg = String(err?.message || err);
          if (!/already exists/i.test(msg)) {
            // ignore non-fatal binding errors
          }
        });
      } catch (_) {}
    }
    await applyFingerprintToTab(sessionCall, null, injectFp, enriched, {
      applyKey: `session:${targetInfo?.targetId || sessionId}`,
      targetType: targetInfo?.type,
      isSubframe,
    });
    // Synchronize Blink physical layout scaling with target devicePixelRatio for desktop personas.
    // Without setDeviceMetricsOverride, Blink computes CSS @media (resolution) at host 1dppx,
    // creating an observable contradiction with window.devicePixelRatio and JS matchMedia.
    const dpr = Number(injectFp?.screen?.devicePixelRatio);
    if (dpr && dpr !== 1 && !injectFp?.mobileDevice && !isSubframe && targetInfo?.type !== 'iframe') {
      await sessionCall('Emulation.setDeviceMetricsOverride', {
        width: 0,
        height: 0,
        deviceScaleFactor: dpr,
        mobile: false,
      }).catch(() => {});
    }
    if (!item.fpAppliedTargets) item.fpAppliedTargets = new Set();
    if (targetInfo?.targetId) item.fpAppliedTargets.add(targetInfo.targetId);
    item.fpAppliedHash = fingerprintConfigHash(injectFp);
    item.fingerprint = baseFp;
    return injectFp;
  }

  async startWorkerFingerprintInjection(item, fingerprint) {
    if (fingerprint && Object.keys(fingerprint).length > 0) {
      RequestHeaderRewriter.latestFingerprint = fingerprint;
    }
    if (item?.profile && Object.keys(item.profile).length > 0) {
      RequestHeaderRewriter.latestProfile = item.profile;
    }
    const workerPrivacy = (item.profile && item.profile.privacy) || {};
    const portScanSource = workerPrivacy.portScanProtect
      ? '\n' + buildPortScanProtectionScript(workerPrivacy.portScanAllow)
      : '';
    const fontPresenceSource = typeof buildWorkerFontPresenceSource === 'function'
      ? buildWorkerFontPresenceSource(fingerprint)
      : '';
    const source = buildWorkerInjectionScript(fingerprint)
      + portScanSource
      + (fontPresenceSource ? '\n' + fontPresenceSource : '');
    if (fingerprint?.fontBlobBridge && !item.fontBlobBridge) {
      item.fontBlobBridge = fingerprint.fontBlobBridge;
    }
    const browserWs = await cdp.browserSocket(item.port);
    // Response rewriting runs below the parser, before static HTML/CSS is turned into a
    // stylesheet. It complements the document gate, which only sees dynamic DOM/CSSOM writes.
    const fontResponseRewriter = createCssFontResponseRewriter({
      personaFonts: fingerprint?.fonts?.list || [],
      fingerprint,
      blockedFont: deriveFontPlaceholder(fingerprint),
      logger: (details) => {
        if (details?.type === 'handle-error' || details?.type === 'enable-error') {
          const errMsg = String(details?.error || '');
          if (/Can only get response body|No resource with given identifier/i.test(errMsg)) {
            return;
          }
          console.log("[FONT_REWRITER LOG]", details);
          item.cssFontResponseRewriteError = String(details.error || 'response rewrite error');
        }
      },
    });
    item.cssFontResponseRewriter = fontResponseRewriter;
    const requestHeaderRewriter = new RequestHeaderRewriter({
      profile: item.profile,
      fingerprint,
      logger: (details) => {
        if (details?.type === 'request-rewrite-error') {
          item.requestHeaderRewriteError = details.error;
        }
      },
    });
    item.requestHeaderRewriter = requestHeaderRewriter;
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
      this.emit({
        type: 'fingerprint-injection-failed',
        id: item.profile?.id,
        targetType: targetInfo.type || '',
        stage: 'worker-inject',
        operation: 'worker-inject',
        message: error.message,
      });
    };

    // Tracking for initial pre-existing target attach and fetch enablement barrier
    const workerSessionToTargetId = new Map();
    const pendingInitialTargets = new Set();
    const completedInitialTargets = new Set();
    let barrierResolve;
    let barrierReject;
    let barrierSettled = false;
    let barrierTimer = null;

    const barrierPromise = new Promise((resolve, reject) => {
      barrierResolve = resolve;
      barrierReject = reject;
    });

    const settleBarrier = (err) => {
      if (barrierSettled) return;
      barrierSettled = true;
      if (barrierTimer) {
        clearTimeout(barrierTimer);
        barrierTimer = null;
      }
      if (err) {
        barrierReject(err);
      } else {
        barrierResolve();
      }
    };

    const onAttached = (event, connection) => {
      // Font payload lazy-load host bridge (consumer side)
      if (event?.method === 'Runtime.bindingCalled') {
        const bridge = item?.fontBlobBridge || item?.fingerprint?.fontBlobBridge || fingerprint?.fontBlobBridge;
        if (bridge?.channelName && event.params?.name === bridge.channelName) {
          (async () => {
            try {
              let parsed = null;
              try {
                parsed = JSON.parse(event.params?.payload || '{}');
              } catch (_) {
                return;
              }
              const { action, platform, token, wanted } = parsed || {};
              const validTokens = new Set([
                bridge?.token,
                item?.fontBlobBridge?.token,
                item?.fingerprint?.fontBlobBridge?.token,
                fingerprint?.fontBlobBridge?.token,
              ].filter(Boolean));
              const isTokenValid = Boolean(token && (
                validTokens.has(token) ||
                (bridge?.channelName && bridge.channelName.startsWith('_') && token.startsWith(bridge.channelName.slice(1))) ||
                (event.params?.name && event.params.name.startsWith('_') && token.startsWith(event.params.name.slice(1)))
              ));
              // 安全校验：action 必须是 getFontBytes 且 token 必须有效
              if (action !== 'getFontBytes' || !isTokenValid) {
                return;
              }
              const targetPlatform = platform || bridge.platform || 'windows';
              const targetWanted = wanted || bridge.wanted || undefined;
              const payload = getPlatformFontPayload(targetPlatform, { wanted: targetWanted });
              const expr = `try {
                const targetFn = (typeof FontData !== 'undefined' && FontData?.prototype?.blob)
                  ? FontData.prototype.blob
                  : Function.prototype.toString;
                Function.prototype.toString.call(targetFn, ${JSON.stringify(token)}, 'provideBytes', ${JSON.stringify(payload)});
              } catch (_) {}`;
              const targetSessionId = event.sessionId;
              const cmdOptions = targetSessionId ? { sessionId: targetSessionId, timeout: 8000 } : { timeout: 8000 };
              const evalParams = {
                expression: expr,
                awaitPromise: false,
                returnByValue: false,
              };
              if (event.params?.executionContextId != null) {
                evalParams.contextId = event.params.executionContextId;
              }
              await connection.command('Runtime.evaluate', evalParams, cmdOptions).catch(async () => {
                if (evalParams.contextId != null) {
                  await connection.command('Runtime.evaluate', {
                    expression: expr,
                    awaitPromise: false,
                    returnByValue: false,
                  }, cmdOptions).catch(() => {});
                }
              });
            } catch (_) {}
          })();
          return;
        }
      }
      // Fetch.requestPaused at Request stage (responseStatusCode == null) is handled by
      // requestHeaderRewriter to guarantee that main-frame navigations, subresources, and workers
      // carry persona User-Agent, Client Hints (sec-ch-ua*), and Accept-Language without host leaks.
      if (event?.method === 'Fetch.requestPaused' && event.params?.requestId && event.params?.responseStatusCode == null) {
        try { requestHeaderRewriter.handleEvent(event, connection); } catch (_) {}
        return;
      }

      // Fetch.requestPaused is delivered on this same browser connection. It must be dispatched
      // before the Target branch below, otherwise a paused parser response can wait forever.
      try { fontResponseRewriter.handleEvent(event, connection); } catch (_) {}

      // Clean up in-flight requests when a target session detaches or closes
      if (event?.method === 'Target.detachedFromTarget') {
        const detachedSessionId = event.params?.sessionId;
        const detachedTargetId = event.params?.targetId || (detachedSessionId ? workerSessionToTargetId.get(detachedSessionId) : null);
        if (detachedTargetId && item.attachedWorkerTargets) {
          item.attachedWorkerTargets.delete(detachedTargetId);
        }
        if (detachedSessionId) {
          workerSessionToTargetId.delete(detachedSessionId);
          try { requestHeaderRewriter.cleanupSession(detachedSessionId); } catch (_) {}
          try { fontResponseRewriter.cleanupSession?.(detachedSessionId); } catch (_) {}
        }
        return;
      }

      // If an initial target closes before attaching, unblock barrier without hanging
      if (event?.method === 'Target.targetDestroyed') {
        const destroyedId = event.params?.targetId;
        if (destroyedId && item.attachedWorkerTargets) {
          item.attachedWorkerTargets.delete(destroyedId);
        }
        if (destroyedId && pendingInitialTargets.has(destroyedId)) {
          pendingInitialTargets.delete(destroyedId);
          if (pendingInitialTargets.size === 0) {
            settleBarrier();
          }
        }
        return;
      }

      if (event.method !== 'Target.attachedToTarget') return;
      const { sessionId, targetInfo = {}, waitingForDebugger } = event.params || {};
      if (!sessionId) return;
      const targetId = targetInfo.targetId;
      if (targetId) workerSessionToTargetId.set(sessionId, targetId);
      const isInitial = Boolean(targetId && pendingInitialTargets.has(targetId));

      (async () => {
        try {
          const pageLikeTypes = new Set(['page', 'iframe', 'popup', 'webview']);
          if (targetInfo.type === 'page' || targetInfo.type === 'iframe' || pageLikeTypes.has(targetInfo.type)) {
            // Nested attach so workers/iframes under this page also pause for inject.
            await connection.command('Target.setAutoAttach', {
              autoAttach: true,
              waitForDebuggerOnStart: true,
              flatten: true,
            }, { sessionId }).catch(() => {});
            // Critical: inject fingerprint BEFORE resuming the page/iframe target.
            // Polling in startRunningWatch is only a fallback, not the primary path.
            await this.applyFingerprintToSession(connection, sessionId, item, fingerprint, { ...targetInfo, waitingForDebugger });
            // Enable Fetch while this page/iframe is paused. The next navigation then receives
            // sanitized HTML/CSS bytes before the renderer tokenizes its static styles.
            if (targetInfo.type !== 'iframe') {
              await fontResponseRewriter.enable(connection, { sessionId, timeout: 8000 });
              await connection.command('Fetch.enable', {
                patterns: [
                  { urlPattern: '*', requestStage: 'Request' },
                  { urlPattern: '*', requestStage: 'Response', resourceType: 'Document' },
                  { urlPattern: '*', requestStage: 'Response', resourceType: 'Stylesheet' },
                ],
              }, { sessionId, timeout: 8000 }).catch(() => {});
            }

            if (isInitial && !completedInitialTargets.has(targetId)) {
              completedInitialTargets.add(targetId);
              pendingInitialTargets.delete(targetId);
              if (pendingInitialTargets.size === 0) {
                settleBarrier();
              }
            }
            if (waitingForDebugger) {
              await connection.command('Runtime.runIfWaitingForDebugger', {}, { sessionId }).catch(() => {});
            }
          } else if (workerTypes.has(targetInfo.type) && !internalUrl.test(String(targetInfo.url || ''))) {
            if (!item.attachedWorkerTargets) item.attachedWorkerTargets = new Set();
            if (targetId && item.attachedWorkerTargets.has(targetId)) {
              if (waitingForDebugger) {
                await connection.command('Runtime.runIfWaitingForDebugger', {}, { sessionId }).catch(() => {});
              }
              return;
            }
            if (targetId) item.attachedWorkerTargets.add(targetId);
            const isServiceWorker = targetInfo.type === 'service_worker';
            if (!isServiceWorker) {
              await connection.command('Network.enable', {}, { sessionId }).catch(() => {});
              const workerUa = requestHeaderRewriter.enabled ? requestHeaderRewriter.persona : null;
              if (workerUa) {
                await connection.command('Network.setUserAgentOverride', {
                  userAgent: workerUa.userAgent,
                  acceptLanguage: workerUa.acceptLanguage,
                  platform: workerUa.platformNav || workerUa.platform,
                  userAgentMetadata: workerUa.metadata,
                }, { sessionId }).catch(() => {});
                await connection.command('Emulation.setUserAgentOverride', {
                  userAgent: workerUa.userAgent,
                  acceptLanguage: workerUa.acceptLanguage,
                  platform: workerUa.platformNav || workerUa.platform,
                  userAgentMetadata: workerUa.metadata,
                }, { sessionId }).catch(() => {});
              }
              await connection.command('Fetch.enable', {
                patterns: [{ urlPattern: '*', requestStage: 'Request' }],
              }, { sessionId, timeout: 8000 }).catch(() => {});
            }
            // Worker fingerprint injection (DedicatedWorker, SharedWorker, and ServiceWorker)
            // Evaluated before runIfWaitingForDebugger so the worker global scope carries persona
            // mocks before evaluating initial worker scripts. Short timeout guarantees no hang.
            await connection.command('Runtime.evaluate', {
              expression: source,
            }, { sessionId, timeout: 3000 }).catch((evalErr) => {
              report(evalErr, targetInfo);
            });
          }
        } catch (error) {
          report(error, targetInfo);
          this.emit({
            type: 'fingerprint-injection-failed',
            id: item.profile?.id,
            targetType: targetInfo.type || '',
            message: error.message,
          });
          if (isInitial) {
            settleBarrier(new Error(`Initial target session attach failed for ${targetId}: ${error.message}`));
          }
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
        try { requestHeaderRewriter.destroy(); } catch (_) {}
        try { fontResponseRewriter.destroy?.(); } catch (_) {}
        if (!barrierSettled) {
          settleBarrier(new Error(`CDP connection closed before initial target barrier resolved: ${error?.message || error}`));
        }
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

    const origClose = connection.close.bind(connection);
    connection.close = () => {
      try { requestHeaderRewriter.destroy(); } catch (_) {}
      try { fontResponseRewriter.destroy?.(); } catch (_) {}
      if (!barrierSettled) {
        settleBarrier(new Error('CDP connection closed before initial target barrier resolved'));
      }
      return origClose();
    };
    item.workerFingerprintConnection = connection;

    if (item.cleanedUp || item.stopping) {
      connection.close();
      throw new Error('Browser item is already stopping or cleaned up');
    }

    try {
      await connection.command('Target.setDiscoverTargets', { discover: true });

      // Identify existing targets before setAutoAttach to establish the initial target barrier
      let discoveredTargets = [];
      try {
        const targetsRes = await connection.command('Target.getTargets', {}, { timeout: 8000 });
        discoveredTargets = targetsRes?.targetInfos || [];
      } catch (_) {
        try {
          const fallbackTargets = await cdp.targets(item.port);
          discoveredTargets = fallbackTargets || [];
        } catch (_) {}
      }

      for (const t of discoveredTargets) {
        const tid = t.targetId || t.id;
        const ttype = t.type;
        const turl = String(t.url || '');
        const pageLikeTypes = new Set(['page', 'iframe', 'popup', 'webview']);
        if ((ttype === 'page' || ttype === 'iframe' || pageLikeTypes.has(ttype)) && !internalUrl.test(turl) && tid) {
          pendingInitialTargets.add(tid);
        }
      }

      if (pendingInitialTargets.size === 0) {
        settleBarrier();
      } else {
        barrierTimer = setTimeout(() => {
          const remaining = Array.from(pendingInitialTargets).join(', ');
          settleBarrier(new Error(`Initial target session attach barrier timed out after 8000ms (targets: ${remaining})`));
        }, 8000);
        if (typeof barrierTimer.unref === 'function') barrierTimer.unref();
      }

      await connection.command('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });

      // Synchronize on the initial target barrier before returning to prevent navigation race
      await barrierPromise;
    } catch (error) {
      settleBarrier(error);
      connection.close();
      if (item.workerFingerprintConnection === connection) {
        item.workerFingerprintConnection = null;
      }
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
    const resolvedTimezone = resolveProfileTimezone(profile, network);
    const tzMode = String(privacy.timezoneMode || 'ip').trim().toLowerCase();
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
      exitTimezone: tzMode === 'real' ? '' : (resolvedTimezone || network.timezone || profile.exitTimezone || ''),
      exitLatitude: network.latitude ?? profile.exitLatitude,
      exitLongitude: network.longitude ?? profile.exitLongitude,
    };
    if ((tzMode === 'ip' || tzMode === 'custom') && resolvedTimezone) {
      next.privacy = { ...next.privacy, timezone: resolvedTimezone };
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
      const url = String(tab.url || '');
      // Only apply to our own internal start page; never overwrite user pages or about:blank document.title
      if (!this.isStartPageUrl(url)) continue;
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
      appliedTargetIds: item?.fpAppliedTargets instanceof Set ? item.fpAppliedTargets : new Set(),
      appliedFingerprintHash: item?.fpAppliedHash,
      trackOn: item,
      phase: 'post-startpage',
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
      const fontBlobBridge = injectFp?.fontBlobBridge || profile?.fingerprint?.fontBlobBridge || item?.fontBlobBridge;
      if (fontBlobBridge?.channelName && page?.webSocketDebuggerUrl) {
        try {
          await cdp.call(page.webSocketDebuggerUrl, 'Runtime.enable', {}).catch(() => {});
          await cdp.call(page.webSocketDebuggerUrl, 'Runtime.addBinding', { name: fontBlobBridge.channelName }).catch((err) => {
            const msg = String(err?.message || err);
            if (!/already exists/i.test(msg)) {}
          });
        } catch (_) {}
      }
      await applyFingerprintToTab(cdp.call, page.webSocketDebuggerUrl, injectFp, profile, { force: true });
      await cdp.call(page.webSocketDebuggerUrl, 'Page.enable', {}).catch(() => {});
      if (startUrl) await cdp.call(page.webSocketDebuggerUrl, 'Page.navigate', { url: startUrl });
      else await cdp.call(page.webSocketDebuggerUrl, 'Page.reload', { ignoreCache: true });
      await sleep(600);
      await this.applyRuntimeSettings(port, profile, injectFp, {
        appliedTargetIds: item?.fpAppliedTargets instanceof Set ? item.fpAppliedTargets : new Set(),
        appliedFingerprintHash: item?.fpAppliedHash,
        trackOn: item,
        phase: 'post-reload',
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
   * 启动前 CDP 指纹交付校验：
   * 在导航目标站点/启动页之前，用 CDP 在初始页面执行单次探针 Runtime.evaluate，
   * 校验实际交付给页面的指纹值与配置是否存在直接矛盾。
   */
  async verifyStartupFingerprintDelivery(item, profile, fingerprint = null, options = {}) {
    const profileId = profile?.id || item?.profile?.id || 'unknown';
    const maxConsecutiveFailures = options.maxConsecutiveFailures || 3;
    const windowMs = options.failureWindowMs || (5 * 60 * 1000);

    const lastFailureTime = this.deliveryVerificationFailureTimestamps?.get(profileId) || 0;
    if (lastFailureTime > 0 && Date.now() - lastFailureTime > windowMs) {
      this.resetFingerprintVerificationFailures(profileId);
    }

    const priorFailures = this.deliveryVerificationFailures.get(profileId) || 0;

    if (priorFailures >= maxConsecutiveFailures) {
      const errorMsg = "同一环境连续指纹交付校验失败已达上限 (" + maxConsecutiveFailures + " 次)，已阻止访问目标站点";
      await fpLog('verify.delivery-blocked-consecutive-limit', {
        profileId,
        priorFailures,
        maxConsecutiveFailures,
      });
      return {
        ok: false,
        blocked: true,
        consecutiveLimitReached: true,
        mismatches: [{ field: 'consecutiveFailures', expected: "< " + maxConsecutiveFailures, actual: priorFailures, message: errorMsg }],
        message: errorMsg,
        warnings: [],
      };
    }

    const port = item?.port;
    if (!port && !options.probe && options.mockProbe === undefined) {
      return {
        ok: true,
        blocked: false,
        mismatches: [],
        warnings: ['未获取到调试端口，跳过指纹交付校验'],
        liveProbe: null,
      };
    }

    const timeout = Math.min(5000, Math.max(1000, Number(options.timeout) || 3500));
    let liveProbe = null;
    let probeWarning = null;

    if (typeof options.probe === 'function') {
      try {
        liveProbe = await options.probe();
      } catch (err) {
        probeWarning = "探针执行异常: " + (err?.message || String(err));
        liveProbe = { probeError: probeWarning };
      }
    } else if (options.mockProbe !== undefined) {
      liveProbe = options.mockProbe;
    } else {
      try {
        const tabs = await cdp.tabs(port).catch(() => []);
        // Probe initial blank tab or current start page tab
        const probeTab = tabs.find((t) => /about:blank/i.test(String(t.url || '')) || this.isStartPageUrl(t.url)) || tabs[0];
        if (!probeTab?.webSocketDebuggerUrl) {
          probeWarning = '未找到可用于探针校验的初始标签页';
          liveProbe = { probeError: probeWarning };
        } else {
          const probeRes = await cdp.call(probeTab.webSocketDebuggerUrl, 'Runtime.evaluate', {
            expression: LIVE_PROBE_EXPRESSION,
            returnByValue: true,
          }, timeout);
          liveProbe = probeRes?.result?.value || probeRes?.value || null;
        }
      } catch (err) {
        probeWarning = "CDP 探针执行异常: " + (err?.message || String(err));
        liveProbe = { probeError: probeWarning };
      }
    }

    const targetFp = fingerprint || item?.fingerprint || {};
    const evalResult = evaluateFingerprintDelivery(profile, targetFp, liveProbe);
    if (probeWarning && !evalResult.warnings.includes(probeWarning)) {
      evalResult.warnings.push(probeWarning);
    }

    await fpLog('verify.delivery-result', {
      profileId,
      ok: evalResult.ok,
      mismatchCount: evalResult.mismatches.length,
      warningCount: evalResult.warnings.length,
      mismatches: evalResult.mismatches,
      warnings: evalResult.warnings,
      liveProbeSummary: liveProbe ? {
        platform: liveProbe.platform,
        userAgent: liveProbe.userAgent ? String(liveProbe.userAgent).slice(0, 80) : null,
        uaDataPlatform: liveProbe.uaDataPlatform,
        timezone: liveProbe.timezone,
        webglVendor: liveProbe.webglVendor,
        webglRenderer: liveProbe.webglRenderer,
        languages: liveProbe.languages,
        hardwareConcurrency: liveProbe.hardwareConcurrency,
        deviceMemory: liveProbe.deviceMemory,
      } : null,
    });

    if (!evalResult.ok) {
      const newFailureCount = priorFailures + 1;
      const MAX_FAILURE_TRACK_SIZE = 200;
      if (this.deliveryVerificationFailures.has(profileId)) {
        this.deliveryVerificationFailures.delete(profileId);
        this.deliveryVerificationFailureTimestamps?.delete(profileId);
      } else if (this.deliveryVerificationFailures.size >= MAX_FAILURE_TRACK_SIZE) {
        const oldestKey = this.deliveryVerificationFailures.keys().next().value;
        if (oldestKey !== undefined) {
          this.deliveryVerificationFailures.delete(oldestKey);
          this.deliveryVerificationFailureTimestamps?.delete(oldestKey);
        }
      }
      this.deliveryVerificationFailures.set(profileId, newFailureCount);
      if (!this.deliveryVerificationFailureTimestamps) this.deliveryVerificationFailureTimestamps = new Map();
      this.deliveryVerificationFailureTimestamps.set(profileId, Date.now());
      const mismatchText = evalResult.mismatches.map((m) => m.message || String(m)).join('; ');
      return {
        ok: false,
        blocked: true,
        mismatches: evalResult.mismatches,
        message: "指纹交付校验失败: " + mismatchText,
        warnings: evalResult.warnings,
        liveProbe,
      };
    }

    // Success: clear consecutive failure counter
    this.resetFingerprintVerificationFailures(profileId);
    return {
      ok: true,
      blocked: false,
      mismatches: [],
      warnings: evalResult.warnings,
      liveProbe,
    };
  }

  resetFingerprintVerificationFailures(profileId) {
    if (profileId) {
      this.deliveryVerificationFailures.delete(profileId);
      this.deliveryVerificationFailureTimestamps?.delete(profileId);
    } else {
      this.deliveryVerificationFailures.clear();
      this.deliveryVerificationFailureTimestamps?.clear();
    }
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
              appliedFingerprintHash: item.fpAppliedHash,
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
    if (isChildExited(child)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener?.('exit', onExit);
        child.removeListener?.('close', onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(isChildExited(child)), timeout);
      child.once?.('exit', onExit);
      child.once?.('close', onExit);
    });
  }

  async drainProfileHelpers(root) {
    if (!root) return { known: true, pids: [], attempts: 0, timedOut: false };
    return isolation.drainProcessesUsingProfile(root, {
      attempts: HELPER_CLEANUP_ATTEMPTS,
      delayMs: HELPER_CLEANUP_DELAY_MS,
      timeoutMs: HELPER_CLEANUP_TIMEOUT_MS,
    });
  }

  cleanupRunningItem(profileId, item, options = {}) {
    if (!item) return Promise.resolve({ id: profileId, running: false });
    if (item.cleanupPromise?.lifecycleSettled) item.cleanupPromise = null;
    if (item.cleanupPromise) return item.cleanupPromise;

    const reason = String(options.reason || 'browser-gone');
    const wasStopping = Boolean(item.stopping);
    const cleanup = async () => {
      // Mark first so the watcher and any late startup continuation stop touching
      // a browser whose ownership is already being torn down. Keep `running` until
      // all external resources have been released; start() waits on `stopping`.
      item.cleanupState = 'cleaning';
      item.cleanupAttempts = (item.cleanupAttempts || 0) + 1;
      item.cleanedUp = false;
      item.stopping = true;
      this.clearRunningWatch(item);
      item.workerFingerprintConnection?.close();
      item.workerFingerprintConnection = null;

      if (options.kill && !isChildExited(item.child) && item.pid) {
        await killProcessTree(item.pid, managedBrowserKillOptions(item, item.root)).catch(() => {});
      }
      if (options.waitForExit) {
        let exited = await this.waitForChildExit(item.child, Number(options.exitTimeout) || 6500);
        // A failed first kill must not release the profile lock while Chromium
        // still owns the profile. Retry the bounded kill/wait sequence once.
        if (!exited && !isChildExited(item.child) && item.pid) {
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
          // Do not close proxyForwarder while child has not exited to avoid network leak to host
          stopIpcStubForWindow(item.kernelWindowName);
          item.cleanupFailed = true;
          item.cleanupState = 'blocked';
          const failure = new Error(`Browser child exit was not confirmed for profile ${profileId}; cleanup is fail-closed`);
          failure.code = 'BROWSER_EXIT_UNCONFIRMED';
          item.cleanupError = failure;
          throw failure;
        }
      }

      // The tracked browser process can exit before Chromium's renderer/GPU
      // helpers. Re-scan the exact user-data-dir and terminate only those
      // helpers before releasing the profile lock.
      if (item.root && isChildExited(item.child)) {
        let helperDrain = await this.drainProfileHelpers(item.root);
        if (!helperDrain.known || helperDrain.pids.length) {
          if (helperDrain.pids?.length) {
            await isolation.terminateProcessIds?.(helperDrain.pids);
            helperDrain = await this.drainProfileHelpers(item.root);
          }
        }
        if (!helperDrain.known || helperDrain.pids.length) {
          try {
            const remaining = scanProcessesUsingProfile(item.root);
            if (remaining?.pids?.length) {
              for (const p of remaining.pids) {
                if (p && p !== process.pid) {
                  try {
                    if (process.platform === 'win32') {
                      require('child_process').execFileSync('taskkill.exe', ['/PID', String(p), '/T', '/F'], { windowsHide: true, timeout: 3000 });
                    } else {
                      process.kill(p, 'SIGKILL');
                    }
                  } catch (_) {}
                }
              }
            }
          } catch (_) {}
          helperDrain = await this.drainProfileHelpers(item.root);
        }
        if (item.root) {
          await removeSingletonFiles(item.root, { attempts: 6, delayMs: 40 });
        }
        const activeHelperPids = (helperDrain.pids || []).filter(isPidAlive);
        if (activeHelperPids.length > 0) {
          const failure = new Error(`Chromium helper exit was not confirmed for profile ${profileId}; cleanup is fail-closed`);
          failure.code = 'BROWSER_HELPERS_EXIT_UNCONFIRMED';
          failure.pids = activeHelperPids;
          item.cleanupFailed = true;
          item.cleanupState = 'blocked';
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
      const lockReleased = await releaseProfileLock(item.root, item.profileLock).catch(() => false);
      if (!lockReleased && item.profileLock && fs.existsSync(lockPath(item.root))) {
        if (!options.ignoreForeignLock) {
          item.cleanupFailed = true;
          item.cleanupState = 'blocked';
          const failure = new Error(`Profile lock release failed for profile ${profileId}; cleanup is fail-closed`);
          failure.code = 'PROFILE_LOCK_RELEASE_FAILED';
          item.cleanupError = failure;
          throw failure;
        }
      }
      // Existing behavior intentionally marks the profile clean after watchdog
      // cleanup as well, preventing Chromium's restore bubble on the next launch.
      if (options.markCleanExit !== false) await this.markProfileCleanExit(item.root).catch(() => {});

      if (this.running.get(profileId) === item) this.running.delete(profileId);
      item.cleanupFailed = false;
      item.cleanupState = 'cleaned';
      item.cleanupError = null;
      item.cleanedUp = true;
      item.stopping = false;
      const live = this.profiles.get(profileId) || item.profile;
      const error = options.error === undefined ? null : (options.error || null);
      const currentItem = this.running.get(profileId);
      const mayEmitForGeneration = !currentItem || currentItem === item;
      if (mayEmitForGeneration && options.emitStatus !== false && !item.statusEmitted) {
        item.statusEmitted = true;
        this.emit({ type: 'status', id: profileId, running: false, stopping: false, error, reason });
      }
      if (mayEmitForGeneration && options.emitProfileClosed && live?.advanced?.cloudBackup && !wasStopping && !item.profileClosedEmitted) {
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
    cleanupPromise.lifecycleItem = item;
    cleanupPromise.lifecycleGeneration = item.lifecycleGeneration;
    cleanupPromise.lifecycleSettled = false;
    item.cleanupPromise = cleanupPromise;
    cleanupPromise.then(
      () => {
        cleanupPromise.lifecycleSettled = true;
        if (item.cleanupPromise === cleanupPromise) item.cleanupPromise = null;
      },
      (error) => {
        cleanupPromise.lifecycleSettled = true;
        // Keep the running item and lock visible, but allow an explicit retry after
        // the child eventually exits instead of memoizing a rejected promise forever.
        item.cleanupFailed = true;
        item.cleanupState = 'blocked';
        item.cleanupError = error;
        if (item.cleanupPromise === cleanupPromise) item.cleanupPromise = null;
      },
    );
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
      let exited = isChildExited(child);

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
        if (!exited && !isChildExited(child) && child.pid) {
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
      if (resources.root) {
        await removeSingletonFiles(resources.root, { attempts: 6, delayMs: 40 });
        const helperDrain = await this.drainProfileHelpers(resources.root);
        if (!helperDrain.known || helperDrain.pids.length) {
          return {
            exited: false,
            lockReleased: false,
            cleanupBlocked: true,
            helperPids: helperDrain.pids,
          };
        }
      }
      if (resources.profileLock && resources.root) {
        const released = await releaseProfileLock(resources.root, resources.profileLock).catch(() => false);
        const lockStillPresent = fs.existsSync(lockPath(resources.root));
        if (!released && lockStillPresent) {
          return { exited: false, lockReleased: false, cleanupBlocked: true };
        }
        return { exited, lockReleased: !lockStillPresent };
      }
      return { exited, lockReleased: true };
    };
    resources.cleanupPromise = cleanup();
    return resources.cleanupPromise;
  }

  handleBrowserGone(profileId, item, reason = 'browser-gone', options = {}) {
    if (profileId) this.resetFingerprintVerificationFailures(profileId);
    if (!item) return Promise.resolve({ id: profileId, running: false });
    const pending = this.stopping.get(profileId);
    if (pending?.lifecycleSettled && this.stopping.get(profileId) === pending) this.stopping.delete(profileId);
    const activePending = this.stopping.get(profileId);
    if (activePending && (!activePending.lifecycleItem || activePending.lifecycleItem === item)) return activePending;
    if (item.cleanupPromise?.lifecycleSettled) item.cleanupPromise = null;
    if (item.cleanupPromise) return item.cleanupPromise;

    const current = this.running.get(profileId);
    const latestGeneration = Math.max(
      Number(this.lifecycleGenerations?.get(profileId)) || 0,
      Number(this.starting.get(profileId)?.lifecycleGeneration) || 0,
      Number(current?.lifecycleGeneration) || 0,
      Number(activePending?.lifecycleGeneration) || 0,
    );
    const staleGeneration = Number(item.lifecycleGeneration) > 0
      && latestGeneration > Number(item.lifecycleGeneration);
    if (staleGeneration || (current && current !== item) || (activePending && activePending.lifecycleItem && activePending.lifecycleItem !== item)) {
      // A late exit/error from an older generation must never replace the stop
      // barrier or status of the current browser generation.
      return this.cleanupRunningItem(profileId, item, {
        reason,
        expected: true,
        error: null,
        kill: options.kill !== false,
        waitForExit: options.waitForExit !== false,
        exitTimeout: options.exitTimeout,
        // A replacement generation may already be preparing the same profile.
        // Do not rewrite its Preferences from an old process callback.
        markCleanExit: false,
        emitStatus: false,
        emitProfileClosed: false,
        ignoreForeignLock: Boolean(
          current
          && current !== item
          && current.profileLock
          && current.root
          && item.root
          && path.resolve(String(current.root || '')) === path.resolve(String(item.root || '')),
        ),
      });
    }

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
    cleanupPromise.lifecycleItem = item;
    cleanupPromise.lifecycleGeneration = item.lifecycleGeneration;
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
      if (child && isChildExited(child)) {
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

  restoreStoredProxyCredentials(incoming, source = null) {
    if (!incoming || incoming.networkMode === 'direct' || incoming.proxyId) return incoming;
    if (String(source?.proxyAuthAction ?? source?.proxy_auth_action ?? '').trim().toLowerCase() === 'clear') {
      return incoming;
    }
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

  nextLifecycleGeneration(id) {
    if (!this.lifecycleGenerations) this.lifecycleGenerations = new Map();
    const next = (Number(this.lifecycleGenerations.get(id)) || 0) + 1;
    this.lifecycleGenerations.set(id, next);
    return next;
  }

  requestLifecycleStop(id, generation) {
    if (!this.lifecycleStopRequests) this.lifecycleStopRequests = new Map();
    this.lifecycleStopRequests.set(id, generation == null ? true : generation);
  }

  clearLifecycleStopRequest(id, generation) {
    if (!this.lifecycleStopRequests) return;
    if (generation === undefined) return;
    const requested = this.lifecycleStopRequests.get(id);
    if (requested === generation || (generation === null && requested === true)) {
      this.lifecycleStopRequests.delete(id);
    }
  }

  isLifecycleStopRequested(id, generation) {
    const requested = this.lifecycleStopRequests?.get(id);
    return requested === true || requested === generation;
  }

  assertStartGenerationActive(id, generation) {
    if (this.stopAllInProgress || this.isLifecycleStopRequested(id, generation)) {
      const error = new Error(`Browser start was cancelled for profile ${id}`);
      error.code = 'BROWSER_START_CANCELLED';
      throw error;
    }
  }

  retainBlockedStartup(profile, resources, cause, generation, cleanupResult = {}) {
    const current = this.running.get(profile.id);
    if (current) return current;
    const error = new Error(`Browser startup cleanup is incomplete for profile ${profile.id}`);
    error.code = cleanupResult.helperPids?.length
      ? 'BROWSER_HELPERS_EXIT_UNCONFIRMED'
      : 'BROWSER_EXIT_UNCONFIRMED';
    error.cause = cause;
    error.pids = cleanupResult.helperPids || [];
    const item = {
      child: resources.child || null,
      cdpConnection: resources.connection || null,
      proxyForwarder: resources.proxyForwarder || null,
      markerProcess: resources.markerProcess || null,
      profileLock: resources.profileLock || null,
      pid: resources.child?.pid || null,
      browser: resources.browser || null,
      root: resources.root || null,
      profile,
      port: null,
      launchBinary: resources.launchBinary || null,
      kernelWindowName: resources.kernelWindowName || null,
      childExitState: {
        exited: isChildExited(resources.child),
        code: resources.child?.exitCode ?? null,
        signal: resources.child?.signalCode || null,
        error: null,
      },
      lifecycleGeneration: generation,
      cleanupState: 'blocked',
      cleanupAttempts: 1,
      cleanedUp: false,
      cleanupFailed: true,
      cleanupError: error,
      stopping: true,
      cleanupPromise: null,
      statusEmitted: false,
      profileClosedEmitted: false,
      extensions: [],
      loadedExtensions: [],
    };
    this.running.set(profile.id, item);
    return item;
  }

  async start(raw) {
    const candidate = this.restoreStoredProxyCredentials(
      this.resolveStoredProxyProfile(this.sanitizeProfile(raw)),
      raw,
    );
    const id = candidate.id;
    const pendingStart = this.starting.get(id);
    if (pendingStart) return pendingStart;
    if (this.stopAllInProgress) {
      const error = new Error('Browser engine is stopping all environments');
      error.code = 'ENGINE_STOPPING';
      throw error;
    }

    const generation = this.nextLifecycleGeneration(id);
    const task = (async () => {
      const pendingStop = this.stopping.get(id);
      if (pendingStop) await pendingStop.catch(() => {});
      this.assertStartGenerationActive(id, generation);

      let afterStop = this.running.get(id);
      if (afterStop && (afterStop.cleanupFailed || afterStop.cleanedUp || afterStop.stopping)) {
        if (!afterStop.cleanupFailed) {
          await this.stopRunningItem(id, afterStop).catch(() => {});
          afterStop = this.running.get(id);
        }
      }
      if (afterStop && (afterStop.cleanupFailed || afterStop.cleanedUp || afterStop.stopping)) {
        let numericPid = Number(afterStop.pid);
        let childDead = afterStop.child
          ? isChildExited(afterStop.child)
          : (numericPid > 0 ? !isPidAlive(numericPid) : true);
        let helpers = scanProcessesUsingProfile(afterStop.root || '').pids;
        if (!childDead || helpers.length) {
          if (!childDead && numericPid > 0) {
            await killProcessTree(numericPid, managedBrowserKillOptions(afterStop, afterStop.root)).catch(() => {});
          }
          for (const helperPid of helpers) {
            if (helperPid && helperPid !== process.pid) {
              await killProcessTree(helperPid, { force: true }).catch(() => {});
            }
          }
          childDead = afterStop.child
            ? isChildExited(afterStop.child)
            : (numericPid > 0 ? !isPidAlive(numericPid) : true);
          helpers = scanProcessesUsingProfile(afterStop.root || '').pids;
          if (!childDead || helpers.length) {
            if (numericPid > 0 && isPidAlive(numericPid)) {
              try { process.kill(numericPid, 'SIGKILL'); } catch (_) {}
            }
            for (const helperPid of helpers) {
              try { if (helperPid !== process.pid) process.kill(helperPid, 'SIGKILL'); } catch (_) {}
            }
          }
        }
        childDead = afterStop.child
          ? isChildExited(afterStop.child)
          : (numericPid > 0 ? !isPidAlive(numericPid) : true);
        helpers = scanProcessesUsingProfile(afterStop.root || '').pids;
        if (!childDead) {
          throw afterStop.cleanupError || Object.assign(
            new Error(`Browser environment ${id} is still stopping; child exit has not been confirmed`),
            { code: 'BROWSER_EXIT_UNCONFIRMED' },
          );
        }
        if (afterStop.root) {
          await removeSingletonFiles(afterStop.root, { attempts: 8, delayMs: 40 });
        }
        try { afterStop.cdpConnection?.close?.(); } catch (_) {}
        if (afterStop.proxyForwarder) {
          try { await afterStop.proxyForwarder.close?.(); } catch (_) {}
        }
        if (afterStop.profileLock && afterStop.root) {
          await releaseProfileLock(afterStop.root, afterStop.profileLock).catch(() => {});
        }
        this.running.delete(id);
        afterStop = null;
      }
      if (afterStop) return this.publicRunning(id);
      this.assertStartGenerationActive(id, generation);
      return this._start(candidate, generation);
    })();
    task.lifecycleGeneration = generation;
    this.starting.set(id, task);
    try {
      return await task;
    } finally {
      if (this.starting.get(id) === task) this.starting.delete(id);
    }
  }

  async _start(raw, lifecycleGeneration = null) {
    // let: language/timezone resolution reassigns profile via applyResolvedLocale
    // start() already applied redaction recovery exactly once. Repeating it here
    // would undo an explicit proxyAuthAction=clear before launch.
    let profile = this.resolveStoredProxyProfile(this.sanitizeProfile(raw));
    this.profiles.set(profile.id, profile);
    this.assertStartGenerationActive(profile.id, lifecycleGeneration);
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
    let currentStage = 'prepare';
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
    this.assertStartGenerationActive(profile.id, lifecycleGeneration);
    this.profiles.set(profile.id, profile);
    currentStage = 'proxy'; this.emitStartProgress(profile.id, 'proxy', 18, '正在检测代理与出口…');
    await this.ensureExitNetworkForLocale(profile).catch(() => {});
    profile = this.applyResolvedLocale(profile);
    this.profiles.set(profile.id, profile);
    // Persist the effective proxy (including credentials returned by a dynamic
    // proxy API) before launching Chromium. A quit immediately after startup
    // must not leave the renderer's redacted copy as the durable state.
    await this.persist();
    const extensions = this.assignedExtensions(profile.id);
    currentStage = 'kernel'; this.emitStartProgress(profile.id, 'kernel', 30, '正在准备浏览器内核…');
    if (!this.kernelStatus().installed && this.preferIndependentKernel) {
      // Resolve integrated seed only — never download a remote kernel at start time.
      await this.ensureKernelBootstrap();
    }
    this.assertStartGenerationActive(profile.id, lifecycleGeneration);
    const browser = this.chooseBrowser(profile);
    root = this.profileRoot(profile.id);
    startupResources.root = root;
    const rootCheck = await validateProfileRootSecure(this.profileDataRootPath, root, profile.id, { create: true });
    if (!rootCheck.ok) throw new Error('Isolation error: ' + rootCheck.message);
    profileLock = await acquireProfileLock(root, {
      profileId: profile.id,
      browser: browser.path,
      lifecycleGeneration,
    });
    startupResources.profileLock = profileLock;
    startupResources.lifecycleGeneration = lifecycleGeneration;
    this.assertStartGenerationActive(profile.id, lifecycleGeneration);
    const restoreSession = profile.advanced.tabMode === 'restore' || profile.advanced.restoreSession;
    // Parallelized (independent IO overlaps; Preferences writers stay serialized). See method.
    await this.prepareProfileFilesForStart(root, profile, restoreSession);
    await removeSingletonFiles(root, { attempts: 6, delayMs: 40 });
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
    let args = [
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
      '--extensions-on-chrome-urls',
      '--enable-features=AutomaticFullscreenContentSetting,WindowPlacement,WindowManagement',
      '--disable-gesture-requirement-for-presentation',
      '--disable-fullscreen-low-power-mode',
      // Random loopback port only; never bind 0.0.0.0. Restrict CDP WebSocket origins
      // (was * — any local page that learns the port could attach and steal session).
      '--remote-debugging-port=0',
      '--remote-allow-origins=http://127.0.0.1,http://localhost',
    ];
    // Fingerprint chrome flags (UA / webrtc / webgl / lang / window-size)
    args = mergeFlags(args, chromeArgsForFingerprint(fingerprint, profile), {
      listFlags: LIST_VALUE_FLAGS,
    });
    const langList = (Array.isArray(fingerprint?.languages) && fingerprint.languages.length)
      ? fingerprint.languages
      : (Array.isArray(profile?.languages) && profile.languages.length)
        ? profile.languages
        : profile?.language
          ? [profile.language]
          : [];
    if (langList.length && !args.some((a) => a.startsWith('--accept-lang='))) {
      args.push(`--accept-lang=${langList.join(',')}`);
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
    else args.push('--autoplay-policy=no-user-gesture-required');
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
      if (!args.some((a) => a.startsWith('--force-webrtc-ip-handling-policy='))) {
        args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
      }
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
      // Appending without de-duplicating would repeat names already present
      // from either the base list or the fingerprint merge above.
      args = appendFlagValue(args, 'disable-features', disabledFeatures.join(','));
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
      currentStage = 'spawn'; this.emitStartProgress(profile.id, 'spawn', 62, '正在启动浏览器进程…');
      this.assertStartGenerationActive(profile.id, lifecycleGeneration);
      await ensureKernelReadyForLaunch(browser);
      this.assertStartGenerationActive(profile.id, lifecycleGeneration);
      const headless = /^(1|true|new)$/i.test(String(process.env.OPENBROWSER_HEADLESS || '').trim());
      if (headless && !finalArgs.some((arg) => /^--headless(?:=|$)/i.test(String(arg)))) {
        finalArgs.push('--headless=new');
        if (!finalArgs.some((arg) => String(arg).split('=')[0] === '--disable-gpu')) finalArgs.push('--disable-gpu');
      }
      const isRealTimezone = profile.privacy?.timezoneMode === 'real';
      const userExplicitTz = extractTimezoneFromArgs(finalArgs);
      const hasExplicitTzFlag = Boolean(userExplicitTz || finalArgs.some((arg) => /^--time-zone-for-testing(?:=|$)/i.test(String(arg))));

      let effectiveTimezone = '';
      if (hasExplicitTzFlag) {
        // User explicitly specified --time-zone-for-testing; honor explicit flag priority and avoid duplicates.
        if (isValidIanaTimezone(userExplicitTz)) {
          effectiveTimezone = userExplicitTz;
        }
      } else if (!isRealTimezone) {
        const resolvedTz = resolveProfileTimezone(profile, pageNetwork);
        const candidateTz = String(
          resolvedTz
          || profile.exitTimezone
          || pageNetwork?.timezone
          || (profile.privacy?.timezoneMode === 'custom' ? profile.privacy.timezone : '')
          || profile.privacy?.timezone
          || fingerprint?.timezone
          || ''
        ).trim();

        if (isValidIanaTimezone(candidateTz)) {
          effectiveTimezone = candidateTz;
          finalArgs.push(`--time-zone-for-testing=${effectiveTimezone}`);
        }
      }

      // Synchronize process-level timezone for POSIX kernels and C++ ICU subsystems.
      // On Windows, ICU reads the system registry rather than TZ, so passing
      // --time-zone-for-testing on the command line ensures the Chromium C++ core boots in
      // the persona timezone.
      const spawnEnv = { ...process.env };
      if (effectiveTimezone && !isRealTimezone && process.platform !== 'win32') {
        spawnEnv.TZ = effectiveTimezone;
      }
      child = spawn(launchBinary, finalArgs, {
        detached: process.platform !== 'win32',
        windowsHide: headless,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
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
      this.assertStartGenerationActive(profile.id, lifecycleGeneration);
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
      childExitState: childExitState || { exited: isChildExited(child), code: child.exitCode, signal: child.signalCode, error: null },
      lifecycleGeneration,
      cleanupState: 'active',
      cleanupAttempts: 0,
      cleanedUp: false,
      stopping: false,
      cleanupPromise: null,
      statusEmitted: false,
      profileClosedEmitted: false,
    };
    this.running.set(profile.id, item);
    liveItem = item;
    this.assertStartGenerationActive(profile.id, lifecycleGeneration);

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
      currentStage = 'inject'; this.emitStartProgress(profile.id, 'inject', 88, '正在注入指纹与运行时…');
      let injectSucceeded = false;
      let injectError = null;

      // Fail-closed pre-inject with bounded retries (2 retries, total 3 attempts)
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          item.fingerprint = await this.applyRuntimeSettings(item.port, profile, injectFp, {
            appliedTargetIds: item.fpAppliedTargets,
            appliedFingerprintHash: item.fpAppliedHash,
            trackOn: item,
            phase: 'pre-startpage',
          }) || fingerprint;
          injectSucceeded = true;
          injectError = null;
          break;
        } catch (err) {
          injectError = err;
          await fpLog('start.pre-inject-fail-attempt', {
            profileId: profile.id,
            attempt,
            error: String(err?.message || err),
          });
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
        }
      }

      if (!injectSucceeded) {
        item.fingerprint = fingerprint;
        await fpLog('start.pre-inject-fail', {
          profileId: profile.id,
          error: String(injectError?.message || injectError),
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

      // Worker fingerprint injection with bounded retries
      let workerSucceeded = false;
      let workerError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await this.startWorkerFingerprintInjection(item, injectFp);
          workerSucceeded = true;
          workerError = null;
          break;
        } catch (err) {
          workerError = err;
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }

      if (!workerSucceeded) {
        item.workerFingerprintError = workerError?.message || String(workerError);
        await fpLog('worker.inject-fail', { profileId: profile.id, error: String(workerError?.message || workerError) });
        this.emit({ type: 'worker-fingerprint-injection-failed', id: profile.id, message: workerError?.message || String(workerError) });
      }

      const injectionFailed = !injectSucceeded || !workerSucceeded;

      if (injectionFailed) {
        const failureDetails = [
          !injectSucceeded ? ('Pre-inject 失败: ' + (injectError?.message || injectError || '未知错误')) : '',
          !workerSucceeded ? ('Worker inject 失败: ' + (workerError?.message || workerError || '未知错误')) : '',
        ].filter(Boolean).join('; ');

        this.emit({
          type: 'fingerprint-injection-failed',
          id: profile.id,
          message: failureDetails,
          blocked: true,
        });

        // Fail-Closed: DO NOT navigate to target site or startUrl.
        // Navigate to a safe local error page to prevent real fingerprint exposure.
        const safeErrorHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>指纹注入失败 - 启动已阻断</title><style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:40px;background:#18181b;color:#f4f4f5;}h1{color:#ef4444;font-size:22px;margin-top:0;}.card{background:#27272a;border:1px solid #3f3f46;border-radius:8px;padding:24px;max-width:620px;margin:40px auto;box-shadow:0 4px 6px -1px rgba(0,0,0,.3);}.desc{color:#a1a1aa;font-size:14px;line-height:1.6;}.err{background:#09090b;padding:12px;border-radius:6px;font-family:monospace;font-size:13px;color:#f87171;word-break:break-all;white-space:pre-wrap;margin:16px 0;}.hint{font-size:13px;color:#71717a;}</style></head><body><div class="card"><h1>⚠️ 指纹防护注入未就绪</h1><p class="desc">为避免原生环境及真实指纹泄露至目标站点，系统已触发 Fail-Closed 安全屏障，中止访问目标地址。</p><div class="err">` + String(failureDetails).replace(/[<>&"]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])) + `</div><p class="hint">请关闭该浏览器窗口，检查内核状态或代理配置后重试。</p></div></body></html>`;
        const safeErrorUrl = `data:text/html;charset=utf-8,${encodeURIComponent(safeErrorHtml)}`;
        await fpLog('start.navigate-barrier-errorpage', { profileId: profile.id, failureDetails });
        try {
          await this.keepDefaultTab(item.port, safeErrorUrl);
        } catch (navError) {
          await fpLog('start.navigate-barrier-fail', { profileId: profile.id, error: String(navError.message || navError) });
        }
      } else {
        // Fail-Closed: Verify actual delivered fingerprint via CDP probe before target navigation
        currentStage = 'verify'; this.emitStartProgress(profile.id, 'verify', 92, '正在校验指纹交付…');
        let deliveryResult = { ok: true, blocked: false, mismatches: [], warnings: [] };
        try {
          deliveryResult = await this.verifyStartupFingerprintDelivery(item, profile, item.fingerprint || fingerprint);
        } catch (verifyError) {
          await fpLog('start.delivery-verify-exception', {
            profileId: profile.id,
            error: String(verifyError?.message || verifyError),
          });
        }

        if (!deliveryResult.ok && deliveryResult.blocked) {
          const mismatchMessages = (deliveryResult.mismatches || []).map((m) => typeof m === 'object' ? (m.message || JSON.stringify(m)) : String(m));
          const failureDetails = mismatchMessages.join('\n');
          item.fingerprintVerificationError = deliveryResult.message || failureDetails;
          item.verificationBlocked = true;

          this.emit({
            type: 'fingerprint-verification-failed',
            id: profile.id,
            blocked: true,
            mismatches: deliveryResult.mismatches,
            message: deliveryResult.message || ('指纹交付校验失败: ' + mismatchMessages.join('; ')),
          });

          // Fail-Closed: DO NOT navigate to target site or startUrl.
          // Navigate to a safe local error page to prevent real fingerprint exposure.
          const safeErrorHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>指纹校验失败 - 启动已阻断</title><style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:40px;background:#18181b;color:#f4f4f5;}h1{color:#ef4444;font-size:22px;margin-top:0;}.card{background:#27272a;border:1px solid #3f3f46;border-radius:8px;padding:24px;max-width:620px;margin:40px auto;box-shadow:0 4px 6px -1px rgba(0,0,0,.3);}.desc{color:#a1a1aa;font-size:14px;line-height:1.6;}.err{background:#09090b;padding:12px;border-radius:6px;font-family:monospace;font-size:13px;color:#f87171;word-break:break-all;white-space:pre-wrap;margin:16px 0;}.hint{font-size:13px;color:#71717a;}</style></head><body><div class="card"><h1>⚠️ 指纹未按配置交付</h1><p class="desc">为避免原生环境及真实指纹泄露至目标站点，系统检测到实际交付指纹与配置存在直接矛盾，已触发 Fail-Closed 安全屏障，阻止访问目标站点。</p><div class="err">` + String(failureDetails).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])) + `</div><p class="hint">指纹未按配置交付，已阻止访问目标站点。请检查内核兼容性或环境指纹配置后重试。</p></div></body></html>`;
          const safeErrorUrl = `data:text/html;charset=utf-8,${encodeURIComponent(safeErrorHtml)}`;
          await fpLog('start.navigate-verification-barrier-errorpage', { profileId: profile.id, failureDetails });
          try {
            await this.keepDefaultTab(item.port, safeErrorUrl);
          } catch (navError) {
            await fpLog('start.navigate-verification-barrier-fail', { profileId: profile.id, error: String(navError.message || navError) });
          }
        } else if (!restoreSession && startUrl) {
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
      if (!restoreSession && startUrl && item.port && !item.verificationBlocked && !injectionFailed) {
        try {
          await this.keepDefaultTab(item.port, startUrl);
          await fpLog('start.navigate-after-fail', { profileId: profile.id, startUrl });
        } catch (_) {}
      }
    }
    this.assertStartGenerationActive(profile.id, lifecycleGeneration);
    if (this.running.get(profile.id) !== item || item.cleanedUp || item.stopping) {
      throw new Error(item.cdpError || '浏览器在启动过程中异常退出');
    }
    // Detect user closing browser with X (process may stay alive; CDP/pages are source of truth)
    this.startRunningWatch(item);
    if (item.verificationBlocked) {
      currentStage = 'blocked'; this.emitStartProgress(profile.id, 'blocked', 100, '指纹校验失败，已阻止访问目标站点');
    } else {
      currentStage = 'ready'; this.emitStartProgress(profile.id, 'ready', 100, '启动完成');
    }
    this.emit({ type: 'status', id: profile.id, running: true, blocked: Boolean(item.verificationBlocked), ...this.publicRunning(profile.id) });
    return this.publicRunning(profile.id);
    } catch (error) {
      // Release anything acquired before the env became live. The inner spawn/extension
      // catches already release on their own failure paths (making this a safe no-op via
      // token/close idempotency); this covers the earlier steps — proxy bridge, tab reset,
      // start-page/fingerprint build — whose throws would otherwise strand the lock.
      let cleanupResult = null;
      if (liveItem) {
        // The item is published before runtime injection and start-page setup so
        // exit events can clean it up. If either step fails, run the same guarded
        // cleanup path instead of leaving a live map entry and profile lock behind.
        cleanupResult = await this.handleBrowserGone(profile.id, liveItem, 'start-failed', {
          expected: false,
          error: error?.message || String(error),
          kill: true,
          waitForExit: true,
          emitProfileClosed: false,
        }).catch(() => null);
      } else if (!this.running.has(profile.id)) {
        cleanupResult = await this.cleanupStartupResources(startupResources).catch(() => null);
        if (cleanupResult?.cleanupBlocked) {
          this.retainBlockedStartup(profile, startupResources, error, lifecycleGeneration, cleanupResult);
        }
      }
      const kernelVer = browser?.version || (isOpenBrowser148(browser) ? '148' : 'system');
      if (error && typeof error === 'object') {
        error.profileId = profile.id;
        error.stage = currentStage;
        error.phase = currentStage;
        error.kernelVersion = kernelVer;
        error.operation = 'start';
      }
      this.emit({
        type: 'profile-start-progress',
        id: profile.id,
        phase: 'error',
        stage: currentStage,
        kernelVersion: kernelVer,
        operation: 'start',
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
      verificationBlocked: Boolean(item.verificationBlocked),
      fingerprintVerificationError: item.fingerprintVerificationError || null,
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

  stopRunningItem(safe, item) {
    if (!item) return Promise.resolve({ id: safe, running: false, alreadyStopped: true });
    const pending = this.stopping.get(safe);
    if (pending?.lifecycleSettled && this.stopping.get(safe) === pending) this.stopping.delete(safe);
    const activePending = this.stopping.get(safe);
    if (activePending && (!activePending.lifecycleItem || activePending.lifecycleItem === item)) return activePending;
    if (activePending) {
      return activePending.catch(() => {}).then(() => {
        if (this.running.get(safe) !== item) return { id: safe, running: false, alreadyStopped: true };
        return this.stopRunningItem(safe, item);
      });
    }
    if (item.cleanupPromise?.lifecycleSettled) item.cleanupPromise = null;
    if (item.cleanupPromise) {
      const cleanupPromise = item.cleanupPromise;
      cleanupPromise.lifecycleItem = item;
      cleanupPromise.lifecycleGeneration = item.lifecycleGeneration;
      this.stopping.set(safe, cleanupPromise);
      cleanupPromise.finally(() => {
        if (this.stopping.get(safe) === cleanupPromise) this.stopping.delete(safe);
      }).catch(() => {});
      return cleanupPromise;
    }

    const task = this._stop(safe, item);
    task.lifecycleItem = item;
    task.lifecycleGeneration = item.lifecycleGeneration;
    task.lifecycleSettled = false;
    task.then(
      () => { task.lifecycleSettled = true; },
      () => { task.lifecycleSettled = true; },
    );
    this.stopping.set(safe, task);
    task.finally(() => {
      if (this.stopping.get(safe) === task) this.stopping.delete(safe);
    }).catch(() => {});
    return task;
  }

  async stop(id) {
    const safe = assertProfileId(id);
    this.resetFingerprintVerificationFailures(safe);
    const pendingStop = this.stopping.get(safe);
    if (pendingStop?.lifecycleSettled && this.stopping.get(safe) === pendingStop) this.stopping.delete(safe);
    if (this.stopping.has(safe)) return this.stopping.get(safe);

    const pendingStart = this.starting.get(safe);
    const requestedGeneration = pendingStart?.lifecycleGeneration;
    if (pendingStart) {
      this.requestLifecycleStop(safe, requestedGeneration);
      await pendingStart.catch(() => {});
    }

    const afterStartStop = this.stopping.get(safe);
    if (afterStartStop) {
      try {
        return await afterStartStop;
      } finally {
        this.clearLifecycleStopRequest(safe, requestedGeneration);
      }
    }
    const item = this.running.get(safe);
    if (!item) {
      this.clearLifecycleStopRequest(safe, requestedGeneration);
      return { id: safe, running: false, alreadyStopped: true };
    }

    try {
      return await this.stopRunningItem(safe, item);
    } finally {
      this.clearLifecycleStopRequest(safe, requestedGeneration);
    }
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
    let graceful = !item.child || isChildExited(item.child);
    if (!graceful && item.child) {
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
      graceful = await this.waitForChildExit(item.child, 6500);
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
    if (this.stopAllPromise) return this.stopAllPromise;
    this.stopAllInProgress = true;
    const task = this._stopAll();
    this.stopAllPromise = task;
    try {
      return await task;
    } finally {
      if (this.stopAllPromise === task) this.stopAllPromise = null;
      this.stopAllInProgress = false;
    }
  }

  async _stopAll() {
    // Drain until the lifecycle maps reach a fixed point. A one-shot snapshot can
    // miss a restart that was queued while another environment was stopping.
    // Each environment also has its own deadline, so a stuck startup or WMI/CDP
    // operation cannot prevent unrelated environments and the start-page server
    // from being closed during application shutdown.
    const failed = [];
    const itemTimeout = Math.max(50, Number(this.stopAllItemTimeoutMs) || STOP_ALL_ITEM_TIMEOUT_MS);
    for (let pass = 0; pass < 8; pass += 1) {
      const ids = [...new Set([...this.running.keys(), ...this.starting.keys(), ...this.stopping.keys()])];
      if (!ids.length) break;
      const results = await Promise.allSettled(ids.map((id) => lifecycleTimeout(
        this.stop(id),
        itemTimeout,
        `Timed out stopping browser environment ${id}`,
      )));
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === 'rejected') failed.push(`${ids[index]}: ${String(result.reason?.message || result.reason)}`);
      }
      const remaining = [...new Set([...this.running.keys(), ...this.starting.keys(), ...this.stopping.keys()])];
      if (!remaining.length) break;
    }
    const remaining = [...new Set([...this.running.keys(), ...this.starting.keys(), ...this.stopping.keys()])];
    if (remaining.length) failed.push(`lifecycle resources remain: ${remaining.join(', ')}`);
    if (this.startPageServer?.server) {
      try {
        await lifecycleTimeout(this.startPageServer.stop(), 4000, 'Timed out stopping start page server');
      } catch (error) {
        failed.push(`start page server: ${error.message || error}`);
      }
    }
    if (failed.length) this.emit({ type: 'sync-error', action: 'stop-all', message: `部分环境停止失败：${[...new Set(failed)].join('; ')}` });
    return { stopped: remaining.length === 0, remaining, errors: [...new Set(failed)] };
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
      // Commit in-memory deletion only after the profile directory is gone.
      // Persist each successful item so a later batch failure cannot leave the
      // durable profile list disagreeing with already-deleted directories.
      const previousProfile = this.profiles.get(id);
      const previousAssignments = this.assignments.get(id);
      const previousNetwork = this.networkInfo.get(id);
      const hadAssignments = this.assignments.has(id);
      const hadNetwork = this.networkInfo.has(id);
      this.profiles.delete(id);
      this.assignments.delete(id);
      this.networkInfo.delete(id);
      try {
        await this.persist();
      } catch (error) {
        if (previousProfile) this.profiles.set(id, previousProfile);
        if (hadAssignments) this.assignments.set(id, previousAssignments);
        if (hadNetwork) this.networkInfo.set(id, previousNetwork);
        throw error;
      }
      deleted.push(id);
    }
    this.emit({ type: 'profiles', action: 'delete', ids: deleted }); this.emit({ type: 'extensions' });
    return { success: true, deleted: deleted.length, stopped, dataDeleted: Boolean(deleteData), ids: deleted };
  }

  status() { return [...this.profiles.values()].map((profile) => ({ ...profile, ...this.publicRunning(profile.id), network: this.networkInfo.get(profile.id) || null, assignedExtensions: [...(this.assignments.get(profile.id) || [])] })); }

  async resolveProfileProxyConfig(profile, { allowExtract = true } = {}) {
    const working = this.resolveStoredProxyProfile(this.sanitizeProfile(profile));
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
    const timezone = resolveProfileTimezone(profile, network);
    const tzMode = String(privacy.timezoneMode || 'ip').trim().toLowerCase();
    const patch = {
      exitIp: network.ip || '',
      exitCountryCode: network.countryCode || '',
      exitTimezone: tzMode === 'real' ? '' : (timezone || network.timezone || ''),
      exitLatitude: network.latitude ?? null,
      exitLongitude: network.longitude ?? null,
      exitCheckedAt: network.checkedAt || new Date().toISOString(),
      language,
      privacy: { ...privacy },
    };
    if ((tzMode === 'ip' || tzMode === 'custom') && timezone) {
      patch.privacy.timezoneMode = privacy.timezoneMode || 'ip';
      patch.privacy.timezone = timezone;
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
        // Cold cache + a rate-limited probe service: the profile's last known exit is a valid
        // degradation source, otherwise a 429 would look like a dead proxy.
        profile,
        exitIp: profile.exitIp,
        exitCountryCode: profile.exitCountryCode,
        exitTimezone: profile.exitTimezone,
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
      err.code = error.code;
      err.probeUnavailable = error.probeUnavailable === true;
      err.errorClass = error.errorClass || classifyProxyError(error);
      err.latencyMs = error.latencyMs;
      throw err;
    }
  }

  async checkProxy(raw, options = {}) {
    const profile = this.restoreStoredProxyCredentials(
      this.resolveStoredProxyProfile(this.sanitizeProfile(raw)),
      raw,
    );
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
    const profile = this.restoreStoredProxyCredentials(
      this.resolveStoredProxyProfile(this.sanitizeProfile(raw)),
      raw,
    );
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
    let working = this.resolveStoredProxyProfile(this.sanitizeProfile(profile));
    const meta = working.proxyMeta || {};
    if (profile?.proxyMeta?.allowDirectFallback !== undefined) {
      meta.allowDirectFallback = Boolean(profile.proxyMeta.allowDirectFallback);
    }
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
        // A rate-limited or unreachable exit-probe service is NOT a dead proxy. Treating a 429 as
        // "proxy not ready" would block startup on a healthy tunnel. But we may only continue when
        // the exit geography is still knowable: without it the timezone/language cannot be aligned
        // to the real exit, and starting anyway would leak the host timezone.
        const probeUnavailable = lastError.code === 'probe-unavailable'
          || lastError.errorClass === 'probe-unavailable'
          || lastError.probeUnavailable === true;
        if (probeUnavailable) {
          const hasExitGeo = Boolean(
            working.exitIp
            || working.exitCountryCode
            || working.exitTimezone
            || working.privacy?.timezone
            || this.networkInfo.get(working.id)?.ip
          );
          if (hasExitGeo) {
            this.emit({
              type: 'proxy-warn',
              id: working.id,
              code: 'probe-unavailable',
              message: '出口探测服务受限（限频或超时），代理链路未见异常，已复用环境既有出口信息继续启动',
            });
            return working;
          }
          const probeMsg = '出口探测服务暂时不可用（限频或超时），且该环境尚无可用出口信息。为避免时区/语言与真实出口不一致而暴露指纹，已停止启动。请稍后重试，或点击「测试」强制刷新出口探测。';
          this.emit({
            type: 'proxy-error',
            id: working.id,
            code: 'probe-unavailable',
            message: probeMsg,
            policy: 'block',
          });
          throw Object.assign(new Error(probeMsg), { code: 'probe-unavailable' });
        }
        const policy = String(meta.notReadyPolicy || (meta.requireReady === false ? 'continue' : 'block'));
        const message = '启动前代理未就绪：' + (lastError.message || lastError);
        this.emit({ type: 'proxy-error', id: working.id, code: 'proxy-not-ready', message, policy });
        if (policy === 'direct') {
          const isExplicitOptIn = meta.allowDirectFallback === true || profile?.proxyMeta?.allowDirectFallback === true;
          if (isExplicitOptIn) {
            working = this.sanitizeProfile({ ...working, networkMode: 'direct', proxy: 'Direct' });
            this.emit({
              type: 'proxy-fallback',
              id: working.id,
              danger: true,
              level: 'danger',
              message: '【高危警告】代理未就绪，已按显式授权策略回落直连（存在真实公网IP暴露风险）',
            });
          } else {
            const blockMsg = message + '（代理未就绪且未显式配置 allowDirectFallback: true，已默认阻断启动以防止真实IP暴露）';
            this.emit({
              type: 'proxy-error',
              id: working.id,
              code: 'proxy-direct-fallback-blocked',
              message: blockMsg,
              policy: 'block',
            });
            throw new Error(blockMsg);
          }
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
  async reloadExtension(id) {
    const existing = this.extensions.get(id);
    if (!existing) throw new Error('Unknown extension');
    if (!fs.existsSync(existing.path)) throw new Error('Extension path does not exist');
    const updated = await this.readExtension(existing.path, Boolean(existing.builtIn));
    updated.addedAt = existing.addedAt || updated.addedAt;
    this.extensions.set(id, updated);
    await this.persist();
    this.emit({ type: 'extensions' });
    return updated;
  }
  async reloadAllExtensions() {
    const results = [];
    for (const [id, ext] of this.extensions.entries()) {
      if (fs.existsSync(ext.path)) {
        try {
          const updated = await this.readExtension(ext.path, Boolean(ext.builtIn));
          updated.addedAt = ext.addedAt || updated.addedAt;
          this.extensions.set(id, updated);
          results.push(updated);
        } catch (e) {
          console.warn('[extensions] Failed to reload extension ' + id + ':', e.message);
        }
      }
    }
    await this.persist();
    this.emit({ type: 'extensions' });
    return results;
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
  sanitizeInjectionScript,
  appendDiagnosticOutput,
  formatBrowserStartupError,
  writeBrowserStartupDiagnostic,
  systemBrowserCandidatesForPlatform,
  isValidIanaTimezone,
  extractTimezoneFromArgs,
  RequestHeaderRewriter,
  createRequestHeaderRewriter,
  CHROMIUM_CANONICAL_HEADER_ORDER,
  CHROMIUM_CANONICAL_HEADER_INDEX,
  evaluateFingerprintDelivery,
  normalizePlatformFamily,
  detectUaPlatform,
  extractChromeMajor,
  extractGpuBrand,
  normalizeTimezone,
  extractPrimaryLanguage,
};
