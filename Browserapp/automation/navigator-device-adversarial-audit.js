#!/usr/bin/env node
'use strict';

/**
 * Navigator & Device API Surface Adversarial Red-Team Audit
 * OpenBrowser Hardening
 *
 * Exhaustive A/B adversarial audit covering 12 core surfaces:
 *  1. navigator.plugins / navigator.mimeTypes (length, names, prototypes, descriptors, ownPropertyNames order, mobile absence)
 *  2. navigator.connection (effectiveType, rtt, downlink, saveData, type, NetworkInformation prototype, iOS absence)
 *  3. navigator.getBattery() (BatteryManager charging, level, chargingTime, dischargingTime, prototype descriptors, blocked error messages, iOS absence)
 *  4. navigator.permissions.query() (geolocation, notifications, camera, microphone, Notification consistency, iOS restrictions, invalid name throwing)
 *  5. navigator.hardwareConcurrency & deviceMemory across THREE contexts (main, same-origin iframe, data: iframe insecure context, worker, offscreencanvas worker, prototype brand checks)
 *  6. navigator.maxTouchPoints / platform / vendor across main, iframe, worker & prototype brand checks
 *  7. navigator.usb / hid / bluetooth / serial existence, device enumeration, getAvailability, iOS absence
 *  8. navigator.mediaCapabilities.decodingInfo() & navigator.storage.estimate() (codec support leak, mobile disk quota leak)
 *  9. screen.orientation & window.orientation (portrait vs landscape geometry contradictions, screen.orientation.lock)
 * 10. navigator.pdfViewerEnabled / doNotTrack / globalPrivacyControl (Android/iOS PDF viewer absence, DNT reflection)
 * 11. performance.now() vs Date.now() clock skew & performance.timeOrigin
 * 12. navigator.webdriver & window.chrome object shapes (prototype brand checks, worker webdriver leak, chrome.app mobile/iOS contradiction)
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
  buildInjectionScript,
  buildWorkerInjectionScript,
  chromeArgsForFingerprint,
  applyFingerprintToTab,
} = require('./fingerprint');
const {
  writeOpenBrowserKernelInit,
  mapFingerprintToInitFields,
  validateKernelInitInvariants,
  detectOs,
  detectInitOs,
} = require('./kernel-init-sync');
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
    namesInOrder: list.map((h) => h.name),
    namesInOrderLower: list.map((h) => h.name.toLowerCase()),
    map,
  };
}

class AuditServer {
  constructor() {
    this.server = null;
    this.port = 0;
    this.recordedRequests = {
      mainPage: null,
      fetchRequest: null,
    };
  }

  resetRecorded() {
    for (const k of Object.keys(this.recordedRequests)) {
      this.recordedRequests[k] = null;
    }
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
      const p = parsedUrl.pathname;

      if (p === '/main') {
        this.recordedRequests.mainPage = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getMainHtml());
        return;
      }

      if (p === '/iframe-page') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getIframeHtml());
        return;
      }

      if (p === '/worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(this.getWorkerJs());
        return;
      }

      if (p === '/offscreencanvas-worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(this.getOffscreenCanvasWorkerJs());
        return;
      }

      if (p === '/api/fetch') {
        this.recordedRequests.fetchRequest = extractRawHeaders(req);
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
        let brandChecks = {};
        if (typeof WorkerNavigator !== 'undefined' && WorkerNavigator.prototype) {
          for (const key of ['hardwareConcurrency', 'deviceMemory', 'platform', 'webdriver']) {
            const d = Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, key);
            if (d && typeof d.get === 'function') {
              try {
                const val = d.get.call(WorkerNavigator.prototype);
                brandChecks[key] = { threw: false, returnedValue: val };
              } catch (err) {
                brandChecks[key] = { threw: true, name: err.name, message: err.message };
              }
            } else {
              brandChecks[key] = { noGetter: true, descriptorPresent: Boolean(d) };
            }
          }
        }

        let permQuery = null;
        if (navigator.permissions && navigator.permissions.query) {
          try {
            const p = await navigator.permissions.query({ name: 'notifications' });
            permQuery = { state: p.state, name: p.name };
          } catch (err) {
            permQuery = { threw: true, name: err.name, message: err.message };
          }
        }

        let connection = null;
        const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (c) {
          connection = {
            effectiveType: c.effectiveType,
            rtt: c.rtt,
            downlink: c.downlink,
            saveData: c.saveData,
            type: c.type,
          };
        }

        const report = {
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          webdriver: navigator.webdriver,
          hasWebdriverProperty: 'webdriver' in navigator,
          hasVendorInWorkerNav: 'vendor' in navigator,
          hasMaxTouchPointsInWorkerNav: 'maxTouchPoints' in navigator,
          hasConnection: 'connection' in navigator,
          connection,
          isSecureContext: self.isSecureContext,
          permQuery,
          brandChecks,
        };
        self.postMessage(report);
      };
    `;
  }

  getOffscreenCanvasWorkerJs() {
    return `
      self.onmessage = async (e) => {
        let offscreen = { supported: false };
        try {
          if (typeof OffscreenCanvas !== 'undefined') {
            const osc = new OffscreenCanvas(256, 256);
            const gl = osc.getContext('webgl2') || osc.getContext('webgl');
            let webglInfo = null;
            if (gl) {
              const dbg = gl.getExtension('WEBGL_debug_renderer_info');
              webglInfo = {
                vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
                renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
              };
            }
            offscreen = {
              supported: true,
              webglInfo,
            };
          }
        } catch (err) {
          offscreen = { supported: false, error: err.message };
        }

        const report = {
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          webdriver: navigator.webdriver,
          isSecureContext: self.isSecureContext,
          offscreen,
        };
        self.postMessage(report);
      };
    `;
  }

  getIframeHtml() {
    return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <script>
    window.probeIframe = () => {
      return {
        platform: navigator.platform,
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        maxTouchPoints: navigator.maxTouchPoints,
        vendor: navigator.vendor,
        webdriver: navigator.webdriver,
        pluginsLength: navigator.plugins ? navigator.plugins.length : null,
        hasChrome: 'chrome' in window,
        hasChromeApp: Boolean(window.chrome && window.chrome.app),
        isSecureContext: window.isSecureContext,
      };
    };
  </script>
</body>
</html>`;
  }

  getMainHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Navigator & Device API Surface Adversarial Audit</title>
</head>
<body>
  <h1>Adversarial Testbed</h1>
  <script>
    (async () => {
      const out = {};
      try {
        console.log('[PROBE] Starting probe execution...');

        // ============================================================
        // 1. navigator.plugins & navigator.mimeTypes
        // ============================================================
        console.log('[PROBE] 1. plugins & mimeTypes');
        const plugins = navigator.plugins;
        const mimeTypes = navigator.mimeTypes;
        out.plugins = {
          hasPlugins: 'plugins' in navigator,
          length: plugins ? plugins.length : null,
          instanceofPluginArray: typeof PluginArray !== 'undefined' && plugins instanceof PluginArray,
          protoIsPluginArrayProto: typeof PluginArray !== 'undefined' && Object.getPrototypeOf(plugins) === PluginArray.prototype,
          names: plugins ? Array.from(plugins).map(p => p.name) : [],
          filenames: plugins ? Array.from(plugins).map(p => p.filename) : [],
          descriptions: plugins ? Array.from(plugins).map(p => p.description) : [],
          ownPropertyNames: plugins ? Object.getOwnPropertyNames(plugins) : [],
          itemMethod: plugins && typeof plugins.item === 'function' ? plugins.item(0)?.name : null,
          namedItemMethod: plugins && typeof plugins.namedItem === 'function' ? plugins.namedItem('PDF Viewer')?.name : null,
          itemMatchesIndex: plugins && plugins.length > 0 ? (plugins.item(0) === plugins[0]) : null,
          firstPluginProto: plugins && plugins[0] && typeof Plugin !== 'undefined' ? (plugins[0] instanceof Plugin) : null,
          firstPluginOwnNames: plugins && plugins[0] ? Object.getOwnPropertyNames(plugins[0]) : [],
        };
        out.mimeTypes = {
          hasMimeTypes: 'mimeTypes' in navigator,
          length: mimeTypes ? mimeTypes.length : null,
          instanceofMimeTypeArray: typeof MimeTypeArray !== 'undefined' && mimeTypes instanceof MimeTypeArray,
          protoIsMimeTypeArrayProto: typeof MimeTypeArray !== 'undefined' && Object.getPrototypeOf(mimeTypes) === MimeTypeArray.prototype,
          types: mimeTypes ? Array.from(mimeTypes).map(m => m.type) : [],
          ownPropertyNames: mimeTypes ? Object.getOwnPropertyNames(mimeTypes) : [],
          firstMimeProto: mimeTypes && mimeTypes[0] && typeof MimeType !== 'undefined' ? (mimeTypes[0] instanceof MimeType) : null,
          firstMimeEnabledPluginName: mimeTypes && mimeTypes[0]?.enabledPlugin ? mimeTypes[0].enabledPlugin.name : null,
          enabledPluginMatchesPlugins: mimeTypes && mimeTypes[0]?.enabledPlugin && plugins && plugins[0] ? (mimeTypes[0].enabledPlugin === plugins[0]) : null,
        };

        // ============================================================
        // 2. navigator.connection (NetworkInformation)
        // ============================================================
        console.log('[PROBE] 2. connection');
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        out.connection = {
          hasConnection: 'connection' in navigator,
          value: conn ? {
            effectiveType: conn.effectiveType,
            rtt: conn.rtt,
            downlink: conn.downlink,
            saveData: conn.saveData,
            type: conn.type,
            instanceofNetworkInformation: typeof NetworkInformation !== 'undefined' && conn instanceof NetworkInformation,
            protoCheck: typeof NetworkInformation !== 'undefined' && Object.getPrototypeOf(conn) === NetworkInformation.prototype,
            ownPropertyNames: Object.getOwnPropertyNames(conn),
          } : null,
        };

        // ============================================================
        // 3. navigator.getBattery()
        // ============================================================
        console.log('[PROBE] 3. getBattery');
        out.battery = {
          hasGetBattery: 'getBattery' in navigator,
          hasNavProtoGetBattery: typeof Navigator !== 'undefined' && 'getBattery' in Navigator.prototype,
        };
        if (navigator.getBattery) {
          try {
            const b = await navigator.getBattery();
            let brandCheckCharging = null;
            let brandCheckLevel = null;
            if (typeof BatteryManager !== 'undefined' && BatteryManager.prototype) {
              try {
                const d = Object.getOwnPropertyDescriptor(BatteryManager.prototype, 'charging');
                d.get.call(BatteryManager.prototype);
                brandCheckCharging = 'no-throw-on-proto';
              } catch (err) {
                brandCheckCharging = { threw: true, name: err.name, message: err.message };
              }
              try {
                const d = Object.getOwnPropertyDescriptor(BatteryManager.prototype, 'level');
                d.get.call(BatteryManager.prototype);
                brandCheckLevel = 'no-throw-on-proto';
              } catch (err) {
                brandCheckLevel = { threw: true, name: err.name, message: err.message };
              }
            }
            out.battery.result = {
              resolved: true,
              charging: b.charging,
              chargingTime: b.chargingTime,
              dischargingTime: b.dischargingTime,
              level: b.level,
              instanceofBatteryManager: typeof BatteryManager !== 'undefined' && b instanceof BatteryManager,
              ownPropertyNames: Object.getOwnPropertyNames(b),
              brandCheckCharging,
              brandCheckLevel,
            };
          } catch (err) {
            out.battery.result = {
              resolved: false,
              name: err.name,
              message: err.message,
            };
          }
        }

        // ============================================================
        // 4. navigator.permissions.query()
        // ============================================================
        console.log('[PROBE] 4. permissions');
        out.permissions = {
          hasPermissions: 'permissions' in navigator,
        };
        if (navigator.permissions && navigator.permissions.query) {
          const permResults = {};
          for (const name of ['geolocation', 'notifications', 'camera', 'microphone']) {
            try {
              const p = await navigator.permissions.query({ name });
              permResults[name] = {
                state: p.state,
                name: p.name,
                instanceofPermissionStatus: typeof PermissionStatus !== 'undefined' && p instanceof PermissionStatus,
              };
            } catch (err) {
              permResults[name] = { threw: true, name: err.name, message: err.message };
            }
          }
          try {
            await navigator.permissions.query({ name: 'illegal_perm_xyz' });
            permResults.invalidPerm = { threw: false };
          } catch (err) {
            permResults.invalidPerm = { threw: true, name: err.name, message: err.message };
          }
          let brandCheckPerm = null;
          try {
            await Permissions.prototype.query.call(null, { name: 'geolocation' });
            brandCheckPerm = 'no-throw';
          } catch (err) {
            brandCheckPerm = { threw: true, name: err.name, message: err.message };
          }
          out.permissions.queries = permResults;
          out.permissions.notificationPermission = typeof Notification !== 'undefined' ? Notification.permission : null;
          out.permissions.brandCheck = brandCheckPerm;
        }

        // ============================================================
        // 5. HardwareConcurrency, DeviceMemory, & Receiver Brand Checks
        // ============================================================
        console.log('[PROBE] 5. hardware & brandChecks');
        const brandChecks = {};
        if (typeof Navigator !== 'undefined' && Navigator.prototype) {
          for (const key of ['hardwareConcurrency', 'deviceMemory', 'platform', 'maxTouchPoints', 'vendor', 'webdriver', 'pdfViewerEnabled', 'doNotTrack']) {
            const d = Object.getOwnPropertyDescriptor(Navigator.prototype, key);
            if (d && typeof d.get === 'function') {
              try {
                const val = d.get.call(Navigator.prototype);
                brandChecks[key] = { threw: false, returnedValue: val };
              } catch (err) {
                brandChecks[key] = { threw: true, name: err.name, message: err.message };
              }
            } else {
              brandChecks[key] = { noGetterOnProto: true, descriptor: Boolean(d) };
            }
          }
        }

        out.hardware = {
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          brandChecks,
        };

        // ============================================================
        // 6. Identity (maxTouchPoints, platform, vendor, UA)
        // ============================================================
        console.log('[PROBE] 6. identity');
        out.identity = {
          platform: navigator.platform,
          vendor: navigator.vendor,
          maxTouchPoints: navigator.maxTouchPoints,
          userAgent: navigator.userAgent,
          appVersion: navigator.appVersion,
        };

        // ============================================================
        // 7. USB, HID, Bluetooth, Serial
        // ============================================================
        console.log('[PROBE] 7. deviceApis');
        out.deviceApis = {
          hasUsb: 'usb' in navigator,
          hasHid: 'hid' in navigator,
          hasBluetooth: 'bluetooth' in navigator,
          hasSerial: 'serial' in navigator,
          bluetoothAvailability: null,
          usbDevices: null,
          hidDevices: null,
          bluetoothDevices: null,
        };
        if (navigator.bluetooth && typeof navigator.bluetooth.getAvailability === 'function') {
          try {
            out.deviceApis.bluetoothAvailability = await navigator.bluetooth.getAvailability();
          } catch (e) {
            out.deviceApis.bluetoothAvailability = { error: e.message };
          }
        }
        if (navigator.usb && typeof navigator.usb.getDevices === 'function') {
          try {
            const devs = await navigator.usb.getDevices();
            out.deviceApis.usbDevices = devs.length;
          } catch (e) {
            out.deviceApis.usbDevices = { error: e.message };
          }
        }
        if (navigator.hid && typeof navigator.hid.getDevices === 'function') {
          try {
            const devs = await navigator.hid.getDevices();
            out.deviceApis.hidDevices = devs.length;
          } catch (e) {
            out.deviceApis.hidDevices = { error: e.message };
          }
        }
        if (navigator.bluetooth && typeof navigator.bluetooth.getDevices === 'function') {
          try {
            const devs = await navigator.bluetooth.getDevices();
            out.deviceApis.bluetoothDevices = devs.length;
          } catch (e) {
            out.deviceApis.bluetoothDevices = { error: e.message };
          }
        }

        // ============================================================
        // 8. mediaCapabilities & storage.estimate
        // ============================================================
        console.log('[PROBE] 8. mediaCapabilities & storage');
        out.capabilities = {
          mediaCapabilities: null,
          storage: null,
        };
        if (navigator.mediaCapabilities && typeof navigator.mediaCapabilities.decodingInfo === 'function') {
          const decodings = {};
          const testCodecs = [
            { id: 'h264', config: { type: 'file', video: { contentType: 'video/mp4; codecs="avc1.42E01E"', width: 1920, height: 1080, bitrate: 5000000, framerate: 30 } } },
            { id: 'vp9', config: { type: 'file', video: { contentType: 'video/webm; codecs="vp09.00.10.08"', width: 1920, height: 1080, bitrate: 5000000, framerate: 30 } } },
            { id: 'av1', config: { type: 'file', video: { contentType: 'video/mp4; codecs="av01.0.08M.08"', width: 1920, height: 1080, bitrate: 5000000, framerate: 30 } } },
            { id: 'hevc', config: { type: 'file', video: { contentType: 'video/mp4; codecs="hvc1.1.6.L93.B0"', width: 1920, height: 1080, bitrate: 5000000, framerate: 30 } } },
          ];
          for (const t of testCodecs) {
            try {
              const r = await navigator.mediaCapabilities.decodingInfo(t.config);
              decodings[t.id] = { supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient };
            } catch (err) {
              decodings[t.id] = { error: err.message };
            }
          }
          out.capabilities.mediaCapabilities = decodings;
        }
        if (navigator.storage && typeof navigator.storage.estimate === 'function') {
          try {
            const est = await navigator.storage.estimate();
            out.capabilities.storage = {
              quota: est.quota,
              usage: est.usage,
              quotaGB: Math.round((est.quota || 0) / 1e9),
            };
          } catch (err) {
            out.capabilities.storage = { error: err.message };
          }
        }

        // ============================================================
        // 9. screen.orientation & window.orientation
        // ============================================================
        console.log('[PROBE] 9. orientation');
        out.orientation = {
          screenOrientationType: screen.orientation?.type,
          screenOrientationAngle: screen.orientation?.angle,
          hasOnChange: 'onchange' in (screen.orientation || {}),
          windowOrientation: typeof window.orientation !== 'undefined' ? window.orientation : undefined,
          screenWidth: screen.width,
          screenHeight: screen.height,
          isPortraitGeometry: screen.width < screen.height,
          lockMethodResult: null,
        };
        if (screen.orientation && typeof screen.orientation.lock === 'function') {
          try {
            await screen.orientation.lock('landscape');
            out.orientation.lockMethodResult = 'resolved';
          } catch (err) {
            out.orientation.lockMethodResult = { name: err.name, message: err.message };
          }
        }

        // ============================================================
        // 10. pdfViewerEnabled / doNotTrack / globalPrivacyControl
        // ============================================================
        console.log('[PROBE] 10. privacyFlags');
        out.privacyFlags = {
          pdfViewerEnabled: navigator.pdfViewerEnabled,
          doNotTrack: navigator.doNotTrack,
          globalPrivacyControl: navigator.globalPrivacyControl,
          windowDoNotTrack: typeof window.doNotTrack !== 'undefined' ? window.doNotTrack : undefined,
        };

        // ============================================================
        // 11. performance.now vs Date.now clock skew & timeOrigin
        // ============================================================
        console.log('[PROBE] 11. timing');
        const tOrigin = performance.timeOrigin;
        const pNow = performance.now();
        const dNow = Date.now();
        const skew = dNow - (tOrigin + pNow);
        const perfSamples = [];
        for (let i = 0; i < 5; i++) perfSamples.push(performance.now());
        const monotonic = perfSamples.every((v, i, a) => i === 0 || v >= a[i - 1]);
        out.timing = {
          timeOrigin: tOrigin,
          perfNow: pNow,
          dateNow: dNow,
          skewMs: Number(skew.toFixed(3)),
          isSkewReasonable: Math.abs(skew) < 15,
          perfMonotonic: monotonic,
        };

        // ============================================================
        // 12. navigator.webdriver & window.chrome
        // ============================================================
        console.log('[PROBE] 12. webdriver & chrome');
        let ctorCheck = null;
        if (window.chrome && window.chrome.app && typeof window.chrome.app.getIsInstalled === 'function') {
          try {
            new window.chrome.app.getIsInstalled();
            ctorCheck = 'no-throw-on-new';
          } catch (err) {
            ctorCheck = { threw: true, name: err.name, message: err.message };
          }
        }

        out.webdriverAndChrome = {
          webdriver: navigator.webdriver,
          hasWebdriverProperty: 'webdriver' in navigator,
          hasChrome: 'chrome' in window,
          chromeKeys: window.chrome ? Object.getOwnPropertyNames(window.chrome) : [],
          hasChromeApp: Boolean(window.chrome && window.chrome.app),
          chromeAppKeys: window.chrome?.app ? Object.getOwnPropertyNames(window.chrome.app) : [],
          chromeAppIsInstalled: window.chrome?.app?.isInstalled,
          chromeAppCtorCheck: ctorCheck,
          hasChromeRuntime: Boolean(window.chrome && window.chrome.runtime),
          hasChromeLoadTimes: Boolean(window.chrome && window.chrome.loadTimes),
          hasChromeCsi: Boolean(window.chrome && window.chrome.csi),
        };

        // ============================================================
        // Cross-Context Probes
        // ============================================================
        // 1. Same-Origin Iframe
        console.log('[PROBE] Cross-context: 1. same-origin iframe');
        try {
          const ifr = document.createElement('iframe');
          ifr.src = '/iframe-page';
          const ifrPromise = new Promise(r => { ifr.onload = () => r(true); setTimeout(() => r(false), 1500); });
          document.body.appendChild(ifr);
          await ifrPromise;
          const iWin = ifr.contentWindow;
          out.iframeSameOrigin = iWin.probeIframe ? iWin.probeIframe() : {
            platform: iWin.navigator.platform,
            hardwareConcurrency: iWin.navigator.hardwareConcurrency,
            deviceMemory: iWin.navigator.deviceMemory,
            maxTouchPoints: iWin.navigator.maxTouchPoints,
            vendor: iWin.navigator.vendor,
            webdriver: iWin.navigator.webdriver,
            pluginsLength: iWin.navigator.plugins?.length,
            hasChrome: 'chrome' in iWin,
          };
          ifr.remove();
        } catch (e) {
          out.iframeSameOrigin = { error: e.message };
        }

        // 2. Data-URL Iframe (Insecure Context test)
        console.log('[PROBE] Cross-context: 2. data iframe');
        try {
          const dataIfr = document.createElement('iframe');
          const dataHtml = '<!doctype html><script>' +
            'window.parent.postMessage({ ' +
            '  isSecureContext: window.isSecureContext, ' +
            '  deviceMemory: navigator.deviceMemory, ' +
            '  hasDeviceMemoryInNav: "deviceMemory" in navigator, ' +
            '  hardwareConcurrency: navigator.hardwareConcurrency, ' +
            '  platform: navigator.platform, ' +
            '  webdriver: navigator.webdriver ' +
            '}, "*");' +
            '<' + '/script>';
          dataIfr.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(dataHtml);
          const dataPromise = new Promise(r => {
            const handler = (e) => {
              window.removeEventListener('message', handler);
              r(e.data);
            };
            window.addEventListener('message', handler);
            setTimeout(() => r({ timeout: true }), 1500);
          });
          document.body.appendChild(dataIfr);
          out.iframeDataInsecure = await dataPromise;
          dataIfr.remove();
        } catch (e) {
          out.iframeDataInsecure = { error: e.message };
        }

        // 3. Dedicated Worker
        console.log('[PROBE] Cross-context: 3. dedicated worker');
        try {
          const worker = new Worker('/worker.js');
          const wPromise = new Promise(r => {
            worker.onmessage = (e) => r(e.data);
            worker.onerror = (e) => r({ error: e.message });
            setTimeout(() => r({ timeout: true }), 2500);
          });
          worker.postMessage({ cmd: 'audit' });
          out.dedicatedWorker = await wPromise;
          worker.terminate();
        } catch (e) {
          out.dedicatedWorker = { error: e.message };
        }

        // 4. OffscreenCanvas Worker
        console.log('[PROBE] Cross-context: 4. offscreen worker');
        try {
          const oscWorker = new Worker('/offscreencanvas-worker.js');
          const oscPromise = new Promise(r => {
            oscWorker.onmessage = (e) => r(e.data);
            oscWorker.onerror = (e) => r({ error: e.message });
            setTimeout(() => r({ timeout: true }), 2500);
          });
          oscWorker.postMessage({ cmd: 'audit' });
          out.offscreenCanvasWorker = await oscPromise;
          oscWorker.terminate();
        } catch (e) {
          out.offscreenCanvasWorker = { error: e.message };
        }

      } catch (globalErr) {
        console.error('[PROBE ERROR]', globalErr);
        out.globalAuditError = { name: globalErr.name, message: globalErr.message, stack: globalErr.stack };
      } finally {
        console.log('[PROBE] Setting __AUDIT_READY__ = true');
        window.__AUDIT_RESULT__ = out;
        window.__AUDIT_READY__ = true;
      }
    })();
  </script>
</body>
</html>`;
  }
}

async function runSession(profileConfig, isInject, server) {
  server.resetRecorded();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-nav-audit-' + profileConfig.id + '-'));
  const fp = isInject ? buildFingerprint(profileConfig) : null;

  const launchArgs = [dir, '--headless=new', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'];

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

    let primarySessionId = null;

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
        if (targetInfo.type === 'page' && !primarySessionId) {
          primarySessionId = sessionId;
        }
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
            if (waitingForDebugger || targetInfo.waitingForDebugger) {
              await conn.command('Runtime.runIfWaitingForDebugger', {}, { sessionId }).catch(() => {});
            }
          }
        })();
      }

      if (event?.method === 'Runtime.consoleAPICalled') {
        const text = (event.params?.args || []).map(a => a.value || a.description || '').join(' ');
        if (text.startsWith('[PROBE')) {
          console.log(`      [Browser] ${text}`);
        }
      }
    };

    connection = await cdp.connect(wsUrl, { onEvent, timeout: 8000 });

    await connection.command('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    for (let i = 0; i < 30 && !primarySessionId; i += 1) {
      await sleep(100);
    }

    if (!primarySessionId) {
      const targetList = await cdp.targets(port);
      const defaultTarget = targetList.find((t) => t.type === 'page');
      const targetId = defaultTarget ? defaultTarget.id : null;
      if (targetId) {
        const attached = await connection.command('Target.attachToTarget', { targetId, flatten: true });
        primarySessionId = attached?.sessionId;
      }
    }

    const sessionId = primarySessionId;

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
    await connection.command('Runtime.runIfWaitingForDebugger', {}, { sessionId }).catch(() => {});

    const mainUrl = `http://127.0.0.1:${server.port}/main`;
    await connection.command('Page.navigate', { url: mainUrl }, { sessionId });

    let ready = false;
    for (let i = 0; i < 60; i += 1) {
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
      const dataRes = await connection.command('Runtime.evaluate', {
        expression: 'window.__AUDIT_RESULT__',
        returnByValue: true,
      }, { sessionId, timeout: 15000 });
      clientResult = dataRes?.result?.value;
    }
  } catch (err) {
    clientResult = { error: String(err), stack: err.stack };
  } finally {
    if (connection) {
      try { connection.socket?.close(); } catch (_) {}
    }
    stop();
  }

  return {
    client: clientResult,
    headers: JSON.parse(JSON.stringify(server.recordedRequests)),
    fingerprint: fp,
  };
}

(async () => {
  console.log('================================================================');
  console.log('  OpenBrowser Navigator & Device API Surface Adversarial Audit');
  console.log('  Red-Team Adversarial Perspective (12 Core Surfaces)');
  console.log('================================================================\n');

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.error('ERROR: This audit requires the macos-x64 Chromium kernel at', launcher);
    process.exit(1);
  }

  const server = new AuditServer();
  await server.start();
  console.log(`[AuditServer] Running on http://127.0.0.1:${server.port}`);

  const results = {};

  // 1. Session 1: Baseline
  console.log('\n>>> [Session 1/6] Running Native Baseline (Stock Chromium on macOS)...');
  const baselineConfig = { id: 'audit-baseline', name: 'Baseline Stock Kernel' };
  results.baseline = await runSession(baselineConfig, false, server);
  console.log('    Baseline finished. Client error:', results.baseline.client?.error || 'none');

  // 2. Session 2: Windows Desktop Persona
  console.log('\n>>> [Session 2/6] Running Windows Desktop Persona (Windows 10/11 x64, Chrome 148)...');
  const windowsConfig = {
    id: 'audit-windows',
    name: 'Windows Desktop Persona',
    os: 'Windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    kernelVersion: '148.0.7778.165',
    fingerprintLaunchSeed: 'win-audit-seed-77',
    canvas: 'noise',
    webgl: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    webrtc: 'proxy',
    privacy: {
      deviceProfile: 'persona',
      timezone: 'America/New_York',
      languages: ['en-US', 'en'],
      battery: 'noise',
    },
  };
  results.windows = await runSession(windowsConfig, true, server);
  console.log('    Windows session finished. Client error:', results.windows.client?.error || 'none');

  // 3. Session 3: Linux Desktop Persona
  console.log('\n>>> [Session 3/6] Running Linux Desktop Persona (Ubuntu / Linux x86_64, Chrome 148)...');
  const linuxConfig = {
    id: 'audit-linux',
    name: 'Linux Desktop Persona',
    os: 'Linux',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    kernelVersion: '148.0.7778.165',
    fingerprintLaunchSeed: 'linux-audit-seed-88',
    canvas: 'noise',
    webgl: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    webrtc: 'proxy',
    privacy: {
      deviceProfile: 'persona',
      timezone: 'Europe/London',
      languages: ['en-GB', 'en'],
      battery: 'noise',
      dnt: true,
    },
  };
  results.linux = await runSession(linuxConfig, true, server);
  console.log('    Linux session finished. Client error:', results.linux.client?.error || 'none');

  // 4. Session 4: Android Mobile Persona
  console.log('\n>>> [Session 4/6] Running Android Mobile Persona (Pixel 7 Pro, Android 14)...');
  const androidConfig = {
    id: 'audit-android',
    name: 'Android Pixel 7 Pro',
    os: 'Android',
    kernelVersion: '148.0.7778.165',
    fingerprintLaunchSeed: '74',
    canvas: 'noise',
    webgl: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    webrtc: 'proxy',
    privacy: {
      deviceProfile: 'persona',
      timezone: 'America/Chicago',
      languages: ['en-US', 'en'],
      battery: 'noise',
    },
  };
  results.android = await runSession(androidConfig, true, server);
  console.log('    Android session finished. Client error:', results.android.client?.error || 'none');

  // 5. Session 5: iOS Mobile Persona
  console.log('\n>>> [Session 5/6] Running iOS Mobile Persona (iPhone 16 Plus, iOS 18)...');
  const iosConfig = {
    id: 'audit-ios',
    name: 'iPhone 16 Plus',
    os: 'iOS',
    kernelVersion: '148.0.7778.165',
    fingerprintLaunchSeed: '2',
    canvas: 'noise',
    webgl: 'noise',
    audio: 'noise',
    clientRects: 'noise',
    webrtc: 'proxy',
    privacy: {
      deviceProfile: 'persona',
      timezone: 'America/New_York',
      languages: ['en-US', 'en'],
      battery: 'noise',
    },
  };
  results.ios = await runSession(iosConfig, true, server);
  console.log('    iOS session finished. Client error:', results.ios.client?.error || 'none');

  // 6. Session 6: Battery Blocked Persona
  console.log('\n>>> [Session 6/6] Running Battery Blocked Persona (privacy.battery=blocked)...');
  const batteryBlockedConfig = {
    id: 'audit-batt-blocked',
    name: 'Battery Blocked Persona',
    os: 'Windows',
    kernelVersion: '148.0.7778.165',
    fingerprintLaunchSeed: 'batt-blocked-seed',
    privacy: {
      battery: 'blocked',
      deviceProfile: 'persona',
    },
  };
  results.batteryBlocked = await runSession(batteryBlockedConfig, true, server);
  console.log('    Battery Blocked session finished. Client error:', results.batteryBlocked.client?.error || 'none');

  await server.stop();

  // Save Raw Dump
  const rawPath = path.join(reportsDir, 'navigator-device-adversarial-raw.json');
  fs.writeFileSync(rawPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n[Audit] Raw data dumped to: ${rawPath}`);

  console.log('\n[Audit] Completed successfully. Exiting.');
})();
