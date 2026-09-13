'use strict';

/**
 * CSS @font-face src:local() dynamic path mitigation module.
 *
 * Provides buildCssFontLocalGateSource to generate an injectable IIFE script.
 * The script intercepts dynamic stylesheet and style element manipulation pathways:
 * - HTMLStyleElement.prototype.textContent & Element.prototype.innerHTML
 * - Node.prototype.appendChild, insertBefore, replaceChild & Element.prototype.replaceChildren/append/prepend
 * - CSSStyleSheet.prototype.insertRule & CSSGroupingRule.prototype.insertRule
 * - CSSStyleSheet.prototype.replace & replaceSync
 * - Document.prototype.adoptedStyleSheets & ShadowRoot.prototype.adoptedStyleSheets
 * - CSSStyleDeclaration.prototype.setProperty & cssText
 * - HTMLLinkElement.prototype.href & rel accessors
 * - Element.prototype.setAttribute & setAttributeNode for link href and rel
 * - Blob constructor and URL.createObjectURL / URL.revokeObjectURL for text/css Blobs
 *
 * Foreign local() font requests outside the persona whitelist are rewritten to
 * local("__ob_font_blocked__"), triggering NetworkError on document.fonts.load().
 * Whitelisted persona fonts are augmented with authentic platform font subset WOFF2 payloads
 * so that cross-platform requests (e.g. Segoe UI on non-Windows hosts) load genuine font data.
 * Web fonts (url/data) remain completely untouched.
 */

const fs = require('fs');
const path = require('path');

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

function loadSubsetsForGate(platformOrSubsets) {
  if (Array.isArray(platformOrSubsets) && platformOrSubsets.length > 0 && platformOrSubsets[0].base64) {
    return platformOrSubsets;
  }
  const root = resolveFontSubsetRoot();
  const indexPath = path.join(root, 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const platformKey = typeof platformOrSubsets === 'string' && platformOrSubsets.toLowerCase().includes('mac')
      ? 'macos'
      : 'windows';
    const pData = index.platforms?.[platformKey] || index.platforms?.windows || {};
    const list = [];
    for (const [family, entry] of Object.entries(pData)) {
      if (!entry || !entry.file) continue;
      const fPath = path.join(root, platformKey, entry.file);
      if (!fs.existsSync(fPath)) continue;
      try {
        const buf = fs.readFileSync(fPath);
        list.push({
          family,
          format: entry.file.endsWith('.woff2') ? 'font/woff2' : 'font/ttf',
          base64: buf.toString('base64'),
        });
      } catch (_) {}
    }
    return list;
  } catch (_) {
    return [];
  }
}

