#!/usr/bin/env node
'use strict';

/**
 * Full Function.prototype.toString & Prototype Shape Adversarial Audit
 *
 * Exhaustive A/B real-kernel audit comparing un-injected stock baseline against
 * injected personas (Windows 10 D3D11 and iOS iPhone WebKit).
 *
 * Covers 8 core areas:
 *  1. Function.prototype.toString.call(fn) on all patched APIs/getters/setters/constructors
 *  2. fn.name and fn.length arity alignment
 *  3. Object.getOwnPropertyDescriptor(proto, key) enumerable/configurable/writable/get/set
 *  4. Unexpected own property vs prototype placement
 *  5. Generator (function*), async function, arrow function (=>), class leaks
 *  6. Object.getOwnPropertyNames enumeration order across all core interfaces
 *  7. Error.stack leakage on illegal invocation (cleanStack / stripStackFrame bypasses)
 *  8. Object.getOwnPropertySymbols hidden symbol leakage (S_NATIVE trace)
 *
 * Executed in a fully loaded, attached HTTP document (document.readyState === 'complete').
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
const reportsDir = path.join(appRoot, '..', 'reports');

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
      self.onmessage = async (e) => {
        const probeFn = (fn, name) => {
          if (typeof fn !== 'function') return null;
          let str = null;
          try { str = Function.prototype.toString.call(fn); } catch (err) { str = 'ERR:' + err.message; }
          const syms = Object.getOwnPropertySymbols(fn).map(s => String(s));
          return {
            name: fn.name,
            length: fn.length,
            toStringVal: str,
            isNativeCode: str ? str.includes('[native code]') : false,
            isGenerator: str ? (str.startsWith('function*') || str.includes('yield')) : false,
            isAsync: str ? str.startsWith('async') : false,
            isArrow: str ? str.includes('=>') : false,
            hasSymbols: syms.length > 0,
            symbols: syms
          };
        };

        const probeAccessor = (proto, key) => {
          if (!proto) return null;
          let desc = null;
          try { desc = Object.getOwnPropertyDescriptor(proto, key); } catch (err) { return { err: err.message }; }
          if (!desc) return null;
          return {
            enumerable: desc.enumerable,
            configurable: desc.configurable,
            writable: desc.writable,
            hasGet: typeof desc.get === 'function',
            hasSet: typeof desc.set === 'function',
            getProbe: desc.get ? probeFn(desc.get, 'get ' + key) : null,
            setProbe: desc.set ? probeFn(desc.set, 'set ' + key) : null,
          };
        };

        const out = {
          workerNavigatorProps: Object.getOwnPropertyNames(self.WorkerNavigator ? self.WorkerNavigator.prototype : {}),
          workerNavigatorInstanceProps: Object.getOwnPropertyNames(self.navigator || {}),
          accessors: {},
          methods: {},
          symbolsOnNavigator: Object.getOwnPropertySymbols(self.navigator || {}).map(s => String(s)),
          symbolsOnProto: Object.getOwnPropertySymbols(self.WorkerNavigator ? self.WorkerNavigator.prototype : {}).map(s => String(s)),
        };

        const wProto = self.WorkerNavigator ? self.WorkerNavigator.prototype : null;
        for (const k of ['userAgent', 'appVersion', 'platform', 'languages', 'language', 'hardwareConcurrency', 'deviceMemory', 'userAgentData']) {
          out.accessors[k] = probeAccessor(wProto, k);
        }

        // OffscreenCanvas in Worker
        const offCtxProto = self.OffscreenCanvasRenderingContext2D ? self.OffscreenCanvasRenderingContext2D.prototype : null;
        out.methods.offscreenGetImageData = offCtxProto ? probeFn(offCtxProto.getImageData, 'getImageData') : null;

        const offProto = self.OffscreenCanvas ? self.OffscreenCanvas.prototype : null;
        out.methods.offscreenConvertToBlob = offProto ? probeFn(offProto.convertToBlob, 'convertToBlob') : null;

        self.postMessage(out);
      };
    `;
  }

  getMainHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Prototype & toString Scan</title>
</head>
<body>
  <h1>Prototype Shape & Function.prototype.toString Scan</h1>
  <canvas id="probe-canvas" width="10" height="10" style="display:none;"></canvas>

  <script>
    (async () => {
      try {
      // Script executes in active document

      const out = {
        targets: {},
        order: {},
        stackLeaks: {},
        symbolsLeak: {},
        iteratorTypes: {},
        proxyTraces: {},
        workerReport: null
      };

      // -------------------------------------------------------------
      // Helper: Comprehensive Function Inspector
      // -------------------------------------------------------------
      const inspectFunction = (fn, label) => {
        if (typeof fn !== 'function') return null;
        let str = null;
        try {
          str = Function.prototype.toString.call(fn);
        } catch (err) {
          str = 'ERR:' + (err && err.message ? err.message : String(err));
        }

        let ownStr = null;
        try {
          ownStr = typeof fn.toString === 'function' ? fn.toString() : null;
        } catch (_) {}

        const syms = Object.getOwnPropertySymbols(fn).map(s => String(s));
        const isGen = Boolean(str && (str.startsWith('function*') || str.includes('yield') || (fn.constructor && fn.constructor.name === 'GeneratorFunction')));
        const isAsync = Boolean(str && (str.startsWith('async') || (fn.constructor && fn.constructor.name === 'AsyncFunction')));
        const isArrow = Boolean(str && (str.includes('=>')));
        const isClass = Boolean(str && (str.startsWith('class ') || str.startsWith('class{')));
        const isNative = Boolean(str && str.includes('[native code]'));

        return {
          label: label || fn.name,
          name: fn.name,
          length: fn.length,
          toStringVal: str,
          ownToStringVal: ownStr,
          isNativeCode: isNative,
          isGenerator: isGen,
          isAsync: isAsync,
          isArrow: isArrow,
          isClass: isClass,
          constructorName: fn.constructor ? fn.constructor.name : null,
          hasSymbols: syms.length > 0,
          symbols: syms,
        };
      };

      // -------------------------------------------------------------
      // Helper: Property Descriptor & Shape Inspector
      // -------------------------------------------------------------
      const inspectDescriptor = (holder, key, holderLabel) => {
        if (!holder) return { exists: false, holderLabel };
        let desc = null;
        try {
          desc = Object.getOwnPropertyDescriptor(holder, key);
        } catch (err) {
          return { exists: false, error: err.message, holderLabel };
        }
        if (!desc) return { exists: false, holderLabel };

        const symsOnDesc = [];
        return {
          exists: true,
          holderLabel,
          enumerable: desc.enumerable,
          configurable: desc.configurable,
          writable: desc.writable,
          isAccessor: typeof desc.get === 'function' || typeof desc.set === 'function',
          isValue: desc.value !== undefined,
          getProbe: desc.get ? inspectFunction(desc.get, 'get ' + key) : null,
          setProbe: desc.set ? inspectFunction(desc.set, 'set ' + key) : null,
          valueProbe: typeof desc.value === 'function' ? inspectFunction(desc.value, key) : (desc.value !== undefined ? typeof desc.value : undefined),
        };
      };

      // -------------------------------------------------------------
      // Helper: Illegal Invocation Stack Leak Test
      // -------------------------------------------------------------
      const testStackLeak = (callerFn, targetName) => {
        if (typeof callerFn !== 'function') return null;
        let errObj = null;
        try {
          callerFn();
        } catch (e) {
          errObj = e;
        }
        if (!errObj) return { thrown: false };

        const stack = String(errObj.stack || '');
        const leakedKeywords = [];
        const suspiciousPatterns = [
          'replaceMethod',
          'nativeLike',
          'makeNativeGetter',
          'stripStackFrame',
          'cleanStack',
          'safeWrapper',
          'inspectBridge',
          '<anonymous>',
          'fingerprint.js',
          'engine.js',
          'sanitizeElementFontScope',
          'applyCanvasNoise',
          'applyNoise'
        ];

        for (const p of suspiciousPatterns) {
          if (stack.includes(p)) {
            leakedKeywords.push(p);
          }
        }

        return {
          thrown: true,
          errorName: errObj.name,
          errorMessage: errObj.message,
          hasStack: typeof errObj.stack === 'string',
          stackLines: stack.split('\\n').slice(0, 5),
          leakedKeywords,
          hasLeak: leakedKeywords.length > 0
        };
      };

      // =============================================================
      // 1. Function.prototype.toString Self-Inspection
      // =============================================================
      out.targets['Function.prototype.toString'] = {
        fnProbe: inspectFunction(Function.prototype.toString, 'Function.prototype.toString'),
        descriptor: inspectDescriptor(Function.prototype, 'toString', 'Function.prototype'),
        symbols: Object.getOwnPropertySymbols(Function.prototype.toString).map(s => String(s)),
        calledOnSelf: Function.prototype.toString.call(Function.prototype.toString),
        calledOnNative: Function.prototype.toString.call(Math.sin),
        calledOnNonFnError: (() => {
          try { Function.prototype.toString.call({}); return 'NO_THROW'; }
          catch (e) { return e.name + ': ' + e.message; }
        })()
      };

      // =============================================================
      // 2. Navigator & NavigatorUAData APIs
      // =============================================================
      const navProto = Navigator.prototype;
      const navKeys = [
        'userAgent', 'appVersion', 'platform', 'languages', 'language',
        'hardwareConcurrency', 'deviceMemory', 'vendor', 'maxTouchPoints',
        'webdriver', 'userAgentData', 'getBattery', 'mediaDevices',
        'bluetooth', 'permissions', 'keyboard', 'cookieEnabled', 'onLine'
      ];

      for (const k of navKeys) {
        const protoDesc = inspectDescriptor(navProto, k, 'Navigator.prototype');
        const instDesc = inspectDescriptor(navigator, k, 'navigator');
        const isOwn = Object.prototype.hasOwnProperty.call(navigator, k);

        out.targets['Navigator.' + k] = {
          protoDesc,
          instDesc,
          isOwnOnInstance: isOwn,
        };

        // Stack leak test for getter / method
        if (protoDesc && protoDesc.getProbe) {
          const g = Object.getOwnPropertyDescriptor(navProto, k).get;
          out.stackLeaks['Navigator.' + k] = testStackLeak(() => g.call({}), 'get ' + k);
        }
      }

      // NavigatorUAData
      if (typeof NavigatorUAData !== 'undefined') {
        const uadProto = NavigatorUAData.prototype;
        for (const k of ['brands', 'mobile', 'platform', 'getHighEntropyValues', 'toJSON']) {
          out.targets['NavigatorUAData.' + k] = {
            protoDesc: inspectDescriptor(uadProto, k, 'NavigatorUAData.prototype'),
            instDesc: navigator.userAgentData ? inspectDescriptor(navigator.userAgentData, k, 'navigator.userAgentData') : null,
            isOwnOnInstance: navigator.userAgentData ? Object.prototype.hasOwnProperty.call(navigator.userAgentData, k) : null
          };
        }
      }

      // =============================================================
      // 3. Screen APIs
      // =============================================================
      const scrProto = Screen.prototype;
      const scrKeys = [
        'width', 'height', 'availWidth', 'availHeight',
        'colorDepth', 'pixelDepth', 'availLeft', 'availTop', 'orientation'
      ];
      for (const k of scrKeys) {
        const protoDesc = inspectDescriptor(scrProto, k, 'Screen.prototype');
        const instDesc = inspectDescriptor(screen, k, 'screen');
        const isOwn = Object.prototype.hasOwnProperty.call(screen, k);
        out.targets['Screen.' + k] = { protoDesc, instDesc, isOwnOnInstance: isOwn };
        if (protoDesc && protoDesc.getProbe) {
          const g = Object.getOwnPropertyDescriptor(scrProto, k).get;
          out.stackLeaks['Screen.' + k] = testStackLeak(() => g.call({}), 'get ' + k);
        }
      }

      // =============================================================
      // 4. Window Metrics & Methods
      // =============================================================
      for (const k of ['devicePixelRatio', 'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'screenX', 'screenY', 'matchMedia', 'open']) {
        out.targets['Window.' + k] = {
          protoDesc: inspectDescriptor(Window.prototype, k, 'Window.prototype'),
          instDesc: inspectDescriptor(window, k, 'window'),
          isOwnOnInstance: Object.prototype.hasOwnProperty.call(window, k),
        };
      }

      // =============================================================
      // 5. Date & Date.prototype
      // =============================================================
      out.targets['Date'] = {
        constructorProbe: inspectFunction(Date, 'Date'),
        descriptorOnGlobal: inspectDescriptor(window, 'Date', 'window'),
        protoDescOnDate: inspectDescriptor(Date, 'prototype', 'Date'),
        nowDesc: inspectDescriptor(Date, 'now', 'Date'),
        parseDesc: inspectDescriptor(Date, 'parse', 'Date'),
        utcDesc: inspectDescriptor(Date, 'UTC', 'Date'),
      };

      const dateMethods = [
        'getTimezoneOffset', 'toString', 'toDateString', 'toTimeString',
        'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
        'getHours', 'getDate', 'getDay', 'getFullYear', 'getMonth',
        'getMinutes', 'getSeconds', 'getMilliseconds', 'getYear',
        'setFullYear', 'setMonth', 'setDate', 'setHours', 'setMinutes',
        'setSeconds', 'setMilliseconds'
      ];
      for (const m of dateMethods) {
        out.targets['Date.prototype.' + m] = {
          protoDesc: inspectDescriptor(Date.prototype, m, 'Date.prototype'),
        };
        const fn = Date.prototype[m];
        if (typeof fn === 'function') {
          out.stackLeaks['Date.prototype.' + m] = testStackLeak(() => fn.call({}), m);
        }
      }

      // =============================================================
      // 6. Intl.DateTimeFormat & prototype
      // =============================================================
      if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
        out.targets['Intl.DateTimeFormat'] = {
          constructorProbe: inspectFunction(Intl.DateTimeFormat, 'Intl.DateTimeFormat'),
          protoDescOnIntl: inspectDescriptor(Intl.DateTimeFormat, 'prototype', 'Intl.DateTimeFormat'),
        };
        for (const m of ['resolvedOptions', 'format', 'formatToParts', 'formatRange', 'formatRangeToParts']) {
          out.targets['Intl.DateTimeFormat.prototype.' + m] = {
            protoDesc: inspectDescriptor(Intl.DateTimeFormat.prototype, m, 'Intl.DateTimeFormat.prototype')
          };
        }
      }

      // =============================================================
      // 7. Canvas (HTMLCanvasElement & OffscreenCanvas & Context2D)
      // =============================================================
      const htmlCanvasProto = HTMLCanvasElement.prototype;
      for (const m of ['toDataURL', 'toBlob', 'getContext']) {
        out.targets['HTMLCanvasElement.' + m] = {
          protoDesc: inspectDescriptor(htmlCanvasProto, m, 'HTMLCanvasElement.prototype'),
        };
        if (typeof htmlCanvasProto[m] === 'function') {
          out.stackLeaks['HTMLCanvasElement.' + m] = testStackLeak(() => htmlCanvasProto[m].call({}), m);
        }
      }

      const c2dProto = CanvasRenderingContext2D.prototype;
      for (const m of ['getImageData', 'isPointInPath', 'measureText', 'font']) {
        out.targets['CanvasRenderingContext2D.' + m] = {
          protoDesc: inspectDescriptor(c2dProto, m, 'CanvasRenderingContext2D.prototype'),
        };
        if (m === 'getImageData') {
          out.stackLeaks['CanvasRenderingContext2D.getImageData'] = testStackLeak(() => c2dProto.getImageData.call({}, 0, 0, 1, 1), 'getImageData');
        }
      }

      if (typeof OffscreenCanvas !== 'undefined') {
        const offProto = OffscreenCanvas.prototype;
        for (const m of ['convertToBlob', 'getContext', 'toDataURL']) {
          out.targets['OffscreenCanvas.' + m] = {
            protoDesc: inspectDescriptor(offProto, m, 'OffscreenCanvas.prototype'),
          };
        }
      }

      if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
        const offCtxProto = OffscreenCanvasRenderingContext2D.prototype;
        for (const m of ['getImageData', 'font']) {
          out.targets['OffscreenCanvasRenderingContext2D.' + m] = {
            protoDesc: inspectDescriptor(offCtxProto, m, 'OffscreenCanvasRenderingContext2D.prototype'),
          };
        }
      }

      // =============================================================
      // 8. WebGL & WebGL2
      // =============================================================
      for (const glName of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
        const glCtor = window[glName];
        if (glCtor) {
          for (const m of ['getParameter', 'getExtension', 'getSupportedExtensions', 'getShaderPrecisionFormat', 'readPixels']) {
            out.targets[glName + '.' + m] = {
              protoDesc: inspectDescriptor(glCtor.prototype, m, glName + '.prototype'),
            };
            if (typeof glCtor.prototype[m] === 'function') {
              out.stackLeaks[glName + '.' + m] = testStackLeak(() => glCtor.prototype[m].call({}), m);
            }
          }
        }
      }

      if (typeof WebGLShaderPrecisionFormat !== 'undefined') {
        for (const k of ['rangeMin', 'rangeMax', 'precision']) {
          out.targets['WebGLShaderPrecisionFormat.' + k] = {
            protoDesc: inspectDescriptor(WebGLShaderPrecisionFormat.prototype, k, 'WebGLShaderPrecisionFormat.prototype'),
          };
        }
      }

      // =============================================================
      // 9. Web Audio (AudioContext / AnalyserNode / AudioBuffer)
      // =============================================================
      for (const actxName of ['BaseAudioContext', 'AudioContext', 'OfflineAudioContext']) {
        const ctor = window[actxName];
        if (ctor) {
          for (const m of ['createAnalyser', 'createOscillator', 'startRendering', 'sampleRate', 'baseLatency', 'outputLatency']) {
            out.targets[actxName + '.' + m] = {
              protoDesc: inspectDescriptor(ctor.prototype, m, actxName + '.prototype'),
            };
          }
        }
      }

      if (window.AudioBuffer) {
        for (const m of ['getChannelData', 'copyFromChannel', 'copyToChannel']) {
          out.targets['AudioBuffer.' + m] = {
            protoDesc: inspectDescriptor(AudioBuffer.prototype, m, 'AudioBuffer.prototype'),
          };
        }
      }

      if (window.AnalyserNode) {
        for (const m of ['getFloatFrequencyData', 'getByteFrequencyData', 'getFloatTimeDomainData', 'getByteTimeDomainData']) {
          out.targets['AnalyserNode.' + m] = {
            protoDesc: inspectDescriptor(AnalyserNode.prototype, m, 'AnalyserNode.prototype'),
          };
        }
      }

      // =============================================================
      // 10. DOM Geometry & SVG Metrics
      // =============================================================
      for (const m of ['getBoundingClientRect', 'getClientRects']) {
        out.targets['Element.' + m] = { protoDesc: inspectDescriptor(Element.prototype, m, 'Element.prototype') };
        out.targets['Range.' + m] = { protoDesc: inspectDescriptor(Range.prototype, m, 'Range.prototype') };
      }

      for (const m of ['offsetWidth', 'offsetHeight', 'scrollWidth', 'scrollHeight', 'clientWidth', 'clientHeight']) {
        out.targets['HTMLElement.' + m] = { protoDesc: inspectDescriptor(HTMLElement.prototype, m, 'HTMLElement.prototype') };
      }

      if (window.SVGTextContentElement) {
        for (const m of ['getComputedTextLength', 'getSubStringLength']) {
          out.targets['SVGTextContentElement.' + m] = { protoDesc: inspectDescriptor(SVGTextContentElement.prototype, m, 'SVGTextContentElement.prototype') };
        }
      }
      if (window.SVGGraphicsElement) {
        out.targets['SVGGraphicsElement.getBBox'] = { protoDesc: inspectDescriptor(SVGGraphicsElement.prototype, 'getBBox', 'SVGGraphicsElement.prototype') };
      }

      // =============================================================
      // 11. MediaDevices, Permissions, Keyboard, Bluetooth
      // =============================================================
      if (navigator.mediaDevices) {
        const mdProto = Object.getPrototypeOf(navigator.mediaDevices);
        for (const m of ['enumerateDevices', 'getUserMedia']) {
          out.targets['MediaDevices.' + m] = { protoDesc: inspectDescriptor(mdProto, m, 'MediaDevices.prototype') };
          if (typeof mdProto[m] === 'function') {
            out.stackLeaks['MediaDevices.' + m] = testStackLeak(() => mdProto[m].call({}), m);
          }
        }
      }

      if (navigator.permissions) {
        const pProto = Object.getPrototypeOf(navigator.permissions);
        out.targets['Permissions.query'] = { protoDesc: inspectDescriptor(pProto, 'query', 'Permissions.prototype') };
      }

      if (navigator.keyboard) {
        const kbProto = Object.getPrototypeOf(navigator.keyboard);
        out.targets['Keyboard.getLayoutMap'] = { protoDesc: inspectDescriptor(kbProto, 'getLayoutMap', 'Keyboard.prototype') };
      }

      if (navigator.bluetooth) {
        const btProto = Object.getPrototypeOf(navigator.bluetooth);
        for (const m of ['getAvailability', 'requestDevice']) {
          out.targets['Bluetooth.' + m] = { protoDesc: inspectDescriptor(btProto, m, 'Bluetooth.prototype') };
        }
      }

      // =============================================================
      // 12. WebGPU
      // =============================================================
      if (navigator.gpu) {
        const gpuProto = Object.getPrototypeOf(navigator.gpu);
        out.targets['GPU.requestAdapter'] = { protoDesc: inspectDescriptor(gpuProto, 'requestAdapter', 'GPU.prototype') };
      }
      if (typeof GPUAdapter !== 'undefined') {
        for (const m of ['info', 'features', 'limits', 'requestAdapterInfo']) {
          out.targets['GPUAdapter.' + m] = { protoDesc: inspectDescriptor(GPUAdapter.prototype, m, 'GPUAdapter.prototype') };
        }
      }
      if (typeof GPUAdapterInfo !== 'undefined') {
        for (const m of ['vendor', 'architecture', 'device', 'description']) {
          out.targets['GPUAdapterInfo.' + m] = { protoDesc: inspectDescriptor(GPUAdapterInfo.prototype, m, 'GPUAdapterInfo.prototype') };
        }
      }

      // =============================================================
      // 13. Document.fonts & FontFaceSet
      // =============================================================
      out.targets['Document.fonts'] = {
        protoDesc: inspectDescriptor(Document.prototype, 'fonts', 'Document.prototype'),
        isOwnOnDoc: Object.prototype.hasOwnProperty.call(document, 'fonts')
      };
      if (document.fonts) {
        const ffs = document.fonts;
        const ffsProto = Object.getPrototypeOf(ffs);
        for (const k of ['size', 'status', 'ready', 'has', 'add', 'delete', 'clear', 'check', 'load', 'forEach', 'entries', 'keys', 'values']) {
          out.targets['FontFaceSet.' + k] = {
            descOnProxy: inspectDescriptor(ffs, k, 'document.fonts'),
            descOnProto: inspectDescriptor(ffsProto, k, 'FontFaceSet.prototype')
          };
        }
        // Symbol.iterator
        if (typeof Symbol !== 'undefined' && Symbol.iterator) {
          const symIter = ffs[Symbol.iterator];
          out.targets['FontFaceSet[Symbol.iterator]'] = {
            fnProbe: inspectFunction(symIter, '[Symbol.iterator]'),
          };
        }

        // Iterator return types
        try {
          out.iteratorTypes['FontFaceSet.keys()'] = Object.prototype.toString.call(ffs.keys());
          out.iteratorTypes['FontFaceSet.values()'] = Object.prototype.toString.call(ffs.values());
          out.iteratorTypes['FontFaceSet.entries()'] = Object.prototype.toString.call(ffs.entries());
          out.iteratorTypes['FontFaceSet[Symbol.iterator]()'] = Object.prototype.toString.call(ffs[Symbol.iterator]());
        } catch (err) {
          out.iteratorTypes['FontFaceSet.error'] = err.message;
        }

        // Proxy detection on document.fonts
        out.proxyTraces['document.fonts'] = {
          toStringTag: Object.prototype.toString.call(ffs),
          isExtensible: Object.isExtensible(ffs),
          isFrozen: Object.isFrozen(ffs),
          isSealed: Object.isSealed(ffs),
          constructorMatches: typeof FontFaceSet !== 'undefined' ? ffs.constructor === FontFaceSet : (ffs.constructor ? ffs.constructor.name === 'FontFaceSet' : null),
        };
      }

      // =============================================================
      // 14. RTCPeerConnection Prototype Shapes
      // =============================================================
      if (typeof RTCPeerConnection !== 'undefined') {
        const pcProto = RTCPeerConnection.prototype;
        for (const m of ['createOffer', 'createAnswer', 'setLocalDescription', 'getStats',
                         'localDescription', 'currentLocalDescription', 'remoteDescription', 'currentRemoteDescription']) {
          out.targets['RTCPeerConnection.' + m] = {
            protoDesc: inspectDescriptor(pcProto, m, 'RTCPeerConnection.prototype'),
          };
        }
      }

      // =============================================================
      // 15. Object.getOwnPropertyNames Enumeration Order
      // =============================================================
      const listOrder = (obj, label) => {
        try {
          return Object.getOwnPropertyNames(obj);
        } catch (e) {
          return ['ERR:' + e.message];
        }
      };

      out.order['Navigator.prototype'] = listOrder(Navigator.prototype);
      out.order['navigator'] = listOrder(navigator);
      out.order['Screen.prototype'] = listOrder(Screen.prototype);
      out.order['screen'] = listOrder(screen);
      out.order['Date'] = listOrder(Date);
      out.order['Date.prototype'] = listOrder(Date.prototype);
      if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
        out.order['Intl.DateTimeFormat'] = listOrder(Intl.DateTimeFormat);
        out.order['Intl.DateTimeFormat.prototype'] = listOrder(Intl.DateTimeFormat.prototype);
      }
      if (window.WebGLRenderingContext) {
        out.order['WebGLRenderingContext.prototype'] = listOrder(WebGLRenderingContext.prototype);
      }
      if (window.CanvasRenderingContext2D) {
        out.order['CanvasRenderingContext2D.prototype'] = listOrder(CanvasRenderingContext2D.prototype);
      }
      if (window.FontFaceSet) {
        out.order['FontFaceSet.prototype'] = listOrder(FontFaceSet.prototype);
      }
      if (document.fonts) {
        out.order['document.fonts'] = listOrder(document.fonts);
      }
      if (window.RTCPeerConnection) {
        out.order['RTCPeerConnection.prototype'] = listOrder(RTCPeerConnection.prototype);
      }

      // =============================================================
      // 16. Hidden Symbols Audit on Core Objects
      // =============================================================
      const checkSymbols = (obj, label) => {
        try {
          const syms = Object.getOwnPropertySymbols(obj).map(s => String(s));
          if (syms.length > 0) out.symbolsLeak[label] = syms;
        } catch (_) {}
      };

      checkSymbols(Navigator.prototype, 'Navigator.prototype');
      checkSymbols(navigator, 'navigator');
      checkSymbols(Screen.prototype, 'Screen.prototype');
      checkSymbols(screen, 'screen');
      checkSymbols(Date, 'Date');
      checkSymbols(Date.prototype, 'Date.prototype');
      checkSymbols(CanvasRenderingContext2D.prototype, 'CanvasRenderingContext2D.prototype');
      checkSymbols(HTMLCanvasElement.prototype, 'HTMLCanvasElement.prototype');
      checkSymbols(Document.prototype, 'Document.prototype');
      checkSymbols(document, 'document');
      checkSymbols(Function.prototype, 'Function.prototype');
      checkSymbols(Function.prototype.toString, 'Function.prototype.toString');

      // Check symbols on individual functions
      for (const [k, t] of Object.entries(out.targets)) {
        if (t.protoDesc && t.protoDesc.valueProbe && typeof t.protoDesc.valueProbe === 'object' && t.protoDesc.valueProbe.hasSymbols) {
          out.symbolsLeak[k + ' (value)'] = t.protoDesc.valueProbe.symbols;
        }
        if (t.protoDesc && t.protoDesc.getProbe && t.protoDesc.getProbe.hasSymbols) {
          out.symbolsLeak[k + ' (get)'] = t.protoDesc.getProbe.symbols;
        }
        if (t.protoDesc && t.protoDesc.setProbe && t.protoDesc.setProbe.hasSymbols) {
          out.symbolsLeak[k + ' (set)'] = t.protoDesc.setProbe.symbols;
        }
      }

      // =============================================================
      // 17. DedicatedWorker Probe
      // =============================================================
      try {
        const worker = new Worker('/worker.js');
        const workerPromise = new Promise((resolve) => {
          worker.onmessage = (e) => resolve(e.data);
          worker.onerror = (e) => resolve({ error: e.message || 'Worker error' });
          setTimeout(() => resolve({ timeout: true }), 4000);
        });
        worker.postMessage({ cmd: 'probe' });
        out.workerReport = await workerPromise;
        worker.terminate();
      } catch (err) {
        out.workerReport = { error: String(err) };
      }

      window.__AUDIT_RESULT__ = out;
    } catch (err) {
      window.__AUDIT_ERROR__ = String(err && err.stack ? err.stack : err);
      console.error("[PROBE FATAL ERROR]", err);
    } finally {
      window.__AUDIT_READY__ = true;
    }
    })();
  </script>
</body>
</html>`;
  }
}

async function runAuditSession(profileConfig, isInject, server) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-proto-audit-' + profileConfig.id + '-'));
  const fp = isInject ? buildFingerprint(profileConfig) : null;

  const launchArgs = [
    dir,
    '--headless=new',
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
      if (isInject && requestHeaderRewriter) {
        if (event?.method === 'Fetch.requestPaused' && event.params?.requestId && event.params?.responseStatusCode == null) {
          const reqId = event.params.requestId;
          if (requestHeaderRewriter.inFlight.has(reqId)) {
            conn.command('Fetch.continueRequest', { requestId: reqId }, { sessionId: event.sessionId }).catch(() => {});
            return;
          }
          try { requestHeaderRewriter.handleEvent(event, conn); } catch (e) {}
          return;
        }
      }

      if (event?.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo = {}, waitingForDebugger } = event.params || {};
        if (!sessionId) return;
        (async () => {
          try {
            if (targetInfo.type === 'worker') {
              if (isInject) {
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
              }
            }
          } finally {
            if (waitingForDebugger) {
              await conn.command('Runtime.runIfWaitingForDebugger', {}, { sessionId }).catch(() => {});
            }
          }
        })();
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
      const errCheck = await connection.command('Runtime.evaluate', { expression: 'window.__AUDIT_ERROR__', returnByValue: true }, { sessionId }).catch(() => null);
      if (errCheck?.result?.value) console.error("  [PROBE IN-PAGE ERROR]:", errCheck.result.value);
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
  console.log('Function.prototype.toString & Prototype Shape Consistency Audit');
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
    // 1. Native Un-injected Baseline
    console.log('\n[1/3] Running Session 1: Baseline (Un-injected Stock Kernel)...');
    const baselineProfile = {
      id: 'baseline',
      name: 'baseline',
      os: 'macos',
      language: 'en-US',
      privacy: { timezoneMode: 'real' },
    };
    rawResults.baseline = await runAuditSession(baselineProfile, false, server);
    console.log('  Baseline session complete.');

    // 2. Injected Windows Desktop Persona
    console.log('\n[2/3] Running Session 2: Windows Persona (Intel D3D11, America/New_York)...');
    const windowsProfile = {
      id: 'win-d3d11',
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
    rawResults.windows = await runAuditSession(windowsProfile, true, server);
    console.log('  Windows session complete.');

    // 3. Injected iOS Mobile Persona
    console.log('\n[3/3] Running Session 3: iOS Mobile Persona (iPhone, Asia/Shanghai)...');
    const iosProfile = {
      id: 'ios-iphone',
      name: 'ios-iphone',
      os: 'ios',
      mobile: true,
      platform: 'iPhone',
      language: 'zh-CN',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      exitIp: '114.114.114.114',
      exitTimezone: 'Asia/Shanghai',
      webglRenderer: 'Apple GPU',
      webglVendor: 'Apple Inc.',
      privacy: {
        deviceProfile: 'persona',
        timezoneMode: 'custom',
        timezone: 'Asia/Shanghai',
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
    console.log('  iOS session complete.');

  } finally {
    await server.stop();
  }

  // Dump Raw Evidence JSON
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  const rawPath = path.join(reportsDir, 'prototype-shape-toString-raw.json');
  fs.writeFileSync(rawPath, JSON.stringify(rawResults, null, 2), 'utf8');
  console.log(`\n[Audit] Raw results dumped to ${rawPath}`);

  // Automated Differential Analysis
  console.log('\n================================================================');
  console.log('DIFF ANALYSIS: Baseline vs Injected Personas');
  console.log('================================================================');

  const baseTargets = rawResults.baseline?.targets || {};
  const winTargets = rawResults.windows?.targets || {};
  const iosTargets = rawResults.ios?.targets || {};

  let totalScanned = 0;
  let toStringMismatches = 0;
  let descriptorMismatches = 0;
  let generatorLeaks = 0;
  let ownPropMismatches = 0;

  const diffTable = [];

  for (const [key, baseT] of Object.entries(baseTargets)) {
    totalScanned++;
    const winT = winTargets[key];
    if (!winT) continue;

    // Check descriptors
    const bDesc = baseT.protoDesc || {};
    const wDesc = winT.protoDesc || {};

    let descDiff = false;
    if (bDesc.exists && wDesc.exists) {
      if (bDesc.enumerable !== wDesc.enumerable ||
          bDesc.configurable !== wDesc.configurable ||
          bDesc.writable !== wDesc.writable ||
          bDesc.isAccessor !== wDesc.isAccessor) {
        descDiff = true;
        descriptorMismatches++;
      }
    }

    // Check toString & name/length on getters / values
    let tsDiff = false;
    let isGen = false;

    const checkFnPair = (bFn, wFn, role) => {
      if (!bFn || !wFn) return;
      if (wFn.isGenerator) {
        generatorLeaks++;
        isGen = true;
      }
      if (bFn.isNativeCode && !wFn.isNativeCode) {
        tsDiff = true;
        toStringMismatches++;
        diffTable.push({
          api: `${key} (${role})`,
          issue: 'Native code string missing / leaked JS source',
          baseline: bFn.toStringVal,
          injected: wFn.toStringVal,
          bName: bFn.name,
          wName: wFn.name,
          bLen: bFn.length,
          wLen: wFn.length,
        });
      } else if (bFn.name !== wFn.name || bFn.length !== wFn.length) {
        tsDiff = true;
        diffTable.push({
          api: `${key} (${role})`,
          issue: 'Name or length arity mismatch',
          baseline: `name: "${bFn.name}", len: ${bFn.length}`,
          injected: `name: "${wFn.name}", len: ${wFn.length}`,
        });
      }
    };

    if (bDesc.getProbe && wDesc.getProbe) checkFnPair(bDesc.getProbe, wDesc.getProbe, 'get');
    if (bDesc.setProbe && wDesc.setProbe) checkFnPair(bDesc.setProbe, wDesc.setProbe, 'set');
    if (bDesc.valueProbe && typeof bDesc.valueProbe === 'object' && wDesc.valueProbe && typeof wDesc.valueProbe === 'object') {
      checkFnPair(bDesc.valueProbe, wDesc.valueProbe, 'value');
    }

    // Check own property placement
    if (baseT.isOwnOnInstance !== undefined && winT.isOwnOnInstance !== undefined) {
      if (baseT.isOwnOnInstance !== winT.isOwnOnInstance) {
        ownPropMismatches++;
        diffTable.push({
          api: key,
          issue: `Own property mismatch: baseline isOwn=${baseT.isOwnOnInstance}, injected isOwn=${winT.isOwnOnInstance}`,
          baseline: `isOwn: ${baseT.isOwnOnInstance}`,
          injected: `isOwn: ${winT.isOwnOnInstance}`,
        });
      }
    }
  }

  console.log(`Total APIs & Properties Scanned: ${totalScanned}`);
  console.log(`Function toString Mismatches   : ${toStringMismatches}`);
  console.log(`Descriptor Shape Mismatches    : ${descriptorMismatches}`);
  console.log(`Generator / Source Leaks       : ${generatorLeaks}`);
  console.log(`Own Property Placement Diff    : ${ownPropMismatches}`);
  console.log(`Total Flagged Differences      : ${diffTable.length}`);

  // Hidden Symbols Audit
  console.log('\n--- Hidden Symbols Leakage (S_NATIVE trace) ---');
  const winSymbols = rawResults.windows?.symbolsLeak || {};
  const symKeys = Object.keys(winSymbols);
  console.log(`Total entities with custom Symbol(): ${symKeys.length}`);
  for (const k of symKeys.slice(0, 10)) {
    console.log(`  - ${k}: ${winSymbols[k]}`);
  }

  // Stack Leaks
  console.log('\n--- Illegal Invocation Stack Trace Leaks ---');
  const winStacks = rawResults.windows?.stackLeaks || {};
  for (const [k, v] of Object.entries(winStacks)) {
    if (v && v.hasLeak) {
      console.log(`  🚨 Stack Leak in ${k}: ${v.leakedKeywords.join(', ')}`);
    }
  }

  // Iterators
  console.log('\n--- Iterator Types ---');
  console.log('Baseline Iterators:', rawResults.baseline?.iteratorTypes);
  console.log('Windows Iterators :', rawResults.windows?.iteratorTypes);

  // Property Order diffs
  console.log('\n--- Property Enumeration Order Diffs ---');
  const baseOrder = rawResults.baseline?.order || {};
  const winOrder = rawResults.windows?.order || {};
  for (const [k, bList] of Object.entries(baseOrder)) {
    const wList = winOrder[k];
    if (!wList) continue;
    const bStr = bList.join(',');
    const wStr = wList.join(',');
    if (bStr !== wStr) {
      console.log(`  ⚠️ Order Diff in ${k}:`);
      console.log(`     Baseline (${bList.length}): ${bList.slice(0, 8).join(', ')}...`);
      console.log(`     Injected (${wList.length}): ${wList.slice(0, 8).join(', ')}...`);
    } else {
      console.log(`  ✅ Order Identical in ${k} (${bList.length} items)`);
    }
  }

  console.log('\n================================================================');
  console.log('Audit completed. Data saved.');
})();
