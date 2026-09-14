#!/usr/bin/env node
'use strict';

/**
 * Cross-Realm & Cross-Context Adversarial Detection Audit
 * OpenBrowser Hardening
 *
 * Exhaustive real-kernel A/B adversarial audit testing whether injected mocks,
 * wrappers, proxies, and overrides withstand cross-realm inspection.
 *
 * Compares:
 *  1. Native macOS Stock Baseline (un-injected Chromium kernel)
 *  2. Injected Desktop Persona (Windows 10, Chrome 148, D3D11, America/New_York)
 *  3. Injected iOS Mobile Persona (iPhone 16 Plus, iOS 18, Apple GPU, Asia/Shanghai)
 *
 * 10 Required Attack Surfaces:
 *  1. Cross-Realm Function Identity: iframe.contentWindow.Function.prototype.toString.call(parentFn)
 *  2. Cross-Realm Prototype: Prototype identity, placement, and descriptor alignment across realms
 *  3. instanceof / isPrototypeOf Cross-Realm Semantics
 *  4. structuredClone / postMessage Serialization on mock objects (WebIDL DataCloneError vs Plain Object leak)
 *  5. JSON.stringify / Object.keys / spread on mock objects (FrozenArray vs Plain Array)
 *  6. Error Shape Cross-Realm: Constructor realm, name, message, stack leaks on illegal invocation
 *  7. Proxy Detectability: document.fonts, plugins, and native C++ brand checks on Proxies
 *  8. document.fonts Iterator Cross-Realm: Symbol.toStringTag, constructor.name, generator/next leaks
 *  9. window.open Sub-Window: Function identity, navigator, and screen consistency in popup
 * 10. Four Sub-Contexts: about:blank, srcdoc, blob:, data: (opaque origin isolation & host leaks)
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const cdp = require('../cdp');
const {
  buildFingerprint,
  buildWorkerInjectionScript,
  chromeArgsForFingerprint,
  applyFingerprintToTab,
} = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { RequestHeaderRewriter } = require('../engine');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const reportsDirTop = path.join(appRoot, '..', 'reports');
const reportsDirLocal = path.join(appRoot, 'reports');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class AuditServer {
  constructor() {
    this.server = null;
    this.port = 0;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
      const p = parsedUrl.pathname;

      res.setHeader('Access-Control-Allow-Origin', '*');

      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getMainHtml());
        return;
      }

      if (p === '/worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(this.getWorkerJs());
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
  }

  async stop() {
    if (this.server) {
      await new Promise((r) => this.server.close(r));
    }
  }

  getWorkerJs() {
    return `
      self.onmessage = (e) => {
        self.postMessage({ ok: true, platform: self.navigator.platform });
      };
    `;
  }

  getMainHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Cross-Realm Detection Adversarial Audit</title>
</head>
<body>
  <h1>Cross-Realm Adversarial Probe</h1>
  <canvas id="probe-canvas" width="32" height="32" style="display:none;"></canvas>

  <script>
    (async () => {
      const timeoutPromise = (p, ms, fallback) => Promise.race([
        p,
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
      ]);

      try {
        console.log('[CROSS-REALM] Starting cross-realm adversarial audit...');
        const out = {
          surface1_crossRealmToString: {},
          surface2_crossRealmPrototypes: {},
          surface3_instanceOfSemantics: {},
          surface4_structuredClone: {},
          surface5_jsonKeysSpread: {},
          surface6_errorShapeCrossRealm: {},
          surface7_proxyDetectability: {},
          surface8_fontsIterator: {},
          surface9_windowOpen: {},
          surface10_subContexts: {},
        };

        // Create standard same-origin about:blank iframe
        const cleanIframe = document.createElement('iframe');
        cleanIframe.src = 'about:blank';
        document.body.appendChild(cleanIframe);
        const subWin = cleanIframe.contentWindow;
        const subToString = subWin.Function.prototype.toString;

        // Ensure voices are available for testing
        let nativeVoice = null;
        if (window.speechSynthesis) {
          const v = window.speechSynthesis.getVoices();
          if (v && v.length) {
            nativeVoice = v[0];
          } else {
            await new Promise((resolve) => {
              window.speechSynthesis.onvoiceschanged = () => {
                const nv = window.speechSynthesis.getVoices();
                if (nv && nv.length) nativeVoice = nv[0];
                resolve(true);
              };
              setTimeout(() => resolve(false), 800);
            });
          }
        }

        // ============================================================
        // 1. Cross-Realm Function Identity
        // ============================================================
        const fontIterVal = document.fonts ? document.fonts.values() : null;

        const testFns = [
          { name: 'Function.prototype.toString', fn: Function.prototype.toString },
          { name: 'Date.prototype.getTimezoneOffset', fn: Date.prototype.getTimezoneOffset },
          { name: 'Date.now', fn: Date.now },
          { name: 'Intl.DateTimeFormat.prototype.resolvedOptions', fn: Intl.DateTimeFormat?.prototype?.resolvedOptions },
          { name: 'CanvasRenderingContext2D.prototype.getImageData', fn: CanvasRenderingContext2D.prototype.getImageData },
          { name: 'HTMLCanvasElement.prototype.toDataURL', fn: HTMLCanvasElement.prototype.toDataURL },
          { name: 'HTMLCanvasElement.prototype.toBlob', fn: HTMLCanvasElement.prototype.toBlob },
          { name: 'WebGLRenderingContext.prototype.getParameter', fn: WebGLRenderingContext?.prototype?.getParameter },
          { name: 'Element.prototype.getBoundingClientRect', fn: Element.prototype.getBoundingClientRect },
          { name: 'Navigator.prototype.userAgent(get)', fn: Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')?.get },
          { name: 'Navigator.prototype.platform(get)', fn: Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform')?.get },
          { name: 'Navigator.prototype.hardwareConcurrency(get)', fn: Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency')?.get },
          { name: 'Navigator.prototype.deviceMemory(get)', fn: Object.getOwnPropertyDescriptor(Navigator.prototype, 'deviceMemory')?.get },
          { name: 'Screen.prototype.width(get)', fn: Object.getOwnPropertyDescriptor(Screen.prototype, 'width')?.get },
          { name: 'Screen.prototype.height(get)', fn: Object.getOwnPropertyDescriptor(Screen.prototype, 'height')?.get },
          { name: 'document.fonts.check', fn: document.fonts ? document.fonts.check : null },
          { name: 'document.fonts.forEach', fn: document.fonts ? document.fonts.forEach : null },
          { name: 'document.fonts.values', fn: document.fonts ? document.fonts.values : null },
          { name: 'document.fonts[Symbol.iterator]', fn: document.fonts ? document.fonts[Symbol.iterator] : null },
          { name: 'document.fonts.values().next', fn: fontIterVal ? fontIterVal.next : null },
          { name: 'document.fonts.values()[Symbol.iterator]', fn: fontIterVal ? fontIterVal[Symbol.iterator] : null },
          { name: 'window.open', fn: window.open },
          { name: 'HTMLIFrameElement.prototype.contentWindow(get)', fn: Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')?.get },
          { name: 'HTMLIFrameElement.prototype.contentDocument(get)', fn: Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument')?.get },
        ];

        for (const item of testFns) {
          if (!item.fn) {
            out.surface1_crossRealmToString[item.name] = { exists: false };
            continue;
          }

          let parentStr = null;
          try { parentStr = Function.prototype.toString.call(item.fn); } catch (e) { parentStr = 'ERR: ' + e.message; }

          let subStr = null;
          try { subStr = subToString.call(item.fn); } catch (e) { subStr = 'ERR: ' + e.message; }

          const isNative = typeof subStr === 'string' && subStr.includes('[native code]');
          const leakedCode = typeof subStr === 'string' && (subStr.includes('return') || subStr.includes('throw') || subStr.includes('nativeLike') || subStr.includes('isNav') || subStr.includes('internalFaces') || !subStr.includes('[native code]'));

          out.surface1_crossRealmToString[item.name] = {
            exists: true,
            parentToString: parentStr,
            crossRealmToString: subStr,
            isNativeInSubRealm: isNative,
            leakedCodeInSubRealm: leakedCode,
            consistent: parentStr === subStr,
          };
        }

        // Reverse check: parent toString calling subWin methods
        out.surface1_crossRealmToString['reverse_subWinTzOffset'] = {
          val: Function.prototype.toString.call(subWin.Date.prototype.getTimezoneOffset),
          isNative: Function.prototype.toString.call(subWin.Date.prototype.getTimezoneOffset).includes('[native code]'),
        };

        // Descriptor across realms
        const subDescUA = subWin.Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
        out.surface1_crossRealmToString['subRealmInspectParentDescUA'] = {
          hasGet: typeof subDescUA?.get === 'function',
          enumerable: subDescUA?.enumerable,
          configurable: subDescUA?.configurable,
          subToStringOnGet: subDescUA?.get ? subToString.call(subDescUA.get) : null,
        };

        // ============================================================
        // 2. Cross-Realm Prototype Identity & Shape
        // ============================================================
        out.surface2_crossRealmPrototypes = {
          navigatorProtoIdentity: subWin.Navigator.prototype === Navigator.prototype,
          screenProtoIdentity: subWin.Screen.prototype === Screen.prototype,
          webglProtoIdentity: (subWin.WebGLRenderingContext && WebGLRenderingContext) ? (subWin.WebGLRenderingContext.prototype === WebGLRenderingContext.prototype) : 'N/A',
          c2dProtoIdentity: subWin.CanvasRenderingContext2D.prototype === CanvasRenderingContext2D.prototype,

          subWinNavigatorOwnProps: Object.getOwnPropertyNames(subWin.navigator),
          parentNavigatorOwnProps: Object.getOwnPropertyNames(navigator),
          subWinScreenOwnProps: Object.getOwnPropertyNames(subWin.screen),
          parentScreenOwnProps: Object.getOwnPropertyNames(screen),

          subWinHasOwnUserAgent: Object.prototype.hasOwnProperty.call(subWin.navigator, 'userAgent'),
          parentHasOwnUserAgent: Object.prototype.hasOwnProperty.call(navigator, 'userAgent'),

          subWinHasOwnScreenWidth: Object.prototype.hasOwnProperty.call(subWin.screen, 'width'),
          parentHasOwnScreenWidth: Object.prototype.hasOwnProperty.call(screen, 'width'),

          subNavigatorUADesc: {
            configurable: Object.getOwnPropertyDescriptor(subWin.Navigator.prototype, 'userAgent')?.configurable,
            enumerable: Object.getOwnPropertyDescriptor(subWin.Navigator.prototype, 'userAgent')?.enumerable,
            hasGet: typeof Object.getOwnPropertyDescriptor(subWin.Navigator.prototype, 'userAgent')?.get === 'function',
          },
          parentNavigatorUADesc: {
            configurable: Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')?.configurable,
            enumerable: Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')?.enumerable,
            hasGet: typeof Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')?.get === 'function',
          },
        };

        // ============================================================
        // 3. instanceof / isPrototypeOf Cross-Realm Semantics
        // ============================================================
        const testDate = new Date();
        const testFontFace = typeof FontFace !== 'undefined' ? new FontFace('TestFont', 'url(x)') : null;

        out.surface3_instanceOfSemantics = {
          parentNavInstanceofSubNav: navigator instanceof subWin.Navigator,
          subNavInstanceofParentNav: subWin.navigator instanceof Navigator,
          subProtoIsPrototypeOfParentNav: subWin.Navigator.prototype.isPrototypeOf(navigator),

          parentScreenInstanceofSubScreen: screen instanceof subWin.Screen,
          parentDateInstanceofSubDate: testDate instanceof subWin.Date,

          parentFontsInstanceofSubFontsSet: document.fonts && subWin.FontFaceSet ? (document.fonts instanceof subWin.FontFaceSet) : null,
          parentFontFaceInstanceofSubFontFace: testFontFace && subWin.FontFace ? (testFontFace instanceof subWin.FontFace) : null,

          hasCustomHasInstance: {
            Navigator: Object.prototype.hasOwnProperty.call(Navigator, Symbol.hasInstance),
            Screen: Object.prototype.hasOwnProperty.call(Screen, Symbol.hasInstance),
            Date: Object.prototype.hasOwnProperty.call(Date, Symbol.hasInstance),
            FontFaceSet: typeof FontFaceSet !== 'undefined' ? Object.prototype.hasOwnProperty.call(FontFaceSet, Symbol.hasInstance) : false,
          },
        };

        // ============================================================
        // 4. structuredClone / postMessage Serialization
        // ============================================================
        const probeStructuredClone = (obj, label) => {
          if (!obj) return { exists: false };
          try {
            const cloned = structuredClone(obj);
            return {
              threw: false,
              clonedType: typeof cloned,
              clonedKeys: Object.keys(cloned),
              isPlainObject: Object.prototype.toString.call(cloned) === '[object Object]',
            };
          } catch (err) {
            return {
              threw: true,
              errorName: err.name,
              errorMessage: err.message,
            };
          }
        };

        out.surface4_structuredClone = {
          userAgentData: probeStructuredClone(navigator.userAgentData, 'userAgentData'),
          screenOrientation: probeStructuredClone(screen.orientation, 'screenOrientation'),
          documentFonts: probeStructuredClone(document.fonts, 'documentFonts'),
          plugins: probeStructuredClone(navigator.plugins, 'plugins'),
          mimeTypes: probeStructuredClone(navigator.mimeTypes, 'mimeTypes'),
          fontsIterator: fontIterVal ? probeStructuredClone(fontIterVal, 'fontsIterator') : null,
          speechVoice: nativeVoice ? probeStructuredClone(nativeVoice, 'speechVoice') : null,
          fontFace: testFontFace ? probeStructuredClone(testFontFace, 'fontFace') : null,
        };

        // ============================================================
        // 5. JSON.stringify / Object.keys / Spread
        // ============================================================
        out.surface5_jsonKeysSpread = {
          userAgentData: navigator.userAgentData ? {
            jsonStringify: JSON.stringify(navigator.userAgentData),
            objectKeys: Object.keys(navigator.userAgentData),
            spread: { ...navigator.userAgentData },
            brandsIsFrozen: Object.isFrozen(navigator.userAgentData.brands),
            brandItemIsFrozen: navigator.userAgentData.brands && navigator.userAgentData.brands[0] ? Object.isFrozen(navigator.userAgentData.brands[0]) : null,
          } : 'userAgentData undefined',

          plugins: {
            jsonStringify: JSON.stringify(navigator.plugins),
            objectKeys: Object.keys(navigator.plugins),
            spreadKeys: Object.keys({ ...navigator.plugins }),
          },

          languages: {
            isFrozen: Object.isFrozen(navigator.languages),
            jsonStringify: JSON.stringify(navigator.languages),
          },

          screenOrientation: screen.orientation ? {
            jsonStringify: JSON.stringify(screen.orientation),
            objectKeys: Object.keys(screen.orientation),
          } : 'orientation undefined',
        };

        // ============================================================
        // 6. Error Shape Cross-Realm
        // ============================================================
        let parentErr = null;
        try {
          Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get.call({});
        } catch (e) {
          parentErr = e;
        }

        let subErr = null;
        try {
          Object.getOwnPropertyDescriptor(subWin.Navigator.prototype, 'userAgent').get.call({});
        } catch (e) {
          subErr = e;
        }

        out.surface6_errorShapeCrossRealm = {
          parentErr: parentErr ? {
            name: parentErr.name,
            message: parentErr.message,
            instanceofParentTypeError: parentErr instanceof TypeError,
            instanceofSubWinTypeError: parentErr instanceof subWin.TypeError,
            stackContainsWrapper: parentErr.stack ? (/nativeLike|cleanStack|replaceMethod|<anonymous>/i.test(parentErr.stack)) : false,
            stackSnippet: parentErr.stack ? parentErr.stack.split(String.fromCharCode(10)).slice(0, 3).join(' | ') : '',
          } : null,

          subErr: subErr ? {
            name: subErr.name,
            message: subErr.message,
            instanceofSubWinTypeError: subErr instanceof subWin.TypeError,
            instanceofParentTypeError: subErr instanceof TypeError,
            leakedParentTypeError: (subErr instanceof TypeError) && !(subErr instanceof subWin.TypeError),
            stackContainsWrapper: subErr.stack ? (/nativeLike|cleanStack|replaceMethod|<anonymous>/i.test(subErr.stack)) : false,
            stackSnippet: subErr.stack ? subErr.stack.split(String.fromCharCode(10)).slice(0, 3).join(' | ') : '',
          } : null,
        };

        // ============================================================
        // 7. Proxy Detectability
        // ============================================================
        out.surface7_proxyDetectability = {};
        if (document.fonts) {
          let brandCheckThrew = false;
          let brandCheckError = null;
          try {
            if (typeof FontFaceSet !== 'undefined' && typeof FontFaceSet.prototype.has === 'function') {
              FontFaceSet.prototype.has.call(document.fonts, new FontFace('t', 'url(x)'));
            }
          } catch (e) {
            brandCheckThrew = true;
            brandCheckError = e.message;
          }

          out.surface7_proxyDetectability.documentFonts = {
            toStringTag: Object.prototype.toString.call(document.fonts),
            isFrozen: Object.isFrozen(document.fonts),
            isSealed: Object.isSealed(document.fonts),
            isExtensible: Object.isExtensible(document.fonts),
            protoName: Object.getPrototypeOf(document.fonts)?.constructor?.name,
            constructorName: document.fonts.constructor?.name,
            ownSymbols: Object.getOwnPropertySymbols(document.fonts).map(s => String(s)),
            brandCheckThrew,
            brandCheckError,
          };
        }

        // ============================================================
        // 8. document.fonts Iterator Cross-Realm
        // ============================================================
        out.surface8_fontsIterator = {};
        if (document.fonts && fontIterVal) {
          const subIter = subWin.document.fonts ? subWin.document.fonts.values() : null;

          let iterNextToString = null;
          try { iterNextToString = Function.prototype.toString.call(fontIterVal.next); } catch (e) { iterNextToString = e.message; }

          let subIterNextToString = null;
          try { subIterNextToString = subToString.call(fontIterVal.next); } catch (e) { subIterNextToString = e.message; }

          let iterSymToString = null;
          try { iterSymToString = Function.prototype.toString.call(fontIterVal[Symbol.iterator]); } catch (e) { iterSymToString = e.message; }

          out.surface8_fontsIterator = {
            parentIterToString: Object.prototype.toString.call(fontIterVal),
            subWinToStringOnParentIter: subWin.Object.prototype.toString.call(fontIterVal),
            parentIterConstructorName: fontIterVal.constructor ? fontIterVal.constructor.name : 'none',
            isGenerator: Object.prototype.toString.call(fontIterVal).includes('Generator') || (fontIterVal.constructor && fontIterVal.constructor.name.includes('Generator')),
            iterNextToString,
            subIterNextToString,
            nextLeakedSource: typeof iterNextToString === 'string' && (iterNextToString.includes('internalFaces') || iterNextToString.includes('return')),
            iterSymToString,

            subIterToString: subIter ? Object.prototype.toString.call(subIter) : null,
            subIterConstructorName: subIter?.constructor ? subIter.constructor.name : 'none',
          };
        }

        // ============================================================
        // 9. window.open Sub-Window
        // ============================================================
        out.surface9_windowOpen = {};
        try {
          const popup = window.open('about:blank', '_blank');
          if (popup) {
            const popToString = popup.Function.prototype.toString;
            out.surface9_windowOpen = {
              opened: true,
              popToStringOnParentTz: popToString.call(Date.prototype.getTimezoneOffset),
              popUAMatches: popup.navigator.userAgent === navigator.userAgent,
              popScreenWidthMatches: popup.screen.width === screen.width,
              popTzOffsetMatches: (new popup.Date()).getTimezoneOffset() === (new Date()).getTimezoneOffset(),
            };
            popup.close();
          } else {
            out.surface9_windowOpen = { opened: false, reason: 'window.open blocked or null' };
          }
        } catch (e) {
          out.surface9_windowOpen = { opened: false, error: e.message };
        }

        // ============================================================
        // 10. Four Sub-Contexts (about:blank, srcdoc, blob:, data:)
        // ============================================================
        const probeSameOriginSubWin = (w, contextName) => {
          if (!w) return { error: 'window is null' };
          const pToString = w.Function.prototype.toString;
          return {
            contextName,
            crossToStringOnTz: pToString.call(Date.prototype.getTimezoneOffset),
            isNativeTz: pToString.call(Date.prototype.getTimezoneOffset).includes('[native code]'),
            userAgent: w.navigator.userAgent,
            uaMatchesParent: w.navigator.userAgent === navigator.userAgent,
            platform: w.navigator.platform,
            platformMatchesParent: w.navigator.platform === navigator.platform,
            screenWidth: w.screen.width,
            screenWidthMatchesParent: w.screen.width === screen.width,
            tzOffset: (new w.Date()).getTimezoneOffset(),
            tzOffsetMatchesParent: (new w.Date()).getTimezoneOffset() === (new Date()).getTimezoneOffset(),
          };
        };

        // 10.1 about:blank
        out.surface10_subContexts.aboutBlank = probeSameOriginSubWin(subWin, 'about:blank');

        // 10.2 srcdoc
        try {
          const srcdocIfr = document.createElement('iframe');
          srcdocIfr.srcdoc = '<!doctype html><html><body><div id=\"sd\">srcdoc</div></body></html>';
          document.body.appendChild(srcdocIfr);
          out.surface10_subContexts.srcdoc = probeSameOriginSubWin(srcdocIfr.contentWindow, 'srcdoc');
          srcdocIfr.remove();
        } catch (e) {
          out.surface10_subContexts.srcdoc = { error: e.message };
        }

        // 10.3 blob:
        try {
          const blobHtml = '<!doctype html><html><body><div id=\"bl\">blob</div></body></html>';
          const blob = new Blob([blobHtml], { type: 'text/html' });
          const blobUrl = URL.createObjectURL(blob);
          const blobIfr = document.createElement('iframe');
          blobIfr.src = blobUrl;
          const blobLoaded = new Promise((resolve) => {
            blobIfr.onload = () => resolve(true);
            setTimeout(() => resolve(false), 2000);
          });
          document.body.appendChild(blobIfr);
          await blobLoaded;
          out.surface10_subContexts.blob = probeSameOriginSubWin(blobIfr.contentWindow, 'blob:');
          blobIfr.remove();
          URL.revokeObjectURL(blobUrl);
        } catch (e) {
          out.surface10_subContexts.blob = { error: e.message };
        }

        // 10.4 data: (opaque origin, communicate via postMessage)
        try {
          const dataCode = \`
            <!doctype html>
            <html><body><script>
              window.onload = () => {
                let glRenderer = null;
                try {
                  const c = document.createElement('canvas');
                  const gl = c.getContext('webgl');
                  const ext = gl.getExtension('WEBGL_debug_renderer_info');
                  glRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
                } catch (_) {}

                window.parent.postMessage({
                  type: 'DATA_IFRAME_PROBE',
                  payload: {
                    userAgent: navigator.userAgent,
                    platform: navigator.platform,
                    hardwareConcurrency: navigator.hardwareConcurrency,
                    deviceMemory: navigator.deviceMemory,
                    tzOffset: (new Date()).getTimezoneOffset(),
                    screenWidth: screen.width,
                    screenHeight: screen.height,
                    glRenderer: glRenderer,
                  }
                }, '*');
              };
            <\\/script></body></html>
          \`;

          const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(dataCode);
          const dataIfr = document.createElement('iframe');
          const dataMsgPromise = new Promise((resolve) => {
            const handler = (ev) => {
              if (ev.data && ev.data.type === 'DATA_IFRAME_PROBE') {
                window.removeEventListener('message', handler);
                resolve(ev.data.payload);
              }
            };
            window.addEventListener('message', handler);
            setTimeout(() => resolve({ timeout: true }), 3000);
          });
          dataIfr.src = dataUrl;
          document.body.appendChild(dataIfr);
          const dataPayload = await dataMsgPromise;
          dataIfr.remove();

          out.surface10_subContexts.dataIframe = {
            payload: dataPayload,
            uaMatchesParent: dataPayload.userAgent === navigator.userAgent,
            platformMatchesParent: dataPayload.platform === navigator.platform,
            tzMatchesParent: dataPayload.tzOffset === (new Date()).getTimezoneOffset(),
            screenWidthMatchesParent: dataPayload.screenWidth === screen.width,
          };
        } catch (e) {
          out.surface10_subContexts.dataIframe = { error: e.message };
        }

        cleanIframe.remove();
        console.log('[CROSS-REALM] Audit completed successfully.');
        window.__AUDIT_RESULT__ = out;
        window.__AUDIT_READY__ = true;
      } catch (globalErr) {
        console.error('[CROSS-REALM ERROR]', globalErr);
        window.__AUDIT_ERROR__ = (globalErr ? (globalErr.message || String(globalErr)) + String.fromCharCode(10) + (globalErr.stack || '') : 'Unknown error');
        window.__AUDIT_READY__ = true;
      }
    })();
  </script>
</body>
</html>`;
  }
}

async function runAuditSession(profileConfig, isInject, server) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-realm-audit-' + profileConfig.id + '-'));
  const fp = isInject ? buildFingerprint(profileConfig) : null;

  const launchArgs = [
    dir,
    '--headless=new',
    '--disable-popup-blocking',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--enable-unsafe-webgpu'
  ];

  if (isInject) {
    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile: profileConfig,
      templatePath: path.join(kernelRoot, 'init_template.json'),
    });
    const fpChromeArgs = chromeArgsForFingerprint(fp, profileConfig);
    for (const arg of fpChromeArgs) {
      if (!launchArgs.includes(arg)) launchArgs.push(arg);
    }
    if (profileConfig.privacy?.timezone) {
      launchArgs.push(`--time-zone-for-testing=${profileConfig.privacy.timezone}`);
    }
  }

  const child = spawn(launcher, launchArgs, {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(300);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { port = p; break; }
    } catch (_) {}
  }

  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  };

  if (!port) {
    stop();
    return { error: 'Failed to retrieve DevToolsActivePort' };
  }

  let clientResult = null;
  let connection = null;

  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const wsUrl = v.webSocketDebuggerUrl;

    const requestHeaderRewriter = isInject
      ? new RequestHeaderRewriter({ profile: profileConfig, fingerprint: fp })
      : null;

    const workerInjectionSource = isInject ? buildWorkerInjectionScript(fp) : '';

    const onEvent = async (event, conn) => {
      if (event?.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo = {}, waitingForDebugger } = event.params || {};
        if (waitingForDebugger && sessionId) {
          conn.command('Runtime.runIfWaitingForDebugger', {}, { sessionId }).catch(() => {});
        }
        if (targetInfo.type === 'worker' && isInject && sessionId) {
          (async () => {
            try {
              await conn.command('Network.enable', {}, { sessionId, timeout: 1500 }).catch(() => {});
              const workerUa = requestHeaderRewriter?.persona;
              if (workerUa) {
                await conn.command('Network.setUserAgentOverride', {
                  userAgent: workerUa.userAgent,
                  acceptLanguage: workerUa.acceptLanguage,
                  platform: workerUa.platformNav || workerUa.platform,
                  userAgentMetadata: workerUa.metadata,
                }, { sessionId, timeout: 1500 }).catch(() => {});
              }
              await conn.command('Runtime.evaluate', { expression: workerInjectionSource }, { sessionId, timeout: 2000 }).catch(() => {});
            } catch (_) {}
          })();
        }
      }

      if (isInject && requestHeaderRewriter) {
        if (event?.method === 'Fetch.requestPaused' && event.params?.requestId && event.params?.responseStatusCode == null) {
          const reqId = event.params.requestId;
          if (requestHeaderRewriter.inFlight.has(reqId)) {
            conn.command('Fetch.continueRequest', { requestId: reqId }, { sessionId: event.sessionId }).catch(() => {});
            return;
          }
          try { requestHeaderRewriter.handleEvent(event, conn); } catch (e) {
            conn.command('Fetch.continueRequest', { requestId: reqId }, { sessionId: event.sessionId }).catch(() => {});
          }
          return;
        }
      }

      if (event?.method === 'Runtime.consoleAPICalled') {
        const msg = event.params?.args?.[0]?.value;
        if (msg) console.log('    [Page Console]', msg);
      }
      if (event?.method === 'Runtime.exceptionThrown') {
        console.error('    [Page Exception]', event.params?.exceptionDetails?.text, event.params?.exceptionDetails?.exception?.description);
      }
    };

    let primarySessionId = null;
    let primaryReadyResolve = null;
    const primaryReadyPromise = new Promise((resolve) => { primaryReadyResolve = resolve; });

    const wrappedOnEvent = async (event, conn) => {
      if (event?.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo = {} } = event.params || {};
        if (targetInfo.type === 'page' && !primarySessionId) {
          primarySessionId = sessionId;
          if (primaryReadyResolve) primaryReadyResolve(sessionId);
        }
      }
      return onEvent(event, conn);
    };

    connection = await cdp.connect(wsUrl, { onEvent: wrappedOnEvent, timeout: 8000 });

    await connection.command('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    let sessionId = await Promise.race([
      primaryReadyPromise,
      sleep(3000).then(() => null),
    ]);

    if (!sessionId) {
      const targetList = await cdp.targets(port);
      const defaultTarget = targetList.find((t) => t.type === 'page');
      const targetId = defaultTarget ? defaultTarget.id : null;
      if (targetId) {
        const attached = await connection.command('Target.attachToTarget', { targetId, flatten: true });
        sessionId = attached?.sessionId;
      }
    }

    if (!sessionId) {
      stop();
      return { error: 'Failed to acquire page session ID' };
    }

    await connection.command('Runtime.runIfWaitingForDebugger', {}, { sessionId }).catch(() => {});

    if (isInject) {
      await connection.command('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      }, { sessionId }).catch(() => {});

      await connection.command('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      }, { sessionId, timeout: 5000 }).catch(() => {});

      const sessionCall = async (method, params = {}) => {
        return connection.command(method, params, { sessionId, timeout: 30000 });
      };
      await applyFingerprintToTab(sessionCall, null, fp, profileConfig, {
        applyKey: `session:${sessionId}`,
      });
    }

    await connection.command('Page.enable', {}, { sessionId });
    await connection.command('Runtime.enable', {}, { sessionId });

    const mainUrl = `http://127.0.0.1:${server.port}/index.html`;
    await connection.command('Page.navigate', { url: mainUrl }, { sessionId });

    let ready = false;
    for (let i = 0; i < 70; i += 1) {
      await sleep(300);
      const evalRes = await connection.command('Runtime.evaluate', {
        expression: 'Boolean(window.__AUDIT_READY__)',
        returnByValue: true,
      }, { sessionId, timeout: 12000 }).catch(() => null);
      if (evalRes?.result?.value === true) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      clientResult = { error: 'Timeout waiting for __AUDIT_READY__' };
    } else {
      const errCheck = await connection.command('Runtime.evaluate', {
        expression: 'window.__AUDIT_ERROR__',
        returnByValue: true,
      }, { sessionId }).catch(() => null);
      if (errCheck?.result?.value) {
        console.error('  [PAGE PROBE ERROR]:', errCheck.result.value);
      }
      const dataRes = await connection.command('Runtime.evaluate', {
        expression: 'window.__AUDIT_RESULT__',
        returnByValue: true,
      }, { sessionId, timeout: 20000 });
      clientResult = dataRes?.result?.value;
    }
  } catch (err) {
    clientResult = { error: String(err && err.message ? err.message : err) };
  } finally {
    if (connection) {
      try { connection.close(); } catch (_) {}
    }
    stop();
  }

  return clientResult;
}

(async () => {
  console.log('================================================================');
  console.log('  Cross-Realm & Cross-Context Adversarial Red-Team Audit');
  console.log('================================================================');

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.error('Error: macOS launcher not found at ' + launcher);
    process.exit(1);
  }

  const server = new AuditServer();
  await server.start();
  console.log(`[AuditServer] Listening on http://127.0.0.1:${server.port}`);

  const rawResults = {};

  try {
    // 1. Native macOS Stock Baseline
    console.log('\n[1/3] Running Session 1: Native macOS Stock Baseline (Un-injected)...');
    const baselineProfile = {
      id: 'realm-baseline',
      name: 'Baseline Stock Kernel',
      os: 'macos',
      language: 'en-US',
      privacy: { timezoneMode: 'real' },
    };
    rawResults.baseline = await runAuditSession(baselineProfile, false, server);
    console.log('  Baseline complete. Error:', rawResults.baseline?.error || 'none');

    // 2. Injected Windows Desktop Persona
    console.log('\n[2/3] Running Session 2: Injected Desktop Persona (Windows 10, D3D11, America/New_York)...');
    const windowsProfile = {
      id: 'realm-win-d3d11',
      name: 'win-d3d11',
      os: 'windows',
      language: 'en-US',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      exitIp: '198.51.100.22',
      exitTimezone: 'America/New_York',
      webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      webglVendor: 'Google Inc. (Intel)',
      privacy: {
        deviceProfile: 'persona',
        timezoneMode: 'custom',
        timezone: 'America/New_York',
        webgl: 'noise',
        canvas: 'noise',
        audio: 'noise',
        clientRects: 'noise',
        webrtc: 'proxy',
        webrtcAddress: '198.51.100.22',
        webrtcLocalIp: '192.168.1.105',
        webgpu: 'webgl',
      },
    };
    rawResults.desktop = await runAuditSession(windowsProfile, true, server);
    console.log('  Desktop session complete. Error:', rawResults.desktop?.error || 'none');

    // 3. Injected iOS Mobile Persona
    console.log('\n[3/3] Running Session 3: Injected iOS Mobile Persona (iPhone 16 Plus, iOS 18, Asia/Shanghai)...');
    const iosProfile = {
      id: 'realm-ios-iphone',
      name: 'iPhone 16 Plus',
      os: 'ios',
      mobile: true,
      platform: 'iPhone',
      language: 'zh-CN',
      fingerprintLaunchSeed: '2',
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      webrtc: 'proxy',
      exitIp: '114.114.114.114',
      exitTimezone: 'Asia/Shanghai',
      privacy: {
        deviceProfile: 'persona',
        timezoneMode: 'custom',
        timezone: 'Asia/Shanghai',
        languages: ['zh-CN', 'zh', 'en'],
        webgl: 'noise',
        canvas: 'noise',
        audio: 'noise',
        clientRects: 'noise',
        webrtc: 'proxy',
        webrtcAddress: '114.114.114.114',
        webrtcLocalIp: '192.168.2.88',
        webgpu: 'webgl',
      },
    };
    rawResults.ios = await runAuditSession(iosProfile, true, server);
    console.log('  iOS session complete. Error:', rawResults.ios?.error || 'none');

  } finally {
    await server.stop();
  }

  // Ensure directories exist and dump raw results
  for (const rDir of [reportsDirTop, reportsDirLocal]) {
    if (!fs.existsSync(rDir)) fs.mkdirSync(rDir, { recursive: true });
    const rawPath = path.join(rDir, 'cross-realm-detection-adversarial-raw.json');
    fs.writeFileSync(rawPath, JSON.stringify(rawResults, null, 2), 'utf8');
    console.log(`[Dump] Raw results written to: ${rawPath}`);
  }

  // Reap any leftover kernels
  try {
    execSync('node ' + path.join(__dirname, 'reap-orphan-kernels.js'), { stdio: 'inherit' });
  } catch (_) {}

  console.log('\nCross-realm adversarial data collection complete.');
})();
