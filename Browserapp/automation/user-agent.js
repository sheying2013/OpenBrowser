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
  try {
    if (!nativeSource.has(Function.prototype.toString)) {
      const holder = {
        toString() {
          if (nativeSource.has(this)) return nativeSource.get(this);
          return originalToString.call(this);
        }
      };
      const patchedToString = holder.toString;
      nativeSource.set(patchedToString, "function toString() { [native code] }");
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
      if (typeof navigator !== "undefined" && receiver === navigator) return true;
      if (typeof Navigator !== "undefined" && (receiver instanceof Navigator || Object.prototype.toString.call(receiver) === "[object Navigator]")) return true;
      if (typeof WorkerNavigator !== "undefined" && (receiver instanceof WorkerNavigator || Object.prototype.toString.call(receiver) === "[object WorkerNavigator]")) return true;
      return false;
    } catch (_) { return false; }
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
    const holder = {
      get [key]() {
        if (!isNav(this)) {
          throw new TypeError("Illegal invocation");
        }
        return getter();
      }
    };
    const nativeGetter = Object.getOwnPropertyDescriptor(holder, key).get;
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
  try {
    const navPrototypes = [];
    if (typeof Navigator !== "undefined" && Navigator.prototype) navPrototypes.push(Navigator.prototype);
    if (typeof WorkerNavigator !== "undefined" && WorkerNavigator.prototype) navPrototypes.push(WorkerNavigator.prototype);
    for (const proto of navPrototypes) {
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
    }
    if (typeof navigator !== "undefined") {
      ["userAgent", "appVersion", "platform", "vendor", "appCodeName", "appName", "product", "productSub", "vendorSub"].forEach((k) => {
        try { delete navigator[k]; } catch (_) {}
      });
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
    if (typeof NavigatorUAData !== "undefined") {
      const targetProto = NavigatorUAData.prototype;
      const makeUaGetter = (prop, fn) => {
        const h = {
          get [prop]() {
            if (!(this instanceof NavigatorUAData) && Object.prototype.toString.call(this) !== "[object NavigatorUAData]") {
              throw new TypeError("Illegal invocation");
            }
            return fn.call(this);
          }
        };
        const g = Object.getOwnPropertyDescriptor(h, prop).get;
        nativeSource.set(g, "function get " + prop + "() { [native code] }");
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
      const geh = {
        getHighEntropyValues(hints) {
          if (!isUaReceiver(this)) {
            if (typeof nativeGeh === "function") return nativeGeh.apply(this, arguments);
            return Promise.reject(new TypeError("Illegal invocation"));
          }
          const want = Array.isArray(hints) ? hints : [];
          const out = { brands, mobile: Boolean(U.mobile), platform: String(U.chPlatform || "") };
          for (const h of want) {
            if (h in highEntropy) out[h] = highEntropy[h];
            if (h === "uaFullVersion") out.uaFullVersion = highEntropy.fullVersion;
          }
          return Promise.resolve(out);
        }
      }.getHighEntropyValues;
      nativeSource.set(geh, "function getHighEntropyValues() { [native code] }");
      Object.defineProperty(targetProto, "getHighEntropyValues", { configurable: true, writable: true, enumerable: true, value: geh });
      const tj = {
        toJSON() {
          if (!isUaReceiver(this)) {
            if (typeof nativeToJSON === "function") return nativeToJSON.apply(this, arguments);
            throw new TypeError("Illegal invocation");
          }
          return { brands, mobile: Boolean(U.mobile), platform: String(U.chPlatform || "") };
        }
      }.toJSON;
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
        const h = {
          get [prop]() {
            if (this !== uaData) {
              throw new TypeError("Illegal invocation");
            }
            return fn.call(this);
          }
        };
        const g = Object.getOwnPropertyDescriptor(h, prop).get;
        nativeSource.set(g, "function get " + prop + "() { [native code] }");
        return g;
      };
      Object.defineProperty(uaData, "brands", { get: makeUaGetter("brands", () => Object.freeze(brands)), enumerable: true, configurable: true });
      Object.defineProperty(uaData, "mobile", { get: makeUaGetter("mobile", () => Boolean(U.mobile)), enumerable: true, configurable: true });
      Object.defineProperty(uaData, "platform", { get: makeUaGetter("platform", () => String(U.chPlatform || "")), enumerable: true, configurable: true });
      const geh = {
        getHighEntropyValues(hints) {
          if (this !== uaData) {
            return Promise.reject(new TypeError("Illegal invocation"));
          }
          const want = Array.isArray(hints) ? hints : [];
          const out = { brands, mobile: Boolean(U.mobile), platform: String(U.chPlatform || "") };
          for (const h of want) {
            if (h in highEntropy) out[h] = highEntropy[h];
            if (h === "uaFullVersion") out.uaFullVersion = highEntropy.fullVersion;
          }
          return Promise.resolve(out);
        }
      }.getHighEntropyValues;
      nativeSource.set(geh, "function getHighEntropyValues() { [native code] }");
      Object.defineProperty(uaData, "getHighEntropyValues", { configurable: true, writable: true, enumerable: true, value: geh });
      const tj = {
        toJSON() {
          if (this !== uaData) {
            throw new TypeError("Illegal invocation");
          }
          return { brands, mobile: Boolean(U.mobile), platform: String(U.chPlatform || "") };
        }
      }.toJSON;
      nativeSource.set(tj, "function toJSON() { [native code] }");
      Object.defineProperty(uaData, "toJSON", { configurable: true, writable: true, enumerable: true, value: tj });
      if (contextExposesClientHints()) {
        const protoTarget = typeof Navigator !== "undefined" ? Navigator.prototype : (typeof WorkerNavigator !== "undefined" ? WorkerNavigator.prototype : null);
        if (protoTarget) define(protoTarget, "userAgentData", () => uaData);
        try { delete navigator.userAgentData; } catch (_) {}
      }
    }
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
