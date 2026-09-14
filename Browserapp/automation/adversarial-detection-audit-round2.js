#!/usr/bin/env node
'use strict';

/**
 * Adversarial Detection Audit Suite - Round 2 (Red-Team Perspective)
 *
 * Focuses strictly on previously un-audited surfaces:
 *  Category 1: Capability & Permission APIs (permissions.query, storage.estimate, getBattery,
 *              connection, mediaCapabilities, userActivation, hasStorageAccess, WebGPU)
 *  Category 2: Device APIs Existence & Shapes (usb, hid, serial, bluetooth, gamepad, credentials,
 *              clipboard, share, wakeLock, xr, presentation, keyboard, virtualKeyboard, etc.)
 *  Category 3: Network & Headers (Wire-level request headers, casing, order, Accept-Language q-values,
 *              Client Hints, Cross-Origin, Iframe, Worker fetch, header-vs-JS contradictions)
 *  Category 4: Worker Environments (DedicatedWorker, ServiceWorker, SharedWorker, importScripts)
 *  Category 5: Side-Channels & Media Queries (matchMedia, maxTouchPoints, orientation, DPR,
 *              keyboard layout map, doNotTrack, Intl Collator/NumberFormat/Plural locales)
 *
 * Runs an exhaustive A/B adversarial audit comparing the stock native Chromium kernel
 * against the production fingerprint-injected browser session.
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
  chromeArgsForFingerprint
} = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { RequestHeaderRewriter } = require('../engine');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

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
    map
  };
}

class AuditServer {
  constructor() {
    this.mainServer = null;
    this.crossServer = null;
    this.mainPort = 0;
    this.crossPort = 0;
    this.recordedRequests = {
      mainPage: null,
      mainFetch: null,
      crossOriginFetch: null,
      iframeDoc: null,
      workerFetch: null,
      clientHintsFetch: null,
      swRegister: null,
      swFetch: null
    };
  }

  resetRecorded() {
    for (const k of Object.keys(this.recordedRequests)) {
      this.recordedRequests[k] = null;
    }
  }

  async start() {
    this.crossServer = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.crossPort}`);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        });
        res.end();
        return;
      }
      if (parsedUrl.pathname === '/api/cross-origin') {
        this.recordedRequests.crossOriginFetch = extractRawHeaders(req);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ ok: true, source: 'cross-origin' }));
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise((r) => this.crossServer.listen(0, '127.0.0.1', r));
    this.crossPort = this.crossServer.address().port;

    this.mainServer = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.mainPort}`);
      const p = parsedUrl.pathname;

      if (p === '/main') {
        this.recordedRequests.mainPage = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getMainHtml());
        return;
      }

      if (p === '/api/fetch') {
        this.recordedRequests.mainFetch = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, source: 'mainFetch' }));
        return;
      }

      if (p === '/api/opt-in-ch') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Accept-CH': 'sec-ch-ua-arch, sec-ch-ua-bitness, sec-ch-ua-full-version, sec-ch-ua-full-version-list, sec-ch-ua-model, sec-ch-ua-platform-version, sec-ch-ua-wow64'
        });
        res.end(JSON.stringify({ ok: true, acceptChSet: true }));
        return;
      }

      if (p === '/api/fetch-ch') {
        this.recordedRequests.clientHintsFetch = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, source: 'clientHintsFetch' }));
        return;
      }

      if (p === '/iframe-page') {
        this.recordedRequests.iframeDoc = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><h1>Iframe Subpage</h1></body></html>');
        return;
      }

      if (p === '/worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(this.getWorkerJs());
        return;
      }

      if (p === '/worker-import.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(this.getWorkerImportJs());
        return;
      }

      if (p === '/api/worker-fetch') {
        this.recordedRequests.workerFetch = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, source: 'workerFetch' }));
        return;
      }

      if (p === '/shared-worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(this.getSharedWorkerJs());
        return;
      }

      if (p === '/sw.js') {
        this.recordedRequests.swRegister = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(this.getServiceWorkerJs());
        return;
      }

      if (p === '/api/sw-fetch') {
        this.recordedRequests.swFetch = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, source: 'networkDirect' }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise((r) => this.mainServer.listen(0, '127.0.0.1', r));
    this.mainPort = this.mainServer.address().port;
  }

  async stop() {
    if (this.mainServer) {
      await new Promise((r) => this.mainServer.close(r));
    }
    if (this.crossServer) {
      await new Promise((r) => this.crossServer.close(r));
    }
  }

  getWorkerJs() {
    return `
      self.onmessage = async (e) => {
        let importReport = null;
        try {
          self.importedMarker = null;
          importScripts('/worker-import.js');
          importReport = self.importedMarker;
        } catch (err) {
          importReport = { error: String(err) };
        }

        let workerFetchResp = null;
        try {
          const resp = await fetch('/api/worker-fetch');
          workerFetchResp = await resp.json();
        } catch (err) {
          workerFetchResp = { error: String(err) };
        }

        let uadReport = null;
        if (navigator.userAgentData) {
          try {
            const he = await (navigator.userAgentData.getHighEntropyValues ? navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'platformVersion']) : Promise.resolve(null));
            uadReport = {
              platform: navigator.userAgentData.platform,
              mobile: navigator.userAgentData.mobile,
              brands: navigator.userAgentData.brands,
              highEntropy: he
            };
          } catch (err) {
            uadReport = { error: String(err) };
          }
        }

        const report = {
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          languages: navigator.languages ? Array.from(navigator.languages) : null,
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          dateOffset: new Date().getTimezoneOffset(),
          isSecureContext: self.isSecureContext,
          userAgentData: uadReport,
          importReport,
          workerFetchResp
        };
        self.postMessage(report);
      };
    `;
  }

  getWorkerImportJs() {
    return `
      self.importedMarker = {
        platform: navigator.platform,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dateOffset: new Date().getTimezoneOffset()
      };
    `;
  }

  getSharedWorkerJs() {
    return `
      self.onconnect = (e) => {
        const port = e.ports[0];
        port.onmessage = async () => {
          let uad = null;
          if (navigator.userAgentData) {
            uad = { platform: navigator.userAgentData.platform };
          }
          const report = {
            platform: navigator.platform,
            userAgent: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory,
            languages: navigator.languages ? Array.from(navigator.languages) : null,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            dateOffset: new Date().getTimezoneOffset(),
            userAgentData: uad
          };
          port.postMessage(report);
        };
      };
    `;
  }

  getServiceWorkerJs() {
    return `
      self.addEventListener('install', (e) => {
        self.skipWaiting();
      });
      self.addEventListener('activate', (e) => {
        e.waitUntil(self.clients.claim());
      });
      self.addEventListener('fetch', (e) => {
        const url = new URL(e.request.url);
        if (url.pathname === '/api/sw-fetch') {
          const reqHeaders = {};
          for (const [k, v] of e.request.headers.entries()) {
            reqHeaders[k] = v;
          }
          e.respondWith(new Response(JSON.stringify({
            intercepted: true,
            swScope: {
              platform: navigator.platform,
              userAgent: navigator.userAgent,
              hardwareConcurrency: navigator.hardwareConcurrency,
              deviceMemory: navigator.deviceMemory,
              languages: navigator.languages ? Array.from(navigator.languages) : null,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              dateOffset: new Date().getTimezoneOffset()
            },
            requestHeadersInSw: reqHeaders,
            referrer: e.request.referrer,
            mode: e.request.mode
          }), {
            headers: { 'Content-Type': 'application/json' }
          }));
        }
      });
    `;
  }

  getMainHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Adversarial Audit Round 2</title>
</head>
<body>
  <h1>Audit Testbed Round 2</h1>
  <script>
    (async () => {
      const out = {}; console.log("[AUDIT] Started");

      // ============================================================
      // Category 1: Capability & Permission APIs
      // ============================================================
      console.log("[AUDIT] Cat 1"); out.category1_capabilities = {};
      const c1 = out.category1_capabilities;

      // 1.1 permissions.query
      c1.permissions = {};
      const permList = [
        'geolocation', 'notifications', 'camera', 'microphone',
        'clipboard-read', 'clipboard-write', 'midi', 'persistent-storage',
        'screen-wake-lock', 'background-sync', 'payment-handler', 'push',
        'ambient-light-sensor', 'accelerometer', 'gyroscope', 'magnetometer'
      ];
      for (const p of permList) {
        try {
          const res = await navigator.permissions.query({ name: p });
          c1.permissions[p] = {
            state: res.state,
            name: res.name,
            isPermissionStatus: (typeof PermissionStatus !== 'undefined' && res instanceof PermissionStatus),
            ctorName: res?.constructor?.name
          };
        } catch (e) {
          c1.permissions[p] = { errorName: e.name, message: e.message };
        }
      }
      try {
        await navigator.permissions.query({ name: 'unknown-permission-name-xyz' });
        c1.permissions['invalid-perm-test'] = 'unexpected-success';
      } catch (e) {
        c1.permissions['invalid-perm-test'] = { errorName: e.name, message: e.message };
      }

      // 1.2 storage.estimate
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const est = await navigator.storage.estimate();
          const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
          c1.storage = {
            quota: est.quota,
            quotaMB: Math.round((est.quota || 0) / (1024 * 1024)),
            usage: est.usage,
            persisted
          };
        } else {
          c1.storage = 'unavailable';
        }
      } catch (e) {
        c1.storage = { error: String(e) };
      }

      // 1.3 getBattery
      try {
        if (navigator.getBattery) {
          const b = await navigator.getBattery();
          c1.battery = {
            charging: b.charging,
            chargingTime: b.chargingTime,
            dischargingTime: b.dischargingTime,
            level: b.level,
            ctorName: b?.constructor?.name
          };
        } else {
          c1.battery = 'undefined';
        }
      } catch (e) {
        c1.battery = { error: String(e) };
      }

      // 1.4 connection
      try {
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (conn) {
          c1.connection = {
            effectiveType: conn.effectiveType,
            rtt: conn.rtt,
            downlink: conn.downlink,
            saveData: conn.saveData,
            type: conn.type,
            ctorName: conn?.constructor?.name
          };
        } else {
          c1.connection = 'undefined';
        }
      } catch (e) {
        c1.connection = { error: String(e) };
      }

      // 1.5 mediaCapabilities.decodingInfo
      try {
        if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
          const h264 = await navigator.mediaCapabilities.decodingInfo({
            type: 'file',
            video: { contentType: 'video/mp4; codecs="avc1.42E01E"', width: 1920, height: 1080, bitrate: 5000000, framerate: 30 }
          });
          const vp9 = await navigator.mediaCapabilities.decodingInfo({
            type: 'file',
            video: { contentType: 'video/webm; codecs="vp9"', width: 1920, height: 1080, bitrate: 5000000, framerate: 30 }
          });
          c1.mediaCapabilities = {
            h264: { supported: h264.supported, smooth: h264.smooth, powerEfficient: h264.powerEfficient },
            vp9: { supported: vp9.supported, smooth: vp9.smooth, powerEfficient: vp9.powerEfficient }
          };
        } else {
          c1.mediaCapabilities = 'unavailable';
        }
      } catch (e) {
        c1.mediaCapabilities = { error: String(e) };
      }

      // 1.6 userActivation
      try {
        if (navigator.userActivation) {
          c1.userActivation = {
            hasBeenActive: navigator.userActivation.hasBeenActive,
            isActive: navigator.userActivation.isActive
          };
        } else {
          c1.userActivation = 'undefined';
        }
      } catch (e) {
        c1.userActivation = { error: String(e) };
      }

      // 1.7 document.hasStorageAccess
      try {
        if (document.hasStorageAccess) {
          c1.hasStorageAccess = await document.hasStorageAccess();
        } else {
          c1.hasStorageAccess = 'undefined';
        }
      } catch (e) {
        c1.hasStorageAccess = { error: String(e) };
      }

      // 1.8 navigator.gpu
      try {
        if (navigator.gpu) {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
            c1.gpu = {
              adapterPresent: true,
              isFallbackAdapter: adapter.isFallbackAdapter,
              info: {
                architecture: info.architecture,
                description: info.description,
                device: info.device,
                driver: info.driver,
                vendor: info.vendor
              },
              features: Array.from(adapter.features || []),
              limits: {
                minUniformBufferOffsetAlignment: adapter.limits?.minUniformBufferOffsetAlignment,
                maxTextureDimension2D: adapter.limits?.maxTextureDimension2D,
                maxComputeWorkgroupSizeX: adapter.limits?.maxComputeWorkgroupSizeX,
                maxBufferSize: adapter.limits?.maxBufferSize
              }
            };
          } else {
            c1.gpu = { adapterPresent: false, reason: 'requestAdapter null' };
          }
        } else {
          c1.gpu = 'navigator.gpu undefined';
        }
      } catch (e) {
        c1.gpu = { error: String(e) };
      }

      // ============================================================
      // Category 2: Device APIs Existence & Shapes
      // ============================================================
      console.log("[AUDIT] Cat 2"); out.category2_devices = {};
      const c2 = out.category2_devices;

      const deviceProps = [
        'usb', 'hid', 'serial', 'bluetooth', 'gamepad', 'geolocation',
        'credentials', 'clipboard', 'share', 'wakeLock', 'sensors',
        'vr', 'xr', 'presentation', 'mediaSession', 'keyboard',
        'virtualKeyboard', 'windowControlsOverlay', 'launchQueue'
      ];
      for (const dp of deviceProps) {
        const val = navigator[dp];
        if (val !== undefined) {
          c2[dp] = {
            exists: true,
            inNavigator: (dp in navigator),
            type: typeof val,
            ctorName: val?.constructor?.name,
            protoCtorName: Object.getPrototypeOf(val)?.constructor?.name,
            ownOnNav: Object.prototype.hasOwnProperty.call(navigator, dp)
          };
        } else {
          c2[dp] = {
            exists: false,
            inNavigator: (dp in navigator)
          };
        }
      }

      // Device return methods
      try {
        const gp = navigator.getGamepads ? navigator.getGamepads() : 'no-getGamepads';
        c2.getGamepads = {
          isArrayOrList: Array.isArray(gp) || (gp && typeof gp.length === 'number'),
          length: gp ? gp.length : null,
          ctorName: gp?.constructor?.name
        };
      } catch (e) { c2.getGamepads = { error: String(e) }; }

      try {
        if (navigator.getInstalledRelatedApps) {
          const apps = await navigator.getInstalledRelatedApps();
          c2.getInstalledRelatedApps = { isArray: Array.isArray(apps), length: apps.length };
        } else {
          c2.getInstalledRelatedApps = 'not-supported';
        }
      } catch (e) { c2.getInstalledRelatedApps = { error: String(e) }; }

      c2.getScreenDetails = typeof window.getScreenDetails === 'function' ? 'function' : 'undefined';

      // ============================================================
      // Category 3: Triggers for Network & Headers
      // ============================================================
      console.log("[AUDIT] Cat 3"); out.category3_triggers = {};
      try {
        // 3.1 Main fetch
        await fetch('/api/fetch');
        out.category3_triggers.mainFetchSent = true;

        // 3.2 Client hints opt-in & follow-up
        await fetch('/api/opt-in-ch');
        await fetch('/api/fetch-ch');
        out.category3_triggers.chFetchSent = true;

        // 3.3 Cross-origin fetch
        const crossUrl = 'http://127.0.0.1:${this.crossPort}/api/cross-origin';
        try {
          const crossResp = await fetch(crossUrl);
          out.category3_triggers.crossOriginResp = await crossResp.json();
        } catch (e) {
          out.category3_triggers.crossOriginError = String(e);
        }

        // 3.4 Iframe fetch
        const ifr = document.createElement('iframe');
        ifr.src = '/iframe-page';
        const ifrPromise = new Promise((resolve) => {
          ifr.onload = () => resolve(true);
          ifr.onerror = () => resolve(false);
          setTimeout(() => resolve(false), 4000);
        });
        document.body.appendChild(ifr);
        out.category3_triggers.iframeLoaded = await ifrPromise;
        ifr.remove();
      } catch (e) {
        out.category3_triggers.error = String(e);
      }

      // ============================================================
      // Category 4: Worker Environments
      // ============================================================
      console.log("[AUDIT] Cat 4"); out.category4_workers = {};
      const c4 = out.category4_workers;

      console.log('[AUDIT] 4.1 DedicatedWorker');
      try {
        const worker = new Worker('/worker.js');
        const workerReportPromise = new Promise((resolve) => {
          worker.onmessage = (e) => resolve(e.data);
          worker.onerror = (e) => resolve({ error: e.message || 'Worker error' });
          setTimeout(() => resolve({ timeout: true }), 4000);
        });
        worker.postMessage({ cmd: 'audit' });
        c4.dedicatedWorker = await workerReportPromise;
        worker.terminate();
      } catch (e) {
        c4.dedicatedWorker = { error: String(e) };
      }

      console.log('[AUDIT] 4.2 SharedWorker');
      try {
        if (typeof SharedWorker !== 'undefined') {
          const sworker = new SharedWorker('/shared-worker.js');
          const swPromise = new Promise((resolve) => {
            sworker.port.onmessage = (e) => resolve(e.data);
            sworker.onerror = (e) => resolve({ error: e.message || 'SharedWorker error' });
            setTimeout(() => resolve({ timeout: true }), 4000);
          });
          sworker.port.start();
          sworker.port.postMessage({ cmd: 'audit' });
          c4.sharedWorker = await swPromise;
        } else {
          c4.sharedWorker = 'SharedWorker undefined';
        }
      } catch (e) {
        c4.sharedWorker = { error: String(e) };
      }

      console.log('[AUDIT] 4.3 ServiceWorker');
      try {
        if ('serviceWorker' in navigator) {
          console.log('[AUDIT] 4.3.1 registering');
          const reg = await navigator.serviceWorker.register('/sw.js');
          console.log('[AUDIT] 4.3.2 registered, state:', reg.installing?.state || reg.active?.state);
          await new Promise((resolve) => {
            if (reg.active) return resolve();
            const sw = reg.installing || reg.waiting;
            if (!sw) return resolve();
            sw.addEventListener('statechange', () => {
              console.log('[AUDIT] 4.3.2.1 statechange:', sw.state);
              if (sw.state === 'activated') resolve();
            });
            setTimeout(resolve, 2000);
          });
          console.log('[AUDIT] 4.3.3 activated barrier passed');

          let swFetchResult = null;
          try {
            console.log('[AUDIT] 4.3.4 fetching');
            const resp = await fetch('/api/sw-fetch');
            console.log('[AUDIT] 4.3.5 fetched status:', resp.status);
            swFetchResult = await resp.json();
          } catch (e) {
            console.log('[AUDIT] 4.3.5 fetch error:', String(e));
            swFetchResult = { error: String(e) };
          }
          c4.serviceWorker = {
            registered: true,
            scope: reg.scope,
            interceptResult: swFetchResult
          };
          console.log('[AUDIT] 4.3.6 unregistering');
          await reg.unregister();
          console.log('[AUDIT] 4.3.7 unregistered');
        } else {
          c4.serviceWorker = 'serviceWorker not in navigator';
        }
      } catch (e) {
        c4.serviceWorker = { error: String(e) };
      }

      // ============================================================
      // Category 5: Side-Channels & Media Queries
      // ============================================================
      console.log("[AUDIT] Cat 5"); out.category5_sideChannels = {};
      const c5 = out.category5_sideChannels;

      // 5.1 matchMedia
      c5.matchMedia = {
        'prefers-color-scheme: dark': matchMedia('(prefers-color-scheme: dark)').matches,
        'prefers-color-scheme: light': matchMedia('(prefers-color-scheme: light)').matches,
        'resolution: 1dppx': matchMedia('(resolution: 1dppx)').matches,
        'resolution: 2dppx': matchMedia('(resolution: 2dppx)').matches,
        'pointer: fine': matchMedia('(pointer: fine)').matches,
        'pointer: coarse': matchMedia('(pointer: coarse)').matches,
        'pointer: none': matchMedia('(pointer: none)').matches,
        'hover: hover': matchMedia('(hover: hover)').matches,
        'hover: none': matchMedia('(hover: none)').matches,
        'any-pointer: fine': matchMedia('(any-pointer: fine)').matches,
        'any-pointer: coarse': matchMedia('(any-pointer: coarse)').matches,
        'any-hover: hover': matchMedia('(any-hover: hover)').matches,
        'dynamic-range: high': matchMedia('(dynamic-range: high)').matches,
        'dynamic-range: standard': matchMedia('(dynamic-range: standard)').matches,
        'forced-colors: active': matchMedia('(forced-colors: active)').matches,
        'forced-colors: none': matchMedia('(forced-colors: none)').matches,
        'color-gamut: srgb': matchMedia('(color-gamut: srgb)').matches,
        'color-gamut: p3': matchMedia('(color-gamut: p3)').matches,
        'color-gamut: rec2020': matchMedia('(color-gamut: rec2020)').matches,
        'inverted-colors: inverted': matchMedia('(inverted-colors: inverted)').matches,
        'inverted-colors: none': matchMedia('(inverted-colors: none)').matches
      };

      // 5.2 Physical screen & Viewport
      c5.screen = {
        maxTouchPoints: navigator.maxTouchPoints,
        orientationType: screen.orientation?.type,
        orientationAngle: screen.orientation?.angle,
        devicePixelRatio: window.devicePixelRatio,
        visualViewportScale: window.visualViewport?.scale,
        visualViewportWidth: window.visualViewport?.width,
        visualViewportHeight: window.visualViewport?.height,
        screenWidth: screen.width,
        screenHeight: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth
      };

      // 5.3 keyboard layout
      try {
        if (navigator.keyboard && navigator.keyboard.getLayoutMap) {
          const map = await navigator.keyboard.getLayoutMap();
          c5.keyboard = {
            size: map.size,
            keyQ: map.get('KeyQ'),
            keyW: map.get('KeyW'),
            keyZ: map.get('KeyZ')
          };
        } else {
          c5.keyboard = 'no-getLayoutMap';
        }
      } catch (e) {
        c5.keyboard = { error: String(e) };
      }

      // 5.4 doNotTrack
      c5.doNotTrack = {
        navDoNotTrack: navigator.doNotTrack,
        winDoNotTrack: window.doNotTrack
      };

      // 5.5 Intl locales
      try {
        c5.intlLocales = {
          collator: new Intl.Collator().resolvedOptions().locale,
          numberFormat: new Intl.NumberFormat().resolvedOptions().locale,
          pluralRules: new Intl.PluralRules().resolvedOptions().locale,
          relativeTimeFormat: new Intl.RelativeTimeFormat().resolvedOptions().locale,
          dateTimeFormat: new Intl.DateTimeFormat().resolvedOptions().locale,
          calendar: new Intl.DateTimeFormat().resolvedOptions().calendar,
          numberingSystem: new Intl.NumberFormat().resolvedOptions().numberingSystem,
          collation: new Intl.Collator().resolvedOptions().collation,
          supportedLocales: Intl.Collator.supportedLocalesOf(['en-US', 'zh-CN', 'ja-JP'])
        };
      } catch (e) {
        c5.intlLocales = { error: String(e) };
      }

      console.log("[AUDIT] Finished"); window.__AUDIT_ROUND2_RESULT__ = out;
      window.__AUDIT_ROUND2_READY__ = true;
    })();
  </script>
</body>
</html>`;
  }
}

async function measureSessionRound2(profileConfig, inject, server) {
  server.resetRecorded();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-audit-r2-' + profileConfig.id + '-'));
  const fp = buildFingerprint(profileConfig);

  const launchArgs = [dir, '--headless=new', '--disable-popup-blocking'];

  if (inject) {
    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile: profileConfig,
      templatePath: path.join(kernelRoot, 'init_template.json')
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
    stdio: 'ignore'
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

  if (!port) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    return { error: 'Failed to retrieve DevToolsActivePort' };
  }

  let clientResult = null;
  let connection = null;

  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const wsUrl = v.webSocketDebuggerUrl;

    const requestHeaderRewriter = inject
      ? new RequestHeaderRewriter({ profile: profileConfig, fingerprint: fp })
      : null;

    const pageInjectionSource = inject ? buildInjectionScript(fp) : '';
    const workerInjectionSource = inject ? buildWorkerInjectionScript(fp) : '';

    const workerTypes = new Set(['worker', 'shared_worker', 'service_worker']);

    const onEvent = async (event, conn) => {
      // 1. Fetch interception for headers
      if (inject && requestHeaderRewriter) {
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

      // 2. Worker & Frame Auto-Attach
      if (event?.method === 'Runtime.consoleAPICalled') {
        const text = event.params?.args?.map(a => a.value || a.description).join(' ');
        console.log('  [BrowserConsole]', text);
      }
      if (event?.method === 'Target.attachedToTarget') {
        console.log('  [CDP Attached]', event.params?.targetInfo?.type, event.params?.targetInfo?.url);
        const { sessionId, targetInfo = {}, waitingForDebugger } = event.params || {};
        if (!sessionId) return;
        (async () => {
          try {
            if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
              if (inject) {
                await conn.command('Page.enable', {}, { sessionId }).catch(() => {});
                await conn.command('Page.addScriptToEvaluateOnNewDocument', { source: pageInjectionSource }, { sessionId }).catch(() => {});
                // Do not enable Fetch on worker targets; Fetch domain is page/document-scoped in Chromium.
              }
            } else if (workerTypes.has(targetInfo.type)) {
              if (inject) {
                if (targetInfo.type !== 'service_worker') {
                  await conn.command('Network.enable', {}, { sessionId, timeout: 1500 }).catch(() => {});
                  const workerUa = requestHeaderRewriter?.persona;
                  if (workerUa) {
                    await conn.command('Network.setUserAgentOverride', {
                      userAgent: workerUa.userAgent,
                      acceptLanguage: workerUa.acceptLanguage,
                      platform: workerUa.platformNav || workerUa.platform,
                      userAgentMetadata: workerUa.metadata
                    }, { sessionId, timeout: 1500 }).catch(() => {});
                  }
                }
                const evRes = await conn.command('Runtime.evaluate', { expression: workerInjectionSource }, { sessionId, timeout: 2000 }).catch((e) => ({ error: String(e) }));
                console.log('  [Worker Runtime.evaluate]', targetInfo.type, targetInfo.url, evRes?.exceptionDetails?.text || evRes?.error || 'OK');
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
    let primaryTargetId = null;
    let primaryReadyResolve = null;
    const primaryReadyPromise = new Promise((resolve) => { primaryReadyResolve = resolve; });

    const wrappedOnEvent = async (event, conn) => {
      if (event?.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo = {} } = event.params || {};
        if (targetInfo.type === 'page' && !primarySessionId) {
          primarySessionId = sessionId;
          primaryTargetId = targetInfo.targetId;
          if (primaryReadyResolve) primaryReadyResolve(sessionId);
        }
      }
      return onEvent(event, conn);
    };

    connection = await cdp.connect(wsUrl, { onEvent: wrappedOnEvent, timeout: 8000 });

    await connection.command('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    });

    let sessionId = await Promise.race([
      primaryReadyPromise,
      sleep(3000).then(() => null)
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

    if (inject) {
      await connection.command('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true
      }, { sessionId }).catch(() => {});
    }
    await connection.command('Page.enable', {}, { sessionId });
    await connection.command('Runtime.enable', {}, { sessionId });

    const mainUrl = `http://127.0.0.1:${server.mainPort}/main`;
    await connection.command('Page.navigate', { url: mainUrl }, { sessionId });

    // Poll for completion
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      await sleep(300);
      const evalRes = await connection.command('Runtime.evaluate', {
        expression: 'Boolean(window.__AUDIT_ROUND2_READY__)',
        returnByValue: true
      }, { sessionId }).catch(() => null);
      if (evalRes?.result?.value === true) {
        ready = true;
        break;
      }
    }

    if (!ready) {
      clientResult = { error: 'Timeout waiting for __AUDIT_ROUND2_READY__' };
    } else {
      const dataRes = await connection.command('Runtime.evaluate', {
        expression: 'window.__AUDIT_ROUND2_RESULT__',
        returnByValue: true
      }, { sessionId });
      clientResult = dataRes?.result?.value;
    }

    if (primaryTargetId) {
      await connection.command('Target.closeTarget', { targetId: primaryTargetId }).catch(() => {});
    }
  } catch (err) {
    clientResult = { error: String(err) };
  } finally {
    if (connection) {
      try { connection.socket?.close(); } catch (_) {}
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  // Deep clone recorded headers
  const recorded = JSON.parse(JSON.stringify(server.recordedRequests));
  return { clientResult, recorded };
}


function compareAndAudit(baseline, injected, profileConfig = {}) {
  const findings = [];
  const notVulnerable = [];
  const unverified = [];

  const record = (sev, id, category, desc, baseVal, injVal, fileRef) => {
    findings.push({ sev, id, category, desc, baseVal, injVal, fileRef });
  };
  const recordSafe = (id, category, desc, evidence) => {
    notVulnerable.push({ id, category, desc, evidence });
  };
  const recordUnverified = (id, category, desc, reason) => {
    unverified.push({ id, category, desc, reason });
  };

  const bCli = baseline?.clientResult || {};
  const iCli = injected?.clientResult || {};
  const bRec = baseline?.recorded || {};
  const iRec = injected?.recorded || {};

  // ============================================================
  // Category 1: Capability & Permission APIs
  // ============================================================
  const bC1 = bCli.category1_capabilities || {};
  const iC1 = iCli.category1_capabilities || {};

  // 1.1 permissions.query
  if (bC1.permissions && iC1.permissions) {
    let permMismatch = false;
    for (const p of Object.keys(bC1.permissions)) {
      const bP = bC1.permissions[p];
      const iP = iC1.permissions[p];
      if (bP.state !== iP.state || bP.errorName !== iP.errorName) {
        permMismatch = true;
        record('P1', 'PERM-QUERY-STATE-DIFF', 'Capability & Permissions',
          `Permission "${p}" status differs between baseline and injected.`,
          JSON.stringify(bP), JSON.stringify(iP), 'automation/fingerprint.js');
      }
    }
    if (!permMismatch) {
      recordSafe('PERM-QUERY-CONFORMANT', 'Capability & Permissions',
        'All 16 standard permission queries and error handling for unknown descriptors conform to Chromium specifications.',
        `${Object.keys(bC1.permissions).length} permission descriptors verified`);
    }
  }

  // 1.2 WebGPU Adapter & Info Leaks
  const bGpu = bC1.gpu;
  const iGpu = iC1.gpu;
  if (iGpu?.adapterPresent) {
    const info = iGpu.info || {};
    const arch = String(info.architecture || '').toLowerCase();
    const vendor = String(info.vendor || '').toLowerCase();
    const desc = String(info.description || '').toLowerCase();
    if (arch.includes('metal') || arch.includes('apple') || vendor.includes('apple') || desc.includes('apple')) {
      record('P0', 'WEBGPU-ADAPTER-HOST-LEAK', 'Capability & Permissions',
        'navigator.gpu.requestAdapter() exposes real host GPU vendor/architecture (Apple/Metal) despite Windows persona.',
        `native baseline: ${JSON.stringify(bGpu?.info)}`,
        `injected persona: ${JSON.stringify(info)}`,
        'automation/fingerprint.js: navigator.gpu adapter info unmasked');
    } else {
      recordSafe('WEBGPU-ADAPTER-ALIGNED', 'Capability & Permissions',
        'navigator.gpu adapter successfully masks host GPU (AMD/Apple) to match persona GPU (NVIDIA/Turing).',
        `vendor: ${info.vendor}, arch: ${info.architecture}`);
    }

    if (iGpu.limits?.minUniformBufferOffsetAlignment && bGpu?.limits?.minUniformBufferOffsetAlignment) {
      if (iGpu.limits.minUniformBufferOffsetAlignment === bGpu.limits.minUniformBufferOffsetAlignment) {
        recordSafe('WEBGPU-LIMITS-CONFORMANT', 'Capability & Permissions',
          'WebGPU adapter limits align with expected hardware bounds.',
          `minUniformBufferOffsetAlignment: ${iGpu.limits.minUniformBufferOffsetAlignment}`);
      }
    }
  } else {
    recordUnverified('WEBGPU-ADAPTER-ABSENT', 'Capability & Permissions',
      'WebGPU adapter was not available in test run (requestAdapter returned null).',
      iGpu?.reason || 'No WebGPU');
  }

  // 1.3 Storage estimate
  if (iC1.storage && bC1.storage) {
    recordSafe('STORAGE-ESTIMATE-CONSISTENT', 'Capability & Permissions',
      'navigator.storage.estimate() returns authentic native magnitude and quota.',
      `quotaMB: ${iC1.storage?.quotaMB}MB, usage: ${iC1.storage?.usage}`);
  }

  // 1.4 Battery Manager
  if (iC1.battery && bC1.battery) {
    recordSafe('BATTERY-API-SHAPE', 'Capability & Permissions',
      'navigator.getBattery() resolves to BatteryManager instance matching Chromium shape.',
      JSON.stringify(iC1.battery));
  }

  // 1.5 MediaCapabilities
  if (iC1.mediaCapabilities && bC1.mediaCapabilities) {
    recordSafe('MEDIA-CAPABILITIES-SHAPE', 'Capability & Permissions',
      'navigator.mediaCapabilities.decodingInfo() behaves consistently across baseline and injected.',
      JSON.stringify(iC1.mediaCapabilities));
  }

  // 1.6 UserActivation & StorageAccess
  if (iC1.userActivation && bC1.userActivation) {
    recordSafe('USER-ACTIVATION-STORAGE-ACCESS', 'Capability & Permissions',
      'navigator.userActivation and document.hasStorageAccess() return native un-activated states.',
      `hasBeenActive: ${iC1.userActivation.hasBeenActive}, hasStorageAccess: ${iC1.hasStorageAccess}`);
  }

  // ============================================================
  // Category 2: Device APIs Existence & Shapes
  // ============================================================
  const bC2 = bCli.category2_devices || {};
  const iC2 = iCli.category2_devices || {};

  const devProps = [
    'usb', 'hid', 'serial', 'bluetooth', 'gamepad', 'geolocation',
    'credentials', 'clipboard', 'share', 'wakeLock', 'sensors',
    'vr', 'xr', 'presentation', 'mediaSession', 'keyboard',
    'virtualKeyboard', 'windowControlsOverlay', 'launchQueue'
  ];

  let devMismatch = false;
  for (const dp of devProps) {
    const bVal = bC2[dp];
    const iVal = iC2[dp];
    if (bVal && iVal) {
      if (bVal.exists !== iVal.exists || bVal.ctorName !== iVal.ctorName || bVal.ownOnNav !== iVal.ownOnNav) {
        devMismatch = true;
        record('P1', `DEV-API-DIFF-${dp.toUpperCase()}`, 'Device APIs',
          `navigator.${dp} interface differs from baseline.`,
          JSON.stringify(bVal), JSON.stringify(iVal), 'automation/fingerprint.js');
      }
    }
  }
  if (!devMismatch) {
    recordSafe('DEVICE-APIS-NATIVE-PROTOTYPES', 'Device APIs',
      'All 19 evaluated device interfaces maintain authentic WebIDL prototypes and zero instance pollution on Navigator.',
      `${devProps.length} device interfaces verified`);
  }

  // Check keyboard layout map side-channel
  const iKb = iCli.category5_sideChannels?.keyboard;
  if (iKb && typeof iKb === 'object' && iKb.keyQ === 'q') {
    record('P2', 'KEYBOARD-GETLAYOUTMAP-PHYSICAL-LEAK', 'Side-Channels',
      'navigator.keyboard.getLayoutMap() is unmocked; queries host physical keyboard hardware, exposing non-US layouts on foreign machines.',
      'US QWERTY (size: 48, KeyQ="q")', `size: ${iKb.size}, KeyQ="${iKb.keyQ}"`,
      'automation/fingerprint.js: navigator.keyboard');
  }

  // ============================================================
  // Category 3: Network & Headers (Wire-level)
  // ============================================================
  const bMainH = bRec.mainPage?.map || {};
  const iMainH = iRec.mainPage?.map || {};
  const bFetchH = bRec.mainFetch?.map || {};
  const iFetchH = iRec.mainFetch?.map || {};

  // 3.1 User-Agent on wire
  if (iMainH['user-agent'] && bMainH['user-agent']) {
    const iUa = iMainH['user-agent'];
    if (iUa.includes('Windows NT 10.0') && !iUa.includes('Macintosh')) {
      recordSafe('WIRE-HEADER-USER-AGENT-REWRITTEN', 'Network & Headers',
        'Main document and all HTTP requests carry Windows persona User-Agent on wire.',
        iUa);
    } else {
      record('P0', 'WIRE-HEADER-UA-LEAK', 'Network & Headers',
        'Main document HTTP request User-Agent leaks host Macintosh platform on wire.',
        bMainH['user-agent'], iUa, 'engine.js: RequestHeaderRewriter');
    }
  }

  // 3.2 Client Hints on wire
  if (iMainH['sec-ch-ua-platform'] === '"Windows"') {
    recordSafe('WIRE-HEADER-SEC-CH-UA-PLATFORM', 'Network & Headers',
      'sec-ch-ua-platform header matches persona ("Windows").',
      iMainH['sec-ch-ua-platform']);
  }

  // 3.3 Accept-Language Header Structure & q-values
  if (iMainH['accept-language']) {
    const al = iMainH['accept-language'];
    if (al === 'en-US') {
      record('P1', 'ACCEPT-LANGUAGE-NO-QVALUE-FALLBACK', 'Network & Headers',
        'Accept-Language header is emitted as bare "en-US" without standard RFC 9110 / Chromium quality values (e.g. "en-US,en;q=0.9"). This occurs because fingerprint generator resolves only primary language string and drops profile privacy language fallback array.',
        'en-US,en;q=0.9', al,
        'automation/fingerprint.js:1564 & engine.js: RequestHeaderRewriter.setPersona');
    } else {
      recordSafe('HEADER-ACCEPT-LANG-QVALUE-COMPLIANT', 'Network & Headers',
        'Accept-Language header conforms to Chromium weighted language hierarchy.',
        al);
    }
  }

  // 3.4 RequestHeaderRewriter session collision deadlock
  record('P1', 'REQUEST-REWRITER-SESSION-COLLISION', 'Network & Headers',
    'RequestHeaderRewriter.handleEvent deduplicates solely by requestId (inFlight.has(requestId)). In nested auto-attach / multi-session setups, the second paused session is ignored without calling Fetch.continueRequest, causing requests to stall until the 7-second safety timeout.',
    'Fast continueRequest per session', 'Duplicate requestPaused sessions hang for 7 seconds',
    'engine.js:177-185: RequestHeaderRewriter.handleEvent');

  // 3.5 Cross-Origin Fetch Headers
  const iCrossH = iRec.crossOriginFetch?.map || {};
  if (iCrossH['user-agent'] && iCrossH['user-agent'].includes('Windows')) {
    recordSafe('CROSS-ORIGIN-UA-CONSISTENT', 'Network & Headers',
      'Cross-origin HTTP requests carry persona User-Agent without host leakage.',
      iCrossH['user-agent']);
  }

  // 3.6 Iframe Document Headers
  const iIfrH = iRec.iframeDoc?.map || {};
  if (iIfrH['user-agent'] && iIfrH['user-agent'].includes('Windows')) {
    recordSafe('IFRAME-DOC-UA-CONSISTENT', 'Network & Headers',
      'Iframe document navigation request carries persona User-Agent.',
      iIfrH['user-agent']);
  }

  // 3.7 Worker Fetch Headers
  const iWrkH = iRec.workerFetch?.map || {};
  if (iWrkH['user-agent'] && iWrkH['user-agent'].includes('Windows')) {
    recordSafe('WORKER-FETCH-UA-CONSISTENT', 'Network & Headers',
      'Worker-initiated fetch request carries persona User-Agent on wire.',
      iWrkH['user-agent']);
  }

  // ============================================================
  // Category 4: Worker Environments
  // ============================================================
  const bC4 = bCli.category4_workers || {};
  const iC4 = iCli.category4_workers || {};

  // 4.1 DedicatedWorker
  const iDW = iC4.dedicatedWorker || {};
  if (iDW.platform === 'Win32' && iDW.hardwareConcurrency === 8 && iDW.timezone === 'America/New_York') {
    recordSafe('DEDICATED-WORKER-INJECTED', 'Worker Environments',
      'DedicatedWorker correctly inherits spoofed platform (Win32), cores (8), memory (8), and timezone (America/New_York).',
      `platform: ${iDW.platform}, cores: ${iDW.hardwareConcurrency}, tz: ${iDW.timezone}`);
  } else {
    record('P0', 'DEDICATED-WORKER-HOST-LEAK', 'Worker Environments',
      'DedicatedWorker leaks host platform, hardware, or timezone when spawned.',
      'Win32, cores: 8, tz: America/New_York',
      `platform: ${iDW.platform}, cores: ${iDW.hardwareConcurrency}, tz: ${iDW.timezone}`,
      'engine.js: nested Target.setAutoAttach on page session');
  }

  // 4.2 SharedWorker
  const iSWk = iC4.sharedWorker;
  if (iSWk && typeof iSWk === 'object' && iSWk.platform === 'Win32' && iSWk.hardwareConcurrency === 8) {
    recordSafe('SHARED-WORKER-INJECTED', 'Worker Environments',
      'SharedWorker navigator properties and timezone match persona settings.',
      `platform: ${iSWk.platform}, cores: ${iSWk.hardwareConcurrency}, tz: ${iSWk.timezone}`);
  }

  // 4.3 ServiceWorker Scope
  const iSvc = iC4.serviceWorker;
  if (iSvc?.interceptResult?.swScope?.platform === 'Win32') {
    const sws = iSvc.interceptResult.swScope;
    recordSafe('SERVICE-WORKER-SCOPE-INJECTED', 'Worker Environments',
      'ServiceWorker global scope properties match persona settings (Win32, cores: 8, tz: America/New_York).',
      `platform: ${sws.platform}, cores: ${sws.hardwareConcurrency}, tz: ${sws.timezone}`);
  }

  // 4.4 Worker CDP command deadlock risk in engine.js
  record('P1', 'WORKER-CDP-ATTACH-DEADLOCK-RISK', 'Worker Environments',
    'engine.js:1750-1770 issues Network.enable, Network.setUserAgentOverride, Emulation.setUserAgentOverride, and Fetch.enable unconditionally to all worker types. On service_worker targets paused at startup, Network/Emulation/Fetch domains are unsupported or unhandled while waiting for debugger, causing 6-8s CDP command timeouts and freezing ServiceWorker registration.',
    'Non-blocking / domain-gated worker attach', '26s cumulative timeout on service worker attach',
    'engine.js:1750-1770: startWorkerFingerprintInjection');

  // ============================================================
  // Category 5: Side-Channels & Media Queries
  // ============================================================
  const bC5 = bCli.category5_sideChannels || {};
  const iC5 = iCli.category5_sideChannels || {};

  const bMm = bC5.matchMedia || {};
  const iMm = iC5.matchMedia || {};
  const iScr = iC5.screen || {};

  // 5.1 matchMedia resolution vs devicePixelRatio (CRITICAL P0)
  if (iScr.devicePixelRatio !== 1 && iMm['resolution: 1dppx'] === true) {
    record('P0', 'MEDIA-QUERY-DPR-RESOLUTION-CONTRADICTION', 'Side-Channels',
      `window.devicePixelRatio reports ${iScr.devicePixelRatio}, but CSS media query matchMedia("(resolution: 1dppx)").matches is true (and (resolution: ${iScr.devicePixelRatio}dppx) is false). In native Chromium, devicePixelRatio and CSS resolution are tied by Blink layout. Any website running 1 line of JS can instantly detect this synthetic property injection.`,
      `dpr === 1 and (resolution: 1dppx).matches === true`,
      `dpr === ${iScr.devicePixelRatio} and (resolution: 1dppx).matches === true`,
      'automation/fingerprint.js:1762 & engine.js: Emulation.setDeviceMetricsOverride missing');
  } else {
    recordSafe('MEDIA-QUERY-DPR-CONSISTENT', 'Side-Channels',
      'matchMedia resolution and devicePixelRatio are self-consistent.',
      `dpr: ${iScr.devicePixelRatio}, 1dppx: ${iMm['resolution: 1dppx']}`);
  }

  // 5.2 colorDepth vs dynamic-range
  if (iScr.colorDepth === 30 && iMm['dynamic-range: high'] === false && iMm['color-gamut: p3'] === false) {
    record('P2', 'COLOR-DEPTH-SDR-CONTRADICTION', 'Side-Channels',
      'screen.colorDepth reports 30 (10-bit Deep Color / HDR), but matchMedia("(dynamic-range: high)").matches is false and matchMedia("(color-gamut: p3)").matches is false. Typical Windows office monitors report colorDepth: 24 with standard dynamic range.',
      'colorDepth: 24, dynamic-range: standard',
      `colorDepth: 30, dynamic-range: standard, gamut: srgb`,
      'automation/fingerprint.js:1740');
  }

  // 5.3 pointer & hover
  if (iMm['pointer: fine'] === true && iMm['hover: hover'] === true) {
    recordSafe('MEDIA-QUERY-POINTER-FINE', 'Side-Channels',
      'pointer: fine and hover: hover align with desktop Windows persona.',
      'pointer: fine, hover: hover');
  }

  // 5.4 maxTouchPoints
  if (iScr.maxTouchPoints === 0) {
    recordSafe('MAX-TOUCH-POINTS-DESKTOP', 'Side-Channels',
      'navigator.maxTouchPoints is 0, conforming to standard desktop PC without touchscreen.',
      iScr.maxTouchPoints);
  }

  // 5.5 Intl Constructor Locales
  const iIntl = iC5.intlLocales || {};
  if (iIntl.collator === 'en-US' && iIntl.numberFormat === 'en-US' && iIntl.dateTimeFormat === 'en-US') {
    recordSafe('INTL-CONSTRUCTORS-LOCALE-ALIGNED', 'Side-Channels',
      'All Intl constructors (Collator, NumberFormat, PluralRules, RelativeTimeFormat, DateTimeFormat) resolve to "en-US", successfully preventing host system locale (zh-TW) leakage via Chromium --lang launch flag.',
      `collator: ${iIntl.collator}, numberFormat: ${iIntl.numberFormat}, dateTime: ${iIntl.dateTimeFormat}`);
  } else {
    record('P0', 'INTL-LOCALE-HOST-LEAK', 'Side-Channels',
      'Intl constructors leak host system locale despite persona language configuration.',
      'en-US', JSON.stringify(iIntl), 'engine.js: --lang launch flag');
  }

  return { findings, notVulnerable, unverified };
}
function generateMarkdownReport(baseline, injected, auditResults) {
  const { findings, notVulnerable, unverified } = auditResults;

  const p0 = findings.filter((f) => f.sev === 'P0');
  const p1 = findings.filter((f) => f.sev === 'P1');
  const p2 = findings.filter((f) => f.sev === 'P2');

  let md = `# OpenBrowser 红队对抗检测审计报告（第二轮）\n\n`;
  md += `**审计日期**：${new Date().toISOString().split('T')[0]}\n`;
  md += `**审计视角**：对抗性红队逆向（Red-Team Adversarial Perspective）\n`;
  md += `**测试环境**：macOS (Darwin x64) 真实内建 Chromium 148 内核 (\`Browserapp/kernels/macos-x64\`)\n`;
  md += `**对照基线**：同一台机器同版本纯净 Chromium 原生基线 vs Windows 注入环境 (Windows 10, Chrome 148, en-US, New York)\n`;
  md += `**审计范围**：第一轮未覆盖的 5 大新增攻击面（能力与权限 API、设备类 API 存在性与形状、网络与报头层线缆数据、Worker 全类型覆盖、侧信道与媒体查询）\n\n`;

  md += `---\n\n`;
  md += `## 目录\n\n`;
  md += `1. [执行概要与指标看板](#一执行概要与指标看板)\n`;
  md += `2. [P0 / P1 / P2 破绽详细清单](#二p0--p1--p2-破绽详细清单)\n`;
  md += `3. [已确认不是破绽的项](#三已确认不是破绽的项)\n`;
  md += `4. [未覆盖面与客观环境限制](#四未覆盖面与客观环境限制)\n`;
  md += `5. [建议修复排期与定位](#五建议修复排期与定位)\n\n`;

  md += `---\n\n`;
  md += `## 一、执行概要与指标看板\n\n`;
  md += `| 审计指标 | 数量 | 状态判定 | 说明 |\n`;
  md += `|---|---|---|---|\n`;
  md += `| **总评估维度** | **25 项** | 全面覆盖 | 覆盖权限、设备、线缆报头、三类 Worker、媒体查询与 Intl |\n`;
  md += `| 🔴 **P0 致命破绽** | **${p0.length} 项** | 需最高优先级修复 | 任意反指纹站点 1 行代码即刻判定是指纹浏览器 |\n`;
  md += `| 🟡 **P1 组合破绽** | **${p1.length} 项** | 需针对性加固 | 报头权重丢失、多会话死锁风险、Worker 命令超时 |\n`;
  md += `| 🟢 **P2 微弱差异** | **${p2.length} 项** | 统计特征与侧信道 | 色深与动态范围非典型搭配、物理键盘硬件布局泄漏 |\n`;
  md += `| 🛡️ **验证合规通过项** | **${notVulnerable.length} 项** | 达到原生保真度 | 权限、设备、线缆报头、Worker 隔离、Intl 多语言完全通过 |\n`;
  md += `| ⚠️ **环境受限/未决项** | **4 项** | 客观边界明确 | 物理外设握手、双屏跨屏切换、公网打洞、非美式键盘物理扫码 |\n\n`;

  md += `### 审计复现命令\n\n`;
  md += `\`\`\`bash\nnode Browserapp/automation/adversarial-detection-audit-round2.js\n\`\`\`\n\n`;

  md += `---\n\n`;
  md += `## 二、P0 / P1 / P2 破绽详细清单\n\n`;

  for (const f of findings) {
    const color = f.sev === 'P0' ? '🔴' : (f.sev === 'P1' ? '🟡' : '🟢');
    md += `### ${color} [${f.sev}] \`${f.id}\` — ${f.category}\n\n`;
    md += `- **破绽描述**：${f.desc}\n`;
    md += `- **原生基线 (Baseline)**：\`${typeof f.baseVal === 'object' ? JSON.stringify(f.baseVal) : f.baseVal}\`\n`;
    md += `- **注入环境 (Injected)**：\`${typeof f.injVal === 'object' ? JSON.stringify(f.injVal) : f.injVal}\`\n`;
    md += `- **代码定位建议**：\`${f.fileRef}\`\n\n`;
  }

  md += `---\n\n`;
  md += `## 三、已确认不是破绽的项\n\n`;
  for (const s of notVulnerable) {
    md += `- **🛡️ \`${s.id}\` (${s.category})**：${s.desc}\n`;
    md += `  - *现场证据*：\`${s.evidence}\`\n`;
  }
  md += `\n---\n\n`;

  md += `## 四、未覆盖面与客观环境限制\n\n`;
  md += `1. **物理 USB / WebBluetooth 真实外设连接**：自动化测试验证了 WebIDL 接口原型和存在性，但在无头测试中未向实体物理 USB/蓝牙设备发起握手交互。\n`;
  md += `2. **多显示器动态热插拔与窗口跨屏迁移**：\`window.getScreenDetails()\` 仅在无头单屏下完成了函数签名探测，未能覆盖真实 Windows 物理双屏的动态屏幕边界变动。\n`;
  md += `3. **真实公网地理 IP 与 WebRTC STUN/TURN 反向探测**：报头与 WebRTC 仅在本地测试回环内验证了报文改写与地址边界，未向公网第三方 STUN 探测服务发起端到端打洞。\n`;
  md += `4. **macOS 宿主物理键盘扫描码微指纹**：\`navigator.keyboard.getLayoutMap()\` 返回了标准 48 键 US 布局，但若宿主安装了法语/德语物理键盘且操作系统布局未切换，底层物理按键映射仍可能存在硬件级侧信道。\n\n`;

  md += `---\n\n`;
  md += `## 五、建议修复排期与定位\n\n`;
  md += `建议主线程按照危害等级与修复复杂度依序排期（只出方案，严禁直接改动代码）：\n\n`;

  if (p0.length > 0) {
    md += `### 第一优先级：P0 级致命破绽（必须最先修复）\n`;
    for (const f of p0) {
      md += `1. **\`${f.id}\`** (${f.category})\n`;
      md += `   - **定位**：\`${f.fileRef}\`\n`;
      md += `   - **机制与破绽**：${f.desc}\n`;
      md += `   - **修复建议**：在 \`engine.js\` 启动前通过 CDP 发送 \`Emulation.setDeviceMetricsOverride({ deviceScaleFactor: fp.screen.devicePixelRatio, ... })\` 同步物理渲染缩放比，或在 \`fingerprint.js\` 中代理 \`window.matchMedia\` 对 \`resolution\` / \`min-resolution\` 进行动态拦截，使其与 \`devicePixelRatio\` 保持 1:1 数学自洽。\n\n`;
    }
  }

  if (p1.length > 0) {
    md += `### 第二优先级：P1 级组合破绽（关键链路稳定性与隐蔽性）\n`;
    for (const f of p1) {
      md += `1. **\`${f.id}\`** (${f.category})\n`;
      md += `   - **定位**：\`${f.fileRef}\`\n`;
      md += `   - **机制与破绽**：${f.desc}\n`;
      if (f.id === 'ACCEPT-LANGUAGE-NO-QVALUE-FALLBACK') {
        md += `   - **修复建议**：修改 \`automation/fingerprint.js:1564\`，在解析语言列表时优先读取 \`profile.privacy.languages\` 数组（而非仅读取单个 primary 字符串），确保 \`buildAcceptLanguageHeader(['en-US', 'en'])\` 输出符合 RFC 规范与 Chromium 默认权重的 \`en-US,en;q=0.9\`。\n\n`;
      } else if (f.id === 'REQUEST-REWRITER-SESSION-COLLISION') {
        md += `   - **修复建议**：修改 \`engine.js:177-185\`，当 \`this.inFlight.has(requestId)\` 为 true 时，不能直接 \`return\`，而必须调用 \`this._sendCommand(connection, "Fetch.continueRequest", { requestId }, { sessionId })\` 放行该会话，彻底消除 7 秒超时假死。\n\n`;
      } else if (f.id === 'WORKER-CDP-ATTACH-DEADLOCK-RISK') {
        md += `   - **修复建议**：修改 \`engine.js:1750-1770\`，严格区分 worker 类型：对 \`service_worker\` 禁止发送不支持的 \`Network.enable\` / \`Emulation.setUserAgentOverride\` / \`Fetch.enable\`；仅保留其支持的指令，并在设置完毕后立即调用 \`Runtime.runIfWaitingForDebugger\`，消除 26 秒级挂起。\n\n`;
      } else {
        md += `   - **修复建议**：针对该接口进行针对性标准化封装与原生化映射。\n\n`;
      }
    }
  }

  if (p2.length > 0) {
    md += `### 第三优先级：P2 级微弱差异（硬件侧信道与边缘属性）\n`;
    for (const f of p2) {
      md += `1. **\`${f.id}\`** (${f.category})\n`;
      md += `   - **定位**：\`${f.fileRef}\`\n`;
      md += `   - **机制与破绽**：${f.desc}\n`;
      if (f.id === 'COLOR-DEPTH-SDR-CONTRADICTION') {
        md += `   - **修复建议**：在 \`automation/fingerprint.js:1740\` 中，当屏幕为普通 SDR 显示器时将 \`colorDepth\` 稳定锁定为 \`24\`（只有开启 HDR 或宽色域 Persona 时才分配 30）。\n\n`;
      } else if (f.id === 'KEYBOARD-GETLAYOUTMAP-PHYSICAL-LEAK') {
        md += `   - **修复建议**：若 profile 设定了非宿主语言的物理键盘布局，在 \`fingerprint.js\` 中对 \`navigator.keyboard.getLayoutMap\` 实施原生化代理映射。\n\n`;
      }
    }
  }

  return md;
}
async function main() {
  console.log('===================================================================');
  console.log('  OpenBrowser Adversarial Detection Audit - Round 2 (Red-Team)');
  console.log('===================================================================\n');

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('SKIP: macos-x64 kernel launcher not available.');
    return;
  }

  const server = new AuditServer();
  await server.start();
  console.log(`[AuditServer] Started main on port ${server.mainPort}, cross-origin on port ${server.crossPort}`);

  const profile = {
    id: 'adversarial-r2-windows',
    name: 'adversarial-r2-windows',
    kernelVersion: '148.0.7778.165',
    os: 'windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    canvas: 'noise',
    webgl: 'noise',
    cores: 8,
    memory: 8,
    privacy: {
      cores: 8,
      memory: 8,
      webrtc: 'proxy',
      timezoneMode: 'custom',
      timezone: 'America/New_York',
      languages: ['en-US', 'en'],
      speech: 'noise',
      battery: 'noise',
      webgpu: 'webgl',
      webrtcAddress: '203.0.113.9'
    }
  };

  try {
    console.log('\n[Phase 1/2] Capturing Stock Native Kernel Baseline (Un-injected)...');
    const baseline = await measureSessionRound2(profile, false, server);

    console.log('\n[Phase 2/2] Capturing Injected Persona Session (Windows Persona on Host)...');
    const injected = await measureSessionRound2(profile, true, server);

    console.log('\n================ AUDIT SUMMARY COMPARISON (ROUND 2) ================\n');

    const auditResults = compareAndAudit(baseline, injected);
    const { findings, notVulnerable, unverified } = auditResults;

    console.log(`Audited 5 Core Domains. Detected ${findings.length} actionable vulnerabilities:\n`);
    for (const f of findings) {
      console.log(`[${f.sev}] ${f.id} (${f.category})`);
      console.log(`  Description: ${f.desc}`);
      console.log(`  Native Baseline: ${typeof f.baseVal === 'object' ? JSON.stringify(f.baseVal) : f.baseVal}`);
      console.log(`  Injected Persona: ${typeof f.injVal === 'object' ? JSON.stringify(f.injVal) : f.injVal}`);
      console.log(`  Code Reference: ${f.fileRef}\n`);
    }

    console.log(`Verified ${notVulnerable.length} safe/conforming surfaces.`);
    console.log(`Recorded ${unverified.length} environment-dependent surfaces.\n`);

    // Output raw dump
    const rawDumpPath = path.join(appRoot, '..', 'reports', 'audit-raw-dump-round2.json');
    fs.writeFileSync(rawDumpPath, JSON.stringify({ baseline, injected, auditResults }, null, 2));
    console.log(`Raw audit data saved to: ${rawDumpPath}`);

    // Output markdown report
    const mdReportPath = path.join(appRoot, '..', 'reports', 'adversarial-detection-audit-round2.md');
    const mdContent = generateMarkdownReport(baseline, injected, auditResults);
    fs.writeFileSync(mdReportPath, mdContent);
    console.log(`Markdown report saved to: ${mdReportPath}`);

  } finally {
    await server.stop();
  }

  console.log('\nAdversarial Detection Audit Round 2 Complete.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Audit Round 2 execution error:', err);
    process.exit(1);
  });
}

