"use strict";

/**
 * User-Agent + Client Hints (UserAgentMetadata) builder.
 *
 * Surfaces:
 *  1) chrome arg `--user-agent=...`
 *  2) UserAgentMetadata / clientHints object
 *       { platform, platformVersion, architecture, model, mobile,
 *         wow64, uaFullVersion, bitness }
 *  3) Network/Emulation.setUserAgentOverride({ userAgent, userAgentMetadata })
 *  4) TLS: Chrome major <106 disable PermuteTLSExtensions, >=106 enable
 *
 * Applied via CDP + document-start JS inject on stock Chromium.
 */

const GREASE_BRANDS = [
  { brand: "Not:A-Brand", version: "99" },
  { brand: "Not A(Brand", version: "8" },
  { brand: "Not)A;Brand", version: "24" },
  { brand: "Not_A Brand", version: "8" },
  { brand: "Not/A)Brand", version: "8" },
];

const OS_PRESETS = {
  windows: {
    id: "windows",
    platformNav: "Win32",
    uaToken: "Windows NT 10.0; Win64; x64",
    chPlatform: "Windows",
    chPlatformVersion: "15.0.0",
    architecture: "x86",
    bitness: "64",
    wow64: false,
    vendor: "Google Inc.",
  },
  macos: {
    id: "macos",
    platformNav: "MacIntel",
    uaToken: "Macintosh; Intel Mac OS X 10_15_7",
    chPlatform: "macOS",
    chPlatformVersion: "14.5.0",
    architecture: "x86",
    bitness: "64",
    wow64: false,
    vendor: "Google Inc.",
  },
  macos_arm: {
    id: "macos_arm",
    platformNav: "MacIntel",
    uaToken: "Macintosh; Intel Mac OS X 10_15_7",
    chPlatform: "macOS",
    chPlatformVersion: "14.5.0",
    architecture: "arm",
    bitness: "64",
    wow64: false,
    vendor: "Google Inc.",
  },
  linux: {
    id: "linux",
    platformNav: "Linux x86_64",
    uaToken: "X11; Linux x86_64",
    chPlatform: "Linux",
    chPlatformVersion: "6.5.0",
    architecture: "x86",
    bitness: "64",
    wow64: false,
    vendor: "Google Inc.",
  },
  android: {
    id: "android",
    platformNav: "Linux armv8l",
    uaToken: "Linux; Android 10; K",
    chPlatform: "Android",
    chPlatformVersion: "14.0.0",
    architecture: "",
    bitness: "",
    model: "K",
    mobile: true,
    wow64: false,
    vendor: "Google Inc.",
  },
  ios: {
    id: "ios",
    platformNav: "iPhone",
    uaToken: "iPhone; CPU iPhone OS 18_0 like Mac OS X",
    chPlatform: "iOS",
    chPlatformVersion: "18.0.0",
    architecture: "arm",
    bitness: "64",
    model: "iPhone",
    mobile: true,
    wow64: false,
    vendor: "Apple Computer, Inc.",
  },
};

function detectHostOs() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "windows";
}

function parseChromeVersion(ua = "") {
  const m = String(ua).match(/Chrome\/([\d.]+)/i);
  if (!m) return null;
  const full = m[1];
  const major = Number(full.split(".")[0]) || 0;
  return { full, major };
}

function parseOsFromUa(ua = "") {
  const s = String(ua);
  if (/Windows NT/i.test(s)) return "windows";
  if (/Android/i.test(s)) return "android";
  if (/iPhone|iPad|iPod/i.test(s)) return "ios";
  if (/Macintosh|Mac OS X/i.test(s)) return "macos";
  if (/Linux/i.test(s)) return "linux";
  return detectHostOs();
}

/**
 * Build grease brands list similar to real Chrome sec-ch-ua order.
 */
function buildBrands(major) {
  const m = String(Math.max(1, Number(major) || 120));
  const grease = GREASE_BRANDS[Number(m) % GREASE_BRANDS.length];
  const chromium = { brand: "Chromium", version: m };
  const chrome = { brand: "Google Chrome", version: m };
  if (Number(m) % 2 === 0) return [grease, chromium, chrome];
  return [chrome, chromium, grease];
}

function buildFullVersionList(major, fullVersion) {
  const full = String(fullVersion || `${major}.0.0.0`);
  const brands = buildBrands(major);
  return brands.map((b) => {
    if (b.brand === "Chromium" || b.brand === "Google Chrome") {
      return { brand: b.brand, version: full };
    }
    return { brand: b.brand, version: `${b.version}.0.0.0` };
  });
}

function normalizeChromeFull(major, full) {
  const m = Number(major) || 120;
  if (full && /^\d+\.\d+\.\d+\.\d+$/.test(String(full))) return String(full);
  return `${m}.0.0.0`;
}

/**
 * Build a complete UA string for desktop or mobile Chrome.
 */
