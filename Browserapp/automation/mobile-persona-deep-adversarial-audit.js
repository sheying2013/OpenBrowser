#!/usr/bin/env node
'use strict';

/**
 * Mobile Persona (iOS / Android) Deep Adversarial Red-Team Audit
 * OpenBrowser Hardening
 *
 * Full real-kernel A/B/C adversarial audit comparing:
 *  1. Native macOS Stock Baseline (un-injected Chromium kernel)
 *  2. iOS Mobile Persona (iPhone 16 Plus / iOS 18, Apple GPU, Retina DPR 3.0, Touch)
 *  3. Android Mobile Persona (Google Pixel 7 Pro / Android 14, PowerVR/Adreno GPU, DPR 3.0, Touch)
 *
 * Strictly executes inside a fully loaded, attached HTTP document (document.readyState === 'complete').
 * Zero modifications to existing product or test files.
 *
 * Covers 6 core areas (A to F, items 1 to 20):
 *  A. Existence Contradictions (iOS forbidden/mandatory APIs, Android chrome.app, Desktop mobile leaks)
 *  B. Media Queries & Interaction Phases (pointer, hover, resolution, orientation, touch APIs, screen.orientation)
 *  C. Viewport & Geometry (innerWidth/outerWidth, visualViewport, screen, DPR, availLeft/availTop, screenX/Y)
 *  D. UA / Client Hints / Languages (iOS userAgentData absence, Android platform/model, wire Accept-Language)
 *  E. Sensors, Permissions, Hardware (DeviceOrientationEvent, requestPermission, permissions.query, battery, deviceMemory)
 *  F. Fonts, WebGL, Canvas (Desktop fonts on mobile, Apple GPU vs Mali/Adreno, canvas measureText metrics)
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

function extractRawHeaders(req) {
  const raw = req.rawHeaders || [];
  const list = [];
  const map = {};
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    list.push({ name, value });
    map[name.toLowerCase()] = value;
  }
  return {
    rawList: list,
    map,
  };
}

class AuditServer {
  constructor() {
    this.server = null;
    this.port = 0;
    this.recordedHeaders = {
      navigation: null,
      fetchRequest: null,
      clientHintsFetch: null,
    };
  }

  reset() {
    this.recordedHeaders = {
      navigation: null,
      fetchRequest: null,
      clientHintsFetch: null,
    };
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
      const p = parsedUrl.pathname;

      res.setHeader('Access-Control-Allow-Origin', '*');

      if (p === '/' || p === '/index.html') {
        this.recordedHeaders.navigation = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getMainHtml());
        return;
      }

      if (p === '/worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(this.getWorkerJs());
        return;
      }

      if (p === '/iframe.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getIframeHtml());
        return;
      }

      if (p === '/api/fetch') {
        this.recordedHeaders.fetchRequest = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (p === '/api/opt-in-ch') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Accept-CH': 'sec-ch-ua-arch, sec-ch-ua-bitness, sec-ch-ua-full-version, sec-ch-ua-model, sec-ch-ua-platform-version',
        });
        res.end(JSON.stringify({ ok: true, optIn: true }));
        return;
      }

      if (p === '/api/fetch-ch') {
        this.recordedHeaders.clientHintsFetch = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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
        const out = {
          userAgent: self.navigator ? self.navigator.userAgent : null,
          platform: self.navigator ? self.navigator.platform : null,
          languages: self.navigator ? Array.from(self.navigator.languages || []) : [],
          hardwareConcurrency: self.navigator ? self.navigator.hardwareConcurrency : null,
          hasDeviceMemory: self.navigator ? ('deviceMemory' in self.navigator) : false,
          deviceMemory: self.navigator ? self.navigator.deviceMemory : null,
          hasUserAgentData: self.navigator ? ('userAgentData' in self.navigator) : false,
          userAgentData: (self.navigator && self.navigator.userAgentData) ? {
            platform: self.navigator.userAgentData.platform,
            mobile: self.navigator.userAgentData.mobile,
            brands: self.navigator.userAgentData.brands,
          } : null,
          hasOffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
        };

        if (typeof OffscreenCanvas !== 'undefined') {
          try {
            const oc = new OffscreenCanvas(64, 64);
            const gl = oc.getContext('webgl');
            if (gl) {
              const ext = gl.getExtension('WEBGL_debug_renderer_info');
              out.offscreenWebgl = {
                vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
                renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
              };
            }
          } catch (err) {
            out.offscreenWebgl = { error: err.message };
          }
        }

        self.postMessage(out);
      };
    `;
  }

  getIframeHtml() {
    return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <script>
    window.parent.postMessage({
      type: 'iframe_result',
      data: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        vendor: navigator.vendor,
        maxTouchPoints: navigator.maxTouchPoints,
        dpr: window.devicePixelRatio,
        screenWidth: screen.width,
        screenHeight: screen.height,
        chromeInWindow: 'chrome' in window,
        hasChromeApp: Boolean(window.chrome && window.chrome.app), chromeAppType: typeof window.chrome?.app,
        standaloneInNav: 'standalone' in navigator,
        orientationInWindow: 'orientation' in window,
        hasUserAgentData: 'userAgentData' in navigator,
      }
    }, '*');
  </script>
</body>
</html>`;
  }

  getMainHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mobile Persona Adversarial Audit</title>
</head>
<body>
  <h1>Mobile Persona Adversarial Probe</h1>
  <canvas id="probe-canvas" width="64" height="64" style="display:none;"></canvas>

  <script>
    (async () => {
      const timeoutPromise = (p, ms, fallback) => Promise.race([
        p,
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
      ]);

      try {
        console.log('[PROBE] Starting mobile persona probe...');
        const out = {
          areaA: {},
          areaB: {},
          areaC: {},
          areaD: {},
          areaE: {},
          areaF: {},
          crossSurface: {},
        };

        // ============================================================
        // AREA A: 存在性矛盾 (Existence Contradictions)
        // ============================================================
        // 1. window.chrome & sub-properties
        out.areaA.windowChrome = {
          inWindow: 'chrome' in window,
          typeof: typeof window.chrome,
          keys: window.chrome ? Object.keys(window.chrome) : [],
          hasApp: Boolean(window.chrome && ('app' in window.chrome)),
          appType: window.chrome ? typeof window.chrome.app : 'undefined',
          appKeys: (window.chrome && window.chrome.app) ? Object.keys(window.chrome.app) : [],
          hasCsi: Boolean(window.chrome && ('csi' in window.chrome)),
          hasLoadTimes: Boolean(window.chrome && ('loadTimes' in window.chrome)),
          hasRuntime: Boolean(window.chrome && ('runtime' in window.chrome)),
        };

        // 2. navigator.connection
        out.areaA.connection = {
          inNav: 'connection' in navigator,
          typeof: typeof navigator.connection,
          effectiveType: navigator.connection?.effectiveType,
          rtt: navigator.connection?.rtt,
          downlink: navigator.connection?.downlink,
          type: navigator.connection?.type,
          saveData: navigator.connection?.saveData,
          protoKeys: (navigator.connection && Object.getPrototypeOf(navigator.connection)) ? Object.getOwnPropertyNames(Object.getPrototypeOf(navigator.connection)) : [],
        };

        // 3. navigator.getBattery
        out.areaA.getBattery = {
          inNav: 'getBattery' in navigator,
          typeof: typeof navigator.getBattery,
          inProto: typeof Navigator !== 'undefined' ? ('getBattery' in Navigator.prototype) : false,
        };
        try {
          if (typeof navigator.getBattery === 'function') {
            const bm = await timeoutPromise(navigator.getBattery(), 1000, null);
            if (bm) {
              out.areaA.getBattery.exec = {
                success: true,
                charging: bm.charging,
                level: bm.level,
                chargingTime: bm.chargingTime,
                dischargingTime: bm.dischargingTime,
              };
            } else {
              out.areaA.getBattery.exec = { success: false, reason: 'timeout' };
            }
          } else {
            out.areaA.getBattery.exec = { success: false, reason: 'not a function' };
          }
        } catch (err) {
          out.areaA.getBattery.exec = {
            success: false,
            errorName: err.name,
            errorMessage: err.message,
          };
        }

        // 4. Hardware APIs: usb, hid, bluetooth, serial
        out.areaA.hardwareApis = {
          usb: { inNav: 'usb' in navigator, typeof: typeof navigator.usb },
          hid: { inNav: 'hid' in navigator, typeof: typeof navigator.hid },
          bluetooth: { inNav: 'bluetooth' in navigator, typeof: typeof navigator.bluetooth },
          serial: { inNav: 'serial' in navigator, typeof: typeof navigator.serial },
        };

        // 5. navigator.plugins & mimeTypes
        out.areaA.plugins = {
          inNav: 'plugins' in navigator,
          length: navigator.plugins ? navigator.plugins.length : -1,
          names: navigator.plugins ? Array.from(navigator.plugins).map(p => p.name) : [],
          mimeTypesLength: navigator.mimeTypes ? navigator.mimeTypes.length : -1,
        };

        // 6. navigator.pdfViewerEnabled
        out.areaA.pdfViewerEnabled = {
          inNav: 'pdfViewerEnabled' in navigator,
          value: navigator.pdfViewerEnabled,
          descOnProto: typeof Navigator !== 'undefined' ? Boolean(Object.getOwnPropertyDescriptor(Navigator.prototype, 'pdfViewerEnabled')) : false,
        };

        // 7. navigator.keyboard, presentation, wakeLock
        out.areaA.otherNavApis = {
          keyboard: { inNav: 'keyboard' in navigator, typeof: typeof navigator.keyboard },
          presentation: { inNav: 'presentation' in navigator, typeof: typeof navigator.presentation },
          wakeLock: { inNav: 'wakeLock' in navigator, typeof: typeof navigator.wakeLock },
        };

        // 8. iOS Mandatory: window.GestureEvent
        out.areaA.gestureEvent = {
          inWindow: 'GestureEvent' in window,
          typeof: typeof window.GestureEvent,
          protoConstructorName: window.GestureEvent?.prototype?.constructor?.name,
          descOnWindow: Object.getOwnPropertyDescriptor(window, 'GestureEvent') ? {
            enumerable: Object.getOwnPropertyDescriptor(window, 'GestureEvent').enumerable,
            configurable: Object.getOwnPropertyDescriptor(window, 'GestureEvent').configurable,
            writable: Object.getOwnPropertyDescriptor(window, 'GestureEvent').writable,
          } : null,
        };

        // 9. iOS Mandatory: navigator.standalone
        out.areaA.standalone = {
          inNav: 'standalone' in navigator,
          value: navigator.standalone,
          typeof: typeof navigator.standalone,
        };

        // 10. iOS Mandatory: window.orientation
        out.areaA.windowOrientation = {
          inWindow: 'orientation' in window,
          typeof: typeof window.orientation,
          value: window.orientation,
        };

        // 11. Touch event listeners on window and document
        out.areaA.touchHandlers = {
          ontouchstartInWindow: 'ontouchstart' in window,
          ontouchstartInDoc: 'ontouchstart' in document,
          ontouchstartInHtml: 'ontouchstart' in document.documentElement,
          windowOntouchstartVal: window.ontouchstart,
          docOntouchstartVal: document.ontouchstart,
        };

        // 12. WebKit prefix APIs
        out.areaA.webkitPrefixes = {
          webkitRequestAnimationFrame: 'webkitRequestAnimationFrame' in window,
          webkitCancelAnimationFrame: 'webkitCancelAnimationFrame' in window,
          webkitAudioContext: 'webkitAudioContext' in window,
          webkitURL: 'webkitURL' in window,
          webkitConvertPointFromNodeToPage: 'webkitConvertPointFromNodeToPage' in window,
          webkitConvertPointFromPageToNode: 'webkitConvertPointFromPageToNode' in window,
        };

        // ============================================================
        // AREA B: 媒体查询与交互相位 (Media Queries & Interaction)
        // ============================================================
        const dpr = window.devicePixelRatio;
        out.areaB.matchMedia = {
          pointerCoarse: matchMedia('(pointer: coarse)').matches,
          pointerFine: matchMedia('(pointer: fine)').matches,
          pointerNone: matchMedia('(pointer: none)').matches,
          anyPointerCoarse: matchMedia('(any-pointer: coarse)').matches,
          anyPointerFine: matchMedia('(any-pointer: fine)').matches,
          anyPointerNone: matchMedia('(any-pointer: none)').matches,
          hoverNone: matchMedia('(hover: none)').matches,
          hoverHover: matchMedia('(hover: hover)').matches,
          anyHoverNone: matchMedia('(any-hover: none)').matches,
          anyHoverHover: matchMedia('(any-hover: hover)').matches,
          orientationPortrait: matchMedia('(orientation: portrait)').matches,
          orientationLandscape: matchMedia('(orientation: landscape)').matches,
          prefersReducedMotionNoPreference: matchMedia('(prefers-reduced-motion: no-preference)').matches,
          dynamicRangeHigh: matchMedia('(dynamic-range: high)').matches,
          dynamicRangeStandard: matchMedia('(dynamic-range: standard)').matches,
          colorGamutP3: matchMedia('(color-gamut: p3)').matches,
          colorGamutSrgb: matchMedia('(color-gamut: srgb)').matches,
          res1dppx: matchMedia('(resolution: 1dppx)').matches,
          res2dppx: matchMedia('(resolution: 2dppx)').matches,
          res3dppx: matchMedia('(resolution: 3dppx)').matches,
          resDprDppx: matchMedia('(resolution: ' + dpr + 'dppx)').matches,
          resDprExact: matchMedia('(resolution: ' + Number(dpr.toFixed(3)) + 'dppx)').matches,
          minRes2dppx: matchMedia('(min-resolution: 2dppx)').matches,
        };

        // Touch APIs
        let touchConstructOk = false;
        let touchConstructError = null;
        try {
          if (typeof TouchEvent === 'function') {
            const te = new TouchEvent('touchstart', { bubbles: true, cancelable: true });
            touchConstructOk = te instanceof TouchEvent;
          }
        } catch (err) {
          touchConstructError = err.message;
        }

        let docCreateTouchOk = false;
        try {
          if (typeof document.createTouch === 'function') {
            docCreateTouchOk = true;
          }
        } catch (_) {}

        let createEventTouchOk = false;
        try {
          const ev = document.createEvent('TouchEvent');
          createEventTouchOk = Boolean(ev);
        } catch (err) {
          createEventTouchOk = false;
        }

        out.areaB.touchApis = {
          maxTouchPoints: navigator.maxTouchPoints,
          typeofTouchEvent: typeof TouchEvent,
          typeofTouch: typeof Touch,
          typeofTouchList: typeof TouchList,
          touchConstructOk,
          touchConstructError,
          typeofCreateTouch: typeof document.createTouch,
          createEventTouchOk,
        };

        // screen.orientation
        let orientLockRejected = null;
        let orientLockErrorName = null;
        try {
          if (screen.orientation && typeof screen.orientation.lock === 'function') {
            const lockP = screen.orientation.lock('portrait');
            await timeoutPromise(lockP.then(() => {
              orientLockRejected = false;
            }).catch((err) => {
              orientLockRejected = true;
              orientLockErrorName = err.name;
            }), 300, null);
          }
        } catch (err) {
          orientLockRejected = true;
          orientLockErrorName = err.name;
        }

        out.areaB.screenOrientation = {
          hasScreenOrientation: Boolean(screen.orientation),
          type: screen.orientation?.type,
          angle: screen.orientation?.angle,
          screenWidth: screen.width,
          screenHeight: screen.height,
          isPortraitDimension: screen.height >= screen.width,
          orientLockRejected,
          orientLockErrorName,
        };

        // ============================================================
        // AREA C: 视口几何 (Viewport Geometry)
        // ============================================================
        out.areaC.viewport = {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          outerInnerWidthDiff: Math.abs(window.outerWidth - window.innerWidth),
          outerInnerHeightDiff: Math.abs(window.outerHeight - window.innerHeight),
          visualViewport: {
            scale: window.visualViewport?.scale,
            width: window.visualViewport?.width,
            height: window.visualViewport?.height,
            offsetLeft: window.visualViewport?.offsetLeft,
            offsetTop: window.visualViewport?.offsetTop,
            pageLeft: window.visualViewport?.pageLeft,
            pageTop: window.visualViewport?.pageTop,
          },
          screen: {
            width: screen.width,
            height: screen.height,
            availWidth: screen.availWidth,
            availHeight: screen.availHeight,
            availLeft: screen.availLeft,
            availTop: screen.availTop,
            colorDepth: screen.colorDepth,
            pixelDepth: screen.pixelDepth,
          },
          windowCoords: {
            screenX: window.screenX,
            screenY: window.screenY,
            screenLeft: window.screenLeft,
            screenTop: window.screenTop,
          },
          devicePixelRatio: dpr,
          mathChecks: {
            visualEqualsInnerWidth: window.visualViewport ? (window.visualViewport.width === window.innerWidth) : null,
            physicalWidth: Math.round(screen.width * dpr),
            physicalHeight: Math.round(screen.height * dpr),
            availLeftIsZero: screen.availLeft === 0,
            availTopIsZero: screen.availTop === 0,
            screenXIsZero: window.screenX === 0,
            screenYIsZero: window.screenY === 0,
          }
        };

        // ============================================================
        // AREA D: UA / Client Hints / Languages
        // ============================================================
        let highEntropyValues = null;
        if (navigator.userAgentData && typeof navigator.userAgentData.getHighEntropyValues === 'function') {
          try {
            highEntropyValues = await timeoutPromise(navigator.userAgentData.getHighEntropyValues([
              'model', 'platformVersion', 'architecture', 'bitness', 'mobile', 'wow64', 'formFactors'
            ]), 1000, { timeout: true });
          } catch (err) {
            highEntropyValues = { error: err.message };
          }
        }

        out.areaD.identity = {
          userAgent: navigator.userAgent,
          appVersion: navigator.appVersion,
          platform: navigator.platform,
          vendor: navigator.vendor,
          language: navigator.language,
          languages: Array.from(navigator.languages || []),
          userAgentData: navigator.userAgentData ? {
            exists: true,
            platform: navigator.userAgentData.platform,
            mobile: navigator.userAgentData.mobile,
            brands: navigator.userAgentData.brands,
            highEntropy: highEntropyValues,
          } : { exists: false },
        };

        // ============================================================
        // AREA E: 传感器 / 权限 / 硬件
        // ============================================================
        out.areaE.sensors = {
          DeviceOrientationEvent: {
            inWindow: 'DeviceOrientationEvent' in window,
            typeof: typeof window.DeviceOrientationEvent,
            hasRequestPermission: typeof window.DeviceOrientationEvent?.requestPermission === 'function',
          },
          DeviceMotionEvent: {
            inWindow: 'DeviceMotionEvent' in window,
            typeof: typeof window.DeviceMotionEvent,
            hasRequestPermission: typeof window.DeviceMotionEvent?.requestPermission === 'function',
          },
          Gyroscope: {
            inWindow: 'Gyroscope' in window,
            typeof: typeof window.Gyroscope,
          },
          Accelerometer: {
            inWindow: 'Accelerometer' in window,
            typeof: typeof window.Accelerometer,
          },
          AbsoluteOrientationSensor: {
            inWindow: 'AbsoluteOrientationSensor' in window,
            typeof: typeof window.AbsoluteOrientationSensor,
          },
        };

        // Permissions query
        out.areaE.permissions = {};
        if (navigator.permissions && typeof navigator.permissions.query === 'function') {
          for (const pName of ['geolocation', 'notifications']) {
            try {
              const res = await timeoutPromise(navigator.permissions.query({ name: pName }), 500, null);
              out.areaE.permissions[pName] = res ? { supported: true, state: res.state } : { supported: false, timeout: true };
            } catch (err) {
              out.areaE.permissions[pName] = { supported: false, errorName: err.name, errorMessage: err.message };
            }
          }
          // Test camera & mic separately as some browsers throw on these names
          for (const pName of ['camera', 'microphone']) {
            try {
              const res = await timeoutPromise(navigator.permissions.query({ name: pName }), 500, null);
              out.areaE.permissions[pName] = res ? { supported: true, state: res.state } : { supported: false, timeout: true };
            } catch (err) {
              out.areaE.permissions[pName] = { supported: false, errorName: err.name, errorMessage: err.message };
            }
          }
        } else {
          out.areaE.permissions = 'navigator.permissions unavailable';
        }

        // Hardware details
        out.areaE.hardware = {
          hardwareConcurrency: navigator.hardwareConcurrency,
          hasDeviceMemory: 'deviceMemory' in navigator,
          deviceMemory: navigator.deviceMemory,
          protoHasDeviceMemory: typeof Navigator !== 'undefined' ? ('deviceMemory' in Navigator.prototype) : false,
        };

        // ============================================================
        // AREA F: 字体 / WebGL / Canvas 移动特征
        // ============================================================
        // Font detection via Canvas 2D
        const testFamilies = [
          // Android native
          'Roboto', 'Noto Sans', 'Droid Sans',
          // Windows desktop
          'Segoe UI', 'Calibri', 'Bahnschrift', 'Consolas', 'Arial',
          // macOS desktop
          'Menlo', 'Monaco', 'Helvetica Neue', 'PingFang SC',
          // Linux
          'Ubuntu'
        ];

        const fontCanvas = document.createElement('canvas');
        const fontCtx = fontCanvas.getContext('2d');
        const probeString = 'mmmmmmmmmmlliWWWWWWWWW@@@@@@@@@@1234567890';
        fontCtx.font = '72px monospace';
        const baseMonoW = Math.round(fontCtx.measureText(probeString).width * 1000) / 1000;
        fontCtx.font = '72px sans-serif';
        const baseSansW = Math.round(fontCtx.measureText(probeString).width * 1000) / 1000;

        out.areaF.fonts = {};
        for (const fam of testFamilies) {
          fontCtx.font = '72px "' + fam + '", monospace';
          const wMono = Math.round(fontCtx.measureText(probeString).width * 1000) / 1000;
          fontCtx.font = '72px "' + fam + '", sans-serif';
          const wSans = Math.round(fontCtx.measureText(probeString).width * 1000) / 1000;
          const detected = (wMono !== baseMonoW) || (wSans !== baseSansW);
          out.areaF.fonts[fam] = { detected, wMono, wSans };
        }

        // WebGL GPU strings and shader precision
        const glCanvas = document.getElementById('probe-canvas');
        const gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
        if (gl) {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          const getPrec = (target, type) => {
            const p = gl.getShaderPrecisionFormat(target, type);
            return p ? { rangeMin: p.rangeMin, rangeMax: p.rangeMax, precision: p.precision } : null;
          };
          out.areaF.webgl = {
            vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
            renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
            maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
            maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []),
            vertexHighp: getPrec(gl.VERTEX_SHADER, gl.HIGH_FLOAT),
            fragmentHighp: getPrec(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT),
            fragmentMediump: getPrec(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT),
            fragmentLowp: getPrec(gl.FRAGMENT_SHADER, gl.LOW_FLOAT),
          };
        } else {
          out.areaF.webgl = 'webgl unavailable';
        }

        // Canvas measureText advanced metrics
        const mMetrics = fontCtx.measureText('Hello World 123');
        out.areaF.measureText = {
          width: mMetrics.width,
          actualBoundingBoxAscent: mMetrics.actualBoundingBoxAscent,
          actualBoundingBoxDescent: mMetrics.actualBoundingBoxDescent,
          actualBoundingBoxLeft: mMetrics.actualBoundingBoxLeft,
          actualBoundingBoxRight: mMetrics.actualBoundingBoxRight,
          fontBoundingBoxAscent: mMetrics.fontBoundingBoxAscent,
          fontBoundingBoxDescent: mMetrics.fontBoundingBoxDescent,
        };

        // ============================================================
        // Cross-Surface: Worker & Iframe
        // ============================================================
        // 1. Worker
        try {
          const worker = new Worker('/worker.js');
          const workerPromise = new Promise((resolve) => {
            worker.onmessage = (e) => resolve(e.data);
            worker.onerror = (e) => resolve({ error: e.message || 'Worker error' });
            setTimeout(() => resolve({ timeout: true }), 1500);
          });
          worker.postMessage({ cmd: 'probe' });
          out.crossSurface.worker = await workerPromise;
          worker.terminate();
        } catch (err) {
          out.crossSurface.worker = { error: err.message };
        }

        // 2. Iframe
        try {
          const iframePromise = new Promise((resolve) => {
            const handler = (e) => {
              if (e.data && e.data.type === 'iframe_result') {
                window.removeEventListener('message', handler);
                resolve(e.data.data);
              }
            };
            window.addEventListener('message', handler);
            setTimeout(() => resolve({ timeout: true }), 1500);
          });
          const ifr = document.createElement('iframe');
          ifr.src = '/iframe.html';
          document.body.appendChild(ifr);
          out.crossSurface.iframe = await iframePromise;
          ifr.remove();
        } catch (err) {
          out.crossSurface.iframe = { error: err.message };
        }

        // Trigger network requests to capture wire headers
        try {
          await timeoutPromise(fetch('/api/fetch'), 1000, null);
          await timeoutPromise(fetch('/api/opt-in-ch'), 1000, null);
          await timeoutPromise(fetch('/api/fetch-ch'), 1000, null);
        } catch (_) {}

        console.log('[PROBE] Probe finished successfully, writing results.');
        window.__AUDIT_RESULT__ = out;
        window.__AUDIT_READY__ = true;
      } catch (globalErr) {
        console.error('[PROBE ERROR]', globalErr);
        window.__AUDIT_ERROR__ = (globalErr ? (globalErr.message || String(globalErr)) + String.fromCharCode(10) + (globalErr.stack || "") : "Unknown error");
        window.__AUDIT_READY__ = true;
      }
    })();
  </script>
</body>
</html>`;
  }
}

async function runSession(profileConfig, isInject, server) {
  server.reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-mobile-audit-' + profileConfig.id + '-'));
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
      // Unpause any target paused by waitForDebuggerOnStart
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

      // Fetch interception for headers
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
        if (msg) console.log('    [Console]', msg);
      }
      if (event?.method === 'Runtime.exceptionThrown') {
        console.error('    [Exception]', JSON.stringify(event.params?.exceptionDetails, null, 2));
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

    // Unpause primary session immediately
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

  return {
    client: clientResult,
    wireHeaders: server.recordedHeaders,
    fingerprint: fp,
  };
}

(async () => {
  console.log('================================================================');
  console.log('  Mobile Persona (iOS / Android) Deep Adversarial Red-Team Audit');
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
      id: 'audit-baseline',
      name: 'Baseline Stock Kernel',
      os: 'macos',
      language: 'en-US',
      privacy: { timezoneMode: 'real' },
    };
    rawResults.baseline = await runSession(baselineProfile, false, server);
    console.log('  Baseline session complete. Client err:', rawResults.baseline.client?.error || 'none');

    // 2. Injected iOS Persona (iPhone 16 Plus / iOS 18)
    console.log('\n[2/3] Running Session 2: Injected iOS Mobile Persona (iPhone 16 Plus, iOS 18)...');
    const iosProfile = {
      id: 'audit-ios',
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
    rawResults.ios = await runSession(iosProfile, true, server);
    console.log('  iOS session complete. Client err:', rawResults.ios.client?.error || 'none');

    // 3. Injected Android Persona (Google Pixel 7 Pro, Android 14)
    console.log('\n[3/3] Running Session 3: Injected Android Mobile Persona (Google Pixel 7 Pro, Android 14)...');
    const androidProfile = {
      id: 'audit-android',
      name: 'Google Pixel 7 Pro',
      os: 'android',
      mobile: true,
      platform: 'Linux armv8l',
      language: 'en-US',
      fingerprintLaunchSeed: '74',
      canvas: 'noise',
      webgl: 'noise',
      audio: 'noise',
      clientRects: 'noise',
      webrtc: 'proxy',
      exitIp: '198.51.100.22',
      exitTimezone: 'America/New_York',
      privacy: {
        deviceProfile: 'persona',
        timezoneMode: 'custom',
        timezone: 'America/New_York',
        languages: ['en-US', 'en'],
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
    rawResults.android = await runSession(androidProfile, true, server);
    console.log('  Android session complete. Client err:', rawResults.android.client?.error || 'none');

  } finally {
    await server.stop();
  }

  // Write raw results to reports/mobile-persona-deep-adversarial-raw.json
  const rawJsonPath = path.join(reportsDir, 'mobile-persona-deep-adversarial-raw.json');
  fs.writeFileSync(rawJsonPath, JSON.stringify(rawResults, null, 2), 'utf8');
  console.log('\n[Dump] Raw results written to: ' + rawJsonPath);

  // Reap any leftover kernels
  try {
    execSync('node ' + path.join(__dirname, 'reap-orphan-kernels.js'), { stdio: 'inherit' });
  } catch (_) {}

  console.log('\nAudit data collection completed successfully.');
})();
