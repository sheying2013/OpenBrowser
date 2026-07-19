'use strict';

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
  { brand: 'Not:A-Brand', version: '99' },
  { brand: 'Not A(Brand', version: '8' },
  { brand: 'Not)A;Brand', version: '24' },
  { brand: 'Not_A Brand', version: '8' },
  { brand: 'Not/A)Brand', version: '8' },
];

const OS_PRESETS = {
  windows: {
    id: 'windows',
    platformNav: 'Win32',
    uaToken: 'Windows NT 10.0; Win64; x64',
    chPlatform: 'Windows',
    chPlatformVersion: '15.0.0',
    architecture: 'x86',
    bitness: '64',
    wow64: false,
    vendor: 'Google Inc.',
  },
  macos: {
    id: 'macos',
    platformNav: 'MacIntel',
    uaToken: 'Macintosh; Intel Mac OS X 10_15_7',
    chPlatform: 'macOS',
    chPlatformVersion: '14.5.0',
    architecture: 'x86',
    bitness: '64',
    wow64: false,
    vendor: 'Google Inc.',
  },
  macos_arm: {
    id: 'macos_arm',
    // Chrome still reports MacIntel for UA/platform in most builds
    platformNav: 'MacIntel',
    uaToken: 'Macintosh; Intel Mac OS X 10_15_7',
    chPlatform: 'macOS',
    chPlatformVersion: '14.5.0',
    architecture: 'arm',
    bitness: '64',
    wow64: false,
    vendor: 'Google Inc.',
  },
  linux: {
    id: 'linux',
    platformNav: 'Linux x86_64',
    uaToken: 'X11; Linux x86_64',
    chPlatform: 'Linux',
    chPlatformVersion: '6.5.0',
    architecture: 'x86',
    bitness: '64',
    wow64: false,
    vendor: 'Google Inc.',
  },
};

function detectHostOs() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'windows';
}

function parseChromeVersion(ua = '') {
  const m = String(ua).match(/Chrome\/([\d.]+)/i);
  if (!m) return null;
  const full = m[1];
  const major = Number(full.split('.')[0]) || 0;
  return { full, major };
}

function parseOsFromUa(ua = '') {
  const s = String(ua);
  if (/Windows NT/i.test(s)) return 'windows';
  if (/Android/i.test(s)) return 'android';
  if (/iPhone|iPad|iPod/i.test(s)) return 'ios';
  if (/Macintosh|Mac OS X/i.test(s)) return 'macos';
  if (/Linux/i.test(s)) return 'linux';
  return detectHostOs();
}

/**
 * Build grease brands list similar to real Chrome sec-ch-ua order.
 * Order rotates with major version (simplified Chromium-compatible).
 */
function buildBrands(major) {
  const m = String(Math.max(1, Number(major) || 120));
  const grease = GREASE_BRANDS[Number(m) % GREASE_BRANDS.length];
  // Real Chrome often: grease, Chromium, Google Chrome — or reverse for some majors
  const chromium = { brand: 'Chromium', version: m };
  const chrome = { brand: 'Google Chrome', version: m };
  if (Number(m) % 2 === 0) return [grease, chromium, chrome];
  return [chrome, chromium, grease];
}

function buildFullVersionList(major, fullVersion) {
  const full = String(fullVersion || `${major}.0.0.0`);
  const brands = buildBrands(major);
  return brands.map((b) => {
    if (b.brand === 'Chromium' || b.brand === 'Google Chrome') {
      return { brand: b.brand, version: full };
    }
    // grease keeps short version
    return { brand: b.brand, version: b.version };
  });
}

function normalizeChromeFull(major, full) {
  const m = Number(major) || 120;
  if (full && /^\d+\.\d+\.\d+\.\d+$/.test(String(full))) return String(full);
  // Realistic-looking reduced full version (Chrome often uses X.0.0.0 in reduced UA)
  return `${m}.0.0.0`;
}

/**
 * Build a complete UA string (desktop Chrome).
 */
function buildUserAgentString(options = {}) {
  const osKey = OS_PRESETS[options.os] ? options.os : (options.os === 'mac' ? 'macos' : detectHostOs());
  const preset = OS_PRESETS[osKey] || OS_PRESETS.windows;
  const major = Number(options.chromeMajor || options.major || 131) || 131;
  const full = normalizeChromeFull(major, options.chromeFull || options.fullVersion);
  // Prefer reduced UA form Chrome ships in many channels: Chrome/MAJOR.0.0.0
  const chromeToken = options.reduced === false ? full : `${major}.0.0.0`;
  return `Mozilla/5.0 (${preset.uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeToken} Safari/537.36`;
}

/**
 * Derive Client Hints / UserAgentMetadata from UA (+ optional overrides).
 * Field names align with CDP userAgentMetadata plus common clientHints aliases.
 */
