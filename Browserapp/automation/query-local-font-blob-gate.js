'use strict';

/**
 * Local Font Access API FontData.blob() isolation gate.
 *
 * Provides real platform font subset WOFF2 payloads for Local Font Access API (queryLocalFonts)
 * FontData.blob() invocations, preventing cross-platform host font byte leakage while guaranteeing
 * authentic, parseable, and loadable OpenType font binaries.
 */

const fs = require('fs');
const path = require('path');
const { OS_FONTS } = require('./device-personas');

// Cache structures for subset index and binary payloads
let fontSubsetIndexCache = null;
const fontAssetBufferCache = new Map();
const fontAssetBase64Cache = new Map();

/**
 * Resolve root directory containing platform font subsets.
 */
function resolveFontSubsetRoot() {
  const candidates = [
    path.resolve(__dirname, '..', 'assets', 'font-subsets'),
    path.resolve(__dirname, '..', '..', 'assets', 'font-subsets'),
    path.resolve(process.cwd(), 'Browserapp', 'assets', 'font-subsets'),
    path.resolve(process.cwd(), 'assets', 'font-subsets'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.json'))) {
      return candidate;
    }
  }
  return candidates[0];
}

/**
 * Normalize platform string to canonical key: 'windows' | 'macos' | 'linux' | 'android'.
 */
function normalizePlatformKey(platformInput) {
  if (typeof platformInput !== 'string') return 'windows';
  const p = platformInput.trim().toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac') || p.includes('darwin')) return 'macos';
  if (p.includes('android')) return 'android';
  if (p.includes('linux')) return 'linux';
  return 'windows';
}

/**
 * Read and cache index.json metadata.
 */
function getFontSubsetIndex() {
  if (fontSubsetIndexCache) return fontSubsetIndexCache;
  const root = resolveFontSubsetRoot();
  const indexPath = path.join(root, 'index.json');
  if (fs.existsSync(indexPath)) {
    try {
      fontSubsetIndexCache = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (_) {
      fontSubsetIndexCache = { platforms: {} };
    }
  } else {
    fontSubsetIndexCache = { platforms: {} };
  }
  return fontSubsetIndexCache;
}

/**
 * Read and cache an individual WOFF2 font asset file.
 * Validates the wOF2 magic header (0x774f4632).
 */
function loadFontAsset(platform, filename) {
  const cacheKey = `${platform}:${filename}`;
  if (fontAssetBase64Cache.has(cacheKey)) {
    return {
      buffer: fontAssetBufferCache.get(cacheKey),
      base64: fontAssetBase64Cache.get(cacheKey),
    };
  }

  const root = resolveFontSubsetRoot();
  const filePath = path.join(root, platform, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 4 || buffer.subarray(0, 4).toString('ascii') !== 'wOF2') {
      return null;
    }
    const base64 = buffer.toString('base64');
    fontAssetBufferCache.set(cacheKey, buffer);
    fontAssetBase64Cache.set(cacheKey, base64);
    return { buffer, base64 };
  } catch (_) {
    return null;
  }
}

/**
 * Classify a font family name into a typography category for alias heuristics.
 */
function classifyFamilyStyle(familyName) {
  const name = String(familyName || '').toLowerCase();
  if (/(mono|console|consolas|courier|typewriter|fixed|terminal|\bcode\b)/i.test(name)) return 'monospace';
  if (/sans[\s_-]?serif/i.test(name)) return 'sans-serif';
  if (/(serif|roman|times|georgia|cambria|caslon|century|bookman|palatino|garamond|minion|baskerville|didot|bodoni|sylfaen)/i.test(name)) return 'serif';
  if (/(script|hand|cursive|brush|calligraph|chalk|duster|ink|pen|marker|flair|kunstler|zapfino)/i.test(name)) return 'script';
  if (/(black|impact|heavy|extra bold|ultra|gothic)/i.test(name)) return 'display';
  if (/(symbol|dingbat|wingding|webding|emoji|icon|math|marlett)/i.test(name)) return 'symbol';
  return 'sans-serif';
}

/**
 * Deterministic hash (DJB2) for dispersion of missing font families.
 */
