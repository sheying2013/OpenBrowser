'use strict';

const { deriveBridgeToken } = require('./font-placeholder');

/**
 * Worker font presence fallback script builder.
 *
 * Dedicated workers expose FontFace and can be probed using plain local() sources.
 * In cross-platform personas (such as a Windows persona running on a macOS host),
 * the underlying host font store answers queries directly, resolving host fonts and
 * rejecting persona fonts. This fallback intercepts plain local() FontFace constructions
 * in DedicatedWorkerGlobalScope, resolving persona fonts and rejecting foreign fonts with
 * DOMException('A network error occurred.', 'NetworkError'), while preserving native
 * pass-through for url(), data:, binary buffer, and mixed candidate sources.
 */

function buildWorkerFontPresenceSource(fp) {
  const list = fp && fp.fonts && Array.isArray(fp.fonts.list) ? fp.fonts.list : null;
  if (!list || !list.length) {
    return '';
  }

  const personaFonts = list.map((name) => String(name));
  const bridgeToken = String(fp.bridgeToken || deriveBridgeToken(fp));

  return `(() => {
  'use strict';
  try {
    const globalObj = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this);
    if (!globalObj) return;
    const BRIDGE_TOKEN = ${JSON.stringify(bridgeToken)};
    const inspectBridge = (fn) => {
      try {
        const result = Function.prototype.toString.call(fn, BRIDGE_TOKEN);
        return result && typeof result === 'object' && result.bridge === true ? result : null;
      } catch (_) { return null; }
    };
    const NativeFontFace = globalObj.FontFace;
    if (inspectBridge(NativeFontFace) || inspectBridge(NativeFontFace?.prototype?.load)) return;
    if (typeof NativeFontFace !== 'function' || typeof NativeFontFace.prototype !== 'object') {
      return;
    }

    const ownFamilies = new Set(${JSON.stringify(personaFonts.map((name) => name.toLowerCase()))});
    const localOnlyFamily = new WeakMap();
    const forcedStatus = new WeakMap();
    const settledLocal = new WeakMap();

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
          },
        };
        clean = holder[fnName];
        try { Object.defineProperty(clean, 'length', { configurable: true, value: fnLength }); } catch (_) {}
      }
      let nativeStr;
      if (typeof original === 'function') {
        const origStr = nativeSource.get(original) || originalToString.call(original);
        nativeStr = (origStr && origStr.includes('[native code]'))
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
          toString(...args) {
            const secret = args[0];
            if (secret === BRIDGE_TOKEN) {
              if (nativeSource.has(this)) return { bridge: true, nativeText: nativeSource.get(this) };
              try {
                const inherited = originalToString.call(this, secret);
                if (inherited && typeof inherited === 'object' && inherited.bridge === true) return inherited;
              } catch (_) {}
            }
            if (nativeSource.has(this)) return nativeSource.get(this);
            return originalToString.call(this, ...args);
          },
        };
        const patchedToString = holder.toString;
        nativeSource.set(patchedToString, 'function toString() { [native code] }');
        try {
          Object.defineProperty(Function.prototype, 'toString', {
            configurable: true,
            writable: true,
            value: patchedToString,
          });
        } catch (_) {}
      }
    } catch (_) {}

    const isPlainLocalSource = (source) => {
      const text = String(source === undefined || source === null ? '' : source).trim();
      return /^local\\s*\\(\\s*(?:"[^"]*"|'[^']*'|[^)'"]*)\\s*\\)$/i.test(text);
    };

    const missingFontError = () => {
      try {
        return new DOMException('A network error occurred.', 'NetworkError');
      } catch (_) {
        const fallback = new Error('A network error occurred.');
        fallback.name = 'NetworkError';
        return fallback;
      }
    };

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
      if (!new.target) {
        throw new TypeError("Failed to construct 'FontFace': Please use the 'new' operator, this DOM object cannot be initialized without it.");
      }
      const face = Reflect.construct(NativeFontFace, [family, source, descriptors], new.target);
      try {
        const localTarget = parseLocalSourceFamily(source);
        if (localTarget !== null) {
          localOnlyFamily.set(face, localTarget);
        }
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
    try {
      Object.defineProperty(NativeFontFace.prototype, 'constructor', {
        value: cleanCtor,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } catch (_) {}
    Object.defineProperty(globalObj, 'FontFace', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: cleanCtor,
    });

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
      Object.defineProperty(NativeFontFace.prototype, 'load', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: replacedLoad,
      });
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

    const NativeFontFaceSet = globalObj.FontFaceSet;
    const fontSetProto = (NativeFontFaceSet && NativeFontFaceSet.prototype) ||
      (globalObj.fonts && Object.getPrototypeOf(globalObj.fonts));
    if (fontSetProto) {
      const origCheck = fontSetProto.check;
      if (typeof origCheck === 'function') {
        const cleanCheck = nativeLike(function check(font, text) {
          try {
            const css = String(font || '');
            const match = css.match(/(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][A-Za-z0-9 _-]*))\s*$/);
            const family = match ? String(match[1] || match[2] || match[3] || '').trim().toLowerCase() : '';
            const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace']);
            if (family && !generic.has(family) && !ownFamilies.has(family)) {
              let authorFace = false;
              for (const face of this) {
                if (String(face.family || '').trim().toLowerCase() === family) { authorFace = true; break; }
              }
              if (!authorFace) return false;
            }
          } catch (_) {}
          return origCheck.apply(this, arguments);
        }, origCheck, 'check', 1, false);
        try {
          Object.defineProperty(fontSetProto, 'check', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: cleanCheck,
          });
        } catch (_) {}
      }

      const origLoad = fontSetProto.load;
      if (typeof origLoad === 'function') {
        const cleanLoad = nativeLike(function load(font, text) {
          try {
            const css = String(font || '');
            const match = css.match(/(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][A-Za-z0-9 _-]*))\s*$/);
            const family = match ? String(match[1] || match[2] || match[3] || '').trim().toLowerCase() : '';
            const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace']);
            if (family && !generic.has(family) && !ownFamilies.has(family)) {
              let authorFace = false;
              for (const face of this) {
                if (String(face.family || '').trim().toLowerCase() === family) { authorFace = true; break; }
              }
              if (!authorFace) return Promise.resolve([]);
            }
          } catch (_) {}
          return origLoad.apply(this, arguments);
        }, origLoad, 'load', 1, false);
        try {
          Object.defineProperty(fontSetProto, 'load', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: cleanLoad,
          });
        } catch (_) {}
      }
    }
  } catch (_) {}
})();`;
}

module.exports = {
  buildWorkerFontPresenceSource,
};