function buildCssFontLocalGateSource(personaFonts, fontSubsets) {
  let list = [];
  let platform = 'windows';
  if (Array.isArray(personaFonts)) {
    list = personaFonts;
  } else if (personaFonts && personaFonts.fonts && Array.isArray(personaFonts.fonts.list)) {
    list = personaFonts.fonts.list;
    if (personaFonts.platform) platform = personaFonts.platform;
  } else if (personaFonts && Array.isArray(personaFonts.list)) {
    list = personaFonts.list;
  }

  if (!list || !list.length) {
    return '';
  }

  const allowedList = list.map((name) => String(name).trim()).filter(Boolean);
  const allowedSetJson = JSON.stringify(allowedList.map((name) => name.toLowerCase()));
  const allowedFamiliesSet = new Set(allowedList.map((name) => name.toLowerCase()));

  let subsets = fontSubsets;
  if (!subsets || !Array.isArray(subsets) || subsets.length === 0) {
    subsets = loadSubsetsForGate(platform);
  }

  const subsetMap = {};
  if (Array.isArray(subsets)) {
    for (const item of subsets) {
      if (item && item.family && item.base64) {
        const lower = item.family.trim().toLowerCase();
        if (allowedFamiliesSet.has(lower)) {
          subsetMap[lower] = {
            format: item.format || 'font/woff2',
            base64: item.base64,
          };
        }
      }
    }
  }

  const fontSubsetsJson = JSON.stringify(subsetMap);

  return `(() => {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__cssFontLocalGateActive) return;
  try {
    Object.defineProperty(window, '__cssFontLocalGateActive', {
      value: true,
      configurable: true,
      enumerable: false,
      writable: false,
    });
  } catch (_) {
    window.__cssFontLocalGateActive = true;
  }

  const allowedFamilies = new Set(${allowedSetJson});
  const fontSubsets = ${fontSubsetsJson};
  const BLOCKED_FONT = '__ob_font_blocked__';

  function sanitizeCss(css) {
    if (typeof css !== 'string') return css;
    if (!css.toLowerCase().includes('@font-face')) {
      return css;
    }
    let sanitized = css.replace(/@font-face(?:\\s|\\/\\*[\\s\\S]*?\\*\\/)*\\{([^{}]*)\\}/gi, (match, inner) => {
      const prefix = match.slice(0, match.indexOf('{') + 1);
      const sanitizedInner = inner.replace(/local\\s*\\(\\s*(["']?)([^"')]+)\\1\\s*\\)/gi, (localMatch, quote, fontName) => {
        const cleanName = fontName.trim().replace(/\\s+/g, ' ').toLowerCase();
        if (allowedFamilies.has(cleanName)) {
          const sub = fontSubsets[cleanName];
          if (sub && sub.base64) {
            return 'local(' + quote + fontName + quote + '), url("data:' + (sub.format || 'font/woff2') + ';base64,' + sub.base64 + '")';
          }
          return localMatch;
        }
        return 'local("' + BLOCKED_FONT + '")';
      });
      return prefix + sanitizedInner + '}';
    });

    if (sanitized.toLowerCase().includes('@import')) {
      sanitized = sanitized.replace(/@import\\s+(?:url\\s*\\(\\s*(["']?)([^"')]+)\\1\\s*\\)|(["'])([^"']+)\\3)/gi, (match, q1, u1, q2, u2) => {
        const targetUrl = u1 || u2;
        const q = q1 || q2 || '"';
        if (!targetUrl) return match;
        const targetLower = targetUrl.trim().toLowerCase();
        if (targetLower.startsWith('data:')) {
          const cleanData = sanitizeDataUri(targetUrl.trim());
          return '@import url(' + q + cleanData + q + ')';
        }
        if (rawToCleanBlobUrl.has(targetUrl)) {
          return '@import url(' + q + rawToCleanBlobUrl.get(targetUrl) + q + ')';
        }
        return match;
      });
    }

    return sanitized;
  }

  function sanitizeSrcValue(val) {
    if (typeof val !== 'string') return val;
    return val.replace(/local\\s*\\(\\s*(["']?)([^"')]+)\\1\\s*\\)/gi, (match, quote, fontName) => {
      const cleanName = fontName.trim().replace(/\\s+/g, ' ').toLowerCase();
      if (allowedFamilies.has(cleanName)) {
        const sub = fontSubsets[cleanName];
        if (sub && sub.base64) {
          return 'local(' + quote + fontName + quote + '), url("data:' + (sub.format || 'font/woff2') + ';base64,' + sub.base64 + '")';
        }
        return match;
      }
      return 'local("' + BLOCKED_FONT + '")';
    });
  }

  const isStyleElement = (el) => {
    if (!el || typeof el !== 'object') return false;
    const name = el.nodeName;
    if (typeof name === 'string' && name.toUpperCase() === 'STYLE') return true;
    if (typeof HTMLStyleElement !== 'undefined' && el instanceof HTMLStyleElement) return true;
    if (typeof SVGStyleElement !== 'undefined' && el instanceof SVGStyleElement) return true;
    return false;
  };

  const isLinkElement = (el) => {
    if (!el || typeof el !== 'object') return false;
    const name = el.nodeName;
    if (typeof name === 'string' && name.toUpperCase() === 'LINK') return true;
    if (typeof HTMLLinkElement !== 'undefined' && el instanceof HTMLLinkElement) return true;
    return false;
  };

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
    const holder = {
      toString() {
        if (nativeSource.has(this)) return nativeSource.get(this);
        return originalToString.call(this);
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
  } catch (_) {}

  function utf8ToBase64(str) {
    try {
      const bytes = new TextEncoder().encode(str);
      let bin = '';
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    } catch (_) {
      return btoa(unescape(encodeURIComponent(str)));
    }
  }

  function base64ToUtf8(b64) {
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch (_) {
      return decodeURIComponent(escape(atob(b64)));
    }
  }

  function sanitizeDataUri(url) {
    if (typeof url !== 'string') return url;
    const trimmed = url.trim();
    if (!trimmed.toLowerCase().startsWith('data:')) return url;

    const commaIdx = trimmed.indexOf(',');
    if (commaIdx === -1) return url;

    const meta = trimmed.slice(5, commaIdx);
    const rawData = trimmed.slice(commaIdx + 1);
    const metaLower = meta.toLowerCase();
    const isBase64 = /;base64(?:;|$)/i.test(meta);

    // If media type is explicitly non-css (e.g. image, audio, font binary), keep untouched
    if (metaLower && !metaLower.includes('text/css') && !metaLower.startsWith('text/plain') && !metaLower.startsWith(';')) {
      return url;
    }

    let cssText = '';
    try {
      if (isBase64) {
        cssText = base64ToUtf8(rawData);
      } else {
        try {
          cssText = decodeURIComponent(rawData);
        } catch (_) {
          cssText = unescape(rawData);
        }
      }
    } catch (_) {
      return url;
    }

    if (!cssText.toLowerCase().includes('@font-face') || !cssText.toLowerCase().includes('local(')) {
      return url;
    }

    const cleanCss = sanitizeCss(cssText);
    if (cleanCss === cssText) {
      return url;
    }

    if (isBase64) {
      return 'data:' + meta + ',' + utf8ToBase64(cleanCss);
    } else {
      return 'data:' + meta + ',' + encodeURIComponent(cleanCss);
    }
  }

  const OrigBlob = typeof Blob !== 'undefined' ? Blob : null;
  const blobCssInfo = new WeakMap();
  const rawToCleanBlobUrl = new Map();
  const cleanToRawBlobUrl = new Map();

  function extractBlobPartsText(blobParts) {
    if (!blobParts) return '';
    let str = '';
    try {
      const iter = Array.isArray(blobParts) ? blobParts : Array.from(blobParts);
      for (const part of iter) {
        if (typeof part === 'string') {
          str += part;
        } else if (part instanceof ArrayBuffer) {
          try { str += new TextDecoder('utf-8').decode(part); } catch (_) {}
        } else if (ArrayBuffer.isView(part)) {
          try { str += new TextDecoder('utf-8').decode(part); } catch (_) {}
        } else if (part && typeof part === 'object' && blobCssInfo.has(part)) {
          str += blobCssInfo.get(part).text;
        } else if (part != null) {
          str += String(part);
        }
      }
    } catch (_) {}
    return str;
  }

  if (OrigBlob) {
    const PatchedBlob = function Blob(blobParts, options) {
      if (!new.target) {
        throw new TypeError("Failed to construct 'Blob': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      }
      const instance = Reflect.construct(OrigBlob, arguments, new.target);
      const typeStr = (options && options.type) ? String(options.type).toLowerCase() : '';
      const isCssType = typeStr.includes('text/css');

      let cssText = null;
      if (isCssType) {
        cssText = extractBlobPartsText(blobParts);
      } else if (blobParts && (Array.isArray(blobParts) || blobParts[Symbol.iterator])) {
        const sample = extractBlobPartsText(blobParts);
        if (sample.toLowerCase().includes('@font-face') && sample.toLowerCase().includes('local(')) {
          cssText = sample;
        }
      }

      if (cssText !== null) {
        blobCssInfo.set(instance, {
          text: cssText,
          type: (options && options.type) ? options.type : 'text/css',
        });
      }
      return instance;
    };
    PatchedBlob.prototype = OrigBlob.prototype;
    nativeLike(PatchedBlob, OrigBlob, 'Blob', 0, true);
    try {
      Object.defineProperty(window, 'Blob', {
        configurable: true,
        writable: true,
        enumerable: false,
        value: PatchedBlob,
      });
    } catch (_) {}
  }

  if (typeof URL !== 'undefined') {
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;

    if (typeof origCreate === 'function') {
      const cleanCreate = nativeLike(function createObjectURL(obj) {
        if (!obj || typeof obj !== 'object') return origCreate.call(URL, obj);
        const info = blobCssInfo.get(obj);
        const isTypeCss = Boolean(obj.type && typeof obj.type === 'string' && obj.type.toLowerCase().includes('text/css'));
        if (!info && !isTypeCss) {
          return origCreate.call(URL, obj);
        }

        const rawText = info ? info.text : '';
        if (rawText && rawText.toLowerCase().includes('@font-face') && rawText.toLowerCase().includes('local(')) {
          const cleanText = sanitizeCss(rawText);
          if (cleanText !== rawText) {
            const cleanBlob = new OrigBlob([cleanText], { type: (info && info.type) || 'text/css' });
            const cleanUrl = origCreate.call(URL, cleanBlob);
            const rawUrl = origCreate.call(URL, obj);
            rawToCleanBlobUrl.set(rawUrl, cleanUrl);
            cleanToRawBlobUrl.set(cleanUrl, rawUrl);
            return cleanUrl;
          }
        }
        return origCreate.call(URL, obj);
      }, origCreate, 'createObjectURL', 1, false);

      try {
        Object.defineProperty(URL, 'createObjectURL', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: cleanCreate,
        });
      } catch (_) {}
    }

    if (typeof origRevoke === 'function') {
      const cleanRevoke = nativeLike(function revokeObjectURL(url) {
        const urlStr = String(url);
        if (cleanToRawBlobUrl.has(urlStr)) {
          const rawUrl = cleanToRawBlobUrl.get(urlStr);
          cleanToRawBlobUrl.delete(urlStr);
          rawToCleanBlobUrl.delete(rawUrl);
          try { origRevoke.call(URL, rawUrl); } catch (_) {}
          return origRevoke.call(URL, urlStr);
        }
        if (rawToCleanBlobUrl.has(urlStr)) {
          const cleanUrl = rawToCleanBlobUrl.get(urlStr);
          rawToCleanBlobUrl.delete(urlStr);
          cleanToRawBlobUrl.delete(cleanUrl);
          try { origRevoke.call(URL, cleanUrl); } catch (_) {}
          return origRevoke.call(URL, urlStr);
        }
        return origRevoke.call(URL, url);
      }, origRevoke, 'revokeObjectURL', 1, false);

      try {
        Object.defineProperty(URL, 'revokeObjectURL', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: cleanRevoke,
        });
      } catch (_) {}
    }
  }

  function sanitizeLinkHref(url) {
    if (typeof url !== 'string') return url;
    if (rawToCleanBlobUrl.has(url)) return rawToCleanBlobUrl.get(url);
    const trimmed = url.trim();
    if (trimmed.toLowerCase().startsWith('data:')) return sanitizeDataUri(trimmed);
    return url;
  }

  const origLinkHrefDesc = typeof HTMLLinkElement !== 'undefined'
    ? Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href')
    : null;
  const origLinkRelDesc = typeof HTMLLinkElement !== 'undefined'
    ? Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'rel')
    : null;

  if (origLinkHrefDesc && typeof origLinkHrefDesc.set === 'function') {
    const origSet = origLinkHrefDesc.set;
    const origGet = origLinkHrefDesc.get;
    const wrappedSet = nativeLike(function set_href(val) {
      return origSet.call(this, sanitizeLinkHref(String(val)));
    }, origSet, 'set href', 1, false);
    const wrappedGet = nativeLike(function get_href() {
      return origGet.call(this);
    }, origGet, 'get href', 0, false);
    nativeSource.set(wrappedSet, 'function set href() { [native code] }');
    nativeSource.set(wrappedGet, 'function get href() { [native code] }');
    try {
      Object.defineProperty(HTMLLinkElement.prototype, 'href', {
        configurable: origLinkHrefDesc.configurable,
        enumerable: origLinkHrefDesc.enumerable,
        get: wrappedGet,
        set: wrappedSet,
      });
    } catch (_) {}
  }

  if (origLinkRelDesc && typeof origLinkRelDesc.set === 'function') {
    const origSet = origLinkRelDesc.set;
    const origGet = origLinkRelDesc.get;
    const wrappedSet = nativeLike(function set_rel(val) {
      const res = origSet.call(this, val);
      if (typeof val === 'string' && val.toLowerCase().includes('stylesheet')) {
        const curHref = this.getAttribute('href');
        if (curHref) {
          const cleanHref = sanitizeLinkHref(curHref);
          if (cleanHref !== curHref) {
            if (origLinkHrefDesc && origLinkHrefDesc.set) {
              try { origLinkHrefDesc.set.call(this, cleanHref); } catch (_) {}
            }
            if (origSetAttribute) {
              try { origSetAttribute.call(this, 'href', cleanHref); } catch (_) {}
            }
          }
        }
      }
      return res;
    }, origSet, 'set rel', 1, false);
    const wrappedGet = nativeLike(function get_rel() {
      return origGet.call(this);
    }, origGet, 'get rel', 0, false);
    nativeSource.set(wrappedSet, 'function set rel() { [native code] }');
    nativeSource.set(wrappedGet, 'function get rel() { [native code] }');
    try {
      Object.defineProperty(HTMLLinkElement.prototype, 'rel', {
        configurable: origLinkRelDesc.configurable,
        enumerable: origLinkRelDesc.enumerable,
        get: wrappedGet,
        set: wrappedSet,
      });
    } catch (_) {}
  }

  const origSetAttribute = Element.prototype.setAttribute;
  if (typeof origSetAttribute === 'function') {
    const cleanSetAttribute = nativeLike(function setAttribute(name, value) {
      let cleanVal = value;
      if (isLinkElement(this)) {
        const lowerName = typeof name === 'string' ? name.toLowerCase() : '';
        if (lowerName === 'href') {
          cleanVal = sanitizeLinkHref(String(value));
        } else if (lowerName === 'rel' && typeof value === 'string' && value.toLowerCase().includes('stylesheet')) {
          const curHref = this.getAttribute('href');
          if (curHref) {
            const cleanHref = sanitizeLinkHref(curHref);
            if (cleanHref !== curHref) {
              origSetAttribute.call(this, 'href', cleanHref);
            }
          }
        }
      }
      return origSetAttribute.call(this, name, cleanVal);
    }, origSetAttribute, 'setAttribute', 2, false);
    try {
      Object.defineProperty(Element.prototype, 'setAttribute', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanSetAttribute,
      });
    } catch (_) {}
  }

  const origSetAttributeNode = Element.prototype.setAttributeNode;
  if (typeof origSetAttributeNode === 'function') {
    const cleanSetAttributeNode = nativeLike(function setAttributeNode(attr) {
      if (isLinkElement(this) && attr && typeof attr.name === 'string' && attr.name.toLowerCase() === 'href') {
        attr.value = sanitizeLinkHref(String(attr.value));
      }
      return origSetAttributeNode.call(this, attr);
    }, origSetAttributeNode, 'setAttributeNode', 1, false);
    try {
      Object.defineProperty(Element.prototype, 'setAttributeNode', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanSetAttributeNode,
      });
    } catch (_) {}
  }

  function sanitizeLinkNode(node) {
    if (!node) return;
    if (isLinkElement(node)) {
      const curHref = node.getAttribute('href');
      if (curHref) {
        const cleanHref = sanitizeLinkHref(curHref);
        if (cleanHref !== curHref) {
          if (origLinkHrefDesc && origLinkHrefDesc.set) {
            try { origLinkHrefDesc.set.call(node, cleanHref); } catch (_) {}
          }
          if (origSetAttribute) {
            try { origSetAttribute.call(node, 'href', cleanHref); } catch (_) {}
          }
        }
      }
    } else if (node.nodeType === 11 && node.querySelectorAll) {
      try {
        const links = node.querySelectorAll('link');
        for (let i = 0; i < links.length; i++) {
          sanitizeLinkNode(links[i]);
        }
      } catch (_) {}
    }
  }

  // 1. CSSStyleSheet.prototype.insertRule
  if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype && typeof CSSStyleSheet.prototype.insertRule === 'function') {
    const origInsertRule = CSSStyleSheet.prototype.insertRule;
    const cleanInsertRule = nativeLike(function insertRule(rule, index) {
      const cleanRule = sanitizeCss(String(rule));
      if (arguments.length > 1) {
        return origInsertRule.call(this, cleanRule, index);
      }
      return origInsertRule.call(this, cleanRule);
    }, origInsertRule, 'insertRule', 1, false);
    try {
      Object.defineProperty(CSSStyleSheet.prototype, 'insertRule', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanInsertRule,
      });
    } catch (_) {}
  }

  // CSSGroupingRule.prototype.insertRule
  if (typeof CSSGroupingRule !== 'undefined' && CSSGroupingRule.prototype && typeof CSSGroupingRule.prototype.insertRule === 'function') {
    const origGroupingInsert = CSSGroupingRule.prototype.insertRule;
    const cleanGroupingInsert = nativeLike(function insertRule(rule, index) {
      const cleanRule = sanitizeCss(String(rule));
      if (arguments.length > 1) {
        return origGroupingInsert.call(this, cleanRule, index);
      }
      return origGroupingInsert.call(this, cleanRule);
    }, origGroupingInsert, 'insertRule', 1, false);
    try {
      Object.defineProperty(CSSGroupingRule.prototype, 'insertRule', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanGroupingInsert,
      });
    } catch (_) {}
  }

  // 2. CSSStyleSheet.prototype.replaceSync
  if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
    const origReplaceSync = CSSStyleSheet.prototype.replaceSync;
    const cleanReplaceSync = nativeLike(function replaceSync(text) {
      return origReplaceSync.call(this, sanitizeCss(String(text)));
    }, origReplaceSync, 'replaceSync', 1, false);
    try {
      Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanReplaceSync,
      });
    } catch (_) {}
  }

  // 3. CSSStyleSheet.prototype.replace
  if (typeof CSSStyleSheet !== 'undefined' && CSSStyleSheet.prototype && typeof CSSStyleSheet.prototype.replace === 'function') {
    const origReplace = CSSStyleSheet.prototype.replace;
    const cleanReplace = nativeLike(function replace(text) {
      return origReplace.call(this, sanitizeCss(String(text)));
    }, origReplace, 'replace', 1, false);
    try {
      Object.defineProperty(CSSStyleSheet.prototype, 'replace', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanReplace,
      });
    } catch (_) {}
  }

  // 4. Node.prototype.textContent
  const origNodeTextContent = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
  if (origNodeTextContent && typeof origNodeTextContent.set === 'function') {
    const origSet = origNodeTextContent.set;
    const origGet = origNodeTextContent.get;
    const wrappedSet = nativeLike(function set_textContent(val) {
      if (isStyleElement(this)) {
        return origSet.call(this, sanitizeCss(String(val)));
      }
      return origSet.call(this, val);
    }, origSet, 'set textContent', 1, false);
    const wrappedGet = nativeLike(function get_textContent() {
      return origGet.call(this);
    }, origGet, 'get textContent', 0, false);
    nativeSource.set(wrappedSet, 'function set textContent() { [native code] }');
    nativeSource.set(wrappedGet, 'function get textContent() { [native code] }');
    try {
      Object.defineProperty(Node.prototype, 'textContent', {
        configurable: origNodeTextContent.configurable,
        enumerable: origNodeTextContent.enumerable,
        get: wrappedGet,
        set: wrappedSet,
      });
    } catch (_) {}
  }

  // 5. Element.prototype.innerHTML
  const origElementInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  if (origElementInnerHTML && typeof origElementInnerHTML.set === 'function') {
    const origSet = origElementInnerHTML.set;
    const origGet = origElementInnerHTML.get;
    const wrappedSet = nativeLike(function set_innerHTML(val) {
      if (isStyleElement(this)) {
        return origSet.call(this, sanitizeCss(String(val)));
      }
      let cleanHtml = val;
      if (typeof val === 'string' && val.includes('<link') && (val.includes('data:') || val.includes('blob:'))) {
        cleanHtml = val.replace(/(<link\\b[^>]*\\bhref\\s*=\\s*)(["']?)([^"'\\s>]+)\\2/gi, (match, prefix, quote, url) => {
          const cleanUrl = sanitizeLinkHref(url);
          const q = quote || '"';
          return prefix + q + cleanUrl + q;
        });
      }
      return origSet.call(this, cleanHtml);
    }, origSet, 'set innerHTML', 1, false);
    const wrappedGet = nativeLike(function get_innerHTML() {
      return origGet.call(this);
    }, origGet, 'get innerHTML', 0, false);
    nativeSource.set(wrappedSet, 'function set innerHTML() { [native code] }');
    nativeSource.set(wrappedGet, 'function get innerHTML() { [native code] }');
    try {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: origElementInnerHTML.configurable,
        enumerable: origElementInnerHTML.enumerable,
        get: wrappedGet,
        set: wrappedSet,
      });
    } catch (_) {}
  }

  // 6. HTMLElement.prototype.innerText
  if (typeof HTMLElement !== 'undefined' && HTMLElement.prototype) {
    const origInnerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
    if (origInnerText && typeof origInnerText.set === 'function') {
      const origSet = origInnerText.set;
      const origGet = origInnerText.get;
      const wrappedSet = nativeLike(function set_innerText(val) {
        if (isStyleElement(this)) {
          return origSet.call(this, sanitizeCss(String(val)));
        }
        return origSet.call(this, val);
      }, origSet, 'set innerText', 1, false);
      const wrappedGet = nativeLike(function get_innerText() {
        return origGet.call(this);
      }, origGet, 'get innerText', 0, false);
      nativeSource.set(wrappedSet, 'function set innerText() { [native code] }');
      nativeSource.set(wrappedGet, 'function get innerText() { [native code] }');
      try {
        Object.defineProperty(HTMLElement.prototype, 'innerText', {
          configurable: origInnerText.configurable,
          enumerable: origInnerText.enumerable,
          get: wrappedGet,
          set: wrappedSet,
        });
      } catch (_) {}
    }
  }

  // 7. Node.prototype.appendChild, insertBefore, replaceChild
  const origAppendChild = Node.prototype.appendChild;
  if (typeof origAppendChild === 'function') {
    const cleanAppendChild = nativeLike(function appendChild(child) {
      if (isStyleElement(this) && child) {
        if (child.nodeType === 3 || child.nodeType === 4) {
          child.data = sanitizeCss(child.data);
        } else if (child.nodeType === 11 && child.childNodes) {
          for (let i = 0; i < child.childNodes.length; i++) {
            const n = child.childNodes[i];
            if (n && (n.nodeType === 3 || n.nodeType === 4)) {
              n.data = sanitizeCss(n.data);
            }
          }
        }
      } else if (child) {
        sanitizeLinkNode(child);
      }
      return origAppendChild.call(this, child);
    }, origAppendChild, 'appendChild', 1, false);
    try {
      Object.defineProperty(Node.prototype, 'appendChild', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanAppendChild,
      });
    } catch (_) {}
  }

  const origInsertBefore = Node.prototype.insertBefore;
  if (typeof origInsertBefore === 'function') {
    const cleanInsertBefore = nativeLike(function insertBefore(newNode, refNode) {
      if (isStyleElement(this) && newNode) {
        if (newNode.nodeType === 3 || newNode.nodeType === 4) {
          newNode.data = sanitizeCss(newNode.data);
        } else if (newNode.nodeType === 11 && newNode.childNodes) {
          for (let i = 0; i < newNode.childNodes.length; i++) {
            const n = newNode.childNodes[i];
            if (n && (n.nodeType === 3 || n.nodeType === 4)) {
              n.data = sanitizeCss(n.data);
            }
          }
        }
      } else if (newNode) {
        sanitizeLinkNode(newNode);
      }
      return origInsertBefore.call(this, newNode, refNode);
    }, origInsertBefore, 'insertBefore', 2, false);
    try {
      Object.defineProperty(Node.prototype, 'insertBefore', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanInsertBefore,
      });
    } catch (_) {}
  }

  const origReplaceChild = Node.prototype.replaceChild;
  if (typeof origReplaceChild === 'function') {
    const cleanReplaceChild = nativeLike(function replaceChild(newChild, oldChild) {
      if (isStyleElement(this) && newChild) {
        if (newChild.nodeType === 3 || newChild.nodeType === 4) {
          newChild.data = sanitizeCss(newChild.data);
        } else if (newChild.nodeType === 11 && newChild.childNodes) {
          for (let i = 0; i < newChild.childNodes.length; i++) {
            const n = newChild.childNodes[i];
            if (n && (n.nodeType === 3 || n.nodeType === 4)) {
              n.data = sanitizeCss(n.data);
            }
          }
        }
      } else if (newChild) {
        sanitizeLinkNode(newChild);
      }
      return origReplaceChild.call(this, newChild, oldChild);
    }, origReplaceChild, 'replaceChild', 2, false);
    try {
      Object.defineProperty(Node.prototype, 'replaceChild', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanReplaceChild,
      });
    } catch (_) {}
  }

  // 8. Element.prototype.replaceChildren, append, prepend
  const sanitizeNodeList = (nodes) => {
    return nodes.map((n) => {
      if (typeof n === 'string') return sanitizeCss(n);
      if (n && (n.nodeType === 3 || n.nodeType === 4)) {
        n.data = sanitizeCss(n.data);
      } else if (n && n.nodeType === 11 && n.childNodes) {
        for (let i = 0; i < n.childNodes.length; i++) {
          const child = n.childNodes[i];
          if (child && (child.nodeType === 3 || child.nodeType === 4)) {
            child.data = sanitizeCss(child.data);
          }
        }
      }
      return n;
    });
  };

  if (typeof Element.prototype.replaceChildren === 'function') {
    const origReplaceChildren = Element.prototype.replaceChildren;
    const cleanReplaceChildren = nativeLike(function replaceChildren(...nodes) {
      if (isStyleElement(this)) {
        return origReplaceChildren.apply(this, sanitizeNodeList(nodes));
      }
      for (let i = 0; i < nodes.length; i++) {
        sanitizeLinkNode(nodes[i]);
      }
      return origReplaceChildren.apply(this, nodes);
    }, origReplaceChildren, 'replaceChildren', 0, false);
    try {
      Object.defineProperty(Element.prototype, 'replaceChildren', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanReplaceChildren,
      });
    } catch (_) {}
  }

  if (typeof Element.prototype.append === 'function') {
    const origAppend = Element.prototype.append;
    const cleanAppend = nativeLike(function append(...nodes) {
      if (isStyleElement(this)) {
        return origAppend.apply(this, sanitizeNodeList(nodes));
      }
      for (let i = 0; i < nodes.length; i++) {
        sanitizeLinkNode(nodes[i]);
      }
      return origAppend.apply(this, nodes);
    }, origAppend, 'append', 0, false);
    try {
      Object.defineProperty(Element.prototype, 'append', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanAppend,
      });
    } catch (_) {}
  }

  if (typeof Element.prototype.prepend === 'function') {
    const origPrepend = Element.prototype.prepend;
    const cleanPrepend = nativeLike(function prepend(...nodes) {
      if (isStyleElement(this)) {
        return origPrepend.apply(this, sanitizeNodeList(nodes));
      }
      for (let i = 0; i < nodes.length; i++) {
        sanitizeLinkNode(nodes[i]);
      }
      return origPrepend.apply(this, nodes);
    }, origPrepend, 'prepend', 0, false);
    try {
      Object.defineProperty(Element.prototype, 'prepend', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cleanPrepend,
      });
    } catch (_) {}
  }

  // 9. CharacterData.prototype.data & nodeValue setters
  if (typeof CharacterData !== 'undefined' && CharacterData.prototype) {
    const origDataDesc = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'data');
    if (origDataDesc && typeof origDataDesc.set === 'function') {
      const origDataSet = origDataDesc.set;
      const origDataGet = origDataDesc.get;
      const wrappedSet = nativeLike(function set_data(val) {
        if (isStyleElement(this.parentElement)) {
          return origDataSet.call(this, sanitizeCss(String(val)));
        }
        return origDataSet.call(this, val);
      }, origDataSet, 'set data', 1, false);
      const wrappedGet = nativeLike(function get_data() {
        return origDataGet.call(this);
      }, origDataGet, 'get data', 0, false);
      nativeSource.set(wrappedSet, 'function set data() { [native code] }');
      nativeSource.set(wrappedGet, 'function get data() { [native code] }');
      try {
        Object.defineProperty(CharacterData.prototype, 'data', {
          configurable: origDataDesc.configurable,
          enumerable: origDataDesc.enumerable,
          get: wrappedGet,
          set: wrappedSet,
        });
      } catch (_) {}
    }

    const origNodeValueDesc = Object.getOwnPropertyDescriptor(CharacterData.prototype, 'nodeValue');
    if (origNodeValueDesc && typeof origNodeValueDesc.set === 'function') {
      const origNodeValueSet = origNodeValueDesc.set;
      const origNodeValueGet = origNodeValueDesc.get;
      const wrappedSet = nativeLike(function set_nodeValue(val) {
        if (isStyleElement(this.parentElement)) {
          return origNodeValueSet.call(this, sanitizeCss(String(val)));
        }
        return origNodeValueSet.call(this, val);
      }, origNodeValueSet, 'set nodeValue', 1, false);
      const wrappedGet = nativeLike(function get_nodeValue() {
        return origNodeValueGet.call(this);
      }, origNodeValueGet, 'get nodeValue', 0, false);
      nativeSource.set(wrappedSet, 'function set nodeValue() { [native code] }');
      nativeSource.set(wrappedGet, 'function get nodeValue() { [native code] }');
      try {
        Object.defineProperty(CharacterData.prototype, 'nodeValue', {
          configurable: origNodeValueDesc.configurable,
          enumerable: origNodeValueDesc.enumerable,
          get: wrappedGet,
          set: wrappedSet,
        });
      } catch (_) {}
    }
  }

  // 10. CSSStyleDeclaration.prototype.setProperty & cssText
  if (typeof CSSStyleDeclaration !== 'undefined' && CSSStyleDeclaration.prototype) {
    const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
    if (typeof origSetProperty === 'function') {
      const cleanSetProperty = nativeLike(function setProperty(property, value, priority) {
        let cleanValue = value;
        if (typeof property === 'string' && property.trim().toLowerCase() === 'src') {
          cleanValue = sanitizeSrcValue(String(value));
        }
        if (arguments.length > 2) {
          return origSetProperty.call(this, property, cleanValue, priority);
        }
        return origSetProperty.call(this, property, cleanValue);
      }, origSetProperty, 'setProperty', 2, false);
      try {
        Object.defineProperty(CSSStyleDeclaration.prototype, 'setProperty', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: cleanSetProperty,
        });
      } catch (_) {}
    }

    const origCssTextDesc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');
    if (origCssTextDesc && typeof origCssTextDesc.set === 'function') {
      const origCssTextSet = origCssTextDesc.set;
      const origCssTextGet = origCssTextDesc.get;
      const wrappedSet = nativeLike(function set_cssText(val) {
        let cleanVal = val;
        if (typeof val === 'string' && val.toLowerCase().includes('local(')) {
          cleanVal = sanitizeSrcValue(val);
        }
        return origCssTextSet.call(this, cleanVal);
      }, origCssTextSet, 'set cssText', 1, false);
      const wrappedGet = nativeLike(function get_cssText() {
        return origCssTextGet.call(this);
      }, origCssTextGet, 'get cssText', 0, false);
      nativeSource.set(wrappedSet, 'function set cssText() { [native code] }');
      nativeSource.set(wrappedGet, 'function get cssText() { [native code] }');
      try {
        Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
          configurable: origCssTextDesc.configurable,
          enumerable: origCssTextDesc.enumerable,
          get: wrappedGet,
          set: wrappedSet,
        });
      } catch (_) {}
    }
  }

  // 11. Document.prototype.adoptedStyleSheets & ShadowRoot.prototype.adoptedStyleSheets
  const hookAdopted = (proto) => {
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, 'adoptedStyleSheets');
    if (desc && typeof desc.set === 'function') {
      const origSet = desc.set;
      const origGet = desc.get;
      const wrappedSet = nativeLike(function set_adoptedStyleSheets(sheets) {
        return origSet.call(this, sheets);
      }, origSet, 'set adoptedStyleSheets', 1, false);
      const wrappedGet = nativeLike(function get_adoptedStyleSheets() {
        return origGet.call(this);
      }, origGet, 'get adoptedStyleSheets', 0, false);
      nativeSource.set(wrappedSet, 'function set adoptedStyleSheets() { [native code] }');
      nativeSource.set(wrappedGet, 'function get adoptedStyleSheets() { [native code] }');
      try {
        Object.defineProperty(proto, 'adoptedStyleSheets', {
          configurable: desc.configurable,
          enumerable: desc.enumerable,
          get: wrappedGet,
          set: wrappedSet,
        });
      } catch (_) {}
    }
  };
  hookAdopted(Document.prototype);
  if (typeof ShadowRoot !== 'undefined' && ShadowRoot.prototype) {
    hookAdopted(ShadowRoot.prototype);
  }
})();`;
}

module.exports = {
  buildCssFontLocalGateSource,
};