function buildUserAgentString(options = {}) {
  const osKey = OS_PRESETS[options.os] ? options.os : (options.os === "mac" ? "macos" : detectHostOs());
  const preset = OS_PRESETS[osKey] || OS_PRESETS.windows;
  const major = Number(options.chromeMajor || options.major || 131) || 131;
  const full = normalizeChromeFull(major, options.chromeFull || options.fullVersion);
  const chromeToken = options.reduced === false ? full : `${major}.0.0.0`;

  if (preset.id === "android") {
    const version = options.androidVersion || options.version || "14";
    const model = options.model || (options.reduced !== false ? "K" : "SM-S918B");
    return `Mozilla/5.0 (Linux; Android ${version}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeToken} Mobile Safari/537.36`;
  }
  if (preset.id === "ios") {
    const version = String(options.iosVersion || options.version || "18_0").replace(/\./g, "_");
    return `Mozilla/5.0 (iPhone; CPU iPhone OS ${version} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${chromeToken} Mobile/15E148 Safari/604.1`;
  }
  return `Mozilla/5.0 (${preset.uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeToken} Safari/537.36`;
}

/**
 * Derive Client Hints / UserAgentMetadata from UA (+ optional overrides).
 */
function buildUserAgentMetadata(ua, overrides = {}) {
  const parsed = parseChromeVersion(ua) || { full: "131.0.0.0", major: 131 };
  const osKey = overrides.os || parseOsFromUa(ua);
  const preset = OS_PRESETS[osKey] || OS_PRESETS.windows;
  const major = Number(overrides.chromeMajor || parsed.major) || 131;
  const fullVersion = normalizeChromeFull(
    major,
    overrides.ua_full_version || overrides.uaFullVersion || overrides.fullVersion || parsed.full
  );
  const brands = Array.isArray(overrides.brands) ? overrides.brands : buildBrands(major);
  const fullVersionList = Array.isArray(overrides.fullVersionList)
    ? overrides.fullVersionList
    : buildFullVersionList(major, fullVersion);

  const platform = overrides.platform || overrides.chPlatform || preset.chPlatform;
  let platformVersion = overrides.platform_version
    || overrides.platformVersion
    || preset.chPlatformVersion;
  let model = overrides.model != null ? String(overrides.model) : (preset.model || "");

  if (osKey === "android" && ua) {
    const androidMatch = String(ua).match(/Android\s+([0-9.]+)(?:;\s*([^)]+))?/i);
    if (androidMatch) {
      if (!overrides.platform_version && !overrides.platformVersion) {
        platformVersion = `${androidMatch[1]}.0.0`;
      }
      if (overrides.model == null && androidMatch[2]) {
        const rawModel = androidMatch[2].trim();
        if (rawModel) model = rawModel;
      }
    }
  }

  const isMobile = overrides.mobile !== undefined
    ? (overrides.mobile === true || overrides.mobile === "1" || overrides.mobile === 1)
    : (/Mobile/i.test(ua) || Boolean(preset.mobile));

  // Android Client Hints report empty string for architecture and bitness
  const architecture = overrides.architecture !== undefined
    ? String(overrides.architecture)
    : (osKey === "android" ? "" : preset.architecture);
  const bitness = overrides.bitness !== undefined
    ? String(overrides.bitness)
    : (osKey === "android" ? "" : preset.bitness);
  const wow64 = overrides.wow64 === true || overrides.wow64 === "1" || overrides.wow64 === 1
    ? true
    : Boolean(preset.wow64);

  return {
    brands,
    fullVersionList,
    fullVersion,
    platform,
    platformVersion,
    architecture,
    model,
    mobile: isMobile,
    bitness,
    wow64,
    uaFullVersion: fullVersion,
    platform_version: platformVersion,
    ua_full_version: fullVersion,
  };
}

/**
 * Full UA profile: string + navigator fields + client hints + chrome flags.
 */
