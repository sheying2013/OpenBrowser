#!/usr/bin/env node
'use strict';

/**
 * Render, Media & DedicatedWorker Adversarial Red-Team Audit
 *
 * Exhaustive A/B/C/D real-kernel audit covering 12 core attack surfaces:
 *  1. OffscreenCanvas in DedicatedWorker vs Main Thread (getImageData / convertToBlob / toDataURL noise parity)
 *  2. Canvas 2D Stability & Advanced Ops (multi-read stability, put/get accumulation drift, filter/shadow, isPointInPath)
 *  3. WebGL getParameter / getExtension / getShaderPrecisionFormat / readPixels in Worker/Main/Iframe
 *  4. WebGPU requestAdapter() info (vendor/architecture/device/description) vs persona declaration
 *  5. AudioContext Fingerprint (oscillator+analyser getFloatFrequencyData, sampleRate, baseLatency, outputLatency, OfflineAudioContext)
 *  6. WebRTC Real Connection (RTCPeerConnection createOffer SDP a=candidate host IP, m=audio codecs, local IP leak)
 *  7. FontFace / document.fonts Enumeration (size, forEach, keys/values/entries generator leak, check() return values)
 *  8. CSS @supports / CSS.supports() Platform Differences (-webkit-touch-callout, -webkit-font-smoothing, etc.)
 *  9. SVG getComputedTextLength() / getBBox() Font Metric Leakage (inline vs stylesheet class bypass)
 * 10. HTMLCanvasElement Dimensions, toBlob quality, CanvasRenderingContext2D.measureText TextMetrics
 * 11. MediaCapabilities / MediaSource isTypeSupported Codec Support Differences
 * 12. Worker importScripts & Worker Scope Fingerprint Injection & Network Wire Headers
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
      workerJs: null,
      workerImportJs: null,
      iframeDoc: null,
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

      res.setHeader('Access-Control-Allow-Origin', '*');

      if (p === '/audit') {
        this.recordedRequests.mainPage = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getMainHtml());
        return;
      }

      if (p === '/worker.js') {
        this.recordedRequests.workerJs = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(this.getWorkerJs());
        return;
      }

      if (p === '/worker-import.js') {
        this.recordedRequests.workerImportJs = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(this.getWorkerImportJs());
        return;
      }

      if (p === '/iframe-page') {
        this.recordedRequests.iframeDoc = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getIframeHtml());
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

  getWorkerImportJs() {
    return `
      // Script loaded via importScripts() inside DedicatedWorker
      self.__importedProbe = (function() {
        const uad = navigator.userAgentData;
        return {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          languages: navigator.languages ? Array.from(navigator.languages) : null,
          hasUaData: Boolean(uad),
          uadPlatform: uad ? uad.platform : null,
          importedAt: Date.now()
        };
      })();
    `;
  }

  getWorkerJs() {
    return `
      self.onmessage = async (e) => {
        const out = {};

        // 12. Test importScripts
        try {
          importScripts('/worker-import.js');
          out.importScriptsResult = self.__importedProbe || null;
        } catch (err) {
          out.importScriptsResult = { error: String(err) };
        }

        // 1. OffscreenCanvas in DedicatedWorker
        out.offscreenCanvas = {};
        try {
          const w = 120;
          const h = 80;
          const off = new OffscreenCanvas(w, h);
          const ctx = off.getContext('2d');
          ctx.fillStyle = '#ff3300';
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = '#0066cc';
          ctx.fillRect(10, 10, w - 20, h - 20);
          ctx.fillStyle = 'rgba(100, 200, 50, 0.8)';
          ctx.beginPath();
          ctx.arc(w / 2, h / 2, Math.min(w, h) / 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = '16px sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.fillText('Worker Offscreen', 15, 30);

          const imgData = ctx.getImageData(0, 0, w, h);
          let sum = 0;
          let nonZero = 0;
          let hash = 0;
          for (let i = 0; i < imgData.data.length; i++) {
            const v = imgData.data[i];
            if (v !== 0) nonZero++;
            sum += v;
            hash = ((hash << 5) - hash + v) | 0;
          }

          let blobSize = null;
          let blobType = null;
          try {
            const b = await off.convertToBlob();
            blobSize = b ? b.size : null;
            blobType = b ? b.type : null;
          } catch (err) {
            blobSize = 'ERR:' + err.name;
          }

          const hasToDataURL = typeof off.toDataURL === 'function';

          const ctxProto = self.OffscreenCanvasRenderingContext2D ? self.OffscreenCanvasRenderingContext2D.prototype : null;
          const getImgDesc = ctxProto ? Object.getOwnPropertyDescriptor(ctxProto, 'getImageData') : null;
          const getImgToString = ctxProto && ctxProto.getImageData ? String(ctxProto.getImageData) : null;

          out.offscreenCanvas = {
            width: w,
            height: h,
            pixelSum: sum,
            nonZeroPixels: nonZero,
            pixelHash: hash >>> 0,
            blobSize,
            blobType,
            hasToDataURL,
            getImageDataToString: getImgToString ? getImgToString.slice(0, 80) : null,
            isNativeLike: getImgToString ? getImgToString.includes('[native code]') : false
          };
        } catch (err) {
          out.offscreenCanvas = { error: String(err) };
        }

        // 3. WebGL in DedicatedWorker
        out.webgl = {};
        try {
          const offGl = new OffscreenCanvas(64, 64);
          const gl = offGl.getContext('webgl') || offGl.getContext('experimental-webgl');
          const gl2 = offGl.getContext('webgl2');
          if (gl) {
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            const unmaskedVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
            const unmaskedRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;

            const getPrec = (target, type) => {
              const p = gl.getShaderPrecisionFormat(target, type);
              return p ? { rangeMin: p.rangeMin, rangeMax: p.rangeMax, precision: p.precision } : null;
            };

            // readPixels noise in Worker
            gl.clearColor(0.7, 0.3, 0.4, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            const px = new Uint8Array(64 * 64 * 4);
            gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
            let pxSum = 0;
            for (let i = 0; i < px.length; i += 4) pxSum += px[i];

            out.webgl = {
              unmaskedVendor,
              unmaskedRenderer,
              maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
              maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []),
              aliasedPointSizeRange: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || []),
              aliasedLineWidthRange: Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE || 0x846E) || []),
              maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE || 0x84E8),
              maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS || 0x8DFB),
              maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS || 0x8DFC),
              vertexHighp: getPrec(gl.VERTEX_SHADER, gl.HIGH_FLOAT),
              fragmentHighp: getPrec(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT),
              readPixelsSum: pxSum,
              extensionsCount: gl.getSupportedExtensions() ? gl.getSupportedExtensions().length : 0,
              webgl2: gl2 ? {
                uniformBufferOffsetAlignment: gl2.getParameter(gl2.UNIFORM_BUFFER_OFFSET_ALIGNMENT || 0x8A34),
                maxUniformBlockSize: gl2.getParameter(gl2.MAX_UNIFORM_BLOCK_SIZE || 0x8A30),
              } : 'webgl2-unavailable'
            };
          } else {
            out.webgl = 'webgl-unavailable';
          }
        } catch (err) {
          out.webgl = { error: String(err) };
        }

        // 4. WebGPU in DedicatedWorker
        out.webgpu = {};
        try {
          if (navigator.gpu) {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
              const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
              out.webgpu = {
                exists: true,
                vendor: info?.vendor,
                architecture: info?.architecture,
                device: info?.device,
                description: info?.description,
                limits: {
                  minUniformBufferOffsetAlignment: adapter.limits?.minUniformBufferOffsetAlignment,
                  maxTextureDimension2D: adapter.limits?.maxTextureDimension2D,
                  maxBufferSize: adapter.limits?.maxBufferSize
                }
              };
            } else {
              out.webgpu = { exists: true, adapter: null };
            }
          } else {
            out.webgpu = { exists: false };
          }
        } catch (err) {
          out.webgpu = { error: String(err) };
        }

        // Navigator identity in Worker
        out.workerNavigator = {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          languages: navigator.languages ? Array.from(navigator.languages) : null,
          hasUserAgentData: Boolean(navigator.userAgentData)
        };

        self.postMessage(out);
      };
    `;
  }

  getIframeHtml() {
    return `<!doctype html>
<html>
<body>
  <script>
    window.__getIframeGl = function() {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        aliasedPointSizeRange: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || []),
        aliasedLineWidthRange: Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE || 0x846E) || [])
      };
    };
    window.__iframeLoaded = true;
  </script>
</body>
</html>`;
  }

  getMainHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Render Media Worker Adversarial Audit</title>
  <style>
    .mac-class-font {
      font-family: "PingFang SC", monospace;
      font-size: 72px;
    }
    .win-class-font {
      font-family: "Segoe UI", monospace;
      font-size: 72px;
    }
    .mono-class-font {
      font-family: monospace;
      font-size: 72px;
    }
  </style>
</head>
<body>
  <h1>Render Media Worker Audit In-Browser Probes</h1>

  <!-- SVG elements for Font Metric leakage testing -->
  <svg id="test-svg" width="800" height="400" style="position: absolute; left: -9999px; top: -9999px;">
    <!-- Inline style test -->
    <text id="svg-inline-mac" style="font-family: 'PingFang SC', monospace; font-size: 72px;">test12345</text>
    <!-- Stylesheet class test -->
    <text id="svg-class-mac" class="mac-class-font">test12345</text>
    <!-- Pure Monospace baseline test -->
    <text id="svg-mono" class="mono-class-font">test12345</text>
    <!-- Windows Persona font test -->
    <text id="svg-class-win" class="win-class-font">test12345</text>
    <!-- Nested tspan test -->
    <text id="svg-tspan-parent" style="font-size: 72px;">
      <tspan id="svg-tspan-mac" style="font-family: 'PingFang SC', monospace;">test12345</tspan>
    </text>
  </svg>

  <iframe id="sub-iframe" src="/iframe-page" style="display:none;"></iframe>

  <script>
    (async () => {
      const out = {};

      const hashData = (arr) => {
        let h = 0;
        for (let i = 0; i < arr.length; i++) {
          h = ((h << 5) - h + arr[i]) | 0;
        }
        return h >>> 0;
      };

      // ============================================================
      // 1. OffscreenCanvas (Main Thread) & Parity
      // ============================================================
      out.offscreenMain = {};
      try {
        const w = 120;
        const h = 80;

        // HTMLCanvasElement
        const htmlC = document.createElement('canvas');
        htmlC.width = w; htmlC.height = h;
        const hCtx = htmlC.getContext('2d');
        hCtx.fillStyle = '#ff3300';
        hCtx.fillRect(0, 0, w, h);
        hCtx.fillStyle = '#0066cc';
        hCtx.fillRect(10, 10, w - 20, h - 20);
        hCtx.fillStyle = 'rgba(100, 200, 50, 0.8)';
        hCtx.beginPath();
        hCtx.arc(w / 2, h / 2, Math.min(w, h) / 4, 0, Math.PI * 2);
        hCtx.fill();
        hCtx.font = '16px sans-serif';
        hCtx.fillStyle = '#ffffff';
        hCtx.fillText('Worker Offscreen', 15, 30);
        const htmlImg = hCtx.getImageData(0, 0, w, h);
        const htmlHash = hashData(htmlImg.data);

        // OffscreenCanvas on Main Thread
        const offC = new OffscreenCanvas(w, h);
        const offCtx = offC.getContext('2d');
        offCtx.fillStyle = '#ff3300';
        offCtx.fillRect(0, 0, w, h);
        offCtx.fillStyle = '#0066cc';
        offCtx.fillRect(10, 10, w - 20, h - 20);
        offCtx.fillStyle = 'rgba(100, 200, 50, 0.8)';
        offCtx.beginPath();
        offCtx.arc(w / 2, h / 2, Math.min(w, h) / 4, 0, Math.PI * 2);
        offCtx.fill();
        offCtx.font = '16px sans-serif';
        offCtx.fillStyle = '#ffffff';
        offCtx.fillText('Worker Offscreen', 15, 30);
        const offImg = offCtx.getImageData(0, 0, w, h);
        const offHash = hashData(offImg.data);

        const offBlob = await offC.convertToBlob();

        out.offscreenMain = {
          htmlCanvasHash: htmlHash,
          offscreenCanvasHash: offHash,
          mainThreadParity: htmlHash === offHash,
          blobSize: offBlob ? offBlob.size : null,
          hasToDataURL: typeof offC.toDataURL === 'function'
        };
      } catch (err) {
        out.offscreenMain = { error: String(err) };
      }

      // ============================================================
      // 2. Canvas 2D Stability & Advanced Ops
      // ============================================================
      out.canvas2d = {};
      try {
        const c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#2288bb';
        ctx.fillRect(0, 0, 100, 100);
        ctx.fillStyle = '#ee4411';
        ctx.beginPath();
        ctx.arc(50, 50, 30, 0, Math.PI * 2);
        ctx.fill();

        // Multi-read stability
        const readHashes = [];
        for (let i = 0; i < 5; i++) {
          const img = ctx.getImageData(0, 0, 100, 100);
          readHashes.push(hashData(img.data));
        }
        const multiReadStable = readHashes.every(h => h === readHashes[0]);

        // PutImageData Accumulation Drift test
        const d1 = ctx.getImageData(0, 0, 50, 50);
        const h1 = hashData(d1.data);
        ctx.putImageData(d1, 0, 0);
        const d2 = ctx.getImageData(0, 0, 50, 50);
        const h2 = hashData(d2.data);
        ctx.putImageData(d2, 0, 0);
        const d3 = ctx.getImageData(0, 0, 50, 50);
        const h3 = hashData(d3.data);
        const accumulationDrift = (h1 !== h2) || (h2 !== h3);

        // Filter / ShadowBlur / Composite repeatability
        const cFilt1 = document.createElement('canvas');
        cFilt1.width = 60; cFilt1.height = 60;
        const ctxF1 = cFilt1.getContext('2d');
        ctxF1.filter = 'blur(4px)';
        ctxF1.shadowBlur = 10;
        ctxF1.shadowColor = 'rgba(0,0,0,0.5)';
        ctxF1.globalCompositeOperation = 'difference';
        ctxF1.fillStyle = '#ff00ff';
        ctxF1.fillRect(10, 10, 40, 40);
        const filtHash1 = hashData(ctxF1.getImageData(0, 0, 60, 60).data);

        const cFilt2 = document.createElement('canvas');
        cFilt2.width = 60; cFilt2.height = 60;
        const ctxF2 = cFilt2.getContext('2d');
        ctxF2.filter = 'blur(4px)';
        ctxF2.shadowBlur = 10;
        ctxF2.shadowColor = 'rgba(0,0,0,0.5)';
        ctxF2.globalCompositeOperation = 'difference';
        ctxF2.fillStyle = '#ff00ff';
        ctxF2.fillRect(10, 10, 40, 40);
        const filtHash2 = hashData(ctxF2.getImageData(0, 0, 60, 60).data);

        // isPointInPath precision & native integrity
        ctx.beginPath();
        ctx.arc(50.5, 50.5, 25, 0, Math.PI * 2);
        const inCenter = ctx.isPointInPath(50.5, 50.5);
        const inNearEdge = ctx.isPointInPath(75.4, 50.5);
        const inFarEdge = ctx.isPointInPath(75.6, 50.5);
        const ipipToString = String(ctx.isPointInPath);

        out.canvas2d = {
          readHashes,
          multiReadStable,
          drift: { h1, h2, h3, accumulationDrift },
          filterRepeatable: filtHash1 === filtHash2,
          isPointInPath: {
            inCenter,
            inNearEdge,
            inFarEdge,
            isNative: ipipToString.includes('[native code]')
          }
        };
      } catch (err) {
        out.canvas2d = { error: String(err) };
      }

      // ============================================================
      // 3. WebGL Full getParameter & readPixels vs toDataURL
      // ============================================================
      out.webgl = {};
      try {
        const c = document.createElement('canvas');
        c.width = 100; c.height = 100;
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        const gl2 = c.getContext('webgl2');
        if (gl) {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          const unmaskedVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
          const unmaskedRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;

          // Draw scene
          gl.clearColor(0.8, 0.2, 0.4, 1.0);
          gl.clear(gl.COLOR_BUFFER_BIT);

          // readPixels
          const px = new Uint8Array(100 * 100 * 4);
          gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const readPixelsHash = hashData(px);

          // canvas.toDataURL() on WebGL canvas (check if noise applied or bypassed)
          const dataUrl = c.toDataURL();
          const dataUrlLength = dataUrl.length;

          // Precision formats
          const getPrec = (target, type) => {
            const p = gl.getShaderPrecisionFormat(target, type);
            return p ? { rangeMin: p.rangeMin, rangeMax: p.rangeMax, precision: p.precision } : null;
          };

          const exts = gl.getSupportedExtensions() || [];
          const hasDisallowedExt = exts.some(e => /^(nv_|amd_|intel_|qcom_)/i.test(e));

          out.webgl = {
            unmaskedVendor,
            unmaskedRenderer,
            maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
            maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []),
            aliasedPointSizeRange: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || []),
            aliasedLineWidthRange: Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE || 0x846E) || []),
            maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE || 0x84E8),
            maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS || 0x8DFB),
            maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS || 0x8DFC),
            readPixelsHash,
            dataUrlLength,
            dataUrlSample: dataUrl.slice(0, 60),
            vertexHighp: getPrec(gl.VERTEX_SHADER, gl.HIGH_FLOAT),
            fragmentHighp: getPrec(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT),
            fragmentMediump: getPrec(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT),
            fragmentLowp: getPrec(gl.FRAGMENT_SHADER, gl.LOW_FLOAT),
            extensionsCount: exts.length,
            hasDisallowedVendorExtension: hasDisallowedExt,
            disallowedExts: exts.filter(e => /^(nv_|amd_|intel_|qcom_)/i.test(e)),
            webgl2: gl2 ? {
              uniformBufferOffsetAlignment: gl2.getParameter(gl2.UNIFORM_BUFFER_OFFSET_ALIGNMENT || 0x8A34),
              maxUniformBlockSize: gl2.getParameter(gl2.MAX_UNIFORM_BLOCK_SIZE || 0x8A30),
            } : 'webgl2-unavailable'
          };
        } else {
          out.webgl = 'webgl-unavailable';
        }
      } catch (err) {
        out.webgl = { error: String(err) };
      }

      // ============================================================
      // 4. WebGPU requestAdapter()
      // ============================================================
      out.webgpu = {};
      try {
        if (navigator.gpu) {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
            out.webgpu = {
              exists: true,
              vendor: info?.vendor,
              architecture: info?.architecture,
              device: info?.device,
              description: info?.description,
              featuresCount: adapter.features ? adapter.features.size : 0,
              featuresList: Array.from(adapter.features || []).slice(0, 10),
              limits: {
                minUniformBufferOffsetAlignment: adapter.limits?.minUniformBufferOffsetAlignment,
                maxTextureDimension2D: adapter.limits?.maxTextureDimension2D,
                maxBufferSize: adapter.limits?.maxBufferSize
              }
            };
          } else {
            out.webgpu = { exists: true, adapter: null };
          }
        } else {
          out.webgpu = { exists: false };
        }
      } catch (err) {
        out.webgpu = { error: String(err) };
      }

      // ============================================================
      // 5. AudioContext Fingerprint & Latencies
      // ============================================================
      out.audio = {};
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          const actx = new AudioCtx();
          out.audio.sampleRate = actx.sampleRate;
          out.audio.baseLatency = actx.baseLatency;
          out.audio.outputLatency = actx.outputLatency;
          out.audio.state = actx.state;

          const osc = actx.createOscillator();
          const analyser = actx.createAnalyser();
          analyser.fftSize = 128;
          osc.type = 'triangle';
          osc.frequency.value = 10000;
          osc.connect(analyser);
          analyser.connect(actx.destination);
          try { osc.start(0); } catch (_) {}

          const freq1 = new Float32Array(analyser.frequencyBinCount);
          analyser.getFloatFrequencyData(freq1);
          const hashFreq1 = hashData(freq1);

          await new Promise(r => setTimeout(r, 40));
          const freq2 = new Float32Array(analyser.frequencyBinCount);
          analyser.getFloatFrequencyData(freq2);
          const hashFreq2 = hashData(freq2);

          out.audio.liveAnalyser = {
            freqBinCount: analyser.frequencyBinCount,
            hashFreq1,
            hashFreq2,
            isJittering: hashFreq1 !== hashFreq2
          };

          try { actx.close(); } catch (_) {}
        } else {
          out.audio.live = 'unavailable';
        }

        // OfflineAudioContext
        const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (OfflineCtx) {
          const oactx = new OfflineCtx(1, 44100, 44100);
          const osc2 = oactx.createOscillator();
          osc2.type = 'sine';
          osc2.frequency.value = 440;
          osc2.connect(oactx.destination);
          osc2.start(0);
          const rendered = await oactx.startRendering();
          const chData = rendered.getChannelData(0);
          out.audio.offlineRenderedHash = hashData(chData.subarray(0, 5000));

          // Silent buffer preservation test
          const silentCtx = new OfflineCtx(1, 1024, 44100);
          const silentBuf = await silentCtx.startRendering();
          const silentData = silentBuf.getChannelData(0);
          let hasNonZeroSilent = false;
          for (let i = 0; i < silentData.length; i++) {
            if (silentData[i] !== 0) { hasNonZeroSilent = true; break; }
          }
          out.audio.silentBufferUntouched = !hasNonZeroSilent;
        }
      } catch (err) {
        out.audio = { error: String(err) };
      }

      // ============================================================
      // 6. WebRTC Real Connection & SDP Candidate Audit
      // ============================================================
      out.webrtc = {};
      try {
        if (typeof RTCPeerConnection !== 'undefined') {
          let pcConstructSuccess = false;
          let pcConstructError = null;
          let offerSdp = null;
          let candidateLines = [];
          let gatheredCandidates = [];

          try {
            const pc = new RTCPeerConnection({
              iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            });
            pcConstructSuccess = true;

            pc.onicecandidate = (evt) => {
              if (evt && evt.candidate) {
                gatheredCandidates.push({
                  candidate: evt.candidate.candidate,
                  address: evt.candidate.address,
                  type: evt.candidate.type,
                  isTrusted: evt.isTrusted
                });
              }
            };

            pc.createDataChannel('audit-channel');
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            offerSdp = offer.sdp || '';

            // Give ICE gathering 300ms
            await new Promise(r => setTimeout(r, 300));

            const lines = (offerSdp || '').split('\\r\\n').concat((pc.localDescription?.sdp || '').split('\\r\\n'));
            for (const l of lines) {
              if (l.startsWith('a=candidate:') || l.startsWith('c=IN IP')) {
                candidateLines.push(l);
              }
            }

            pc.close();
          } catch (err) {
            pcConstructError = String(err && err.name ? err.name + ': ' + err.message : err);
          }

          out.webrtc = {
            supported: true,
            constructSuccess: pcConstructSuccess,
            constructError: pcConstructError,
            candidateLines: Array.from(new Set(candidateLines)),
            gatheredCandidates,
            hasHostCandidate: candidateLines.some(c => c.includes('typ host')),
            hasConnectionLine: candidateLines.some(c => c.startsWith('c=IN IP')),
          };
        } else {
          out.webrtc = { supported: false };
        }
      } catch (err) {
        out.webrtc = { error: String(err) };
      }

      // ============================================================
      // 7. FontFace & document.fonts Enumeration & Leakage
      // ============================================================
      out.docFonts = {};
      try {
        if (document.fonts) {
          const df = document.fonts;
          const methods = ['keys', 'values', 'entries', 'forEach', 'has', 'check', 'load', 'delete', 'clear'];
          const methodAudits = {};

          for (const m of methods) {
            const fn = df[m];
            if (typeof fn === 'function') {
              const str = Function.prototype.toString.call(fn);
              methodAudits[m] = {
                type: typeof fn,
                name: fn.name,
                length: fn.length,
                isNativeCode: str.includes('[native code]'),
                isGenerator: str.startsWith('function*') || str.includes('yield'),
                strSample: str.slice(0, 70).replace(/\\s+/g, ' ')
              };
            } else {
              methodAudits[m] = { type: typeof fn };
            }
          }

          // Symbol.iterator inspection
          const symIter = df[Symbol.iterator];
          if (typeof symIter === 'function') {
            const symStr = Function.prototype.toString.call(symIter);
            methodAudits['Symbol.iterator'] = {
              isNativeCode: symStr.includes('[native code]'),
              isGenerator: symStr.startsWith('function*') || symStr.includes('yield'),
              strSample: symStr.slice(0, 70).replace(/\\s+/g, ' ')
            };
          }

          // Iterator return type
          let keysReturnType = null;
          try {
            const k = df.keys();
            keysReturnType = Object.prototype.toString.call(k);
          } catch (e) {
            keysReturnType = 'ERR:' + e.name;
          }

          // Check query results
          const checks = {
            arial: df.check('16px Arial'),
            segoeUi: df.check('16px "Segoe UI"'),
            pingfang: df.check('16px "PingFang SC"'),
            appleEmoji: df.check('16px "Apple Color Emoji"'),
            ubuntu: df.check('16px "Ubuntu"'),
            dejavu: df.check('16px "DejaVu Sans"')
          };

          out.docFonts = {
            size: df.size,
            status: df.status,
            arrayFromCount: Array.from(df).length,
            methods: methodAudits,
            keysReturnType,
            checks
          };
        } else {
          out.docFonts = 'document.fonts unavailable';
        }
      } catch (err) {
        out.docFonts = { error: String(err) };
      }

      // ============================================================
      // 8. CSS @supports / CSS.supports() Platform Specific Features
      // ============================================================
      out.cssSupports = {};
      try {
        if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
          out.cssSupports = {
            webkitTouchCallout: CSS.supports('-webkit-touch-callout', 'none'),
            webkitFontSmoothing: CSS.supports('-webkit-font-smoothing', 'antialiased'),
            webkitOverflowScrolling: CSS.supports('-webkit-overflow-scrolling', 'touch'),
            applePayButton: CSS.supports('-webkit-appearance', '-apple-pay-button'),
            backdropFilter: CSS.supports('backdrop-filter', 'blur(10px)'),
            accentColor: CSS.supports('accent-color', 'red'),
            hasSelector: CSS.supports('selector(:has(*))'),
            fontPalette: CSS.supports('font-palette', 'dark')
          };
        } else {
          out.cssSupports = 'CSS.supports unavailable';
        }
      } catch (err) {
        out.cssSupports = { error: String(err) };
      }

      // ============================================================
      // 9. SVG getComputedTextLength() & getBBox() Font Metric Leakage
      // ============================================================
      out.svgFonts = {};
      try {
        const svgInlineMac = document.getElementById('svg-inline-mac');
        const svgClassMac = document.getElementById('svg-class-mac');
        const svgMono = document.getElementById('svg-mono');
        const svgClassWin = document.getElementById('svg-class-win');
        const svgTspanMac = document.getElementById('svg-tspan-mac');
        const svgTspanParent = document.getElementById('svg-tspan-parent');

        const measure = (el) => {
          if (!el) return null;
          return {
            computedTextLength: Math.round(el.getComputedTextLength() * 1000) / 1000,
            bboxWidth: Math.round(el.getBBox().width * 1000) / 1000,
          };
        };

        out.svgFonts = {
          monoBaseline: measure(svgMono),
          inlineMacStyle: measure(svgInlineMac),
          stylesheetClassMac: measure(svgClassMac),
          stylesheetClassWin: measure(svgClassWin),
          tspanParent: measure(svgTspanParent),
          tspanMacChild: measure(svgTspanMac),
          // Check if class bypassed: if classMac !== monoBaseline, it detected PingFang SC via class!
          classBypassed: measure(svgClassMac)?.computedTextLength !== measure(svgMono)?.computedTextLength,
          inlineBypassed: measure(svgInlineMac)?.computedTextLength !== measure(svgMono)?.computedTextLength,
        };
      } catch (err) {
        out.svgFonts = { error: String(err) };
      }

      // ============================================================
      // 10. Canvas Dimensions, toBlob quality & measureText
      // ============================================================
      out.canvasDimsAndMetrics = {};
      try {
        const cZero = document.createElement('canvas');
        cZero.width = 0; cZero.height = 0;
        let zeroBlobErr = null;
        try {
          await new Promise((r, rej) => cZero.toBlob((b) => b ? r(b) : rej(new Error('null blob'))));
        } catch (e) {
          zeroBlobErr = e.message;
        }

        // Quality parameter test
        const cQual = document.createElement('canvas');
        cQual.width = 200; cQual.height = 200;
        const qCtx = cQual.getContext('2d');
        qCtx.fillStyle = '#119955';
        qCtx.fillRect(0, 0, 200, 200);
        qCtx.fillStyle = '#ff8800';
        qCtx.font = '24px serif';
        qCtx.fillText('Quality Gradient Test', 20, 100);

        const bLow = await new Promise(r => cQual.toBlob(r, 'image/jpeg', 0.1));
        const bHigh = await new Promise(r => cQual.toBlob(r, 'image/jpeg', 0.95));

        // measureText TextMetrics full properties
        const mCtx = document.createElement('canvas').getContext('2d');
        mCtx.font = '24px "Segoe UI", Arial, sans-serif';
        const tm = mCtx.measureText('Sample Text 123456');

        out.canvasDimsAndMetrics = {
          zeroCanvasBlob: zeroBlobErr,
          jpegQualityScale: {
            lowSize: bLow ? bLow.size : null,
            highSize: bHigh ? bHigh.size : null,
            qualityScalesNormally: bLow && bHigh ? (bHigh.size > bLow.size) : false
          },
          textMetrics: {
            width: Math.round(tm.width * 1000) / 1000,
            actualBoundingBoxLeft: Math.round(tm.actualBoundingBoxLeft * 1000) / 1000,
            actualBoundingBoxRight: Math.round(tm.actualBoundingBoxRight * 1000) / 1000,
            actualBoundingBoxAscent: Math.round(tm.actualBoundingBoxAscent * 1000) / 1000,
            actualBoundingBoxDescent: Math.round(tm.actualBoundingBoxDescent * 1000) / 1000,
            fontBoundingBoxAscent: tm.fontBoundingBoxAscent !== undefined ? Math.round(tm.fontBoundingBoxAscent * 1000) / 1000 : null,
            fontBoundingBoxDescent: tm.fontBoundingBoxDescent !== undefined ? Math.round(tm.fontBoundingBoxDescent * 1000) / 1000 : null
          }
        };
      } catch (err) {
        out.canvasDimsAndMetrics = { error: String(err) };
      }

      // ============================================================
      // 11. MediaCapabilities / MediaSource Codecs
      // ============================================================
      out.mediaCodecs = {};
      try {
        const codecs = [
          'video/mp4; codecs="avc1.42E01E"',
          'video/mp4; codecs="hvc1.1.6.L93.B0"',
          'video/webm; codecs="vp8"',
          'video/webm; codecs="vp9"',
          'video/webm; codecs="av01.0.08M.08"',
          'audio/mp4; codecs="mp4a.40.2"',
          'audio/webm; codecs="opus"'
        ];

        const msResults = {};
        if (typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function') {
          for (const c of codecs) {
            msResults[c] = MediaSource.isTypeSupported(c);
          }
        }

        const canPlayResults = {};
        const vid = document.createElement('video');
        for (const c of codecs) {
          canPlayResults[c] = vid.canPlayType(c);
        }

        out.mediaCodecs = {
          mediaSourceSupported: typeof MediaSource !== 'undefined',
          mediaSource: msResults,
          canPlayType: canPlayResults
        };
      } catch (err) {
        out.mediaCodecs = { error: String(err) };
      }

      // ============================================================
      // 12. Cross-Context (Same-Origin Iframe & DedicatedWorker)
      // ============================================================
      out.crossContext = {};

      // Iframe
      try {
        const ifr = document.getElementById('sub-iframe');
        if (ifr && ifr.contentWindow && ifr.contentWindow.__getIframeGl) {
          out.crossContext.iframeWebgl = ifr.contentWindow.__getIframeGl();
        } else {
          out.crossContext.iframeWebgl = 'iframe not ready';
        }
      } catch (err) {
        out.crossContext.iframeWebgl = { error: String(err) };
      }

      // DedicatedWorker
      try {
        const worker = new Worker('/worker.js');
        const workerPromise = new Promise((resolve) => {
          worker.onmessage = (e) => resolve(e.data);
          worker.onerror = (e) => resolve({ error: e.message || 'Worker error' });
          setTimeout(() => resolve({ timeout: true }), 4000);
        });
        worker.postMessage({ cmd: 'audit' });
        out.crossContext.dedicatedWorker = await workerPromise;
        worker.terminate();
      } catch (err) {
        out.crossContext.dedicatedWorker = { error: String(err) };
      }

      window.__AUDIT_RESULT__ = out;
      window.__AUDIT_READY__ = true;
    })();
  </script>
</body>
</html>`;
  }
}

async function runSession(profileConfig, isInject, server) {
  server.resetRecorded();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-rmw-audit-' + profileConfig.id + '-'));
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
      // 1. Fetch interception for headers
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

      // 2. Worker auto-attach
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

    const mainUrl = `http://127.0.0.1:${server.port}/audit`;
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
      const dataRes = await connection.command('Runtime.evaluate', {
        expression: 'window.__AUDIT_RESULT__',
        returnByValue: true,
      }, { sessionId, timeout: 15000 });
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
    headers: { ...server.recordedRequests },
  };
}

(async () => {
  console.log('================================================================');
  console.log('OpenBrowser Render / Media / DedicatedWorker Adversarial Audit');
  console.log('================================================================');

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.error('Error: macOS launcher not found at ' + launcher);
    process.exit(1);
  }

  const server = new AuditServer();
  await server.start();
  console.log(`[AuditServer] Listening on http://127.0.0.1:${server.port}`);

  const results = {};

  try {
    // 1. Baseline: Un-injected Stock Kernel
    console.log('\n[1/4] Running Session 1: Baseline (Un-injected Stock Kernel)...');
    const baselineProfile = {
      id: 'baseline',
      name: 'baseline',
      os: 'macos',
      language: 'zh-TW',
      privacy: { timezoneMode: 'real' },
    };
    results.baseline = await runSession(baselineProfile, false, server);
    console.log('  Baseline session complete.');

    // 2. Windows Desktop Persona (Intel D3D11 GPU, Win10 x64, America/New_York)
    console.log('\n[2/4] Running Session 2: Windows Persona (Intel D3D11, America/New_York)...');
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
    results.windows = await runSession(windowsProfile, true, server);
    console.log('  Windows session complete.');

    // 3. Linux Desktop Persona (Mesa Intel GPU, Linux x86_64, Europe/London)
    console.log('\n[3/4] Running Session 3: Linux Persona (Mesa Intel, Europe/London)...');
    const linuxProfile = {
      id: 'linux-mesa',
      name: 'linux-mesa',
      os: 'linux',
      language: 'en-GB',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      exitIp: '203.0.113.45',
      exitTimezone: 'Europe/London',
      webglRenderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
      webglVendor: 'Google Inc. (Intel)',
      privacy: {
        deviceProfile: 'persona',
        timezoneMode: 'custom',
        timezone: 'Europe/London',
        webgl: 'noise',
        canvas: 'noise',
        audio: 'noise',
        clientRects: 'noise',
        webrtc: 'proxy',
        webrtcAddress: '203.0.113.45',
        webrtcLocalIp: '10.0.0.45',
        webgpu: 'webgl',
      },
    };
    results.linux = await runSession(linuxProfile, true, server);
    console.log('  Linux session complete.');

    // 4. iOS Mobile Persona (iPhone / WebKit / Apple GPU)
    console.log('\n[4/4] Running Session 4: iOS Mobile Persona (iPhone, Asia/Shanghai)...');
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
    results.ios = await runSession(iosProfile, true, server);
    console.log('  iOS session complete.');

  } finally {
    await server.stop();
  }

  // Dump Raw Evidence JSON
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  const rawPath = path.join(reportsDir, 'render-media-worker-adversarial-raw.json');
  fs.writeFileSync(rawPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n[Audit] Raw results dumped to ${rawPath}`);

  // Print Summary Analysis
  console.log('\n================================================================');
  console.log('AUDIT ANALYSIS & HIGHLIGHTS');
  console.log('================================================================');

  const bClient = results.baseline?.client || {};
  const wClient = results.windows?.client || {};
  const lClient = results.linux?.client || {};
  const iClient = results.ios?.client || {};

  console.log('1. OffscreenCanvas (Main vs Worker):');
  console.log('   Windows Main HTMLCanvas hash:', wClient.offscreenMain?.htmlCanvasHash);
  console.log('   Windows Main Offscreen hash :', wClient.offscreenMain?.offscreenCanvasHash);
  console.log('   Windows Worker Offscreen    :', wClient.crossContext?.dedicatedWorker?.offscreenCanvas?.pixelHash);
  console.log('   Worker Parity with Main     :', wClient.offscreenMain?.offscreenCanvasHash === wClient.crossContext?.dedicatedWorker?.offscreenCanvas?.pixelHash);

  console.log('\n2. Canvas 2D Stability:');
  console.log('   Multi-read stable (Windows) :', wClient.canvas2d?.multiReadStable);
  console.log('   Accumulation Drift on Put   :', wClient.canvas2d?.drift?.accumulationDrift,
              `(h1=${wClient.canvas2d?.drift?.h1}, h2=${wClient.canvas2d?.drift?.h2}, h3=${wClient.canvas2d?.drift?.h3})`);

  console.log('\n3. WebGL ALIASED_LINE_WIDTH_RANGE & toDataURL:');
  console.log('   Baseline LineWidthRange     :', bClient.webgl?.aliasedLineWidthRange);
  console.log('   Windows LineWidthRange      :', wClient.webgl?.aliasedLineWidthRange);
  console.log('   Worker WebGL LineWidthRange :', wClient.crossContext?.dedicatedWorker?.webgl?.aliasedLineWidthRange);
  console.log('   WebGL toDataURL length      :', wClient.webgl?.dataUrlLength);

  console.log('\n4. WebGPU:');
  console.log('   Windows WebGPU Vendor       :', wClient.webgpu?.vendor);
  console.log('   Windows WebGPU Architecture :', wClient.webgpu?.architecture);

  console.log('\n5. AudioContext:');
  console.log('   SampleRate                  :', wClient.audio?.sampleRate);
  console.log('   BaseLatency                 :', wClient.audio?.baseLatency);
  console.log('   OutputLatency               :', wClient.audio?.outputLatency);
  console.log('   OfflineAudio Hash           :', wClient.audio?.offlineRenderedHash);
  console.log('   Silent Buffer Untouched     :', wClient.audio?.silentBufferUntouched);

  console.log('\n6. WebRTC:');
  console.log('   Construct success           :', wClient.webrtc?.constructSuccess);
  console.log('   Construct error             :', wClient.webrtc?.constructError);
  console.log('   Candidate lines             :', wClient.webrtc?.candidateLines);

  console.log('\n7. FontFace / document.fonts:');
  console.log('   document.fonts.size         :', wClient.docFonts?.size);
  console.log('   document.fonts.keys()       :', wClient.docFonts?.methods?.keys);
  console.log('   document.fonts.forEach()    :', wClient.docFonts?.methods?.forEach);
  console.log('   document.fonts.has()        :', wClient.docFonts?.methods?.has);
  console.log('   document.fonts.check()      :', wClient.docFonts?.checks);

  console.log('\n8. CSS @supports:');
  console.log('   Windows CSS supports        :', wClient.cssSupports);
  console.log('   iOS CSS supports            :', iClient.cssSupports);

  console.log('\n9. SVG Font Metric Leakage:');
  console.log('   Mono baseline               :', wClient.svgFonts?.monoBaseline);
  console.log('   Inline Mac PingFang         :', wClient.svgFonts?.inlineMacStyle);
  console.log('   Class Mac PingFang          :', wClient.svgFonts?.stylesheetClassMac);
  console.log('   Class Bypassed Shield?      :', wClient.svgFonts?.classBypassed);

  console.log('\n10. Canvas Dimensions & TextMetrics:');
  console.log('    JPEG Quality Scales        :', wClient.canvasDimsAndMetrics?.jpegQualityScale?.qualityScalesNormally);
  console.log('    TextMetrics                :', wClient.canvasDimsAndMetrics?.textMetrics);

  console.log('\n11. MediaCodecs:');
  console.log('    MediaSource WebM/VP9 (Win) :', wClient.mediaCodecs?.mediaSource?.['video/webm; codecs="vp9"']);
  console.log('    MediaSource WebM/VP9 (iOS) :', iClient.mediaCodecs?.mediaSource?.['video/webm; codecs="vp9"']);

  console.log('\n12. Worker importScripts:');
  console.log('    Worker Import UA           :', wClient.crossContext?.dedicatedWorker?.importScriptsResult?.userAgent);
  console.log('    Worker Import Platform     :', wClient.crossContext?.dedicatedWorker?.importScriptsResult?.platform);
  console.log('    Worker Import Headers UA   :', results.windows?.headers?.workerImportJs?.map?.['user-agent']);

  console.log('\n================================================================');
  console.log('Audit completed successfully.');
})();
