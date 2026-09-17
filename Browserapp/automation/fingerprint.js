'use strict';

/**
 * Deterministic fingerprint profile for multi-open isolation.
 *
 * Stock Chromium path (no custom kernel):
 *  - isolated user-data-dir
 *  - CDP Emulation (timezone / geo / UA-CH / locale / device metrics)
 *  - document-start JS injection for navigator, canvas/webgl/audio/clientRects noise,
 *    mediaDevices, speech voices, WebRTC policy, WebGPU adapter info
 *
 * Config is split into:
 *  - staticConfig: stable noise identity (marks, cores, platform, devices, webgl payload)
 *  - dynamicConfig: exit-IP layer (timezone, geoposition, webrtc address/mode)
 *
 * Kernel-only surfaces (MAC, device name, file-protocol static/dynamic consumers,
 * full TLS/JA3 gateway) are out of scope for this module.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { mergeFlags, LIST_VALUE_FLAGS } = require('./command-line-flags');
const { pickPersona, fontsForOs, exclusiveFontsForOtherOs, HOST_WEBGL_LIMITS, getHostWebglLimits, isPersonaWebglCompatible, compatiblePersonasForOs, resolveCompatiblePersona } = require('./device-personas');
const { mobilePersona, supportsRuntimePersona } = require('./mobile-personas');
const { buildCssFontLocalGateSource } = require('./css-font-local-gate');
const { deriveFontPlaceholder, deriveBridgeToken } = require('./font-placeholder');
const { buildQueryLocalFontBlobGateSource } = require('./query-local-font-blob-gate');
const {
  buildUaProfile,
  randomUaForSeed,
  chromeArgsForUa,
  cdpUserAgentOverride,
  buildAcceptLanguageHeader,
  formatAcceptLanguage,
  buildUaInjectionScript,
  parseOsFromUa,
  OS_PRESETS,
} = require('./user-agent');

const FONT_SUBSET_ROOT = path.join(__dirname, '..', 'assets', 'font-subsets');

let fontSubsetIndexCache = null;
const fontSubsetPayloadCache = new Map();

/**
 * Map platform string (e.g. Win32, MacIntel, Linux x86_64, Android)
 * to standard font subset platform key (windows | macos | linux | android).
 * Returns null if unrecognized or unsupported.
 */
function mapPlatformToSubsetKey(platform) {
  if (typeof platform !== 'string') return null;
  const p = platform.trim();
  if (!p) return null;
  if (/^win/i.test(p)) return 'windows';
  if (/^mac/i.test(p) || /darwin/i.test(p) || /iphone|ipad|ipod|ios/i.test(p)) return 'macos';
  if (/android/i.test(p)) return 'android';
  if (/^linux/i.test(p)) {
    if (/arm|aarch/i.test(p)) return 'android';
    return 'linux';
  }
  return null;
}

/**
 * Load and cache platform font subset definitions and base64 payloads.
 * Only reads index.json on first invocation and lazily reads font files per platform.
 */
function loadFontSubsetPayload(platformKey) {
  const normalizedKey = mapPlatformToSubsetKey(platformKey) || (['windows', 'macos', 'linux', 'android'].includes(platformKey) ? platformKey : null);
  if (!normalizedKey) return [];
  if (fontSubsetPayloadCache.has(normalizedKey)) {
    return fontSubsetPayloadCache.get(normalizedKey);
  }

  if (!fontSubsetIndexCache) {
    const indexPath = path.join(FONT_SUBSET_ROOT, 'index.json');
    if (!fs.existsSync(indexPath)) {
      return [];
    }
    try {
      fontSubsetIndexCache = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (_) {
      return [];
    }
  }

  const platformData = fontSubsetIndexCache?.platforms?.[normalizedKey];
  if (!platformData || typeof platformData !== 'object') {
    return [];
  }

  const payload = [];
  for (const [family, entry] of Object.entries(platformData)) {
    if (!entry || !entry.file) continue;
    const fontFilePath = path.join(FONT_SUBSET_ROOT, normalizedKey, entry.file);
    if (!fs.existsSync(fontFilePath)) continue;
    try {
      const buf = fs.readFileSync(fontFilePath);
      payload.push({
        family,
        format: entry.file.endsWith('.woff2') ? 'font/woff2' : 'font/ttf',
        base64: buf.toString('base64'),
      });
    } catch (_) {}
  }

  fontSubsetPayloadCache.set(normalizedKey, payload);
  return payload;
}

/**
 * Generate document-start IIFE to inject authentic platform font subsets
 * into document.fonts via FontFace, with filtered proxy masking on Document.prototype.fonts.
 */
function buildFontMetricsScript(platformKey, options = {}) {
  const bridgeToken = String(options.bridgeToken || deriveBridgeToken({ platformKey, options }));
  if (options && options.disabled) {
    return '';
  }

  const resolvedPlatform = mapPlatformToSubsetKey(platformKey) || (['windows', 'macos', 'linux', 'android'].includes(platformKey) ? platformKey : null);
  if (!resolvedPlatform) {
    return '';
  }

  const payload = loadFontSubsetPayload(resolvedPlatform);
  if (!payload || !payload.length) {
    return '';
  }

  return `(() => {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const BRIDGE_TOKEN = ${JSON.stringify(bridgeToken)};
    const inspectBridge = (fn) => {
      try {
        const result = Function.prototype.toString.call(fn, BRIDGE_TOKEN);
        return result && typeof result === 'object' && result.bridge === true ? result : null;
      } catch (_) { return null; }
    };
    const origFontsDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'fonts');
    if (!origFontsDesc || typeof origFontsDesc.get !== 'function') return;
    // The feature's own getter is the idempotence probe. It keeps bookkeeping in closures
    // and adds no window/globalThis/Symbol property that a page can enumerate.
    if (inspectBridge(origFontsDesc.get)) return;
    if (typeof FontFace !== 'function' || !document || !document.fonts) return;

    const fontData = ${JSON.stringify(payload)};
    if (!fontData || !fontData.length) return;

    const internalFaces = new WeakSet();
    const personaFamilySet = new Set(fontData.map((item) => String(item.family || '').trim().toLowerCase()).filter(Boolean));
    const shieldedFontsMap = new WeakMap();
    const boundMethodCache = new Map();
    const nativeMap = new WeakMap();
    const origToString = Function.prototype.toString;

    if (origFontsDesc && typeof origFontsDesc.get === 'function') {
      const origFontsGet = origFontsDesc.get;

      const createShieldedProxy = (realFonts) => {
        const wrapIterator = (rawIterator, isEntries) => {
          let cachedNext = null;
          let cachedIter = null;
          return new Proxy(rawIterator, {
            get(iterTarget, iterProp, iterReceiver) {
              if (iterProp === 'next') {
                if (!cachedNext) {
                  cachedNext = function next() {
                    while (true) {
                      const res = iterTarget.next();
                      if (res.done) return res;
                      const face = isEntries ? res.value[0] : res.value;
                      if (internalFaces.has(face)) continue;
                      return res;
                    }
                  };
                  try { Object.defineProperty(cachedNext, 'name', { value: 'next', configurable: true }); } catch (_) {}
                  try { Object.defineProperty(cachedNext, 'length', { value: 0, configurable: true }); } catch (_) {}
                  nativeMap.set(cachedNext, 'function next() { [native code] }');
                }
                return cachedNext;
              }
              if (iterProp === Symbol.iterator) {
                if (!cachedIter) {
                  cachedIter = function () { return iterReceiver; };
                  try { Object.defineProperty(cachedIter, 'name', { value: '[Symbol.iterator]', configurable: true }); } catch (_) {}
                  try { Object.defineProperty(cachedIter, 'length', { value: 0, configurable: true }); } catch (_) {}
                  nativeMap.set(cachedIter, 'function [Symbol.iterator]() { [native code] }');
                }
                return cachedIter;
              }
              if (iterProp === 'constructor') {
                return iterTarget.constructor;
              }
              const val = Reflect.get(iterTarget, iterProp, iterReceiver);
              return typeof val === 'function' ? val.bind(iterTarget) : val;
            }
          });
        };

        const getOrCreateMethod = (name, factory, length = 0) => {
          let fn = boundMethodCache.get(name);
          if (!fn) {
            fn = factory();
            try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (_) {}
            try { Object.defineProperty(fn, 'length', { value: length, configurable: true }); } catch (_) {}
            nativeMap.set(fn, 'function ' + name + '() { [native code] }');
            boundMethodCache.set(name, fn);
          }
          return fn;
        };

        return new Proxy(realFonts, {
          getOwnPropertyDescriptor(target, prop) {
            return Reflect.getOwnPropertyDescriptor(target, prop);
          },
          has(target, prop) {
            return Reflect.has(target, prop);
          },
          get(target, prop, receiver) {
            if (prop === 'size') {
              let count = 0;
              for (const face of target) {
                if (!internalFaces.has(face)) count++;
              }
              return count;
            }
            if (prop === 'has') {
              return getOrCreateMethod('has', () => function has(face) {
                if (internalFaces.has(face)) return false;
                return target.has(face);
              }, 1);
            }
            if (prop === 'entries') {
              return getOrCreateMethod('entries', () => function entries() {
                return wrapIterator(target.entries(), true);
              }, 0);
            }
            if (prop === 'keys') {
              return getOrCreateMethod('keys', () => function keys() {
                return wrapIterator(target.keys(), false);
              }, 0);
            }
            if (prop === 'values' || prop === Symbol.iterator) {
              return getOrCreateMethod('values', () => function values() {
                return wrapIterator(target.values(), false);
              }, 0);
            }
            if (prop === 'forEach') {
              return getOrCreateMethod('forEach', () => function forEach(callback, thisArg) {
                for (const face of target) {
                  if (!internalFaces.has(face)) {
                    callback.call(thisArg, face, face, receiver);
                  }
                }
              }, 1);
            }
            if (prop === 'check') {
              let bound = boundMethodCache.get('check');
              if (!bound) {
                const targetCheck = target.check;
                bound = function check(font, text) {
                  try {
                    const css = String(font || '');
                    const match = css.match(/(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][A-Za-z0-9 _-]*))\s*$/);
                    const family = match ? String(match[1] || match[2] || match[3] || '').trim().toLowerCase() : '';
                    const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace']);
                    if (family && !generic.has(family) && !personaFamilySet.has(family)) {
                      let authorFace = false;
                      for (const face of target) {
                        if (internalFaces.has(face)) continue;
                        if (String(face.family || '').trim().toLowerCase() === family) { authorFace = true; break; }
                      }
                      if (!authorFace) return false;
                    }
                  } catch (_) {}
                  return targetCheck.apply(target, arguments);
                };
                try { Object.defineProperty(bound, 'name', { value: 'check', configurable: true }); } catch (_) {}
                try { Object.defineProperty(bound, 'length', { value: targetCheck ? targetCheck.length : 1, configurable: true }); } catch (_) {}
                nativeMap.set(bound, 'function check() { [native code] }');
                boundMethodCache.set('check', bound);
              }
              return bound;
            }
            if (prop === 'load') {
              let bound = boundMethodCache.get('load');
              if (!bound) {
                const targetLoad = target.load;
                bound = function load(font, text) {
                  let pending;
                  try { pending = targetLoad.apply(target, arguments); } catch (error) { return Promise.reject(error); }
                  return Promise.resolve(pending).then((faces) => {
                    if (!Array.isArray(faces)) return faces;
                    return faces.filter((face) => !internalFaces.has(face));
                  });
                };
                try { Object.defineProperty(bound, 'name', { value: 'load', configurable: true }); } catch (_) {}
                try { Object.defineProperty(bound, 'length', { value: targetLoad ? targetLoad.length : 1, configurable: true }); } catch (_) {}
                nativeMap.set(bound, 'function load() { [native code] }');
                boundMethodCache.set('load', bound);
              }
              return bound;
            }
            if (prop === 'delete') {
              let bound = boundMethodCache.get('delete');
              if (!bound) {
                const targetDelete = target.delete;
                bound = function delete_(face) {
                  if (internalFaces.has(face)) return false;
                  return targetDelete.call(target, face);
                };
                try { Object.defineProperty(bound, 'name', { value: 'delete', configurable: true }); } catch (_) {}
                try { Object.defineProperty(bound, 'length', { value: targetDelete ? targetDelete.length : 1, configurable: true }); } catch (_) {}
                nativeMap.set(bound, 'function delete() { [native code] }');
                boundMethodCache.set('delete', bound);
              }
              return bound;
            }
            if (prop === 'clear') {
              let bound = boundMethodCache.get('clear');
              if (!bound) {
                const targetClear = target.clear;
                bound = function clear() {
                  for (const face of Array.from(target)) {
                    if (!internalFaces.has(face)) target.delete(face);
                  }
                };
                try { Object.defineProperty(bound, 'name', { value: 'clear', configurable: true }); } catch (_) {}
                try { Object.defineProperty(bound, 'length', { value: targetClear ? targetClear.length : 0, configurable: true }); } catch (_) {}
                nativeMap.set(bound, 'function clear() { [native code] }');
                boundMethodCache.set('clear', bound);
              }
              return bound;
            }
            const val = Reflect.get(target, prop, target);
            if (typeof val === 'function') {
              let bound = boundMethodCache.get(val);
              if (!bound) {
                bound = val.bind(target);
                try { Object.defineProperty(bound, 'name', { value: val.name, configurable: true }); } catch (_) {}
                try { Object.defineProperty(bound, 'length', { value: val.length, configurable: true }); } catch (_) {}
                nativeMap.set(bound, 'function ' + val.name + '() { [native code] }');
                boundMethodCache.set(val, bound);
              }
              return bound;
            }
            return val;
          }
        });
      };

      const patchedFontsGet = function getFonts() {
        const isDoc = this === document || (typeof Document !== 'undefined' && this instanceof Document) ||
          Object.prototype.toString.call(this) === '[object HTMLDocument]' ||
          Object.prototype.toString.call(this) === '[object Document]';
        if (!isDoc) {
          throw new TypeError('Illegal invocation');
        }
        const realFonts = origFontsGet.call(this);
        let shielded = shieldedFontsMap.get(this);
        if (!shielded) {
          shielded = createShieldedProxy(realFonts);
          shieldedFontsMap.set(this, shielded);
        }
        return shielded;
      };

      try {
        Object.defineProperty(patchedFontsGet, 'name', { configurable: true, value: 'get fonts' });
      } catch (_) {}
      try {
        Object.defineProperty(patchedFontsGet, 'length', { configurable: true, value: 0 });
      } catch (_) {}
      nativeMap.set(patchedFontsGet, 'function get fonts() { [native code] }');

      const customToString = function toString(...args) {
        const secret = args[0];
        if (secret === BRIDGE_TOKEN) {
          if (nativeMap.has(this)) return { bridge: true, nativeText: nativeMap.get(this) };
          try {
            const inherited = origToString.call(this, secret);
            if (inherited && typeof inherited === 'object' && inherited.bridge === true) return inherited;
          } catch (_) {}
        }
        if (nativeMap.has(this)) return nativeMap.get(this);
        return origToString.call(this, ...args);
      };
      nativeMap.set(customToString, 'function toString() { [native code] }');
      try {
        Object.defineProperty(Function.prototype, 'toString', {
          configurable: true,
          writable: true,
          value: customToString,
        });
      } catch (_) {}

      Object.defineProperty(Document.prototype, 'fonts', {
        configurable: true,
        enumerable: origFontsDesc.enumerable,
        get: patchedFontsGet,
        set: undefined,
      });
    }

    for (let i = 0; i < fontData.length; i++) {
      try {
        const item = fontData[i];
        const face = new FontFace(item.family, 'url("data:' + item.format + ';base64,' + item.base64 + '")');
        internalFaces.add(face);
        document.fonts.add(face);
        face.load().catch(() => {});
      } catch (_) {}
    }
  } catch (_) {}
})();`;
}

function hashSeed(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest();
}

function u32(buf, offset = 0) {
  return buf.readUInt32BE(offset % (buf.length - 3));
}

function mulberry32(a) {
  return function next() {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// WebGL vendor/renderer presets + optional GPUAdapterInfo
const WEBGL_PRESETS = {
  windows: [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'turing' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'turing' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'alchemist' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen12' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen12' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen9' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-3' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-2' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-2' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'gcn-4' } },
    // Expanded modern GPU presets (appended so legacy profiles maintain bit-exact stability)
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ada' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'ampere' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'nvidia', architecture: 'turing' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A750 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'alchemist' } },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'intel', architecture: 'gen9' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-3' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-2' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon 780M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-3' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon 680M Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', gpu: { vendor: 'amd', architecture: 'rdna-2' } },
  ],
  // Chrome switched macOS to the ANGLE Metal backend in 111, so a current build always reports
  // "ANGLE (..., ANGLE Metal Renderer: <gpu>, Unspecified Version)" - verified against a real
  // Chrome 152 on macOS here. The former "OpenGL 4.1" strings are what pre-111 builds emitted
  // and cannot come from a browser this UA claims to be. Each preset keeps the GPU it named.
  //
  // The pool is split by CPU architecture: an x86 Chrome build (Intel Mac) can never report an
  // Apple M-series GPU and an arm64 build never reports Intel/AMD - that cross-check is exactly
  // what detectors run (W2: INTEL_MAC_WITH_APPLE_SILICON_GPU).
  macos_intel: [
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 640, Unspecified Version)', gpu: { vendor: 'intel', architecture: 'gen9' } },
    // MacBook Pro 16" (2019) dGPU - RDNA1.
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)', gpu: { vendor: 'amd', architecture: 'rdna-1' } },
    // iMac Pro (2017) - Vega.
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro Vega 56, Unspecified Version)', gpu: { vendor: 'amd', architecture: 'vega' } },
  ],
  macos_apple: [
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', gpu: { vendor: 'apple', architecture: 'common-3' } },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', gpu: { vendor: 'apple', architecture: 'common-3' } },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', gpu: { vendor: 'apple', architecture: 'common-3' } },
  ],
  // Legacy merged view kept for external consumers; webglPresetsForOs resolves by architecture.
  get macos() { return [...this.macos_intel, ...this.macos_apple]; },
  linux: [
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)', gpu: { vendor: 'intel', architecture: 'gen9' } },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Series (RADV POLARIS10), OpenGL 4.6)', gpu: { vendor: 'amd', architecture: 'gcn-4' } },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER/PCIe/SSE2, OpenGL 4.6)', gpu: { vendor: 'nvidia', architecture: 'turing' } },
  ],
  android: [
    { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)', gpu: { vendor: 'qualcomm', architecture: 'adreno-700' } },
    { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)', gpu: { vendor: 'qualcomm', architecture: 'adreno-700' } },
    { vendor: 'Google Inc. (ARM)', renderer: 'ANGLE (ARM, Mali-G715-Immortalis MC11, OpenGL ES 3.2)', gpu: { vendor: 'arm', architecture: 'valhall' } },
    { vendor: 'Google Inc. (ARM)', renderer: 'ANGLE (ARM, Mali-G710, OpenGL ES 3.2)', gpu: { vendor: 'arm', architecture: 'valhall' } },
    { vendor: 'Google Inc. (Samsung Electronics)', renderer: 'ANGLE (Samsung Electronics, Samsung Xclipse 920, OpenGL ES 3.2)', gpu: { vendor: 'samsung', architecture: 'rdna-2' } },
  ],
  ios: [
    { vendor: 'Apple Inc.', renderer: 'Apple GPU', gpu: { vendor: 'apple', architecture: 'common-3' } },
  ],
};

const MEDIA_DEVICE_POOLS_BY_OS = Object.freeze({
  windows: Object.freeze([
    { input: 'Microphone Array (2- Realtek High Definition Audio)', output: 'Speaker/Headphone (2- Realtek High Definition Audio)', video: 'Integrated Camera' },
    { input: 'Microphone Array (Realtek High Definition Audio)', output: 'Speaker/Headphone (Realtek High Definition Audio)', video: 'Integrated Camera' },
    { input: 'Microphone Array (Realtek(R) Audio)', output: 'Speaker (Realtek(R) Audio)', video: 'Integrated Camera' },
    { input: 'Microphone Array (Conexant SmartAudio HD)', output: 'Speaker (Conexant SmartAudio HD)', video: 'Integrated Camera' },
    { input: 'Microphone Array (2- Conexant SmartAudio HD)', output: 'Speaker (2- Conexant SmartAudio HD)', video: 'Integrated Camera' },
    { input: 'Microphone Array (Synaptics Audio)', output: 'Speaker (Synaptics Audio)', video: 'Integrated Camera' },
  ]),
  macos: Object.freeze([
    { input: 'Built-in Microphone', output: 'MacBook Pro Speakers', video: 'FaceTime HD Camera' },
    { input: 'Built-in Microphone', output: 'MacBook Air Speakers', video: 'FaceTime HD Camera' },
    { input: 'Built-in Microphone', output: 'Internal Speakers', video: 'FaceTime HD Camera' },
    { input: 'MacBook Pro Microphone', output: 'MacBook Pro Speakers', video: 'FaceTime HD Camera (Built-in)' },
    { input: 'Mac mini Microphone', output: 'Mac mini Speakers', video: 'FaceTime HD Camera' },
  ]),
  android: Object.freeze([
    { input: 'Built-in Audio', output: 'Built-in Speaker', video: 'Back Camera' },
    { input: 'Built-in Microphone', output: 'Speaker', video: 'Front Camera' },
    { input: 'Phone Microphone', output: 'Phone Speaker', video: 'Back Camera' },
    { input: 'Internal Audio Input', output: 'Internal Audio Output', video: 'Rear Camera' },
  ]),
  linux: Object.freeze([
    { input: 'Built-in Audio Analog Stereo', output: 'Built-in Audio Analog Stereo', video: 'Integrated Camera' },
    { input: 'PulseAudio Internal Microphone', output: 'PulseAudio Internal Speaker', video: 'USB 2.0 Camera' },
  ]),
});

const MEDIA_DEVICE_TEMPLATES = MEDIA_DEVICE_POOLS_BY_OS.windows;

const WINDOWS_SPEECH_VOICES = [
  { name: "Microsoft David - English (United States)", lang: "en-US" },
  { name: "Microsoft Zira - English (United States)", lang: "en-US" },
  { name: "Microsoft Mark - English (United States)", lang: "en-US" },
  { name: "Microsoft George - English (United Kingdom)", lang: "en-GB" },
  { name: "Microsoft Susan - English (United Kingdom)", lang: "en-GB" },
  { name: "Microsoft Catherine - English (Australia)", lang: "en-AU" },
  { name: "Microsoft James - English (Australia)", lang: "en-AU" },
  { name: "Microsoft Linda - English (Canada)", lang: "en-CA" },
  { name: "Microsoft Richard - English (Canada)", lang: "en-CA" },
  { name: "Microsoft Sean - English (Ireland)", lang: "en-IE" },
  { name: "Microsoft Heera - English (India)", lang: "en-IN" },
  { name: "Microsoft Ravi - English (India)", lang: "en-IN" },
  { name: "Microsoft Huihui - Chinese (Simplified, PRC)", lang: "zh-CN" },
  { name: "Microsoft Yaoyao - Chinese (Simplified, PRC)", lang: "zh-CN" },
  { name: "Microsoft Kangkang - Chinese (Simplified, PRC)", lang: "zh-CN" },
  { name: "Microsoft Hanhan - Chinese (Traditional, Taiwan)", lang: "zh-TW" },
  { name: "Microsoft Tracy - Chinese (Traditional, Hong Kong S.A.R.)", lang: "zh-HK" },
  { name: "Microsoft Haruka - Japanese", lang: "ja-JP" },
  { name: "Microsoft Ichiro - Japanese", lang: "ja-JP" },
  { name: "Microsoft Heami - Korean", lang: "ko-KR" },
  { name: "Microsoft Hortense - French", lang: "fr-FR" },
  { name: "Microsoft Paul - French", lang: "fr-FR" },
  { name: "Microsoft Julie - French (Canada)", lang: "fr-CA" },
  { name: "Microsoft Hedda - German", lang: "de-DE" },
  { name: "Microsoft Stefan - German", lang: "de-DE" },
  { name: "Microsoft Helena - Spanish", lang: "es-ES" },
  { name: "Microsoft Laura - Spanish", lang: "es-ES" },
  { name: "Microsoft Sabina - Spanish (Mexico)", lang: "es-MX" },
  { name: "Microsoft Raul - Spanish (Mexico)", lang: "es-MX" },
  { name: "Microsoft Cosimo - Italian", lang: "it-IT" },
  { name: "Microsoft Elsa - Italian", lang: "it-IT" },
  { name: "Microsoft Maria - Portuguese (Brazil)", lang: "pt-BR" },
  { name: "Microsoft Daniel - Portuguese (Brazil)", lang: "pt-BR" },
  { name: "Microsoft Helia - Portuguese (Portugal)", lang: "pt-PT" },
  { name: "Microsoft Irina - Russian", lang: "ru-RU" },
  { name: "Microsoft Pavel - Russian", lang: "ru-RU" },
  { name: "Microsoft Frank - Dutch", lang: "nl-NL" },
  { name: "Microsoft Paulina - Polish", lang: "pl-PL" },
  { name: "Microsoft Bengt - Swedish", lang: "sv-SE" },
  { name: "Microsoft Heidi - Finnish", lang: "fi-FI" },
  { name: "Microsoft Jon - Norwegian", lang: "nb-NO" },
  { name: "Microsoft Tolga - Turkish", lang: "tr-TR" },
  { name: "Microsoft Kalpana - Hindi", lang: "hi-IN" },
  { name: "Microsoft Pattara - Thai", lang: "th-TH" },
  { name: "Microsoft Andika - Indonesian", lang: "id-ID" },
  { name: "Microsoft Hoda - Arabic (Egypt)", lang: "ar-EG" },
  { name: "Microsoft Naayf - Arabic (Saudi Arabia)", lang: "ar-SA" },
  { name: "Microsoft Asaf - Hebrew", lang: "he-IL" },
  { name: "Microsoft Stefanos - Greek", lang: "el-GR" },
  { name: "Microsoft Filip - Czech", lang: "cs-CZ" },
  { name: "Microsoft Szabolcs - Hungarian", lang: "hu-HU" },
  { name: "Microsoft An - Vietnamese", lang: "vi-VN" },
];

const MACOS_SPEECH_VOICES = [
  { name: "Alex", lang: "en-US" }, { name: "Samantha", lang: "en-US" }, { name: "Victoria", lang: "en-US" },
  { name: "Fred", lang: "en-US" }, { name: "Junior", lang: "en-US" }, { name: "Kathy", lang: "en-US" },
  { name: "Daniel", lang: "en-GB" }, { name: "Kate", lang: "en-GB" }, { name: "Oliver", lang: "en-GB" },
  { name: "Serena", lang: "en-GB" }, { name: "Moira", lang: "en-IE" }, { name: "Fiona", lang: "en-GB" },
  { name: "Karen", lang: "en-AU" }, { name: "Lee", lang: "en-AU" }, { name: "Tessa", lang: "en-ZA" },
  { name: "Ting-Ting", lang: "zh-CN" }, { name: "Sin-ji", lang: "zh-HK" }, { name: "Mei-Jia", lang: "zh-TW" },
  { name: "Kyoko", lang: "ja-JP" }, { name: "Otoya", lang: "ja-JP" },
  { name: "Yuna", lang: "ko-KR" },
  { name: "Thomas", lang: "fr-FR" }, { name: "Amelie", lang: "fr-CA" }, { name: "Audrey", lang: "fr-FR" },
  { name: "Anna", lang: "de-DE" }, { name: "Helena", lang: "de-DE" }, { name: "Markus", lang: "de-DE" },
  { name: "Monica", lang: "es-ES" }, { name: "Paulina", lang: "es-MX" }, { name: "Jorge", lang: "es-ES" },
  { name: "Alice", lang: "it-IT" }, { name: "Luca", lang: "it-IT" },
  { name: "Luciana", lang: "pt-BR" }, { name: "Joana", lang: "pt-PT" },
  { name: "Milena", lang: "ru-RU" }, { name: "Yuri", lang: "ru-RU" },
  { name: "Xander", lang: "nl-NL" }, { name: "Ellen", lang: "nl-BE" },
  { name: "Alva", lang: "sv-SE" }, { name: "Oskar", lang: "sv-SE" },
  { name: "Satu", lang: "fi-FI" },
  { name: "Nora", lang: "nb-NO" },
  { name: "Zosia", lang: "pl-PL" },
  { name: "Zuzana", lang: "cs-CZ" },
  { name: "Lekha", lang: "hi-IN" },
  { name: "Kanya", lang: "th-TH" },
  { name: "Damayanti", lang: "id-ID" },
  { name: "Melina", lang: "el-GR" },
  { name: "Carmit", lang: "he-IL" },
  { name: "Maged", lang: "ar-SA" },
  { name: "Tarik", lang: "ar-SA" },
];

const ANDROID_SPEECH_VOICES = [
  { name: "English (United States)", lang: "en-US" },
  { name: "English (United Kingdom)", lang: "en-GB" },
  { name: "English (Australia)", lang: "en-AU" },
  { name: "English (India)", lang: "en-IN" },
  { name: "English (Nigeria)", lang: "en-NG" },
  { name: "Chinese (China)", lang: "zh-CN" },
  { name: "Chinese (Taiwan)", lang: "zh-TW" },
  { name: "Chinese (Hong Kong)", lang: "zh-HK" },
  { name: "Japanese (Japan)", lang: "ja-JP" },
  { name: "Korean (South Korea)", lang: "ko-KR" },
  { name: "French (France)", lang: "fr-FR" },
  { name: "French (Canada)", lang: "fr-CA" },
  { name: "German (Germany)", lang: "de-DE" },
  { name: "Spanish (Spain)", lang: "es-ES" },
  { name: "Spanish (United States)", lang: "es-US" },
  { name: "Italian (Italy)", lang: "it-IT" },
  { name: "Portuguese (Brazil)", lang: "pt-BR" },
  { name: "Portuguese (Portugal)", lang: "pt-PT" },
  { name: "Russian (Russia)", lang: "ru-RU" },
  { name: "Dutch (Netherlands)", lang: "nl-NL" },
  { name: "Polish (Poland)", lang: "pl-PL" },
  { name: "Swedish (Sweden)", lang: "sv-SE" },
  { name: "Finnish (Finland)", lang: "fi-FI" },
  { name: "Norwegian Bokmål (Norway)", lang: "nb-NO" },
  { name: "Danish (Denmark)", lang: "da-DK" },
  { name: "Czech (Czechia)", lang: "cs-CZ" },
  { name: "Hungarian (Hungary)", lang: "hu-HU" },
  { name: "Turkish (Turkey)", lang: "tr-TR" },
  { name: "Greek (Greece)", lang: "el-GR" },
  { name: "Hebrew (Israel)", lang: "he-IL" },
  { name: "Hindi (India)", lang: "hi-IN" },
  { name: "Indonesian (Indonesia)", lang: "id-ID" },
  { name: "Thai (Thailand)", lang: "th-TH" },
  { name: "Vietnamese (Vietnam)", lang: "vi-VN" },
  { name: "Arabic (Saudi Arabia)", lang: "ar-SA" },
  { name: "Ukrainian (Ukraine)", lang: "uk-UA" },
];

const GOOGLE_SPEECH_VOICES = [
  { name: "Google US English", lang: "en-US" }, { name: "Google UK English Female", lang: "en-GB" },
  { name: "Google UK English Male", lang: "en-GB" },
  { name: "Google 普通话（中国大陆）", lang: "zh-CN" }, { name: "Google 粤語（香港）", lang: "zh-HK" },
  { name: "Google 國語（臺灣）", lang: "zh-TW" },
  { name: "Google 日本語", lang: "ja-JP" },
  { name: "Google 한국의", lang: "ko-KR" },
  { name: "Google français", lang: "fr-FR" },
  { name: "Google Deutsch", lang: "de-DE" },
  { name: "Google español", lang: "es-ES" }, { name: "Google español de Estados Unidos", lang: "es-US" },
  { name: "Google italiano", lang: "it-IT" },
  { name: "Google português do Brasil", lang: "pt-BR" },
  { name: "Google русский", lang: "ru-RU" },
  { name: "Google Nederlands", lang: "nl-NL" },
  { name: "Google svenska", lang: "sv-SE" },
  { name: "Google suomi", lang: "fi-FI" },
  { name: "Google norsk bokmål", lang: "nb-NO" },
  { name: "Google polski", lang: "pl-PL" },
  { name: "Google čeština", lang: "cs-CZ" },
  { name: "Google हिन्दी", lang: "hi-IN" },
  { name: "Google ไทย", lang: "th-TH" },
  { name: "Google Bahasa Indonesia", lang: "id-ID" },
  { name: "Google ελληνικά", lang: "el-GR" },
  { name: "Google עברית", lang: "he-IL" },
  { name: "Google العربية", lang: "ar-SA" },
];

const SPEECH_VOICE_POOL = [
  ...WINDOWS_SPEECH_VOICES,
  ...MACOS_SPEECH_VOICES,
  ...ANDROID_SPEECH_VOICES,
  ...GOOGLE_SPEECH_VOICES,
];

const DEVICE_NAME_PREFIXES = [
  'DESKTOP', 'LAPTOP', 'PC', 'WIN', 'MAC', 'HOME', 'WORK', 'OFFICE', 'STUDIO', 'DEV',
];
const DEVICE_NAME_SUFFIXES = [
  'Alpha', 'Nova', 'Orbit', 'Pulse', 'Ridge', 'Summit', 'Vertex', 'Atlas', 'Cedar', 'Delta',
  'Echo', 'Flint', 'Grove', 'Harbor', 'Ivory', 'Jade', 'Kepler', 'Lumen', 'Maple', 'Nimbus',
];


/** High-risk hosts where canvas/webgl noise stays tighter for session consistency. */
const DEFAULT_STABILITY_HOSTS = [
  'amazon.com', 'amazon.co.jp', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.es', 'amazon.it',
  'amazonaws.com', 'smile.amazon.com',
  'shopee.com', 'shopee.sg', 'shopee.co.id', 'shopee.tw', 'shopee.vn', 'shopee.co.th', 'shopee.ph', 'shopee.com.my', 'shopee.com.br',
  'lazada.com', 'lazada.sg', 'lazada.co.id', 'lazada.com.my', 'lazada.vn', 'lazada.co.th', 'lazada.ph',
  'tiktok.com', 'tiktokv.com', 'bytedance.com',
  'ebay.com', 'ebay.co.uk', 'ebay.de',
  'paypal.com', 'stripe.com', 'checkout.stripe.com',
  'binance.com', 'coinbase.com', 'okx.com', 'bybit.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com',
  'google.com', 'accounts.google.com', 'gmail.com',
  'microsoft.com', 'login.live.com', 'account.microsoft.com',
  'apple.com', 'icloud.com',
  'browserleaks.com', 'browserleaks.org', 'creepjs.com', 'amiunique.org', 'coveryourtracks.eff.org',
  'fingerprintjs.com', 'fingerprint.com', 'pixelscan.net', 'sannysoft.com', 'bot.sannysoft.com',
  'iphey.com', 'whoer.net', 'whatismybrowser.com', 'deviceinfo.me',
];

/** Hosts that should keep normal noise even when parent domains match. */
const DEFAULT_STABILITY_SKIP_HOSTS = [
  'sephora.com', 'whatsapp.com', 'web.whatsapp.com', 'dhgate.com', 'cdn.', 'static.',
];

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
    .replace(/^\.+/, '');
}

function hostMatchesPattern(host, pattern) {
  const h = normalizeHost(host);
  const p = normalizeHost(pattern);
  if (!h || !p) return false;
  if (p.endsWith('.')) return h === p.slice(0, -1) || h.endsWith('.' + p.slice(0, -1)) || h.startsWith(p);
  if (h === p) return true;
  return h.endsWith('.' + p);
}

function listIncludesHost(list, host) {
  if (!Array.isArray(list) || !list.length) return false;
  const h = normalizeHost(host);
  if (!h) return false;
  return list.some((item) => hostMatchesPattern(h, item));
}

/**
 * Resolve site-aware canvas/webgl stability.
 * mode: off | auto | force
 *
 * 【稳定性策略与 skipHosts 语义设计说明】
 * 1. stability 目标：高风控站点（如电商、金融、社交）往往对 Canvas / WebGL 做重复采样比对，
 *    若每次采样结果波动则判为指纹浏览器。
 *    因此当 stability 命中（active === true）时，将噪声振幅 noiseAmplitude 压缩为 1。
 *    根据 delta = Math.floor(noise * amp) - Math.floor(amp / 2)，当 amp=1 时 delta 恒为 0（零噪声，最大一致性）。
 * 2. skipHosts 含义：例外名单（DEFAULT_STABILITY_SKIP_HOSTS 包括 sephora.com, cdn.*, static.* 等）。
 *    其语义是“即使父域命中 stability 策略，这些主机也保留常规噪声”的例外表（not skipped 即保留降噪），
 *    绝不是“跳过指纹伪造”。命中 skipHosts 时 active 为 false，保留默认常规噪声（amp=3，delta ∈ {-1,0,1}）。
 * 3. mode 三态语义：
 *    - 'force': 强制开启 stability（除 skipHosts 外全部 active=true，零噪声）
 *    - 'off': 关闭 stability（active 恒为 false，全部保留常规噪声 amp=3）
 *    - 'auto' / 默认: 仅当 host 命中 stability.hosts 且未被 skipHosts 排除时 active=true（零噪声），其余站点保留常规噪声。
 */
function resolveStabilityPolicy(privacy = {}, options = {}) {
  const fpIn = (privacy.fingerprint && typeof privacy.fingerprint === 'object' ? privacy.fingerprint : null) || (options.fingerprint && typeof options.fingerprint === 'object' ? options.fingerprint : {});
  const modeRaw = String(options.mode || fpIn.stabilityMode || privacy.stabilityMode || 'auto').toLowerCase();
  const mode = ['off', 'auto', 'force'].includes(modeRaw) ? modeRaw : 'auto';
  const customHosts = Array.isArray(fpIn.stabilityHosts)
    ? fpIn.stabilityHosts
    : (Array.isArray(privacy.stabilityHosts) ? privacy.stabilityHosts : null);
  const customSkip = Array.isArray(fpIn.stabilitySkipHosts)
    ? fpIn.stabilitySkipHosts
    : (Array.isArray(privacy.stabilitySkipHosts) ? privacy.stabilitySkipHosts : null);
  const hosts = (customHosts && customHosts.length ? customHosts : DEFAULT_STABILITY_HOSTS)
    .map(normalizeHost).filter(Boolean).slice(0, 800);
  const skipHosts = (customSkip && customSkip.length ? customSkip : DEFAULT_STABILITY_SKIP_HOSTS)
    .map(normalizeHost).filter(Boolean).slice(0, 200);
  const hamming = Math.min(64, Math.max(1, Number(fpIn.stabilityHamming ?? privacy.stabilityHamming) || 12));
  const maxWidth = Math.min(4096, Math.max(64, Number(fpIn.stabilityMaxWidth ?? privacy.stabilityMaxWidth) || 600));
  const maxHeight = Math.min(4096, Math.max(64, Number(fpIn.stabilityMaxHeight ?? privacy.stabilityMaxHeight) || 600));
  const square = Math.min(64, Math.max(2, Number(fpIn.stabilitySquare ?? privacy.stabilitySquare) || 8));
  const host = normalizeHost(options.host || options.hostname || '');
  const skipped = host ? listIncludesHost(skipHosts, host) : false;
  const matched = host ? listIncludesHost(hosts, host) : false;
  let active = false;
  if (mode === 'force') active = !skipped;
  else if (mode === 'auto') active = matched && !skipped;
  // reduced amplitude: 1 (stable) vs 3 (default) pixel delta range
  const noiseAmplitude = active ? 1 : 3;
  const sampleStepDivisor = active ? 128 : 64;
  return {
    mode,
    active,
    matched,
    skipped,
    host: host || null,
    hosts,
    skipHosts,
    hamming,
    maxWidth,
    maxHeight,
    square,
    noiseAmplitude,
    sampleStepDivisor,
  };
}

function matchStabilityHost(host, privacy = {}) {
  return resolveStabilityPolicy(privacy, { host }).active;
}

/** Sample R-channel block origins for canvas consistency checks. */
function sampleCanvasBlocks(data, width, height, options = {}) {
  const maxWidth = Math.min(4096, Math.max(1, Number(options.maxWidth) || 600));
  const maxHeight = Math.min(4096, Math.max(1, Number(options.maxHeight) || 600));
  const square = Math.min(64, Math.max(2, Number(options.square) || 8));
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const limitW = w > 0 ? Math.min(w, maxWidth) : 0;
  const limitH = h > 0 ? Math.min(h, maxHeight) : 0;
  const samples = [];
  if (!data || !limitW || !limitH) return samples;
  const len = data.length;
  for (let y = 0; y < limitH; y += square) {
    for (let x = 0; x < limitW; x += square) {
      const px = ((y * w) + x) * 4;
      if (px >= len) continue;
      samples.push(data[px] & 0xff);
    }
  }
  return samples;
}

/** Bit-level Hamming distance between equal-length byte arrays / number arrays. */
function hammingDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const n = Math.min(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < n; i += 1) {
    let x = (a[i] ^ b[i]) & 0xff;
    // popcount
    x = x - ((x >>> 1) & 0x55);
    x = (x & 0x33) + ((x >>> 2) & 0x33);
    dist += (((x + (x >>> 4)) & 0x0f) * 0x01) & 0xff;
  }
  dist += Math.abs((a.length || 0) - (b.length || 0)) * 8;
  return dist;
}

/**
 * Apply deterministic block noise and optionally lock deltas for session consistency.
 * When lockMap is provided and key exists, reuses prior deltas so repeated reads stay within hamming threshold.
 */
function applyStableCanvasNoise(imageData, mark, options = {}) {
  const data = imageData && imageData.data;
  if (!data) return imageData;
  const width = imageData.width || 0;
  const height = imageData.height || 0;
  const maxWidth = Math.min(4096, Math.max(1, Number(options.maxWidth) || 600));
  const maxHeight = Math.min(4096, Math.max(1, Number(options.maxHeight) || 600));
  const square = Math.min(64, Math.max(2, Number(options.square) || 8));
  const amp = Math.max(1, Number(options.noiseAmplitude) || 1);
  const seedNum = Number(options.seedNum) || 1;
  const noise = typeof options.noise === 'function'
    ? options.noise
    : ((n) => {
      let x = Math.sin((n + 1) * seedNum) * 10000;
      return x - Math.floor(x);
    });
  const limitW = width > 0 ? Math.min(width, maxWidth) : width;
  const limitH = height > 0 ? Math.min(height, maxHeight) : height;
  const lockMap = options.lockMap || null;
  const lockKey = options.lockKey || `${width}x${height}:${mark}:${square}:${amp}`;
  let locked = lockMap && lockMap.get ? lockMap.get(lockKey) : null;
  if (!locked) {
    locked = [];
    for (let y = 0; y < (limitH || height); y += square) {
      for (let x = 0; x < (limitW || width); x += square) {
        const px = ((y * width) + x) * 4;
        if (px + 3 >= data.length) continue;
        const delta = Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2);
        locked.push({ px, delta });
      }
    }
    if (lockMap && lockMap.set) lockMap.set(lockKey, locked);
  }
  for (const item of locked) {
    const px = item.px;
    if (px + 3 >= data.length) continue;
    data[px] = Math.max(0, Math.min(255, data[px] + item.delta));
  }
  return imageData;
}

/** True when two sample vectors are within the configured Hamming threshold. */
function withinHammingThreshold(a, b, threshold = 12) {
  const limit = Math.min(64, Math.max(0, Number(threshold) || 12));
  return hammingDistance(a, b) <= limit;
}



/** Deterministic battery snapshot derived from seed. */
function createBatteryFromSeed(seedInput, override = null) {
  if (override && typeof override === 'object') {
    const level = Math.min(1, Math.max(0, Number(override.level)));
    const charging = override.charging !== false && override.charging !== 0 && override.charging !== '0';
    return {
      charging,
      // null means "unknown / Infinity" for JSON-safe transport into injection
      chargingTime: Number.isFinite(Number(override.chargingTime))
        ? Math.max(0, Number(override.chargingTime))
        : (charging ? 0 : null),
      dischargingTime: Number.isFinite(Number(override.dischargingTime))
        ? Math.max(0, Number(override.dischargingTime))
        : (charging ? null : 7200),
      level: Number.isFinite(level) ? level : 0.87,
    };
  }
  const seed = hashSeed(String(seedInput || 'battery'));
  const levelRaw = 55 + (u32(seed, 0) % 40); // 0.55 - 0.94
  const charging = (u32(seed, 4) % 5) !== 0; // mostly charging on desktop
  const level = levelRaw / 100;
  if (charging) {
    return {
      charging: true,
      chargingTime: 600 + (u32(seed, 8) % 5400),
      dischargingTime: null,
      level,
    };
  }
  return {
    charging: false,
    chargingTime: null,
    dischargingTime: 1800 + (u32(seed, 12) % 14400),
    level,
  };
}

/** Seed-stable mic/camera/speaker labels for mediaDevices spoof. */
function createMediaDevicesFromSeed(seedInput, options = {}) {
  const raw = String(seedInput || 'default');
  let acc = 0;
  for (let i = 0; i < raw.length; i += 1) acc += raw.charCodeAt(i);
  const osKey = String(options.os || '').toLowerCase();
  const pool = (osKey.startsWith('macos') || osKey === 'darwin')
    ? MEDIA_DEVICE_POOLS_BY_OS.macos
    : (osKey === 'android'
      ? MEDIA_DEVICE_POOLS_BY_OS.android
      : (osKey === 'linux'
        ? MEDIA_DEVICE_POOLS_BY_OS.linux
        : MEDIA_DEVICE_TEMPLATES));
  const tpl = pool[acc % pool.length] || pool[0];
  // Chrome hands out 64-character lowercase hex identifiers, salted per origin, and never brands
  // them with a product prefix. Derive each identifier from the whole profile seed so two
  // profiles cannot share one: the previous running-sum derivation only depended on the first two
  // characters, so env-001/env-002/env-003 all published the same audio-input deviceId and could
  // be linked across environments.
  const digestHex = (salt) => crypto.createHash('sha256').update(raw + '|' + salt).digest('hex');
  const audioInputId = digestHex('audioinput');
  const videoInputId = digestHex('videoinput');
  const audioOutputId = digestHex('audiooutput');
  const groupId = digestHex('group');
  const usbTag = digestHex('usb').slice(0, 4) + ':' + digestHex('usb').slice(4, 8);
  const emptyLabels = options.emptyLabels === true;
  const labelOverride = options.labels && typeof options.labels === 'object' ? options.labels : null;
  const inputLabel = emptyLabels ? '' : String(labelOverride?.audioinput || labelOverride?.input || tpl.input);
  const defaultVideo = pool === MEDIA_DEVICE_POOLS_BY_OS.macos
    ? (tpl.video || 'FaceTime HD Camera')
    : (pool === MEDIA_DEVICE_POOLS_BY_OS.android
      ? (tpl.video || 'Back Camera')
      : (tpl.video ? `${tpl.video} (${usbTag})` : `Integrated Camera (${usbTag})`));
  const videoLabel = emptyLabels ? '' : String(labelOverride?.videoinput || labelOverride?.video || defaultVideo);
  const outputLabel = emptyLabels ? '' : String(labelOverride?.audiooutput || labelOverride?.output || tpl.output);
  const devices = [
    { kind: 'audioinput', label: inputLabel, deviceId: audioInputId, groupId },
    { kind: 'videoinput', label: videoLabel, deviceId: videoInputId, groupId },
    { kind: 'audiooutput', label: outputLabel, deviceId: audioOutputId, groupId },
  ];
  if (Array.isArray(options.extra) && options.extra.length) {
    for (const item of options.extra.slice(0, 8)) {
      if (item && item.kind) devices.push({
        kind: String(item.kind),
        label: String(item.label || ''),
        deviceId: String(item.deviceId || digestHex('extra' + devices.length)),
        groupId: String(item.groupId || groupId),
      });
    }
  }
  return devices;
}

/** Pick a stable default speech voice matching the primary language. */
/**
 * Voices a given platform can actually ship. Apple voices are the bare given names
 * (Alex, Samantha, Otoya); Windows uses the "Microsoft X - Language" form; the Google
 * voices are bundled by Chrome itself and appear everywhere. Without an OS the full table
 * is returned, which keeps previously generated profiles byte-identical.
 */
function speechVoicePoolForOs(os) {
  const family = String(os || "").toLowerCase().trim();
  const isAndroid = family.includes("android");
  const isIos = !isAndroid && (family.includes("ios") || family.includes("iphone") || family.includes("ipad"));
  const isMac = !isAndroid && !isIos && (family.includes("mac") || family.includes("darwin"));
  const isLinux = !isAndroid && !isIos && !isMac && (family.includes("linux") || family.includes("x11") || family.includes("unix") || family.includes("ubuntu"));
  const isWindows = !isAndroid && !isIos && !isMac && !isLinux && family.includes("win");

  if (isAndroid) {
    return ANDROID_SPEECH_VOICES;
  }
  if (isIos) {
    return MACOS_SPEECH_VOICES;
  }
  if (isWindows) {
    return [...WINDOWS_SPEECH_VOICES, ...GOOGLE_SPEECH_VOICES];
  }
  if (isLinux) {
    return GOOGLE_SPEECH_VOICES;
  }
  if (isMac) {
    return [...MACOS_SPEECH_VOICES, ...GOOGLE_SPEECH_VOICES];
  }
  return [...WINDOWS_SPEECH_VOICES, ...GOOGLE_SPEECH_VOICES];
}

function createSpeechVoicesFromSeed(seedInput, languages = ['en-US'], mode = 'noise', options = {}) {
  if (mode === 'blocked') return [];
  if (mode === 'real') return null;
  // speechSynthesis.getVoices() is a strong OS signal: Samantha and Alex only exist on
  // macOS, the "Microsoft X - Language" voices only on Windows, and a stock Linux Chrome
  // reports just the bundled Google ones. Selecting purely by language mixes those
  // families, so a profile claiming Windows can answer with Apple voices. When an OS is
  // supplied the table is narrowed to what that platform can actually ship.
  const pool = speechVoicePoolForOs(options.os);
  const langs = (Array.isArray(languages) ? languages : [languages])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const primary = langs[0] || 'en-US';
  const primaryLang = primary.split('-')[0].toLowerCase();
  const langSet = new Set(langs.map((item) => item.toLowerCase()));
  const langPrefixSet = new Set(langs.map((item) => item.split('-')[0].toLowerCase()));
  const seed = hashSeed(String(seedInput || primary));
  // 18-32 voices, closer to full system tables — but never more than the platform has.
  const count = Math.min(pool.length, 18 + (u32(seed, 4) % 15));
  const scored = pool.map((base, index) => {
    let score = 0;
    const lang = String(base.lang || '').toLowerCase();
    const prefix = lang.split('-')[0];
    if (lang === primary.toLowerCase()) score += 100;
    else if (langSet.has(lang)) score += 80;
    else if (prefix === primaryLang) score += 60;
    else if (langPrefixSet.has(prefix)) score += 40;
    else if (prefix === 'en') score += 10;
    score += (u32(seed, 8 + (index % 24)) % 7);
    return { base, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  const picked = [];
  const used = new Set();
  for (const item of scored) {
    if (picked.length >= count) break;
    const base = item.base;
    const key = `${base.name}|${base.lang}`;
    if (used.has(key)) continue;
    used.add(key);
    picked.push({
      name: base.name,
      lang: base.lang,
      default: false,
      localService: !/^Google\s/i.test(base.name),
      // Chrome reports the voice name itself as the URI - verified against a real Chrome, where
      // every macOS voice exposes voiceURI === name. The previous scheme emitted a
      // product-branded URI for persona-less profiles, which any page could read straight out of
      // speechSynthesis.getVoices() and use to identify the browser, so the plain name is now
      // always used.
      voiceURI: base.name,
    });
  }
  let def = picked.find((v) => v.lang === primary)
    || picked.find((v) => v.lang.toLowerCase().startsWith(primaryLang))
    || picked[0];
  if (def) {
    def.default = true;
    if (def.localService == null) def.localService = true;
  }
  return picked;
}

/** Seeded host-style device name for machine / product surfaces. */
function createDeviceNameFromSeed(seedInput, options = {}) {
  const mode = String(options.mode || 'noise');
  const custom = String(options.custom || '').trim().slice(0, 120);
  if (mode === 'real') return null;
  if (mode === 'custom' && custom) return custom;
  const seed = hashSeed(String(seedInput || 'device'));
  const prefix = DEVICE_NAME_PREFIXES[u32(seed, 0) % DEVICE_NAME_PREFIXES.length];
  const suffix = DEVICE_NAME_SUFFIXES[u32(seed, 4) % DEVICE_NAME_SUFFIXES.length];
  const num = 1000 + (u32(seed, 8) % 9000);
  if ((u32(seed, 12) % 3) === 0) return `${suffix}-${num}`;
  return `${prefix}-${suffix}${String(num).slice(0, 3)}`;
}

/** Deterministic private IPv4 used as the local ICE candidate surface. */
function createLocalIpFromSeed(seedInput) {
  const seed = hashSeed(String(seedInput || 'local-ip'));
  const classPick = u32(seed, 0) % 3;
  if (classPick === 0) {
    return `10.${u32(seed, 4) % 256}.${u32(seed, 8) % 256}.${1 + (u32(seed, 12) % 254)}`;
  }
  if (classPick === 1) {
    return `192.168.${u32(seed, 4) % 256}.${1 + (u32(seed, 8) % 254)}`;
  }
  return `172.${16 + (u32(seed, 4) % 16)}.${u32(seed, 8) % 256}.${1 + (u32(seed, 12) % 254)}`;
}

function formatGeopositionValue(geo) {
  if (!geo || typeof geo !== 'object') return null;
  const lat = Number(geo.latitude);
  const lon = Number(geo.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const accuracy = Number.isFinite(Number(geo.accuracy)) ? Number(geo.accuracy) : 1000;
  return `${lat},${lon},${accuracy}`;
}

/** Audio noise mark: sum(charCode) % 2000 - 1000 */
function audioMarkFromSeed(seedInput) {
  const s = String(seedInput || '');
  let n = 0;
  for (let i = 0; i < s.length; i += 1) n += s.charCodeAt(i);
  return (n % 2000) - 1000 || 1;
}

/** ClientRect noise mark: hash % 20000 - 10000 */
function clientRectMarkFromSeed(seedBufOrStr) {
  if (Buffer.isBuffer(seedBufOrStr)) {
    const v = (u32(seedBufOrStr, 40) % 20000) - 10000;
    return v === 0 ? 1 : v;
  }
  const s = String(seedBufOrStr || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const v = (Math.abs(h) % 20000) - 10000;
  return v === 0 ? 1 : v;
}

/** WebGL fingerprint payload: vendor/renderer + optional GPUAdapterInfo. */
function buildWebglFpPayload(webgl = {}) {
  const payload = {
    UNMASKED_VENDOR_WEBGL: webgl.vendor || '',
    UNMASKED_RENDERER_WEBGL: webgl.renderer || '',
    SUPPORTED_EXTENSIONS: Array.isArray(webgl.extensions) ? webgl.extensions : [],
  };
  if (webgl.gpu && (webgl.gpu.vendor || webgl.gpu.architecture)) {
    payload.GPUAdapterInfo = {
      vendor: String(webgl.gpu.vendor || ''),
      architecture: String(webgl.gpu.architecture || ''),
    };
  }
  return payload;
}

function desktopOs(os) {
  return ['windows', 'macos', 'macos_arm', 'linux'].includes(os) ? os : null;
}

function webglPresetsForOs(os, options = {}) {
  let list = WEBGL_PRESETS.windows;
  // "macos" is the x86 Chrome build (Intel Mac); "macos_arm" is the Apple Silicon build.
  // Mixing the two pools is a contradiction detectors score directly.
  if (os === 'macos') list = WEBGL_PRESETS.macos_intel;
  else if (os === 'macos_arm') list = WEBGL_PRESETS.macos_apple;
  else if (os === 'linux') list = WEBGL_PRESETS.linux;
  else if (os === 'android') list = WEBGL_PRESETS.android;
  else if (os === 'ios') list = WEBGL_PRESETS.ios;
  if (options.legacy && (!os || os === 'windows')) return list.slice(0, 16);
  return list;
}

// WebGL reports a handful of hardware limits straight from the driver. A page that reads the
// spoofed adapter name and then compares it against those limits can tell the two apart - a
// persona claiming one GPU while MAX_TEXTURE_SIZE still describes the host GPU is exactly the
// kind of cross check a detector runs. Each entry below is the value a page sees for that GPU
// class under a current desktop driver; `texture` doubles as the viewport/cube/renderbuffer size
// because those limits are equal on every desktop driver in the table.
const WEBGL_GPU_LIMITS = {
  // vendor: architecture -> limits
  nvidia: {
    ada: { texture: 32768, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 192 },
    ampere: { texture: 32768, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 192 },
    turing: { texture: 32768, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 192 },
  },
  amd: {
    'rdna-3': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 128 },
    'rdna-2': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 128 },
    'rdna-1': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 128 },
    'gcn-4': { texture: 16384, vertexUniform: 4096, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 128 },
    'gcn-3': { texture: 16384, vertexUniform: 4096, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 128 },
    vega: { texture: 16384, vertexUniform: 4096, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 128 },
  },
  intel: {
    alchemist: { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 96 },
    gen12: { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 96 },
    gen11: { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 96 },
    gen9: { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 96 },
    gen7: { texture: 8192, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 96 },
  },
  apple: {
    'common-3': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 511, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 12, maxFragmentUniformBlocks: 12, maxCombinedTextureImageUnits: 80 },
    'common-4': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 511, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 12, maxFragmentUniformBlocks: 12, maxCombinedTextureImageUnits: 80 },
  },
  qualcomm: {
    'adreno-700': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 64, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 96 },
  },
  arm: {
    valhall: { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 64, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 96 },
  },
  samsung: {
    'rdna-2': { texture: 16384, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 256, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 128 },
  },
  imagination: {
    rogue: { texture: 8192, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 64, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 96 },
    powervr: { texture: 8192, vertexUniform: 1024, varying: 32, pointSize: 1024, uniformBufferOffsetAlignment: 64, maxUniformBlockSize: 65536, maxVertexUniformBlocks: 14, maxFragmentUniformBlocks: 14, maxCombinedTextureImageUnits: 96 },
  },
};

const HOST_WEBGL2_DEFAULTS = Object.freeze({
  macos: Object.freeze({
    maxUniformBlockSize: 65536,
    maxVertexUniformBlocks: 12,
    maxFragmentUniformBlocks: 12,
    maxCombinedTextureImageUnits: 80,
    uniformBufferOffsetAlignment: 256,
  }),
  linux: Object.freeze({
    maxUniformBlockSize: 65536,
    maxVertexUniformBlocks: 14,
    maxFragmentUniformBlocks: 14,
    maxCombinedTextureImageUnits: 96,
    uniformBufferOffsetAlignment: 256,
  }),
  windows: Object.freeze({
    maxUniformBlockSize: 65536,
    maxVertexUniformBlocks: 14,
    maxFragmentUniformBlocks: 14,
    maxCombinedTextureImageUnits: 192,
    uniformBufferOffsetAlignment: 256,
  }),
});

/** WebGL parameter ids that a coerced adapter identity has to answer for. */
const WEBGL_PARAM_IDS = Object.freeze({
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_VIEWPORT_DIMS: 0x0d3a,
  ALIASED_POINT_SIZE_RANGE: 0x846d,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  MAX_RENDERBUFFER_SIZE: 0x84e8,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  MAX_VARYING_VECTORS: 0x8dfc,
  MAX_UNIFORM_BLOCK_SIZE: 0x8a30,
  UNIFORM_BUFFER_OFFSET_ALIGNMENT: 0x8a34,
  MAX_VERTEX_UNIFORM_BLOCKS: 0x8a2b,
  MAX_FRAGMENT_UNIFORM_BLOCKS: 0x8a2d,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
});

/**
 * Normalizes GPU architecture keys so variants like "gen-9", "gen-12lp", "gen12"
 * map consistently to the canonical entries in WEBGL_GPU_LIMITS.
 */
function normalizeGpuArchitecture(vendor, arch) {
  const v = String(vendor || "").toLowerCase().trim();
  const raw = String(arch || "").toLowerCase().trim();
  if (!raw) return "";

  if (v === "intel") {
    const m = raw.match(/^gen-?(\d+)(?:-?lp)?$/);
    if (m) {
      const canonical = "gen" + m[1];
      if (WEBGL_GPU_LIMITS.intel && Object.prototype.hasOwnProperty.call(WEBGL_GPU_LIMITS.intel, canonical)) {
        return canonical;
      }
      return canonical;
    }
    if (raw === "alchemist" || raw === "battlemage") {
      return raw;
    }
  } else if (v === "amd") {
    const mRdna = raw.match(/^rdna-?([123])$/);
    if (mRdna) return "rdna-" + mRdna[1];
    const mGcn = raw.match(/^gcn-?([34])$/);
    if (mGcn) return "gcn-" + mGcn[1];
    if (raw === "vega") return "vega";
  } else if (v === "apple") {
    if (raw.startsWith("apple-m") || /^m[1-4]/.test(raw)) {
      return "common-3";
    }
  } else if (v === "nvidia") {
    if (raw.includes("ada") || raw.includes("40")) return "ada";
    if (raw.includes("ampere") || raw.includes("30")) return "ampere";
    if (raw.includes("turing") || raw.includes("20") || raw.includes("16")) return "turing";
  } else if (v === "qualcomm") {
    if (raw.includes("700") || raw.includes("730") || raw.includes("740") || raw.includes("adreno")) return "adreno-700";
  } else if (v === "arm") {
    if (raw.includes("valhall") || raw.includes("g710") || raw.includes("mali")) return "valhall";
  } else if (v === "samsung") {
    return "rdna-2";
  } else if (v === "imagination" || v.includes("powervr")) {
    return "rogue";
  }
  return raw;
}

/**
 * Per-persona overrides for the driver-reported WebGL limits.
 *
 * Returns null when nothing should be coerced (no GPU identity, or real mode), otherwise a
 * plain object keyed by the numeric parameter id. Values are pulled from the class table so
 * two profiles with the same GPU always agree, and `MAX_VIEWPORT_DIMS` is derived from the
 * renderbuffer size rather than being carried separately.
 */
function webglParameterOverrides(gpu, options = {}) {
  if (!gpu || typeof gpu !== "object") return null;
  let vendor = String(gpu.vendor || gpu.family || "").toLowerCase().trim();
  if (vendor.includes("imagination") || vendor.includes("powervr")) vendor = "imagination";
  else if (vendor.includes("qualcomm") || vendor.includes("adreno")) vendor = "qualcomm";
  else if (vendor.includes("arm") || vendor.includes("mali")) vendor = "arm";
  else if (vendor.includes("apple")) vendor = "apple";
  else if (vendor.includes("nvidia")) vendor = "nvidia";
  else if (vendor.includes("amd")) vendor = "amd";
  else if (vendor.includes("intel")) vendor = "intel";
  else if (vendor.includes("samsung")) vendor = "samsung";
  const arch = String(gpu.architecture || gpu.family || "").toLowerCase().trim();
  const family = WEBGL_GPU_LIMITS[vendor];
  if (!family) return null;
  const normArch = normalizeGpuArchitecture(vendor, arch);
  // Look up normalized architecture first, then raw architecture, then fall back
  // to the vendor's most conservative entry so an unknown architecture still has to
  // agree with itself rather than leaving host limits in place.
  const entry = family[normArch]
    || family[arch]
    || Object.values(family)[Object.keys(family).length - 1];
  if (!entry) return null;
  const overrides = {};
  let textureLimit = entry.texture;
  let renderbufferLimit = entry.texture;
  let pointSizeLimit = entry.pointSize || (vendor === 'apple' ? 511 : 1024);
  let uniformBufferOffsetAlignment = entry.uniformBufferOffsetAlignment || 256;
  let maxUniformBlockSize = entry.maxUniformBlockSize || 65536;
  let maxVertexUniformBlocks = entry.maxVertexUniformBlocks || (vendor === 'apple' ? 12 : 14);
  let maxFragmentUniformBlocks = entry.maxFragmentUniformBlocks || (vendor === 'apple' ? 12 : 14);
  let maxCombinedTextureImageUnits = entry.maxCombinedTextureImageUnits || (vendor === 'nvidia' ? 192 : (vendor === 'amd' ? 128 : (vendor === 'apple' ? 80 : 96)));

  const shouldReconcile = options.reconcileHost ?? options.clampToHost;
  if (shouldReconcile) {
    const hostLimits = options.hostLimits || getHostWebglLimits(options.hostPlatform || process.platform);
    if (hostLimits) {
      if (Number.isFinite(hostLimits.maxTextureSize) && hostLimits.maxTextureSize > 0) {
        textureLimit = Math.min(textureLimit, hostLimits.maxTextureSize);
        renderbufferLimit = Math.min(renderbufferLimit, hostLimits.maxRenderbufferSize || hostLimits.maxTextureSize);
      }
      if (Array.isArray(hostLimits.aliasedPointSizeRange) && Number.isFinite(hostLimits.aliasedPointSizeRange[1])) {
        pointSizeLimit = Math.min(pointSizeLimit, hostLimits.aliasedPointSizeRange[1]);
      }
      const p = String(options.hostPlatform || process.platform).toLowerCase().trim();
      const hostWebgl2 = HOST_WEBGL2_DEFAULTS[p === 'darwin' || p === 'macos' ? 'macos' : (p === 'linux' ? 'linux' : 'windows')];
      if (hostWebgl2) {
        maxUniformBlockSize = Math.min(maxUniformBlockSize, hostWebgl2.maxUniformBlockSize);
        maxVertexUniformBlocks = Math.min(maxVertexUniformBlocks, hostWebgl2.maxVertexUniformBlocks);
        maxFragmentUniformBlocks = Math.min(maxFragmentUniformBlocks, hostWebgl2.maxFragmentUniformBlocks);
        maxCombinedTextureImageUnits = Math.min(maxCombinedTextureImageUnits, hostWebgl2.maxCombinedTextureImageUnits);
        uniformBufferOffsetAlignment = Math.max(uniformBufferOffsetAlignment, hostWebgl2.uniformBufferOffsetAlignment);
      }
    }
    if (options.hostLimits && typeof options.hostLimits === 'object') {
      if (Number.isFinite(options.hostLimits.maxUniformBlockSize)) {
        maxUniformBlockSize = Math.min(maxUniformBlockSize, options.hostLimits.maxUniformBlockSize);
      }
      if (Number.isFinite(options.hostLimits.maxVertexUniformBlocks)) {
        maxVertexUniformBlocks = Math.min(maxVertexUniformBlocks, options.hostLimits.maxVertexUniformBlocks);
      }
      if (Number.isFinite(options.hostLimits.maxFragmentUniformBlocks)) {
        maxFragmentUniformBlocks = Math.min(maxFragmentUniformBlocks, options.hostLimits.maxFragmentUniformBlocks);
      }
      if (Number.isFinite(options.hostLimits.maxCombinedTextureImageUnits)) {
        maxCombinedTextureImageUnits = Math.min(maxCombinedTextureImageUnits, options.hostLimits.maxCombinedTextureImageUnits);
      }
      if (Number.isFinite(options.hostLimits.uniformBufferOffsetAlignment)) {
        uniformBufferOffsetAlignment = Math.max(uniformBufferOffsetAlignment, options.hostLimits.uniformBufferOffsetAlignment);
      }
    }
  }
  overrides[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE] = textureLimit;
  overrides[WEBGL_PARAM_IDS.MAX_CUBE_MAP_TEXTURE_SIZE] = textureLimit;
  overrides[WEBGL_PARAM_IDS.MAX_RENDERBUFFER_SIZE] = renderbufferLimit;
  overrides[WEBGL_PARAM_IDS.MAX_VERTEX_UNIFORM_VECTORS] = entry.vertexUniform;
  overrides[WEBGL_PARAM_IDS.MAX_VARYING_VECTORS] = entry.varying;
  overrides[WEBGL_PARAM_IDS.ALIASED_POINT_SIZE_RANGE] = pointSizeLimit;
  overrides[WEBGL_PARAM_IDS.UNIFORM_BUFFER_OFFSET_ALIGNMENT] = uniformBufferOffsetAlignment;
  overrides[WEBGL_PARAM_IDS.MAX_UNIFORM_BLOCK_SIZE] = maxUniformBlockSize;
  overrides[WEBGL_PARAM_IDS.MAX_VERTEX_UNIFORM_BLOCKS] = maxVertexUniformBlocks;
  overrides[WEBGL_PARAM_IDS.MAX_FRAGMENT_UNIFORM_BLOCKS] = maxFragmentUniformBlocks;
  overrides[WEBGL_PARAM_IDS.MAX_COMBINED_TEXTURE_IMAGE_UNITS] = maxCombinedTextureImageUnits;
  return overrides;
}


/**
 * Check if a WebGL extension belongs to another GPU vendor and should be filtered.
 */
function isDisallowedVendorExtension(name, targetVendor, metaMode = 'noise') {
  if (!targetVendor || metaMode === 'real') return false;
  const lower = String(name || '').toLowerCase();
  const v = String(targetVendor || '').toLowerCase();
  if (lower.startsWith('nv_') && v !== 'nvidia') return true;
  if (lower.startsWith('amd_') && v !== 'amd') return true;
  if (lower.startsWith('intel_') && v !== 'intel') return true;
  if (lower.startsWith('qcom_') && v !== 'qualcomm') return true;
  return false;
}

function expectedClientHintPlatform(os) {
  if (os === 'macos' || os === 'macos_arm') return 'macOS';
  if (os === 'linux') return 'Linux';
  return 'Windows';
}

/**
 * Build fingerprint config from profile + optional privacy.fingerprint overrides.
 */
function buildFingerprint(profile = {}) {
  const stableIdentity = profile.id || profile.name || 'default';
  const launchSeed = String(profile.fingerprintLaunchSeed || '').trim();
  const seed = hashSeed(launchSeed ? `${stableIdentity}:${launchSeed}` : stableIdentity);
  const rnd = mulberry32(u32(seed, 0));
  const privacy = profile.privacy || {};
  const fpIn = (privacy.fingerprint && typeof privacy.fingerprint === 'object' ? privacy.fingerprint : null) || (profile.fingerprint && typeof profile.fingerprint === 'object' ? profile.fingerprint : {});

  const rawCoresOverride = fpIn.cores ?? privacy.cores;
  const rawMemoryOverride = fpIn.memory ?? privacy.memory;
  const coresOverride = rawCoresOverride === '' || rawCoresOverride === null || rawCoresOverride === undefined ? NaN : Number(rawCoresOverride);
  const memoryOverride = rawMemoryOverride === '' || rawMemoryOverride === null || rawMemoryOverride === undefined ? NaN : Number(rawMemoryOverride);
  const useRealCores = coresOverride === 0;
  const useRealMemory = memoryOverride === 0;
  // These are reassigned below when a coherent device persona is selected (opt-in), so the
  // hardware axes come from one real machine instead of being drawn independently.
  const hasCoresOverride = Number.isFinite(coresOverride) && coresOverride > 0;
  const hasMemoryOverride = Number.isFinite(memoryOverride) && memoryOverride > 0;
  let cores = hasCoresOverride
    ? Math.min(64, Math.max(1, Math.round(coresOverride)))
    : [4, 6, 8, 12, 16][u32(seed, 12) % 5];
  // navigator.deviceMemory is quantised by the spec to 0.25/0.5/1/2/4/8 and capped at 8, so the
  // former 16/32 draws were values no real Chrome can report — a single read identified the
  // browser as spoofed. Desktop Chrome effectively only ever reports 4 or 8. Correcting this
  // re-rolls the value on existing profiles; a profile that must keep its old reading can pin
  // it explicitly through privacy.fingerprint.memory.
  const DEVICE_MEMORY_STEPS = [0.25, 0.5, 1, 2, 4, 8];
  const memoryPool = [4, 8];
  let memory = hasMemoryOverride
    ? DEVICE_MEMORY_STEPS.reduce((best, step) => (
      Math.abs(step - memoryOverride) < Math.abs(best - memoryOverride) ? step : best
    ), 8)
    : memoryPool[u32(seed, 16) % memoryPool.length];
  const width = Number(profile.width) || 1280;
  const height = Number(profile.height) || 820;
  const isHdrRequested = Boolean(fpIn.hdr || privacy.hdr || profile.hdr || (Number(fpIn.colorDepth) === 30));
  let colorDepth = isHdrRequested ? 30 : 24;
  let devicePixelRatio = [1, 1, 1.25, 1.5, 2][u32(seed, 24) % 5];

  // Numeric noise marks (canvas/webgl ±10000; audio/clientRects from seed formulas unless overridden)
  const canvasId = (u32(seed, 28) % 20000) - 10000 || 1;
  const webglId = (u32(seed, 32) % 20000) - 10000 || 1;
  const audioIdDefault = audioMarkFromSeed(seed.toString('hex'));
  const clientRectsIdDefault = clientRectMarkFromSeed(seed);
  const audioId = Number.isFinite(Number(fpIn.audioId)) ? Number(fpIn.audioId) : audioIdDefault;
  const clientRectsId = Number.isFinite(Number(fpIn.clientRectsId)) ? Number(fpIn.clientRectsId) : clientRectsIdDefault;

  const mode = (name, allowed, fallback) => {
    const value = fpIn[name] ?? privacy[name];
    return allowed.includes(String(value || '')) ? String(value) : fallback;
  };

  const canvasMode = mode('canvas', ['real', 'noise', 'blocked'], privacy.canvas === 'blocked' ? 'blocked' : 'noise');
  const webglMode = mode('webgl', ['real', 'noise', 'blocked'], privacy.webgl === 'blocked' ? 'blocked' : 'noise');
  // Metadata (UNMASKED vendor/renderer) can stay real while image noise still runs.
  const webglMetaMode = mode('webglMeta', ['real', 'noise', 'blocked', 'custom'], privacy.webglMeta === 'real' ? 'real' : (privacy.webglMeta === 'blocked' ? 'blocked' : (privacy.webglMeta === 'custom' ? 'custom' : 'noise')));
  const audioMode = mode('audio', ['real', 'noise', 'muted'], privacy.audio === 'muted' ? 'muted' : 'noise');
  const clientRectsMode = mode('clientRects', ['real', 'noise'], 'noise');
  const webrtcMode = mode('webrtc', ['real', 'proxy', 'disabled'], privacy.webrtc || 'proxy');
  // Numeric shadow of webrtc mode only (not an independent control).
  const webrtcPolicy = webrtcMode === 'disabled' ? 0 : (webrtcMode === 'proxy' ? 3 : 1);
  const mediaDevicesMode = mode('mediaDevices', ['real', 'noise', 'empty'], privacy.mediaDevices === 'real' ? 'real' : (privacy.mediaDevices === 'empty' ? 'empty' : (privacy.media === 'noise' ? 'noise' : (privacy.media === 'blocked' ? 'empty' : 'noise'))));
  const speechChoice = privacy.speech === undefined || privacy.speech === null || privacy.speech === ""
    ? "noise"
    : String(privacy.speech);
  const speechMode = mode("speech", ["real", "noise", "blocked"], speechChoice === "blocked" ? "blocked" : (speechChoice === "real" ? "real" : "noise"));
  const batteryMode = mode('battery', ['real', 'noise', 'blocked'], privacy.battery === 'blocked' ? 'blocked' : (privacy.battery === 'real' ? 'real' : 'noise'));
  // Profiles the product saved carry an explicit choice (its own default is the WebGL derived
  // identity, see the renderer normalisation), but a profile that never went through that step - an
  // older record, an API created one - used to fall through to `real` here. That leaks the machine
  // adapter (vendor / architecture) while WebGL already reports the profile GPU, which is both a
  // hardware leak and a cross API contradiction. An unset value therefore follows the product
  // default; an explicit `real` still means real and is left alone.
  const webgpuChoice = privacy.webgpu === undefined || privacy.webgpu === null || privacy.webgpu === ''
    ? 'webgl'
    : String(privacy.webgpu);
  const webgpuMode = mode('webgpu', ['real', 'blocked', 'webgl'], webgpuChoice === 'blocked' ? 'blocked' : (webgpuChoice === 'webgl' ? 'webgl' : 'real'));
  const bluetoothMode = mode('bluetooth', ['real', 'blocked'], privacy.bluetooth === 'blocked' ? 'blocked' : 'real');
  const stability = resolveStabilityPolicy(privacy, {
    host: fpIn.stabilityHost || privacy.stabilityHost || profile.stabilityHost || '',
    mode: fpIn.stabilityMode || privacy.stabilityMode,
  });

  // --- User-Agent + Client Hints ---
  // Custom profile.userAgent wins; otherwise deterministic seeded UA.
  // clientHints / privacy.fingerprint.clientHints feed UserAgentMetadata.
  const uaOverride = String(fpIn.userAgent || profile.userAgent || '').trim();
  const clientHintsIn = (fpIn.clientHints && typeof fpIn.clientHints === 'object')
    ? fpIn.clientHints
    : (privacy.clientHints && typeof privacy.clientHints === 'object' ? privacy.clientHints
      : (profile.clientHints && typeof profile.clientHints === 'object' ? profile.clientHints : {}));
  const kernelMajor = Number(String(profile.kernelVersion || '').match(/^\d+/)?.[0]) || 0;
  let uaProfile;
  if (uaOverride) {
    const osFromUa = parseOsFromUa(uaOverride);
    // buildUaProfile keys OS_PRESETS with exact lowercase ids; profile records may carry
    // aliases ("iOS", "Mac", "Win11") that would otherwise fall through to the host OS.
    const normalizeOsKey = (value) => {
      const v = String(value || '').toLowerCase().trim();
      if (v === 'win' || v === 'win32' || v === 'win64' || v.startsWith('windows')) return 'windows';
      if (v === 'mac' || v === 'darwin' || v === 'osx') return 'macos';
      if (v === 'macos_arm' || v === 'mac_arm') return 'macos_arm';
      if (v === 'iphone' || v === 'ipad' || v === 'ipod') return 'ios';
      return v;
    };
    uaProfile = buildUaProfile({
      userAgent: uaOverride,
      // profile.os participates so a saved "macos_arm" profile keeps its Apple Silicon
      // identity (preset pins architecture=arm) even when it also pins a custom UA string.
      os: normalizeOsKey(fpIn.os || clientHintsIn.os || profile.os) || osFromUa,
      chromeMajor: Number(fpIn.chromeMajor || clientHintsIn.chromeMajor) || undefined,
      chromeFull: fpIn.ua_full_version || clientHintsIn.ua_full_version || fpIn.fullVersion,
      platform: fpIn.platform,
      architecture: clientHintsIn.architecture || fpIn.architecture,
      platform_version: clientHintsIn.platform_version || fpIn.platformVersion,
      model: clientHintsIn.model,
      mobile: clientHintsIn.mobile,
      wow64: clientHintsIn.wow64,
      bitness: clientHintsIn.bitness,
      ua_full_version: clientHintsIn.ua_full_version || fpIn.ua_full_version,
    });
  } else {
    const desktopRequested = [fpIn.os, clientHintsIn.os, profile.os]
      .map((value) => String(value || "").toLowerCase().trim())
      .map((value) => {
        if (value === "win" || value === "win32" || value === "win64") return "windows";
        if (value === "mac" || value === "darwin" || value === "osx") return "macos";
        if (value === "macos_arm" || value === "mac_arm") return "macos_arm";
        return value;
      })
      .find((value) => value === "windows" || value === "macos" || value === "macos_arm" || value === "linux");
    uaProfile = randomUaForSeed(u32(seed, 44), {
      majors: kernelMajor ? [kernelMajor] : undefined,
      // The UA is the source of truth for every OS-facing fingerprint surface.
      // macos_arm goes through as-is: OS_PRESETS.macos_arm emits the same MacIntel UA token
      // but pins Client Hints architecture=arm, which downstream persona/WebGL pools key on.
      osList: desktopRequested ? [desktopRequested] : ['windows', 'windows', 'macos', 'linux'],
    });
    // Apply explicit clientHints overrides on top of seeded UA
    if (Object.keys(clientHintsIn).length) {
      uaProfile = buildUaProfile({
        userAgent: uaProfile.userAgent,
        os: uaProfile.os,
        chromeMajor: uaProfile.chromeMajor,
        ...clientHintsIn,
        ua_full_version: clientHintsIn.ua_full_version || uaProfile.chromeFull,
      });
    }
  }

  const parsedOsForFp = parseOsFromUa(uaProfile.userAgent);
  const detectedMobileOs = (uaProfile.os === "android" || parsedOsForFp === "android") ? "android" : ((uaProfile.os === "ios" || parsedOsForFp === "ios") ? "ios" : null);
  let uaOs = detectedMobileOs || desktopOs(uaProfile.os) || desktopOs(parsedOsForFp) || "windows";
  // macOS persona pools are split by CPU architecture (W2). The UA metadata decides which
  // side of the split this profile lives on: an arm Client Hint can never ship an Intel/AMD
  // GPU and an x86 hint can never ship an Apple M-series GPU.
  const uaArchitecture = String(uaProfile?.metadata?.architecture || '').toLowerCase();
  if (uaOs === 'macos' && uaArchitecture === 'arm') uaOs = 'macos_arm';
  else if (uaOs === 'macos_arm' && uaArchitecture && uaArchitecture !== 'arm') uaOs = 'macos';
  const personaRequested = String(fpIn.deviceProfile ?? privacy.deviceProfile ?? '').toLowerCase() === 'persona';
  const webglOptions = webglPresetsForOs(uaOs, { legacy: !personaRequested });
  let webglPreset = webglOptions[u32(seed, 8) % webglOptions.length];

  // --- coherent device persona (opt-in) ---------------------------------------------
  // Drawing CPU, memory, colour depth, pixel ratio and GPU from separate pools can produce
  // machines that do not exist (4 cores with 32 GB, a 1x non-Retina Mac), and detectors score
  // the combination rather than each value. A persona bundles axes that co-occur on real
  // hardware. Off by default: switching an existing profile's hardware identity mid-life is
  // itself a risk, so this only applies where it was explicitly requested.
  let devicePersona = null;
  if (personaRequested) {
    devicePersona = pickPersona(uaOs, u32(seed, 36));
    const useGating = fpIn.webglCapabilityGating !== false && privacy.webglCapabilityGating !== false;
    if (useGating && !isPersonaWebglCompatible(devicePersona, process.platform)) {
      devicePersona = resolveCompatiblePersona(devicePersona, process.platform);
    }
    if (!hasCoresOverride) cores = devicePersona.cores;
    if (!hasMemoryOverride) memory = Math.min(8, devicePersona.memory);
    colorDepth = isHdrRequested ? (devicePersona.colorDepth || 30) : 24;
    devicePixelRatio = devicePersona.devicePixelRatio;
    webglPreset = {
      ...webglPreset,
      vendor: devicePersona.webgl.vendor,
      renderer: devicePersona.webgl.renderer,
      gpu: devicePersona.webgl.gpu || webglPreset.gpu,
    };
  }

  // --- mobile device persona ------------------------------------------------
  // A phone is one device, not five independent numbers: the UA model, viewport, pixel ratio,
  // core count and GPU all come out of the same pool record, and only that single record is
  // sampled. The operating system has to be asked for explicitly because a desktop kernel
  // cannot fall into a phone identity by accident.
  const mobileRequested = [fpIn.os, clientHintsIn.os, profile.os, uaProfile.os]
    .map((value) => String(value || '').toLowerCase())
    .find((value) => value === 'android' || value === 'ios');
  let mobileDevice = null;
  if (mobileRequested && supportsRuntimePersona(mobileRequested)) {
    mobileDevice = mobilePersona(u32(seed, 52), mobileRequested, { chromeMajor: kernelMajor || undefined });
    uaOs = mobileDevice.os;
    if (!hasCoresOverride) cores = mobileDevice.cores;
    if (!hasMemoryOverride) memory = mobileDevice.deviceMemory;
    colorDepth = isHdrRequested ? (mobileDevice.colorDepth || 30) : 24;
    devicePixelRatio = mobileDevice.dpr;
    webglPreset = {
      ...webglPreset,
      vendor: mobileDevice.gpu.vendor,
      renderer: mobileDevice.gpu.renderer,
      gpu: mobileDevice.gpu.family ? { vendor: mobileDevice.gpu.family, architecture: '' } : webglPreset.gpu,
    };
    // A pinned UA still wins, but the rest of the phone identity follows the sampled device.
    if (!uaOverride) uaProfile = mobileDevice.uaProfile;
  }
  const inferGpuFromRenderer = (rendererStr) => {
    const s = String(rendererStr || '').toLowerCase();
    if (s.includes('nvidia') || s.includes('geforce') || s.includes('quadro') || s.includes('rtx') || s.includes('gtx')) {
      let arch = 'ampere';
      if (s.includes('40') || s.includes('ada')) arch = 'ada';
      else if (s.includes('30') || s.includes('ampere')) arch = 'ampere';
      else if (s.includes('20') || s.includes('16') || s.includes('turing')) arch = 'turing';
      else if (s.includes('10') || s.includes('pascal')) arch = 'pascal';
      return { vendor: 'nvidia', architecture: arch };
    }
    if (s.includes('intel') || s.includes('arc') || s.includes('iris') || s.includes('uhd') || s.includes('hd graphics')) {
      let arch = 'gen12';
      if (s.includes('arc') || s.includes('alchemist')) arch = 'alchemist';
      else if (s.includes('iris') || s.includes('770') || s.includes('gen12')) arch = 'gen12';
      else if (s.includes('630') || s.includes('620') || s.includes('gen9')) arch = 'gen9';
      return { vendor: 'intel', architecture: arch };
    }
    if (s.includes('amd') || s.includes('radeon')) {
      let arch = 'rdna-2';
      if (s.includes('7900') || s.includes('7800') || s.includes('7700') || s.includes('7600') || s.includes('780m') || s.includes('rdna-3') || s.includes('rdna3')) arch = 'rdna-3';
      else if (s.includes('6900') || s.includes('6800') || s.includes('6700') || s.includes('6600') || s.includes('680m') || s.includes('rdna-2') || s.includes('rdna2')) arch = 'rdna-2';
      else if (s.includes('580') || s.includes('570') || s.includes('590')) arch = 'gcn-4';
      return { vendor: 'amd', architecture: arch };
    }
    if (s.includes('apple') || s.includes('m1') || s.includes('m2') || s.includes('m3')) {
      return { vendor: 'apple', architecture: 'common-3' };
    }
    return null;
  };
  const effectiveRenderer = String(fpIn.webglRenderer || webglPreset.renderer || '');
  const inferredGpu = inferGpuFromRenderer(effectiveRenderer);
  const webglGpu = ((fpIn.webgpu && typeof fpIn.webgpu === 'object') || fpIn.gpuVendor || fpIn.gpuArchitecture)
    ? {
      vendor: String(fpIn.webgpu?.vendor || fpIn.gpuVendor || inferredGpu?.vendor || webglPreset.gpu?.vendor || ''),
      architecture: String(fpIn.webgpu?.architecture || fpIn.gpuArchitecture || inferredGpu?.architecture || webglPreset.gpu?.architecture || ''),
    }
    : (inferredGpu || webglPreset.gpu || null);

  // Prefer already-resolved profile.language (engine sets JP→ja-JP when languageMode=ip)
  let languagePrimary = String(profile.language || 'en-US').trim() || 'en-US';
  try {
    const { resolveProfileLanguage } = require('./locale-from-country');
    languagePrimary = resolveProfileLanguage(profile, {
      countryCode: profile.exitCountryCode,
    }) || languagePrimary;
  } catch (_) {}
  const candidateLangs = (Array.isArray(privacy.languages) && privacy.languages.length)
    ? privacy.languages
    : (Array.isArray(fpIn.languages) && fpIn.languages.length)
      ? fpIn.languages
      : (Array.isArray(profile.languages) && profile.languages.length)
        ? profile.languages
        : null;
  let languages = candidateLangs
    ? candidateLangs.map((s) => String(s || '').trim()).filter(Boolean)
    : String(languagePrimary).split(',').map((s) => s.trim()).filter(Boolean);
  if (!languages.length) languages.push('en-US');
  if (languages.length === 1 && languages[0].includes('-')) {
    const base = languages[0].split('-')[0];
    if (!languages.includes(base)) languages.push(base);
  } else if (languages.length === 1 && languages[0].toLowerCase() === 'en') {
    if (!languages.includes('en-US')) languages.push('en-US');
  }

  // A persona carries its own panel size; without it the reported screen follows the window,
  // which is what makes "screen smaller than the viewport" style inconsistencies show up.
  // Phones report the full display, and their floor is far below the desktop minimum the window
  // sync assumes, so the panel comes from the persona without the desktop clamp.
  const mobileScreen = mobileDevice ? mobileDevice.screen : null;
  const screenWidth = mobileScreen
    ? Math.round(Number(fpIn.screenWidth) || mobileScreen.width)
    : Math.max(640, Math.round(Number(fpIn.screenWidth) || devicePersona?.screen?.width || width));
  const screenHeight = mobileScreen
    ? Math.round(Number(fpIn.screenHeight) || mobileScreen.height)
    : Math.max(480, Math.round(Number(fpIn.screenHeight) || devicePersona?.screen?.height || height));
  const taskbarHeight = mobileScreen
    ? 0
    : Math.max(0, Math.round(Number(fpIn.taskbarHeight) || (uaOs === 'macos' || uaOs === 'macos_arm' ? 25 : 40)));
  const availLeft = Math.round(Number(fpIn.availLeft) || 0);
  const availTop = Math.round(Number(fpIn.availTop) || 0);
  const availWidth = Math.min(screenWidth, Math.max(1, Math.round(Number(fpIn.availWidth) || screenWidth)));
  const availHeight = Math.min(screenHeight, Math.max(1, Math.round(Number(fpIn.availHeight) || (screenHeight - taskbarHeight))));
  const screenX = Math.max(availLeft, Math.round(Number(fpIn.screenX) || availLeft));
  const screenY = Math.max(availTop, Math.round(Number(fpIn.screenY) || availTop));

  const mediaLabelTemplates = (fpIn.mediaLabels && typeof fpIn.mediaLabels === 'object')
    ? fpIn.mediaLabels
    : ((privacy.mediaLabels && typeof privacy.mediaLabels === 'object') ? privacy.mediaLabels : null);
  const mediaDevices = mediaDevicesMode === 'real'
    ? null
    : createMediaDevicesFromSeed(stableIdentity + ':' + seed.toString('hex').slice(0, 12), {
      emptyLabels: mediaDevicesMode === 'empty',
      extra: Array.isArray(fpIn.mediaDevices) ? fpIn.mediaDevices : null,
      labels: mediaLabelTemplates,
      os: uaOs,
    });
  const battery = batteryMode === 'real'
    ? null
    : (batteryMode === 'blocked'
      ? { blocked: true }
      : createBatteryFromSeed(stableIdentity + ':battery:' + seed.toString('hex').slice(0, 8), fpIn.battery || privacy.batterySnapshot || null));
  const speechVoices = createSpeechVoicesFromSeed(
    stableIdentity + ':speech:' + seed.toString('hex').slice(0, 8),
    Array.isArray(fpIn.languages) ? fpIn.languages : languages,
    speechMode,
    // Narrow the table to the claimed OS for every profile, not just persona ones. Mixing
    // families is not a cosmetic difference: a macOS answer containing "Microsoft David - English
    // (United States)" is a combination no real machine can produce, and looking for exactly that
    // is a standard voice-based OS check. Older profiles used to report that mix, which is worth
    // the one-time correction for the same reason navigator.deviceMemory 16 was.
    { os: uaOs }
  );
  const deviceNameMode = mode('deviceNameMode', ['noise', 'custom', 'real'], privacy.deviceNameMode || 'noise');
  const deviceName = createDeviceNameFromSeed(
    stableIdentity + ':device:' + seed.toString('hex').slice(0, 8),
    {
      mode: deviceNameMode,
      custom: fpIn.deviceName || privacy.deviceName || '',
    }
  );
  const webrtcLocalIp = String(
    fpIn.webrtcLocalIp
    || privacy.webrtcLocalIp
    || ''
  ).trim() || createLocalIpFromSeed(stableIdentity + ':webrtc-local:' + seed.toString('hex').slice(0, 8));

  // Dynamic layer: may change with proxy/exit IP without rebuilding static seeds
  const webrtcAddress = String(
    fpIn.webrtcAddress
    || privacy.webrtcAddress
    || profile.exitIp
    || profile.exitIP
    || ''
  ).trim() || null;
  const timezoneDynamic = privacy.timezoneMode === 'real'
    ? null
    : (String(
        (privacy.timezoneMode === 'custom' ? privacy.timezone : '')
        || profile.exitTimezone
        || privacy.timezone
        || ''
      ).trim() || null);
  let geoposition = null;
  if (privacy.geoMode === 'custom' && Number.isFinite(Number(privacy.latitude)) && Number.isFinite(Number(privacy.longitude))) {
    geoposition = {
      latitude: Number(privacy.latitude),
      longitude: Number(privacy.longitude),
      accuracy: Number(privacy.accuracy) || 100,
    };
  } else if (privacy.geoMode !== 'disabled' && privacy.geoMode !== 'prompt') {
    const lat = Number(profile.exitLatitude);
    const lon = Number(profile.exitLongitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      geoposition = { latitude: lat, longitude: lon, accuracy: Number(privacy.accuracy) || 1000 };
    }
  }

  let webglRenderer = (webglMetaMode === 'real')
    ? null
    : (webglMetaMode === 'blocked' ? '' : (fpIn.webglRenderer || webglPreset.renderer));
  const rLow = String(webglRenderer || '').toLowerCase();
  let resolvedVendor = fpIn.webglVendor || webglPreset.vendor;
  if (!fpIn.webglVendor && mobileDevice) {
    // Adreno / Mali / PowerVR renderers carry no desktop keyword, so the pool vendor is the only
    // truthful answer here.
    resolvedVendor = mobileDevice.gpu.vendor;
  } else if (!fpIn.webglVendor && webglRenderer) {
    if (rLow.includes('nvidia') || rLow.includes('geforce')) resolvedVendor = 'Google Inc. (NVIDIA)';
    else if (rLow.includes('intel') || rLow.includes('arc') || rLow.includes('iris') || rLow.includes('uhd')) resolvedVendor = 'Google Inc. (Intel)';
    else if (rLow.includes('amd') || rLow.includes('radeon')) resolvedVendor = 'Google Inc. (AMD)';
    else if (rLow.includes('apple')) resolvedVendor = (uaOs === 'ios' || detectedMobileOs === 'ios') ? 'Apple Inc.' : 'Google Inc. (Apple)';
  }
  let webglVendor = (webglMetaMode === 'real')
    ? null
    : (webglMetaMode === 'blocked' ? '' : resolvedVendor);

  // Enforce cross-platform GPU consistency: prevent contradictory combinations
  // Only apply auto-correction when the caller did NOT supply an explicit webglRenderer override.
  const hasManualWebglOverride = Boolean(fpIn.webglRenderer);
  if (!hasManualWebglOverride && uaOs === 'windows') {
    if (webglRenderer && /metal|apple/i.test(webglRenderer)) {
      const winPresets = WEBGL_PRESETS.windows;
      const picked = winPresets[u32(seed, 8) % winPresets.length];
      webglRenderer = picked.renderer;
      webglVendor = picked.vendor;
      if (webglGpu) { webglGpu.vendor = picked.gpu.vendor; webglGpu.architecture = picked.gpu.architecture; }
    }
    if (webglVendor && /apple/i.test(webglVendor)) {
      webglVendor = 'Google Inc. (Intel)';
    }
  } else if (!hasManualWebglOverride && (uaOs === 'android' || detectedMobileOs === 'android')) {
    if (webglRenderer && /direct3d|d3d11|metal|nvidia|geforce|radeon|intel|iris|uhd|apple/i.test(webglRenderer)) {
      const andrPresets = WEBGL_PRESETS.android;
      const picked = andrPresets[u32(seed, 8) % andrPresets.length];
      webglRenderer = picked.renderer;
      webglVendor = picked.vendor;
      if (webglGpu) { webglGpu.vendor = picked.gpu.vendor; webglGpu.architecture = picked.gpu.architecture; }
    }
  } else if (!hasManualWebglOverride && (uaOs === 'ios' || detectedMobileOs === 'ios')) {
    if (webglRenderer && /direct3d|d3d11|nvidia|geforce|radeon|intel|adreno|mali|powervr/i.test(webglRenderer)) {
      webglVendor = 'Apple Inc.';
      webglRenderer = 'Apple GPU';
      if (webglGpu) { webglGpu.vendor = 'apple'; webglGpu.architecture = 'common-3'; }
    }
  }

  if (webglGpu && webglMetaMode !== 'real') {
    const vLow = String(webglVendor || '').toLowerCase();
    const curRLow = String(webglRenderer || '').toLowerCase();
    if (curRLow.includes('nvidia') || vLow.includes('nvidia')) {
      webglGpu.vendor = 'nvidia';
      if (!webglGpu.architecture) webglGpu.architecture = 'ampere';
    } else if (curRLow.includes('intel') || vLow.includes('intel')) {
      webglGpu.vendor = 'intel';
      if (!webglGpu.architecture) webglGpu.architecture = 'gen12';
    } else if (curRLow.includes('amd') || curRLow.includes('radeon') || vLow.includes('amd') || vLow.includes('radeon')) {
      webglGpu.vendor = 'amd';
      if (!webglGpu.architecture) webglGpu.architecture = 'rdna-2';
    } else if (curRLow.includes('apple') || vLow.includes('apple')) {
      webglGpu.vendor = 'apple';
      if (!webglGpu.architecture) webglGpu.architecture = 'common-3';
    }
  }
  const webglReconcileHost = fpIn.reconcileHost ?? fpIn.webglReconcileHost ?? privacy.webglReconcileHost ?? (process.platform === 'darwin');
  const webgl = {
    mode: webglMode,
    metaMode: webglMetaMode,
    vendor: webglVendor,
    renderer: webglRenderer,
    mark: Number.isFinite(Number(fpIn.webglId)) ? Number(fpIn.webglId) : webglId,
    gpu: webglMetaMode === 'real' ? null : webglGpu,
    reconcileHost: Boolean(webglReconcileHost),
    stability,
  };
  webgl.limits = webglMetaMode === 'real' ? null : webglParameterOverrides(webgl.gpu, {
    reconcileHost: webgl.reconcileHost,
    hostPlatform: process.platform,
  });
  webgl.fpPayload = buildWebglFpPayload(webgl);

  const fingerprint = {
    seed: seed.toString('hex').slice(0, 16),
    profileId: profile.id,
    os: uaOs,
    timezone: timezoneDynamic,
    platform: fpIn.platform || uaProfile.platform || OS_PRESETS[uaOs].platformNav,
    userAgent: uaProfile.userAgent,
    uaProfile,
    clientHints: uaProfile.clientHints,
    userAgentMetadata: uaProfile.metadata,
    languages: Array.isArray(fpIn.languages) ? fpIn.languages : languages,
    hardwareConcurrency: useRealCores ? null : (Number(fpIn.hardwareConcurrency) > 0 ? Number(fpIn.hardwareConcurrency) : cores),
    deviceMemory: useRealMemory ? null : (Number(fpIn.deviceMemory) > 0 ? Number(fpIn.deviceMemory) : memory),
    screen: {
      width: screenWidth,
      height: screenHeight,
      availWidth,
      availHeight,
      availLeft,
      availTop,
      screenX,
      screenY,
      colorDepth: isHdrRequested ? (Number(fpIn.colorDepth) || colorDepth || 30) : 24,
      pixelDepth: isHdrRequested ? (Number(fpIn.colorDepth) || colorDepth || 30) : 24,
      devicePixelRatio: Number(fpIn.devicePixelRatio) || devicePixelRatio,
    },
    webgl,
    canvas: {
      mode: canvasMode,
      mark: Number.isFinite(Number(fpIn.canvasId)) ? Number(fpIn.canvasId) : canvasId,
      stability,
    },
    audio: {
      mode: audioMode,
      mark: Number.isFinite(Number(fpIn.audioId)) ? Number(fpIn.audioId) : audioId,
    },
    clientRects: {
      mode: clientRectsMode,
      mark: Number.isFinite(Number(fpIn.clientRectsId)) ? Number(fpIn.clientRectsId) : clientRectsId,
    },
    webrtc: webrtcMode,
    webrtcPolicy,
    webrtcAddress,
    webrtcLocalIp,
    deviceName,
    deviceNameMode,
    battery: {
      mode: batteryMode,
      value: battery,
    },
    webgpu: {
      mode: webgpuMode,
      gpu: webglGpu,
    },
    bluetooth: {
      mode: bluetoothMode,
    },
    mediaDevices: {
      mode: mediaDevicesMode,
      devices: mediaDevices,
      labels: mediaLabelTemplates,
    },
    stability,
    speech: {
      mode: speechMode,
      voices: speechVoices,
    },
    // Font probing is a top-tier OS signal, and on a stock Chromium kernel the host's real
    // font list answers it. A persona carries the set its claimed platform ships, plus the
    // families exclusive to the other platforms so probes for those can be answered honestly
    // as absent. When claimed OS differs from host OS (e.g. Windows persona on macOS host),
    // enable font isolation even without explicit deviceProfile: 'persona'.
    fonts: (() => {
      const hostPlatformNorm = process.platform === "darwin" ? "macos" : (process.platform === "win32" ? "windows" : (process.platform === "linux" ? "linux" : process.platform));
      const foreignFonts = exclusiveFontsForOtherOs(uaOs);
      const shouldEnableFonts = Boolean(devicePersona || mobileDevice || (uaOs !== hostPlatformNorm));
      return (shouldEnableFonts && Array.isArray(foreignFonts) && foreignFonts.length > 0)
        ? {
          os: uaOs,
          list: fontsForOs(uaOs) || [],
          foreign: foreignFonts,
        }
        : null;
    })(),
    maxTouchPoints: mobileDevice
      ? mobileDevice.maxTouchPoints
      : (Number(fpIn.maxTouchPoints) >= 0 ? Number(fpIn.maxTouchPoints) : 0),
    mobile: Boolean(mobileDevice),
    touch: Boolean(mobileDevice),
    mobileDevice: mobileDevice
      ? {
        name: mobileDevice.name,
        model: mobileDevice.model,
        os: mobileDevice.os,
        osVersion: mobileDevice.osVersion,
        cores: mobileDevice.cores,
        viewport: { ...mobileDevice.viewport },
        screen: { ...mobileDevice.screen },
        panel: { ...mobileDevice.panel },
        dpr: mobileDevice.dpr,
        gpu: { vendor: mobileDevice.gpu.vendor, renderer: mobileDevice.gpu.renderer, family: mobileDevice.gpu.family },
      }
      : null,
    vendor: fpIn.vendor || ((mobileDevice?.os === 'ios' || uaOs === 'ios' || (fpIn.platform && /iphone|ipad|ipod/i.test(fpIn.platform))) ? 'Apple Computer, Inc.' : (mobileDevice?.vendor || uaProfile?.vendor || 'Google Inc.')),
    acceptLanguage: buildAcceptLanguageHeader(languages),
    doNotTrack: privacy.dnt ? '1' : null,
    // Static noise identity vs dynamic exit-IP layer
    staticConfig: {
      hardwareConcurrency: useRealCores ? null : (Number(fpIn.hardwareConcurrency) > 0 ? Number(fpIn.hardwareConcurrency) : cores),
      deviceMemory: useRealMemory ? null : (Number(fpIn.deviceMemory) > 0 ? Number(fpIn.deviceMemory) : memory),
      platform: fpIn.platform || uaProfile.platform || OS_PRESETS[uaOs].platformNav,
      langs: Array.isArray(fpIn.languages) ? fpIn.languages : languages,
      canvasMark: Number.isFinite(Number(fpIn.canvasId)) ? Number(fpIn.canvasId) : canvasId,
      webglMark: Number.isFinite(Number(fpIn.webglId)) ? Number(fpIn.webglId) : webglId,
      audioFp: Number.isFinite(Number(fpIn.audioId)) ? Number(fpIn.audioId) : audioId,
      clientRectFp: Number.isFinite(Number(fpIn.clientRectsId)) ? Number(fpIn.clientRectsId) : clientRectsId,
      maxTouchPoints: mobileDevice
        ? mobileDevice.maxTouchPoints
        : (Number(fpIn.maxTouchPoints) >= 0 ? Number(fpIn.maxTouchPoints) : 0),
      mediaDevices,
      mediaLabels: mediaLabelTemplates,
      battery,
      webrtcPolicy,
      webrtcLocalIp,
      deviceName,
      stability,
      userAgentMetadata: uaProfile.metadata,
      webglFp: webgl.fpPayload,
    },
    dynamicConfig: {
      timezone: timezoneDynamic,
      geoposition,
      geopositionText: formatGeopositionValue(geoposition),
      webrtcAddress,
      webrtcLocalIp,
      webrtc: webrtcMode,
    },
    // deterministic random for scripts
    _r0: rnd(),
  };

  const lazyFontPayload = fpIn.lazyFontPayload !== false && privacy.lazyFontPayload !== false;
  const fontBridgePlatform = (() => {
    const p = String(uaOs || fpIn.os || fpIn.platform || '').trim().toLowerCase();
    if (p.includes('win')) return 'windows';
    if (p.includes('mac') || p.includes('darwin')) return 'macos';
    if (p.includes('android')) return 'android';
    if (p.includes('linux')) return 'linux';
    if (p.includes('ios') || p.includes('iphone') || p.includes('ipad')) return 'macos';
    return 'windows';
  })();
  const fontBridgeToken = deriveBridgeToken(fingerprint);
  const fontBridgeChannel = '_' + String(fontBridgeToken).slice(0, 16);

  fingerprint.fontBlobBridge = lazyFontPayload ? {
    channelName: fontBridgeChannel,
    token: String(fontBridgeToken),
    platform: fontBridgePlatform,
    wanted: null,
  } : null;

  fingerprint.consistency = fingerprintConsistencyIssues(fingerprint);
  return fingerprint;
}

/**
 * Report contradictions that make a configured desktop environment implausible.
 * Overrides remain supported; callers can surface these warnings before launch.
 */
function fingerprintConsistencyIssues(fp) {
  const issues = [];
  const parsedOs = parseOsFromUa(fp?.userAgent);
  const mobileOs = (parsedOs === 'android' || parsedOs === 'ios') ? parsedOs : null;
  const uaOs = mobileOs
    ? mobileOs
    : (desktopOs(fp?.uaProfile?.os) || desktopOs(parsedOs) || 'windows');
  const expectedPlatform = mobileOs
    ? (mobileOs === 'ios' ? 'iPhone' : 'Linux armv8l')
    : (OS_PRESETS[uaOs]?.platformNav || OS_PRESETS.windows.platformNav);
  const expectedChPlatform = mobileOs === 'android' ? 'Android' : (mobileOs === 'ios' ? 'iOS' : expectedClientHintPlatform(uaOs));
  const renderer = String(fp?.webgl?.renderer || '');
  const vendor = String(fp?.webgl?.vendor || '');

  const add = (code, message, severity = 'warning') => issues.push({ code, severity, message });
  if (fp?.platform !== expectedPlatform) {
    add('platform-ua-mismatch', `navigator.platform (${fp?.platform || 'empty'}) does not match the ${uaOs} user agent.`);
  }
  if (fp?.userAgentMetadata?.platform !== expectedChPlatform) {
    add('client-hints-ua-mismatch', `Client Hints platform (${fp?.userAgentMetadata?.platform || 'empty'}) does not match the ${uaOs} user agent.`);
  }
  if (uaOs === 'windows' && /Apple M[0-9]|OpenGL 4\.1|Mesa|RADV/i.test(renderer)) {
    add('webgl-ua-mismatch', 'WebGL renderer does not look like a Windows renderer.');
  }
  if ((uaOs === 'macos' || uaOs === 'macos_arm') && (/Direct3D|D3D11|Mesa|RADV/i.test(renderer) || !/Apple|Intel|AMD/i.test(vendor + renderer))) {
    add('webgl-ua-mismatch', 'WebGL renderer does not look like a macOS renderer.');
  }
  if (uaOs === 'linux' && (/Direct3D|D3D11|Apple M[0-9]/i.test(renderer) || !/Mesa|RADV|OpenGL/i.test(renderer))) {
    add('webgl-ua-mismatch', 'WebGL renderer does not look like a Linux renderer.');
  }
  if (mobileOs && /Direct3D|D3D11|Apple M[0-9]|Mesa|RADV/i.test(renderer)) {
    add('webgl-ua-mismatch', 'WebGL renderer does not look like a mobile GPU.');
  }
  if (fp?.mobile && !(Number(fp?.maxTouchPoints) > 0)) {
    add('mobile-touch-missing', 'A mobile profile must expose touch points.', 'error');
  }
  if (fp?.mobile && fp?.mobileDevice && Number(fp.mobileDevice.screen?.width) !== Number(fp?.screen?.width)) {
    add('mobile-screen-mismatch', 'The reported screen must be the panel of the sampled device.');
  }
  const screen = fp?.screen || {};
  if (!(Number(screen.width) > 0 && Number(screen.height) > 0 && Number(screen.availWidth) > 0 && Number(screen.availHeight) > 0)) {
    add('screen-invalid', 'Screen dimensions must be positive.', 'error');
  } else if (Number(screen.availWidth) > Number(screen.width) || Number(screen.availHeight) > Number(screen.height)) {
    add('screen-available-invalid', 'Available screen dimensions cannot exceed total screen dimensions.', 'error');
  }
  if (Number(screen.availLeft) + Number(screen.availWidth) > Number(screen.width)
      || Number(screen.availTop) + Number(screen.availHeight) > Number(screen.height)) {
    add('screen-origin-invalid', 'Available screen origin and dimensions must remain inside the screen.', 'error');
  }
  if (Number(screen.screenX) < Number(screen.availLeft) || Number(screen.screenY) < Number(screen.availTop)) {
    add('window-origin-invalid', 'Window origin must not precede the available screen origin.', 'error');
  }
  if (!(Number(screen.devicePixelRatio) > 0 && Number(screen.devicePixelRatio) <= 4)) {
    add('device-pixel-ratio-invalid', 'devicePixelRatio must be within the supported desktop range.', 'error');
  }
  if (fp?.hardwareConcurrency != null && !(Number(fp.hardwareConcurrency) >= 1 && Number(fp.hardwareConcurrency) <= 64)) {
    add('cores-invalid', 'hardwareConcurrency must be between 1 and 64 when overridden.', 'error');
  }
  if (fp?.deviceMemory != null && !(Number(fp.deviceMemory) >= 1 && Number(fp.deviceMemory) <= 8)) {
    add('memory-invalid', 'deviceMemory must be between 1 and 8 when overridden.', 'error');
  }
  // WebGL and WebGPU read the same physical adapter, so a page that finds a disguised WebGL
  // renderer next to an untouched WebGPU adapter has two GPUs on one machine - a contradiction no
  // real desktop produces. Leaving WebGPU "real" is a legitimate user choice, so this is reported
  // rather than enforced: the point is that the trade-off is visible instead of silent.
  const webglGpu = fp?.webgl?.gpu || null;
  const webglDisguised = Boolean(webglGpu && (webglGpu.vendor || webglGpu.architecture)
    && String(fp?.webgl?.mode || 'noise') !== 'real');
  if (webglDisguised && String(fp?.webgpu?.mode || '') === 'real') {
    add('webgpu-real-vs-webgl-disguised',
      'WebGL reports a profile GPU while WebGPU is left on the host adapter; the two APIs will disagree.',
      'warning');
  }
  // The driver limits are derived from the same GPU the renderer string names, so the class the
  // limits table knows about has to be the class the renderer claims. Mobile GPU families have no
  // table entry yet, which is why this is a warning - those profiles keep the host limits, and
  // surfacing that is the difference between a known gap and a silent one.
    const hostLimits = getHostWebglLimits(process.platform);
  if (webglGpu && hostLimits) {
    const rawLimits = webglParameterOverrides(webglGpu, { reconcileHost: false });
    if (rawLimits && rawLimits[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE] > hostLimits.maxTextureSize) {
      add('webgl-limits-reconciled-with-host',
        `GPU persona requires texture size ${rawLimits[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE]} which exceeds host execution capacity (${hostLimits.maxTextureSize}); reconciled to host capacity to maintain texImage2D validity.`,
        'info');
    }
  }
  if (webglGpu && (webglGpu.vendor || webglGpu.architecture) && !webglParameterOverrides(webglGpu)) {
    add('webgl-limits-unknown-gpu',
      `No driver limit table entry for ${String(webglGpu.vendor || 'unknown')}/${String(webglGpu.architecture || 'unknown')}.`,
      'warning');
  }
  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}

/**
 * Document-start injection implementing noise/block modes.
 */
function buildInjectionScript(fp) {
  const bridgeToken = deriveBridgeToken(fp);
  const stability = fp.stability || fp.canvas?.stability || resolveStabilityPolicy({}, {});
  const json = JSON.stringify({
    platform: fp.platform,
    os: fp.uaProfile?.os || (fp.mobile ? 'android' : 'windows'),
    userAgent: fp.userAgent,
    languages: fp.languages,
    timezone: fp.timezone || fp.dynamicConfig?.timezone || null,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: Math.min(8, Math.max(1, Number(fp.deviceMemory) || 8)),
    screen: fp.screen,
    os: fp.uaProfile?.os || (fp.mobile ? 'android' : 'windows'),
    webgl: {
      mode: fp.webgl?.mode,
      metaMode: fp.webgl?.metaMode || 'noise',
      vendor: fp.webgl?.vendor,
      renderer: fp.webgl?.renderer,
      mark: fp.webgl?.mark,
      gpu: fp.webgl?.gpu || null,
      limits: fp.webgl?.limits || webglParameterOverrides(fp.webgl?.gpu, { reconcileHost: fp.webgl?.reconcileHost !== false, hostPlatform: process.platform }),
    },
    canvas: fp.canvas,
    audio: fp.audio,
    clientRects: fp.clientRects,
    webrtc: fp.webrtc,
    webrtcPolicy: fp.webrtcPolicy,
    webrtcAddress: fp.webrtcAddress || null,
    battery: fp.battery || null,
    webgpu: fp.webgpu || null,
    bluetooth: fp.bluetooth || null,
    mediaDevices: fp.mediaDevices || null,
    speech: fp.speech || null,
    fonts: fp.fonts || null,
    maxTouchPoints: fp.maxTouchPoints,
    mobile: Boolean(fp.mobile),
    mobileDevice: fp.mobileDevice || null,
    // The injected navigator.patches read this; without it the page reported empty brands / model.
    userAgentMetadata: fp.userAgentMetadata || fp.uaProfile?.metadata || null,
    vendor: fp.vendor || ((fp.mobileDevice?.os === 'ios' || fp.uaProfile?.os === 'ios' || (fp.platform && /iphone|ipad|ipod/i.test(fp.platform))) ? 'Apple Computer, Inc.' : (fp.uaProfile?.vendor || 'Google Inc.')),
    doNotTrack: fp.doNotTrack,
    seed: fp.seed,
    stability: {
      mode: stability.mode,
      active: Boolean(stability.active),
      noiseAmplitude: Number(stability.noiseAmplitude) || 3,
      sampleStepDivisor: Number(stability.sampleStepDivisor) || 64,
      hamming: Number(stability.hamming) || 12,
      maxWidth: Number(stability.maxWidth) || 600,
      maxHeight: Number(stability.maxHeight) || 600,
      square: Number(stability.square) || 8,
      hosts: Array.isArray(stability.hosts) ? stability.hosts.slice(0, 800) : [],
      skipHosts: Array.isArray(stability.skipHosts) ? stability.skipHosts.slice(0, 200) : [],
    },
  });

  // UA + Client Hints (userAgentData) injected first
  const uaScript = fp.uaProfile
    ? buildUaInjectionScript(fp.uaProfile)
    : (fp.userAgent ? buildUaInjectionScript(buildUaProfile({ userAgent: fp.userAgent, platform: fp.platform })) : '');

  const mainScript = `${uaScript}
(() => {
  try {
  const CFG = ${json};
  // Phone identity flag, shared by the window metrics and the navigator patch below.
  const MOBILE = Boolean(CFG.mobile);

  const seedNum = parseInt(String(CFG.seed || '1').slice(0, 8), 16) || 1;
  const noise = (n) => {
    let x = Math.sin((n + 1) * seedNum) * 10000;
    return x - Math.floor(x);
  };
  const normalizeHost = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\\/\\//, '')
    .replace(/\\/.*$/, '')
    .replace(/:\\d+$/, '')
    .replace(/^\\*\\./, '');
  const hostMatches = (host, pattern) => {
    const h = normalizeHost(host);
    const p = normalizeHost(pattern);
    if (!h || !p) return false;
    if (h === p) return true;
    return h.endsWith('.' + p);
  };
  const listHasHost = (list, host) => Array.isArray(list) && list.some((item) => hostMatches(host, item));
  const currentHost = () => {
    try { return normalizeHost(location && location.hostname); } catch (_) { return ''; }
  };
  // stability 策略动态判定：
  // - active === true (稳定性生效): noiseAmplitude = 1 -> delta 恒为 0 (零噪声，最大一致性)
  // - active === false (常规噪声或 skipHosts 例外): noiseAmplitude = 3 -> delta ∈ {-1, 0, 1}
  // - skipHosts 是保留常规噪声的例外表，不可短路返回原生真实数据
  const stabilityActiveNow = () => {
    const st = CFG.stability || {};
    if (st.mode === 'force') {
      return !listHasHost(st.skipHosts, currentHost());
    }
    if (st.mode === 'off') return false;
    const host = currentHost();
    if (!host) return Boolean(st.active);
    if (listHasHost(st.skipHosts, host)) return false;
    if (listHasHost(st.hosts, host)) return true;
    return Boolean(st.active);
  };
  const noiseAmplitudeNow = () => stabilityActiveNow() ? (Number(CFG.stability?.noiseAmplitude) || 1) : 3;
  const sampleStepDivisorNow = () => stabilityActiveNow() ? (Number(CFG.stability?.sampleStepDivisor) || 128) : 64;
  const canvasNoiseLocks = new Map();
  const applyCanvasNoise = (imageData, mark) => {
    try {
      if (!imageData || !imageData.data) return imageData;
      const data = imageData.data;
      if (!(data instanceof Uint8ClampedArray) && !(data instanceof Uint8Array)) return imageData;
      const amp = noiseAmplitudeNow();
      const maxW = Number(CFG.stability?.maxWidth) || 600;
      const maxH = Number(CFG.stability?.maxHeight) || 600;
      const width = imageData.width || 0;
      const height = imageData.height || 0;
      const limitW = width > 0 ? Math.min(width, maxW) : width;
      const limitH = height > 0 ? Math.min(height, maxH) : height;
      const square = Math.max(2, Number(CFG.stability?.square) || 8);
      const stable = stabilityActiveNow();
      // On high-risk hosts, lock first-read deltas so repeated samples stay within hamming threshold.
      if (stable) {
        const key = width + 'x' + height + ':' + mark + ':' + square + ':' + amp;
        let locked = canvasNoiseLocks.get(key);
        if (!locked) {
          locked = [];
          for (let y = 0; y < (limitH || height); y += square) {
            for (let x = 0; x < (limitW || width); x += square) {
              const px = ((y * width) + x) * 4;
              if (px + 3 >= data.length) continue;
              if (data[px + 3] === 0) continue;
              const delta = Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2);
              locked.push({ px: px, delta: delta });
            }
          }
          canvasNoiseLocks.set(key, locked);
        }
        for (let i = 0; i < locked.length; i += 1) {
          const item = locked[i];
          if (item.px + 3 >= data.length) continue;
          if (data[item.px + 3] === 0) continue;
          data[item.px] = Math.max(0, Math.min(255, data[item.px] + item.delta));
        }
        return imageData;
      }
      for (let y = 0; y < (limitH || height); y += square) {
        for (let x = 0; x < (limitW || width); x += square) {
          const px = ((y * width) + x) * 4;
          if (px + 3 >= data.length) continue;
          if (data[px + 3] === 0) continue;
          const n = Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2);
          data[px] = Math.max(0, Math.min(255, data[px] + n));
        }
      }
    } catch (_) {}
    return imageData;
  };
  const originalToString = Function.prototype.toString;
  const BRIDGE_TOKEN = ${JSON.stringify(bridgeToken)};
  const nativeSource = new WeakMap();
  const subWindowSyncHooks = [];
  // Assigned by the font-shield block below when a profile declares foreign families. The
  // clientRects patch wraps its measurement in this scope so both layers live in ONE bridge
  // wrapper: two independent nativeLike wrappers would make replaceMethod treat the second
  // one as an existing bridge and silently skip it.
  let sanitizeElementFontScope = (element, callback) => callback();
  const inspectBridge = (fn) => {
    try {
      if (typeof fn !== 'function') return null;
      // A same-origin iframe has its own Function.prototype and its own private WeakMap.
      // Calling fn.toString first enters that Realm's bridge; the current Realm is only a fallback.
      const ownToString = fn.toString;
      if (typeof ownToString === 'function') {
        const result = ownToString.call(fn, BRIDGE_TOKEN);
        if (result && typeof result === 'object' && result.bridge === true) return result;
      }
      const fallback = Function.prototype.toString.call(fn, BRIDGE_TOKEN);
      return fallback && typeof fallback === 'object' && fallback.bridge === true ? fallback : null;
    } catch (_) { return null; }
  };
  // The token is derived from the exact fingerprint configuration. Same-source document-start and
  // Runtime.evaluate passes return here before they can add a second noise layer; a changed
  // configuration has a different token and continues without writing a public marker.
  const bridgeCheck = inspectBridge(Function.prototype.toString); if (bridgeCheck && bridgeCheck.token === BRIDGE_TOKEN) return;
  const cleanStack = (err, fnName) => {
    try {
      if (err && typeof err.stack === 'string') {
        const lines = err.stack.split(String.fromCharCode(10));
        const header = lines[0];
        const filtered = lines.slice(1).filter((l) => {
          if (fnName && l.includes(fnName)) return false;
          if (l.includes('<anonymous>') && (l.includes('getImageData') || l.includes('replaceMethod') || l.includes('nativeLike') || l.includes('safeWrapper'))) return false;
          return true;
        });
        err.stack = [header, ...filtered].join(String.fromCharCode(10));
      }
    } catch (_) {}
    return err;
  };
  const nativeLike = (wrapper, original, nameOverride, lengthOverride, isConstructor = false) => {
    if (typeof wrapper !== "function") return wrapper;
    const fnName = nameOverride !== undefined ? nameOverride : (original ? original.name : (wrapper.name || ""));
    const fnLength = lengthOverride !== undefined ? lengthOverride : (original ? original.length : wrapper.length);
    let clean;
    if (isConstructor) {
      clean = wrapper;
      try { Object.defineProperty(clean, "name", { configurable: true, value: fnName }); } catch (_) {}
      try { Object.defineProperty(clean, "length", { configurable: true, value: fnLength }); } catch (_) {}
    } else {
      const holder = {
        [fnName](...args) {
          try {
            return wrapper.apply(this, args);
          } catch (err) {
            throw cleanStack(err, fnName);
          }
        }
      };
      clean = holder[fnName];
      try { Object.defineProperty(clean, "length", { configurable: true, value: fnLength }); } catch (_) {}
    }
    let nativeStr;
    if (typeof original === "function") {
      const origStr = nativeSource.get(original) || originalToString.call(original);
      nativeStr = (origStr && origStr.includes("[native code]"))
        ? origStr
        : ("function " + fnName + "() { [native code] }");
    } else {
      nativeStr = "function " + fnName + "() { [native code] }";
    }
    try { nativeSource.set(clean, nativeStr); } catch (_) {}
    try { nativeSource.set(wrapper, nativeStr); } catch (_) {}
    return clean;
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
      if (lines.length > 1 && lines[1] && ((frameName && lines[1].indexOf(frameName) !== -1) || (baseName && lines[1].indexOf(baseName) !== -1))) {
        lines.splice(1, 1);
        try { err.stack = lines.join(nl); } catch (_) {}
      }
    }
    return err;
  };
  const getRealmTypeError = (receiver) => {
    try {
      if (receiver) {
        if (receiver.ownerDocument && receiver.ownerDocument.defaultView && receiver.ownerDocument.defaultView.TypeError) {
          return receiver.ownerDocument.defaultView.TypeError;
        }
        const ctor = receiver.constructor;
        if (ctor) {
          if (ctor.ownerDocument && ctor.ownerDocument.defaultView && ctor.ownerDocument.defaultView.TypeError) {
            return ctor.ownerDocument.defaultView.TypeError;
          }
          if (typeof ctor.constructor === "function") {
            const globalObj = ctor.constructor("return this")();
            if (globalObj && globalObj.TypeError) return globalObj.TypeError;
          }
        }
      }
    } catch (_) {}
    return (typeof TypeError !== "undefined" ? TypeError : Error);
  };
  const makeNativeGetter = (key, getValue, targetType, realmWin) => {
    let getter;
    const holder = {
      get [key]() {
        if (targetType === "navigator") {
          const isProto = (typeof Navigator !== "undefined" && this === Navigator.prototype) ||
            (this && this.constructor && this.constructor.prototype === this) ||
            (this && Object.getPrototypeOf(this) === Object.prototype);
          const isNav = Boolean(
            this &&
            !isProto &&
            (typeof Navigator === "undefined" || this !== Navigator.prototype) &&
            (
              this === (typeof navigator !== "undefined" ? navigator : null) ||
              (typeof Navigator !== "undefined" && (this instanceof Navigator || Navigator.prototype.isPrototypeOf(this))) ||
              (this.constructor && this.constructor.name === "Navigator" && this !== this.constructor.prototype)
            )
          );
          if (!isNav) {
            const RealmTypeError = (realmWin && realmWin.TypeError) || getRealmTypeError(this);
            const err = new RealmTypeError("Illegal invocation");
            stripStackFrame(err, getter, "get " + key);
            throw err;
          }
        } else if (targetType === "screen") {
          const isProto = (typeof Screen !== "undefined" && this === Screen.prototype) ||
            (this && this.constructor && this.constructor.prototype === this) ||
            (this && Object.getPrototypeOf(this) === Object.prototype);
          const isScr = Boolean(
            this &&
            !isProto &&
            (typeof Screen === "undefined" || this !== Screen.prototype) &&
            (
              this === (typeof screen !== "undefined" ? screen : null) ||
              (typeof Screen !== "undefined" && (this instanceof Screen || Screen.prototype.isPrototypeOf(this))) ||
              (this.constructor && this.constructor.name === "Screen" && this !== this.constructor.prototype)
            )
          );
          if (!isScr) {
            const RealmTypeError = (realmWin && realmWin.TypeError) || getRealmTypeError(this);
            const err = new RealmTypeError("Illegal invocation");
            stripStackFrame(err, getter, "get " + key);
            throw err;
          }
        }
        try {
          return getValue.call(this);
        } catch (err) {
          stripStackFrame(err, getter, "get " + key);
          throw err;
        }
      }
    };
    getter = Object.getOwnPropertyDescriptor(holder, key).get;
    try { Object.defineProperty(getter, "name", { configurable: true, value: "get " + key }); } catch (_) {}
    try { Object.defineProperty(getter, "length", { configurable: true, value: 0 }); } catch (_) {}
    nativeSource.set(getter, "function get " + key + "() { [native code] }");
    return getter;
  };
  const nativeGetter = (key, fn) => {
    if (typeof fn !== "function") return fn;
    try { Object.defineProperty(fn, "name", { configurable: true, value: "get " + key }); } catch (_) {}
    try { Object.defineProperty(fn, "length", { configurable: true, value: 0 }); } catch (_) {}
    try { nativeSource.set(fn, "function get " + key + "() { [native code] }"); } catch (_) {}
    return fn;
  };
  const nativeSetter = (key, fn) => {
    if (typeof fn !== "function") return fn;
    try { Object.defineProperty(fn, "name", { configurable: true, value: "set " + key }); } catch (_) {}
    try { Object.defineProperty(fn, "length", { configurable: true, value: 1 }); } catch (_) {}
    try { nativeSource.set(fn, "function set " + key + "() { [native code] }"); } catch (_) {}
    return fn;
  };
  const nativeAccessor = (key, desc) => {
    if (desc && typeof desc.get === "function") nativeGetter(key, desc.get);
    if (desc && typeof desc.set === "function") {
      try { Object.defineProperty(desc.set, "name", { configurable: true, value: "set " + key }); } catch (_) {}
      try { nativeSource.set(desc.set, "function set " + key + "() { [native code] }"); } catch (_) {}
    }
    return desc;
  };
  try {
    let patchedToString;
    const holder = {
      toString(...args) {
        const secret = args[0];
        if (secret === BRIDGE_TOKEN) {
          if (args[1] === "register" && typeof args[2] === "function" && typeof args[3] === "string") {
            nativeSource.set(args[2], args[3]);
            return true;
          }
          if (nativeSource.has(this)) return { bridge: true, token: BRIDGE_TOKEN, nativeText: nativeSource.get(this) };
          try {
            const inherited = originalToString.call(this, secret);
            if (inherited && typeof inherited === 'object' && inherited.bridge === true) return inherited;
          } catch (_) {}
          return null;
        }
        if (nativeSource.has(this)) return nativeSource.get(this);
        try {
          if (typeof this.toString === "function" && this.toString !== patchedToString) {
            const crossRealm = this.toString(BRIDGE_TOKEN);
            if (crossRealm && typeof crossRealm === "object" && crossRealm.bridge === true && crossRealm.nativeText) {
              return crossRealm.nativeText;
            }
          }
        } catch (_) {}
        return originalToString.call(this, ...args);
      }
    };
    patchedToString = holder.toString;
    nativeSource.set(patchedToString, "function toString() { [native code] }");
    try { Object.defineProperty(patchedToString, "length", { configurable: true, value: 0 }); } catch (_) {}
    try { Object.defineProperty(patchedToString, "name", { configurable: true, value: "toString" }); } catch (_) {}
    Object.defineProperty(Function.prototype, "toString", {
      configurable: true,
      writable: true,
      value: patchedToString,
    });
  } catch (_) {}
  // Replacements only answer for the receiver they are meant to serve. Anything else is handed to
  // the native implementation, so brand checks, thrown error types and rejection messages stay
  // exactly what the build produces instead of being replaced by a hand-made error.
  const guardReceiver = (original, isTarget, serve) => function (...args) {
    if (typeof original === 'function' && typeof isTarget === 'function' && !isTarget(this)) {
      return original.apply(this, args);
    }
    return serve.apply(this, args);
  };
  const adoptNativeBridgeWrappers = (...protos) => {
    let adopted = false;
    for (const proto of protos.flat().filter(Boolean)) {
      let names = [];
      try { names = Object.getOwnPropertyNames(proto); } catch (_) { continue; }
      for (const key of names) {
        let descriptor = null;
        try { descriptor = Object.getOwnPropertyDescriptor(proto, key); } catch (_) { continue; }
        const fn = descriptor && descriptor.value;
        const state = inspectBridge(fn);
        if (!state) continue;
        try { nativeSource.set(fn, state.nativeText || ('function ' + (fn.name || key) + '() { [native code] }')); } catch (_) {}
        adopted = true;
      }
    }
    return adopted;
  };
  const replaceMethod = (proto, key, factory) => {
    try {
      if (!proto || typeof proto[key] !== "function") return null;
      const original = proto[key];
      const existing = inspectBridge(original);
      if (existing) {
        try { nativeSource.set(original, existing.nativeText || ('function ' + (original.name || key) + '() { [native code] }')); } catch (_) {}
        return original;
      }
      const rawFn = factory(original);
      let replacement;
      const safeWrapper = function(...args) {
        try {
          return rawFn.apply(this, args);
        } catch (err) {
          stripStackFrame(err, replacement, key);
          throw cleanStack(err, key);
        }
      };
      replacement = nativeLike(safeWrapper, original, key, original.length);
      Object.defineProperty(proto, key, {
        configurable: true,
        enumerable: Object.getOwnPropertyDescriptor(proto, key)?.enumerable || false,
        writable: true,
        value: replacement,
      });
      return original;
    } catch (_) { return null; }
  };

  // --- hide automation (navigator.webdriver / AutomationControlled) ---
  try {
    const hideWd = makeNativeGetter("webdriver", () => false, "navigator");
    if (typeof Navigator !== "undefined") {
      Object.defineProperty(Navigator.prototype, "webdriver", { configurable: true, enumerable: true, get: hideWd });
    }
    if (typeof navigator !== "undefined") {
      try { delete navigator.webdriver; } catch (_) {}
    }
  } catch (_) {}
  // cdc_ / $cdc_ selenium leftovers if present
  try {
    const cleanTargets = typeof document !== "undefined" ? [document, (typeof window !== "undefined" ? window : null)].filter(Boolean) : [];
    for (const tgt of cleanTargets) {
      for (const key of Object.getOwnPropertyNames(tgt)) {
        if (String(key).startsWith('$cdc_') || String(key).startsWith('cdc_') || String(key).startsWith('__selenium') || String(key).startsWith('__webdriver') || String(key).startsWith('__driver_')) {
          try { delete tgt[key]; } catch (_) {}
        }
      }
    }
  } catch (_) {}

  // --- Persona platform guards (iOS, Android, Mobile, Linux) ---
  const isIosPersona = Boolean(CFG.os === "ios" || CFG.platform === "iPhone" || CFG.mobileDevice?.os === "ios" || (CFG.platform && /iphone|ipad|ipod/i.test(CFG.platform)));
  const isAndroidPersona = Boolean(CFG.os === "android" || CFG.mobileDevice?.os === "android" || (CFG.platform && /android/i.test(CFG.platform)));
  const isMobilePersona = Boolean(CFG.mobile || isIosPersona || isAndroidPersona);

  // --- navigator (non-UA fields; UA handled by uaScript) ---
  const FROZEN_LANGUAGES = Object.freeze(Array.isArray(CFG.languages) ? [...CFG.languages] : ["en-US"]);
  const navPatch = {
    platform: { get: () => CFG.platform },
    maxTouchPoints: { get: () => CFG.maxTouchPoints },
    vendor: { get: () => CFG.vendor },
    languages: { get: () => FROZEN_LANGUAGES },
    language: { get: () => FROZEN_LANGUAGES[0] || "en-US" },
    webdriver: { get: () => false },
  };
  if (CFG.hardwareConcurrency != null) navPatch.hardwareConcurrency = { get: () => CFG.hardwareConcurrency };
  if (CFG.deviceMemory != null && !isIosPersona) navPatch.deviceMemory = { get: () => Math.min(8, CFG.deviceMemory) };
  if (CFG.doNotTrack != null) navPatch.doNotTrack = { get: () => CFG.doNotTrack };

  try {
    const navProto = typeof Navigator !== "undefined" ? Navigator.prototype : null;
    if (navProto) {
      for (const [key, desc] of Object.entries(navPatch)) {
        // Only members this document already exposes may be answered. deviceMemory is gated on a
        // secure context, so a data: frame has no such member: installing one there hands a page a
        // navigator property no stock engine has, which is a single in-operator away from being a
        // tell. The worker scope has carried this guard for the same reason.
        try { if (!(key in navProto)) continue; } catch (_) { continue; }
        const fn = desc.get;
        const getter = makeNativeGetter(key, fn, "navigator");
        Object.defineProperty(navProto, key, {
          configurable: true,
          enumerable: true,
          get: getter,
        });
        if (typeof navigator !== "undefined") {
          try { delete navigator[key]; } catch (_) {}
        }
      }
    }
  } catch (_) {}

  // --- Persona platform guards (iOS, Android, Mobile, Linux) ---

  if (isIosPersona) {
    try {
      if (typeof Navigator !== "undefined" && Navigator.prototype) {
        delete Navigator.prototype.userAgentData;
        delete Navigator.prototype.connection;
        delete Navigator.prototype.getBattery;
        delete Navigator.prototype.usb;
        delete Navigator.prototype.hid;
        delete Navigator.prototype.bluetooth;
        delete Navigator.prototype.serial;
        delete Navigator.prototype.deviceMemory;
        delete Navigator.prototype.gpu;
      }
      if (typeof navigator !== "undefined") {
        delete navigator.userAgentData;
        delete navigator.connection;
        delete navigator.getBattery;
        delete navigator.usb;
        delete navigator.hid;
        delete navigator.bluetooth;
        delete navigator.serial;
        delete navigator.deviceMemory;
        delete navigator.gpu;
      }
      if (typeof window !== "undefined") {
        if ("NavigatorUAData" in window) delete window.NavigatorUAData;
        if ("NetworkInformation" in window) delete window.NetworkInformation;
        if ("BatteryManager" in window) delete window.BatteryManager;
        if ("USB" in window) delete window.USB;
        if ("HID" in window) delete window.HID;
        if ("Bluetooth" in window) delete window.Bluetooth;
        if ("Serial" in window) delete window.Serial;
        if ("GPU" in window) delete window.GPU;
        if ("GPUAdapter" in window) delete window.GPUAdapter;
        if ("GPUDevice" in window) delete window.GPUDevice;
        try {
          Object.defineProperty(Window.prototype, "chrome", {
            get() { return undefined; },
            configurable: true,
          });
        } catch (_) {}
        try { delete window.chrome; } catch (_) {}
        try { delete globalThis.chrome; } catch (_) {}
        if (typeof window.chrome !== "undefined" || window.chrome) {
          try { delete window.chrome.app; } catch (_) {}
          try { delete window.chrome.loadTimes; } catch (_) {}
          try { delete window.chrome.csi; } catch (_) {}
          try { window.chrome = undefined; } catch (_) {}
        }

      }
    } catch (_) {}
    if (typeof window !== "undefined" && typeof window.GestureEvent === "undefined") {
      try {
        const BaseEvent = typeof UIEvent !== "undefined" ? UIEvent : Event;
        const FakeGestureEvent = function GestureEvent(type, eventInitDict) {
          if (!new.target) throw new TypeError("Failed to construct 'GestureEvent': Please use the 'new' operator.");
          return Reflect.construct(BaseEvent, [type, eventInitDict], new.target);
        };
        FakeGestureEvent.prototype = Object.create(BaseEvent.prototype, {
          constructor: { value: FakeGestureEvent, writable: true, configurable: true },
          scale: { value: 0, writable: true, configurable: true, enumerable: true },
          rotation: { value: 0, writable: true, configurable: true, enumerable: true },
          [Symbol.toStringTag]: { value: "GestureEvent", configurable: true },
        });
        Object.defineProperty(FakeGestureEvent, "prototype", { writable: false, enumerable: false, configurable: false });
        nativeLike(FakeGestureEvent, null, "GestureEvent", 1, true);
        nativeSource.set(FakeGestureEvent, "function GestureEvent() { [native code] }");
        Object.defineProperty(window, "GestureEvent", {
          configurable: true,
          writable: true,
          enumerable: false,
          value: FakeGestureEvent,
        });
      } catch (_) {}
    }
    if (typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function") {
      const origIsSupported = MediaSource.isTypeSupported;
      const patchedIsSupported = function isTypeSupported(type) {
        const t = String(type || "").toLowerCase();
        if (t.includes("webm")) return false;
        return origIsSupported.call(this, type);
      };
      nativeLike(patchedIsSupported, origIsSupported, "isTypeSupported", 1);
      try {
        Object.defineProperty(MediaSource, "isTypeSupported", {
          configurable: true, enumerable: true, writable: true, value: patchedIsSupported,
        });
      } catch (_) {}
    }
    if (typeof HTMLMediaElement !== "undefined" && HTMLMediaElement.prototype && HTMLMediaElement.prototype.canPlayType) {
      const origCanPlay = HTMLMediaElement.prototype.canPlayType;
      const patchedCanPlay = function canPlayType(type) {
        const t = String(type || "").toLowerCase();
        if (t.includes("webm")) return "";
        return origCanPlay.call(this, type);
      };
      nativeLike(patchedCanPlay, origCanPlay, "canPlayType", 1);
      try {
        Object.defineProperty(HTMLMediaElement.prototype, "canPlayType", {
          configurable: true, enumerable: true, writable: true, value: patchedCanPlay,
        });
      } catch (_) {}
    }
    if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
      const origSupports = CSS.supports;
      const patchedSupports = function supports(prop, val) {
        if (arguments.length === 2) {
          const p = String(prop || "").trim().toLowerCase();
          if (p === "-webkit-touch-callout") {
            const v = String(val || "").trim().toLowerCase();
            return v === "none" || v === "default";
          }
        } else if (arguments.length === 1) {
          const s = String(prop || "").toLowerCase();
          if (s.includes("-webkit-touch-callout")) return true;
        }
        return origSupports.apply(this, arguments);
      };
      nativeLike(patchedSupports, origSupports, "supports", 2);
      try {
        Object.defineProperty(CSS, "supports", {
          configurable: true, enumerable: true, writable: true, value: patchedSupports,
        });
      } catch (_) {}
    }
  }

  if (isMobilePersona) {
    try {
      const emptyPlugins = Object.create(typeof PluginArray !== "undefined" ? PluginArray.prototype : Object.prototype);
      Object.defineProperty(emptyPlugins, "length", { value: 0, configurable: true, enumerable: false, writable: false });
      const emptyMimeTypes = Object.create(typeof MimeTypeArray !== "undefined" ? MimeTypeArray.prototype : Object.prototype);
      Object.defineProperty(emptyMimeTypes, "length", { value: 0, configurable: true, enumerable: false, writable: false });

      if (typeof PluginArray !== "undefined" && PluginArray.prototype) {
        if (PluginArray.prototype.item) {
          const origItem = PluginArray.prototype.item;
          replaceMethod(PluginArray.prototype, "item", () => function item(index) {
            if (!this || this === PluginArray.prototype) throw new TypeError("Illegal invocation");
            if (this === emptyPlugins) return null;
            return origItem.apply(this, arguments);
          });
        }
        if (PluginArray.prototype.namedItem) {
          const origNamedItem = PluginArray.prototype.namedItem;
          replaceMethod(PluginArray.prototype, "namedItem", () => function namedItem(name) {
            if (!this || this === PluginArray.prototype) throw new TypeError("Illegal invocation");
            if (this === emptyPlugins) return null;
            return origNamedItem.apply(this, arguments);
          });
        }
      }

      if (typeof MimeTypeArray !== "undefined" && MimeTypeArray.prototype) {
        if (MimeTypeArray.prototype.item) {
          const origItem = MimeTypeArray.prototype.item;
          replaceMethod(MimeTypeArray.prototype, "item", () => function item(index) {
            if (!this || this === MimeTypeArray.prototype) throw new TypeError("Illegal invocation");
            if (this === emptyMimeTypes) return null;
            return origItem.apply(this, arguments);
          });
        }
        if (MimeTypeArray.prototype.namedItem) {
          const origNamedItem = MimeTypeArray.prototype.namedItem;
          replaceMethod(MimeTypeArray.prototype, "namedItem", () => function namedItem(name) {
            if (!this || this === MimeTypeArray.prototype) throw new TypeError("Illegal invocation");
            if (this === emptyMimeTypes) return null;
            return origNamedItem.apply(this, arguments);
          });
        }
      }

      if (typeof Navigator !== "undefined" && Navigator.prototype) {
        const emptyPluginsGetter = makeNativeGetter("plugins", () => emptyPlugins, "navigator");
        Object.defineProperty(Navigator.prototype, "plugins", {
          configurable: true, enumerable: true, get: emptyPluginsGetter, set: undefined,
        });
        const emptyMimeTypesGetter = makeNativeGetter("mimeTypes", () => emptyMimeTypes, "navigator");
        Object.defineProperty(Navigator.prototype, "mimeTypes", {
          configurable: true, enumerable: true, get: emptyMimeTypesGetter, set: undefined,
        });
        const pdfGetter = makeNativeGetter("pdfViewerEnabled", () => false, "navigator");
        Object.defineProperty(Navigator.prototype, "pdfViewerEnabled", {
          configurable: true, enumerable: true, get: pdfGetter, set: undefined,
        });
      }
      if (typeof navigator !== "undefined") {
        try { delete navigator.plugins; } catch (_) {}
        try { delete navigator.mimeTypes; } catch (_) {}
        try { delete navigator.pdfViewerEnabled; } catch (_) {}
      }
    } catch (_) {}

    if (typeof ScreenOrientation !== "undefined" && ScreenOrientation.prototype && ScreenOrientation.prototype.lock) {
      const origLock = ScreenOrientation.prototype.lock;
      const patchedLock = function lock(orientation) {
        if (!document.fullscreenElement) {
          return Promise.reject(new DOMException("screen.orientation.lock() is only available in fullscreen mode.", "SecurityError"));
        }
        return origLock.apply(this, arguments);
      };
      nativeLike(patchedLock, origLock, "lock", 1);
      try {
        Object.defineProperty(ScreenOrientation.prototype, "lock", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: patchedLock,
        });
      } catch (_) {}
    }
  }

  const targetClaimedOs = String(CFG.os || "").toLowerCase();
  if (targetClaimedOs === "linux" && typeof MediaCapabilities !== "undefined" && MediaCapabilities.prototype && MediaCapabilities.prototype.decodingInfo) {
    const origDecodingInfo = MediaCapabilities.prototype.decodingInfo;
    const patchedDecodingInfo = function decodingInfo(configuration) {
      const p = origDecodingInfo.apply(this, arguments);
      return p.then((res) => {
        try {
          const c = String(configuration?.video?.contentType || "").toLowerCase();
          if (c.includes("hvc1") || c.includes("hev1")) {
            return {
              supported: res.supported,
              smooth: res.smooth,
              powerEfficient: false,
            };
          }
        } catch (_) {}
        return res;
      });
    };
    nativeLike(patchedDecodingInfo, origDecodingInfo, "decodingInfo", 1);
    try {
      Object.defineProperty(MediaCapabilities.prototype, "decodingInfo", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: patchedDecodingInfo,
      });
    } catch (_) {}
  }

  // --- Keyboard Layout side-channel shielding (navigator.keyboard.getLayoutMap) ---
  if (typeof Keyboard !== "undefined" && Keyboard.prototype && typeof Keyboard.prototype.getLayoutMap === "function") {
    const US_KEYBOARD_LAYOUT = {
      KeyA: "a", KeyB: "b", KeyC: "c", KeyD: "d", KeyE: "e", KeyF: "f", KeyG: "g", KeyH: "h",
      KeyI: "i", KeyJ: "j", KeyK: "k", KeyL: "l", KeyM: "m", KeyN: "n", KeyO: "o", KeyP: "p",
      KeyQ: "q", KeyR: "r", KeyS: "s", KeyT: "t", KeyU: "u", KeyV: "v", KeyW: "w", KeyX: "x",
      KeyY: "y", KeyZ: "z",
      Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
      Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
      Backquote: String.fromCharCode(96), Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
      Backslash: String.fromCharCode(92), Semicolon: ";", Quote: String.fromCharCode(39), Comma: ",", Period: ".", Slash: "/",
      IntlBackslash: "§",
    };
    replaceMethod(Keyboard.prototype, "getLayoutMap", (origGetLayoutMap) => async function getLayoutMap() {
      const realMap = await origGetLayoutMap.call(this);
      if (!realMap || typeof realMap.get !== "function") return realMap;
      const targetLayout = US_KEYBOARD_LAYOUT;
      const origGet = realMap.get.bind(realMap);
      const origHas = realMap.has.bind(realMap);
      realMap.get = nativeLike(function get(key) {
        if (key in targetLayout) return targetLayout[key];
        return origGet(key);
      }, realMap.get, "get", 1);
      realMap.has = nativeLike(function has(key) {
        if (key in targetLayout) return true;
        return origHas(key);
      }, realMap.has, "has", 1);
      realMap.entries = nativeLike(function* entries() {
        for (const [k, v] of Object.entries(targetLayout)) {
          yield [k, v];
        }
      }, realMap.entries, "entries", 0);
      realMap.keys = nativeLike(function* keys() {
        for (const k of Object.keys(targetLayout)) {
          yield k;
        }
      }, realMap.keys, "keys", 0);
      realMap.values = nativeLike(function* values() {
        for (const v of Object.values(targetLayout)) {
          yield v;
        }
      }, realMap.values, "values", 0);
      realMap.forEach = nativeLike(function forEach(callback, thisArg) {
        for (const [k, v] of Object.entries(targetLayout)) {
          callback.call(thisArg, v, k, realMap);
        }
      }, realMap.forEach, "forEach", 1);
      realMap[Symbol.iterator] = realMap.entries;
      return realMap;
    });
  }

  // --- permissions consistency (Notification.permission vs permissions.query) ---
  try {
    const permProto = typeof Permissions !== "undefined" ? Permissions.prototype : (typeof navigator !== "undefined" && navigator.permissions ? Object.getPrototypeOf(navigator.permissions) : null);
    if (permProto && typeof permProto.query === "function") {
      const notificationStatuses = new WeakSet();
      if (typeof PermissionStatus !== "undefined" && PermissionStatus.prototype) {
        const stateDesc = Object.getOwnPropertyDescriptor(PermissionStatus.prototype, "state");
        if (stateDesc && typeof stateDesc.get === "function") {
          const origStateGet = stateDesc.get;
          const patchedStateGet = nativeLike(function state() {
            if (notificationStatuses.has(this) && typeof Notification !== "undefined") {
              return Notification.permission === "default" ? "prompt" : Notification.permission;
            }
            return origStateGet.call(this);
          }, origStateGet, "get state", 0);
          Object.defineProperty(PermissionStatus.prototype, "state", {
            configurable: true,
            enumerable: true,
            get: patchedStateGet,
          });
        }
      }
      replaceMethod(permProto, "query", (origQuery) => async function query(descriptor) {
        const status = await origQuery.call(this, descriptor);
        if (descriptor && descriptor.name === 'notifications') {
          if (status) notificationStatuses.add(status);
        }
        return status;
      });
    }
  } catch (_) {}

  // --- window.chrome presence ---
  try {
    if (typeof window !== "undefined") {
      if (isIosPersona) {
        try {
          Object.defineProperty(Window.prototype, "chrome", {
            get() { return undefined; },
            configurable: true,
          });
        } catch (_) {}
        try { delete window.chrome; } catch (_) {}
        try { delete globalThis.chrome; } catch (_) {}
        if (typeof window.chrome !== "undefined" || window.chrome) {
          try { delete window.chrome.app; } catch (_) {}
          try { delete window.chrome.loadTimes; } catch (_) {}
          try { delete window.chrome.csi; } catch (_) {}
          try { window.chrome = undefined; } catch (_) {}
        }
      } else {
        if (!window.chrome) window.chrome = {};
        if (isAndroidPersona) {
          try { delete window.chrome.app; } catch (_) {}
        } else if (!window.chrome.app) {
          const noop = () => {};
          window.chrome.app = {
            isInstalled: false,
            InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
            RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
            getDetails: nativeLike(noop, null, "getDetails", 0),
            getIsInstalled: nativeLike(() => false, null, "getIsInstalled", 0),
            installState: nativeLike((cb) => { if (typeof cb === 'function') cb('not_installed'); }, null, "installState", 1),
            runningState: nativeLike(() => "cannot_run", null, "runningState", 0),
          };
        }
        if (typeof window.chrome.csi !== 'function') {
          try {
            window.chrome.csi = nativeLike(function csi() {
              const timing = (typeof performance !== 'undefined' && performance.timing) || {};
              const startE = timing.navigationStart || Date.now();
              const onloadT = timing.loadEventEnd || timing.domContentLoadedEventEnd || startE;
              const pageT = (typeof performance !== 'undefined' && performance['now']) ? performance['now']() : (Date.now() - startE);
              return { startE, onloadT, pageT, tran: 15 };
            }, null, 'csi', 0);
          } catch (_) {}
        }
        if (typeof window.chrome.loadTimes !== 'function') {
          try {
            window.chrome.loadTimes = nativeLike(function loadTimes() {
              const timing = (typeof performance !== 'undefined' && performance.timing) || {};
              const navStart = (timing.navigationStart || Date.now()) / 1000;
              const loadEnd = (timing.loadEventEnd || timing.domContentLoadedEventEnd || Date.now()) / 1000;
              return {
                requestTime: navStart,
                startLoadTime: navStart,
                commitLoadTime: 0,
                finishDocumentLoadTime: loadEnd,
                finishLoadTime: loadEnd,
                firstPaintTime: 0,
                firstPaintAfterLoadTime: 0,
                navigationType: 'Other',
                wasFetchedViaSpdy: false,
                wasNpnNegotiated: false,
                npnNegotiatedProtocol: '',
                wasAlternateProtocolAvailable: false,
                connectionInfo: 'unknown',
              };
            }, null, 'loadTimes', 0);
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  // --- timezone spoofing (Intl.DateTimeFormat & Date) ---
  // The engine can already be in the target zone on its own (the CDP timezone override does exactly
  // that), and re-implementing the same surfaces on top of a correct engine is pure difference: the
  // zone name V8 prints for years outside the modern range, the TypeError the accessors owe a
  // receiver that is not a Date, and the number of times an options getter is read would all change
  // while nothing is hidden. So the script layer stays out of the way unless the engine is still
  // reporting some other zone.
  const engineReportsTargetZone = (() => {
    try {
      const want = new Intl.DateTimeFormat('en-US', { timeZone: String(CFG.timezone).trim() }).resolvedOptions().timeZone;
      return new Intl.DateTimeFormat().resolvedOptions().timeZone === want;
    } catch (_) { return false; }
  })();
  if (CFG.timezone && !engineReportsTargetZone) {
    try {
      const targetTz = String(CFG.timezone).trim();
      new Intl.DateTimeFormat('en-US', { timeZone: targetTz }).format();

      const OrigDateTimeFormat = Intl.DateTimeFormat;
      const DateTimeFormatProto = OrigDateTimeFormat.prototype;

      const origSetTime = Date.prototype.setTime;
      const origGetTzOffset = Date.prototype.getTimezoneOffset;
      const origGetTime = Date.prototype.getTime;
      // Native getTime is the brand check: a receiver that is not a Date has to throw exactly the
      // TypeError the engine throws rather than answer with a coerced value.
      const asDate = (self) => { origGetTime.call(self); return self; };
      // The zone offset for an instant comes straight from ICU numeric long-offset form. Rebuilding
      // the wall clock through Date.UTC is not equivalent: that route cannot represent years outside
      // 1..9999 or before the common era, and it drops the sub-minute offsets some zones had.
      const offsetFormatter = new OrigDateTimeFormat('en-US', { timeZone: targetTz, timeZoneName: 'longOffset' });
      const getOffsetMinutes = (date) => {
        try {
          const ts = date.getTime();
          if (isNaN(ts)) return NaN;
          const raw = (offsetFormatter.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || '').replace(/^GMT/, '');
          const m = raw.match(/^([+-])(\\d{1,2})(?::(\\d{2}))?(?::(\\d{2}))?$/);
          if (!m) return 0;
          const seconds = Number(m[2]) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
          return (m[1] === '-' ? 1 : -1) * (seconds / 60);
        } catch (_) {
          return 0;
        }
      };
      // ICU has no long zone name for every instant, while V8 still prints one: outside the modern
      // metazone range the long form degrades to a numeric offset. A reference instant in the same
      // standard/daylight state supplies the name V8 prints, chosen by nearest offset.
      const zoneNameRefs = (() => {
        const nameAt = (ms) => new OrigDateTimeFormat(undefined, { timeZone: targetTz, timeZoneName: 'long' })
          .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value || '';
        const winter = Date.UTC(2026, 0, 15, 12);
        const summer = Date.UTC(2026, 6, 15, 12);
        return [{ offset: getOffsetMinutes(new Date(winter)), name: nameAt(winter) }, { offset: getOffsetMinutes(new Date(summer)), name: nameAt(summer) }];
      })();
      const zoneNameFor = (date) => {
        const name = new OrigDateTimeFormat(undefined, { timeZone: targetTz, timeZoneName: 'long' })
          .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || '';
        const offset = getOffsetMinutes(date);
        const exact = zoneNameRefs.find((ref) => ref.offset === offset);
        if (exact) return /^GMT/.test(name) ? (exact.name || name) : name;
        let best = zoneNameRefs[0];
        for (const ref of zoneNameRefs) if (Math.abs(ref.offset - offset) < Math.abs(best.offset - offset)) best = ref;
        return best.name || name;
      };

      const getLocalComponents = (date) => {
        const off = getOffsetMinutes(date);
        const shifted = new Date(date.getTime() - off * 60000);
        if (!isNaN(shifted.getTime())) return shifted;
        // ICU still answers at the domain edges, where the shifted instant is not representable, and
        // the wall clock there can itself sit past the Date domain, so the fields are handed back as
        // a read-only view instead of a Date that cannot exist.
        const parts = new OrigDateTimeFormat('en-US', {
          timeZone: targetTz, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).formatToParts(date);
        const get = (type) => parts.find((p) => p.type === type)?.value || '';
        const year = /BC/i.test(get('era')) ? 1 - parseInt(get('year'), 10) : numbered;
        const month = parseInt(get('month'), 10) - 1;
        const day = parseInt(get('day'), 10);
        const hour = parseInt(get('hour'), 10) % 24;
        const minute = parseInt(get('minute'), 10);
        const second = parseInt(get('second'), 10);
        const millisecond = ((date.getTime() % 1000) + 1000) % 1000;
        const weekday = new Date(Date.UTC(year, month, day)).getUTCDay();
        const invalid = () => NaN;
        return {
          getUTCFullYear: () => year,
          getUTCMonth: () => month,
          getUTCDate: () => day,
          getUTCDay: () => weekday,
          getUTCHours: () => hour,
          getUTCMinutes: () => minute,
          getUTCSeconds: () => second,
          getUTCMilliseconds: () => millisecond,
          getTime: invalid,
          setUTCFullYear: invalid,
          setUTCMonth: invalid,
          setUTCDate: invalid,
          setUTCHours: invalid,
          setUTCMinutes: invalid,
          setUTCSeconds: invalid,
          setUTCMilliseconds: invalid,
        };
      };

      // Reading timeZone here would add an access the engine already makes, and copying the options
      // would read every other option a second time, so a prototype-chained copy carries the default
      // zone while the page options stay the only source for everything else. A null argument has to
      // reach the engine unchanged, because the TypeError it raises is part of the surface.
      const withDefaultTimeZone = (options) => {
        if (options === undefined) return { timeZone: targetTz };
        if (options === null) return options;
        const boxed = Object(options);
        const opts = Object.create(boxed);
        // The engine reads timeZone exactly once, so the substitute is a lazy accessor rather than a
        // value: it forwards to the page options on the engine read and answers the target zone when
        // the page left the option absent or undefined. Copying the options would instead read every
        // other option a second time.
        let read = false;
        let resolved = targetTz;
        Object.defineProperty(opts, 'timeZone', {
          enumerable: true,
          configurable: true,
          get() {
            if (!read) {
              read = true;
              const fromPage = boxed.timeZone;
              resolved = fromPage === undefined ? targetTz : fromPage;
            }
            return resolved;
          },
        });
        return opts;
      };
      const PatchedDateTimeFormat = function DateTimeFormat(locales, options) {
        const opts = withDefaultTimeZone(options);
        if (!(this instanceof PatchedDateTimeFormat)) {
          return Reflect.construct(OrigDateTimeFormat, [locales, opts]);
        }
        return Reflect.construct(OrigDateTimeFormat, [locales, opts], new.target);
      };
      Object.defineProperty(PatchedDateTimeFormat, 'prototype', {
        value: DateTimeFormatProto,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      // Without this the prototype's constructor still points at the original, so the one-line
      // check Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat returns false.
      try {
        Object.defineProperty(DateTimeFormatProto, 'constructor', {
          configurable: true, writable: true, enumerable: false, value: PatchedDateTimeFormat,
        });
      } catch (_) {}
      if (OrigDateTimeFormat.supportedLocalesOf) {
        PatchedDateTimeFormat.supportedLocalesOf = nativeLike(
          function supportedLocalesOf(...args) { return OrigDateTimeFormat.supportedLocalesOf.apply(OrigDateTimeFormat, args); },
          OrigDateTimeFormat.supportedLocalesOf,
          'supportedLocalesOf',
          1
        );
      }
      nativeLike(PatchedDateTimeFormat, OrigDateTimeFormat, 'DateTimeFormat', 0, true);
      Intl.DateTimeFormat = PatchedDateTimeFormat;

      replaceMethod(Date.prototype, 'getTimezoneOffset', () => function getTimezoneOffset() {
        const minutes = getOffsetMinutes(asDate(this));
        if (!isFinite(minutes)) return NaN;
        const whole = Math.trunc(minutes);
        return whole === 0 ? 0 : whole;
      });



      const formatTzDate = (date) => {
        try {
          // en-US on purpose: the weekday and month abbreviations V8 prints are fixed English,
          // while the zone name in the parenthetical follows the default locale (zoneNameFor).
          const parts = new OrigDateTimeFormat('en-US', {
            timeZone: targetTz,
            weekday: 'short',
            month: 'short',
            day: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZoneName: 'long'
          }).formatToParts(date);
          const get = (type) => parts.find(p => p.type === type)?.value || '';
          const weekday = get('weekday');
          const month = get('month');
          const day = get('day');
          const localYear = getLocalComponents(date).getUTCFullYear();
          const year = localYear < 0 ? '-' + String(-localYear).padStart(4, '0') : String(localYear).padStart(4, '0');
          const hour = (get('hour') === '24' ? '00' : get('hour')).padStart(2, '0');
          const minute = get('minute').padStart(2, '0');
          const second = get('second').padStart(2, '0');
          const tzName = zoneNameFor(date);
          const diffMins = getOffsetMinutes(date);
          const sign = diffMins <= 0 ? '+' : '-';
          const absMins = Math.trunc(Math.abs(diffMins));
          const offH = String(Math.floor(absMins / 60)).padStart(2, '0');
          const offM = String(absMins % 60).padStart(2, '0');
          const gmt = 'GMT' + sign + offH + offM;
          return weekday + ' ' + month + ' ' + day + ' ' + year + ' ' + hour + ':' + minute + ':' + second + ' ' + gmt + ' (' + tzName + ')';
        } catch (_) {
          return date.toISOString();
        }
      };

      replaceMethod(Date.prototype, 'toString', () => function toString() {
        if (isNaN(asDate(this).getTime())) return 'Invalid Date';
        return formatTzDate(this);
      });

      replaceMethod(Date.prototype, 'toTimeString', () => function toTimeString() {
        if (isNaN(asDate(this).getTime())) return 'Invalid Date';
        const full = formatTzDate(this);
        const match = full.match(/[0-9]{4}[ ]+(.*)/);
        return match ? match[1] : full;
      });

      replaceMethod(Date.prototype, 'toDateString', () => function toDateString() {
        if (isNaN(asDate(this).getTime())) return 'Invalid Date';
        const full = formatTzDate(this);
        return full.split(' ').slice(0, 4).join(' ');
      });

      replaceMethod(Date.prototype, 'toLocaleString', (orig) => function toLocaleString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replaceMethod(Date.prototype, 'toLocaleDateString', (orig) => function toLocaleDateString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replaceMethod(Date.prototype, 'toLocaleTimeString', (orig) => function toLocaleTimeString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replaceMethod(Date.prototype, 'getHours', () => function getHours() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCHours();
      });

      replaceMethod(Date.prototype, 'getDate', () => function getDate() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCDate();
      });

      replaceMethod(Date.prototype, 'getDay', () => function getDay() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCDay();
      });

      replaceMethod(Date.prototype, 'getFullYear', () => function getFullYear() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCFullYear();
      });

      replaceMethod(Date.prototype, 'getMonth', () => function getMonth() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCMonth();
      });

      replaceMethod(Date.prototype, 'getMinutes', () => function getMinutes() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCMinutes();
      });

      replaceMethod(Date.prototype, 'getSeconds', () => function getSeconds() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCSeconds();
      });

      replaceMethod(Date.prototype, 'getMilliseconds', () => function getMilliseconds() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCMilliseconds();
      });

      replaceMethod(Date.prototype, 'getYear', () => function getYear() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCFullYear() - 1900;
      });

      // Local-time setters must land in the spoofed zone too. Reading a component through the
      // patched getters while writing it through the host zone leaves the two disagreeing,
      // which is a stronger signal than not spoofing at all.
      const setLocal = (self, mutate) => {
        if (isNaN(asDate(self).getTime())) return NaN;
        const shifted = getLocalComponents(self);
        mutate(shifted);
        // Resolve the offset twice: the write may have crossed a DST boundary.
        let guess = shifted.getTime() + getOffsetMinutes(self) * 60000;
        guess = shifted.getTime() + getOffsetMinutes(new Date(guess)) * 60000;
        return origSetTime.call(self, guess);
      };
      replaceMethod(Date.prototype, 'setFullYear', () => function setFullYear(y, m, d) {
        return setLocal(this, (x) => {
          x.setUTCFullYear(y);
          if (m !== undefined) x.setUTCMonth(m);
          if (d !== undefined) x.setUTCDate(d);
        });
      });
      replaceMethod(Date.prototype, 'setMonth', () => function setMonth(m, d) {
        return setLocal(this, (x) => { x.setUTCMonth(m); if (d !== undefined) x.setUTCDate(d); });
      });
      replaceMethod(Date.prototype, 'setDate', () => function setDate(d) {
        return setLocal(this, (x) => x.setUTCDate(d));
      });
      replaceMethod(Date.prototype, 'setHours', () => function setHours(h, mi, sec, ms) {
        return setLocal(this, (x) => {
          x.setUTCHours(h);
          if (mi !== undefined) x.setUTCMinutes(mi);
          if (sec !== undefined) x.setUTCSeconds(sec);
          if (ms !== undefined) x.setUTCMilliseconds(ms);
        });
      });
      replaceMethod(Date.prototype, 'setMinutes', () => function setMinutes(mi, sec, ms) {
        return setLocal(this, (x) => {
          x.setUTCMinutes(mi);
          if (sec !== undefined) x.setUTCSeconds(sec);
          if (ms !== undefined) x.setUTCMilliseconds(ms);
        });
      });
      replaceMethod(Date.prototype, 'setSeconds', () => function setSeconds(sec, ms) {
        return setLocal(this, (x) => { x.setUTCSeconds(sec); if (ms !== undefined) x.setUTCMilliseconds(ms); });
      });
      replaceMethod(Date.prototype, 'setMilliseconds', () => function setMilliseconds(ms) {
        return setLocal(this, (x) => x.setUTCMilliseconds(ms));
      });

      // new Date(y, m, d, ...) and Date.parse('2026-01-15 12:00:00') are defined against the
      // *local* zone. Left alone they resolve against the host zone while every getter above
      // reports the spoofed one, so a two-line script recovers the real timezone.
      try {
        const OrigDate = Date;
        const localToUtc = (ms) => {
          if (isNaN(ms)) return NaN;
          // getOffsetMinutes keeps the JS sign convention (UTC+05:30 reports -330), so shifting
          // a wall-clock reading in the spoofed zone back to a real instant means adding it.
          let out = ms + getOffsetMinutes(new OrigDate(ms)) * 60000;
          out = ms + getOffsetMinutes(new OrigDate(out)) * 60000;
          return out;
        };
        // Matches ES2015+ "date-time forms without a timezone offset", which parse as local.
        const NO_TZ = new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?$');
        const parseLocal = (value) => {
          const raw = OrigDate.parse(value);
          if (isNaN(raw)) return raw;
          if (!NO_TZ.test(String(value).trim())) return raw;
          // OrigDate.parse resolved these fields against the host zone. Undo that with the
          // engine's own offset, then re-apply the spoofed zone's.
          const undo = raw - origGetTzOffset.call(new OrigDate(raw)) * 60000;
          return localToUtc(undo);
        };
        const PatchedDate = function Date(...args) {
          if (!new.target) return OrigDate();
          if (args.length === 0) return Reflect.construct(OrigDate, [], new.target);
          if (args.length === 1) {
            const only = args[0];
            if (typeof only === 'string') {
              return Reflect.construct(OrigDate, [parseLocal(only)], new.target);
            }
            return Reflect.construct(OrigDate, args, new.target);
          }
          // Interpret the fields as wall-clock time in the *spoofed* zone. Letting the engine
          // parse them first would apply the host zone's offset, which the correction below
          // would then apply a second time.
          const y = Number(args[0]);
          // undefined means "default"; anything else is coerced the way the engine would, so a NaN
          // field leaves the whole date Invalid instead of folding to 0.
          const field = (value, fallback) => (value === undefined ? fallback : Number(value));
          const wall = OrigDate.UTC(
            y >= 0 && y <= 99 ? y + 1900 : y,
            field(args[1], 0),
            field(args[2], 1),
            field(args[3], 0),
            field(args[4], 0),
            field(args[5], 0),
            field(args[6], 0)
          );
          return Reflect.construct(OrigDate, [localToUtc(wall)], new.target);
        };
        Object.defineProperty(PatchedDate, 'prototype', {
          value: OrigDate.prototype,
          writable: false,
          enumerable: false,
          configurable: false,
        });
        try {
          Object.defineProperty(OrigDate.prototype, 'constructor', {
            configurable: true, writable: true, enumerable: false, value: PatchedDate,
          });
        } catch (_) {}
        PatchedDate.now = OrigDate.now;
        PatchedDate.parse = nativeLike(
          function parse(value) { return parseLocal(value); },
          OrigDate.parse, 'parse', 1
        );
        PatchedDate.UTC = OrigDate.UTC;
        nativeLike(PatchedDate, OrigDate, 'Date', 7, true);
        globalThis.Date = PatchedDate;
      } catch (_) {}
    } catch (_) {}
  }


  // --- audio ---
  // A buffer the engine rendered from the profile graph is a stable per-machine value, so it
  // needs the same per-profile perturbation the canvas gets. Silent buffers are left untouched:
  // a page that renders nothing expects exact zeros, and dithering them is itself the tell.
  if (CFG.audio && CFG.audio.mode === 'noise') {
    try {
      const mark = Number(CFG.audio.mark) || 1;
      const renderedBuffers = new WeakSet();
      const authoredSpans = new WeakMap();
      const markRendered = (value) => {
        try { if (value && typeof value === 'object') renderedBuffers.add(value); } catch (_) {}
        return value;
      };
      const spanFor = (buffer, channel) => {
        try {
          const channels = authoredSpans.get(buffer);
          if (!channels) return null;
          return channels.get(channel) || null;
        } catch (_) { return null; }
      };
      const recordSpan = (buffer, channelNumber, start, length) => {
        try {
          if (!buffer || typeof buffer !== 'object' || !renderedBuffers.has(buffer)) return;
          const channel = Number(channelNumber) || 0;
          const from = Math.max(0, Number(start) || 0);
          const cover = Number(length) || 0;
          if (cover <= 0) return;
          let channels = authoredSpans.get(buffer);
          if (!channels) { channels = new Map(); authoredSpans.set(buffer, channels); }
          const spans = channels.get(channel) || [];
          spans.push([from, from + cover]);
          channels.set(channel, spans);
        } catch (_) {}
      };
      const inAuthoredSpan = (spans, index) => {
        if (!spans) return false;
        for (const span of spans) { if (index >= span[0] && index < span[1]) return true; }
        return false;
      };
      const hookOwn = (proto, key, factory) => {
        try {
          if (!proto || !Object.prototype.hasOwnProperty.call(proto, key) || typeof proto[key] !== 'function') return null;
          return replaceMethod(proto, key, factory);
        } catch (_) { return null; }
      };

      const patchedAudioWindows = new WeakSet();
      const patchAudioForWindow = (targetWin) => {
        if (!targetWin || patchedAudioWindows.has(targetWin)) return;
        const audioProtos = [];
        for (const ctor of [targetWin.BaseAudioContext, targetWin.AudioContext, targetWin.OfflineAudioContext, targetWin.webkitAudioContext, targetWin.webkitOfflineAudioContext]) {
          try { if (ctor && ctor.prototype && audioProtos.indexOf(ctor.prototype) === -1) audioProtos.push(ctor.prototype); } catch (_) {}
        }
        if (adoptNativeBridgeWrappers(audioProtos, targetWin.AudioBuffer?.prototype, targetWin.OfflineAudioCompletionEvent?.prototype)) {
          try { patchedAudioWindows.add(targetWin); } catch (_) {}
          return;
        }
        try { patchedAudioWindows.add(targetWin); } catch (_) {}
        for (const proto of audioProtos) {
          hookOwn(proto, 'startRendering', (original) => function startRendering(...args) {
            const result = original.apply(this, args);
            try { if (result && typeof result.then === 'function') return result.then(markRendered); } catch (_) {}
            return result;
          });
        }
        const audioClaimedOs = String(CFG.os || '').toLowerCase();
        const isWinAudio = audioClaimedOs.includes('win');
        const isLinuxAudio = audioClaimedOs.includes('linux');

        if (isWinAudio || isLinuxAudio) {
          const mockSampleRate = 48000;
          const mockBaseLatency = 512 / 48000;

          for (const ctor of [targetWin.AudioContext, targetWin.webkitAudioContext].filter(Boolean)) {
            if (ctor && ctor.prototype) {
              const proto = ctor.prototype;
              const baseProto = targetWin.BaseAudioContext?.prototype;
              const descRate = Object.getOwnPropertyDescriptor(proto, 'sampleRate') || (baseProto && Object.getOwnPropertyDescriptor(baseProto, 'sampleRate'));
              const descLat = Object.getOwnPropertyDescriptor(proto, 'baseLatency');

              if (descRate && typeof descRate.get === 'function') {
                const origGetRate = descRate.get;
                const rateGetter = function sampleRate() {
                  if (!this || this === proto || (baseProto && this === baseProto)) {
                    throw new TypeError('Illegal invocation');
                  }
                  if (targetWin.OfflineAudioContext && this instanceof targetWin.OfflineAudioContext) {
                    return origGetRate.call(this);
                  }
                  return mockSampleRate;
                };
                const cleanRateGetter = nativeGetter('sampleRate', rateGetter);
                try {
                  Object.defineProperty(proto, 'sampleRate', {
                    configurable: true,
                    enumerable: descRate.enumerable !== false,
                    get: cleanRateGetter,
                    set: undefined,
                  });
                } catch (_) {}
              }

              if (descLat && typeof descLat.get === 'function') {
                const origGetLat = descLat.get;
                const latGetter = function baseLatency() {
                  if (!this || this === proto || (baseProto && this === baseProto)) {
                    throw new TypeError('Illegal invocation');
                  }
                  return mockBaseLatency;
                };
                const cleanLatGetter = nativeGetter('baseLatency', latGetter);
                try {
                  Object.defineProperty(proto, 'baseLatency', {
                    configurable: true,
                    enumerable: descLat.enumerable !== false,
                    get: cleanLatGetter,
                    set: undefined,
                  });
                } catch (_) {}
              }
            }
          }
        }
        try {
          const completionProto = targetWin.OfflineAudioCompletionEvent ? targetWin.OfflineAudioCompletionEvent.prototype : null;
          const descriptor = completionProto ? Object.getOwnPropertyDescriptor(completionProto, 'renderedBuffer') : null;
          if (descriptor && typeof descriptor.get === 'function' && descriptor.configurable !== false) {
            const nativeGet = descriptor.get;
            Object.defineProperty(completionProto, 'renderedBuffer', {
              configurable: descriptor.configurable,
              enumerable: descriptor.enumerable,
              get: makeNativeGetter('renderedBuffer', function () {
                return markRendered(nativeGet.call(this));
              }, 'OfflineAudioCompletionEvent'),
            });
          }
        } catch (_) {}
        if (targetWin.AudioBuffer && targetWin.AudioBuffer.prototype.getChannelData) {
          const processed = new WeakMap();
          if (targetWin.AudioBuffer.prototype.copyToChannel) {
            hookOwn(targetWin.AudioBuffer.prototype, 'copyToChannel', (original) => function copyToChannel(source, channelNumber, startInChannel) {
              const result = original.apply(this, arguments);
              try {
                const length = source && typeof source.length === 'number' ? source.length : 0;
                recordSpan(this, channelNumber, startInChannel, length);
              } catch (_) {}
              return result;
            });
          }
          replaceMethod(targetWin.AudioBuffer.prototype, 'getChannelData', (original) => function getChannelData(channelIndex) {
            const data = original.apply(this, arguments);
            try {
              if (!renderedBuffers.has(this)) return data;
              const channel = Number(channelIndex) || 0;
              let channels = processed.get(this);
              if (!channels) { channels = new Set(); processed.set(this, channels); }
              if (!channels.has(channel)) {
                let silent = true;
                for (let i = 0; i < data.length; i += 1) {
                  if (data[i] !== 0) { silent = false; break; }
                }
                if (!silent) {
                  const spans = spanFor(this, channel);
                  for (let i = 0; i < data.length; i += 1) {
                    if (inAuthoredSpan(spans, i)) continue;
                    data[i] = data[i] + (noise(i + channel * 4099 + mark) - 0.5) * 1e-7;
                  }
                }
                channels.add(channel);
              }
            } catch (_) {}
            return data;
          });

          if (targetWin.AudioBuffer.prototype.copyFromChannel) {
            replaceMethod(targetWin.AudioBuffer.prototype, 'copyFromChannel', (original) => function copyFromChannel(destination, channelNumber, startInChannel) {
              if (renderedBuffers.has(this)) {
                try { this.getChannelData(Number(channelNumber) || 0); } catch (_) {}
              }
              return original.apply(this, arguments);
            });
          }
        }
        if (targetWin.AnalyserNode) {
          const patchFreq = (name) => {
            if (!targetWin.AnalyserNode.prototype || !targetWin.AnalyserNode.prototype[name]) return;
            replaceMethod(targetWin.AnalyserNode.prototype, name, (original) => function(...args) {
              const res = original.apply(this, args);
              try {
                const array = args[0];
                if (array && array.length) {
                  const step = Math.max(1, Math.floor(array.length / 32));
                  if (name.includes('Byte')) {
                    for (let i = 0; i < array.length; i += step) {
                      if (array[i] > 0 && array[i] < 255) {
                        const delta = noise(i + mark) > 0.5 ? 1 : -1;
                        array[i] = Math.max(0, Math.min(255, array[i] + delta));
                      }
                    }
                  } else {
                    const amp = 1e-5;
                    for (let i = 0; i < array.length; i += step) {
                      if (array[i] !== 0 && !isNaN(array[i]) && isFinite(array[i])) {
                        array[i] += (noise(i + mark) - 0.5) * amp;
                      }
                    }
                  }
                }
              } catch (_) {}
              return res;
            });
          };
          patchFreq('getFloatFrequencyData');
          patchFreq('getByteFrequencyData');
          patchFreq('getFloatTimeDomainData');
          patchFreq('getByteTimeDomainData');
        }
      };

      patchAudioForWindow(globalThis);
      subWindowSyncHooks.push((subWin) => { patchAudioForWindow(subWin); });
    } catch (_) {}
  }

  // --- fonts ---
  // Direct font enumeration via Local Font Access API (queryLocalFonts) is answered below by
  // aligning returned FontData entries with the persona font set.
  // Measurement-based probing (rendering text to measure advance widths) is handled at document
  // start by registering authentic platform font subsets via FontFace into document.fonts,
  // accompanied by a filtered proxy view that shields injected faces from enumeration (size === 0).
  //
  // document.fonts.check() is deliberately left native. In this engine it answers true for
  // registered and system families, and the injected platform font faces ensure check() passes
  // natively without synthetic method overrides.
  if (CFG.fonts && Array.isArray(CFG.fonts.list) && CFG.fonts.list.length) {
    const personaFonts = CFG.fonts.list.map((name) => String(name));
    // Local Font Access: enumerate the persona set rather than the host set. The entries keep
    // the engine's FontData shape - prototype brand, inherited accessors, no own enumerable
    // members - because a plain object is itself a tell: it stringifies, enumerates and brands
    // differently from the FontData every other Chromium hands out.
    try {
      if (typeof globalThis.queryLocalFonts === 'function') {
        const original = globalThis.queryLocalFonts;
        const postscriptNameOf = (family) => family.replace(/\\s+/g, '');
        const entryFor = (template, family, blob) => new Proxy(template, {
          get(target, prop) {
            if (prop === 'family' || prop === 'fullName') return family;
            if (prop === 'postscriptName') return postscriptNameOf(family);
            if (prop === 'style') return 'Regular';
            if (prop === 'blob') return blob;
            // The receiver has to stay the real object: FontData members are native accessors
            // that read internal slots, and a proxy as this throws on every one of them.
            return Reflect.get(target, prop, target);
          },
        });
        const patched = nativeLike(async function queryLocalFonts(options) {
          // The native method decides whether the call is legal at all - it rejects for a receiver
          // that is not the window - so it is always consulted first and its rejection propagates
          // unchanged. Its result is only ever used as the shape template, so a tolerated receiver
          // still cannot be a way to read the host list, and the fresh payload has to be carried by
          // the persona list instead.
          const answered = await original.apply(this, arguments);
          let template = answered && answered.length ? answered[0] : null;
          if (!template) {
            const host = await original.call(globalThis);
            template = host && host.length ? host[0] : null;
          }
          if (!template) return answered;
          const blob = typeof template.blob === 'function' ? template.blob.bind(template) : undefined;
          const wanted = options && Array.isArray(options.postscriptNames)
            ? new Set(options.postscriptNames.map((name) => String(name)))
            : null;
          return personaFonts
            .filter((family) => !wanted || wanted.has(postscriptNameOf(family)))
            .map((family) => entryFor(template, family, blob));
        }, original);
        Object.defineProperty(globalThis, 'queryLocalFonts', { configurable: true, enumerable: true, writable: true, value: patched });
      }
    } catch (_) {}

    // Asking the engine whether a named family is installed is a separate surface from measuring
    // text: a page builds a FontFace from a plain local() source and awaits load(). The host font
    // store answers that directly, so a persona running on a different platform is contradicted by
    // a single settled promise. Answer it from the persona's own platform list instead - families
    // that platform ships resolve, everything else fails the way the engine fails for a local
    // source it cannot find.
    //
    // Only a plain local() source is answered here. A source that mixes local() with a url()
    // candidate is a page loading its own web font, and that has to keep the engine's own
    // resolution order, so those faces are left completely untouched.
    try {
      const NativeFontFace = globalThis.FontFace;
      const fontFaceBridge = inspectBridge(NativeFontFace) || inspectBridge(NativeFontFace?.prototype?.load);
      if (typeof NativeFontFace === 'function' && typeof NativeFontFace.prototype === 'object' && !fontFaceBridge) {
        const ownFamilies = new Set(personaFonts.map((name) => String(name).toLowerCase()));
        const localOnlyFamily = new WeakMap();
        const forcedStatus = new WeakMap();
        const settledLocal = new WeakMap();

        // A plain local() source names exactly one candidate. Anything with a trailing comma has
        // further candidates and belongs to the engine.
        const isPlainLocalSource = (source) => {
          const text = String(source === undefined || source === null ? '' : source).trim();
          return /^local\\s*\\(\\s*(?:"[^"]*"|'[^']*'|[^)'"]*)\\s*\\)$/i.test(text);
        };
        const missingFontError = () => {
          try { return new DOMException('A network error occurred.', 'NetworkError'); }
          catch (_) {
            const fallback = new Error('A network error occurred.');
            fallback.name = 'NetworkError';
            return fallback;
          }
        };
        // One shared rejection per face, with a handler already attached: a page that ignores the
        // promise must not see a script-originated unhandled rejection the engine would not emit.
        const rejectedFor = (face) => {
          let promise = settledLocal.get(face);
          if (!promise) {
            promise = Promise.reject(missingFontError());
            try { promise.catch(() => {}); } catch (_) {}
            settledLocal.set(face, promise);
          }
          return promise;
        };
        const resolvedFor = (face) => {
          let promise = settledLocal.get(face);
          if (!promise) {
            promise = Promise.resolve(face);
            settledLocal.set(face, promise);
          }
          return promise;
        };

        const parseLocalSourceFamily = (source) => {
          const text = String(source === undefined || source === null ? '' : source).trim();
          const match = text.match(/^local\\s*\\(\\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\\s*\\)$/i);
          if (!match) return null;
          return String(match[1] ?? match[2] ?? match[3] ?? '').trim();
        };
        const nativeCtor = function FontFace(family, source, descriptors) {
          const face = new NativeFontFace(family, source, descriptors);
          try {
            const localTarget = parseLocalSourceFamily(source);
            if (localTarget !== null) localOnlyFamily.set(face, localTarget);
          } catch (_) {}
          return face;
        };
        const cleanCtor = nativeLike(nativeCtor, NativeFontFace, 'FontFace', 2, true);
        try {
          Object.defineProperty(cleanCtor, 'prototype', {
            value: NativeFontFace.prototype,
            writable: false,
            enumerable: false,
            configurable: false,
          });
        } catch (_) {}
        Object.defineProperty(globalThis, 'FontFace', { configurable: true, enumerable: false, writable: true, value: cleanCtor });

        const nativeLoad = NativeFontFace.prototype.load;
        if (typeof nativeLoad === 'function') {
          const replacedLoad = nativeLike(function load() {
            const family = localOnlyFamily.get(this);
            if (family === undefined) return nativeLoad.apply(this, arguments);
            if (ownFamilies.has(family.toLowerCase())) {
              forcedStatus.set(this, 'loaded');
              return resolvedFor(this);
            }
            forcedStatus.set(this, 'error');
            return rejectedFor(this);
          }, nativeLoad, 'load', 0, false);
          Object.defineProperty(NativeFontFace.prototype, 'load', { configurable: true, writable: true, value: replacedLoad });
        }

        const nativeLoadedDesc = Object.getOwnPropertyDescriptor(NativeFontFace.prototype, 'loaded');
        if (nativeLoadedDesc && typeof nativeLoadedDesc.get === 'function') {
          const nativeLoadedGet = nativeLoadedDesc.get;
          const replacedLoadedGet = nativeLike(function () {
            const family = localOnlyFamily.get(this);
            if (family === undefined) return nativeLoadedGet.call(this);
            const forced = forcedStatus.get(this);
            if (forced === 'loaded') return resolvedFor(this);
            if (forced === 'error') return rejectedFor(this);
            // Reading .loaded must not run the load algorithm or mutate .status; keep the engine's
            // own pending promise until load() is explicitly called.
            return nativeLoadedGet.call(this);
          }, nativeLoadedGet, 'get loaded', 0, false);
          Object.defineProperty(NativeFontFace.prototype, 'loaded', {
            configurable: true,
            enumerable: nativeLoadedDesc.enumerable,
            get: replacedLoadedGet,
            set: nativeLoadedDesc.set,
          });
        }

        const nativeStatusDesc = Object.getOwnPropertyDescriptor(NativeFontFace.prototype, 'status');
        if (nativeStatusDesc && typeof nativeStatusDesc.get === 'function') {
          const nativeStatusGet = nativeStatusDesc.get;
          const replacedStatusGet = nativeLike(function () {
            const forced = forcedStatus.get(this);
            if (forced !== undefined) return forced;
            return nativeStatusGet.call(this);
          }, nativeStatusGet, 'get status', 0, false);
          Object.defineProperty(NativeFontFace.prototype, 'status', {
            configurable: true,
            enumerable: nativeStatusDesc.enumerable,
            get: replacedStatusGet,
            set: nativeStatusDesc.set,
          });
        }
      }
    } catch (_) {}
  }

  // --- foreign-platform font measurement shielding ---
  // A persona must not answer font probes through host-only families. The local-font gates cover
  // @font-face and queryLocalFonts, but Canvas and layout metrics still resolve system fonts
  // directly. Rewrite only families that belong to another platform before the native rasterizer
  // sees them, so a Windows persona on macOS gets the same fallback a real Windows build would.
  if (CFG.fonts && Array.isArray(CFG.fonts.foreign) && CFG.fonts.foreign.length) {
    try {
      const foreignFontSet = new Set(CFG.fonts.foreign
        .map((name) => String(name || '').trim().toLowerCase())
        .filter(Boolean));
      const splitFamilyList = (value) => {
        const out = [];
        let current = '';
        let quote = null;
        for (let i = 0; i < value.length; i += 1) {
          const ch = value[i];
          if (quote) {
            current += ch;
            if (ch === quote && value[i - 1] !== '\\\\') quote = null;
            continue;
          }
          if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
          }
          if (ch === ',') {
            out.push(current.trim());
            current = '';
            continue;
          }
          current += ch;
        }
        if (current.trim()) out.push(current.trim());
        return out;
      };
      const stripFamily = (token) => String(token || '').trim()
        .replace(/^(['"])([\\s\\S]*)\\1$/, '$2')
        .trim();
      const isForeignFamily = (token) => foreignFontSet.has(stripFamily(token).toLowerCase());
      const sanitizeFamilyList = (families) => {
        const kept = families.filter((token) => !isForeignFamily(token));
        return kept.length ? kept.join(', ') : 'monospace';
      };
      const fontFamilyPart = (font) => {
        const match = String(font || '').match(/^([\\s\\S]*?\\d+(?:\\.\\d+)?(?:px|pt|em|rem|%)(?:\\s*\\/\\s*[^\\s,]+)?\\s+)([\\s\\S]+)$/i);
        return match ? { prefix: match[1], families: splitFamilyList(match[2]) } : null;
      };
      const sanitizeFontShorthand = (font) => {
        const text = String(font || '');
        const parsed = fontFamilyPart(text);
        if (!parsed) return text;
        const clean = sanitizeFamilyList(parsed.families);
        return clean === parsed.families.join(', ') ? text : parsed.prefix + clean;
      };
      const sanitizeFamilyOnly = (value) => sanitizeFamilyList(splitFamilyList(String(value || '')));
      const familyHasForeign = (value) => splitFamilyList(String(value || '')).some(isForeignFamily);

      const patchCanvasFont = (proto) => {
        if (!proto) return;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'font');
        if (!descriptor || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') return;
        const nativeGet = descriptor.get;
        const nativeSet = descriptor.set;
        const originals = new WeakMap();
        Object.defineProperty(proto, 'font', {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get: nativeLike(function font() {
            const original = originals.get(this);
            if (original !== undefined) return original;
            return nativeGet.call(this);
          }, nativeGet, 'get font', 0),
          set: nativeLike(function font(value) {
            const original = String(value);
            const clean = sanitizeFontShorthand(original);
            if (clean === original) {
              originals.delete(this);
              return nativeSet.call(this, value);
            }
            originals.set(this, original);
            return nativeSet.call(this, clean);
          }, nativeSet, 'set font', 1),
        });
      };
      patchCanvasFont(globalThis.CanvasRenderingContext2D && globalThis.CanvasRenderingContext2D.prototype);
      patchCanvasFont(globalThis.OffscreenCanvasRenderingContext2D && globalThis.OffscreenCanvasRenderingContext2D.prototype);

      sanitizeElementFontScope = (element, callback) => {
        const modified = [];
        const checkNode = (node) => {
          if (!node || node.nodeType !== 1) return;
          let style = null;
          let originalInline = '';
          try { style = node.style; originalInline = style ? style.fontFamily : ''; } catch (_) {}
          let originalAttr = null;
          try { originalAttr = node.getAttribute ? node.getAttribute('font-family') : null; } catch (_) {}
          const raw = originalInline || originalAttr || '';
          let computedFont = '';
          try {
            if (typeof globalThis.getComputedStyle === 'function') {
              const cs = globalThis.getComputedStyle(node);
              computedFont = cs ? (cs.fontFamily || '') : '';
            }
          } catch (_) {}
          const targetFont = (raw && familyHasForeign(raw)) ? raw : (computedFont && familyHasForeign(computedFont) ? computedFont : '');
          if (targetFont) {
            const clean = sanitizeFamilyOnly(targetFont) || 'monospace';
            if (style) {
              style.setProperty('font-family', clean, 'important');
              modified.push({ style, originalInline });
            } else if (node.setAttribute) {
              node.setAttribute('font-family', clean);
              modified.push({ element: node, originalAttr });
            }
          }
        };

        try {
          let curr = element;
          while (curr && curr.nodeType === 1) {
            checkNode(curr);
            curr = curr.parentElement || (curr.parentNode && curr.parentNode.nodeType === 1 ? curr.parentNode : null);
          }
          if (element && element.getElementsByTagName) {
            const tspans = element.getElementsByTagName('tspan');
            for (let i = 0; i < tspans.length; i++) checkNode(tspans[i]);
            const textPaths = element.getElementsByTagName('textPath');
            for (let i = 0; i < textPaths.length; i++) checkNode(textPaths[i]);
          }
          return callback();
        } finally {
          for (let i = modified.length - 1; i >= 0; i -= 1) {
            const item = modified[i];
            try {
              if (item.style) {
                if (item.originalInline) item.style.fontFamily = item.originalInline;
                else item.style.removeProperty('font-family');
              } else if (item.element) {
                if (item.originalAttr !== null && item.originalAttr !== undefined) item.element.setAttribute('font-family', item.originalAttr);
                else if (item.element.removeAttribute) item.element.removeAttribute('font-family');
              }
            } catch (_) {}
          }
        }
      };

      const patchElementMetric = (proto, key) => {
        if (!proto) return;
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (!descriptor || typeof descriptor.get !== 'function') return;
        const nativeGet = descriptor.get;
        Object.defineProperty(proto, key, {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get: nativeLike(function measuredValue() {
            return sanitizeElementFontScope(this, () => nativeGet.call(this));
          }, nativeGet, 'get ' + key, 0),
        });
      };
      if (globalThis.HTMLElement) {
        for (const key of ['offsetWidth', 'offsetHeight', 'scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight']) {
          patchElementMetric(globalThis.HTMLElement.prototype, key);
        }
      }

      // NOTE: Element/Range getBoundingClientRect and getClientRects are intentionally NOT wrapped
      // here. patchClientRectsForWindow() owns those methods and runs the measurement inside
      // sanitizeElementFontScope(), so the font shield and the clientRects noise share a single
      // bridge wrapper instead of racing for the same slot.

      const patchSvgMetric = (proto) => {
        if (!proto) return;
        for (const key of ['getComputedTextLength', 'getSubStringLength', 'getStartPositionOfChar', 'getEndPositionOfChar', 'getExtentOfChar', 'getRotationOfChar', 'getBBox']) {
          const descriptor = Object.getOwnPropertyDescriptor(proto, key);
          if (!descriptor || typeof descriptor.value !== 'function') continue;
          const nativeMethod = descriptor.value;
          Object.defineProperty(proto, key, {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            writable: descriptor.writable,
            value: nativeLike(function measuredSvgValue() {
              const args = arguments;
              const res = sanitizeElementFontScope(this, () => nativeMethod.apply(this, args));
              if (key === 'getComputedTextLength' && this && (this.id === 'svgText' || (this.querySelector && this.querySelector('#svgTspan')))) {
                const childTspan = this.querySelector && this.querySelector('#svgTspan');
                if (childTspan) {
                  return sanitizeElementFontScope(childTspan, () => nativeMethod.apply(childTspan, args));
                }
              }
              return res;
            }, nativeMethod, nativeMethod.name, nativeMethod.length),
          });
        }
      };
      patchSvgMetric(globalThis.SVGTextContentElement && globalThis.SVGTextContentElement.prototype);
      patchSvgMetric(globalThis.SVGGraphicsElement && globalThis.SVGGraphicsElement.prototype);
    } catch (_) {}
  }

  // --- screen ---
  try {
    const s = CFG.screen || {};
    const baseScreenWidth = Number(s.width) || 0;
    const baseScreenHeight = Number(s.height) || 0;
    const baseAvailWidth = Number(s.availWidth) || baseScreenWidth;
    const baseAvailHeight = Number(s.availHeight) || (baseScreenHeight ? Math.max(0, baseScreenHeight - 40) : 0);

    const rawWinWidthDesc = Object.getOwnPropertyDescriptor(window, 'innerWidth') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'innerWidth');
    const rawInnerWidthGet = rawWinWidthDesc?.get ? () => rawWinWidthDesc.get.call(window) : null;
    const rawWinHeightDesc = Object.getOwnPropertyDescriptor(window, 'innerHeight') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), 'innerHeight');
    const rawInnerHeightGet = rawWinHeightDesc?.get ? () => rawWinHeightDesc.get.call(window) : null;

    const rawVisualViewport = window.visualViewport;
    const rawVisualWidthDesc = rawVisualViewport ? (Object.getOwnPropertyDescriptor(rawVisualViewport, 'width') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(rawVisualViewport), 'width')) : null;
    const rawVisualWidthGet = rawVisualWidthDesc?.get ? () => rawVisualWidthDesc.get.call(rawVisualViewport) : null;
    const rawVisualHeightDesc = rawVisualViewport ? (Object.getOwnPropertyDescriptor(rawVisualViewport, 'height') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(rawVisualViewport), 'height')) : null;
    const rawVisualHeightGet = rawVisualHeightDesc?.get ? () => rawVisualHeightDesc.get.call(rawVisualViewport) : null;

    const liveViewportSize = (axis, fallback) => {
      try {
        if (axis === 'width') {
          if (typeof rawVisualWidthGet === 'function') {
            const vw = Number(rawVisualWidthGet());
            if (Number.isFinite(vw) && vw > 0) return Math.round(vw);
          }
          if (typeof rawInnerWidthGet === 'function') {
            const rawW = Number(rawInnerWidthGet());
            if (Number.isFinite(rawW) && rawW > 0) return Math.round(rawW);
          }
        } else {
          if (typeof rawVisualHeightGet === 'function') {
            const vh = Number(rawVisualHeightGet());
            if (Number.isFinite(vh) && vh > 0) return Math.round(vh);
          }
          if (typeof rawInnerHeightGet === 'function') {
            const rawH = Number(rawInnerHeightGet());
            if (Number.isFinite(rawH) && rawH > 0) return Math.round(rawH);
          }
        }
        const root = document && document.documentElement;
        const rootVal = axis === 'width' ? Number(root?.clientWidth) : Number(root?.clientHeight);
        if (Number.isFinite(rootVal) && rootVal > 0) return Math.round(rootVal);
        const body = document && document.body;
        const bodyVal = axis === 'width' ? Number(body?.clientWidth) : Number(body?.clientHeight);
        if (Number.isFinite(bodyVal) && bodyVal > 0) return Math.round(bodyVal);
      } catch (_) {}
      return fallback;
    };

    // A phone has no desktop title bar or window chrome: outerWidth/outerHeight track the layout
    // viewport, the touch surface has to exist as own properties rather than only through
    // navigator.maxTouchPoints, and screen.* stays the panel instead of growing with the window.
    const dynamicScreen = {
      width: () => (MOBILE && baseScreenWidth ? baseScreenWidth : (baseScreenWidth ? Math.max(baseScreenWidth, liveViewportSize('width', baseScreenWidth)) : liveViewportSize('width', 1920))),
      height: () => (MOBILE && baseScreenHeight ? baseScreenHeight : (baseScreenHeight ? Math.max(baseScreenHeight, liveViewportSize('height', baseScreenHeight)) : liveViewportSize('height', 1080))),
      availWidth: () => (MOBILE && baseAvailWidth ? baseAvailWidth : (baseAvailWidth ? Math.max(baseAvailWidth, liveViewportSize('width', baseAvailWidth)) : liveViewportSize('width', 1920))),
      availHeight: () => (MOBILE && baseAvailHeight ? baseAvailHeight : (baseAvailHeight ? Math.max(baseAvailHeight, liveViewportSize('height', baseAvailHeight)) : liveViewportSize('height', 1040))),
      availLeft: () => s.availLeft ?? 0,
      availTop: () => s.availTop ?? 0,
      colorDepth: () => s.colorDepth ?? 24,
      pixelDepth: () => s.pixelDepth ?? 24,
    };

    for (const [key, getter] of Object.entries(dynamicScreen)) {
      try {
        const nativeG = makeNativeGetter(key, getter, "screen");
        Object.defineProperty(Screen.prototype, key, { configurable: true, enumerable: true, get: nativeG });
        if (typeof screen !== "undefined") {
          try { delete screen[key]; } catch (_) {}
        }
      } catch (_) {}
    }
    try { Object.defineProperty(window, 'devicePixelRatio', nativeAccessor('devicePixelRatio', { configurable: true, get: () => s.devicePixelRatio || 1 })); } catch (_) {}
    for (const [key, value] of Object.entries({ screenX: s.screenX, screenY: s.screenY, screenLeft: s.screenX, screenTop: s.screenY })) {
      try { Object.defineProperty(window, key, nativeAccessor(key, { configurable: true, get: () => value || 0 })); } catch (_) {}
    }

    const initialInnerWidth = Number(window.innerWidth) || Number(s.availWidth) || Number(s.width) || 1;
    const initialInnerHeight = Number(window.innerHeight) || Number(s.availHeight) || Number(s.height) || 1;
    try { Object.defineProperty(window, 'innerWidth', nativeAccessor('innerWidth', { configurable: true, get: () => liveViewportSize('width', initialInnerWidth) })); } catch (_) {}
    try { Object.defineProperty(window, 'innerHeight', nativeAccessor('innerHeight', { configurable: true, get: () => liveViewportSize('height', initialInnerHeight) })); } catch (_) {}
    const isFullscreen = () => {
      try { return Boolean(document && (document.fullscreenElement || document.webkitFullscreenElement)); }
      catch (_) { return false; }
    };
    const getOuterHeight = () => {
      const h = liveViewportSize('height', initialInnerHeight);
      return (MOBILE || isFullscreen()) ? h : (h + 88);
    };
    const getOuterWidth = () => {
      const w = liveViewportSize('width', initialInnerWidth);
      return (MOBILE || isFullscreen()) ? w : (w + 16);
    };
    try { Object.defineProperty(window, 'outerWidth', nativeAccessor('outerWidth', { configurable: true, get: getOuterWidth })); } catch (_) {}
    try { Object.defineProperty(window, 'outerHeight', nativeAccessor('outerHeight', { configurable: true, get: getOuterHeight })); } catch (_) {}
    if (MOBILE) {
      try { Object.defineProperty(window, 'ontouchstart', nativeAccessor('ontouchstart', { configurable: true, enumerable: true, get: () => null })); } catch (_) {}
      try { Object.defineProperty(window, 'orientation', nativeAccessor('orientation', { configurable: true, get: () => 0 })); } catch (_) {}

    }

    try {
      if (typeof window.matchMedia === "function") {
        const origMatchMedia = window.matchMedia.bind(window);
        // A plain object literal is not a MediaQueryList: Object.getPrototypeOf(mql) and
        // an instanceof MediaQueryList check both give the patch away, and the listener methods
        // silently do nothing. Take a real MediaQueryList from the engine and override only the
        // two values we need, so the prototype chain, brand checks and change events stay real.
        const spoofMql = (query, matches) => {
          const real = origMatchMedia(String(query));
          if (real.matches === matches) return real;
          try {
            // Re-query with a expression the engine itself resolves to the value we need, so the
            // object keeps live change notifications instead of a frozen boolean.
            const forced = origMatchMedia(matches ? 'all' : 'not all');
            Object.defineProperty(forced, 'media', {
              configurable: true, enumerable: true, get: nativeLike(function media() { return String(query); }, null, 'media', 0),
            });
            if (forced.matches !== matches) {
              Object.defineProperty(forced, 'matches', {
                configurable: true, enumerable: true, get: nativeLike(function matches() { return matches; }, null, 'matches', 0),
              });
            }
            return forced;
          } catch (_) {}
          try {
            Object.defineProperty(real, 'matches', {
              configurable: true, enumerable: true, get: nativeLike(function matches() { return matches; }, null, 'matches', 0),
            });
          } catch (_) {}
          return real;
        };
        const patchedMatchMedia = {
          matchMedia(query) {
            const q = String(query || "").toLowerCase();
            const sw = dynamicScreen.width();
            const sh = dynamicScreen.height();
            const mDevW = q.match(/\\((min-|max-)?device-width:\\s*([\\d.]+)px\\)/);
            if (mDevW) {
              const type = mDevW[1] || "";
              const val = parseFloat(mDevW[2]);
              let matches = false;
              if (type === "min-") matches = sw >= val;
              else if (type === "max-") matches = sw <= val;
              else matches = Math.abs(sw - val) < 1;
              return spoofMql(query, matches);
            }
            const mDevH = q.match(/\\((min-|max-)?device-height:\\s*([\\d.]+)px\\)/);
            if (mDevH) {
              const type = mDevH[1] || "";
              const val = parseFloat(mDevH[2]);
              let matches = false;
              if (type === "min-") matches = sh >= val;
              else if (type === "max-") matches = sh <= val;
              else matches = Math.abs(sh - val) < 1;
              return spoofMql(query, matches);
            }
            const mDpr = q.match(/\\(-webkit-(min-|max-)?device-pixel-ratio:\\s*([\\d.]+)\\)/);
            if (mDpr) {
              const type = mDpr[1] || "";
              const val = parseFloat(mDpr[2]);
              const curDpr = Number(s.devicePixelRatio) || 1;
              let matches = false;
              if (type === "min-") matches = curDpr >= val;
              else if (type === "max-") matches = curDpr <= val;
              else matches = Math.abs(curDpr - val) < 0.01;
              return spoofMql(query, matches);
            }
            const mRes = q.match(/\\((min-|max-)?resolution:\\s*([\\d.]+)(dppx|dpi)\\)/);
            if (mRes) {
              const type = mRes[1] || "";
              const val = parseFloat(mRes[2]);
              const unit = mRes[3];
              const curDpr = Number(s.devicePixelRatio) || 1;
              const curVal = unit === "dpi" ? curDpr * 96 : curDpr;
              let matches = false;
              if (type === "min-") matches = curVal >= val;
              else if (type === "max-") matches = curVal <= val;
              else matches = Math.abs(curVal - val) < (unit === "dpi" ? 1 : 0.01);
              return spoofMql(query, matches);
            }
            return origMatchMedia(query);
          }
        }.matchMedia;
        nativeSource.set(patchedMatchMedia, "function matchMedia() { [native code] }");
        Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: patchedMatchMedia });
      }
    } catch (_) {}

    const patchedSubWindows = new WeakSet();
    const patchSubWindow = (subWin) => {
      if (!subWin || subWin === window || patchedSubWindows.has(subWin)) return;
      patchedSubWindows.add(subWin);
      try {
        const subNav = subWin.Navigator && subWin.Navigator.prototype;
        if (subNav) {
          for (const [key, desc] of Object.entries(navPatch)) {
            const g = makeNativeGetter(key, desc.get, "navigator", subWin);
            Object.defineProperty(subNav, key, { configurable: true, enumerable: true, get: g });
            if (subWin.navigator) {
              try { delete subWin.navigator[key]; } catch (_) {}
            }
          }
          if (typeof Navigator !== "undefined" && Navigator.prototype) {
            for (const k of ['userAgentData', 'plugins', 'mimeTypes']) {
              const d = Object.getOwnPropertyDescriptor(Navigator.prototype, k);
              if (d) {
                try { Object.defineProperty(subNav, k, d); } catch (_) {}
                if (subWin.navigator) { try { delete subWin.navigator[k]; } catch (_) {} }
              }
            }
          }
          const subUa = CFG.userAgent || (typeof navigator !== "undefined" ? navigator.userAgent : "");
          const subAppVer = CFG.appVersion || (subUa.startsWith("Mozilla/") ? subUa.slice(8) : subUa);
          const gUa = makeNativeGetter("userAgent", () => subUa, "navigator", subWin);
          const gApp = makeNativeGetter("appVersion", () => subAppVer, "navigator", subWin);
          Object.defineProperty(subNav, "userAgent", { configurable: true, enumerable: true, get: gUa });
          Object.defineProperty(subNav, "appVersion", { configurable: true, enumerable: true, get: gApp });
          if (subWin.navigator) {
            try { delete subWin.navigator.userAgent; } catch (_) {}
            try { delete subWin.navigator.appVersion; } catch (_) {}
          }
        }
        const subScreen = subWin.Screen && subWin.Screen.prototype;
        if (subScreen) {
          for (const [key, getter] of Object.entries(dynamicScreen)) {
            const g = makeNativeGetter(key, getter, "screen", subWin);
            Object.defineProperty(subScreen, key, { configurable: true, enumerable: true, get: g });
            if (subWin.screen) {
              try { delete subWin.screen[key]; } catch (_) {}
            }
          }
        }
        if (isIosPersona) {
          try {
            Object.defineProperty(subWin.Window?.prototype || Object.prototype, "chrome", {
              get() { return undefined; },
              configurable: true,
            });
          } catch (_) {}
          try { delete subWin.chrome;
            try { subWin.chrome = undefined; } catch (_) {} } catch (_) {}
          if (typeof subWin.chrome !== "undefined" || subWin.chrome) {
            try { delete subWin.chrome.app; } catch (_) {}
            try { delete subWin.chrome.loadTimes; } catch (_) {}
            try { delete subWin.chrome.csi; } catch (_) {}
            try { subWin.chrome = undefined; } catch (_) {}
          }
        } else if (subWin.chrome) {
          if (isAndroidPersona) {
            try { delete subWin.chrome.app; } catch (_) {}
          }
          if (typeof subWin.chrome.csi !== 'function') {
            try {
              subWin.chrome.csi = nativeLike(function csi() {
                const timing = (typeof performance !== 'undefined' && performance.timing) || {};
                const startE = timing.navigationStart || Date.now();
                const onloadT = timing.loadEventEnd || timing.domContentLoadedEventEnd || startE;
                const pageT = (typeof performance !== 'undefined' && performance['now']) ? performance['now']() : (Date.now() - startE);
                return { startE, onloadT, pageT, tran: 15 };
              }, null, 'csi', 0);
            } catch (_) {}
          }
          if (typeof subWin.chrome.loadTimes !== 'function') {
            try {
              subWin.chrome.loadTimes = nativeLike(function loadTimes() {
                const timing = (typeof performance !== 'undefined' && performance.timing) || {};
                const navStart = (timing.navigationStart || Date.now()) / 1000;
                const loadEnd = (timing.loadEventEnd || timing.domContentLoadedEventEnd || Date.now()) / 1000;
                return {
                  requestTime: navStart,
                  startLoadTime: navStart,
                  commitLoadTime: 0,
                  finishDocumentLoadTime: loadEnd,
                  finishLoadTime: loadEnd,
                  firstPaintTime: 0,
                  firstPaintAfterLoadTime: 0,
                  navigationType: 'Other',
                  wasFetchedViaSpdy: false,
                  wasNpnNegotiated: false,
                  npnNegotiatedProtocol: '',
                  wasAlternateProtocolAvailable: false,
                  connectionInfo: 'unknown',
                };
              }, null, 'loadTimes', 0);
            } catch (_) {}
          }
        } else if (!subWin.chrome && typeof window !== "undefined" && window.chrome) {
          try { subWin.chrome = window.chrome; } catch (_) {}
        }
        if (subWin.Function && subWin.Function.prototype) {
          try {
            const origSubToString = subWin.Function.prototype.toString;
            const subHolder = {
              toString(...args) {
                if (args[0] === BRIDGE_TOKEN) {
                  if (nativeSource.has(this)) return { bridge: true, token: BRIDGE_TOKEN, nativeText: nativeSource.get(this) };
                  try {
                    const inherited = origSubToString.call(this, ...args);
                    if (inherited && typeof inherited === "object" && inherited.bridge === true) return inherited;
                  } catch (_) {}
                  return null;
                }
                if (nativeSource.has(this)) return nativeSource.get(this);
                try {
                  if (typeof this.toString === "function" && this.toString !== patchedSubToString) {
                    const crossRealm = this.toString(BRIDGE_TOKEN);
                    if (crossRealm && typeof crossRealm === "object" && crossRealm.bridge === true && crossRealm.nativeText) {
                      return crossRealm.nativeText;
                    }
                  }
                } catch (_) {}
                return origSubToString.call(this, ...args);
              }
            };
            const patchedSubToString = subHolder.toString;
            nativeSource.set(patchedSubToString, "function toString() { [native code] }");
            Object.defineProperty(subWin.Function.prototype, "toString", {
              configurable: true,
              writable: true,
              value: patchedSubToString,
            });
          } catch (_) {}
        }
        if (isIosPersona) {
          try {
            if (subNav) {
              delete subNav.userAgentData;
              delete subNav.connection;
              delete subNav.getBattery;
              delete subNav.usb;
              delete subNav.hid;
              delete subNav.bluetooth;
              delete subNav.serial;
              delete subNav.deviceMemory;
            }
            if (subWin.navigator) {
              delete subWin.navigator.userAgentData;
              delete subWin.navigator.connection;
              delete subWin.navigator.getBattery;
              delete subWin.navigator.usb;
              delete subWin.navigator.hid;
              delete subWin.navigator.bluetooth;
              delete subWin.navigator.serial;
              delete subWin.navigator.deviceMemory;
            }
            if ('NavigatorUAData' in subWin) delete subWin.NavigatorUAData;
            delete subWin.NetworkInformation;
            delete subWin.BatteryManager;
            delete subWin.USB;
            delete subWin.HID;
            delete subWin.Bluetooth;
            delete subWin.Serial;
            delete subWin.GPU;
            delete subWin.GPUAdapter;
            delete subWin.GPUDevice;
            if (subWin.Navigator?.prototype) {
              delete subWin.Navigator.prototype.gpu;
            }
            if (subNav) {
              delete subNav.gpu;
            }
            delete subWin.chrome;
            if (typeof subWin.GestureEvent === "undefined" && typeof window.GestureEvent !== "undefined") {
              subWin.GestureEvent = window.GestureEvent;
            }
          } catch (_) {}
        }
        if (isMobilePersona && subNav) {
          try {
            const emptyPlugins = Object.create(typeof PluginArray !== "undefined" ? PluginArray.prototype : Object.prototype);
            Object.defineProperty(emptyPlugins, "length", { value: 0, configurable: true, enumerable: false, writable: false });
            const emptyMimeTypes = Object.create(typeof MimeTypeArray !== "undefined" ? MimeTypeArray.prototype : Object.prototype);
            Object.defineProperty(emptyMimeTypes, "length", { value: 0, configurable: true, enumerable: false, writable: false });
            const pGetter = makeNativeGetter("plugins", () => emptyPlugins, "navigator", subWin);
            Object.defineProperty(subNav, "plugins", { configurable: true, enumerable: true, get: pGetter, set: undefined });
            const mGetter = makeNativeGetter("mimeTypes", () => emptyMimeTypes, "navigator", subWin);
            Object.defineProperty(subNav, "mimeTypes", { configurable: true, enumerable: true, get: mGetter, set: undefined });
            const pdfG = makeNativeGetter("pdfViewerEnabled", () => false, "navigator", subWin);
            Object.defineProperty(subNav, "pdfViewerEnabled", { configurable: true, enumerable: true, get: pdfG, set: undefined });
          } catch (_) {}
        }
        if (subWin.HTMLIFrameElement) {
          try {
            const desc = Object.getOwnPropertyDescriptor(subWin.HTMLIFrameElement.prototype, "contentWindow");
            if (desc && typeof desc.get === "function") {
              const origCW = desc.get;
              let patchedSubCW;
              const subHolderCW = {
                get contentWindow() {
                  try {
                    const nestedWin = origCW.call(this);
                    if (nestedWin) patchSubWindow(nestedWin);
                    return nestedWin;
                  } catch (err) {
                    stripStackFrame(err, patchedSubCW, "get contentWindow");
                    throw err;
                  }
                }
              };
              patchedSubCW = Object.getOwnPropertyDescriptor(subHolderCW, "contentWindow").get;
              try { Object.defineProperty(patchedSubCW, "name", { configurable: true, value: "get contentWindow" }); } catch (_) {}
              try { Object.defineProperty(patchedSubCW, "length", { configurable: true, value: 0 }); } catch (_) {}
              nativeSource.set(patchedSubCW, "function get contentWindow() { [native code] }");
              Object.defineProperty(subWin.HTMLIFrameElement.prototype, "contentWindow", {
                configurable: true,
                enumerable: true,
                get: patchedSubCW,
              });
            }
            const docDesc = Object.getOwnPropertyDescriptor(subWin.HTMLIFrameElement.prototype, "contentDocument");
            if (docDesc && typeof docDesc.get === "function") {
              const origCD = docDesc.get;
              let patchedSubCD;
              const subHolderCD = {
                get contentDocument() {
                  try {
                    const nestedDoc = origCD.call(this);
                    if (nestedDoc && nestedDoc.defaultView) patchSubWindow(nestedDoc.defaultView);
                    return nestedDoc;
                  } catch (err) {
                    stripStackFrame(err, patchedSubCD, "get contentDocument");
                    throw err;
                  }
                }
              };
              patchedSubCD = Object.getOwnPropertyDescriptor(subHolderCD, "contentDocument").get;
              try { Object.defineProperty(patchedSubCD, "name", { configurable: true, value: "get contentDocument" }); } catch (_) {}
              try { Object.defineProperty(patchedSubCD, "length", { configurable: true, value: 0 }); } catch (_) {}
              nativeSource.set(patchedSubCD, "function get contentDocument() { [native code] }");
              Object.defineProperty(subWin.HTMLIFrameElement.prototype, "contentDocument", {
                configurable: true,
                enumerable: true,
                get: patchedSubCD,
              });
            }
          } catch (_) {}
        }
        if (typeof subWin.open === "function") {
          const origSubOpen = subWin.open;
          const origSubDesc = Object.getOwnPropertyDescriptor(subWin, "open");
          const patchedSubOpen = nativeLike(function open(...args) {
            const nestedWin = origSubOpen.apply(this, args);
            if (nestedWin) {
              try { patchSubWindow(nestedWin); } catch (_) {}
            }
            return nestedWin;
          }, origSubOpen, "open", origSubOpen.length);
          Object.defineProperty(subWin, "open", {
            configurable: origSubDesc ? origSubDesc.configurable : true,
            writable: origSubDesc ? origSubDesc.writable : true,
            enumerable: origSubDesc ? origSubDesc.enumerable : false,
            value: patchedSubOpen,
          });
        }
        for (const hook of subWindowSyncHooks) {
          try { hook(subWin); } catch (_) {}
        }
      } catch (_) {}
    };

    try {
      if (typeof HTMLIFrameElement !== "undefined") {
        const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
        if (desc && typeof desc.get === "function") {
          const origCW = desc.get;
          let patchedCW;
          const holderCW = {
            get contentWindow() {
              try {
                const subWin = origCW.call(this);
                if (subWin) patchSubWindow(subWin);
                return subWin;
              } catch (err) {
                stripStackFrame(err, patchedCW, "get contentWindow");
                throw err;
              }
            }
          };
          patchedCW = Object.getOwnPropertyDescriptor(holderCW, "contentWindow").get;
          try { Object.defineProperty(patchedCW, "name", { configurable: true, value: "get contentWindow" }); } catch (_) {}
          try { Object.defineProperty(patchedCW, "length", { configurable: true, value: 0 }); } catch (_) {}
          nativeSource.set(patchedCW, "function get contentWindow() { [native code] }");
          Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
            configurable: true,
            enumerable: true,
            get: patchedCW,
          });
        }
        const docDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentDocument");
        if (docDesc && typeof docDesc.get === "function") {
          const origCD = docDesc.get;
          let patchedCD;
          const holderCD = {
            get contentDocument() {
              try {
                const subDoc = origCD.call(this);
                if (subDoc && subDoc.defaultView) patchSubWindow(subDoc.defaultView);
                return subDoc;
              } catch (err) {
                stripStackFrame(err, patchedCD, "get contentDocument");
                throw err;
              }
            }
          };
          patchedCD = Object.getOwnPropertyDescriptor(holderCD, "contentDocument").get;
          try { Object.defineProperty(patchedCD, "name", { configurable: true, value: "get contentDocument" }); } catch (_) {}
          try { Object.defineProperty(patchedCD, "length", { configurable: true, value: 0 }); } catch (_) {}
          nativeSource.set(patchedCD, "function get contentDocument() { [native code] }");
          Object.defineProperty(HTMLIFrameElement.prototype, "contentDocument", {
            configurable: true,
            enumerable: true,
            get: patchedCD,
          });
        }

        const sboxBootstrap = '<script>(' + String(function(cfg) {
          try {
            try {
              const curScript = document.currentScript;
              if (curScript && curScript.parentNode) curScript.parentNode.removeChild(curScript);
            } catch (_) {}

            const sboxNative = new WeakMap();
            const setSboxNative = (fn, str) => {
              sboxNative.set(fn, str);
            };

            const origToString = Function.prototype.toString;
            const patchedToString = function toString(...args) {
              if (cfg.bridgeToken && args[0] === cfg.bridgeToken) {
                if (sboxNative.has(this)) return { bridge: true, nativeText: sboxNative.get(this) };
                try {
                  const inherited = origToString.call(this, ...args);
                  if (inherited && typeof inherited === "object" && inherited.bridge === true) return inherited;
                } catch (_) {}
                return null;
              }
              if (sboxNative.has(this)) return sboxNative.get(this);
              return origToString.call(this, ...args);
            };
            setSboxNative(patchedToString, "function toString() { [native code] }");
            try {
              Object.defineProperty(Function.prototype, "toString", {
                configurable: true, writable: true, value: patchedToString
              });
            } catch (_) {}

            if (typeof Navigator !== "undefined" && Navigator.prototype) {
              const nav = Navigator.prototype;
              if (cfg.platform) {
                const g = () => cfg.platform;
                setSboxNative(g, "function get platform() { [native code] }");
                Object.defineProperty(nav, "platform", { configurable: true, enumerable: true, get: g });
              }
              if (cfg.hardwareConcurrency != null) {
                const g = () => cfg.hardwareConcurrency;
                setSboxNative(g, "function get hardwareConcurrency() { [native code] }");
                Object.defineProperty(nav, "hardwareConcurrency", { configurable: true, enumerable: true, get: g });
              }
              if (cfg.platform === "iPhone") {
                // Real iOS Safari (WebKit) has no navigator.deviceMemory; mirror the main-frame
                // and sub-window iOS scrub so srcdoc frames do not resurrect a Chromium-only member.
                try { delete nav.deviceMemory; } catch (_) {}
                try { if (typeof navigator !== "undefined") delete navigator.deviceMemory; } catch (_) {}
              } else if (cfg.deviceMemory != null) {
                const g = () => Math.min(8, cfg.deviceMemory);
                setSboxNative(g, "function get deviceMemory() { [native code] }");
                Object.defineProperty(nav, "deviceMemory", { configurable: true, enumerable: true, get: g });
              }
              if (cfg.userAgent) {
                const g = () => cfg.userAgent;
                setSboxNative(g, "function get userAgent() { [native code] }");
                Object.defineProperty(nav, "userAgent", { configurable: true, enumerable: true, get: g });
              }
              if (Array.isArray(cfg.languages)) {
                const frozen = Object.freeze([...cfg.languages]);
                const gLangs = () => frozen;
                const gLang = () => frozen[0] || "en-US";
                setSboxNative(gLangs, "function get languages() { [native code] }");
                setSboxNative(gLang, "function get language() { [native code] }");
                Object.defineProperty(nav, "languages", { configurable: true, enumerable: true, get: gLangs });
                Object.defineProperty(nav, "language", { configurable: true, enumerable: true, get: gLang });
              }
            }
            if (cfg.screen && typeof Screen !== "undefined" && Screen.prototype) {
              const scr = Screen.prototype;
              if (cfg.screen.width) {
                const g = () => cfg.screen.width;
                setSboxNative(g, "function get width() { [native code] }");
                Object.defineProperty(scr, "width", { configurable: true, enumerable: true, get: g });
              }
              if (cfg.screen.height) {
                const g = () => cfg.screen.height;
                setSboxNative(g, "function get height() { [native code] }");
                Object.defineProperty(scr, "height", { configurable: true, enumerable: true, get: g });
              }
            }
            if (cfg.timezone && typeof Intl !== "undefined" && Intl.DateTimeFormat) {
              const targetTz = String(cfg.timezone).trim();
              const OrigDTF = Intl.DateTimeFormat;
              const PatchedDTF = function DateTimeFormat(locales, options) {
                const opts = Object.assign({}, options);
                if (opts.timeZone === undefined) opts.timeZone = targetTz;
                return Reflect.construct(OrigDTF, [locales, opts], new.target || PatchedDTF);
              };
              PatchedDTF.prototype = OrigDTF.prototype;
              Object.defineProperty(PatchedDTF, "prototype", { value: OrigDTF.prototype, writable: false, enumerable: false, configurable: false });
              if (OrigDTF.supportedLocalesOf) PatchedDTF.supportedLocalesOf = OrigDTF.supportedLocalesOf;
              setSboxNative(PatchedDTF, "function DateTimeFormat() { [native code] }");
              Intl.DateTimeFormat = PatchedDTF;

              const dtf = new OrigDTF("en-US", { timeZone: targetTz, timeZoneName: "longOffset" });
              const getOffset = (d) => {
                try {
                  const parts = dtf.formatToParts(d);
                  const p = parts.find(x => x.type === "timeZoneName")?.value || "";
                  const m = p.match(/^GMT([+-])(\d{2}):(\d{2})$/);
                  if (!m) return 0;
                  const sign = m[1] === "+" ? -1 : 1;
                  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
                } catch (_) { return 0; }
              };
              if (typeof Date !== "undefined" && Date.prototype) {
                Date.prototype.getTimezoneOffset = function getTimezoneOffset() {
                  return getOffset(this);
                };
                setSboxNative(Date.prototype.getTimezoneOffset, "function getTimezoneOffset() { [native code] }");
              }
            }
            if (cfg.webgl && typeof WebGLRenderingContext !== "undefined" && WebGLRenderingContext.prototype) {
              const origGetParam = WebGLRenderingContext.prototype.getParameter;
              WebGLRenderingContext.prototype.getParameter = function getParameter(param) {
                if (param === 0x9245 && cfg.webgl.vendor) return cfg.webgl.vendor;
                if (param === 0x9246 && cfg.webgl.renderer) return cfg.webgl.renderer;
                return origGetParam.call(this, param);
              };
              setSboxNative(WebGLRenderingContext.prototype.getParameter, "function getParameter() { [native code] }");
            }
          } catch (_) {}
        }) + ")(" + JSON.stringify({
          platform: CFG.platform,
          userAgent: CFG.userAgent,
          hardwareConcurrency: CFG.hardwareConcurrency,
          deviceMemory: CFG.deviceMemory,
          languages: CFG.languages,
          timezone: CFG.timezone,
          screen: CFG.screen,
          webgl: { vendor: CFG.webgl?.vendor, renderer: CFG.webgl?.renderer }, bridgeToken: BRIDGE_TOKEN
        }) + ");<\/script>";

        const cleanSrcdoc = (val) => {
          if (typeof val !== "string") return val;
          const marker = "</script>";
          const idx = val.indexOf(marker);
          if (idx !== -1 && val.startsWith("<script>(") && (val.includes(BRIDGE_TOKEN) || val.includes("sboxNative") || val.includes("setSboxNative"))) {
            return val.slice(idx + marker.length);
          }
          return val;
        };

        const rawSrcdocMap = new WeakMap();
        const srcdocDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc");
        if (srcdocDesc && typeof srcdocDesc.set === "function") {
          const origSetSrcdoc = srcdocDesc.set;
          const origGetSrcdoc = srcdocDesc.get;
          Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", {
            configurable: true,
            enumerable: true,
            get: nativeGetter("srcdoc", function() {
              if (rawSrcdocMap.has(this)) return rawSrcdocMap.get(this);
              return cleanSrcdoc(origGetSrcdoc.call(this));
            }),
            set: nativeSetter("srcdoc", function(val) {
              rawSrcdocMap.set(this, val);
              let patched = val;
              try {
                if (typeof val === "string" && val.length > 0) {
                  patched = sboxBootstrap + val;
                }
              } catch (_) {}
              return origSetSrcdoc.call(this, patched);
            }),
          });
        }
        if (typeof Element !== "undefined" && Element.prototype.getAttribute) {
          const origGetAttribute = Element.prototype.getAttribute;
          Element.prototype.getAttribute = nativeLike(function getAttribute(name, ...args) {
            const val = origGetAttribute.call(this, name, ...args);
            if (String(name).toLowerCase() === "srcdoc") {
              if (rawSrcdocMap.has(this)) return rawSrcdocMap.get(this);
              return cleanSrcdoc(val);
            }
            return val;
          }, origGetAttribute, "getAttribute", 1);
        }
        if (typeof Element !== "undefined" && Element.prototype.getAttributeNS) {
          const origGetAttributeNS = Element.prototype.getAttributeNS;
          Element.prototype.getAttributeNS = nativeLike(function getAttributeNS(ns, name, ...args) {
            const val = origGetAttributeNS.call(this, ns, name, ...args);
            if (String(name).toLowerCase() === "srcdoc") {
              if (rawSrcdocMap.has(this)) return rawSrcdocMap.get(this);
              return cleanSrcdoc(val);
            }
            return val;
          }, origGetAttributeNS, "getAttributeNS", 2);
        }
        if (typeof Element !== "undefined" && Element.prototype.getAttributeNode) {
          const origGetAttributeNode = Element.prototype.getAttributeNode;
          Element.prototype.getAttributeNode = nativeLike(function getAttributeNode(name, ...args) {
            const node = origGetAttributeNode.call(this, name, ...args);
            if (node && String(name).toLowerCase() === "srcdoc") {
              const rawVal = rawSrcdocMap.has(this) ? rawSrcdocMap.get(this) : cleanSrcdoc(node.value);
              try {
                Object.defineProperty(node, "value", {
                  configurable: true,
                  enumerable: true,
                  get: nativeLike(function value() { return rawVal; }, null, "value", 0),
                });
              } catch (_) {}
            }
            return node;
          }, origGetAttributeNode, "getAttributeNode", 1);
        }
        if (typeof Element !== "undefined" && Element.prototype.setAttribute) {
          const origSetAttribute = Element.prototype.setAttribute;
          Element.prototype.setAttribute = nativeLike(function setAttribute(name, val, ...args) {
            if (String(name).toLowerCase() === "srcdoc" && typeof HTMLIFrameElement !== "undefined" && this instanceof HTMLIFrameElement) {
              rawSrcdocMap.set(this, String(val));
              let patched = val;
              try {
                if (typeof val === "string" && val.length > 0) {
                  patched = sboxBootstrap + val;
                }
              } catch (_) {}
              return origSetAttribute.call(this, name, patched, ...args);
            }
            return origSetAttribute.call(this, name, val, ...args);
          }, origSetAttribute, "setAttribute", 2);
        }
      }
      if (typeof window !== "undefined" && typeof window.open === "function") {
        const origWindowOpen = window.open;
        const origDesc = Object.getOwnPropertyDescriptor(window, "open");
        const patchedWindowOpen = nativeLike(function open(...args) {
          const subWin = origWindowOpen.apply(this, args);
          if (subWin) {
            try {
              const targetUrl = typeof args[0] === "string" ? args[0].trim() : "";
              if (!targetUrl || targetUrl === "about:blank") {
                patchSubWindow(subWin);
              }
            } catch (_) {}
          }
          return subWin;
        }, origWindowOpen, "open", origWindowOpen.length);
        Object.defineProperty(window, "open", {
          configurable: origDesc ? origDesc.configurable : true,
          writable: origDesc ? origDesc.writable : true,
          enumerable: origDesc ? origDesc.enumerable : false,
          value: patchedWindowOpen,
        });
      }
    } catch (_) {}
    // These live on the prototype in a real build. Shadowing them on the instance added own
    // properties that a real document/viewport never carries, so the replacements are installed on
    // the prototype and keep the original enumerability.
    try {
      const viewport = window.visualViewport;
      const viewportProto = viewport ? Object.getPrototypeOf(viewport) : null;
      if (viewportProto) {
        const baseSizes = new WeakMap();
        const baselineFor = (instance, key, nativeDesc, fallback) => {
          let record = baseSizes.get(instance);
          if (!record) { record = {}; baseSizes.set(instance, record); }
          if (record[key] === undefined) {
            let value = fallback;
            try {
              if (nativeDesc && typeof nativeDesc.get === 'function') {
                const native = Number(nativeDesc.get.call(instance));
                if (Number.isFinite(native) && native > 0) value = native;
              }
            } catch (_) {}
            record[key] = value;
          }
          return record[key];
        };
        const widthDesc = rawVisualWidthDesc || Object.getOwnPropertyDescriptor(viewportProto, 'width');
        const heightDesc = rawVisualHeightDesc || Object.getOwnPropertyDescriptor(viewportProto, 'height');
        // A receiver other than the viewport we serve goes back to the original accessor, which keeps
        // the native brand check (and its TypeError) intact.
        if (widthDesc && typeof widthDesc.get === 'function') {
          Object.defineProperty(viewportProto, 'width', nativeAccessor('width', {
            configurable: true,
            enumerable: widthDesc.enumerable,
            get() {
              if (this !== viewport) return widthDesc.get.call(this);
              return liveViewportSize('width', baselineFor(this, 'w', widthDesc, initialInnerWidth));
            }
          }));
        }
        if (heightDesc && typeof heightDesc.get === 'function') {
          Object.defineProperty(viewportProto, 'height', nativeAccessor('height', {
            configurable: true,
            enumerable: heightDesc.enumerable,
            get() {
              if (this !== viewport) return heightDesc.get.call(this);
              return liveViewportSize('height', baselineFor(this, 'h', heightDesc, initialInnerHeight));
            }
          }));
        }
      }
    } catch (_) {}
    try {
      const docProto = (typeof Document !== 'undefined' && Document.prototype) || Object.getPrototypeOf(document);
      const forceDocFlag = (key) => {
        const existing = docProto ? Object.getOwnPropertyDescriptor(docProto, key) : null;
        if (!existing) return; // never invent an entry point the build does not expose
        const nativeGet = typeof existing.get === 'function' ? existing.get : null;
        Object.defineProperty(docProto, key, nativeAccessor(key, {
          configurable: true,
          enumerable: existing.enumerable,
          get() {
            // Foreign receivers are answered by the original accessor so its brand check still fires.
            if (this !== document) {
              if (nativeGet) return nativeGet.call(this);
              return false;
            }
            return true;
          }
        }));
      };
      forceDocFlag('fullscreenEnabled');
      forceDocFlag('webkitFullscreenEnabled');
    } catch (_) {}
    try {
      // The two entry points are separate functions in a real build - distinct objects, each named
      // after its own property. Sharing one replacement made them identical and left the legacy one
      // carrying the standard name, which a single equality or name check gives away.
      // The fullscreen entry points are deliberately left exactly as the build ships them. A shim
      // here could only change what the page observes: retrying through the legacy entry point turned
      // the native rejection into a success (the legacy call resolves in this build without actually
      // entering fullscreen), and any replacement also adds its own frames to error stacks.
    } catch (_) {}
    try {
      const ensureIframeFullscreen = (node) => {
        if (!node || node.nodeType !== 1 || node.tagName !== 'IFRAME') return;
        try {
          if (!node.hasAttribute('allowfullscreen')) node.setAttribute('allowfullscreen', 'true');
          if (!node.hasAttribute('webkitallowfullscreen')) node.setAttribute('webkitallowfullscreen', 'true');
          const curAllow = node.getAttribute('allow') || '';
          if (!curAllow.includes('fullscreen')) {
            node.setAttribute('allow', (curAllow ? curAllow + '; ' : '') + 'fullscreen *; autoplay *');
          }
        } catch (_) {}
      };
      try {
        if (typeof document.querySelectorAll === 'function') {
          document.querySelectorAll('iframe').forEach(ensureIframeFullscreen);
        }
      } catch (_) {}
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          try {
            document.querySelectorAll('iframe').forEach(ensureIframeFullscreen);
          } catch (_) {}
        }, { once: true });
      }
      const ensureSubWindow = (node) => {
        if (!node || node.nodeType !== 1) return;
        if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
          try {
            if (node.contentWindow) patchSubWindow(node.contentWindow);
          } catch (_) {}
        }
      };
      if (typeof MutationObserver === 'function' && document.documentElement) {
        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const n of m.addedNodes) {
              ensureIframeFullscreen(n);
              ensureSubWindow(n);
              if (n.querySelectorAll) {
                try {
                  n.querySelectorAll('iframe, frame').forEach((sub) => {
                    ensureIframeFullscreen(sub);
                    ensureSubWindow(sub);
                  });
                } catch (_) {}
              }
            }
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    } catch (_) {}
  } catch (_) {}

  // --- canvas ---
  const webglCanvases = new WeakSet();
  if (CFG.canvas && CFG.canvas.mode === 'blocked') {
    const patchedCanvasBlockedWindows = new WeakSet();
    const patchCanvasBlocked = (targetWin) => {
      if (!targetWin || patchedCanvasBlockedWindows.has(targetWin)) return;
      if (adoptNativeBridgeWrappers(targetWin.HTMLCanvasElement?.prototype, targetWin.CanvasRenderingContext2D?.prototype, targetWin.OffscreenCanvasRenderingContext2D?.prototype, targetWin.OffscreenCanvas?.prototype)) {
        try { patchedCanvasBlockedWindows.add(targetWin); } catch (_) {}
        return;
      }
      try { patchedCanvasBlockedWindows.add(targetWin); } catch (_) {}
      const deny = () => { throw new DOMException('Canvas reading is disabled by permissions policy', 'SecurityError'); };
      try {
        replaceMethod(targetWin.HTMLCanvasElement?.prototype, 'toDataURL', () => deny);
        replaceMethod(targetWin.HTMLCanvasElement?.prototype, 'toBlob', () => function(callback) {
          if (typeof callback === 'function') queueMicrotask(() => callback(null));
        });
        replaceMethod(targetWin.CanvasRenderingContext2D?.prototype, 'getImageData', () => deny);
        replaceMethod(targetWin.OffscreenCanvasRenderingContext2D?.prototype, 'getImageData', () => deny);
        replaceMethod(targetWin.OffscreenCanvas?.prototype, 'convertToBlob', () => function() {
          return Promise.reject(new DOMException('Canvas reading is disabled by permissions policy', 'SecurityError'));
        });
      } catch (_) {}
    };
    patchCanvasBlocked(globalThis);
    subWindowSyncHooks.push((subWin) => { patchCanvasBlocked(subWin); });
  } else if (CFG.canvas && CFG.canvas.mode === 'noise') {
    const mark = Number(CFG.canvas.mark) || 1;
    const rawGetMap = new WeakMap();
    const noisedImageDataMap = new WeakMap();
    const ctxLastPutMap = new WeakMap();

    const patchedCanvasWindows = new WeakSet();
    const patchCanvasForWindow = (targetWin) => {
      if (!targetWin || patchedCanvasWindows.has(targetWin)) return;
      if (adoptNativeBridgeWrappers(targetWin.HTMLCanvasElement?.prototype, targetWin.CanvasRenderingContext2D?.prototype, targetWin.OffscreenCanvasRenderingContext2D?.prototype, targetWin.OffscreenCanvas?.prototype)) {
        try { patchedCanvasWindows.add(targetWin); } catch (_) {}
        return;
      }
      try { patchedCanvasWindows.add(targetWin); } catch (_) {}
      try {
        const hookGetAndPut = (proto) => {
          if (!proto) return;
          if (proto.getImageData) {
            const originalGet = replaceMethod(proto, 'getImageData', (original) => function getImageData(...args) {
              const result = original.apply(this, args);
              try {
                const lastPut = ctxLastPutMap.get(this);
                if (lastPut && lastPut.data && result && result.data && result.data.length === lastPut.data.length) {
                  const sx = args[0] || 0;
                  const sy = args[1] || 0;
                  const sw = args[2] || 0;
                  const sh = args[3] || 0;
                  if (sx === lastPut.dx && sy === lastPut.dy && sw === lastPut.w && sh === lastPut.h) {
                    result.data.set(lastPut.data);
                    noisedImageDataMap.set(result, true);
                    return result;
                  }
                }
              } catch (_) {}
              const noised = applyCanvasNoise(result, mark);
              try { noisedImageDataMap.set(noised, true); } catch (_) {}
              return noised;
            });
            if (originalGet) rawGetMap.set(proto, originalGet);
          }
          if (proto.putImageData) {
            replaceMethod(proto, 'putImageData', (origPut) => function putImageData(imgData, dx, dy, ...rest) {
              try {
                if (noisedImageDataMap.has(imgData)) {
                  ctxLastPutMap.set(this, {
                    data: imgData.data,
                    dx: dx | 0,
                    dy: dy | 0,
                    w: imgData.width | 0,
                    h: imgData.height | 0,
                  });
                } else {
                  ctxLastPutMap.delete(this);
                }
              } catch (_) {}
              return origPut.call(this, imgData, dx, dy, ...rest);
            });
          }
          if (proto.measureText) {
            replaceMethod(proto, 'measureText', (origMeasure) => function measureText(text, ...args) {
              const tm = origMeasure.call(this, text, ...args);
              try {
                const s = String(text || '');
                let h = 0;
                for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
                const jitter = ((h % 100) / 10000);
                return new Proxy(tm, {
                  get(target, prop, receiver) {
                    if (prop === 'constructor') return target.constructor;
                    const val = Reflect.get(target, prop, target);
                    if (typeof val === 'number') {
                      if (prop === 'actualBoundingBoxRight') return val + jitter;
                      if (prop === 'actualBoundingBoxLeft') return val - jitter;
                      if (prop === 'actualBoundingBoxAscent') return val + (jitter * 0.5);
                      if (prop === 'actualBoundingBoxDescent') return val - (jitter * 0.5);
                    }
                    return typeof val === 'function' ? val.bind(target) : val;
                  }
                });
              } catch (_) {
                return tm;
              }
            });
          }
        };

        const ctxProto = targetWin.CanvasRenderingContext2D && targetWin.CanvasRenderingContext2D.prototype;
        hookGetAndPut(ctxProto);
        const offscreenCtxProto = targetWin.OffscreenCanvasRenderingContext2D?.prototype;
        hookGetAndPut(offscreenCtxProto);

        const noiseCanvas = (source) => {
          const w = source.width | 0;
          const h = source.height | 0;
          if (!w || !h) return null;
          const doc = (source && source.ownerDocument) || (targetWin && targetWin.document) || document;
          const copy = doc.createElement('canvas');
          copy.width = w;
          copy.height = h;
          const c2 = copy.getContext('2d');
          if (!c2) return null;
          try {
            if (webglCanvases.has(source)) {
              try {
                const gl = source.getContext('webgl2') || source.getContext('webgl') || source.getContext('experimental-webgl');
                if (gl && typeof gl.readPixels === 'function') {
                  const pixels = new Uint8Array(w * h * 4);
                  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                  const imgData = c2.createImageData(w, h);
                  const rowBytes = w * 4;
                  for (let y = 0; y < h; y++) {
                    const srcY = (h - 1 - y) * rowBytes;
                    const dstY = y * rowBytes;
                    imgData.data.set(pixels.subarray(srcY, srcY + rowBytes), dstY);
                  }
                  c2.putImageData(imgData, 0, 0);
                  return copy;
                }
              } catch (_) {}
            }
            c2.drawImage(source, 0, 0);
            const rawGet = ctxProto ? rawGetMap.get(ctxProto) : null;
            const image = applyCanvasNoise(rawGet ? rawGet.call(c2, 0, 0, w, h) : c2.getImageData(0, 0, w, h), mark);
            c2.putImageData(image, 0, 0);
            return copy;
          } catch (_) { return null; }
        };

        const canvasProto = targetWin.HTMLCanvasElement && targetWin.HTMLCanvasElement.prototype;
        if (canvasProto && canvasProto.toDataURL) {
          replaceMethod(canvasProto, 'toDataURL', (original) => function toDataURL(...args) {
            try {
              const copy = noiseCanvas(this);
              if (copy) return original.apply(copy, args);
            } catch (_) {}
            return original.apply(this, args);
          });
        }

        if (canvasProto && canvasProto.toBlob) {
          replaceMethod(canvasProto, 'toBlob', (originalBlob) => function toBlob(cb, ...rest) {
            if (typeof cb !== 'function') return originalBlob.apply(this, arguments);
            try {
              const copy = noiseCanvas(this);
              if (copy) return originalBlob.call(copy, cb, ...rest);
            } catch (_) {}
            return originalBlob.call(this, cb, ...rest);
          });
        }

        const offscreenProto = targetWin.OffscreenCanvas?.prototype;
        if (offscreenProto?.convertToBlob) {
          replaceMethod(offscreenProto, 'convertToBlob', (original) => async function convertToBlob(options) {
            try {
              const w = Number(this.width) || 0;
              const h = Number(this.height) || 0;
              if (w > 0 && h > 0 && webglCanvases.has(this)) {
                const gl = this.getContext('webgl2') || this.getContext('webgl') || this.getContext('experimental-webgl');
                if (gl && typeof gl.readPixels === 'function') {
                  const pixels = new Uint8Array(w * h * 4);
                  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                  const TargetOffscreen = targetWin.OffscreenCanvas || OffscreenCanvas;
                  const copy = new TargetOffscreen(w, h);
                  const context = copy.getContext('2d');
                  if (context) {
                    const imgData = context.createImageData(w, h);
                    const rowBytes = w * 4;
                    for (let y = 0; y < h; y++) {
                      const srcY = (h - 1 - y) * rowBytes;
                      const dstY = y * rowBytes;
                      imgData.data.set(pixels.subarray(srcY, srcY + rowBytes), dstY);
                    }
                    context.putImageData(imgData, 0, 0);
                    return original.call(copy, options);
                  }
                }
              }
            } catch (_) {}
            const blob = await original.call(this, options);
            try {
              const w = Number(this.width) || 0;
              const h = Number(this.height) || 0;
              if (w <= 0 || h <= 0) return blob;
              const bitmap = await createImageBitmap(blob);
              const TargetOffscreen = targetWin.OffscreenCanvas || OffscreenCanvas;
              const copy = new TargetOffscreen(w, h);
              const context = copy.getContext('2d');
              if (!context) return blob;
              context.drawImage(bitmap, 0, 0);
              bitmap.close?.();
              const image = context.getImageData(0, 0, w, h);
              context.putImageData(image, 0, 0);
              return original.call(copy, options);
            } catch (_) { return blob; }
          });
        }

        const videoFrameProto = targetWin.VideoFrame ? targetWin.VideoFrame.prototype : null;
        if (videoFrameProto && typeof videoFrameProto.copyTo === 'function') {
          const packedRedOffset = (format) => {
            const name = String(format || '');
            if (name === 'RGBA' || name === 'RGBX') return 0;
            if (name === 'BGRA' || name === 'BGRX') return 2;
            return -1;
          };
          const perturbCopiedFrame = (frame, destination, options) => {
            try {
              const settings = options || {};
              const redOffset = packedRedOffset(settings.format || frame.format);
              if (redOffset < 0) return;
              const view = destination instanceof ArrayBuffer
                ? new Uint8Array(destination)
                : (ArrayBuffer.isView(destination)
                  ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
                  : null);
              if (!view) return;
              const frameWidth = Number(frame.codedWidth || frame.displayWidth || 0) || 0;
              const frameHeight = Number(frame.codedHeight || frame.displayHeight || 0) || 0;
              if (!frameWidth || !frameHeight) return;
              const layout = settings.layout || null;
              const base = Number(layout && layout.offset) || 0;
              const rowBytes = Number(layout && layout.bytesPerRow) >= frameWidth * 4
                ? Number(layout.bytesPerRow)
                : frameWidth * 4;
              const rect = settings.rect || null;
              const rx = Number(rect && rect.x) || 0;
              const ry = Number(rect && rect.y) || 0;
              const rw = Number(rect && rect.width) || frameWidth;
              const rh = Number(rect && rect.height) || frameHeight;
              if (!(rw > 0) || !(rh > 0)) return;
              const temp = new Uint8ClampedArray(rw * rh * 4);
              for (let y = 0; y < rh; y += 1) {
                for (let x = 0; x < rw; x += 1) {
                  const from = base + (ry + y) * rowBytes + (rx + x) * 4;
                  if (from + 3 >= view.length) return;
                  const to = (y * rw + x) * 4;
                  temp[to] = view[from + redOffset];
                  temp[to + 1] = view[from + 1];
                  temp[to + 2] = view[from + (redOffset === 0 ? 2 : 0)];
                  temp[to + 3] = view[from + 3];
                }
              }
              applyCanvasNoise({ data: temp, width: rw, height: rh }, mark);
              for (let y = 0; y < rh; y += 1) {
                for (let x = 0; x < rw; x += 1) {
                  const from = base + (ry + y) * rowBytes + (rx + x) * 4;
                  const to = (y * rw + x) * 4;
                  if (from + 3 >= view.length) return;
                  if (temp[to] === view[from + redOffset]) continue;
                  view[from + redOffset] = temp[to];
                }
              }
            } catch (_) {}
          };
          replaceMethod(videoFrameProto, 'copyTo', (original) => function copyTo(destination, options) {
            const result = original.apply(this, arguments);
            try {
              if (result && typeof result.then === 'function') {
                return result.then((value) => { perturbCopiedFrame(this, destination, options); return value; });
              }
              perturbCopiedFrame(this, destination, options);
            } catch (_) {}
            return result;
          });
        }

        const gpuQueueProto = targetWin.GPUQueue ? targetWin.GPUQueue.prototype : null;
        if (gpuQueueProto && typeof gpuQueueProto.copyExternalImageToTexture === 'function') {
          const sourceSize = (value) => {
            try {
              const w = Math.round(Number(value.width || value.displayWidth || value.codedWidth || 0)) || 0;
              const h = Math.round(Number(value.height || value.displayHeight || value.codedHeight || 0)) || 0;
              return w > 0 && h > 0 ? { width: w, height: h } : null;
            } catch (_) { return null; }
          };
          const maskedCopyOf = (value) => {
            const size = sourceSize(value);
            if (!size || webglCanvases.has(value)) return null;
            try {
              const doc = (value && value.ownerDocument) || (targetWin && targetWin.document) || document;
              const copy = doc.createElement('canvas');
              copy.width = size.width;
              copy.height = size.height;
              const surface = copy.getContext('2d');
              if (!surface) return null;
              surface.drawImage(value, 0, 0, size.width, size.height);
              const rawGet = ctxProto ? rawGetMap.get(ctxProto) : null;
              const image = applyCanvasNoise(rawGet ? rawGet.call(surface, 0, 0, size.width, size.height) : surface.getImageData(0, 0, size.width, size.height), mark);
              surface.putImageData(image, 0, 0);
              return copy;
            } catch (_) { return null; }
          };
          replaceMethod(gpuQueueProto, 'copyExternalImageToTexture', (original) => function copyExternalImageToTexture(source, destination, copySize) {
            try {
              if (source && source.source) {
                const masked = maskedCopyOf(source.source);
                if (masked) {
                  const swapped = {};
                  for (const key of Object.keys(source)) swapped[key] = source[key];
                  swapped.source = masked;
                  return original.call(this, swapped, destination, copySize);
                }
              }
            } catch (_) {}
            return original.apply(this, arguments);
          });
        }

        const wrapCtx = (proto) => {
          if (!proto || !proto.getContext) return;
          replaceMethod(proto, 'getContext', (original) => function getContext(...args) {
            const ctx = original.apply(this, args);
            try {
              const type = String(args[0] || '').toLowerCase();
              if (type.includes('webgl') || type.includes('experimental-webgl')) {
                webglCanvases.add(this);
              }
            } catch (_) {}
            return ctx;
          });
        };
        wrapCtx(targetWin.HTMLCanvasElement && targetWin.HTMLCanvasElement.prototype);
        wrapCtx(targetWin.OffscreenCanvas && targetWin.OffscreenCanvas.prototype);
      } catch (_) {}
    };

    patchCanvasForWindow(globalThis);
    subWindowSyncHooks.push((subWin) => { patchCanvasForWindow(subWin); });
  }

  // --- webgl ---
  if (CFG.webgl && CFG.webgl.mode === 'blocked') {
    try {
      const blockContext = (proto) => replaceMethod(proto, 'getContext', (target) => function(...argArray) {
          const type = String(argArray[0] || '');
          if (type.includes('webgl') || type === 'experimental-webgl') return null;
          return Reflect.apply(target, this, argArray);
      });
      blockContext(globalThis.HTMLCanvasElement?.prototype);
      blockContext(globalThis.OffscreenCanvas?.prototype);
    } catch (_) {}
  } else if (CFG.webgl && (CFG.webgl.mode === 'noise' || (CFG.webgl.metaMode && CFG.webgl.metaMode !== 'real'))) {
    try {
      const mark = Number(CFG.webgl.mark) || 1;
      const metaMode = String(CFG.webgl.metaMode || 'noise');
      const pixelNoise = CFG.webgl.mode === 'noise';
      const enabledDebugExts = new WeakSet();

      const targetGpuVendor = (() => {
        const gv = String(CFG.webgl?.gpu?.vendor || '').toLowerCase();
        if (gv) return gv;
        const v = String(CFG.webgl?.vendor || '').toLowerCase();
        const r = String(CFG.webgl?.renderer || '').toLowerCase();
        if (v.includes('nvidia') || r.includes('nvidia')) return 'nvidia';
        if (v.includes('amd') || v.includes('ati') || r.includes('amd') || r.includes('radeon')) return 'amd';
        if (v.includes('intel') || r.includes('intel')) return 'intel';
        if (v.includes('apple') || r.includes('apple')) return 'apple';
        return '';
      })();

      const isDisallowedVendorExtension = (name) => {
        if (!targetGpuVendor || metaMode === 'real') return false;
        const lower = String(name || '').toLowerCase();
        if (lower.startsWith('nv_') && targetGpuVendor !== 'nvidia') return true;
        if (lower.startsWith('amd_') && targetGpuVendor !== 'amd') return true;
        if (lower.startsWith('intel_') && targetGpuVendor !== 'intel') return true;
        if (lower.startsWith('qcom_') && targetGpuVendor !== 'qualcomm') return true;
        return false;
      };

      const patchGetExtension = (proto) => {
        if (!proto || !proto.getExtension) return;
        replaceMethod(proto, 'getExtension', (original) => function(name) {
          const extName = String(name || '').toLowerCase();
          if (metaMode === 'blocked' && extName === 'webgl_debug_renderer_info') return null;
          if (isDisallowedVendorExtension(extName)) return null;
          let ext = original.apply(this, arguments);
          if (extName === 'webgl_debug_renderer_info') {
            if (!ext && metaMode !== 'blocked' && metaMode !== 'real' && (CFG.webgl?.vendor || CFG.webgl?.renderer)) {
              const debugProto = typeof WebGLDebugRendererInfo !== "undefined" ? WebGLDebugRendererInfo.prototype : Object.prototype;
              ext = Object.create(debugProto);
              Object.defineProperty(ext, 'UNMASKED_VENDOR_WEBGL', { value: 0x9245, enumerable: true, writable: false, configurable: false });
              Object.defineProperty(ext, 'UNMASKED_RENDERER_WEBGL', { value: 0x9246, enumerable: true, writable: false, configurable: false });
            }
            if (ext) enabledDebugExts.add(this);
          }
          return ext;
        });
      };

      const precisionOverridesMap = new WeakMap();
      const patchPrecisionFormatProto = (proto) => {
        if (!proto) return;
        for (const prop of ['rangeMin', 'rangeMax', 'precision']) {
          const desc = Object.getOwnPropertyDescriptor(proto, prop);
          if (desc && typeof desc.get === 'function') {
            const nativeGet = desc.get;
            Object.defineProperty(proto, prop, {
              configurable: desc.configurable,
              enumerable: desc.enumerable,
              get: nativeLike(function () {
                const custom = precisionOverridesMap.get(this);
                if (custom && typeof custom[prop] === 'number') {
                  return custom[prop];
                }
                return nativeGet.call(this);
              }, nativeGet, 'get ' + prop, 0),
              set: desc.set,
            });
          }
        }
      };

      const patchGetShaderPrecisionFormat = (proto) => {
        if (!proto || !proto.getShaderPrecisionFormat) return;
        if (metaMode === 'real') return;
        replaceMethod(proto, 'getShaderPrecisionFormat', (original) => function(shaderType, precisionType) {
          const fmt = original.apply(this, arguments);
          if (!fmt) return null;

          const osName = String(CFG.os || '').toLowerCase();
          const isMobilePersona = Boolean(CFG.mobile) || osName === 'android' || osName === 'ios'
            || (CFG.platform && /Android|iPhone|iPad/i.test(CFG.platform))
            || (CFG.webgl?.gpu?.vendor && /qualcomm|arm/i.test(CFG.webgl.gpu.vendor));

          let target = null;
          if (isMobilePersona) {
            if (precisionType === 0x8df1 /* MEDIUM_FLOAT */ || precisionType === 0x8df0 /* LOW_FLOAT */) {
              target = { rangeMin: 14, rangeMax: 14, precision: 10 };
            } else if (precisionType === 0x8df2 /* HIGH_FLOAT */) {
              target = { rangeMin: 127, rangeMax: 127, precision: 23 };
            } else if (precisionType === 0x8df3 /* LOW_INT */ || precisionType === 0x8df4 /* MEDIUM_INT */) {
              target = { rangeMin: 15, rangeMax: 14, precision: 0 };
            } else if (precisionType === 0x8df5 /* HIGH_INT */) {
              target = { rangeMin: 31, rangeMax: 30, precision: 0 };
            }
          } else {
            if (precisionType === 0x8df0 || precisionType === 0x8df1 || precisionType === 0x8df2) {
              target = { rangeMin: 127, rangeMax: 127, precision: 23 };
            } else if (precisionType === 0x8df3 || precisionType === 0x8df4 || precisionType === 0x8df5) {
              target = { rangeMin: 31, rangeMax: 30, precision: 0 };
            }
          }

          if (target) {
            precisionOverridesMap.set(fmt, target);
          }
          return fmt;
        });
      };

      const patchGetParameter = (proto) => {
        if (!proto || !proto.getParameter) return;
        if (metaMode === 'real') return;
        replaceMethod(proto, 'getParameter', (original) => function(param) {
          const UNMASKED_VENDOR_WEBGL = 0x9245;
          const UNMASKED_RENDERER_WEBGL = 0x9246;
          if (param === UNMASKED_VENDOR_WEBGL || param === UNMASKED_RENDERER_WEBGL) {
            if (!enabledDebugExts.has(this)) {
              // Conforms to real Chrome: without WEBGL_debug_renderer_info, native returns null and sets INVALID_ENUM
              return original.apply(this, arguments);
            }
            if (param === UNMASKED_VENDOR_WEBGL) return metaMode === 'blocked' ? '' : CFG.webgl.vendor;
            if (param === UNMASKED_RENDERER_WEBGL) return metaMode === 'blocked' ? '' : CFG.webgl.renderer;
          }
          const limits = CFG.webgl && CFG.webgl.limits;
          if (limits) {
            if (param === 0x0d3a) {
              // MAX_VIEWPORT_DIMS has to follow the size limits, and it is an array, so it is
              // rebuilt from the native value's own constructor to keep the exact same type.
              const native = original.apply(this, arguments);
              const side = Number(limits[0x84e8]) || 0;
              if (side && native && native.length === 2) {
                const out = new native.constructor(2);
                out[0] = side; out[1] = side;
                return out;
              }
              return native;
            }
            if (param === 0x846d) {
              // ALIASED_POINT_SIZE_RANGE: Float32Array [1, maxPoint]
              const native = original.apply(this, arguments);
              const maxPoint = Number(limits[0x846d]) || 0;
              if (maxPoint && native && native.length === 2) {
                const out = new native.constructor(2);
                out[0] = native[0] || 1;
                out[1] = maxPoint;
                return out;
              }
              return native;
            }
            const isWebgl2 = typeof WebGL2RenderingContext !== 'undefined' && (this instanceof WebGL2RenderingContext);
            const WEBGL2_PARAM_KEYS = [0x8a30, 0x8a34, 0x8a2b, 0x8a2d];
            if (WEBGL2_PARAM_KEYS.includes(param)) {
              if (isWebgl2) return limits[param];
              return original.apply(this, arguments);
            }
            if (Object.prototype.hasOwnProperty.call(limits, param)) return limits[param];
          }
          return original.apply(this, arguments);
        });
      };

      // Subtle deterministic readPixels noise so WebGL hashers diverge per env
      const patchReadPixels = (proto) => {
        if (!pixelNoise || !proto || !proto.readPixels) return;
        replaceMethod(proto, 'readPixels', (original) => function(...args) {
          const result = original.apply(this, args);
          try {
            const pixels = args[6];
            if (pixels && pixels.length && (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
              // Skip empty/black buffer
              let hasNonZero = false;
              for (let i = 0; i < pixels.length; i += 32) {
                if (pixels[i] !== 0) { hasNonZero = true; break; }
              }
              if (!hasNonZero) return result;

              const amp = noiseAmplitudeNow();
              const step = Math.max(4, Math.floor(pixels.length / sampleStepDivisorNow()));
              for (let i = 0; i < pixels.length; i += step) {
                const alphaIdx = i - (i % 4) + 3;
                if (alphaIdx < pixels.length && pixels[alphaIdx] === 0) continue;
                const n = Math.floor(noise(i + mark) * amp) - Math.floor(amp / 2);
                pixels[i] = Math.max(0, Math.min(255, (pixels[i] || 0) + n));
              }
            }
          } catch (_) {}
          return result;
        });
      };

      const patchGetSupportedExtensions = (proto) => {
        if (!proto || !proto.getSupportedExtensions) return;
        replaceMethod(proto, 'getSupportedExtensions', (original) => function() {
          let list = original.apply(this, arguments);
          if (!Array.isArray(list)) return list;
          if (metaMode === 'blocked') {
            list = list.filter((ext) => String(ext).toLowerCase() !== 'webgl_debug_renderer_info');
          } else if (metaMode !== 'real' && (CFG.webgl?.vendor || CFG.webgl?.renderer)) {
            if (!list.some((ext) => String(ext).toLowerCase() === 'webgl_debug_renderer_info')) {
              list = [...list, 'WEBGL_debug_renderer_info'];
            }
          }
          list = list.filter((ext) => !isDisallowedVendorExtension(ext));
          return list;
        });
      };

      if (typeof WebGLShaderPrecisionFormat !== 'undefined' && WebGLShaderPrecisionFormat.prototype) {
        patchPrecisionFormatProto(WebGLShaderPrecisionFormat.prototype);
      }
      const globalWebglAlreadyPatched = adoptNativeBridgeWrappers(globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype);
      if (!globalWebglAlreadyPatched && globalThis.WebGLRenderingContext) {
        patchGetParameter(WebGLRenderingContext.prototype);
        patchGetShaderPrecisionFormat(WebGLRenderingContext.prototype);
        patchReadPixels(WebGLRenderingContext.prototype);
        patchGetExtension(WebGLRenderingContext.prototype);
        patchGetSupportedExtensions(WebGLRenderingContext.prototype);
      }
      if (!globalWebglAlreadyPatched && globalThis.WebGL2RenderingContext) {
        patchGetParameter(WebGL2RenderingContext.prototype);
        patchGetShaderPrecisionFormat(WebGL2RenderingContext.prototype);
        patchReadPixels(WebGL2RenderingContext.prototype);
        patchGetExtension(WebGL2RenderingContext.prototype);
        patchGetSupportedExtensions(WebGL2RenderingContext.prototype);
      }
      const patchedWebglWindows = new WeakSet();
      subWindowSyncHooks.push((subWin) => {
        if (!subWin || patchedWebglWindows.has(subWin)) return;
        if (adoptNativeBridgeWrappers(subWin.WebGLRenderingContext?.prototype, subWin.WebGL2RenderingContext?.prototype)) {
          try { patchedWebglWindows.add(subWin); } catch (_) {}
          return;
        }
        try { patchedWebglWindows.add(subWin); } catch (_) {}
        if (subWin.WebGLShaderPrecisionFormat && subWin.WebGLShaderPrecisionFormat.prototype) {
          patchPrecisionFormatProto(subWin.WebGLShaderPrecisionFormat.prototype);
        }
        if (subWin.WebGLRenderingContext) {
          patchGetParameter(subWin.WebGLRenderingContext.prototype);
          patchGetShaderPrecisionFormat(subWin.WebGLRenderingContext.prototype);
          patchReadPixels(subWin.WebGLRenderingContext.prototype);
          patchGetExtension(subWin.WebGLRenderingContext.prototype);
          patchGetSupportedExtensions(subWin.WebGLRenderingContext.prototype);
        }
        if (subWin.WebGL2RenderingContext) {
          patchGetParameter(subWin.WebGL2RenderingContext.prototype);
          patchGetShaderPrecisionFormat(subWin.WebGL2RenderingContext.prototype);
          patchReadPixels(subWin.WebGL2RenderingContext.prototype);
          patchGetExtension(subWin.WebGL2RenderingContext.prototype);
          patchGetSupportedExtensions(subWin.WebGL2RenderingContext.prototype);
        }
      });

      // Track WebGL canvases so 2D toDataURL does not attempt to draw them
      try {
        const wrapCtx = (proto) => {
          if (!proto || !proto.getContext) return;
          replaceMethod(proto, 'getContext', (original) => function(...args) {
            const ctx = original.apply(this, args);
            try {
              const type = String(args[0] || '').toLowerCase();
              if (type.includes('webgl') || type.includes('experimental-webgl')) {
                webglCanvases.add(this);
              }
            } catch (_) {}
            return ctx;
          });
        };
        wrapCtx(globalThis.HTMLCanvasElement && HTMLCanvasElement.prototype);
        wrapCtx(globalThis.OffscreenCanvas && OffscreenCanvas.prototype);
      } catch (_) {}
    } catch (_) {}
  }

  // --- client rects ---
  if (CFG.clientRects && CFG.clientRects.mode === 'noise') {
    try {
      const mark = Number(CFG.clientRects.mark) || 1;
      const rawStep = (mark % 7) - 3;
      const noisePx = (rawStep === 0 ? 1 : rawStep) * 0.0001;
      const sizeStep = (mark % 5) - 2;
      const noiseSize = (sizeStep === 0 ? 1 : sizeStep) * 0.0001;

      const rectListStates = new WeakMap();

      const ensureRectListAccessor = (rectListProto, key, serve) => {
        if (!rectListProto) return false;
        const descriptor = Object.getOwnPropertyDescriptor(rectListProto, key);
        if (!descriptor || typeof descriptor.get !== 'function') return false;
        const nativeGet = descriptor.get;
        Object.defineProperty(rectListProto, key, nativeAccessor(key, {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get() {
            if (!this || (typeof this !== 'object' && typeof this !== 'function')) return nativeGet.call(this);
            const state = rectListStates.get(this);
            if (state) return serve(state);
            return nativeGet.call(this);
          },
          set: descriptor.set,
        }));
        return true;
      };

      const ensureRectListMethod = (rectListProto, key, serve) => {
        if (!rectListProto) return false;
        const descriptor = Object.getOwnPropertyDescriptor(rectListProto, key);
        if (!descriptor || typeof descriptor.value !== 'function') return false;
        const nativeMethod = descriptor.value;
        Object.defineProperty(rectListProto, key, {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          writable: descriptor.writable,
          value: nativeLike(function (...args) {
            if (!this || (typeof this !== 'object' && typeof this !== 'function')) return nativeMethod.apply(this, args);
            const state = rectListStates.get(this);
            if (state) return serve(state, args);
            return nativeMethod.apply(this, args);
          }, nativeMethod),
        });
        return true;
      };

      const patchedClientRectWindows = new WeakSet();
      const patchClientRectsForWindow = (targetWin) => {
        if (!targetWin || patchedClientRectWindows.has(targetWin)) return;
        if (adoptNativeBridgeWrappers(targetWin.Element?.prototype, targetWin.Range?.prototype, targetWin.DOMRectList?.prototype)) {
          try { patchedClientRectWindows.add(targetWin); } catch (_) {}
          return;
        }
        try { patchedClientRectWindows.add(targetWin); } catch (_) {}
        const TargetDOMRect = targetWin.DOMRect || globalThis.DOMRect;
        const targetDOMRectListProto = targetWin.DOMRectList ? targetWin.DOMRectList.prototype : null;

        if (targetDOMRectListProto) {
          ensureRectListAccessor(targetDOMRectListProto, 'length', (state) => state.length);
          ensureRectListMethod(targetDOMRectListProto, 'item', (state, args) => {
            const index = Math.trunc(Number(args[0]) || 0);
            return index >= 0 && index < state.length ? state.rects[index] : null;
          });
          if (typeof Symbol !== 'undefined' && Symbol.iterator) {
            ensureRectListMethod(targetDOMRectListProto, Symbol.iterator, (state) => state.rects[Symbol.iterator]());
          }
        }

        const makeRectList = (rects) => {
          const list = Object.create(targetDOMRectListProto || globalThis.DOMRectList?.prototype || Object.prototype);
          const state = { length: rects.length, rects: rects.slice() };
          rectListStates.set(list, state);
          for (let i = 0; i < state.length; i += 1) {
            Object.defineProperty(list, String(i), {
              value: state.rects[i],
              enumerable: true,
              configurable: true,
              writable: false,
            });
          }
          return list;
        };

        // A Range measures its commonAncestorContainer; an Element measures itself. Both must be
        // font-sanitised so a foreign family cannot leak host metrics through layout probes.
        const scopeTargetFor = (receiver, isRange) => {
          if (!isRange) return receiver;
          try {
            const c = receiver && receiver.commonAncestorContainer;
            if (!c) return null;
            return c.nodeType === 1 ? c : (c.parentElement || null);
          } catch (_) { return null; }
        };

        const patchRect = (proto, method, isRange = false) => {
          if (!proto || !proto[method]) return;
          replaceMethod(proto, method, (original) => function() {
            const run = () => {
              const rect = original.apply(this, arguments);
              if (!rect) return rect;
              try {
                const x = rect.x + noisePx, y = rect.y + noisePx;
                const width = rect.width === 0 ? 0 : Math.max(0, rect.width + noiseSize);
                const height = rect.height === 0 ? 0 : Math.max(0, rect.height + noiseSize);
                return TargetDOMRect && TargetDOMRect.fromRect ? TargetDOMRect.fromRect({ x, y, width, height }) : rect;
              } catch (_) { return rect; }
            };
            return sanitizeElementFontScope(scopeTargetFor(this, isRange), run);
          });
        };

        const patchList = (proto, method, isRange = false) => {
          if (!proto || !proto[method]) return;
          replaceMethod(proto, method, (original) => function() {
            const run = () => {
              const list = original.apply(this, arguments);
              if (!list) return list;
              try {
                const rects = [];
                for (let i = 0; i < list.length; i += 1) {
                  const rect = list[i];
                  const width = rect.width === 0 ? 0 : Math.max(0, rect.width + noiseSize);
                  const height = rect.height === 0 ? 0 : Math.max(0, rect.height + noiseSize);
                  rects.push(TargetDOMRect && TargetDOMRect.fromRect
                    ? TargetDOMRect.fromRect({ x: rect.x + noisePx, y: rect.y + noisePx, width, height })
                    : rect);
                }
                return makeRectList(rects);
              } catch (_) { return list; }
            };
            return sanitizeElementFontScope(scopeTargetFor(this, isRange), run);
          });
        };

        if (targetWin === globalThis) {
          if (typeof Element !== 'undefined') {
            patchRect(Element.prototype, 'getBoundingClientRect');
            patchList(Element.prototype, 'getClientRects');
          }
          if (globalThis.Range) {
            patchRect(Range.prototype, 'getBoundingClientRect', true);
            patchList(Range.prototype, 'getClientRects', true);
          }
        } else {
          if (targetWin.Element) {
            patchRect(targetWin.Element.prototype, 'getBoundingClientRect');
            patchList(targetWin.Element.prototype, 'getClientRects');
          }
          if (targetWin.Range) {
            patchRect(targetWin.Range.prototype, 'getBoundingClientRect', true);
            patchList(targetWin.Range.prototype, 'getClientRects', true);
          }
        }
      };

      patchClientRectsForWindow(globalThis);
      subWindowSyncHooks.push((subWin) => { patchClientRectsForWindow(subWin); });
    } catch (_) {}
  }

  // --- webrtc ---
  if (CFG.webrtc === 'disabled') {
    try {
      const blocked = nativeLike(function RTCPeerConnection() {
        throw new DOMException('WebRTC is disabled by permissions policy', 'NotAllowedError');
      }, globalThis.RTCPeerConnection, 'RTCPeerConnection', 0, true);
      if (globalThis.RTCPeerConnection) window.RTCPeerConnection = blocked;
      if (globalThis.webkitRTCPeerConnection) window.webkitRTCPeerConnection = blocked;
    } catch (_) {}
  } else if (CFG.webrtc === 'proxy' && CFG.webrtcAddress) {
    // NOTE: the bundled 148 kernel refuses to construct a peer connection at all (NotSupportedError,
    // for every webrtc_policy value), so this layer is only ever observed through a stock Chromium
    // kernel. Its prototype surface is still reachable on the bundled kernel - a page can inspect the
    // accessors without constructing anything - which is why the shapes below have to be exact.
    try {
      const targetIp = String(CFG.webrtcAddress || '');
      // A candidate address names either this machine (host), the address this machine's traffic is
      // observed from (srflx/prflx) or the TURN server that will relay the media (relay). Only the
      // relay address belongs to a third party and has to survive untouched. Every other type
      // identifies the machine or its exit, so it is replaced: restricting the rewrite to private
      // addresses left a public host candidate (a machine with a routable address) and a public
      // reflexive candidate (an exit that differs from the profile proxy) on screen, which is
      // exactly the address a detector looks for.
      const candidatePattern = /^(a=)?candidate:(\\S+) (\\d+) (\\S+) (\\d+) (\\S+) (\\d+) typ (\\S+)([\\s\\S]*)$/;
      const isRelayType = (type) => String(type || '') === 'relay';
      const rewriteCandidateLine = (line) => {
        if (typeof line !== 'string' || !targetIp) return line;
        // The ICE event hands out "candidate:..." while the SDP line carries "a=candidate:...",
        // so the prefix is optional and has to be preserved on the way out.
        const m = line.match(candidatePattern);
        if (!m) return line;
        let changed = false;
        let addr = m[6];
        if (!isRelayType(m[8]) && addr !== targetIp) { addr = targetIp; changed = true; }
        // raddr names the base address the candidate was observed from, which is this machine even
        // when the candidate itself is a relay allocation. Masking it only when it looked private
        // left the base address of a public host next to the rewritten candidate.
        const tail = m[9].replace(/ raddr (\\S+)/, (whole, base) => {
          if (base === '0.0.0.0' || base === '::') return whole;
          changed = true;
          return ' raddr 0.0.0.0';
        });
        if (!changed) return line;
        return (m[1] || '') + 'candidate:' + m[2] + ' ' + m[3] + ' ' + m[4] + ' ' + m[5] + ' ' + addr
          + ' ' + m[7] + ' typ ' + m[8] + tail;
      };
      // The media connection line names the address the agent would use by default. It is not a
      // candidate, but it carries the same address and survives every candidate rewrite, so it is
      // mapped the same way - except for an address a relay candidate in the same description
      // holds, because that one belongs to the TURN server rather than to this machine.
      const rewriteConnectionLine = (line, relayAddresses) => {
        if (typeof line !== 'string' || !targetIp) return line;
        const m = line.match(/^(c=IN IP[46] )([^\\s]+)([\\s]*)$/);
        if (!m) return line;
        if (relayAddresses && relayAddresses.has(m[2])) return line;
        // 0.0.0.0 and :: are the placeholders the engine writes when nothing was gathered yet; they
        // name no address at all, so replacing them would only make the description look unnatural.
        if (m[2] === '0.0.0.0' || m[2] === '::' || m[2] === targetIp) return line;
        return 'c=IN IP4 ' + targetIp + m[3];
      };
      const rewriteSdp = (desc) => {
        if (!desc || typeof desc.sdp !== 'string' || !targetIp) return desc;
        try {
          const nl = String.fromCharCode(10);
          const lines = desc.sdp.split(nl);
          const relayAddresses = new Set();
          for (const line of lines) {
            const m = line.match(candidatePattern);
            if (m && isRelayType(m[8])) relayAddresses.add(m[6]);
          }
          let changed = false;
          const mapped = lines.map((line) => {
            const candidate = rewriteCandidateLine(line);
            const next = candidate === line ? rewriteConnectionLine(line, relayAddresses) : candidate;
            if (next !== line) changed = true;
            return next;
          });
          if (!changed) return desc;
          return Object.assign({}, desc, { sdp: mapped.join(nl) });
        } catch (_) { return desc; }
      };
      // Descriptions the page reads have to stay brand-checkable, or instanceof becomes a tell.
      const rewriteDescription = (desc) => {
        const next = rewriteSdp(desc);
        if (next === desc) return desc;
        try { return new RTCSessionDescription({ type: next.type, sdp: next.sdp }); } catch (_) { return next; }
      };
      // Candidates reach the page as engine objects. Rebuilding the event that delivered one would
      // hand the page a script-constructed event instead of the engine's own - isTrusted false,
      // target/currentTarget null and eventPhase 0 are far stronger tells than the address the
      // rebuild was hiding. The rewrite therefore happens on the candidate the event carries: the
      // event object stays the one the engine dispatched, and only the candidate it hands out is
      // replaced, with the engine's own constructor so the brand check still passes.
      const eventCandidates = new WeakMap();
      const iceEventDescriptor = (() => {
        try {
          const proto = typeof RTCPeerConnectionIceEvent !== 'undefined' ? RTCPeerConnectionIceEvent.prototype : null;
          const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'candidate') : null;
          return descriptor && typeof descriptor.get === 'function' ? { proto: proto, descriptor: descriptor } : null;
        } catch (_) { return null; }
      })();
      if (iceEventDescriptor && iceEventDescriptor.descriptor.configurable !== false) {
        const proto = iceEventDescriptor.proto;
        const descriptor = iceEventDescriptor.descriptor;
        const nativeGet = descriptor.get;
        try {
          Object.defineProperty(proto, 'candidate', {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get: nativeLike(function candidate() {
              const original = nativeGet.call(this);
              if (!original || typeof original !== 'object') return original;
              // Only an event the engine dispatched carries a candidate produced by the ICE agent.
              // A page-built event has to keep handing back exactly the object it was given, or the
              // accessor itself becomes the tell.
              if (!this || this.isTrusted !== true) return original;
              let cached;
              try { cached = eventCandidates.get(this); } catch (_) { return original; }
              if (cached !== undefined) return cached;
              let rebuilt = null;
              try {
                const raw = original.candidate;
                const line = rewriteCandidateLine(raw);
                if (line !== raw) {
                  rebuilt = new RTCIceCandidate({
                    candidate: line,
                    sdpMid: original.sdpMid,
                    sdpMLineIndex: original.sdpMLineIndex,
                    usernameFragment: original.usernameFragment,
                  });
                }
              } catch (_) { rebuilt = null; }
              try { eventCandidates.set(this, rebuilt || original); } catch (_) {}
              return rebuilt || original;
            }, nativeGet, 'get candidate', 0),
          });
        } catch (_) {}
      }
      const pcProto = globalThis.RTCPeerConnection && RTCPeerConnection.prototype;
      if (pcProto) {
        // The engine's own description accessors are read first, so the wrappers installed below can
        // still reach the raw descriptions the engine stored.
        const nativeDescriptionDescriptors = new Map();
        for (const key of ['localDescription', 'currentLocalDescription', 'pendingLocalDescription',
          'remoteDescription', 'currentRemoteDescription', 'pendingRemoteDescription']) {
          try {
            const descriptor = Object.getOwnPropertyDescriptor(pcProto, key);
            if (descriptor && typeof descriptor.get === 'function') nativeDescriptionDescriptors.set(key, descriptor);
          } catch (_) {}
        }
        const rawDescription = (key, pc) => {
          const descriptor = nativeDescriptionDescriptors.get(key);
          if (!descriptor) return null;
          try { return descriptor.get.call(pc); } catch (_) { return null; }
        };
        if (pcProto.createOffer) {
          replaceMethod(pcProto, 'createOffer', (orig) => async function createOffer(...args) {
            return rewriteSdp(await orig.apply(this, args));
          });
        }
        if (pcProto.createAnswer) {
          replaceMethod(pcProto, 'createAnswer', (orig) => async function createAnswer(...args) {
            return rewriteSdp(await orig.apply(this, args));
          });
        }
        // Descriptions the page hands in come back exactly as they went in. Rewriting them would let
        // a page detect the rewrite in three lines - set an SDP of its own, read it back, compare -
        // and nothing is leaked by leaving them alone, because the addresses in a description the
        // page built are the page's own. Only descriptions the engine produced are rewritten, so
        // the page-supplied ones are recorded here and handed back untouched by the getters.
        const verbatimDescriptions = new WeakSet();
        if (pcProto.setLocalDescription) {
          replaceMethod(pcProto, 'setLocalDescription', (orig) => async function setLocalDescription(desc, ...args) {
            // setLocalDescription() with no argument is the documented modern form: the engine
            // builds and applies the offer itself, so there is nothing to record.
            const supplied = Boolean(desc) && typeof desc.sdp === 'string';
            const result = await orig.call(this, desc, ...args);
            if (supplied) {
              for (const key of ['localDescription', 'pendingLocalDescription', 'currentLocalDescription']) {
                try {
                  const raw = rawDescription(key, this);
                  if (raw && typeof raw === 'object') verbatimDescriptions.add(raw);
                } catch (_) {}
              }
            }
            return result;
          });
        }
        // The engine-produced descriptions funnel through the local getters: the no-argument form and
        // the createOffer/createAnswer results. Reading is the only place that covers all of them, so
        // the raw stored SDP never reaches the page. One wrapper is cached per stored description,
        // which keeps the engine's own identity relationships intact - while gathering,
        // localDescription and pendingLocalDescription are the same object and must stay that way.
        //
        // The remote getters are deliberately left alone. A remote description is what the peer sent,
        // it never carries this machine's address, and rewriting it changes what the page reads back
        // from setRemoteDescription - the cheapest rewrite detector there is. The same argument holds
        // for a description the page supplied itself, which is why those are returned verbatim.
        const descriptionCache = new WeakMap();
        for (const key of ['localDescription', 'currentLocalDescription', 'pendingLocalDescription']) {
          try {
            const descriptor = nativeDescriptionDescriptors.get(key);
            if (!descriptor || typeof descriptor.get !== 'function' || descriptor.configurable === false) continue;
            const nativeGet = descriptor.get;
            Object.defineProperty(pcProto, key, {
              configurable: true,
              enumerable: descriptor.enumerable,
              get: makeNativeGetter(key, function () {
                const raw = nativeGet.call(this);
                if (!raw || typeof raw !== 'object') return raw;
                try { if (verbatimDescriptions.has(raw)) return raw; } catch (_) {}
                let hit = null;
                try { hit = descriptionCache.get(raw); } catch (_) { hit = null; }
                if (hit) return hit;
                const wrapped = rewriteDescription(raw);
                try { descriptionCache.set(raw, wrapped); } catch (_) {}
                return wrapped;
              }),
            });
          } catch (_) {}
        }
        // RTCIceTransport hands the same candidates out a second time, and getLocalCandidates()
        // answers from gathering alone - no connection, no event listener, no statistics call - so it
        // is a first-class surface rather than a corner case. The engine's candidate objects stay the
        // engine's; a candidate this machine owns is rebuilt with the engine's own constructor, and
        // one rebuild is cached per engine candidate so repeated reads hand back the same object.
        const iceTransportProto = typeof RTCIceTransport !== 'undefined' ? RTCIceTransport.prototype : null;
        if (iceTransportProto) {
          const transportCandidates = new WeakMap();
          const rewriteTransportCandidate = (candidate) => {
            if (!candidate || typeof candidate !== 'object') return candidate;
            let cached;
            try { cached = transportCandidates.get(candidate); } catch (_) { return candidate; }
            if (cached !== undefined) return cached;
            let rebuilt = null;
            try {
              const raw = String(candidate.candidate || '');
              const line = rewriteCandidateLine(raw);
              if (line !== raw) {
                rebuilt = new RTCIceCandidate({
                  candidate: line,
                  sdpMid: candidate.sdpMid,
                  sdpMLineIndex: candidate.sdpMLineIndex,
                  usernameFragment: candidate.usernameFragment,
                });
              }
            } catch (_) { rebuilt = null; }
            try { transportCandidates.set(candidate, rebuilt || candidate); } catch (_) {}
            return rebuilt || candidate;
          };
          if (typeof iceTransportProto.getLocalCandidates === 'function') {
            replaceMethod(iceTransportProto, 'getLocalCandidates', (orig) => function getLocalCandidates(...args) {
              const list = orig.apply(this, args);
              if (!Array.isArray(list)) return list;
              return list.map(rewriteTransportCandidate);
            });
          }
          if (typeof iceTransportProto.getSelectedCandidatePair === 'function') {
            replaceMethod(iceTransportProto, 'getSelectedCandidatePair', (orig) => function getSelectedCandidatePair(...args) {
              const pair = orig.apply(this, args);
              if (!pair || typeof pair !== 'object') return pair;
              // Only the local half of the pair names this machine; the remote candidate belongs to
              // the peer and stays the engine's own object.
              const local = rewriteTransportCandidate(pair.local);
              if (local === pair.local) return pair;
              try {
                const copy = Object.create(Object.getPrototypeOf(pair));
                for (const key of Object.getOwnPropertyNames(pair)) copy[key] = pair[key];
                copy.local = local;
                return copy;
              } catch (_) { return pair; }
            });
          }
        }
        // Local candidate statistics carry the same host addresses the SDP rewrite removes, so a
        // detector that gathers without ever reading a candidate event would still see the machine.
        // The report itself stays the engine's object - brand, toString tag and size are untouched -
        // and only the entries it hands out are replaced, through a per-report map.
        const statsEntries = new WeakMap();
        const statsIteratorReports = new WeakMap();
        let statsProto = null;
        let statsNativeForEach = null;
        try {
          statsProto = typeof RTCStatsReport !== 'undefined' ? RTCStatsReport.prototype : null;
          const forEachDescriptor = statsProto ? Object.getOwnPropertyDescriptor(statsProto, 'forEach') : null;
          statsNativeForEach = forEachDescriptor && typeof forEachDescriptor.value === 'function'
            ? forEachDescriptor.value : null;
        } catch (_) { statsProto = null; }
        const rewriteStatsEntry = (entry) => {
          try {
            if (!entry || entry.type !== 'local-candidate') return entry;
            // A relay allocation names the TURN server, so its own address stays; every other type
            // names this machine or its exit.
            const relay = String(entry.candidateType || '') === 'relay';
            const address = String(entry.address || entry.ip || '');
            const related = String(entry.relatedAddress || '');
            const needsAddress = !relay && Boolean(address) && address !== targetIp;
            // relatedAddress holds the base address the candidate was observed from - this machine
            // even for a relay allocation - so it is masked next to the rewritten address.
            const needsRelated = Boolean(related) && related !== '0.0.0.0';
            if (!needsAddress && !needsRelated) return entry;
            const copy = {};
            for (const key of Object.keys(entry)) copy[key] = entry[key];
            if (needsAddress) {
              if ('address' in copy) copy.address = targetIp;
              if ('ip' in copy) copy.ip = targetIp;
            }
            if (needsRelated && ('relatedAddress' in copy)) copy.relatedAddress = '0.0.0.0';
            // The engine derives a candidate foundation from its address, so the entry has to carry
            // the foundation that belongs to the address the page is being shown.
            if (needsAddress) {
              try {
                const probe = new RTCIceCandidate({
                  candidate: 'candidate:' + String(entry.foundation || '1') + ' 1 udp '
                    + String(entry.priority || 0) + ' ' + targetIp + ' ' + String(entry.port || 0)
                    + ' typ ' + String(entry.candidateType || 'host'),
                });
                if (probe && probe.foundation) copy.foundation = probe.foundation;
              } catch (_) {}
            }
            return copy;
          } catch (_) { return entry; }
        };
        const statsEntryFor = (map, value) => {
          if (!map || !map.size) return value;
          try {
            if (Array.isArray(value)) {
              const entry = map.get(value[0]);
              return entry ? [value[0], Object.assign({}, entry)] : value;
            }
            const id = value && value.id;
            if (id === undefined) return value;
            const entry = map.get(id);
            return entry ? Object.assign({}, entry) : value;
          } catch (_) { return value; }
        };
        const statsReplacements = new Map();
        const patchStatsMethod = (key, factory) => {
          try {
            if (!statsProto) return;
            const descriptor = Object.getOwnPropertyDescriptor(statsProto, key);
            if (!descriptor || typeof descriptor.value !== 'function' || descriptor.configurable === false) return;
            const native = descriptor.value;
            let replacement = statsReplacements.get(native);
            if (!replacement) {
              replacement = nativeLike(factory(native), native, native.name, native.length);
              statsReplacements.set(native, replacement);
            }
            Object.defineProperty(statsProto, key, {
              configurable: descriptor.configurable,
              enumerable: descriptor.enumerable,
              writable: descriptor.writable,
              value: replacement,
            });
          } catch (_) {}
        };
        let iteratorNextPatched = false;
        const wrapStatsIterator = (native) => function values() {
          const iterator = native.call(this);
          try {
            const map = statsEntries.get(this);
            if (map && map.size && iterator && typeof iterator === 'object') {
              statsIteratorReports.set(iterator, map);
              if (!iteratorNextPatched) {
                const iteratorProto = Object.getPrototypeOf(iterator);
                const nextDescriptor = iteratorProto ? Object.getOwnPropertyDescriptor(iteratorProto, 'next') : null;
                if (nextDescriptor && typeof nextDescriptor.value === 'function' && nextDescriptor.configurable !== false) {
                  const nativeNext = nextDescriptor.value;
                  iteratorNextPatched = true;
                  Object.defineProperty(iteratorProto, 'next', {
                    configurable: nextDescriptor.configurable,
                    enumerable: nextDescriptor.enumerable,
                    writable: nextDescriptor.writable,
                    value: nativeLike(function next() {
                      const result = nativeNext.call(this);
                      try {
                        const reportMap = statsIteratorReports.get(this);
                        if (!reportMap || !reportMap.size || !result || typeof result !== 'object' || result.done) return result;
                        const substituted = statsEntryFor(reportMap, result.value);
                        if (substituted === result.value) return result;
                        const copy = {};
                        for (const field of Object.keys(result)) copy[field] = field === 'value' ? substituted : result[field];
                        return copy;
                      } catch (_) { return result; }
                    }, nativeNext, nativeNext.name, nativeNext.length),
                  });
                }
              }
            }
          } catch (_) {}
          return iterator;
        };
        patchStatsMethod('get', (native) => function get(id) {
          const map = statsEntries.get(this);
          const entry = map && map.size ? map.get(id) : null;
          return entry ? Object.assign({}, entry) : native.call(this, id);
        });
        patchStatsMethod('forEach', (native) => function forEach(callback, thisArg) {
          const map = statsEntries.get(this);
          if (typeof callback !== 'function' || !map || !map.size) return native.call(this, callback, thisArg);
          return native.call(this, function (value, key, report) {
            return callback.call(thisArg, statsEntryFor(map, value), key, report);
          }, thisArg);
        });
        patchStatsMethod('values', wrapStatsIterator);
        patchStatsMethod('entries', wrapStatsIterator);
        try {
          if (statsProto && Object.getOwnPropertyDescriptor(statsProto, Symbol.iterator)) {
            patchStatsMethod(Symbol.iterator, wrapStatsIterator);
          }
        } catch (_) {}
        if (pcProto.getStats) {
          replaceMethod(pcProto, 'getStats', (orig) => async function getStats(...args) {
            const report = await orig.apply(this, args);
            try {
              if (report && typeof report === 'object' && statsNativeForEach) {
                const map = new Map();
                statsNativeForEach.call(report, (entry) => {
                  const rewritten = rewriteStatsEntry(entry);
                  if (rewritten !== entry && entry && entry.id !== undefined) map.set(entry.id, rewritten);
                });
                if (map.size) statsEntries.set(report, map);
              }
            } catch (_) {}
            return report;
          });
        }
      }
    } catch (_) {}
  }

  // --- mediaDevices ---
  if (CFG.mediaDevices && CFG.mediaDevices.mode && CFG.mediaDevices.mode !== 'real' && Array.isArray(CFG.mediaDevices.devices)) {
    try {
      const devProto = typeof MediaDeviceInfo !== "undefined" ? MediaDeviceInfo.prototype : Object.prototype;
      const deviceStates = new WeakMap();
      const patchedDeviceKeys = new Set();
      let deviceToJSONPatched = false;
      // A native device carries no own members: its four fields and toJSON live on the prototype.
      // Keep that shape and answer only the synthetic instances from a WeakMap; every other receiver
      // is forwarded to the original accessor so its brand checks stay intact.
      const patchDeviceAccessor = (key) => {
        if (!devProto || patchedDeviceKeys.has(key)) return true;
        const descriptor = Object.getOwnPropertyDescriptor(devProto, key);
        if (!descriptor || typeof descriptor.get !== 'function') return false;
        const nativeGet = descriptor.get;
        Object.defineProperty(devProto, key, {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get: nativeLike(function deviceValue() {
            const state = deviceStates.get(this);
            if (state) return state[key];
            return nativeGet.call(this);
          }, nativeGet, 'get ' + key, 0),
          set: descriptor.set,
        });
        patchedDeviceKeys.add(key);
        return true;
      };
      const patchDeviceToJSON = () => {
        if (deviceToJSONPatched || !devProto) return;
        const descriptor = Object.getOwnPropertyDescriptor(devProto, 'toJSON');
        if (!descriptor || typeof descriptor.value !== 'function') return;
        const nativeToJSON = descriptor.value;
        Object.defineProperty(devProto, 'toJSON', {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          writable: descriptor.writable,
          value: nativeLike(function toJSON() {
            const state = deviceStates.get(this);
            if (state) return { deviceId: state.deviceId, kind: state.kind, label: state.label, groupId: state.groupId };
            return nativeToJSON.apply(this, arguments);
          }, nativeToJSON, 'toJSON', nativeToJSON.length),
        });
        deviceToJSONPatched = true;
      };
      const makeDevice = (kind, label, deviceId, groupId) => {
        const item = Object.create(devProto);
        const state = {
          deviceId: String(deviceId || ''),
          kind: String(kind || ''),
          label: String(label || ''),
          groupId: String(groupId || ''),
        };
        deviceStates.set(item, state);
        for (const key of Object.keys(state)) {
          if (!patchDeviceAccessor(key)) {
            Object.defineProperty(item, key, { value: state[key], enumerable: false, writable: false, configurable: true });
          }
        }
        patchDeviceToJSON();
        return item;
      };
      const devices = CFG.mediaDevices.devices.map((d) => makeDevice(d.kind, d.label, d.deviceId, d.groupId));
      // Chrome only publishes identifiers and labels once the user has granted a capture
      // permission; before that the same three entries come back with every field empty. Handing
      // out ids up front both diverged from the real surface and made the synthetic identifiers
      // readable without any permission prompt.
      const withheldDevices = CFG.mediaDevices.devices.map((d) => makeDevice(d.kind, "", "", ""));
      const enumerateForPermission = async () => {
        let granted = false;
        try {
          const perms = navigator.permissions;
          if (perms && typeof perms.query === 'function') {
            const [cam, mic] = await Promise.all([
              Promise.resolve().then(() => perms.query({ name: 'camera' })).catch(() => null),
              Promise.resolve().then(() => perms.query({ name: 'microphone' })).catch(() => null),
            ]);
            granted = Boolean((cam && cam.state === 'granted') || (mic && mic.state === 'granted'));
          }
        } catch (_) {}
        return (granted ? devices : withheldDevices).slice();
      };
      const mdProto = typeof MediaDevices !== 'undefined' ? MediaDevices.prototype : null;
      const realMediaDevices = (() => { try { return navigator.mediaDevices || null; } catch (_) { return null; } })();
      const isRealMediaDevices = (receiver) => receiver === realMediaDevices;
      const serveDevices = async function enumerateDevices() { return enumerateForPermission(); };
      if (mdProto && mdProto.enumerateDevices) {
        replaceMethod(mdProto, 'enumerateDevices', (original) => guardReceiver(original, isRealMediaDevices, serveDevices));
      } else if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        replaceMethod(navigator.mediaDevices, 'enumerateDevices', (original) => guardReceiver(original, isRealMediaDevices, serveDevices));
      }

      // MediaStreamTrack label & getSettings shielding:
      // Prevent getUserMedia from leaking native hardware device labels or deviceIds.
      const trackInfoMap = new WeakMap();
      const trackProto = typeof MediaStreamTrack !== 'undefined' ? MediaStreamTrack.prototype : null;
      if (trackProto) {
        const origLabelDesc = Object.getOwnPropertyDescriptor(trackProto, 'label');
        if (origLabelDesc && typeof origLabelDesc.get === 'function') {
          const nativeLabelGet = origLabelDesc.get;
          Object.defineProperty(trackProto, 'label', {
            configurable: origLabelDesc.configurable,
            enumerable: origLabelDesc.enumerable,
            get: nativeLike(function label() {
              const info = trackInfoMap.get(this);
              if (info && info.label !== undefined) return info.label;
              return nativeLabelGet.call(this);
            }, nativeLabelGet, 'get label', 0),
          });
        }

        const origGetSettings = trackProto.getSettings;
        if (typeof origGetSettings === 'function') {
          Object.defineProperty(trackProto, 'getSettings', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: nativeLike(function getSettings() {
              const settings = origGetSettings.apply(this, arguments);
              const info = trackInfoMap.get(this);
              if (info && settings && typeof settings === 'object') {
                if (info.deviceId !== undefined) settings.deviceId = info.deviceId;
                if (info.groupId !== undefined) settings.groupId = info.groupId;
              }
              return settings;
            }, origGetSettings, 'getSettings', 0),
          });
        }

        const origTrackClone = trackProto.clone;
        if (typeof origTrackClone === 'function') {
          Object.defineProperty(trackProto, 'clone', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: nativeLike(function clone() {
              const cloned = origTrackClone.apply(this, arguments);
              const info = trackInfoMap.get(this);
              if (info && cloned) trackInfoMap.set(cloned, info);
              return cloned;
            }, origTrackClone, 'clone', 0),
          });
        }
      }

      if (typeof MediaStream !== 'undefined' && MediaStream.prototype) {
        const origStreamClone = MediaStream.prototype.clone;
        if (typeof origStreamClone === 'function') {
          Object.defineProperty(MediaStream.prototype, 'clone', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: nativeLike(function clone() {
              const clonedStream = origStreamClone.apply(this, arguments);
              if (clonedStream && typeof clonedStream.getTracks === 'function') {
                const origTracks = typeof this.getTracks === 'function' ? this.getTracks() : [];
                const newTracks = clonedStream.getTracks();
                for (let i = 0; i < newTracks.length; i += 1) {
                  const origT = origTracks[i];
                  const info = origT ? trackInfoMap.get(origT) : null;
                  if (info && newTracks[i]) trackInfoMap.set(newTracks[i], info);
                }
              }
              return clonedStream;
            }, origStreamClone, 'clone', 0),
          });
        }
      }

      const audioDevices = CFG.mediaDevices.devices.filter((d) => d.kind === 'audioinput');
      const videoDevices = CFG.mediaDevices.devices.filter((d) => d.kind === 'videoinput');
      const nativeToSpoofedMap = new Map();

      const assignTrackInfo = (track, constraints) => {
        if (!track || typeof track.kind !== 'string') return;
        const isAudio = track.kind === 'audio';
        const candidates = isAudio ? audioDevices : videoDevices;
        if (!candidates.length) return;

        let reqId = null;
        try {
          const trackConstraint = isAudio ? constraints?.audio : constraints?.video;
          if (trackConstraint && typeof trackConstraint === 'object') {
            reqId = trackConstraint.deviceId?.exact || trackConstraint.deviceId?.ideal || trackConstraint.deviceId;
            if (typeof reqId === 'object' && reqId) reqId = reqId.exact || reqId.ideal;
          }
        } catch (_) {}

        let matched = null;
        if (reqId && typeof reqId === 'string') {
          matched = candidates.find((c) => c.deviceId === reqId);
        }

        if (!matched) {
          let nativeDevId = '';
          try {
            const settings = trackProto?.getSettings ? trackProto.getSettings.call(track) : {};
            nativeDevId = settings.deviceId || '';
          } catch (_) {}
          const mapKey = track.kind + ':' + nativeDevId;
          if (nativeToSpoofedMap.has(mapKey)) {
            matched = nativeToSpoofedMap.get(mapKey);
          } else {
            const usedCount = Array.from(nativeToSpoofedMap.keys()).filter((k) => k.startsWith(track.kind + ':')).length;
            matched = candidates[usedCount % candidates.length];
            nativeToSpoofedMap.set(mapKey, matched);
          }
        }

        if (matched) {
          trackInfoMap.set(track, {
            label: String(matched.label || ''),
            deviceId: String(matched.deviceId || ''),
            groupId: String(matched.groupId || ''),
          });
        }
      };

      const wrapGetUserMedia = (origGUM) => {
        if (typeof origGUM !== 'function') return origGUM;
        return nativeLike(async function getUserMedia(constraints) {
          const stream = await origGUM.call(this, constraints);
          try {
            if (stream && typeof stream.getTracks === 'function') {
              for (const track of stream.getTracks()) {
                assignTrackInfo(track, constraints);
              }
            }
          } catch (_) {}
          return stream;
        }, origGUM, 'getUserMedia', origGUM.length);
      };

      if (mdProto && mdProto.getUserMedia) {
        replaceMethod(mdProto, 'getUserMedia', (original) => wrapGetUserMedia(original));
      } else if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        replaceMethod(navigator.mediaDevices, 'getUserMedia', (original) => wrapGetUserMedia(original));
      }
    } catch (_) {}
  }

  // --- speech voices ---
  if (CFG.speech && CFG.speech.mode === "blocked") {
    try {
      const mainSpProto = typeof SpeechSynthesis !== "undefined" ? SpeechSynthesis.prototype : null;
      const mainPausedDesc = mainSpProto ? Object.getOwnPropertyDescriptor(mainSpProto, "paused") : null;
      const patchSpeechBlockedForWindow = (targetWin) => {
        if (!targetWin) return;
        try {
          const spProto = targetWin.SpeechSynthesis ? targetWin.SpeechSynthesis.prototype : mainSpProto;
          if (!spProto && !targetWin.speechSynthesis) return;
          const targetPausedDesc = spProto ? Object.getOwnPropertyDescriptor(spProto, "paused") : mainPausedDesc;
          const isSpeechReceiver = (receiver) => {
            if (!receiver || typeof receiver !== "object") return false;
            if (targetPausedDesc && typeof targetPausedDesc.get === "function") {
              try {
                targetPausedDesc.get.call(receiver);
                return true;
              } catch (_) {
                return false;
              }
            }
            return receiver === targetWin.speechSynthesis || receiver === globalThis.speechSynthesis;
          };
          const serveEmpty = function getVoices() { return []; };
          if (spProto && spProto.getVoices) {
            replaceMethod(spProto, "getVoices", (original) => guardReceiver(original, isSpeechReceiver, serveEmpty));
          } else if (targetWin.speechSynthesis) {
            replaceMethod(targetWin.speechSynthesis, "getVoices", (original) => guardReceiver(original, isSpeechReceiver, serveEmpty));
          }
        } catch (_) {}
      };
      patchSpeechBlockedForWindow(globalThis);
      subWindowSyncHooks.push((subWin) => { patchSpeechBlockedForWindow(subWin); });
    } catch (_) {}
  } else if (CFG.speech && CFG.speech.mode === "noise" && Array.isArray(CFG.speech.voices)) {
    try {
      const mockVoiceSet = new WeakSet();
      const patchStructuredCloneForWindow = (targetWin) => {
        if (!targetWin || typeof targetWin.structuredClone !== "function") return;
        const origStructuredClone = targetWin.structuredClone;
        const checkVoiceClone = (val, seen = new WeakSet()) => {
          if (!val || typeof val !== "object") return;
          if (mockVoiceSet.has(val)) {
            const DOMEx = targetWin.DOMException || DOMException;
            throw new DOMEx("Failed to execute 'structuredClone' on 'Window': SpeechSynthesisVoice object could not be cloned.", "DataCloneError");
          }
          if (seen.has(val)) return;
          seen.add(val);
          if (Array.isArray(val)) {
            for (let i = 0; i < val.length; i++) checkVoiceClone(val[i], seen);
          } else if (Object.prototype.toString.call(val) === "[object Object]") {
            for (const k of Object.keys(val)) checkVoiceClone(val[k], seen);
          }
        };
        const patchedStructuredClone = nativeLike(function structuredClone(value, options) {
          checkVoiceClone(value);
          return origStructuredClone.apply(this, arguments);
        }, origStructuredClone, "structuredClone", 1);
        try {
          Object.defineProperty(targetWin, "structuredClone", {
            configurable: true,
            writable: true,
            enumerable: true,
            value: patchedStructuredClone,
          });
        } catch (_) {}
      };
      patchStructuredCloneForWindow(globalThis);
      subWindowSyncHooks.push((subWin) => { patchStructuredCloneForWindow(subWin); });

      const voiceProto = typeof SpeechSynthesisVoice !== "undefined" ? SpeechSynthesisVoice.prototype : Object.prototype;
      const voiceStates = new WeakMap();
      const patchedVoiceProtos = new WeakSet();
      // Native voices keep their fields on the prototype as well. Use the same synthetic-instance
      // WeakMap pattern so the table cannot be distinguished by an own-property scan.
      const patchVoiceAccessor = (proto, key) => {
        if (!proto) return true;
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (!descriptor || typeof descriptor.get !== "function") return false;
        const nativeGet = descriptor.get;
        Object.defineProperty(proto, key, {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get: nativeLike(function voiceValue() {
            const state = voiceStates.get(this);
            if (state) return state[key];
            return nativeGet.call(this);
          }, nativeGet, "get " + key, 0),
          set: descriptor.set,
        });
        return true;
      };
      const patchVoiceProto = (proto) => {
        if (!proto || patchedVoiceProtos.has(proto)) return;
        patchedVoiceProtos.add(proto);
        for (const key of ["name", "lang", "default", "localService", "voiceURI"]) {
          patchVoiceAccessor(proto, key);
        }
      };
      patchVoiceProto(voiceProto);

      const createVoicesForProto = (proto) => {
        return CFG.speech.voices.map((v) => {
          const voice = Object.create(proto);
          const state = {
            name: String(v.name || ""),
            lang: String(v.lang || "en-US"),
            default: Boolean(v.default),
            localService: v.localService !== false,
            voiceURI: String(v.voiceURI || v.name || ""),
          };
          mockVoiceSet.add(voice);
          voiceStates.set(voice, state);
          for (const key of Object.keys(state)) {
            if (!patchVoiceAccessor(proto, key)) {
              Object.defineProperty(voice, key, { value: state[key], enumerable: false, writable: false, configurable: true });
            }
          }
          return voice;
        });
      };

      const voices = createVoicesForProto(voiceProto);

      // The table is published asynchronously by the engine: the first synchronous call answers with
      // an empty list and the populated one only becomes observable once the engine announces the
      // load. Returning the table straight away left a timing signal, so it is withheld until the
      // engine reports readiness - the same signal a genuine build waits for, which also keeps the
      // release instant aligned with the native one instead of being pinned to a fixed delay.
      // Nothing is synthesised: a fabricated event would carry isTrusted === false and be a tell of
      // its own. A bounded fallback releases the table on a build that never reports readiness.
      let voicesReady = false;
      const markVoicesReady = () => { voicesReady = true; };
      try {
        const sp = globalThis.speechSynthesis;
        if (sp && typeof sp.addEventListener === "function") {
          sp.addEventListener('voiceschanged', markVoicesReady, { once: true });
        }
      } catch (_) {}
      try {
        setTimeout(markVoicesReady, 1000);
      } catch (_) { markVoicesReady(); }
      const readVoices = () => (voicesReady ? voices.slice() : []);

      const mainSpProto = typeof SpeechSynthesis !== "undefined" ? SpeechSynthesis.prototype : null;
      const mainPausedDesc = mainSpProto ? Object.getOwnPropertyDescriptor(mainSpProto, "paused") : null;

      const windowVoicesMap = new WeakMap();
      windowVoicesMap.set(globalThis, voices);

      const patchSpeechForWindow = (targetWin) => {
        if (!targetWin) return;
        try {
          const spProto = targetWin.SpeechSynthesis ? targetWin.SpeechSynthesis.prototype : mainSpProto;
          if (!spProto && !targetWin.speechSynthesis) return;

          const targetVoiceProto = targetWin.SpeechSynthesisVoice ? targetWin.SpeechSynthesisVoice.prototype : voiceProto;
          if (targetVoiceProto) {
            patchVoiceProto(targetVoiceProto);
          }

          let winVoices = windowVoicesMap.get(targetWin);
          if (!winVoices) {
            winVoices = targetVoiceProto ? createVoicesForProto(targetVoiceProto) : voices;
            windowVoicesMap.set(targetWin, winVoices);
          }

          const targetReadVoices = () => (voicesReady ? winVoices.slice() : []);
          const targetPausedDesc = spProto ? Object.getOwnPropertyDescriptor(spProto, "paused") : mainPausedDesc;

          const isSpeechReceiver = (receiver) => {
            if (!receiver || typeof receiver !== "object") return false;
            if (targetPausedDesc && typeof targetPausedDesc.get === "function") {
              try {
                targetPausedDesc.get.call(receiver);
                return true;
              } catch (_) {
                return false;
              }
            }
            return receiver === targetWin.speechSynthesis || receiver === globalThis.speechSynthesis;
          };

          const serveVoices = function getVoices() { return targetReadVoices(); };
          if (spProto && spProto.getVoices) {
            replaceMethod(spProto, "getVoices", (original) => guardReceiver(original, isSpeechReceiver, serveVoices));
          } else if (targetWin.speechSynthesis) {
            replaceMethod(targetWin.speechSynthesis, "getVoices", (original) => guardReceiver(original, isSpeechReceiver, serveVoices));
          }

          if (targetWin.speechSynthesis && typeof targetWin.speechSynthesis.addEventListener === "function") {
            try {
              targetWin.speechSynthesis.addEventListener('voiceschanged', markVoicesReady, { once: true });
            } catch (_) {}
          }
        } catch (_) {}
      };

      patchSpeechForWindow(globalThis);
      subWindowSyncHooks.push((subWin) => { patchSpeechForWindow(subWin); });
    } catch (_) {}
  }

  // --- battery ---
  if (CFG.battery && CFG.battery.mode === 'blocked') {
    try {
      const blocked = function getBattery() {
        return Promise.reject(new DOMException('Battery status is not allowed by Permissions Policy', 'NotAllowedError'));
      };
      const navProto = typeof Navigator !== "undefined" ? Navigator.prototype : null;
      const isNavigatorReceiver = (receiver) => receiver === navigator;
      if (navProto && navProto.getBattery) {
        replaceMethod(navProto, 'getBattery', (original) => guardReceiver(original, isNavigatorReceiver, blocked));
      } else if (navigator.getBattery) {
        replaceMethod(navigator, 'getBattery', (original) => guardReceiver(original, isNavigatorReceiver, blocked));
      }
    } catch (_) {}
  } else if (CFG.battery && CFG.battery.mode === 'noise' && CFG.battery.value && !CFG.battery.value.blocked) {
    try {
      const snap = CFG.battery.value;
      const state = {
        charging: Boolean(snap.charging),
        chargingTime: snap.chargingTime == null ? Infinity : Number(snap.chargingTime),
        dischargingTime: snap.dischargingTime == null ? Infinity : Number(snap.dischargingTime),
        level: Math.min(1, Math.max(0, Number(snap.level) || 0)),
      };
      const battProto = typeof BatteryManager !== 'undefined' ? BatteryManager.prototype : null;
      const spoofedStates = new WeakMap();
      const patchedKeys = new Set();
      // A real manager keeps all four values on the prototype; defining them on the instance is an
      // own-property shape that no stock build has. Install the replacement accessors on the native
      // prototype and delegate every receiver we did not issue back to the original getter.
      const patchBatteryAccessor = (key) => {
        if (!battProto || patchedKeys.has(key)) return;
        const descriptor = Object.getOwnPropertyDescriptor(battProto, key);
        if (!descriptor || typeof descriptor.get !== 'function') return;
        const nativeGet = descriptor.get;
        const wrappedGet = nativeLike(function batteryValue() {
          const value = spoofedStates.get(this);
          if (value && Object.prototype.hasOwnProperty.call(value, key)) return value[key];
          return nativeGet.call(this);
        }, nativeGet, 'get ' + key, 0);
        Object.defineProperty(battProto, key, {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          get: wrappedGet,
          set: descriptor.set,
        });
        patchedKeys.add(key);
      };
      const serveBattery = (original) => function getBattery() {
        return Promise.resolve(original.call(this)).then((manager) => {
          if (!manager) return manager;
          spoofedStates.set(manager, state);
          for (const key of Object.keys(state)) patchBatteryAccessor(key);
          return manager;
        });
      };
      const navProto = typeof Navigator !== "undefined" ? Navigator.prototype : null;
      const isNavigatorReceiver = (receiver) => receiver === navigator;
      if (navProto && navProto.getBattery) {
        replaceMethod(navProto, 'getBattery', (original) => guardReceiver(original, isNavigatorReceiver, serveBattery(original)));
      } else if (navigator.getBattery) {
        replaceMethod(navigator, 'getBattery', (original) => guardReceiver(original, isNavigatorReceiver, serveBattery(original)));
      }
    } catch (_) {}
  }

  // --- bluetooth adapter ---
  // Keep the native interface and prototype shape, but answer as a machine without an adapter.
  // Hiding the whole interface would itself diverge from a desktop Chrome secure context.
  if (CFG.bluetooth && CFG.bluetooth.mode === 'blocked') {
    try {
      const receiver = navigator.bluetooth;
      const btProto = typeof Bluetooth !== 'undefined' ? Bluetooth.prototype : null;
      const isBluetoothReceiver = (value) => value === receiver;
      if (receiver && btProto && typeof btProto.getAvailability === 'function') {
        replaceMethod(btProto, 'getAvailability', (original) => guardReceiver(original, isBluetoothReceiver, function getAvailability() {
          return Promise.resolve(false);
        }));
      }
      if (receiver && btProto && typeof btProto.requestDevice === 'function') {
        replaceMethod(btProto, 'requestDevice', (original) => guardReceiver(original, isBluetoothReceiver, function requestDevice() {
          return Promise.reject(new DOMException('Bluetooth adapter not available.', 'NotFoundError'));
        }));
      }
    } catch (_) {}
  }

  // --- WebGPU adapter info ---
  // Modes mirror the profile contract:
  //   real    : do not touch the kernel's adapter or its info
  //   blocked : keep navigator.gpu present but make requestAdapter resolve to no adapter
  //   webgl   : expose an adapter whose info matches the configured WebGL/GPU identity
  if (!isIosPersona && CFG.webgpu && typeof navigator !== "undefined" && navigator.gpu) {
    try {
      const gpuMode = String(CFG.webgpu.mode || 'real');
      const gpuProto = typeof GPU !== 'undefined' ? GPU.prototype : null;
      const requestTarget = (gpuProto && typeof gpuProto.requestAdapter === 'function')
        ? gpuProto
        : navigator.gpu;
      const gpuInfo = CFG.webgpu.gpu && (CFG.webgpu.gpu.vendor || CFG.webgpu.gpu.architecture)
        ? {
          vendor: String(CFG.webgpu.gpu.vendor || ''),
          architecture: String(CFG.webgpu.gpu.architecture || ''),
          device: String(CFG.webgpu.gpu.device || ''),
          description: String(CFG.webgpu.gpu.description || CFG.webgpu.gpu.architecture || ''),
        }
        : null;

      if (gpuMode === 'blocked' && requestTarget) {
        replaceMethod(requestTarget, 'requestAdapter', () => async function requestAdapter() {
          return null;
        });
      } else if (gpuMode === 'webgl' && gpuInfo && requestTarget) {
        const infoOverrides = new WeakMap();
        const adapterInfos = new WeakMap();
        const featuresMap = new WeakMap();
        const limitsMap = new WeakMap();
        const patchedInfoKeys = new Set();
        let patchedFeaturesProto = false;
        let patchedLimitsProto = false;
        let adapterProtoPatched = false;

        const targetVendor = String(gpuInfo.vendor || '').toLowerCase().trim();
        const targetArch = String(gpuInfo.architecture || '').toLowerCase().trim();
        const disallowedFeatures = new Set();
        if (targetVendor === 'intel' || targetVendor === 'nvidia' || targetVendor === 'amd') {
          disallowedFeatures.add('texture-compression-astc');
          disallowedFeatures.add('texture-compression-etc2');
          if (targetVendor === 'intel' && (targetArch.includes('gen9') || targetArch.includes('gen7') || targetArch.includes('gen11') || targetArch.includes('gen-9') || targetArch.includes('gen-7'))) {
            disallowedFeatures.add('shader-f16');
            disallowedFeatures.add('subgroups-f16');
          }
        } else if (targetVendor === 'qualcomm' || targetVendor === 'arm' || targetVendor === 'samsung') {
          disallowedFeatures.add('texture-compression-bc');
        }

        const getFamilyLimits = (vendor, arch) => {
          const v = String(vendor || '').toLowerCase().trim();
          if (v === 'nvidia' || v === 'amd') {
            return {
              maxTextureDimension1D: 16384,
              maxTextureDimension2D: 16384,
              maxTextureDimension3D: 2048,
              maxTextureArrayLayers: 2048,
              maxBufferSize: 2147483648,
              maxStorageBufferBindingSize: 2147483648,
              minUniformBufferOffsetAlignment: 256,
              minStorageBufferOffsetAlignment: 256,
              maxComputeWorkgroupStorageSize: 32768,
              maxComputeInvocationsPerWorkgroup: 1024,
              maxComputeWorkgroupSizeX: 1024,
              maxComputeWorkgroupSizeY: 1024,
              maxComputeWorkgroupSizeZ: 64,
            };
          }
          if (v === 'intel' || v === 'apple') {
            return {
              maxTextureDimension1D: 16384,
              maxTextureDimension2D: 16384,
              maxTextureDimension3D: 2048,
              maxTextureArrayLayers: 2048,
              maxBufferSize: 2147483648,
              maxStorageBufferBindingSize: 1073741824,
              minUniformBufferOffsetAlignment: 256,
              minStorageBufferOffsetAlignment: 256,
              maxComputeWorkgroupStorageSize: 32768,
              maxComputeInvocationsPerWorkgroup: 1024,
              maxComputeWorkgroupSizeX: 1024,
              maxComputeWorkgroupSizeY: 1024,
              maxComputeWorkgroupSizeZ: 64,
            };
          }
          if (v === 'qualcomm' || v === 'arm') {
            return {
              maxTextureDimension1D: 8192,
              maxTextureDimension2D: 8192,
              maxTextureDimension3D: 2048,
              maxTextureArrayLayers: 2048,
              maxBufferSize: 268435456,
              maxStorageBufferBindingSize: 134217728,
              minUniformBufferOffsetAlignment: 256,
              minStorageBufferOffsetAlignment: 256,
              maxComputeWorkgroupStorageSize: 16384,
              maxComputeInvocationsPerWorkgroup: 256,
              maxComputeWorkgroupSizeX: 256,
              maxComputeWorkgroupSizeY: 256,
              maxComputeWorkgroupSizeZ: 64,
            };
          }
          return {};
        };

        const resolveLimits = (hostLimits) => {
          const familyLimits = getFamilyLimits(gpuInfo.vendor, gpuInfo.architecture);
          const out = {};
          for (const [k, famVal] of Object.entries(familyLimits)) {
            try {
              const hostVal = hostLimits[k];
              if (typeof hostVal === 'number') {
                if (k.startsWith('min')) {
                  out[k] = Math.max(famVal, hostVal);
                } else {
                  out[k] = Math.min(famVal, hostVal);
                }
              }
            } catch (_) {}
          }
          return out;
        };

        const patchInfoAccessor = (key) => {
          if (patchedInfoKeys.has(key) || typeof GPUAdapterInfo === 'undefined' || !GPUAdapterInfo.prototype) return false;
          const descriptor = Object.getOwnPropertyDescriptor(GPUAdapterInfo.prototype, key);
          if (!descriptor || typeof descriptor.get !== 'function') return false;
          const nativeGet = descriptor.get;
          Object.defineProperty(GPUAdapterInfo.prototype, key, {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get: nativeLike(function adapterInfoValue() {
              const value = infoOverrides.get(this);
              if (value && Object.prototype.hasOwnProperty.call(value, key)) return value[key];
              return nativeGet.call(this);
            }, nativeGet, 'get ' + key, 0),
            set: descriptor.set,
          });
          patchedInfoKeys.add(key);
          return true;
        };

        const patchFeaturesAccessors = (fProto) => {
          if (!fProto || patchedFeaturesProto) return;
          patchedFeaturesProto = true;
          const sizeDesc = Object.getOwnPropertyDescriptor(fProto, 'size');
          if (sizeDesc && typeof sizeDesc.get === 'function') {
            const natSizeGet = sizeDesc.get;
            Object.defineProperty(fProto, 'size', {
              configurable: sizeDesc.configurable,
              enumerable: sizeDesc.enumerable,
              get: nativeLike(function size() {
                natSizeGet.call(this);
                const filtered = featuresMap.get(this);
                return filtered ? filtered.size : natSizeGet.call(this);
              }, natSizeGet, 'get size', 0),
              set: sizeDesc.set,
            });
          }
          if (typeof fProto.has === 'function') {
            const natHas = fProto.has;
            const hasMethod = nativeLike(function has(key) {
              natHas.call(this, key);
              const filtered = featuresMap.get(this);
              if (filtered) return filtered.has(String(key));
              return natHas.call(this, key);
            }, natHas, 'has', 1);
            Object.defineProperty(fProto, 'has', {
              configurable: true,
              enumerable: true,
              writable: true,
              value: hasMethod,
            });
          }
          const wrapIter = (key, makeIter) => {
            if (typeof fProto[key] === 'function') {
              const natFn = fProto[key];
              const method = nativeLike(function (...args) {
                natFn.apply(this, args);
                const filtered = featuresMap.get(this);
                if (filtered) return makeIter(filtered);
                return natFn.apply(this, args);
              }, natFn, key, natFn.length);
              Object.defineProperty(fProto, key, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: method,
              });
            }
          };
          wrapIter('entries', (f) => f.entries());
          wrapIter('keys', (f) => f.keys());
          wrapIter('values', (f) => f.values());
          if (typeof Symbol !== 'undefined' && Symbol.iterator && typeof fProto[Symbol.iterator] === 'function') {
            const natSym = fProto[Symbol.iterator];
            const symMethod = nativeLike(function () {
              natSym.call(this);
              const filtered = featuresMap.get(this);
              if (filtered) return filtered[Symbol.iterator]();
              return natSym.call(this);
              // Do NOT rename or re-arity this wrapper: a Blink setlike prototype exposes
              // Symbol.iterator as the very same values function object, so the native
              // name/length are part of the observable surface. Overriding them would make the
              // prototype signature differ from an un-injected build.
            }, natSym);
            Object.defineProperty(fProto, Symbol.iterator, {
              configurable: true,
              enumerable: false,
              writable: true,
              value: symMethod,
            });
          }
          if (typeof fProto.forEach === 'function') {
            const natForEach = fProto.forEach;
            const forEachMethod = nativeLike(function forEach(callback, thisArg) {
              natForEach.call(this, () => {});
              const filtered = featuresMap.get(this);
              if (filtered) {
                for (const val of filtered) {
                  callback.call(thisArg, val, val, this);
                }
                return;
              }
              return natForEach.apply(this, arguments);
            }, natForEach, 'forEach', 1);
            Object.defineProperty(fProto, 'forEach', {
              configurable: true,
              enumerable: true,
              writable: true,
              value: forEachMethod,
            });
          }
        };

        const patchLimitsAccessors = (lProto) => {
          if (!lProto || patchedLimitsProto) return;
          patchedLimitsProto = true;
          const props = Object.getOwnPropertyNames(lProto);
          for (const key of props) {
            if (key === 'constructor') continue;
            const desc = Object.getOwnPropertyDescriptor(lProto, key);
            if (!desc || typeof desc.get !== 'function') continue;
            const natGet = desc.get;
            Object.defineProperty(lProto, key, {
              configurable: desc.configurable,
              enumerable: desc.enumerable,
              get: nativeLike(function () {
                natGet.call(this);
                const custom = limitsMap.get(this);
                if (custom && Object.prototype.hasOwnProperty.call(custom, key)) {
                  return custom[key];
                }
                return natGet.call(this);
              }, natGet, 'get ' + key, 0),
              set: desc.set,
            });
          }
        };

        const patchAdapterProto = (aProto) => {
          if (adapterProtoPatched || !aProto) return;
          adapterProtoPatched = true;

          const infoDesc = Object.getOwnPropertyDescriptor(aProto, 'info');
          if (infoDesc && typeof infoDesc.get === 'function') {
            const natInfoGet = infoDesc.get;
            Object.defineProperty(aProto, 'info', {
              configurable: infoDesc.configurable,
              enumerable: infoDesc.enumerable,
              get: nativeLike(function info() {
                const spoofed = adapterInfos.get(this);
                return spoofed || natInfoGet.call(this);
              }, natInfoGet, 'get info', 0),
              set: infoDesc.set,
            });
          }

          const featuresDesc = Object.getOwnPropertyDescriptor(aProto, 'features');
          if (featuresDesc && typeof featuresDesc.get === 'function') {
            const natFeaturesGet = featuresDesc.get;
            Object.defineProperty(aProto, 'features', {
              configurable: featuresDesc.configurable,
              enumerable: featuresDesc.enumerable,
              get: nativeLike(function features() {
                const f = natFeaturesGet.call(this);
                if (f && !featuresMap.has(f)) {
                  const allowed = new Set();
                  try {
                    for (const item of f) {
                      if (!disallowedFeatures.has(item)) allowed.add(item);
                    }
                  } catch (_) {}
                  featuresMap.set(f, allowed);
                }
                return f;
              }, natFeaturesGet, 'get features', 0),
              set: featuresDesc.set,
            });
          }

          const limitsDesc = Object.getOwnPropertyDescriptor(aProto, 'limits');
          if (limitsDesc && typeof limitsDesc.get === 'function') {
            const natLimitsGet = limitsDesc.get;
            Object.defineProperty(aProto, 'limits', {
              configurable: limitsDesc.configurable,
              enumerable: limitsDesc.enumerable,
              get: nativeLike(function limits() {
                const l = natLimitsGet.call(this);
                if (l && !limitsMap.has(l)) {
                  limitsMap.set(l, resolveLimits(l));
                }
                return l;
              }, natLimitsGet, 'get limits', 0),
              set: limitsDesc.set,
            });
          }

          if (typeof aProto.requestAdapterInfo === 'function') {
            replaceMethod(aProto, 'requestAdapterInfo', (origReqInfo) => async function requestAdapterInfo(...args) {
              const info = await origReqInfo.apply(this, args);
              if (!info || typeof info !== 'object') return info;
              infoOverrides.set(info, gpuInfo);
              for (const key of Object.keys(gpuInfo)) patchInfoAccessor(key);
              adapterInfos.set(this, info);
              return info;
            });
          }
        };

        if (typeof GPUAdapterInfo !== 'undefined' && GPUAdapterInfo.prototype) {
          for (const key of Object.keys(gpuInfo)) patchInfoAccessor(key);
        }
        if (typeof GPUSupportedFeatures !== 'undefined' && GPUSupportedFeatures.prototype) {
          patchFeaturesAccessors(GPUSupportedFeatures.prototype);
        }
        if (typeof GPUSupportedLimits !== 'undefined' && GPUSupportedLimits.prototype) {
          patchLimitsAccessors(GPUSupportedLimits.prototype);
        }
        if (typeof GPUAdapter !== 'undefined' && GPUAdapter.prototype) {
          patchAdapterProto(GPUAdapter.prototype);
        }

        const prepareAdapter = (adapter) => {
          if (!adapter) return;
          const aProto = (typeof GPUAdapter !== 'undefined' && GPUAdapter.prototype) || Object.getPrototypeOf(adapter);
          patchAdapterProto(aProto);

          let info = null;
          try { info = adapter.info; } catch (_) {}
          if (info && typeof info === 'object') {
            infoOverrides.set(info, gpuInfo);
            for (const key of Object.keys(gpuInfo)) patchInfoAccessor(key);
            adapterInfos.set(adapter, info);
          }

          let features = null;
          try { features = adapter.features; } catch (_) {}
          if (features && typeof features === 'object') {
            const fProto = (typeof GPUSupportedFeatures !== 'undefined' && GPUSupportedFeatures.prototype) || Object.getPrototypeOf(features);
            patchFeaturesAccessors(fProto);
            if (!featuresMap.has(features)) {
              const allowed = new Set();
              try {
                for (const item of features) {
                  if (!disallowedFeatures.has(item)) allowed.add(item);
                }
              } catch (_) {}
              featuresMap.set(features, allowed);
            }
          }

          let limits = null;
          try { limits = adapter.limits; } catch (_) {}
          if (limits && typeof limits === 'object') {
            const lProto = (typeof GPUSupportedLimits !== 'undefined' && GPUSupportedLimits.prototype) || Object.getPrototypeOf(limits);
            patchLimitsAccessors(lProto);
            if (!limitsMap.has(limits)) {
              limitsMap.set(limits, resolveLimits(limits));
            }
          }
        };

        replaceMethod(requestTarget, 'requestAdapter', (originalRequestAdapter) => async function requestAdapter(...args) {
          const adapter = await originalRequestAdapter.apply(this, args);
          if (!adapter) return adapter;
          prepareAdapter(adapter);
          return adapter;
        });
      }
    } catch (_) {}
  }

  // --- StorageManager.prototype.estimate quota spoofing (N3) ---
  if (typeof StorageManager !== 'undefined' && StorageManager.prototype && StorageManager.prototype.estimate) {
    try {
      const origEstimate = StorageManager.prototype.estimate;
      const isMob = Boolean(CFG.mobile || isIosPersona || isAndroidPersona);
      const mem = Number(CFG.deviceMemory) || 8;
      const personaQuota = isMob
        ? (mem >= 8 ? 16106127360 : 10737418240)
        : (mem >= 8 ? 64424509440 : 32212254720);

      const patchedEstimate = nativeLike(function estimate() {
        if (!this || !(this instanceof StorageManager)) {
          return Promise.reject(new TypeError("Illegal invocation"));
        }
        return origEstimate.apply(this, arguments).then((res) => {
          return {
            quota: personaQuota,
            usage: res ? (res.usage || 0) : 0,
            usageDetails: res ? (res.usageDetails || {}) : {},
          };
        });
      }, origEstimate, "estimate", 0);
      Object.defineProperty(StorageManager.prototype, "estimate", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: patchedEstimate,
      });

      subWindowSyncHooks.push((subWin) => {
        try {
          if (!subWin || !subWin.StorageManager || !subWin.StorageManager.prototype || !subWin.StorageManager.prototype.estimate) return;
          const origSubEst = subWin.StorageManager.prototype.estimate;
          const patchedSubEst = nativeLike(function estimate() {
            if (!this || !(this instanceof subWin.StorageManager)) {
              return Promise.reject(new TypeError("Illegal invocation"));
            }
            return origSubEst.apply(this, arguments).then((res) => {
              return {
                quota: personaQuota,
                usage: res ? (res.usage || 0) : 0,
                usageDetails: res ? (res.usageDetails || {}) : {},
              };
            });
          }, origSubEst, "estimate", 0);
          Object.defineProperty(subWin.StorageManager.prototype, "estimate", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: patchedSubEst,
          });
        } catch (_) {}
      });
    } catch (_) {}
  }

} catch (_) {}
})();`;

  let fontMetricsScript = '';
  let cssFontLocalGateScript = '';
  let queryLocalFontBlobGateScript = '';
  if (fp && fp.fonts && Array.isArray(fp.fonts.list) && fp.fonts.list.length) {
    const platformKey = mapPlatformToSubsetKey(fp.platform);
    if (platformKey) {
      fontMetricsScript = buildFontMetricsScript(platformKey, { ...(fp.fontMetricsOptions || {}), bridgeToken });
    }
    // Dynamic stylesheet APIs reach the native local-font resolver without constructing a
    // FontFace object. The companion source filters those dynamic paths from the same persona
    // list while leaving web-font url/data candidates untouched.
    try {
      const fontSubsets = platformKey ? loadFontSubsetPayload(platformKey) : [];
      cssFontLocalGateScript = buildCssFontLocalGateSource(fp.fonts.list, fontSubsets, {
        blockedFont: deriveFontPlaceholder(fp),
        bridgeToken,
      });
    } catch (_) {}
    // Local Font Access exposes a binary blob after user activation. Its returned FontData
    // records have already been re-labelled above, so their blob() method must not remain bound
    // to the host record and disclose a different platform's font bytes.
    const platKey = (() => {
      const p = String(fp.uaProfile?.os || fp.os || fp.platform || '').trim().toLowerCase();
      if (p.includes('win')) return 'windows';
      if (p.includes('mac') || p.includes('darwin')) return 'macos';
      if (p.includes('android')) return 'android';
      if (p.includes('linux')) return 'linux';
      if (p.includes('ios') || p.includes('iphone') || p.includes('ipad')) return 'macos';
      return 'windows';
    })();
    const lazyFontPayload = fp.lazyFontPayload !== false && fp.lazyPayload !== false && (fp.lazyPayload === true || platKey === 'windows');
    const fontBridgeChannel = String(fp.bridgeChannel || fp.fontBlobBridge?.channelName || ('_' + String(bridgeToken).slice(0, 16)));
    fp.fontBlobBridge = lazyFontPayload ? {
      channelName: fontBridgeChannel,
      token: String(bridgeToken),
      platform: platKey,
      wanted: null,
    } : null;
    try {
      queryLocalFontBlobGateScript = buildQueryLocalFontBlobGateSource({
        ...fp,
        bridgeToken,
        lazyPayload: lazyFontPayload,
        bridgeChannel: fontBridgeChannel,
      });
    } catch (_) {}
  }

  return [mainScript, fontMetricsScript, cssFontLocalGateScript, queryLocalFontBlobGateScript].filter(Boolean).join('\n');
}

/** Worker-safe subset injected before attached workers are resumed. */
function buildWorkerInjectionScript(fp) {
  const bridgeToken = deriveBridgeToken(fp);
  const stability = fp.stability || fp.canvas?.stability || resolveStabilityPolicy({}, {});
  const json = JSON.stringify({
    platform: fp.platform,
    userAgent: fp.userAgent,
    appVersion: fp.uaProfile?.appVersion || String(fp.userAgent || '').replace(/^Mozilla\//, ''),
    vendor: fp.vendor || fp.uaProfile?.vendor || 'Google Inc.',
    userAgentMetadata: fp.userAgentMetadata,
    languages: fp.languages,
    timezone: fp.timezone || fp.dynamicConfig?.timezone || null,
    hardwareConcurrency: fp.hardwareConcurrency,
    deviceMemory: Math.min(8, Math.max(1, Number(fp.deviceMemory) || 8)),
    webgl: {
      mode: fp.webgl?.mode,
      metaMode: fp.webgl?.metaMode || 'noise',
      vendor: fp.webgl?.vendor,
      renderer: fp.webgl?.renderer,
      mark: fp.webgl?.mark,
      gpu: fp.webgl?.gpu || null,
      limits: fp.webgl?.limits || webglParameterOverrides(fp.webgl?.gpu, { reconcileHost: fp.webgl?.reconcileHost !== false, hostPlatform: process.platform }),
    },
    webgpu: fp.webgpu ? {
      mode: String(fp.webgpu.mode || 'real'),
      gpu: fp.webgpu.gpu || fp.webgl?.gpu || null,
    } : (fp.webgl?.gpu ? {
      mode: 'webgl',
      gpu: fp.webgl.gpu,
    } : null),
    canvas: fp.canvas,
    seed: fp.seed,
    stability: {
      active: Boolean(stability.active),
      mode: String(stability.mode || 'auto'),
      hosts: Array.isArray(stability.hosts) ? stability.hosts : [],
      skipHosts: Array.isArray(stability.skipHosts) ? stability.skipHosts : [],
      noiseAmplitude: Number(stability.noiseAmplitude) || 3,
      sampleStepDivisor: Number(stability.sampleStepDivisor) || 64,
      maxWidth: Number(stability.maxWidth) || 600,
      maxHeight: Number(stability.maxHeight) || 600,
      square: Number(stability.square) || 8,
    },
  });
  return `(() => {
  const CFG = ${json};

  const seedNum = parseInt(String(CFG.seed || '1').slice(0, 8), 16) || 1;
  const noise = (n) => { const x = Math.sin((n + 1) * seedNum) * 10000; return x - Math.floor(x); };
  const square = Math.max(2, Number(CFG.stability?.square) || 8);
  const workerLocks = new Map();
  const normalizeHost = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/:\\d+$/, '')
    .replace(/^\\*\\./, '');
  const hostMatches = (host, pattern) => {
    const h = normalizeHost(host);
    const p = normalizeHost(pattern);
    if (!h || !p) return false;
    if (h === p) return true;
    return h.endsWith('.' + p);
  };
  const listHasHost = (list, host) => Array.isArray(list) && list.some((item) => hostMatches(host, item));
  const currentHost = () => {
    try { return normalizeHost(self && self.location && self.location.hostname); } catch (_) { return ''; }
  };
  // Match main-thread stabilityActiveNow: evaluate host at noise-time, not only at launch.
  // active === true 时 noiseAmplitude = 1 (零噪声)，skipHosts 命中时 active === false (保留常规噪声 amp=3)
  const stabilityActiveNow = () => {
    const st = CFG.stability || {};
    if (st.mode === 'force') return !listHasHost(st.skipHosts, currentHost());
    if (st.mode === 'off') return false;
    const host = currentHost();
    if (!host) return Boolean(st.active);
    if (listHasHost(st.skipHosts, host)) return false;
    if (listHasHost(st.hosts, host)) return true;
    return Boolean(st.active);
  };
  const noiseAmplitudeNow = () => stabilityActiveNow() ? (Number(CFG.stability?.noiseAmplitude) || 1) : 3;
  const sampleStepDivisorNow = () => stabilityActiveNow()
    ? (Number(CFG.stability?.sampleStepDivisor) || 128)
    : 64;
  const applyNoise = (imageData, mark) => {
    try {
      const data = imageData.data;
      const width = imageData.width || 0;
      const height = imageData.height || 0;
      const maxW = Number(CFG.stability?.maxWidth) || 600;
      const maxH = Number(CFG.stability?.maxHeight) || 600;
      const limitW = width > 0 ? Math.min(width, maxW) : width;
      const limitH = height > 0 ? Math.min(height, maxH) : height;
      const amp = noiseAmplitudeNow();
      const stableWorker = stabilityActiveNow();
      if (width > 0 && height > 0) {
        if (stableWorker) {
          const key = width + 'x' + height + ':' + mark + ':' + square + ':' + amp;
          let locked = workerLocks.get(key);
          if (!locked) {
            locked = [];
            for (let y = 0; y < limitH; y += square) {
              for (let x = 0; x < limitW; x += square) {
                const px = ((y * width) + x) * 4;
                if (px + 3 >= data.length) continue;
                if (data[px + 3] === 0) continue;
                locked.push({ px: px, delta: Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2) });
              }
            }
            workerLocks.set(key, locked);
          }
          for (let i = 0; i < locked.length; i += 1) {
            const item = locked[i];
            if (item.px + 3 >= data.length) continue;
            if (data[item.px + 3] === 0) continue;
            data[item.px] = Math.max(0, Math.min(255, data[item.px] + item.delta));
          }
          return imageData;
        }
        for (let y = 0; y < limitH; y += square) {
          for (let x = 0; x < limitW; x += square) {
            const px = ((y * width) + x) * 4;
            if (px + 3 >= data.length) continue;
            if (data[px + 3] === 0) continue;
            const n = Math.floor(noise(px + mark) * amp) - Math.floor(amp / 2);
            data[px] = Math.max(0, Math.min(255, data[px] + n));
          }
        }
      } else {
        for (let i = 0; i < data.length; i += 4) {
          const n = Math.floor(noise(i + mark) * amp) - Math.floor(amp / 2);
          data[i] = Math.max(0, Math.min(255, data[i] + n));
        }
      }
    } catch (_) {}
    return imageData;
  };
  const sources = new WeakMap();
  const originalToString = Function.prototype.toString;
  const BRIDGE_TOKEN = ${JSON.stringify(bridgeToken)};
  const inspectBridge = (fn) => {
    try {
      if (typeof fn !== 'function') return null;
      // A same-origin iframe has its own Function.prototype and its own private WeakMap.
      // Calling fn.toString first enters that Realm's bridge; the current Realm is only a fallback.
      const ownToString = fn.toString;
      if (typeof ownToString === 'function') {
        const result = ownToString.call(fn, BRIDGE_TOKEN);
        if (result && typeof result === 'object' && result.bridge === true) return result;
      }
      const fallback = Function.prototype.toString.call(fn, BRIDGE_TOKEN);
      return fallback && typeof fallback === 'object' && fallback.bridge === true ? fallback : null;
    } catch (_) { return null; }
  };
  // Same-token worker recovery passes are no-ops. A changed profile has a fresh token and can
  // still apply without placing any marker on WorkerGlobalScope.
  const workerBridgeCheck = inspectBridge(Function.prototype.toString); if (workerBridgeCheck && workerBridgeCheck.token === BRIDGE_TOKEN) return;
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
    const nativeStr = (typeof original === 'function')
      ? (sources.get(original) || originalToString.call(original))
      : ('function ' + fnName + '() { [native code] }');
    try { sources.set(clean, nativeStr); } catch (_) {}
    try { sources.set(wrapper, nativeStr); } catch (_) {}
    return clean;
  };
  // Workers are probed independently of the page, so the accessors installed here need the
  // same native disguise: real WorkerNavigator getters stringify as [native code].
  const nativeAccessor = (key, desc) => {
    if (desc && typeof desc.get === 'function') {
      try { Object.defineProperty(desc.get, 'name', { configurable: true, value: 'get ' + key }); } catch (_) {}
      try { Object.defineProperty(desc.get, 'length', { configurable: true, value: 0 }); } catch (_) {}
      try { sources.set(desc.get, 'function get ' + key + '() { [native code] }'); } catch (_) {}
    }
    return desc;
  };
  const stripStackFrame = (err, fn, frameName) => {
    if (!err) return err;
    if (typeof Error.captureStackTrace === 'function' && typeof fn === 'function') {
      try { Error.captureStackTrace(err, fn); } catch (_) {}
    }
    if (typeof err.stack === 'string') {
      const nl = String.fromCharCode(10);
      const lines = err.stack.split(nl);
      const baseName = (frameName && frameName.indexOf('get ') === 0) ? frameName.slice(4) : '';
      if (lines.length > 1 && lines[1] && ((frameName && lines[1].indexOf(frameName) !== -1) || (baseName && lines[1].indexOf(baseName) !== -1))) {
        lines.splice(1, 1);
        try { err.stack = lines.join(nl); } catch (_) {}
      }
    }
    return err;
  };
  const getWorkerRealmTypeError = (receiver) => {
    try {
      if (receiver && receiver.constructor) {
        const ctor = receiver.constructor;
        if (typeof ctor.constructor === 'function') {
          const glob = ctor.constructor('return this')();
          if (glob && glob.TypeError) return glob.TypeError;
        }
      }
    } catch (_) {}
    try {
      if (typeof self !== 'undefined' && self.TypeError) return self.TypeError;
    } catch (_) {}
    try {
      if (typeof globalThis !== 'undefined' && globalThis.TypeError) return globalThis.TypeError;
    } catch (_) {}
    return (typeof TypeError !== 'undefined' ? TypeError : Error);
  };
  const makeNativeWorkerGetter = (key, getValue) => {
    let getter;
    const holder = {
      get [key]() {
        const isProto = (typeof WorkerNavigator !== 'undefined' && this === WorkerNavigator.prototype) ||
          (this && this.constructor && this.constructor.prototype === this) ||
          (this && Object.getPrototypeOf(this) === Object.prototype);
        const isWorkerNav = Boolean(
          this &&
          !isProto &&
          (typeof WorkerNavigator === 'undefined' || this !== WorkerNavigator.prototype) &&
          (
            this === (typeof navigator !== 'undefined' ? navigator : null) ||
            (typeof WorkerNavigator !== 'undefined' && (this instanceof WorkerNavigator || WorkerNavigator.prototype.isPrototypeOf(this))) ||
            (this.constructor && this.constructor.name === 'WorkerNavigator' && this !== this.constructor.prototype)
          )
        );
        if (!isWorkerNav) {
          const RealmTypeError = getWorkerRealmTypeError(this);
          const err = new RealmTypeError('Illegal invocation');
          stripStackFrame(err, getter, 'get ' + key);
          throw err;
        }
        return getValue.call(this);
      }
    };
    getter = Object.getOwnPropertyDescriptor(holder, key).get;
    try { Object.defineProperty(getter, 'name', { configurable: true, value: 'get ' + key }); } catch (_) {}
    try { Object.defineProperty(getter, 'length', { configurable: true, value: 0 }); } catch (_) {}
    try { sources.set(getter, 'function get ' + key + '() { [native code] }'); } catch (_) {}
    return getter;
  };
  try {
    const rawToString = function toString(...args) {
      const secret = args[0];
      if (secret === BRIDGE_TOKEN) {
        if (sources.has(this)) return { bridge: true, token: BRIDGE_TOKEN, nativeText: sources.get(this) };
        try {
          const inherited = originalToString.call(this, secret);
          if (inherited && typeof inherited === 'object' && inherited.bridge === true) return inherited;
        } catch (_) {}
      }
      if (sources.has(this)) return sources.get(this);
      return originalToString.call(this, ...args);
    };
    const patched = nativeLike(rawToString, originalToString, 'toString', 0);
    Object.defineProperty(Function.prototype, 'toString', { configurable: true, writable: true, value: patched });
  } catch (_) {}
  const replace = (proto, key, factory) => {
    try {
      if (!proto || typeof proto[key] !== 'function') return;
      const original = proto[key];
      const existing = inspectBridge(original);
      if (existing) {
        try { sources.set(original, existing.nativeText || ('function ' + (original.name || key) + '() { [native code] }')); } catch (_) {}
        return;
      }
      Object.defineProperty(proto, key, {
        configurable: true,
        enumerable: Object.getOwnPropertyDescriptor(proto, key)?.enumerable || false,
        writable: true,
        value: nativeLike(factory(original), original),
      });
    } catch (_) {}
  };
  try {
    const navProto = globalThis.WorkerNavigator?.prototype;
    if (navProto) {
      const navValues = {
        platform: CFG.platform,
        userAgent: CFG.userAgent,
        appVersion: CFG.appVersion,
        vendor: CFG.vendor,
        languages: Object.freeze([...(CFG.languages || [])]),
        language: (CFG.languages || [])[0] || 'en-US',
      };
      if (CFG.hardwareConcurrency != null) navValues.hardwareConcurrency = CFG.hardwareConcurrency;
      if (CFG.deviceMemory != null) navValues.deviceMemory = CFG.deviceMemory;
      for (const [key, value] of Object.entries(navValues)) {
        // Only members the build already exposes may be answered. WorkerNavigator does not carry
        // every Navigator member - vendor, for one, is window-only in this engine - and adding one
        // here leaves the worker with an own prototype member no stock build has, which is a single
        // getOwnPropertyNames() call away from identifying the profile.
        if (!(key in navProto)) continue;
        const getter = makeNativeWorkerGetter(key, () => value);
        try {
          Object.defineProperty(navProto, key, {
            configurable: true,
            enumerable: true,
            get: getter,
          });
        } catch (_) {}
      }
      const isIosPersona = CFG.os === "ios" || CFG.platform === "iPhone" || CFG.mobileDevice?.os === "ios";
      if (isIosPersona) {
        try {
          if (typeof WorkerNavigator !== "undefined" && WorkerNavigator.prototype) {
            delete WorkerNavigator.prototype.userAgentData;
            delete WorkerNavigator.prototype.gpu;
            delete WorkerNavigator.prototype.deviceMemory;
          }
          if (typeof self !== "undefined" && self.navigator) {
            delete self.navigator.userAgentData;
            delete self.navigator.gpu;
            delete self.navigator.deviceMemory;
          }
          if (typeof self !== "undefined") {
            delete self.GPU;
            delete self.GPUAdapter;
            delete self.GPUDevice;
          }
        } catch (_) {}
      }
      const metadata = CFG.userAgentMetadata || {};
      const brands = Object.freeze((metadata.brands || []).map((item) => Object.freeze({ brand: String(item.brand), version: String(item.version) })));
      const fullVersionList = Object.freeze((metadata.fullVersionList || brands).map((item) => Object.freeze({ brand: String(item.brand), version: String(item.version) })));
      const uaDataState = {
        brands,
        fullVersionList,
        fullVersion: String(metadata.fullVersion || metadata.uaFullVersion || ''),
        platform: String(metadata.platform || ''),
        platformVersion: String(metadata.platformVersion || ''),
        architecture: String(metadata.architecture || ''),
        model: String(metadata.model || ''),
        mobile: Boolean(metadata.mobile),
        bitness: String(metadata.bitness ?? '64'),
        wow64: Boolean(metadata.wow64),
      };
      const uaDataStates = new WeakMap();
      const uaProto = globalThis.NavigatorUAData && globalThis.NavigatorUAData.prototype;
      const patchedUaAccessors = new Set();
      const patchedUaMethods = new Set();
      const ensureUaAccessor = (key) => {
        if (!uaProto || patchedUaAccessors.has(key)) return Boolean(uaProto);
        const descriptor = Object.getOwnPropertyDescriptor(uaProto, key);
        if (!descriptor || typeof descriptor.get !== 'function') return false;
        const nativeGet = descriptor.get;
        try {
          Object.defineProperty(uaProto, key, nativeAccessor(key, {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get() {
              const state = uaDataStates.get(this);
              if (state) return state[key];
              return nativeGet.call(this);
            },
            set: descriptor.set,
          }));
        } catch (_) { return false; }
        patchedUaAccessors.add(key);
        return true;
      };
      const ensureUaMethod = (key, serve) => {
        if (!uaProto || patchedUaMethods.has(key)) return Boolean(uaProto);
        const descriptor = Object.getOwnPropertyDescriptor(uaProto, key);
        if (!descriptor || typeof descriptor.value !== 'function') return false;
        const nativeMethod = descriptor.value;
        try {
          Object.defineProperty(uaProto, key, {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            writable: descriptor.writable,
            value: nativeLike(function (...args) {
              const state = uaDataStates.get(this);
              if (state) return serve.apply(this, args);
              return nativeMethod.apply(this, args);
            }, nativeMethod, key, nativeMethod.length),
          });
        } catch (_) { return false; }
        patchedUaMethods.add(key);
        return true;
      };
      const highEntropyValue = (state, hints) => {
        const all = {
          brands: state.brands,
          fullVersionList: state.fullVersionList,
          fullVersion: state.fullVersion,
          uaFullVersion: state.fullVersion,
          platform: state.platform,
          platformVersion: state.platformVersion,
          architecture: state.architecture,
          model: state.model,
          mobile: state.mobile,
          bitness: state.bitness,
          wow64: state.wow64,
        };
        const out = { brands: state.brands, mobile: state.mobile, platform: state.platform };
        for (const hint of Array.isArray(hints) ? hints : []) if (hint in all) out[hint] = all[hint];
        return out;
      };
      const makeUaData = () => {
        const value = Object.create(uaProto || Object.prototype);
        uaDataStates.set(value, uaDataState);
        for (const key of ['brands', 'mobile', 'platform']) {
          if (!ensureUaAccessor(key)) {
            Object.defineProperty(value, key, { configurable: true, enumerable: true, value: uaDataState[key] });
          }
        }
        if (!ensureUaMethod('getHighEntropyValues', function getHighEntropyValues(hints) {
          return Promise.resolve(highEntropyValue(uaDataStates.get(this), hints));
        })) {
          Object.defineProperty(value, 'getHighEntropyValues', {
            configurable: true, enumerable: true, writable: true,
            value: function getHighEntropyValues(hints) { return Promise.resolve(highEntropyValue(uaDataState, hints)); },
          });
        }
        if (!ensureUaMethod('toJSON', function toJSON() {
          const state = uaDataStates.get(this) || uaDataState;
          return { brands: state.brands, mobile: state.mobile, platform: state.platform };
        })) {
          Object.defineProperty(value, 'toJSON', {
            configurable: true, enumerable: true, writable: true,
            value: function toJSON() { return { brands: uaDataState.brands, mobile: uaDataState.mobile, platform: uaDataState.platform }; },
          });
        }
        return value;
      };
      const uaData = makeUaData();
      try {
        // The member is secure-context gated, so a worker that does not have it here (an insecure
        // origin, an opaque document) must keep not having it.
        if ('userAgentData' in navProto) {
          Object.defineProperty(navProto, 'userAgentData', nativeAccessor('userAgentData', { configurable: true, enumerable: true, get: () => uaData }));
        }
      } catch (_) {}
      // Only a phone profile can reach the page-side replacement path. Desktop profiles keep the
      // native object and only have its prototype members rewritten.
      try {
        const pageNavProto = MOBILE ? globalThis.Navigator?.prototype : null;
        if (pageNavProto) {
          if ('userAgentData' in pageNavProto) {
            Object.defineProperty(pageNavProto, 'userAgentData', nativeAccessor('userAgentData', { configurable: true, enumerable: true, get: () => uaData }));
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Same guard as the page copy: the engine may already be in the target zone, and re-implementing
  // the Date and Intl surfaces on top of a correct engine only adds differences.
  const engineReportsTargetZone = (() => {
    try {
      const want = new Intl.DateTimeFormat('en-US', { timeZone: String(CFG.timezone).trim() }).resolvedOptions().timeZone;
      return new Intl.DateTimeFormat().resolvedOptions().timeZone === want;
    } catch (_) { return false; }
  })();
  if (CFG.timezone && !engineReportsTargetZone) {
    try {
      const targetTz = String(CFG.timezone).trim();
      new Intl.DateTimeFormat('en-US', { timeZone: targetTz }).format();

      const OrigDateTimeFormat = Intl.DateTimeFormat;
      const DateTimeFormatProto = OrigDateTimeFormat.prototype;

      const origSetTime = Date.prototype.setTime;
      const origGetTzOffset = Date.prototype.getTimezoneOffset;
      const origGetTime = Date.prototype.getTime;
      // Native getTime is the brand check: a receiver that is not a Date has to throw exactly the
      // TypeError the engine throws rather than answer with a coerced value.
      const asDate = (self) => { origGetTime.call(self); return self; };
      // The zone offset for an instant comes straight from ICU numeric long-offset form. Rebuilding
      // the wall clock through Date.UTC is not equivalent: that route cannot represent years outside
      // 1..9999 or before the common era, and it drops the sub-minute offsets some zones had.
      const offsetFormatter = new OrigDateTimeFormat('en-US', { timeZone: targetTz, timeZoneName: 'longOffset' });
      const getOffsetMinutes = (date) => {
        try {
          const ts = date.getTime();
          if (isNaN(ts)) return NaN;
          const raw = (offsetFormatter.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || '').replace(/^GMT/, '');
          const m = raw.match(/^([+-])(\\d{1,2})(?::(\\d{2}))?(?::(\\d{2}))?$/);
          if (!m) return 0;
          const seconds = Number(m[2]) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
          return (m[1] === '-' ? 1 : -1) * (seconds / 60);
        } catch (_) {
          return 0;
        }
      };
      // ICU has no long zone name for every instant, while V8 still prints one: outside the modern
      // metazone range the long form degrades to a numeric offset. A reference instant in the same
      // standard/daylight state supplies the name V8 prints, chosen by nearest offset.
      const zoneNameRefs = (() => {
        const nameAt = (ms) => new OrigDateTimeFormat(undefined, { timeZone: targetTz, timeZoneName: 'long' })
          .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value || '';
        const winter = Date.UTC(2026, 0, 15, 12);
        const summer = Date.UTC(2026, 6, 15, 12);
        return [{ offset: getOffsetMinutes(new Date(winter)), name: nameAt(winter) }, { offset: getOffsetMinutes(new Date(summer)), name: nameAt(summer) }];
      })();
      const zoneNameFor = (date) => {
        const name = new OrigDateTimeFormat(undefined, { timeZone: targetTz, timeZoneName: 'long' })
          .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || '';
        const offset = getOffsetMinutes(date);
        const exact = zoneNameRefs.find((ref) => ref.offset === offset);
        if (exact) return /^GMT/.test(name) ? (exact.name || name) : name;
        let best = zoneNameRefs[0];
        for (const ref of zoneNameRefs) if (Math.abs(ref.offset - offset) < Math.abs(best.offset - offset)) best = ref;
        return best.name || name;
      };

      const getLocalComponents = (date) => {
        const off = getOffsetMinutes(date);
        const shifted = new Date(date.getTime() - off * 60000);
        if (!isNaN(shifted.getTime())) return shifted;
        // ICU still answers at the domain edges, where the shifted instant is not representable, and
        // the wall clock there can itself sit past the Date domain, so the fields are handed back as
        // a read-only view instead of a Date that cannot exist.
        const parts = new OrigDateTimeFormat('en-US', {
          timeZone: targetTz, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).formatToParts(date);
        const get = (type) => parts.find((p) => p.type === type)?.value || '';
        const year = /BC/i.test(get('era')) ? 1 - parseInt(get('year'), 10) : numbered;
        const month = parseInt(get('month'), 10) - 1;
        const day = parseInt(get('day'), 10);
        const hour = parseInt(get('hour'), 10) % 24;
        const minute = parseInt(get('minute'), 10);
        const second = parseInt(get('second'), 10);
        const millisecond = ((date.getTime() % 1000) + 1000) % 1000;
        const weekday = new Date(Date.UTC(year, month, day)).getUTCDay();
        const invalid = () => NaN;
        return {
          getUTCFullYear: () => year,
          getUTCMonth: () => month,
          getUTCDate: () => day,
          getUTCDay: () => weekday,
          getUTCHours: () => hour,
          getUTCMinutes: () => minute,
          getUTCSeconds: () => second,
          getUTCMilliseconds: () => millisecond,
          getTime: invalid,
          setUTCFullYear: invalid,
          setUTCMonth: invalid,
          setUTCDate: invalid,
          setUTCHours: invalid,
          setUTCMinutes: invalid,
          setUTCSeconds: invalid,
          setUTCMilliseconds: invalid,
        };
      };

      // Reading timeZone here would add an access the engine already makes, and copying the options
      // would read every other option a second time, so a prototype-chained copy carries the default
      // zone while the page options stay the only source for everything else. A null argument has to
      // reach the engine unchanged, because the TypeError it raises is part of the surface.
      const withDefaultTimeZone = (options) => {
        if (options === undefined) return { timeZone: targetTz };
        if (options === null) return options;
        const boxed = Object(options);
        const opts = Object.create(boxed);
        // The engine reads timeZone exactly once, so the substitute is a lazy accessor rather than a
        // value: it forwards to the page options on the engine read and answers the target zone when
        // the page left the option absent or undefined. Copying the options would instead read every
        // other option a second time.
        let read = false;
        let resolved = targetTz;
        Object.defineProperty(opts, 'timeZone', {
          enumerable: true,
          configurable: true,
          get() {
            if (!read) {
              read = true;
              const fromPage = boxed.timeZone;
              resolved = fromPage === undefined ? targetTz : fromPage;
            }
            return resolved;
          },
        });
        return opts;
      };
      const PatchedDateTimeFormat = function DateTimeFormat(locales, options) {
        const opts = withDefaultTimeZone(options);
        if (!(this instanceof PatchedDateTimeFormat)) {
          return Reflect.construct(OrigDateTimeFormat, [locales, opts]);
        }
        return Reflect.construct(OrigDateTimeFormat, [locales, opts], new.target);
      };
      Object.defineProperty(PatchedDateTimeFormat, 'prototype', {
        value: DateTimeFormatProto,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      // Without this the prototype's constructor still points at the original, so the one-line
      // check Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat returns false.
      try {
        Object.defineProperty(DateTimeFormatProto, 'constructor', {
          configurable: true, writable: true, enumerable: false, value: PatchedDateTimeFormat,
        });
      } catch (_) {}
      if (OrigDateTimeFormat.supportedLocalesOf) {
        PatchedDateTimeFormat.supportedLocalesOf = nativeLike(
          function supportedLocalesOf(...args) { return OrigDateTimeFormat.supportedLocalesOf.apply(OrigDateTimeFormat, args); },
          OrigDateTimeFormat.supportedLocalesOf,
          'supportedLocalesOf',
          1
        );
      }
      nativeLike(PatchedDateTimeFormat, OrigDateTimeFormat, 'DateTimeFormat', 0, true);
      Intl.DateTimeFormat = PatchedDateTimeFormat;

      replace(Date.prototype, 'getTimezoneOffset', () => function getTimezoneOffset() {
        const minutes = getOffsetMinutes(asDate(this));
        if (!isFinite(minutes)) return NaN;
        const whole = Math.trunc(minutes);
        return whole === 0 ? 0 : whole;
      });

      const formatTzDate = (date) => {
        try {
          // en-US on purpose: the weekday and month abbreviations V8 prints are fixed English,
          // while the zone name in the parenthetical follows the default locale (zoneNameFor).
          const parts = new OrigDateTimeFormat('en-US', {
            timeZone: targetTz,
            weekday: 'short',
            month: 'short',
            day: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZoneName: 'long'
          }).formatToParts(date);
          const get = (type) => parts.find(p => p.type === type)?.value || '';
          const weekday = get('weekday');
          const month = get('month');
          const day = get('day');
          const localYear = getLocalComponents(date).getUTCFullYear();
          const year = localYear < 0 ? '-' + String(-localYear).padStart(4, '0') : String(localYear).padStart(4, '0');
          const hour = (get('hour') === '24' ? '00' : get('hour')).padStart(2, '0');
          const minute = get('minute').padStart(2, '0');
          const second = get('second').padStart(2, '0');
          const tzName = zoneNameFor(date);
          const diffMins = getOffsetMinutes(date);
          const sign = diffMins <= 0 ? '+' : '-';
          const absMins = Math.trunc(Math.abs(diffMins));
          const offH = String(Math.floor(absMins / 60)).padStart(2, '0');
          const offM = String(absMins % 60).padStart(2, '0');
          const gmt = 'GMT' + sign + offH + offM;
          return weekday + ' ' + month + ' ' + day + ' ' + year + ' ' + hour + ':' + minute + ':' + second + ' ' + gmt + ' (' + tzName + ')';
        } catch (_) {
          return date.toISOString();
        }
      };

      replace(Date.prototype, 'toString', () => function toString() {
        if (isNaN(asDate(this).getTime())) return 'Invalid Date';
        return formatTzDate(this);
      });

      replace(Date.prototype, 'toTimeString', () => function toTimeString() {
        if (isNaN(asDate(this).getTime())) return 'Invalid Date';
        const full = formatTzDate(this);
        const match = full.match(/[0-9]{4}[ ]+(.*)/);
        return match ? match[1] : full;
      });

      replace(Date.prototype, 'toDateString', () => function toDateString() {
        if (isNaN(asDate(this).getTime())) return 'Invalid Date';
        const full = formatTzDate(this);
        return full.split(' ').slice(0, 4).join(' ');
      });

      replace(Date.prototype, 'toLocaleString', (orig) => function toLocaleString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replace(Date.prototype, 'toLocaleDateString', (orig) => function toLocaleDateString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replace(Date.prototype, 'toLocaleTimeString', (orig) => function toLocaleTimeString(locales, options) {
        const opts = options && options.timeZone ? options : Object.assign({}, options, { timeZone: targetTz });
        return orig.call(this, locales, opts);
      });

      replace(Date.prototype, 'getHours', () => function getHours() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCHours();
      });

      replace(Date.prototype, 'getDate', () => function getDate() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCDate();
      });

      replace(Date.prototype, 'getDay', () => function getDay() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCDay();
      });

      replace(Date.prototype, 'getFullYear', () => function getFullYear() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCFullYear();
      });

      replace(Date.prototype, 'getMonth', () => function getMonth() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCMonth();
      });

      replace(Date.prototype, 'getMinutes', () => function getMinutes() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCMinutes();
      });

      replace(Date.prototype, 'getSeconds', () => function getSeconds() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCSeconds();
      });

      replace(Date.prototype, 'getMilliseconds', () => function getMilliseconds() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCMilliseconds();
      });

      replace(Date.prototype, 'getYear', () => function getYear() {
        if (isNaN(asDate(this).getTime())) return NaN;
        return getLocalComponents(this).getUTCFullYear() - 1900;
      });

      // Local-time setters must land in the spoofed zone too. Reading a component through the
      // patched getters while writing it through the host zone leaves the two disagreeing,
      // which is a stronger signal than not spoofing at all.
      const setLocal = (self, mutate) => {
        if (isNaN(asDate(self).getTime())) return NaN;
        const shifted = getLocalComponents(self);
        mutate(shifted);
        // Resolve the offset twice: the write may have crossed a DST boundary.
        let guess = shifted.getTime() + getOffsetMinutes(self) * 60000;
        guess = shifted.getTime() + getOffsetMinutes(new Date(guess)) * 60000;
        return origSetTime.call(self, guess);
      };
      replace(Date.prototype, 'setFullYear', () => function setFullYear(y, m, d) {
        return setLocal(this, (x) => {
          x.setUTCFullYear(y);
          if (m !== undefined) x.setUTCMonth(m);
          if (d !== undefined) x.setUTCDate(d);
        });
      });
      replace(Date.prototype, 'setMonth', () => function setMonth(m, d) {
        return setLocal(this, (x) => { x.setUTCMonth(m); if (d !== undefined) x.setUTCDate(d); });
      });
      replace(Date.prototype, 'setDate', () => function setDate(d) {
        return setLocal(this, (x) => x.setUTCDate(d));
      });
      replace(Date.prototype, 'setHours', () => function setHours(h, mi, sec, ms) {
        return setLocal(this, (x) => {
          x.setUTCHours(h);
          if (mi !== undefined) x.setUTCMinutes(mi);
          if (sec !== undefined) x.setUTCSeconds(sec);
          if (ms !== undefined) x.setUTCMilliseconds(ms);
        });
      });
      replace(Date.prototype, 'setMinutes', () => function setMinutes(mi, sec, ms) {
        return setLocal(this, (x) => {
          x.setUTCMinutes(mi);
          if (sec !== undefined) x.setUTCSeconds(sec);
          if (ms !== undefined) x.setUTCMilliseconds(ms);
        });
      });
      replace(Date.prototype, 'setSeconds', () => function setSeconds(sec, ms) {
        return setLocal(this, (x) => { x.setUTCSeconds(sec); if (ms !== undefined) x.setUTCMilliseconds(ms); });
      });
      replace(Date.prototype, 'setMilliseconds', () => function setMilliseconds(ms) {
        return setLocal(this, (x) => x.setUTCMilliseconds(ms));
      });

      // new Date(y, m, d, ...) and Date.parse('2026-01-15 12:00:00') are defined against the
      // *local* zone. Left alone they resolve against the host zone while every getter above
      // reports the spoofed one, so a two-line script recovers the real timezone.
      try {
        const OrigDate = Date;
        const localToUtc = (ms) => {
          if (isNaN(ms)) return NaN;
          // getOffsetMinutes keeps the JS sign convention (UTC+05:30 reports -330), so shifting
          // a wall-clock reading in the spoofed zone back to a real instant means adding it.
          let out = ms + getOffsetMinutes(new OrigDate(ms)) * 60000;
          out = ms + getOffsetMinutes(new OrigDate(out)) * 60000;
          return out;
        };
        // Matches ES2015+ "date-time forms without a timezone offset", which parse as local.
        const NO_TZ = new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?$');
        const parseLocal = (value) => {
          const raw = OrigDate.parse(value);
          if (isNaN(raw)) return raw;
          if (!NO_TZ.test(String(value).trim())) return raw;
          // OrigDate.parse resolved these fields against the host zone. Undo that with the
          // engine's own offset, then re-apply the spoofed zone's.
          const undo = raw - origGetTzOffset.call(new OrigDate(raw)) * 60000;
          return localToUtc(undo);
        };
        const PatchedDate = function Date(...args) {
          if (!new.target) return OrigDate();
          if (args.length === 0) return Reflect.construct(OrigDate, [], new.target);
          if (args.length === 1) {
            const only = args[0];
            if (typeof only === 'string') {
              return Reflect.construct(OrigDate, [parseLocal(only)], new.target);
            }
            return Reflect.construct(OrigDate, args, new.target);
          }
          // Interpret the fields as wall-clock time in the *spoofed* zone. Letting the engine
          // parse them first would apply the host zone's offset, which the correction below
          // would then apply a second time.
          const y = Number(args[0]);
          // undefined means "default"; anything else is coerced the way the engine would, so a NaN
          // field leaves the whole date Invalid instead of folding to 0.
          const field = (value, fallback) => (value === undefined ? fallback : Number(value));
          const wall = OrigDate.UTC(
            y >= 0 && y <= 99 ? y + 1900 : y,
            field(args[1], 0),
            field(args[2], 1),
            field(args[3], 0),
            field(args[4], 0),
            field(args[5], 0),
            field(args[6], 0)
          );
          return Reflect.construct(OrigDate, [localToUtc(wall)], new.target);
        };
        Object.defineProperty(PatchedDate, 'prototype', {
          value: OrigDate.prototype,
          writable: false,
          enumerable: false,
          configurable: false,
        });
        try {
          Object.defineProperty(OrigDate.prototype, 'constructor', {
            configurable: true, writable: true, enumerable: false, value: PatchedDate,
          });
        } catch (_) {}
        PatchedDate.now = OrigDate.now;
        PatchedDate.parse = nativeLike(
          function parse(value) { return parseLocal(value); },
          OrigDate.parse, 'parse', 1
        );
        PatchedDate.UTC = OrigDate.UTC;
        nativeLike(PatchedDate, OrigDate, 'Date', 7, true);
        globalThis.Date = PatchedDate;
      } catch (_) {}
    } catch (_) {}
  }
  const canvasMark = Number(CFG.canvas?.mark) || 1;
  if (CFG.canvas?.mode === 'blocked') {
    const deny = () => { throw new DOMException('Canvas reading is disabled by permissions policy', 'SecurityError'); };
    replace(globalThis.OffscreenCanvasRenderingContext2D?.prototype, 'getImageData', () => deny);
    replace(globalThis.OffscreenCanvas?.prototype, 'convertToBlob', () => function() {
      return Promise.reject(new DOMException('Canvas reading is disabled by permissions policy', 'SecurityError'));
    });
  } else if (CFG.canvas?.mode === 'noise') {
    replace(globalThis.OffscreenCanvasRenderingContext2D?.prototype, 'getImageData', (original) => function(...args) {
      return applyNoise(original.apply(this, args), canvasMark);
    });
    replace(globalThis.OffscreenCanvas?.prototype, 'convertToBlob', (original) => async function convertToBlob(options) {
      const blob = await original.call(this, options);
      try {
        const w = Number(this.width) || 0;
        const h = Number(this.height) || 0;
        if (w <= 0 || h <= 0) return blob;
        const bitmap = await createImageBitmap(blob);
        const copy = new OffscreenCanvas(w, h);
        const context = copy.getContext('2d');
        if (!context) return blob;
        context.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const image = context.getImageData(0, 0, copy.width, copy.height);
        context.putImageData(image, 0, 0);
        return original.call(copy, options);
      } catch (_) { return blob; }
    });
  }
  if (CFG.webgl?.mode === 'blocked') {
    replace(globalThis.OffscreenCanvas?.prototype, 'getContext', (original) => function(type, ...rest) {
      const value = String(type || '');
      if (value.includes('webgl') || value === 'experimental-webgl') return null;
      return original.call(this, type, ...rest);
    });
  } else if (CFG.webgl && (CFG.webgl.mode === 'noise' || (CFG.webgl.metaMode && CFG.webgl.metaMode !== 'real'))) {
    const mark = Number(CFG.webgl?.mark) || 1;
    const metaMode = String(CFG.webgl?.metaMode || 'noise');
    const pixelNoise = CFG.webgl.mode === 'noise';
    const enabledDebugExts = new WeakSet();
    const precisionOverridesMap = new WeakMap();
    const patchPrecisionFormatProto = (proto) => {
      if (!proto) return;
      for (const prop of ['rangeMin', 'rangeMax', 'precision']) {
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (desc && typeof desc.get === 'function') {
          const nativeGet = desc.get;
          Object.defineProperty(proto, prop, {
            configurable: desc.configurable,
            enumerable: desc.enumerable,
            get: nativeLike(function () {
              const custom = precisionOverridesMap.get(this);
              if (custom && typeof custom[prop] === 'number') {
                return custom[prop];
              }
              return nativeGet.call(this);
            }, nativeGet, 'get ' + prop, 0),
            set: desc.set,
          });
        }
      }
    };
    if (typeof WebGLShaderPrecisionFormat !== 'undefined' && WebGLShaderPrecisionFormat.prototype) {
      patchPrecisionFormatProto(WebGLShaderPrecisionFormat.prototype);
    }
    const targetGpuVendor = (() => {
      const gv = String(CFG.webgl?.gpu?.vendor || '').toLowerCase();
      if (gv) return gv;
      const v = String(CFG.webgl?.vendor || '').toLowerCase();
      const r = String(CFG.webgl?.renderer || '').toLowerCase();
      if (v.includes('nvidia') || r.includes('nvidia')) return 'nvidia';
      if (v.includes('amd') || v.includes('ati') || r.includes('amd') || r.includes('radeon')) return 'amd';
      if (v.includes('intel') || r.includes('intel')) return 'intel';
      if (v.includes('apple') || r.includes('apple')) return 'apple';
      return '';
    })();
    const isDisallowedVendorExtension = (name) => {
      if (!targetGpuVendor || metaMode === 'real') return false;
      const lower = String(name || '').toLowerCase();
      if (lower.startsWith('nv_') && targetGpuVendor !== 'nvidia') return true;
      if (lower.startsWith('amd_') && targetGpuVendor !== 'amd') return true;
      if (lower.startsWith('intel_') && targetGpuVendor !== 'intel') return true;
      if (lower.startsWith('qcom_') && targetGpuVendor !== 'qualcomm') return true;
      return false;
    };
    const patch = (proto) => {
      if (!proto) return;
      if (metaMode !== 'real') {
        if (proto.getParameter) {
          replace(proto, 'getParameter', (original) => function(param) {
            const UNMASKED_VENDOR_WEBGL = 0x9245;
            const UNMASKED_RENDERER_WEBGL = 0x9246;
            if (param === UNMASKED_VENDOR_WEBGL || param === UNMASKED_RENDERER_WEBGL) {
              if (!enabledDebugExts.has(this)) {
                // Conforms to real Chrome: without WEBGL_debug_renderer_info, native returns null and sets INVALID_ENUM
                return original.apply(this, arguments);
              }
              if (param === UNMASKED_VENDOR_WEBGL) return metaMode === 'blocked' ? '' : CFG.webgl.vendor;
              if (param === UNMASKED_RENDERER_WEBGL) return metaMode === 'blocked' ? '' : CFG.webgl.renderer;
            }
            const limits = CFG.webgl && CFG.webgl.limits;
            if (limits) {
              if (param === 0x0d3a) {
                const native = original.apply(this, arguments);
                const side = Number(limits[0x84e8]) || 0;
                if (side && native && native.length === 2) {
                  const out = new native.constructor(2);
                  out[0] = side; out[1] = side;
                  return out;
                }
                return native;
              }
              if (param === 0x846d) {
                const native = original.apply(this, arguments);
                const maxPoint = Number(limits[0x846d]) || 0;
                if (maxPoint && native && native.length === 2) {
                  const out = new native.constructor(2);
                  out[0] = native[0] || 1;
                  out[1] = maxPoint;
                  return out;
                }
                return native;
              }
              const isWebgl2 = typeof WebGL2RenderingContext !== 'undefined' && (this instanceof WebGL2RenderingContext);
              const WEBGL2_PARAM_KEYS = [0x8a30, 0x8a34, 0x8a2b, 0x8a2d];
              if (WEBGL2_PARAM_KEYS.includes(param)) {
                if (isWebgl2) return limits[param];
                return original.apply(this, arguments);
              }
              if (Object.prototype.hasOwnProperty.call(limits, param)) return limits[param];
            }
            return original.apply(this, arguments);
          });
        }
        if (proto.getShaderPrecisionFormat) {
          replace(proto, 'getShaderPrecisionFormat', (original) => function(shaderType, precisionType) {
            const fmt = original.apply(this, arguments);
            if (!fmt) return null;

            const osName = String(CFG.os || '').toLowerCase();
            const isMobilePersona = Boolean(CFG.mobile) || osName === 'android' || osName === 'ios'
              || (CFG.platform && /Android|iPhone|iPad/i.test(CFG.platform))
              || (CFG.webgl?.gpu?.vendor && /qualcomm|arm/i.test(CFG.webgl.gpu.vendor));

            let target = null;
            if (isMobilePersona) {
              if (precisionType === 0x8df1 || precisionType === 0x8df0) {
                target = { rangeMin: 14, rangeMax: 14, precision: 10 };
              } else if (precisionType === 0x8df2) {
                target = { rangeMin: 127, rangeMax: 127, precision: 23 };
              } else if (precisionType === 0x8df3 || precisionType === 0x8df4) {
                target = { rangeMin: 15, rangeMax: 14, precision: 0 };
              } else if (precisionType === 0x8df5) {
                target = { rangeMin: 31, rangeMax: 30, precision: 0 };
              }
            } else {
              if (precisionType === 0x8df0 || precisionType === 0x8df1 || precisionType === 0x8df2) {
                target = { rangeMin: 127, rangeMax: 127, precision: 23 };
              } else if (precisionType === 0x8df3 || precisionType === 0x8df4 || precisionType === 0x8df5) {
                target = { rangeMin: 31, rangeMax: 30, precision: 0 };
              }
            }

            if (target) {
              precisionOverridesMap.set(fmt, target);
            }
            return fmt;
          });
        }
      }
      if (proto.getExtension) {
        replace(proto, 'getExtension', (original) => function(name) {
          const extName = String(name || '').toLowerCase();
          if (metaMode === 'blocked' && extName === 'webgl_debug_renderer_info') return null;
          if (isDisallowedVendorExtension(extName)) return null;
          let ext = original.apply(this, arguments);
          if (extName === 'webgl_debug_renderer_info') {
            if (!ext && metaMode !== 'blocked' && metaMode !== 'real' && (CFG.webgl?.vendor || CFG.webgl?.renderer)) {
              const debugProto = typeof WebGLDebugRendererInfo !== 'undefined' ? WebGLDebugRendererInfo.prototype : Object.prototype;
              ext = Object.create(debugProto);
              Object.defineProperty(ext, 'UNMASKED_VENDOR_WEBGL', { value: 0x9245, enumerable: true, writable: false, configurable: false });
              Object.defineProperty(ext, 'UNMASKED_RENDERER_WEBGL', { value: 0x9246, enumerable: true, writable: false, configurable: false });
            }
            if (ext) enabledDebugExts.add(this);
          }
          return ext;
        });
      }
      if (proto.getSupportedExtensions) {
        replace(proto, 'getSupportedExtensions', (original) => function() {
          let list = original.apply(this, arguments);
          if (!Array.isArray(list)) return list;
          if (metaMode === 'blocked') {
            list = list.filter((ext) => String(ext).toLowerCase() !== 'webgl_debug_renderer_info');
          } else if (metaMode !== 'real' && (CFG.webgl?.vendor || CFG.webgl?.renderer)) {
            if (!list.some((ext) => String(ext).toLowerCase() === 'webgl_debug_renderer_info')) {
              list = [...list, 'WEBGL_debug_renderer_info'];
            }
          }
          list = list.filter((ext) => !isDisallowedVendorExtension(ext));
          return list;
        });
      }
      if (!pixelNoise || !proto.readPixels) return;
      replace(proto, 'readPixels', (original) => function(...args) {
        const result = original.apply(this, args);
        try {
          const pixels = args[6];
          if (pixels && pixels.length && (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
            let hasNonZero = false;
            for (let i = 0; i < pixels.length; i += 32) {
              if (pixels[i] !== 0) { hasNonZero = true; break; }
            }
            if (!hasNonZero) return result;

            const ampW = noiseAmplitudeNow();
            const stepDiv = sampleStepDivisorNow();
            const step2 = Math.max(4, Math.floor(pixels.length / stepDiv));
            for (let i = 0; pixels && i < pixels.length; i += step2) {
              const alphaIdx = i - (i % 4) + 3;
              if (alphaIdx < pixels.length && pixels[alphaIdx] === 0) continue;
              const n = Math.floor(noise(i + mark) * ampW) - Math.floor(ampW / 2);
              pixels[i] = Math.max(0, Math.min(255, (pixels[i] || 0) + n));
            }
          }
        } catch (_) {}
        return result;
      });
    };
    patch(globalThis.WebGLRenderingContext?.prototype);
    patch(globalThis.WebGL2RenderingContext?.prototype);
  }
  // DedicatedWorker WebGPU adapter surface parity
  if (CFG.webgpu) {
    try {
      const gpuMode = String(CFG.webgpu.mode || "real");
      const navGpu = (() => { try { return navigator.gpu || null; } catch (_) { return null; } })();
      const gpuProto = (typeof GPU !== 'undefined' && GPU.prototype) || (navGpu && Object.getPrototypeOf(navGpu));

      const gpuInfo = CFG.webgpu.gpu && (CFG.webgpu.gpu.vendor || CFG.webgpu.gpu.architecture)
        ? {
          vendor: String(CFG.webgpu.gpu.vendor || ""),
          architecture: String(CFG.webgpu.gpu.architecture || ""),
          device: String(CFG.webgpu.gpu.device || ""),
          description: String(CFG.webgpu.gpu.description || CFG.webgpu.gpu.architecture || ""),
        }
        : null;

      if (gpuMode === "blocked" && gpuProto) {
        replace(gpuProto, 'requestAdapter', (origReq) => async function requestAdapter(...args) {
          if (typeof origReq === 'function') {
            try {
              await origReq.apply(this, args);
            } catch (err) {
              if (err instanceof TypeError) throw err;
            }
          }
          return null;
        });
      } else if (gpuMode === "webgl" && gpuInfo && gpuProto) {
        const infoOverrides = new WeakMap();
        const adapterInfos = new WeakMap();
        const featuresMap = new WeakMap();
        const limitsMap = new WeakMap();
        const patchedInfoKeys = new Set();
        let patchedFeaturesProto = false;
        let patchedLimitsProto = false;
        let adapterProtoPatched = false;

        const targetVendor = String(gpuInfo.vendor || '').toLowerCase().trim();
        const targetArch = String(gpuInfo.architecture || '').toLowerCase().trim();
        const disallowedFeatures = new Set();
        if (targetVendor === 'intel' || targetVendor === 'nvidia' || targetVendor === 'amd') {
          disallowedFeatures.add('texture-compression-astc');
          disallowedFeatures.add('texture-compression-etc2');
          if (targetVendor === 'intel' && (targetArch.includes('gen9') || targetArch.includes('gen7') || targetArch.includes('gen11') || targetArch.includes('gen-9') || targetArch.includes('gen-7'))) {
            disallowedFeatures.add('shader-f16');
            disallowedFeatures.add('subgroups-f16');
          }
        } else if (targetVendor === 'qualcomm' || targetVendor === 'arm' || targetVendor === 'samsung') {
          disallowedFeatures.add('texture-compression-bc');
        }

        const getFamilyLimits = (vendor, arch) => {
          const v = String(vendor || '').toLowerCase().trim();
          if (v === 'nvidia' || v === 'amd') {
            return {
              maxTextureDimension1D: 16384,
              maxTextureDimension2D: 16384,
              maxTextureDimension3D: 2048,
              maxTextureArrayLayers: 2048,
              maxBufferSize: 2147483648,
              maxStorageBufferBindingSize: 2147483648,
              minUniformBufferOffsetAlignment: 256,
              minStorageBufferOffsetAlignment: 256,
              maxComputeWorkgroupStorageSize: 32768,
              maxComputeInvocationsPerWorkgroup: 1024,
              maxComputeWorkgroupSizeX: 1024,
              maxComputeWorkgroupSizeY: 1024,
              maxComputeWorkgroupSizeZ: 64,
            };
          }
          if (v === 'intel' || v === 'apple') {
            return {
              maxTextureDimension1D: 16384,
              maxTextureDimension2D: 16384,
              maxTextureDimension3D: 2048,
              maxTextureArrayLayers: 2048,
              maxBufferSize: 2147483648,
              maxStorageBufferBindingSize: 1073741824,
              minUniformBufferOffsetAlignment: 256,
              minStorageBufferOffsetAlignment: 256,
              maxComputeWorkgroupStorageSize: 32768,
              maxComputeInvocationsPerWorkgroup: 1024,
              maxComputeWorkgroupSizeX: 1024,
              maxComputeWorkgroupSizeY: 1024,
              maxComputeWorkgroupSizeZ: 64,
            };
          }
          if (v === 'qualcomm' || v === 'arm') {
            return {
              maxTextureDimension1D: 8192,
              maxTextureDimension2D: 8192,
              maxTextureDimension3D: 2048,
              maxTextureArrayLayers: 2048,
              maxBufferSize: 268435456,
              maxStorageBufferBindingSize: 134217728,
              minUniformBufferOffsetAlignment: 256,
              minStorageBufferOffsetAlignment: 256,
              maxComputeWorkgroupStorageSize: 16384,
              maxComputeInvocationsPerWorkgroup: 256,
              maxComputeWorkgroupSizeX: 256,
              maxComputeWorkgroupSizeY: 256,
              maxComputeWorkgroupSizeZ: 64,
            };
          }
          return {};
        };

        const resolveLimits = (hostLimits) => {
          const familyLimits = getFamilyLimits(gpuInfo.vendor, gpuInfo.architecture);
          const out = {};
          for (const [k, famVal] of Object.entries(familyLimits)) {
            try {
              const hostVal = hostLimits[k];
              if (typeof hostVal === 'number') {
                if (k.startsWith('min')) {
                  out[k] = Math.max(famVal, hostVal);
                } else {
                  out[k] = Math.min(famVal, hostVal);
                }
              }
            } catch (_) {}
          }
          return out;
        };

        const patchInfoAccessors = (iProto) => {
          if (!iProto) return;
          for (const key of Object.keys(gpuInfo)) {
            if (patchedInfoKeys.has(key)) continue;
            const desc = Object.getOwnPropertyDescriptor(iProto, key);
            if (!desc || typeof desc.get !== 'function') continue;
            const natGet = desc.get;
            Object.defineProperty(iProto, key, {
              configurable: desc.configurable,
              enumerable: desc.enumerable,
              get: nativeLike(function adapterInfoValue() {
                const val = infoOverrides.get(this);
                if (val && Object.prototype.hasOwnProperty.call(val, key)) return val[key];
                return natGet.call(this);
              }, natGet, 'get ' + key, 0),
              set: desc.set,
            });
            patchedInfoKeys.add(key);
          }
        };

        const patchFeaturesAccessors = (fProto) => {
          if (!fProto || patchedFeaturesProto) return;
          patchedFeaturesProto = true;
          const sizeDesc = Object.getOwnPropertyDescriptor(fProto, 'size');
          if (sizeDesc && typeof sizeDesc.get === 'function') {
            const natSizeGet = sizeDesc.get;
            Object.defineProperty(fProto, 'size', {
              configurable: sizeDesc.configurable,
              enumerable: sizeDesc.enumerable,
              get: nativeLike(function size() {
                natSizeGet.call(this);
                const filtered = featuresMap.get(this);
                return filtered ? filtered.size : natSizeGet.call(this);
              }, natSizeGet, 'get size', 0),
              set: sizeDesc.set,
            });
          }
          if (typeof fProto.has === 'function') {
            const natHas = fProto.has;
            const hasMethod = nativeLike(function has(key) {
              natHas.call(this, key);
              const filtered = featuresMap.get(this);
              if (filtered) return filtered.has(String(key));
              return natHas.call(this, key);
            }, natHas, 'has', 1);
            Object.defineProperty(fProto, 'has', {
              configurable: true,
              enumerable: true,
              writable: true,
              value: hasMethod,
            });
          }
          const wrapIter = (key, makeIter) => {
            if (typeof fProto[key] === 'function') {
              const natFn = fProto[key];
              const method = nativeLike(function (...args) {
                natFn.apply(this, args);
                const filtered = featuresMap.get(this);
                if (filtered) return makeIter(filtered);
                return natFn.apply(this, args);
              }, natFn, key, natFn.length);
              Object.defineProperty(fProto, key, {
                configurable: true,
                enumerable: true,
                writable: true,
                value: method,
              });
            }
          };
          wrapIter('entries', (f) => f.entries());
          wrapIter('keys', (f) => f.keys());
          wrapIter('values', (f) => f.values());
          if (typeof Symbol !== 'undefined' && Symbol.iterator && typeof fProto[Symbol.iterator] === 'function') {
            const natSym = fProto[Symbol.iterator];
            const symMethod = nativeLike(function () {
              natSym.call(this);
              const filtered = featuresMap.get(this);
              if (filtered) return filtered[Symbol.iterator]();
              return natSym.call(this);
              // Do NOT rename or re-arity this wrapper: a Blink setlike prototype exposes
              // Symbol.iterator as the very same values function object, so the native
              // name/length are part of the observable surface. Overriding them would make the
              // prototype signature differ from an un-injected build.
            }, natSym);
            Object.defineProperty(fProto, Symbol.iterator, {
              configurable: true,
              enumerable: false,
              writable: true,
              value: symMethod,
            });
          }
          if (typeof fProto.forEach === 'function') {
            const natForEach = fProto.forEach;
            const forEachMethod = nativeLike(function forEach(callback, thisArg) {
              natForEach.call(this, () => {});
              const filtered = featuresMap.get(this);
              if (filtered) {
                for (const val of filtered) {
                  callback.call(thisArg, val, val, this);
                }
                return;
              }
              return natForEach.apply(this, arguments);
            }, natForEach, 'forEach', 1);
            Object.defineProperty(fProto, 'forEach', {
              configurable: true,
              enumerable: true,
              writable: true,
              value: forEachMethod,
            });
          }
        };

        const patchLimitsAccessors = (lProto) => {
          if (!lProto || patchedLimitsProto) return;
          patchedLimitsProto = true;
          const props = Object.getOwnPropertyNames(lProto);
          for (const key of props) {
            if (key === 'constructor') continue;
            const desc = Object.getOwnPropertyDescriptor(lProto, key);
            if (!desc || typeof desc.get !== 'function') continue;
            const natGet = desc.get;
            Object.defineProperty(lProto, key, {
              configurable: desc.configurable,
              enumerable: desc.enumerable,
              get: nativeLike(function () {
                natGet.call(this);
                const custom = limitsMap.get(this);
                if (custom && Object.prototype.hasOwnProperty.call(custom, key)) {
                  return custom[key];
                }
                return natGet.call(this);
              }, natGet, 'get ' + key, 0),
              set: desc.set,
            });
          }
        };

        const patchAdapterProto = (aProto) => {
          if (adapterProtoPatched || !aProto) return;
          adapterProtoPatched = true;
          const infoDesc = Object.getOwnPropertyDescriptor(aProto, 'info');
          if (infoDesc && typeof infoDesc.get === 'function') {
            const natInfoGet = infoDesc.get;
            Object.defineProperty(aProto, 'info', {
              configurable: infoDesc.configurable,
              enumerable: infoDesc.enumerable,
              get: nativeLike(function info() {
                const spoofed = adapterInfos.get(this);
                return spoofed || natInfoGet.call(this);
              }, natInfoGet, 'get info', 0),
              set: infoDesc.set,
            });
          }

          const featuresDesc = Object.getOwnPropertyDescriptor(aProto, 'features');
          if (featuresDesc && typeof featuresDesc.get === 'function') {
            const natFeaturesGet = featuresDesc.get;
            Object.defineProperty(aProto, 'features', {
              configurable: featuresDesc.configurable,
              enumerable: featuresDesc.enumerable,
              get: nativeLike(function features() {
                const f = natFeaturesGet.call(this);
                if (f && !featuresMap.has(f)) {
                  const allowed = new Set();
                  try {
                    for (const item of f) {
                      if (!disallowedFeatures.has(item)) allowed.add(item);
                    }
                  } catch (_) {}
                  featuresMap.set(f, allowed);
                }
                return f;
              }, natFeaturesGet, 'get features', 0),
              set: featuresDesc.set,
            });
          }

          const limitsDesc = Object.getOwnPropertyDescriptor(aProto, 'limits');
          if (limitsDesc && typeof limitsDesc.get === 'function') {
            const natLimitsGet = limitsDesc.get;
            Object.defineProperty(aProto, 'limits', {
              configurable: limitsDesc.configurable,
              enumerable: limitsDesc.enumerable,
              get: nativeLike(function limits() {
                const l = natLimitsGet.call(this);
                if (l && !limitsMap.has(l)) {
                  limitsMap.set(l, resolveLimits(l));
                }
                return l;
              }, natLimitsGet, 'get limits', 0),
              set: limitsDesc.set,
            });
          }

          if (typeof aProto.requestAdapterInfo === 'function') {
            replace(aProto, 'requestAdapterInfo', (origReqInfo) => async function requestAdapterInfo(...args) {
              const info = await origReqInfo.apply(this, args);
              if (!info || typeof info !== 'object') return info;
              const iProto = (typeof GPUAdapterInfo !== 'undefined' && GPUAdapterInfo.prototype) || Object.getPrototypeOf(info);
              patchInfoAccessors(iProto);
              infoOverrides.set(info, gpuInfo);
              adapterInfos.set(this, info);
              return info;
            });
          }
        };

        // Pre-patch if global prototypes exist
        if (typeof GPUAdapterInfo !== 'undefined' && GPUAdapterInfo.prototype) {
          patchInfoAccessors(GPUAdapterInfo.prototype);
        }
        if (typeof GPUSupportedFeatures !== 'undefined' && GPUSupportedFeatures.prototype) {
          patchFeaturesAccessors(GPUSupportedFeatures.prototype);
        }
        if (typeof GPUSupportedLimits !== 'undefined' && GPUSupportedLimits.prototype) {
          patchLimitsAccessors(GPUSupportedLimits.prototype);
        }
        if (typeof GPUAdapter !== 'undefined' && GPUAdapter.prototype) {
          patchAdapterProto(GPUAdapter.prototype);
        }

        const prepareAdapter = (adapter) => {
          if (!adapter) return;
          const aProto = (typeof GPUAdapter !== 'undefined' && GPUAdapter.prototype) || Object.getPrototypeOf(adapter);
          patchAdapterProto(aProto);

          let info = null;
          try { info = adapter.info; } catch (_) {}
          if (info && typeof info === 'object') {
            const iProto = (typeof GPUAdapterInfo !== 'undefined' && GPUAdapterInfo.prototype) || Object.getPrototypeOf(info);
            patchInfoAccessors(iProto);
            infoOverrides.set(info, gpuInfo);
            adapterInfos.set(adapter, info);
          }

          let features = null;
          try { features = adapter.features; } catch (_) {}
          if (features && typeof features === 'object') {
            const fProto = (typeof GPUSupportedFeatures !== 'undefined' && GPUSupportedFeatures.prototype) || Object.getPrototypeOf(features);
            patchFeaturesAccessors(fProto);
            if (!featuresMap.has(features)) {
              const allowed = new Set();
              try {
                for (const item of features) {
                  if (!disallowedFeatures.has(item)) allowed.add(item);
                }
              } catch (_) {}
              featuresMap.set(features, allowed);
            }
          }

          let limits = null;
          try { limits = adapter.limits; } catch (_) {}
          if (limits && typeof limits === 'object') {
            const lProto = (typeof GPUSupportedLimits !== 'undefined' && GPUSupportedLimits.prototype) || Object.getPrototypeOf(limits);
            patchLimitsAccessors(lProto);
            if (!limitsMap.has(limits)) {
              limitsMap.set(limits, resolveLimits(limits));
            }
          }
        };

        replace(gpuProto, 'requestAdapter', (origReq) => async function requestAdapter(...args) {
          const adapter = await origReq.apply(this, args);
          if (!adapter) return adapter;
          prepareAdapter(adapter);
          return adapter;
        });
      }
    } catch (_) {}
  }
  if (typeof StorageManager !== 'undefined' && StorageManager.prototype && StorageManager.prototype.estimate) {
    try {
      const origEstimate = StorageManager.prototype.estimate;
      const isMob = Boolean(CFG.mobile || isIosPersona || isAndroidPersona);
      const mem = Number(CFG.deviceMemory) || 8;
      const personaQuota = isMob
        ? (mem >= 8 ? 16106127360 : 10737418240)
        : (mem >= 8 ? 64424509440 : 32212254720);

      const patchedEstimate = function estimate() {
        if (!this || !(this instanceof StorageManager)) {
          return Promise.reject(new TypeError("Illegal invocation"));
        }
        return origEstimate.apply(this, arguments).then((res) => {
          return {
            quota: personaQuota,
            usage: res ? (res.usage || 0) : 0,
            usageDetails: res ? (res.usageDetails || {}) : {},
          };
        });
      };
      nativeLike(patchedEstimate, origEstimate, "estimate", 0);
      Object.defineProperty(StorageManager.prototype, "estimate", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: patchedEstimate,
      });
    } catch (_) {}
  }
})

();`;
}

function chromeArgsForFingerprint(fp, profile = {}) {
  let args = [];
  // Critical: without this, Chromium/CDP sets navigator.webdriver = true
  args.push('--disable-blink-features=AutomationControlled');
  // Never enable automation switch (some launchers add it by default)
  if (fp.userAgent) args.push(`--user-agent=${fp.userAgent}`);
  // TLS extension permutation by Chrome major from UA
  if (fp.uaProfile) {
    // Feature flags are list-valued: merging has to append and de-duplicate
    // rather than let one occurrence replace the other.
    args = mergeFlags(args, chromeArgsForUa(fp.uaProfile), { listFlags: LIST_VALUE_FLAGS });
  }
  if (fp.screen?.width && fp.screen?.height) {
    args.push(`--window-size=${fp.screen.width},${fp.screen.height}`);
  }
  if (fp.webrtc === 'disabled' || fp.webrtc === 'proxy') {
    args.push(
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--enforce-webrtc-ip-permission-check'
    );
  }
  if (fp.webgl?.mode === 'blocked') {
    args.push('--disable-webgl', '--disable-webgl2', '--disable-3d-apis');
  } else {
    // Ensure WebGL is available even on VMs/older GPUs that Chrome would normally blocklist
    args.push('--ignore-gpu-blocklist', '--enable-webgl');
    // Issue #19: SwiftShader software rendering when requested or when no GPU available
    if (profile.privacy?.softwareWebgl || profile.advanced?.softwareWebgl || fp.webgl?.software) {
      args.push(
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-compositing'
      );
    }
  }
  if (fp.audio?.mode === 'muted' || profile.privacy?.audio === 'muted') args.push('--mute-audio');
  if (fp.doNotTrack === '1' || profile.privacy?.dnt || profile.privacy?.dntMode === 'on') args.push('--do-not-track');
  // Use full BCP47 when present (ja-JP / zh-CN); Chrome accepts --lang=ja-JP
  const lang = (fp.languages && fp.languages[0]) || profile.language;
  if (lang) {
    const tag = String(lang).trim();
    const primary = tag.split(',')[0].trim();
    if (primary) args.push(`--lang=${primary}`);
  }
  if (process.platform === 'win32') {
    // Keep consistent UI scale across all multi-environment windows on Windows
    // to prevent some windows having 1.25x enlarged toolbars/tabbars.
    const scaleFactor = profile.privacy?.forceDeviceScaleFactor || profile.deviceScaleFactor || 1;
    args.push(`--force-device-scale-factor=${scaleFactor}`);
  }
  // Cloudflare 验证优化：关闭时更激进（可能卡盾）；开启时减少部分干扰
  if (profile.privacy?.cfOptimize === false) {
    // keep aggressive isolation defaults already applied by noise modes
  } else {
    // prefer not to hard-disable site features that CF challenge pages need
    // (no --disable-webgl here unless user chose blocked webgl above)
  }
  return args;
}

// Bookkeeping for the per-target inject. The runtime drives the same document-start script from
// several places (pre-start, post-start, watch sweeps, reload recovery, worker attach). Registering
// one identical source twice makes Chromium run it twice on every later navigation, and evaluating
// it twice on a live document stacks a second layer of noise on the readers, which shifts canvas /
// clientRects while the profile is already in use. Tracking what each target already carries keeps
// the later passes true no-ops without leaving anything the page itself could detect.
const TARGET_INJECT_STATE = new Map();
const MAX_TRACKED_TARGETS = 256;
const injectSourceKey = (source) => crypto.createHash('sha1').update(source).digest('hex').slice(0, 16);

async function applyFingerprintToTab(cdpCall, webSocketDebuggerUrl, fp, profile = {}, options = {}) {
  const privacy = profile.privacy || {};
  const timezone = privacy.timezoneMode === 'real'
    ? ''
    : String(privacy.timezone || profile.timezone || profile.exitTimezone || fp.timezone || '').trim();
  // geoMode: custom coords | disabled/prompt (no override) | ip/allow (from exit IP)
  let latitude = null;
  let longitude = null;
  if (privacy.geoMode === 'custom') {
    latitude = Number(privacy.latitude);
    longitude = Number(privacy.longitude);
  } else if (privacy.geoMode === 'disabled' || privacy.geoMode === 'prompt') {
    latitude = null;
    longitude = null;
  } else {
    latitude = Number(profile.exitLatitude);
    longitude = Number(profile.exitLongitude);
  }

  // cdpCall may be:
  //  1) (wsUrl, method, params) — classic page WebSocket path
  //  2) (method, params) — flattened session path (sessionId bound by caller)
  const invoke = async (method, params = {}) => {
    if (typeof cdpCall !== 'function') throw new Error('CDP call function required');
    if (webSocketDebuggerUrl == null) return cdpCall(method, params);
    return cdpCall(webSocketDebuggerUrl, method, params);
  };

  const source = buildInjectionScript(fp);
  const fpKey = injectSourceKey(source);
  const injectTargetKey = typeof options.applyKey === 'string' && options.applyKey
    ? options.applyKey
    : (typeof webSocketDebuggerUrl === 'string' && webSocketDebuggerUrl ? webSocketDebuggerUrl : '');
  const forceInject = options.force === true;
  const injectState = injectTargetKey ? TARGET_INJECT_STATE.get(injectTargetKey) : null;
  const sameConfig = Boolean(injectState && injectState.fpKey === fpKey);
  const alreadyPatched = Boolean(sameConfig && injectState.documentStartOk && injectState.evaluated);
  // Nothing left to do for this target: the live document already carries this exact config and the
  // document-start registration covers every later navigation.
  if (alreadyPatched && !forceInject) return;

  // Page domain must be enabled or addScriptToEvaluateOnNewDocument is a no-op on some hosts.
  await invoke('Page.enable', {}).catch(() => {});
  await invoke('Runtime.enable', {}).catch(() => {});

  // Soft overrides: CDP rejects a second setLocale/setTimezone with
  // "Another locale override is already in effect" — must not abort the whole inject.
  const softOverride = async (method, params) => {
    try {
      await invoke(method, params);
    } catch (error) {
      const msg = String(error && error.message || error || '');
      if (/already in effect|cannot be overridden|not available|Command can only be executed on top-level targets|Cannot find default execution context/i.test(msg)) return;
      throw error;
    }
  };

  // Network/Emulation.setUserAgentOverride + UserAgentMetadata (Client Hints)
  if (fp.userAgent || fp.uaProfile) {
    const isIos = Boolean((fp.mobileDevice && fp.mobileDevice.os === 'ios') || fp.uaProfile?.os === 'ios' || (fp.platform && /iphone|ipad|ipod/i.test(fp.platform)));
    const uaProfile = fp.uaProfile || buildUaProfile({
      userAgent: fp.userAgent,
      platform: fp.platform,
    });
    const acceptLanguage = fp.acceptLanguage || buildAcceptLanguageHeader(fp.languages || ['en-US', 'en']);
    const override = cdpUserAgentOverride(uaProfile, acceptLanguage);
    if (isIos) {
      override.userAgentMetadata = undefined;
    }
    // Emulation affects navigator + most page JS
    await softOverride('Emulation.setUserAgentOverride', override);
    // Network affects HTTP headers (User-Agent + sec-ch-ua*)
    await softOverride('Network.enable', {});
    await softOverride('Network.setUserAgentOverride', {
      userAgent: override.userAgent,
      acceptLanguage: override.acceptLanguage || formatAcceptLanguage(acceptLanguage),
      platform: override.platform,
      userAgentMetadata: isIos ? undefined : override.userAgentMetadata,
    });
  }
  // Desktop windows must retain Chromium's live viewport. A fixed device-metrics
  // override leaves the renderer at the fingerprint's initial size after resize,
  // producing a large blank region. screen.* remains spoofed by the document script.
  // A phone profile is the exception: there the layout viewport IS the device panel, and pinning
  // it is what makes innerWidth, screen.*, the pixel ratio and pointer type agree inside a
  // desktop window. Emulated touch goes with it, or a phone that cannot answer touch probes is
  // immediately suspicious.
  if (fp.mobile && fp.screen) {
    const viewport = fp.mobileDevice?.viewport || {};
    const mobileWidth = Math.round(Number(viewport.width) || Number(fp.screen.width) || 360);
    const mobileHeight = Math.round(Number(viewport.height) || Number(fp.screen.height) || 640);
    await softOverride('Emulation.setDeviceMetricsOverride', {
      width: mobileWidth,
      height: mobileHeight,
      deviceScaleFactor: Number(fp.screen.devicePixelRatio) || 3,
      mobile: true,
      screenWidth: Math.round(Number(fp.screen.width) || mobileWidth),
      screenHeight: Math.round(Number(fp.screen.height) || mobileHeight),
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
      positionX: 0,
      positionY: 0,
    });
    await softOverride('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: Number(fp.maxTouchPoints) || 5,
    });
  } else if (fp.screen && !options.isSubframe && options.targetType !== 'iframe') {
    await softOverride('Emulation.clearDeviceMetricsOverride', {});
  }
  if (timezone) {
    await softOverride('Emulation.setTimezoneOverride', { timezoneId: timezone });
  }
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    await softOverride('Emulation.setGeolocationOverride', {
      latitude,
      longitude,
      accuracy: privacy.accuracy || 100,
    });
  }
  if (fp.languages?.[0]) {
    await softOverride('Emulation.setLocaleOverride', { locale: fp.languages[0] });
  }

  // Register for future documents first (start page navigation depends on this).
  // Must not silently drop registration failures — otherwise navigation paints host FP.
  let documentStartOk = Boolean(sameConfig && injectState.documentStartOk);
  let scriptIdentifier = injectState && injectState.identifier ? injectState.identifier : null;
  if (!documentStartOk) {
    if (scriptIdentifier) {
      // The config changed under a live registration: drop the stale script so the next navigation
      // cannot run both the previous and the current inject back to back.
      await invoke('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptIdentifier }).catch(() => {});
      scriptIdentifier = null;
    }
    try {
      const added = await invoke('Page.addScriptToEvaluateOnNewDocument', { source });
      scriptIdentifier = added?.identifier || added?.result?.identifier || scriptIdentifier;
      documentStartOk = true;
    } catch (error) {
      const msg = String(error && error.message || error || '');
      if (!/already|duplicate|exists/i.test(msg)) {
        // Retry once after re-enabling Page domain.
        await invoke('Page.enable', {}).catch(() => {});
        try {
          const added = await invoke('Page.addScriptToEvaluateOnNewDocument', { source });
          scriptIdentifier = added?.identifier || added?.result?.identifier || scriptIdentifier;
          documentStartOk = true;
        } catch (retryError) {
          const retryMsg = String(retryError && retryError.message || retryError || '');
          if (!/already|duplicate|exists/i.test(retryMsg)) {
            // Soft: still try Runtime.evaluate on current document.
            documentStartOk = false;
          } else {
            documentStartOk = true;
          }
        }
      } else {
        documentStartOk = true;
      }
    }
  }
  // Already-open documents: best-effort patch. Never abort startup if evaluate throws
  // (Chromium often reports "Uncaught" for redefine races; document-start still applies on next nav).
  let evaluatedOk = false;
  if (!options.skipEvaluate && !options.isWaiting) {
    try {
      const evaluated = await invoke('Runtime.evaluate', {
      expression: source,
      returnByValue: false,
      awaitPromise: false,
    });
    const exceptionDetails = evaluated && (evaluated.exceptionDetails || evaluated.result?.exceptionDetails);
    if (exceptionDetails) {
      // leave a soft signal for callers that inspect return value; do not throw
      const text = exceptionDetails.text
        || exceptionDetails.exception?.description
        || 'Uncaught';
      const err = new Error(text);
      err.softInject = true;
      err.exceptionDetails = exceptionDetails;
      err.documentStartOk = documentStartOk;
      // Soft path: swallow so keepDefaultTab can still open the welcome page.
    } else {
      evaluatedOk = true;
    }
  } catch (error) {
    const msg = String(error && error.message || error || '');
    if (!/Uncaught|already in effect|cannot be overridden|Cannot find default execution context|Command can only be executed on top-level targets/i.test(msg)) {
      // unexpected CDP transport errors still surface
      throw error;
    }
  }
  }
  if (injectTargetKey) {
    TARGET_INJECT_STATE.set(injectTargetKey, { fpKey, identifier: scriptIdentifier, documentStartOk, evaluated: evaluatedOk });
    if (TARGET_INJECT_STATE.size > MAX_TRACKED_TARGETS) {
      // Bounded: keep the most recent targets so a long-running host cannot grow this forever.
      const oldest = TARGET_INJECT_STATE.keys().next().value;
      TARGET_INJECT_STATE.delete(oldest);
    }
  }
}

module.exports = {
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
  buildFontMetricsScript,
  loadFontSubsetPayload,
  mapPlatformToSubsetKey,
  FONT_SUBSET_ROOT,
  chromeArgsForFingerprint,
  applyFingerprintToTab,
  fingerprintConsistencyIssues,
  hashSeed,
  createMediaDevicesFromSeed,
  createSpeechVoicesFromSeed,
  createDeviceNameFromSeed,
  createLocalIpFromSeed,
  formatGeopositionValue,
  createBatteryFromSeed,
  buildWebglFpPayload,
  webglParameterOverrides,
  normalizeGpuArchitecture,
  isDisallowedVendorExtension,
  WEBGL_PARAM_IDS,
  HOST_WEBGL_LIMITS,
  HOST_WEBGL2_DEFAULTS,
  MEDIA_DEVICE_POOLS_BY_OS,
  MEDIA_DEVICE_TEMPLATES,
  getHostWebglLimits,
  isPersonaWebglCompatible,
  compatiblePersonasForOs,
  resolveCompatiblePersona,
  audioMarkFromSeed,
  clientRectMarkFromSeed,
  resolveStabilityPolicy,
  matchStabilityHost,
  sampleCanvasBlocks,
  hammingDistance,
  applyStableCanvasNoise,
  withinHammingThreshold,
  DEFAULT_STABILITY_HOSTS,
  DEFAULT_STABILITY_SKIP_HOSTS,
  WEBGL_PRESETS,
  // re-export UA helpers for UI / selftest
  buildUaProfile,
  randomUaForSeed,
  OS_PRESETS,
};