function buildUaProfile(options = {}) {
  let userAgent = String(options.userAgent || options.ua || "").trim();
  const osKey = options.os
    || (userAgent ? parseOsFromUa(userAgent) : detectHostOs());
  const majorHint = Number(options.chromeMajor || options.major) || 0;

  if (!userAgent) {
    userAgent = buildUserAgentString({
      os: osKey,
      chromeMajor: majorHint || 131,
      chromeFull: options.chromeFull || options.fullVersion,
      reduced: options.reduced !== false,
      model: options.model,
      androidVersion: options.androidVersion,
      version: options.version,
    });
  }

  const parsed = parseChromeVersion(userAgent) || { full: "131.0.0.0", major: 131 };
  const major = majorHint || parsed.major;
  const fullForHints = normalizeChromeFull(
    major,
    options.ua_full_version || options.fullVersion || options.chromeFull || parsed.full
  );

  const metadata = buildUserAgentMetadata(userAgent, {
    ...options,
    os: osKey,
    chromeMajor: major,
    ua_full_version: fullForHints,
  });

  const preset = OS_PRESETS[osKey] || OS_PRESETS.windows;
  const platformNav = options.platformNav || options.platform || preset.platformNav;

  const appVersion = userAgent.replace(/^Mozilla\//, "");

  return {
    userAgent,
    appVersion,
    platform: platformNav,
    vendor: options.vendor || preset.vendor || "Google Inc.",
    chromeMajor: major,
    chromeFull: fullForHints,
    os: osKey,
    metadata,
    clientHints: {
      platform: metadata.platform,
      platform_version: metadata.platformVersion,
      architecture: metadata.architecture,
      model: metadata.model,
      mobile: metadata.mobile ? "1" : "0",
      wow64: metadata.wow64 ? "1" : "0",
      ua_full_version: metadata.uaFullVersion,
      bitness: metadata.bitness,
    },
  };
}

/**
 * TLS extension permutation flags based on Chrome major from UA.
 */
function chromeArgsForUa(uaProfile) {
  const args = [];
  const major = Number(uaProfile?.chromeMajor) || parseChromeVersion(uaProfile?.userAgent || "")?.major || 0;
  if (!major) return args;
  if (major < 106) {
    args.push("--disable-features=PermuteTLSExtensions");
  } else {
    args.push("--enable-features=PermuteTLSExtensions");
  }
  return args;
}

/**
 * Clean comma-separated language tags for CDP Network.setUserAgentOverride.
 * Removes premature q-values to prevent double-weighting by the browser network stack.
 */
function formatAcceptLanguage(languages) {
  if (!languages) return "";
  const list = Array.isArray(languages)
    ? languages
    : String(languages).split(",");
  const cleaned = list
    .map((tag) => String(tag || "").trim().split(";")[0].trim())
    .filter(Boolean);
  return Array.from(new Set(cleaned)).join(",");
}

/**
 * Build RFC-compliant Accept-Language header with descending quality values.
 */
function buildAcceptLanguageHeader(languages) {
  if (!languages) return "";
  const list = Array.isArray(languages)
    ? languages
    : String(languages).split(",");
  const cleaned = list
    .map((tag) => String(tag || "").trim().split(";")[0].trim())
    .filter(Boolean);
  if (!cleaned.length) return "";
  return cleaned.map((lang, idx) => {
    if (idx === 0) return lang;
    const q = Math.max(0.1, 1.0 - idx * 0.1).toFixed(1).replace(/\.0$/, "");
    return `${lang};q=${q}`;
  }).join(",");
}

/**
 * CDP payload for Emulation.setUserAgentOverride / Network.setUserAgentOverride.
 */
function cdpUserAgentOverride(uaProfile, acceptLanguage = "") {
  const meta = uaProfile.metadata || buildUserAgentMetadata(uaProfile.userAgent);
  const cleanLang = formatAcceptLanguage(acceptLanguage);
  return {
    userAgent: uaProfile.userAgent,
    acceptLanguage: cleanLang || undefined,
    platform: uaProfile.platform,
    userAgentMetadata: {
      brands: meta.brands,
      fullVersionList: meta.fullVersionList,
      fullVersion: meta.fullVersion || meta.uaFullVersion,
      platform: meta.platform,
      platformVersion: meta.platformVersion,
      architecture: meta.architecture ?? "",
      model: meta.model || "",
      mobile: Boolean(meta.mobile),
      bitness: meta.bitness ?? "",
      wow64: Boolean(meta.wow64),
    },
  };
}

/**
 * Document-start patch: navigator.userAgent / appVersion / platform / userAgentData.
 * Supports both Window (Navigator) and DedicatedWorker (WorkerNavigator) contexts.
 */
function buildUaInjectionScript(uaProfile) {
  const payload = {
    userAgent: uaProfile.userAgent,
    appVersion: uaProfile.appVersion,
    platform: uaProfile.platform,
    vendor: uaProfile.vendor || "Google Inc.",
    brands: uaProfile.metadata?.brands || [],
    fullVersionList: uaProfile.metadata?.fullVersionList || [],
    fullVersion: uaProfile.metadata?.uaFullVersion || uaProfile.chromeFull,
    chPlatform: uaProfile.metadata?.platform || "Windows",
    platformVersion: uaProfile.metadata?.platformVersion || "",
    architecture: uaProfile.metadata?.architecture ?? "x86",
    model: uaProfile.metadata?.model || "",
    mobile: Boolean(uaProfile.metadata?.mobile),
    bitness: uaProfile.metadata?.bitness ?? "64",
    wow64: Boolean(uaProfile.metadata?.wow64),
  };
  const json = JSON.stringify(payload);
  return `(() => {
  const U = ${json};
  const nativeSource = new WeakMap();
  const originalToString = Function.prototype.toString;
  const nativeLike = (wrapper, original) => {
    try { Object.defineProperty(wrapper, "name", { configurable: true, value: original?.name || wrapper.name }); } catch (_) {}
    try { Object.defineProperty(wrapper, "length", { configurable: true, value: original?.length ?? wrapper.length }); } catch (_) {}
    try { nativeSource.set(wrapper, original ? originalToString.call(original) : "function () { [native code] }"); } catch (_) {}
    return wrapper;
  };

  const getRealmTypeError = (receiver, fallbackProto) => {
    try {
      if (receiver) {
        if (receiver.ownerDocument && receiver.ownerDocument.defaultView && receiver.ownerDocument.defaultView.TypeError) {
          return receiver.ownerDocument.defaultView.TypeError;
        }
        if (receiver.defaultView && receiver.defaultView.TypeError) {
          return receiver.defaultView.TypeError;
        }
        if (typeof receiver.TypeError === "function") {
          return receiver.TypeError;
        }
        const ctor = receiver.constructor;
        if (ctor) {
          if (ctor.ownerDocument && ctor.ownerDocument.defaultView && ctor.ownerDocument.defaultView.TypeError) {
            return ctor.ownerDocument.defaultView.TypeError;
          }
          if (typeof ctor.constructor === "function") {
            try {
              const globalObj = ctor.constructor("return this")();
              if (globalObj && globalObj.TypeError) return globalObj.TypeError;
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
    try {
      if (fallbackProto && fallbackProto.constructor && typeof fallbackProto.constructor.constructor === "function") {
        try {
          const globalObj = fallbackProto.constructor.constructor("return this")();
          if (globalObj && globalObj.TypeError) return globalObj.TypeError;
        } catch (_) {}
      }
    } catch (_) {}
    return (typeof TypeError !== "undefined" ? TypeError : Error);
  };

  const patchSubWindow = (subWin) => {
    try {
      if (!subWin || patchedSubWindows.has(subWin)) return;
      patchedSubWindows.add(subWin);
      if (subWin.Function && subWin.Function.prototype) {
        const origSubToString = subWin.Function.prototype.toString;
        if (!nativeSource.has(origSubToString)) {
          const subHolder = {
            toString(...args) {
              const secret = args[0];
              if (typeof secret === "string" && secret.length > 0) {
                if (nativeSource.has(this)) return { bridge: true, nativeText: nativeSource.get(this) };
                try {
                  const inherited = origSubToString.call(this, secret);
                  if (inherited && typeof inherited === "object" && inherited.bridge === true) return inherited;
                } catch (_) {}
                return null;
              }
              if (nativeSource.has(this)) return nativeSource.get(this);
              try {
                const inherited = origSubToString.call(this, ...args);
                if (inherited && typeof inherited === "object" && inherited.bridge === true && inherited.nativeText) {
                  return inherited.nativeText;
                }
              } catch (_) {}
              return origSubToString.call(this, ...args);
            }
          };
          const patchedSubToString = subHolder.toString;
          nativeSource.set(patchedSubToString, "function toString() { [native code] }");
          try { Object.defineProperty(patchedSubToString, "name", { configurable: true, value: "toString" }); } catch (_) {}
          try { Object.defineProperty(patchedSubToString, "length", { configurable: true, value: 0 }); } catch (_) {}
          Object.defineProperty(subWin.Function.prototype, "toString", {
            configurable: true,
            writable: true,
            value: patchedSubToString,
          });
        }
      }
      if (subWin.Navigator && subWin.Navigator.prototype) {
        applyNavPatches(subWin.Navigator.prototype);
      }
      if (subWin.navigator) {
        cleanNavProperties(subWin.navigator);
      }
      hookIframeAccess(subWin);
    } catch (_) {}
  };

  const patchedSubWindows = new WeakSet();
  const hookIframeAccess = (targetWin) => {
    try {
      const win = targetWin || (typeof window !== "undefined" ? window : null);
      if (!win) return;
      if (win.HTMLIFrameElement && win.HTMLIFrameElement.prototype) {
        const descCW = Object.getOwnPropertyDescriptor(win.HTMLIFrameElement.prototype, "contentWindow");
        if (descCW && typeof descCW.get === "function" && !nativeSource.has(descCW.get)) {
          const origCW = descCW.get;
          let patchedCW;
          const holderCW = {};
          Object.defineProperty(holderCW, "contentWindow", {
            configurable: true,
            get: function() {
              try {
                const sw = origCW.call(this);
                if (sw) patchSubWindow(sw);
                return sw;
              } catch (err) {
                stripStackFrame(err, patchedCW, "get contentWindow");
                throw err;
              }
            }
          });
          patchedCW = Object.getOwnPropertyDescriptor(holderCW, "contentWindow").get;
          try { Object.defineProperty(patchedCW, "name", { configurable: true, value: "get contentWindow" }); } catch (_) {}
          try { Object.defineProperty(patchedCW, "length", { configurable: true, value: 0 }); } catch (_) {}
          nativeSource.set(patchedCW, "function get contentWindow() { [native code] }");
          Object.defineProperty(win.HTMLIFrameElement.prototype, "contentWindow", {
            configurable: true,
            enumerable: true,
            get: patchedCW,
          });
        }
        const descCD = Object.getOwnPropertyDescriptor(win.HTMLIFrameElement.prototype, "contentDocument");
        if (descCD && typeof descCD.get === "function" && !nativeSource.has(descCD.get)) {
          const origCD = descCD.get;
          let patchedCD;
          const holderCD = {};
          Object.defineProperty(holderCD, "contentDocument", {
            configurable: true,
            get: function() {
              try {
                const sd = origCD.call(this);
                if (sd && sd.defaultView) patchSubWindow(sd.defaultView);
                return sd;
              } catch (err) {
                stripStackFrame(err, patchedCD, "get contentDocument");
                throw err;
              }
            }
          });
          patchedCD = Object.getOwnPropertyDescriptor(holderCD, "contentDocument").get;
          try { Object.defineProperty(patchedCD, "name", { configurable: true, value: "get contentDocument" }); } catch (_) {}
          try { Object.defineProperty(patchedCD, "length", { configurable: true, value: 0 }); } catch (_) {}
          nativeSource.set(patchedCD, "function get contentDocument() { [native code] }");
          Object.defineProperty(win.HTMLIFrameElement.prototype, "contentDocument", {
            configurable: true,
            enumerable: true,
            get: patchedCD,
          });
        }
      }
      if (typeof win.open === "function" && !nativeSource.has(win.open)) {
        const origOpen = win.open;
        let patchedOpen;
        const holderOpen = {
          open(...args) {
            try {
              const opened = origOpen.apply(this, args);
              if (opened) patchSubWindow(opened);
              return opened;
            } catch (err) {
              stripStackFrame(err, patchedOpen, "open");
              throw err;
            }
          }
        };
        patchedOpen = holderOpen.open;
        try { Object.defineProperty(patchedOpen, "name", { configurable: true, value: "open" }); } catch (_) {}
        try { Object.defineProperty(patchedOpen, "length", { configurable: true, value: origOpen.length || 0 }); } catch (_) {}
        nativeSource.set(patchedOpen, "function open() { [native code] }");
        try {
          Object.defineProperty(win, "open", {
            configurable: true,
            writable: true,
            value: patchedOpen,
          });
        } catch (_) {}
      }
    } catch (_) {}
  };

  try {
    if (!nativeSource.has(Function.prototype.toString)) {
      const holder = {
        toString(...args) {
          const secret = args[0];
          if (typeof secret === "string" && secret.length > 0) {
            if (nativeSource.has(this)) return { bridge: true, nativeText: nativeSource.get(this) };
            try {
              const inherited = originalToString.call(this, secret);
              if (inherited && typeof inherited === "object" && inherited.bridge === true) return inherited;
            } catch (_) {}
            return null;
          }
          if (nativeSource.has(this)) return nativeSource.get(this);
          return originalToString.call(this, ...args);
        }
      };
      const patchedToString = holder.toString;
      nativeSource.set(patchedToString, "function toString() { [native code] }");
      try { Object.defineProperty(patchedToString, "name", { configurable: true, value: "toString" }); } catch (_) {}
      try { Object.defineProperty(patchedToString, "length", { configurable: true, value: 0 }); } catch (_) {}
      Object.defineProperty(Function.prototype, "toString", {
        configurable: true,
        writable: true,
        value: patchedToString,
      });
    }
  } catch (_) {}

  const sameValue = (obj, key, expected) => {
    try { return obj && obj[key] === expected; } catch (_) { return false; }
  };
  const isNav = (receiver) => {
    try {
      if (!receiver) return false;
      if (typeof Navigator !== "undefined" && receiver === Navigator.prototype) return false;
      if (typeof WorkerNavigator !== "undefined" && receiver === WorkerNavigator.prototype) return false;
      if (receiver && receiver.constructor && receiver.constructor.prototype === receiver) return false;
      if (typeof navigator !== "undefined" && receiver === navigator) return true;
      if (typeof Navigator !== "undefined" && (receiver instanceof Navigator || Object.prototype.toString.call(receiver) === "[object Navigator]")) return true;
      if (typeof WorkerNavigator !== "undefined" && (receiver instanceof WorkerNavigator || Object.prototype.toString.call(receiver) === "[object WorkerNavigator]")) return true;
      return false;
    } catch (_) { return false; }
  };
  const stripStackFrame = (err, fn, frameName) => {
    if (!err) return err;
    if (typeof Error.captureStackTrace === "function" && typeof fn === "function") {
      try { Error.captureStackTrace(err, fn); } catch (_) {}
    }
    if (typeof err.stack === "string") {
      const nl = String.fromCharCode(10);
      const lines = err.stack.split(nl);
      const baseName = (frameName && frameName.indexOf("get ") === 0) ? frameName.slice(4) : "";
      const header = lines[0];
      const filtered = lines.slice(1).filter((l) => {
        if (frameName && l.indexOf(frameName) !== -1) return false;
        if (baseName && l.indexOf(baseName) !== -1) return false;
        if (l.indexOf("stripStackFrame") !== -1 || l.indexOf("nativeGetter") !== -1 || l.indexOf("isNav") !== -1) return false;
        return true;
      });
      try { err.stack = [header, ...filtered].join(nl); } catch (_) {}
    }
    return err;
  };
  const define = (obj, key, getter) => {
    if (sameValue(obj, key, getter())) return true;
    let originalGetter = null;
    try {
      let cursor = obj;
      while (cursor && !originalGetter) {
        originalGetter = Object.getOwnPropertyDescriptor(cursor, key)?.get || null;
        cursor = Object.getPrototypeOf(cursor);
      }
    } catch (_) {}
    let nativeGetter;
    const holder = {};
    Object.defineProperty(holder, key, {
      configurable: true,
      get: function() {
        if (!isNav(this)) {
          const RealmTypeError = getRealmTypeError(this, obj);
          if (originalGetter) {
            try {
              return originalGetter.call(this);
            } catch (err) {
              if (RealmTypeError !== TypeError && err && err.name === "TypeError") {
                const reErr = new RealmTypeError(err.message || "Illegal invocation");
                stripStackFrame(reErr, nativeGetter, "get " + key);
                throw reErr;
              }
              stripStackFrame(err, nativeGetter, "get " + key);
              throw err;
            }
          }
          const err = new RealmTypeError("Illegal invocation");
          stripStackFrame(err, nativeGetter, "get " + key);
          throw err;
        }
        return getter();
      }
    });
    nativeGetter = Object.getOwnPropertyDescriptor(holder, key).get;
    try { Object.defineProperty(nativeGetter, "name", { configurable: true, value: originalGetter?.name || ("get " + key) }); } catch (_) {}
    try { Object.defineProperty(nativeGetter, "length", { configurable: true, value: 0 }); } catch (_) {}
    try { nativeSource.set(nativeGetter, originalGetter ? originalToString.call(originalGetter) : ("function get " + key + "() { [native code] }")); } catch (_) {}
    try {
      Object.defineProperty(obj, key, { configurable: true, enumerable: true, get: nativeGetter });
      return true;
    } catch (_) {
      try { Object.defineProperty(obj, key, { configurable: true, get: nativeGetter }); return true; } catch (__) { return false; }
    }
  };
  const contextExposesClientHints = () => {
    try {
      if (typeof Navigator !== "undefined" && Navigator.prototype && ("userAgentData" in Navigator.prototype)) return true;
      if (typeof WorkerNavigator !== "undefined" && WorkerNavigator.prototype && ("userAgentData" in WorkerNavigator.prototype)) return true;
      return typeof navigator !== "undefined" && navigator.userAgentData != null;
    } catch (_) { return false; }
  };
  const applyNavPatches = (proto) => {
    if (!proto) return;
    define(proto, "userAgent", () => U.userAgent);
    define(proto, "appVersion", () => U.appVersion);
    define(proto, "platform", () => U.platform);
    define(proto, "vendor", () => U.vendor);
    if (typeof Navigator !== "undefined" && proto === Navigator.prototype) {
      define(proto, "appCodeName", () => "Mozilla");
      define(proto, "appName", () => "Netscape");
      define(proto, "product", () => "Gecko");
      define(proto, "productSub", () => "20030107");
      define(proto, "vendorSub", () => "");
    }
  };
  const cleanNavProperties = (nav) => {
    if (!nav) return;
    ["userAgent", "appVersion", "platform", "vendor", "appCodeName", "appName", "product", "productSub", "vendorSub"].forEach((k) => {
      try { delete nav[k]; } catch (_) {}
    });
  };
  try {
    const navPrototypes = [];
    if (typeof Navigator !== "undefined" && Navigator.prototype) navPrototypes.push(Navigator.prototype);
    if (typeof WorkerNavigator !== "undefined" && WorkerNavigator.prototype) navPrototypes.push(WorkerNavigator.prototype);
    for (const proto of navPrototypes) {
      applyNavPatches(proto);
    }
    if (typeof navigator !== "undefined") {
      cleanNavProperties(navigator);
    }
  } catch (_) {}

  // userAgentData (Client Hints JS API)
  try {
    const brands = (U.brands || []).map((b) => ({ brand: String(b.brand), version: String(b.version) }));
    const fullVersionList = (U.fullVersionList || brands).map((b) => ({ brand: String(b.brand), version: String(b.version) }));
    const highEntropy = {
      brands,
      fullVersionList,
      fullVersion: String(U.fullVersion || ""),
      platform: String(U.chPlatform || ""),
      platformVersion: String(U.platformVersion || ""),
      architecture: String(U.architecture ?? ""),
      model: String(U.model || ""),
      mobile: Boolean(U.mobile),
      bitness: String(U.bitness ?? ""),
      wow64: Boolean(U.wow64),
      uaFullVersion: String(U.fullVersion || ""),
    };
    const parseHints = (hints, targetMethod, ErrorCtor = TypeError) => {
      if (hints === null || hints === undefined || typeof hints === "number" || typeof hints === "boolean" || typeof hints === "string" || typeof hints === "symbol" || typeof hints === "bigint") {
        throw new ErrorCtor("Failed to execute '" + targetMethod + "' on 'NavigatorUAData': The provided value cannot be converted to a sequence.");
      }
      if (typeof hints[Symbol.iterator] !== "function") {
        throw new ErrorCtor("Failed to execute '" + targetMethod + "' on 'NavigatorUAData': The object must have a callable @@iterator property.");
      }
      return Array.from(hints, (item) => String(item));
    };

    if (typeof NavigatorUAData !== "undefined") {
      const targetProto = NavigatorUAData.prototype;
      const makeUaGetter = (prop, fn) => {
        let originalGetter = null;
        try {
          originalGetter = Object.getOwnPropertyDescriptor(targetProto, prop)?.get || null;
        } catch (_) {}
        let g;
        const h = {};
        Object.defineProperty(h, prop, {
          configurable: true,
          get: function() {
            if (!(this instanceof NavigatorUAData) && Object.prototype.toString.call(this) !== "[object NavigatorUAData]") {
              const RealmTypeError = getRealmTypeError(this, targetProto);
              if (originalGetter) {
                try {
                  return originalGetter.call(this);
                } catch (err) {
                  if (RealmTypeError !== TypeError && err && err.name === "TypeError") {
                    const reErr = new RealmTypeError(err.message || "Illegal invocation");
                    stripStackFrame(reErr, g, "get " + prop);
                    throw reErr;
                  }
                  stripStackFrame(err, g, "get " + prop);
                  throw err;
                }
              }
              const err = new RealmTypeError("Illegal invocation");
              stripStackFrame(err, g, "get " + prop);
              throw err;
            }
            return fn.call(this);
          }
        });
        g = Object.getOwnPropertyDescriptor(h, prop).get;
        try { Object.defineProperty(g, "name", { configurable: true, value: originalGetter?.name || ("get " + prop) }); } catch (_) {}
        try { Object.defineProperty(g, "length", { configurable: true, value: 0 }); } catch (_) {}
        nativeSource.set(g, originalGetter ? originalToString.call(originalGetter) : ("function get " + prop + "() { [native code] }"));
        return g;
      };
      Object.defineProperty(targetProto, "brands", { get: makeUaGetter("brands", () => Object.freeze(brands)), enumerable: true, configurable: true });
      Object.defineProperty(targetProto, "mobile", { get: makeUaGetter("mobile", () => Boolean(U.mobile)), enumerable: true, configurable: true });
      Object.defineProperty(targetProto, "platform", { get: makeUaGetter("platform", () => String(U.chPlatform || "")), enumerable: true, configurable: true });
      const nativeGeh = targetProto.getHighEntropyValues;
      const nativeToJSON = targetProto.toJSON;
      const isUaReceiver = (receiver) => {
        try {
          return receiver instanceof NavigatorUAData
            || Object.prototype.toString.call(receiver) === "[object NavigatorUAData]";
        } catch (_) { return false; }
      };
      let geh;
      const gehHolder = {
        getHighEntropyValues(hints) {
          const RealmTypeError = getRealmTypeError(this, targetProto);
          if (!isUaReceiver(this)) {
            if (typeof nativeGeh === "function") return nativeGeh.apply(this, arguments);
            const err = new RealmTypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': Illegal invocation");
            stripStackFrame(err, geh, "getHighEntropyValues");
            return Promise.reject(err);
          }
          if (arguments.length < 1) {
            const err = new RealmTypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': 1 argument required, but only 0 present.");
            stripStackFrame(err, geh, "getHighEntropyValues");
            return Promise.reject(err);
          }
          let want;
          try {
            want = parseHints(hints, "getHighEntropyValues", RealmTypeError);
          } catch (err) {
            stripStackFrame(err, geh, "getHighEntropyValues");
            return Promise.reject(err);
          }
          const out = { brands, mobile: Boolean(U.mobile), platform: String(U.chPlatform || "") };
          for (const h of want) {
            if (h in highEntropy) out[h] = highEntropy[h];
            if (h === "uaFullVersion") out.uaFullVersion = highEntropy.fullVersion;
          }
          return Promise.resolve(out);
        }
      };
      geh = gehHolder.getHighEntropyValues;
      nativeSource.set(geh, "function getHighEntropyValues() { [native code] }");
      Object.defineProperty(targetProto, "getHighEntropyValues", { configurable: true, writable: true, enumerable: true, value: geh });
      let tj;
      const tjHolder = {
        toJSON() {
          if (!isUaReceiver(this)) {
            if (typeof nativeToJSON === "function") {
              try {
                return nativeToJSON.apply(this, arguments);
              } catch (err) {
                const RealmTypeError = getRealmTypeError(this, targetProto);
                if (RealmTypeError !== TypeError && err && err.name === "TypeError") {
                  const reErr = new RealmTypeError(err.message || "Illegal invocation");
                  stripStackFrame(reErr, tj, "toJSON");
                  throw reErr;
                }
                stripStackFrame(err, tj, "toJSON");
                throw err;
              }
            }
            const RealmTypeError = getRealmTypeError(this, targetProto);
            const err = new RealmTypeError("Illegal invocation");
            stripStackFrame(err, tj, "toJSON");
            throw err;
          }
          return { brands, mobile: Boolean(U.mobile), platform: String(U.chPlatform || "") };
        }
      };
      tj = tjHolder.toJSON;
      nativeSource.set(tj, "function toJSON() { [native code] }");
      Object.defineProperty(targetProto, "toJSON", { configurable: true, writable: true, enumerable: true, value: tj });

      const existing = (() => { try { return navigator.userAgentData; } catch (_) { return null; } })();
      if (existing) {
        try {
          delete existing.brands;
          delete existing.mobile;
          delete existing.platform;
          delete existing.getHighEntropyValues;
          delete existing.toJSON;
        } catch (_) {}
      } else if (contextExposesClientHints()) {
        const uaData = Object.create(targetProto);
        const protoTarget = typeof Navigator !== "undefined" ? Navigator.prototype : (typeof WorkerNavigator !== "undefined" ? WorkerNavigator.prototype : null);
        if (protoTarget) define(protoTarget, "userAgentData", () => uaData);
        try { delete navigator.userAgentData; } catch (_) {}
      }
    } else {
      const uaData = {};
      const makeUaGetter = (prop, fn) => {
        let g;
        const h = {};
        Object.defineProperty(h, prop, {
          configurable: true,
          get: function() {
            if (this !== uaData) {
              const RealmTypeError = getRealmTypeError(this);
              const err = new RealmTypeError("Illegal invocation");
              stripStackFrame(err, g, "get " + prop);
              throw err;
            }
            return fn.call(this);
          }
        });
        g = Object.getOwnPropertyDescriptor(h, prop).get;
        try { Object.defineProperty(g, "name", { configurable: true, value: "get " + prop }); } catch (_) {}
        try { Object.defineProperty(g, "length", { configurable: true, value: 0 }); } catch (_) {}
        nativeSource.set(g, "function get " + prop + "() { [native code] }");
        return g;
      };
      Object.defineProperty(uaData, "brands", { get: makeUaGetter("brands", () => Object.freeze(brands)), enumerable: true, configurable: true });
      Object.defineProperty(uaData, "mobile", { get: makeUaGetter("mobile", () => Boolean(U.mobile)), enumerable: true, configurable: true });
      Object.defineProperty(uaData, "platform", { get: makeUaGetter("platform", () => String(U.chPlatform || "")), enumerable: true, configurable: true });
      let geh;
      const gehHolder = {
        getHighEntropyValues(hints) {
          const RealmTypeError = getRealmTypeError(this);
          if (this !== uaData) {
            const err = new RealmTypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': Illegal invocation");
            stripStackFrame(err, geh, "getHighEntropyValues");
            return Promise.reject(err);
          }
          if (arguments.length < 1) {
            const err = new RealmTypeError("Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': 1 argument required, but only 0 present.");
            stripStackFrame(err, geh, "getHighEntropyValues");
            return Promise.reject(err);
          }
          let want;
          try {
            want = parseHints(hints, "getHighEntropyValues", RealmTypeError);
          } catch (err) {
            stripStackFrame(err, geh, "getHighEntropyValues");
            return Promise.reject(err);
          }
          const out = { brands, mobile: Boolean(U.mobile), platform: String(U.chPlatform || "") };
          for (const h of want) {
            if (h in highEntropy) out[h] = highEntropy[h];
            if (h === "uaFullVersion") out.uaFullVersion = highEntropy.fullVersion;
          }
          return Promise.resolve(out);
        }
      };
      geh = gehHolder.getHighEntropyValues;
      nativeSource.set(geh, "function getHighEntropyValues() { [native code] }");
      Object.defineProperty(uaData, "getHighEntropyValues", { configurable: true, writable: true, enumerable: true, value: geh });
      let tj;
      const tjHolder = {
        toJSON() {
          const RealmTypeError = getRealmTypeError(this);
          if (this !== uaData) {
            const err = new RealmTypeError("Illegal invocation");
            stripStackFrame(err, tj, "toJSON");
            throw err;
          }
          return { brands, mobile: Boolean(U.mobile), platform: String(U.chPlatform || "") };
        }
      };
      tj = tjHolder.toJSON;
      nativeSource.set(tj, "function toJSON() { [native code] }");
      Object.defineProperty(uaData, "toJSON", { configurable: true, writable: true, enumerable: true, value: tj });
      if (contextExposesClientHints()) {
        const protoTarget = typeof Navigator !== "undefined" ? Navigator.prototype : (typeof WorkerNavigator !== "undefined" ? WorkerNavigator.prototype : null);
        if (protoTarget) define(protoTarget, "userAgentData", () => uaData);
        try { delete navigator.userAgentData; } catch (_) {}
      }
    }
  } catch (_) {}
  try {
    hookIframeAccess();
  } catch (_) {}
})();`;
}

function randomUaForSeed(seedU32, options = {}) {
  const osList = options.osList || ["windows", "windows", "macos", "linux"];
  const os = osList[seedU32 % osList.length];
  const majors = options.majors || [128, 129, 130, 131, 132, 133, 134, 135, 136, 137];
  const major = majors[(seedU32 >>> 8) % majors.length];
  const build = 6000 + ((seedU32 >>> 16) % 900);
  const patch = (seedU32 >>> 24) % 200;
  const full = `${major}.0.${build}.${patch}`;
  return buildUaProfile({
    os,
    chromeMajor: major,
    chromeFull: full,
    reduced: true,
    ua_full_version: full,
    architecture: os === "macos" && (seedU32 & 1) ? "arm" : undefined,
  });
}

module.exports = {
  OS_PRESETS,
  GREASE_BRANDS,
  detectHostOs,
  parseChromeVersion,
  parseOsFromUa,
  buildBrands,
  buildFullVersionList,
  buildUserAgentString,
  buildUserAgentMetadata,
  buildUaProfile,
  chromeArgsForUa,
  formatAcceptLanguage,
  buildAcceptLanguageHeader,
  cdpUserAgentOverride,
  buildUaInjectionScript,
  randomUaForSeed,
};