function deterministicHash(str) {
  let hash = 5381;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Retrieve all available verified assets for a given platform.
 */
function getPlatformAvailableAssets(platform) {
  const index = getFontSubsetIndex();
  const platformData = index.platforms?.[platform] || {};
  const root = resolveFontSubsetRoot();
  const list = [];
  for (const [family, entry] of Object.entries(platformData)) {
    if (!entry || !entry.file) continue;
    const fullPath = path.join(root, platform, entry.file);
    if (fs.existsSync(fullPath)) {
      list.push({
        family,
        file: entry.file,
        bytes: entry.bytes || fs.statSync(fullPath).size,
        category: classifyFamilyStyle(family),
      });
    }
  }
  return list;
}

/**
 * Get default fallback asset file for a given platform.
 */
function getDefaultFallbackAsset(platform, availableAssets) {
  const defaults = {
    windows: 'segoe-ui.woff2',
    macos: 'helvetica.woff2',
    linux: 'liberation-sans.woff2',
    android: 'roboto.woff2',
  };
  const preferred = defaults[platform] || 'arial.woff2';
  if (availableAssets.some((a) => a.file === preferred)) {
    return preferred;
  }
  return availableAssets.length > 0 ? availableAssets[0].file : 'arial.woff2';
}

/**
 * Map a requested font family to an authentic WOFF2 asset.
 * If exact asset exists, returns exact match.
 * If asset is missing, returns deterministic closest real font subset alias.
 */
function resolveFamilyAsset(family, platform, platformData, availableAssets) {
  const cleanFamily = String(family || '').trim();
  const lowerFamily = cleanFamily.toLowerCase();

  // 1. Direct match in index.json
  if (platformData && platformData[cleanFamily] && platformData[cleanFamily].file) {
    const entry = platformData[cleanFamily];
    return {
      family: cleanFamily,
      assetFile: entry.file,
      isAlias: false,
      exact: true,
      category: classifyFamilyStyle(cleanFamily),
      platform,
    };
  }

  // 2. Case-insensitive lookup in index.json
  if (platformData) {
    for (const [key, entry] of Object.entries(platformData)) {
      if (key.toLowerCase() === lowerFamily && entry && entry.file) {
        return {
          family: cleanFamily,
          assetFile: entry.file,
          isAlias: false,
          exact: true,
          category: classifyFamilyStyle(cleanFamily),
          platform,
        };
      }
    }
  }

  // 3. Fallback alias mapping with category heuristic + deterministic hash dispersion
  const category = classifyFamilyStyle(cleanFamily);
  const categoryCandidates = availableAssets.filter((a) => a.category === category);
  const pool = categoryCandidates.length > 0 ? categoryCandidates : availableAssets;

  let chosenAssetFile = null;
  let targetFamily = null;

  if (pool.length > 0) {
    const hashVal = deterministicHash(cleanFamily);
    const chosen = pool[hashVal % pool.length];
    chosenAssetFile = chosen.file;
    targetFamily = chosen.family;
  } else {
    chosenAssetFile = getDefaultFallbackAsset(platform, availableAssets);
    targetFamily = chosenAssetFile.replace(/\.woff2$/, '');
  }

  return {
    family: cleanFamily,
    assetFile: chosenAssetFile,
    isAlias: true,
    exact: false,
    targetFamily,
    category,
    platform,
  };
}

/**
 * Inspect gate payload and coverage metrics for a given configuration.
 */
function inspectGatePayload(options = {}) {
  const targetOs = normalizePlatformKey(
    options.os || options.platform || options.fonts?.os || options.navigator?.platform || 'windows'
  );
  const explicitList = (options && (options.list || options.fonts?.list || (Array.isArray(options.fonts) ? options.fonts : null))) || null;
  const personaFonts = Array.isArray(explicitList) && explicitList.length > 0
    ? explicitList.map((n) => String(n).trim())
    : (OS_FONTS[targetOs] || []);

  const index = getFontSubsetIndex();
  const platformData = index.platforms?.[targetOs] || {};
  const availableAssets = getPlatformAvailableAssets(targetOs);

  const familyMappings = [];
  const referencedAssetFiles = new Set();
  let exactCount = 0;
  let aliasCount = 0;

  for (const fam of personaFonts) {
    const mapping = resolveFamilyAsset(fam, targetOs, platformData, availableAssets);
    familyMappings.push(mapping);
    referencedAssetFiles.add(mapping.assetFile);
    if (mapping.isAlias) {
      aliasCount++;
    } else {
      exactCount++;
    }
  }

  const defaultFallback = getDefaultFallbackAsset(targetOs, availableAssets);
  referencedAssetFiles.add(defaultFallback);

  let totalWoff2Bytes = 0;
  let totalBase64Chars = 0;
  const assetFileDetails = [];

  for (const file of referencedAssetFiles) {
    const asset = loadFontAsset(targetOs, file);
    if (asset) {
      totalWoff2Bytes += asset.buffer.length;
      totalBase64Chars += asset.base64.length;
      assetFileDetails.push({
        file,
        bytes: asset.buffer.length,
        base64Chars: asset.base64.length,
      });
    }
  }

  const coveragePercent = personaFonts.length > 0
    ? (exactCount / personaFonts.length) * 100
    : 0;

  return {
    platform: targetOs,
    totalFamilies: personaFonts.length,
    exactMatchCount: exactCount,
    aliasCount: aliasCount,
    coveragePercentage: Number(coveragePercent.toFixed(2)),
    uniqueAssetCount: referencedAssetFiles.size,
    totalWoff2Bytes,
    totalBase64Chars,
    familyMappings,
    assetFiles: assetFileDetails,
    missingAssetFamilies: familyMappings.filter((m) => m.isAlias),
  };
}

/**
 * Build document-start injection script delivering authentic WOFF2 font subset Blobs.
 */
function buildQueryLocalFontBlobGateSource(options = {}) {
  const targetOs = normalizePlatformKey(
    options.os || options.platform || options.fonts?.os || options.navigator?.platform || 'windows'
  );
  const explicitList = (options && (options.list || options.fonts?.list || (Array.isArray(options.fonts) ? options.fonts : null))) || null;
  const personaFonts = Array.isArray(explicitList) && explicitList.length > 0
    ? explicitList.map((n) => String(n).trim())
    : (OS_FONTS[targetOs] || []);

  const index = getFontSubsetIndex();
  const platformData = index.platforms?.[targetOs] || {};
  const availableAssets = getPlatformAvailableAssets(targetOs);

  const familyToAssetMap = {};
  const neededAssetFiles = new Set();

  for (const fam of personaFonts) {
    const mapping = resolveFamilyAsset(fam, targetOs, platformData, availableAssets);
    familyToAssetMap[fam] = mapping.assetFile;
    neededAssetFiles.add(mapping.assetFile);
  }

  const defaultFallback = getDefaultFallbackAsset(targetOs, availableAssets);
  neededAssetFiles.add(defaultFallback);

  const assetPayload = {};
  for (const file of neededAssetFiles) {
    const loaded = loadFontAsset(targetOs, file);
    if (loaded) {
      assetPayload[file] = loaded.base64;
    }
  }

  const blobType = options.blobType || options.mimeType || 'font/woff2';

  return `(() => {
  'use strict';
  try {
    const globalObj = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this);
    if (!globalObj || globalObj.__queryLocalFontBlobGate) {
      return;
    }
    try {
      Object.defineProperty(globalObj, '__queryLocalFontBlobGate', {
        value: true,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    } catch (_) {
      globalObj.__queryLocalFontBlobGate = true;
    }

    const personaFonts = ${JSON.stringify(personaFonts)};
    const targetOs = ${JSON.stringify(targetOs)};
    const assetPayload = ${JSON.stringify(assetPayload)};
    const familyToAsset = ${JSON.stringify(familyToAssetMap)};
    const defaultAsset = ${JSON.stringify(defaultFallback)};
    const blobType = ${JSON.stringify(blobType)};

    const nativeSource = new WeakMap();
    const originalToString = Function.prototype.toString;
    const nativeLike = (wrapper, original, nameOverride, lengthOverride, isConstructor = false) => {
      if (typeof wrapper !== 'function') return wrapper;
      const fnName = nameOverride !== undefined ? nameOverride : (original ? original.name : (wrapper.name || ''));
      const fnLength = lengthOverride !== undefined ? lengthOverride : (original ? original.length : wrapper.length);
      let clean;
      if (isConstructor) {
        clean = wrapper;
        try { Object.defineProperty(clean, 'name', { configurable: true, value: fnName }); } catch (_) {}
        try { Object.defineProperty(clean, 'length', { configurable: true, value: fnLength }); } catch (_) {}
      } else {
        const holder = {
          [fnName](...args) {
            return wrapper.apply(this, args);
          }
        };
        clean = holder[fnName];
        try { Object.defineProperty(clean, 'length', { configurable: true, value: fnLength }); } catch (_) {}
      }
      let nativeStr;
      if (typeof original === 'function') {
        const origStr = nativeSource.get(original) || originalToString.call(original);
        nativeStr = (origStr && origStr.includes('[native code]') && (!nameOverride || origStr.includes(nameOverride)))
          ? origStr
          : ('function ' + fnName + '() { [native code] }');
      } else {
        nativeStr = 'function ' + fnName + '() { [native code] }';
      }
      try { nativeSource.set(clean, nativeStr); } catch (_) {}
      try { nativeSource.set(wrapper, nativeStr); } catch (_) {}
      return clean;
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
        nativeSource.set(patchedToString, 'function toString() { [native code] }');
        Object.defineProperty(Function.prototype, 'toString', {
          configurable: true,
          writable: true,
          value: patchedToString,
        });
      }
    } catch (_) {}

    function postscriptNameOf(family) {
      return String(family || '').replace(/\\s+/g, '');
    }

    const blobCache = new Map();
    function base64ToUint8Array(base64) {
      const bin = atob(base64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return bytes;
    }

    function getRealFontBlob(family) {
      const famKey = String(family || '').trim();
      if (blobCache.has(famKey)) {
        return blobCache.get(famKey);
      }

      let assetFile = familyToAsset[famKey];
      if (!assetFile || !assetPayload[assetFile]) {
        const lower = famKey.toLowerCase();
        for (const [k, v] of Object.entries(familyToAsset)) {
          if (k.toLowerCase() === lower && assetPayload[v]) {
            assetFile = v;
            break;
          }
        }
      }
      if (!assetFile || !assetPayload[assetFile]) {
        assetFile = defaultAsset;
      }

      const base64 = assetPayload[assetFile];
      if (!base64) {
        throw new Error('Font asset not available for ' + famKey);
      }

      const bytes = base64ToUint8Array(base64);
      const blob = new Blob([bytes], { type: blobType });
      blobCache.set(famKey, blob);
      return blob;
    }

    const fakeBlobMap = new WeakMap();

    // Hook FontData.prototype.blob to maintain prototype invocation parity
    let origProtoBlob = null;
    if (typeof globalObj.FontData !== 'undefined' && globalObj.FontData.prototype) {
      origProtoBlob = globalObj.FontData.prototype.blob;
      const patchedProtoBlob = nativeLike(function blob() {
        if (fakeBlobMap.has(this)) {
          return fakeBlobMap.get(this)();
        }
        if (origProtoBlob) {
          return origProtoBlob.apply(this, arguments);
        }
        throw new TypeError("Failed to execute 'blob' on 'FontData': Illegal invocation");
      }, origProtoBlob, 'blob', 0);

      Object.defineProperty(globalObj.FontData.prototype, 'blob', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: patchedProtoBlob,
      });
    }

    // Intercept queryLocalFonts
    if (typeof globalObj.queryLocalFonts === 'function') {
      const origQueryLocalFonts = globalObj.queryLocalFonts;

      const patchedQuery = nativeLike(async function queryLocalFonts(options) {
        const answered = await origQueryLocalFonts.apply(this || globalObj, arguments);
        if (!answered || !Array.isArray(answered)) return answered;

        const wanted = options && Array.isArray(options.postscriptNames)
          ? new Set(options.postscriptNames.map((name) => String(name)))
          : null;

        const wrapEntry = (entry, family) => {
          const actualFamily = family || entry.family || 'Arial';
          const syntheticBlobFn = nativeLike(function blob() {
            return Promise.resolve(getRealFontBlob(actualFamily));
          }, origProtoBlob || entry.blob, 'blob', 0);

          const proxy = new Proxy(entry, {
            get(target, prop, receiver) {
              if (prop === 'blob') return syntheticBlobFn;
              return Reflect.get(target, prop, receiver);
            }
          });

          const resolver = () => Promise.resolve(getRealFontBlob(actualFamily));
          fakeBlobMap.set(proxy, resolver);
          fakeBlobMap.set(entry, resolver);
          return proxy;
        };

        let listToProcess = answered;
        if (personaFonts && personaFonts.length) {
          const isAlreadyPersona = (answered.length === personaFonts.length) &&
            answered.every((entry, i) => entry && entry.family === personaFonts[i]);
          if (!isAlreadyPersona) {
            const fontDataProto = (typeof globalObj.FontData !== 'undefined' && globalObj.FontData.prototype)
              ? globalObj.FontData.prototype
              : Object.prototype;

            listToProcess = personaFonts.map((fam) => {
              const ps = postscriptNameOf(fam);
              const baseTarget = (answered && answered.length) ? answered[0] : Object.create(fontDataProto);
              return new Proxy(baseTarget, {
                get(target, prop, receiver) {
                  if (prop === 'family' || prop === 'fullName') return fam;
                  if (prop === 'postscriptName') return ps;
                  if (prop === 'style') return 'Regular';
                  if (prop === Symbol.toStringTag) return 'FontData';
                  return Reflect.get(target, prop, receiver);
                },
                has(target, prop) {
                  if (prop === 'family' || prop === 'fullName' || prop === 'postscriptName' || prop === 'style') return true;
                  return Reflect.has(target, prop);
                }
              });
            });
          }
        }

        const filtered = listToProcess.filter((entry) => {
          const ps = entry.postscriptName || postscriptNameOf(entry.family || '');
          return !wanted || wanted.has(ps);
        });

        return filtered.map((entry) => wrapEntry(entry, entry.family));
      }, origQueryLocalFonts, 'queryLocalFonts', 0);

      Object.defineProperty(globalObj, 'queryLocalFonts', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: patchedQuery,
      });
    }
  } catch (_) {}
})();`;
}

/**
 * Clear memory caches.
 */
function clearFontSubsetCaches() {
  fontSubsetIndexCache = null;
  fontAssetBufferCache.clear();
  fontAssetBase64Cache.clear();
}

module.exports = {
  buildQueryLocalFontBlobGateSource,
  inspectGatePayload,
  clearFontSubsetCaches,
};