function buildUserAgentMetadata(ua, overrides = {}) {
  const parsed = parseChromeVersion(ua) || { full: '131.0.0.0', major: 131 };
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
  const platformVersion = overrides.platform_version
    || overrides.platformVersion
    || preset.chPlatformVersion;
  const architecture = overrides.architecture || preset.architecture;
  const model = overrides.model != null ? String(overrides.model) : '';
  const mobile = overrides.mobile === true || overrides.mobile === '1' || overrides.mobile === 1;
  const bitness = overrides.bitness != null ? String(overrides.bitness) : preset.bitness;
  const wow64 = overrides.wow64 === true || overrides.wow64 === '1' || overrides.wow64 === 1
    ? true
    : Boolean(preset.wow64);

  // CDP Emulation/Network.setUserAgentOverride shape
  return {
    brands,
    fullVersionList,
    fullVersion, // legacy field still accepted by some CDP versions
    platform,
    platformVersion,
    architecture,
    model,
    mobile,
    bitness,
    wow64,
    // Common UserAgentMetadata aliases
    uaFullVersion: fullVersion,
    platform_version: platformVersion,
    ua_full_version: fullVersion,
  };
}

/**
 * Full UA profile: string + navigator fields + client hints + chrome flags.
 */
function buildUaProfile(options = {}) {
  let userAgent = String(options.userAgent || options.ua || '').trim();
  const osKey = options.os
    || (userAgent ? parseOsFromUa(userAgent) : detectHostOs());
  const majorHint = Number(options.chromeMajor || options.major) || 0;

  if (!userAgent) {
    userAgent = buildUserAgentString({
      os: osKey,
      chromeMajor: majorHint || 131,
      chromeFull: options.chromeFull || options.fullVersion,
      reduced: options.reduced !== false,
    });
  }

  const parsed = parseChromeVersion(userAgent) || { full: '131.0.0.0', major: 131 };
  const major = majorHint || parsed.major;
  // If UA has reduced X.0.0.0 but caller gave full version, keep reduced in UA
  // and put full into client hints (matches Chrome reduced UA + high-entropy full).
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

  // appVersion is traditionally UA without "Mozilla/"
  const appVersion = userAgent.replace(/^Mozilla\//, '');

  return {
    userAgent,
    appVersion,
    platform: platformNav,
    vendor: options.vendor || preset.vendor || 'Google Inc.',
    chromeMajor: major,
    chromeFull: fullForHints,
    os: osKey,
    metadata,
    // clientHints object (snake_case aliases used by UI / profile config)
    clientHints: {
      platform: metadata.platform,
      platform_version: metadata.platformVersion,
      architecture: metadata.architecture,
      model: metadata.model,
      mobile: metadata.mobile ? '1' : '0',
      wow64: metadata.wow64 ? '1' : '0',
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
  const major = Number(uaProfile?.chromeMajor) || parseChromeVersion(uaProfile?.userAgent || '')?.major || 0;
  if (!major) return args;
  if (major < 106) {
    args.push('--disable-features=PermuteTLSExtensions');
  } else {
    args.push('--enable-features=PermuteTLSExtensions');
  }
  return args;
}

/**
 * CDP payload for Emulation.setUserAgentOverride / Network.setUserAgentOverride.
 */
function cdpUserAgentOverride(uaProfile, acceptLanguage = '') {
  const meta = uaProfile.metadata || buildUserAgentMetadata(uaProfile.userAgent);
  return {
    userAgent: uaProfile.userAgent,
    acceptLanguage: acceptLanguage || undefined,
    platform: uaProfile.platform,
    userAgentMetadata: {
      brands: meta.brands,
      fullVersionList: meta.fullVersionList,
      fullVersion: meta.fullVersion || meta.uaFullVersion,
      platform: meta.platform,
      platformVersion: meta.platformVersion,
      architecture: meta.architecture,
      model: meta.model || '',
      mobile: Boolean(meta.mobile),
      bitness: meta.bitness || '64',
      wow64: Boolean(meta.wow64),
    },
  };
}

/**
 * Document-start patch: navigator.userAgent / appVersion / platform / userAgentData.
 */
function buildUaInjectionScript(uaProfile) {
  const payload = {
    userAgent: uaProfile.userAgent,
    appVersion: uaProfile.appVersion,
    platform: uaProfile.platform,
    vendor: uaProfile.vendor || 'Google Inc.',
    brands: uaProfile.metadata?.brands || [],
    fullVersionList: uaProfile.metadata?.fullVersionList || [],
    fullVersion: uaProfile.metadata?.uaFullVersion || uaProfile.chromeFull,
    chPlatform: uaProfile.metadata?.platform || 'Windows',
    platformVersion: uaProfile.metadata?.platformVersion || '',
    architecture: uaProfile.metadata?.architecture || 'x86',
    model: uaProfile.metadata?.model || '',
    mobile: Boolean(uaProfile.metadata?.mobile),
    bitness: uaProfile.metadata?.bitness || '64',
    wow64: Boolean(uaProfile.metadata?.wow64),
  };
  const json = JSON.stringify(payload);
  return `(() => {
  const U = ${json};
  const nativeSource = new WeakMap();
  const originalToString = Function.prototype.toString;
  const nativeLike = (wrapper, original) => {
    try { Object.defineProperty(wrapper, 'name', { configurable: true, value: original?.name || wrapper.name }); } catch (_) {}
    try { Object.defineProperty(wrapper, 'length', { configurable: true, value: original?.length ?? wrapper.length }); } catch (_) {}
    try { nativeSource.set(wrapper, original ? originalToString.call(original) : 'function () { [native code] }'); } catch (_) {}
    return wrapper;
  };
  try {
    const patchedToString = nativeLike(function toString() {
      if (nativeSource.has(this)) return nativeSource.get(this);
      return originalToString.call(this);
    }, originalToString);
    Object.defineProperty(Function.prototype, 'toString', {
      configurable: true,
      writable: true,
      value: patchedToString,
    });
  } catch (_) {}
  const sameValue = (obj, key, expected) => {
    try { return obj && obj[key] === expected; } catch (_) { return false; }
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
    const nativeGetter = nativeLike(getter, originalGetter);
    try {
      Object.defineProperty(obj, key, { configurable: true, enumerable: true, get: nativeGetter });
      return true;
    } catch (_) {
      try { Object.defineProperty(obj, key, { configurable: true, get: nativeGetter }); return true; } catch (__) { return false; }
    }
  };
  try {
    define(Navigator.prototype, 'userAgent', () => U.userAgent);
    define(Navigator.prototype, 'appVersion', () => U.appVersion);
    define(Navigator.prototype, 'platform', () => U.platform);
    define(Navigator.prototype, 'vendor', () => U.vendor);
    define(Navigator.prototype, 'appCodeName', () => 'Mozilla');
    define(Navigator.prototype, 'appName', () => 'Netscape');
    define(Navigator.prototype, 'product', () => 'Gecko');
    define(Navigator.prototype, 'productSub', () => '20030107');
    define(Navigator.prototype, 'vendorSub', () => '');
  } catch (_) {}

  // userAgentData (Client Hints JS API) — critical; bare UA string is not enough
  try {
    const brands = (U.brands || []).map((b) => ({ brand: String(b.brand), version: String(b.version) }));
    const fullVersionList = (U.fullVersionList || brands).map((b) => ({ brand: String(b.brand), version: String(b.version) }));
    const highEntropy = {
      brands,
      fullVersionList,
      fullVersion: String(U.fullVersion || ''),
      platform: String(U.chPlatform || ''),
      platformVersion: String(U.platformVersion || ''),
      architecture: String(U.architecture || ''),
      model: String(U.model || ''),
      mobile: Boolean(U.mobile),
      bitness: String(U.bitness || '64'),
      wow64: Boolean(U.wow64),
      uaFullVersion: String(U.fullVersion || ''),
    };
    const uaData = {
      brands,
      mobile: Boolean(U.mobile),
      platform: String(U.chPlatform || ''),
      getHighEntropyValues(hints) {
        const want = Array.isArray(hints) ? hints : [];
        const out = { brands, mobile: Boolean(U.mobile), platform: String(U.chPlatform || '') };
        for (const h of want) {
          if (h in highEntropy) out[h] = highEntropy[h];
          if (h === 'uaFullVersion') out.uaFullVersion = highEntropy.fullVersion;
        }
        return Promise.resolve(out);
      },
      toJSON() {
        return { brands, mobile: Boolean(U.mobile), platform: String(U.chPlatform || '') };
      },
    };
    const existing = (() => { try { return navigator.userAgentData; } catch (_) { return null; } })();
    const existingBrands = (() => { try { return JSON.stringify(existing?.brands || []); } catch (_) { return ''; } })();
    if (!existing || existing.platform !== uaData.platform || existing.mobile !== uaData.mobile || existingBrands !== JSON.stringify(brands)) {
      define(Navigator.prototype, 'userAgentData', () => uaData);
      try { define(navigator, 'userAgentData', () => uaData); } catch (_) {}
    }
  } catch (_) {}
})();`;
}

/**
 * Seeded random UA for multi-open isolation (deterministic per profile seed).
 */
function randomUaForSeed(seedU32, options = {}) {
  const osList = options.osList || ['windows', 'windows', 'macos', 'linux'];
  const os = osList[seedU32 % osList.length];
  // Prefer recent stable majors; avoid inventing future majors wildly
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
    architecture: os === 'macos' && (seedU32 & 1) ? 'arm' : undefined,
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
  cdpUserAgentOverride,
  buildUaInjectionScript,
  randomUaForSeed,
};
