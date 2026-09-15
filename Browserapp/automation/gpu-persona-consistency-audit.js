#!/usr/bin/env node
'use strict';

/**
 * GPU & WebGL / WebGPU Persona Consistency Adversarial Audit
 * Red-Team Verification Perspective
 *
 * Exhaustive multi-persona consistency audit comparing:
 *  1. Native Stock Chromium Kernel Baseline (macOS host, Intel Mac + AMD W6800X, un-injected)
 *  2. Windows 10/11 Desktop Persona (Win32, D3D11 ANGLE, deviceProfile: 'persona')
 *  3. Windows 10/11 Desktop Default (Win32, deviceProfile: 'default')
 *  4. macOS Intel Desktop Persona (MacIntel, Metal Intel Iris / AMD)
 *  5. macOS Apple Silicon Desktop Persona (MacIntel, Metal Apple M-series)
 *  6. Linux Desktop Persona (Linux x86_64, Mesa/OpenGL 4.6 ANGLE)
 *  7. Android Mobile Persona (Linux armv8l, Adreno / Mali OpenGL ES)
 *  8. iOS Mobile Persona (iPhone, Apple GPU / WebKit)
 *
 * Core Evaluation Dimensions:
 *  - WebGL 1 & 2: VENDOR, RENDERER, UNMASKED_VENDOR, UNMASKED_RENDERER, MAX_TEXTURE_SIZE,
 *    MAX_RENDERBUFFER_SIZE, MAX_VIEWPORT_DIMS, MAX_UNIFORM_BLOCK_SIZE, UNIFORM_BUFFER_OFFSET_ALIGNMENT,
 *    Shader precisions (HIGH/MED/LOW for VERTEX & FRAGMENT), supported extensions
 *  - WebGPU: navigator.gpu existence, requestAdapter(), adapter.info (vendor/arch/device/desc),
 *    features, limits (BC vs ETC/ASTC texture compression)
 *  - Platform & Screen Alignment: navigator.platform, userAgent, userAgentData.platform,
 *    userAgentData.architecture, screen.width/height, colorDepth, pixelDepth, devicePixelRatio
 *  - Cross-Context Consistency: Main Frame vs iframe vs Worker (OffscreenCanvas)
 *  - Contradiction Detection: Win32+Metal, iOS+ANGLE, Linux+D3D11, Android+D3D11, Mobile+BC-only,
 *    NVIDIA 32k GPU clamped to 16k, Worker/Iframe host leakage
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
  WEBGL_PRESETS,
  HOST_WEBGL_LIMITS,
  HOST_WEBGL2_DEFAULTS,
  isPersonaWebglCompatible,
  compatiblePersonasForOs,
  resolveCompatiblePersona,
} = require('./fingerprint');
const {
  writeOpenBrowserKernelInit,
  mapFingerprintToInitFields,
  validateKernelInitInvariants,
} = require('./kernel-init-sync');
const {
  WINDOWS_PERSONAS,
  MACOS_PERSONAS,
  LINUX_PERSONAS,
  ANDROID_PERSONAS,
  personasForOs,
  pickPersona,
} = require('./device-personas');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const reportsDir = path.join(appRoot, '..', 'reports');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const IN_BROWSER_PROBE_SCRIPT = `(async () => {
  const out = {
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      vendor: navigator.vendor,
      appVersion: navigator.appVersion,
      maxTouchPoints: navigator.maxTouchPoints,
      userAgentData: null,
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
      devicePixelRatio: window.devicePixelRatio,
    },
    webgl: {},
    webgl2: {},
    webgpu: {},
    crossContext: {},
  };

  // 1. Client Hints (userAgentData)
  if (navigator.userAgentData) {
    try {
      const he = await navigator.userAgentData.getHighEntropyValues([
        'architecture', 'bitness', 'model', 'platformVersion', 'mobile'
      ]);
      out.identity.userAgentData = {
        platform: navigator.userAgentData.platform,
        mobile: navigator.userAgentData.mobile,
        brands: navigator.userAgentData.brands,
        highEntropy: he,
      };
    } catch (e) {
      out.identity.userAgentData = { error: String(e) };
    }
  } else {
    out.identity.userAgentData = { exists: false };
  }

  // 2. WebGL 1
  try {
    const c1 = document.createElement('canvas');
    const gl = c1.getContext('webgl') || c1.getContext('experimental-webgl');
    if (gl) {
      // Test direct call before getExtension
      let directUnmaskedVendor = null;
      let directUnmaskedRenderer = null;
      try { directUnmaskedVendor = gl.getParameter(0x9245); } catch (_) {}
      try { directUnmaskedRenderer = gl.getParameter(0x9246); } catch (_) {}

      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const unmaskedVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
      const unmaskedRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;

      const getPrec = (target, type) => {
        const p = gl.getShaderPrecisionFormat(target, type);
        return p ? { rangeMin: p.rangeMin, rangeMax: p.rangeMax, precision: p.precision } : null;
      };

      const exts = gl.getSupportedExtensions() || [];

      out.webgl = {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        unmaskedVendor,
        unmaskedRenderer,
        directCallBeforeExt: {
          unmaskedVendor: directUnmaskedVendor,
          unmaskedRenderer: directUnmaskedRenderer,
        },
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
        maxCubeMapTextureSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
        maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []),
        aliasedPointSizeRange: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || []),
        aliasedLineWidthRange: Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) || []),
        shaderPrecision: {
          vertexHigh: getPrec(gl.VERTEX_SHADER, gl.HIGH_FLOAT),
          vertexMedium: getPrec(gl.VERTEX_SHADER, gl.MEDIUM_FLOAT),
          vertexLow: getPrec(gl.VERTEX_SHADER, gl.LOW_FLOAT),
          fragmentHigh: getPrec(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT),
          fragmentMedium: getPrec(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT),
          fragmentLow: getPrec(gl.FRAGMENT_SHADER, gl.LOW_FLOAT),
        },
        extensionsCount: exts.length,
        supportedExtensions: exts,
        hasDebugRendererInfo: Boolean(dbg),
        vendorSpecificExtensions: {
          hasNv: exts.some(e => /^nv_/i.test(e)),
          hasAmd: exts.some(e => /^amd_/i.test(e)),
          hasIntel: exts.some(e => /^intel_/i.test(e)),
          hasQcom: exts.some(e => /^qcom_/i.test(e)),
          hasApple: exts.some(e => /^apple_/i.test(e)),
          hasS3tc: exts.some(e => /s3tc/i.test(e)),
          hasBptc: exts.some(e => /bptc/i.test(e)),
          hasRgtc: exts.some(e => /rgtc/i.test(e)),
          hasEtc1: exts.some(e => /etc1/i.test(e)),
          hasEtc: exts.some(e => /compressed_texture_etc\b/i.test(e)),
          hasAstc: exts.some(e => /astc/i.test(e)),
          hasPvrtc: exts.some(e => /pvrtc/i.test(e)),
        }
      };
    } else {
      out.webgl = { error: 'webgl context unavailable' };
    }
  } catch (e) {
    out.webgl = { error: String(e) };
  }

  // 3. WebGL 2
  try {
    const c2 = document.createElement('canvas');
    const gl2 = c2.getContext('webgl2');
    if (gl2) {
      const dbg2 = gl2.getExtension('WEBGL_debug_renderer_info');
      out.webgl2 = {
        vendor: gl2.getParameter(gl2.VENDOR),
        renderer: gl2.getParameter(gl2.RENDERER),
        unmaskedVendor: dbg2 ? gl2.getParameter(dbg2.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg2 ? gl2.getParameter(dbg2.UNMASKED_RENDERER_WEBGL) : null,
        maxTextureSize: gl2.getParameter(gl2.MAX_TEXTURE_SIZE),
        maxRenderbufferSize: gl2.getParameter(gl2.MAX_RENDERBUFFER_SIZE),
        maxUniformBlockSize: gl2.getParameter(gl2.MAX_UNIFORM_BLOCK_SIZE),
        uniformBufferOffsetAlignment: gl2.getParameter(gl2.UNIFORM_BUFFER_OFFSET_ALIGNMENT),
        maxVertexUniformBlocks: gl2.getParameter(gl2.MAX_VERTEX_UNIFORM_BLOCKS),
        maxFragmentUniformBlocks: gl2.getParameter(gl2.MAX_FRAGMENT_UNIFORM_BLOCKS),
        maxCombinedTextureImageUnits: gl2.getParameter(gl2.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      };
    } else {
      out.webgl2 = { error: 'webgl2 context unavailable' };
    }
  } catch (e) {
    out.webgl2 = { error: String(e) };
  }

  // 4. WebGPU
  try {
    if (navigator.gpu) {
      out.webgpu.exists = true;
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        out.webgpu.hasAdapter = true;
        let info = null;
        try { info = adapter.info; } catch (_) {}
        let reqInfo = null;
        try {
          if (typeof adapter.requestAdapterInfo === 'function') {
            reqInfo = await adapter.requestAdapterInfo();
          }
        } catch (_) {}

        out.webgpu.adapterInfo = {
          vendor: info?.vendor || reqInfo?.vendor || null,
          architecture: info?.architecture || reqInfo?.architecture || null,
          device: info?.device || reqInfo?.device || null,
          description: info?.description || reqInfo?.description || null,
        };
        const features = Array.from(adapter.features || []);
        out.webgpu.featuresCount = features.length;
        out.webgpu.features = features;
        out.webgpu.hasTextureCompressionBc = features.includes('texture-compression-bc');
        out.webgpu.hasTextureCompressionEtc2 = features.includes('texture-compression-etc2');
        out.webgpu.hasTextureCompressionAstc = features.includes('texture-compression-astc');
        out.webgpu.limits = {
          maxTextureDimension2D: adapter.limits?.maxTextureDimension2D,
          maxBufferSize: adapter.limits?.maxBufferSize,
          minUniformBufferOffsetAlignment: adapter.limits?.minUniformBufferOffsetAlignment,
        };
      } else {
        out.webgpu.hasAdapter = false;
      }
    } else {
      out.webgpu.exists = false;
    }
  } catch (e) {
    out.webgpu = { error: String(e) };
  }

  // 5. Cross-Context: Web Worker OffscreenCanvas WebGL
  try {
    const workerBlob = new Blob([\`
      self.onmessage = async () => {
        const wout = { webgl: null, webgpu: null };
        try {
          if (typeof OffscreenCanvas !== 'undefined') {
            const oc = new OffscreenCanvas(256, 256);
            const gl = oc.getContext('webgl');
            if (gl) {
              const dbg = gl.getExtension('WEBGL_debug_renderer_info');
              wout.webgl = {
                vendor: gl.getParameter(gl.VENDOR),
                renderer: gl.getParameter(gl.RENDERER),
                unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
                unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
                maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
              };
            }
          }
        } catch (e) {
          wout.webgl = { error: String(e) };
        }

        try {
          if (navigator.gpu) {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
              let info = null;
              try { info = adapter.info; } catch (_) {}
              wout.webgpu = {
                vendor: info?.vendor || null,
                architecture: info?.architecture || null,
                device: info?.device || null,
                description: info?.description || null,
              };
            } else {
              wout.webgpu = { hasAdapter: false };
            }
          } else {
            wout.webgpu = { exists: false };
          }
        } catch (e) {
          wout.webgpu = { error: String(e) };
        }

        self.postMessage(wout);
      };
    \`], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(workerBlob);
    const worker = new Worker(workerUrl);
    const workerPromise = new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = (e) => resolve({ error: e.message });
      setTimeout(() => resolve({ timeout: true }), 3000);
    });
    worker.postMessage({});
    out.crossContext.worker = await workerPromise;
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
  } catch (e) {
    out.crossContext.worker = { error: String(e) };
  }

  // 6. Cross-Context: iframe about:blank
  try {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const iWin = iframe.contentWindow;
    if (iWin) {
      const iCanvas = iWin.document.createElement('canvas');
      const igl = iCanvas.getContext('webgl');
      if (igl) {
        const idbg = igl.getExtension('WEBGL_debug_renderer_info');
        out.crossContext.iframeAboutBlank = {
          vendor: igl.getParameter(igl.VENDOR),
          renderer: igl.getParameter(igl.RENDERER),
          unmaskedVendor: idbg ? igl.getParameter(idbg.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: idbg ? igl.getParameter(idbg.UNMASKED_RENDERER_WEBGL) : null,
        };
      }
    }
    iframe.remove();
  } catch (e) {
    out.crossContext.iframeAboutBlank = { error: String(e) };
  }

  return out;
})()`;

class AuditServer {
  constructor() {
    this.server = null;
    this.port = 0;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>GPU Persona Audit</title></head><body><h1>GPU Audit Surface</h1></body></html>`);
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
  }

  async stop() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }
}

async function runSession(scenario, serverPort) {
  const { name, profile, isInject } = scenario;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-gpu-audit-${profile.id}-`));
  const fp = isInject ? buildFingerprint(profile) : null;

  const launchArgs = [
    dir,
    '--headless=new',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--disable-popup-blocking',
  ];

  if (isInject) {
    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile,
      templatePath: path.join(kernelRoot, 'init_template.json'),
    });
    const fpChromeArgs = chromeArgsForFingerprint(fp, profile);
    for (const arg of fpChromeArgs) {
      if (!launchArgs.includes(arg)) launchArgs.push(arg);
    }
  } else {
    fs.copyFileSync(path.join(kernelRoot, 'init_template.json'), path.join(dir, 'init.json'));
  }

  const child = spawn(launcher, launchArgs, {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let devPort = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(200);
    try {
      const p = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (p > 0) { devPort = p; break; }
    } catch (_) {}
  }

  const stop = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  };

  if (!devPort) {
    stop();
    return { name, error: 'DevToolsActivePort acquisition failed' };
  }

  let probeResult = null;
  let connection = null;
  const workerAttachLog = [];

  try {
    const v = await (await fetch(`http://127.0.0.1:${devPort}/json/version`)).json();
    // Mirror engine.js startWorkerFingerprintInjection: dedicated workers in Chromium 148
    // are NOT browser-level auto-attach targets. They only surface via a page-session
    // Target.setAutoAttach (set below), whose attachedToTarget events route back to this
    // connection in flatten mode. Without this, Blob-URL dedicated workers run un-injected
    // and leak the host GPU through OffscreenCanvas WebGL.
    const workerTypes = new Set(['worker', 'shared_worker', 'service_worker']);
    const internalWorkerUrl = /^(chrome|chrome-extension|edge|edge-extension|devtools):/i;
    const workerSource = isInject ? buildWorkerInjectionScript(fp) : null;
    const onEvent = async (event) => {
      if (event?.method !== 'Target.attachedToTarget') return;
      const { sessionId: wSessionId, targetInfo = {}, waitingForDebugger } = event.params || {};
      if (!wSessionId) return;
      try {
        if (workerTypes.has(targetInfo.type) && workerSource && !internalWorkerUrl.test(String(targetInfo.url || ''))) {
          workerAttachLog.push({ type: targetInfo.type, url: String(targetInfo.url || '').slice(0, 80) });
          await connection.command('Runtime.evaluate', { expression: workerSource }, { sessionId: wSessionId, timeout: 8000 })
            .catch((e) => workerAttachLog.push({ injectError: String(e?.message || e) }));
        }
      } finally {
        if (waitingForDebugger) {
          await connection.command('Runtime.runIfWaitingForDebugger', {}, { sessionId: wSessionId }).catch(() => {});
        }
      }
    };
    connection = await cdp.connect(v.webSocketDebuggerUrl, { timeout: 8000, onEvent });

    let targetId = null;
    for (let i = 0; i < 20; i += 1) {
      const targetList = await cdp.targets(devPort);
      const pageTarget = targetList.find((t) => t.type === 'page');
      if (pageTarget) {
        targetId = pageTarget.id;
        break;
      }
      await sleep(200);
    }
    if (!targetId) throw new Error('No page target found');

    const attached = await connection.command('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.sessionId;

    await connection.command('Page.enable', {}, { sessionId });
    await connection.command('Runtime.enable', {}, { sessionId });

    if (isInject) {
      // Page-session nested auto-attach so dedicated/shared workers under this page
      // pause on start and receive the worker fingerprint script (engine.js parity).
      await connection.command('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      }, { sessionId }).catch(() => {});
      await applyFingerprintToTab(async (method, params) => {
        return connection.command(method, params, { sessionId, timeout: 30000 });
      }, null, fp, profile, { applyKey: sessionId });
    }

    await connection.command('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` }, { sessionId });
    await sleep(2000);

    const evalRes = await connection.command('Runtime.evaluate', {
      expression: IN_BROWSER_PROBE_SCRIPT,
      awaitPromise: true,
      returnByValue: true,
    }, { sessionId, timeout: 15000 });

    probeResult = evalRes?.result?.value || { error: evalRes?.exceptionDetails || 'Evaluation failed' };

  } catch (err) {
    probeResult = { error: String(err) };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
    stop();
  }

  return {
    name,
    isInject,
    workerAttachLog,
    profile,
    fingerprintResolved: fp ? {
      os: fp.os,
      platform: fp.platform,
      userAgent: fp.userAgent,
      webgl: {
        vendor: fp.webgl?.vendor,
        renderer: fp.webgl?.renderer,
        metaMode: fp.webgl?.metaMode,
        mode: fp.webgl?.mode,
        gpu: fp.webgl?.gpu,
        limits: fp.webgl?.limits,
      },
      webgpu: fp.webgpu,
      screen: fp.screen,
    } : null,
    inBrowserProbe: probeResult,
  };
}

/**
 * Rules for detecting cross-platform GPU / Persona contradictions
 */
function evaluateContradictions(sessionResult) {
  const issues = [];
  const p = sessionResult.inBrowserProbe;
  if (!p || p.error) {
    issues.push({ level: 'FATAL', code: 'PROBE_FAILED', message: `In-browser probe failed: ${p?.error}` });
    return issues;
  }

  const ua = p.identity?.userAgent || '';
  const platform = p.identity?.platform || '';
  const uadPlatform = p.identity?.userAgentData?.platform || '';
  const uadArch = p.identity?.userAgentData?.highEntropy?.architecture || '';
  const uadMobile = p.identity?.userAgentData?.mobile;
  const glVendor = p.webgl?.unmaskedVendor || '';
  const glRenderer = p.webgl?.unmaskedRenderer || '';
  const gpuVendor = p.webgpu?.adapterInfo?.vendor || '';
  const gpuArch = p.webgpu?.adapterInfo?.architecture || '';
  const gpuDesc = p.webgpu?.adapterInfo?.description || '';
  const dpr = p.screen?.devicePixelRatio;
  const screenW = p.screen?.width;
  const screenH = p.screen?.height;

  // 1. Windows Contradictions
  if (platform === 'Win32' || /Windows NT/i.test(ua)) {
    if (/Metal/i.test(glRenderer) || /Apple/i.test(glRenderer) || /Apple/i.test(glVendor)) {
      issues.push({
        level: 'P0',
        code: 'WIN32_WITH_METAL_OR_APPLE_GPU',
        message: `Windows platform (Win32) claims Apple Metal / Apple GPU: vendor="${glVendor}", renderer="${glRenderer}"`,
        detectionLine: `navigator.platform === 'Win32' && /Metal|Apple/i.test(gl.getParameter(0x9246))`,
      });
    }
    if (/Mesa|OpenGL\s+4\./i.test(glRenderer)) {
      issues.push({
        level: 'P0',
        code: 'WIN32_WITH_MESA_OPENGL',
        message: `Windows platform (Win32) claims Linux Mesa/OpenGL renderer: "${glRenderer}"`,
        detectionLine: `navigator.platform === 'Win32' && /Mesa|radeonsi/i.test(gl.getParameter(0x9246))`,
      });
    }
    if (!/Direct3D11|D3D11/i.test(glRenderer) && !/Vulkan/i.test(glRenderer)) {
      issues.push({
        level: 'P1',
        code: 'WIN32_MISSING_D3D11_BACKEND',
        message: `Windows Chrome ANGLE renderer typically specifies Direct3D11/D3D11, found: "${glRenderer}"`,
        detectionLine: `navigator.platform === 'Win32' && !/Direct3D11|D3D11/i.test(gl.getParameter(0x9246))`,
      });
    }
    if (/Metal/i.test(gpuDesc) || /apple/i.test(gpuVendor)) {
      issues.push({
        level: 'P0',
        code: 'WIN32_WEBGPU_LEAKING_METAL',
        message: `WebGPU adapter leaks Apple Metal on Windows: vendor="${gpuVendor}", desc="${gpuDesc}"`,
        detectionLine: `navigator.platform === 'Win32' && /metal|apple/i.test(adapter.info.vendor + adapter.info.description)`,
      });
    }
  }

  // 2. macOS Contradictions
  if (platform === 'MacIntel' || /Macintosh/i.test(ua)) {
    if (/Direct3D|D3D11/i.test(glRenderer)) {
      issues.push({
        level: 'P0',
        code: 'MAC_WITH_D3D11',
        message: `macOS platform claims Windows Direct3D11 renderer: "${glRenderer}"`,
        detectionLine: `navigator.platform === 'MacIntel' && /Direct3D/i.test(gl.getParameter(0x9246))`,
      });
    }
    if (/Mesa|RADV/i.test(glRenderer)) {
      issues.push({
        level: 'P0',
        code: 'MAC_WITH_MESA',
        message: `macOS platform claims Linux Mesa renderer: "${glRenderer}"`,
        detectionLine: `navigator.platform === 'MacIntel' && /Mesa|RADV/i.test(gl.getParameter(0x9246))`,
      });
    }
    if (!/Metal/i.test(glRenderer)) {
      issues.push({
        level: 'P1',
        code: 'MAC_MISSING_METAL_RENDERER',
        message: `Modern Chrome on macOS (111+) exclusively uses ANGLE Metal Renderer, found: "${glRenderer}"`,
        detectionLine: `navigator.platform === 'MacIntel' && !/Metal/i.test(gl.getParameter(0x9246))`,
      });
    }
    // Check Intel Mac vs Apple Silicon GPU
    if (uadArch === 'x86' && /Apple\s+M[1-4]/i.test(glRenderer)) {
      issues.push({
        level: 'P0',
        code: 'INTEL_MAC_WITH_APPLE_SILICON_GPU',
        message: `Architecture is x86 (Intel Mac) but WebGL claims Apple Silicon GPU: "${glRenderer}"`,
        detectionLine: `(await navigator.userAgentData.getHighEntropyValues(['architecture'])).architecture === 'x86' && /Apple M/i.test(gl.getParameter(0x9246))`,
      });
    }
  }

  // 3. Linux Contradictions
  if (platform === 'Linux x86_64' || (/Linux/i.test(ua) && !/Android/i.test(ua))) {
    if (/Direct3D|D3D11|Metal|Apple/i.test(glRenderer)) {
      issues.push({
        level: 'P0',
        code: 'LINUX_WITH_NON_LINUX_GPU',
        message: `Linux platform claims Windows D3D11 or Apple Metal: "${glRenderer}"`,
        detectionLine: `navigator.platform === 'Linux x86_64' && /Direct3D|Metal|Apple/i.test(gl.getParameter(0x9246))`,
      });
    }
    if (!/OpenGL|Mesa|Vulkan/i.test(glRenderer)) {
      issues.push({
        level: 'P1',
        code: 'LINUX_MISSING_OPENGL_OR_MESA',
        message: `Linux Chrome ANGLE renderer typically specifies OpenGL/Mesa/Vulkan, found: "${glRenderer}"`,
        detectionLine: `navigator.platform === 'Linux x86_64' && !/OpenGL|Mesa/i.test(gl.getParameter(0x9246))`,
      });
    }
  }

  // 4. Android Mobile Contradictions
  if (platform === 'Linux armv8l' || /Android/i.test(ua)) {
    if (/Direct3D|D3D11|Metal|Apple/i.test(glRenderer)) {
      issues.push({
        level: 'P0',
        code: 'ANDROID_WITH_DESKTOP_OR_APPLE_GPU',
        message: `Android mobile claims desktop Direct3D11 or Apple Metal: "${glRenderer}"`,
        detectionLine: `/Android/i.test(navigator.userAgent) && /Direct3D|Metal|Apple/i.test(gl.getParameter(0x9246))`,
      });
    }
    if (/NVIDIA|GeForce|RTX|GTX|Arc\(TM\)|Iris\(R\)/i.test(glRenderer)) {
      issues.push({
        level: 'P0',
        code: 'ANDROID_WITH_DESKTOP_GPU_CHIP',
        message: `Android mobile claims desktop discrete GPU (NVIDIA/Intel Arc): "${glRenderer}"`,
        detectionLine: `/Android/i.test(navigator.userAgent) && /GeForce|RTX|Arc/i.test(gl.getParameter(0x9246))`,
      });
    }
    if (dpr < 2) {
      issues.push({
        level: 'P1',
        code: 'ANDROID_ABNORMAL_DPR',
        message: `Android mobile devices typically have DPR >= 2.0 (Retina/OLED), found DPR=${dpr}`,
        detectionLine: `/Android/i.test(navigator.userAgent) && window.devicePixelRatio < 2`,
      });
    }
  }

  // 5. iOS Mobile Contradictions
  if (platform === 'iPhone' || platform === 'iPad' || /iPhone|iPad/i.test(ua)) {
    if (/ANGLE/i.test(glRenderer)) {
      issues.push({
        level: 'P0',
        code: 'IOS_WITH_ANGLE_RENDERER',
        message: `iOS WebKit/Safari exclusively exposes "Apple GPU" without ANGLE prefix, found: "${glRenderer}"`,
        detectionLine: `/iPhone/i.test(navigator.userAgent) && /ANGLE/i.test(gl.getParameter(0x9246))`,
      });
    }
    if (/Google Inc\./i.test(glVendor)) {
      issues.push({
        level: 'P0',
        code: 'IOS_WITH_GOOGLE_VENDOR',
        message: `iOS WebKit exclusively exposes "Apple Inc." or "Apple" vendor, found: "${glVendor}"`,
        detectionLine: `/iPhone/i.test(navigator.userAgent) && /Google Inc/i.test(gl.getParameter(0x9245))`,
      });
    }
    if (p.webgpu?.exists === true) {
      issues.push({
        level: 'P0',
        code: 'IOS_UNEXPECTED_WEBGPU_EXPOSURE',
        message: `iOS WebKit does not enable WebGPU by default in standard browser sessions, but navigator.gpu exists`,
        detectionLine: `/iPhone/i.test(navigator.userAgent) && 'gpu' in navigator`,
      });
    }
    if (dpr < 2 || (screenW > 500 && screenH > 1000 && dpr < 2)) {
      issues.push({
        level: 'P0',
        code: 'IOS_DESKTOP_SCREEN_OR_LOW_DPR',
        message: `iOS iPhone persona has desktop screen or low DPR: ${screenW}x${screenH} DPR=${dpr}`,
        detectionLine: `/iPhone/i.test(navigator.userAgent) && (screen.width > 500 || window.devicePixelRatio < 2)`,
      });
    }
  }

  // 6. Cross-Context Leakage (Worker / iframe)
  const workerGl = p.crossContext?.worker?.webgl;
  if (workerGl && !workerGl.error) {
    if (/W6800X/i.test(workerGl.unmaskedRenderer) && !/W6800X/i.test(glRenderer)) {
      issues.push({
        level: 'P0',
        code: 'WORKER_HOST_GPU_LEAKAGE',
        message: `Web Worker OffscreenCanvas leaked host GPU (AMD W6800X) while main frame spoofed: "${workerGl.unmaskedRenderer}"`,
        detectionLine: `workerGl.unmaskedRenderer.includes('W6800X') && !mainGl.unmaskedRenderer.includes('W6800X')`,
      });
    }
  }

  const iframeGl = p.crossContext?.iframeAboutBlank;
  if (iframeGl && !iframeGl.error) {
    if (/W6800X/i.test(iframeGl.unmaskedRenderer) && !/W6800X/i.test(glRenderer)) {
      issues.push({
        level: 'P0',
        code: 'IFRAME_HOST_GPU_LEAKAGE',
        message: `about:blank iframe leaked host GPU (AMD W6800X) while main frame spoofed: "${iframeGl.unmaskedRenderer}"`,
        detectionLine: `iframeGl.unmaskedRenderer.includes('W6800X') && !mainGl.unmaskedRenderer.includes('W6800X')`,
      });
    }
  }

  return issues;
}

(async () => {
  console.log('======================================================================');
  console.log('OpenBrowser GPU & WebGL / WebGPU Persona Consistency Audit');
  console.log('Testing Platform Consistency across Windows, macOS, Linux, Android, iOS');
  console.log('======================================================================\n');

  const server = new AuditServer();
  await server.start();
  console.log(`[AuditServer] Running on http://127.0.0.1:${server.port}`);

  const scenarios = [
    // 1. Baseline
    {
      name: 'Stock Baseline (Un-injected macOS Kernel)',
      profile: { id: 'audit-baseline', name: 'Baseline Stock' },
      isInject: false,
    },
    // 2. Windows 10/11 Desktop Persona
    {
      name: 'Windows 10/11 Desktop (deviceProfile: persona)',
      profile: {
        id: 'audit-win-persona',
        os: 'Windows',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        kernelVersion: '148.0.7778.165',
        fingerprintLaunchSeed: 'seed-win-gpu-77',
        canvas: 'noise',
        webgl: 'noise',
        privacy: {
          deviceProfile: 'persona',
          timezone: 'America/New_York',
          languages: ['en-US', 'en'],
        },
      },
      isInject: true,
    },
    // 3. Windows 10/11 Desktop Default (deviceProfile: default)
    {
      name: 'Windows 10/11 Desktop (deviceProfile: default)',
      profile: {
        id: 'audit-win-default',
        os: 'Windows',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        kernelVersion: '148.0.7778.165',
        fingerprintLaunchSeed: 'seed-win-gpu-88',
        canvas: 'noise',
        webgl: 'noise',
        privacy: {
          timezone: 'America/New_York',
          languages: ['en-US', 'en'],
        },
      },
      isInject: true,
    },
    // 4. macOS Intel Desktop Persona
    {
      name: 'macOS Intel Desktop (deviceProfile: persona)',
      profile: {
        id: 'audit-mac-intel-persona',
        os: 'macOS',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        kernelVersion: '148.0.7778.165',
        fingerprintLaunchSeed: 'seed-mac-intel-gpu-12',
        canvas: 'noise',
        webgl: 'noise',
        privacy: {
          deviceProfile: 'persona',
          timezone: 'America/Los_Angeles',
          languages: ['en-US', 'en'],
        },
      },
      isInject: true,
    },
    // 5. macOS Apple Silicon Desktop Persona
    {
      name: 'macOS Apple Silicon Desktop (deviceProfile: persona)',
      profile: {
        id: 'audit-mac-arm-persona',
        os: 'macos_arm',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        kernelVersion: '148.0.7778.165',
        fingerprintLaunchSeed: 'seed-mac-arm-gpu-33',
        canvas: 'noise',
        webgl: 'noise',
        clientHints: {
          architecture: 'arm',
          bitness: '64',
          model: '',
          platform: 'macOS',
          platformVersion: '14.5.0',
        },
        privacy: {
          deviceProfile: 'persona',
          timezone: 'America/Los_Angeles',
          languages: ['en-US', 'en'],
        },
      },
      isInject: true,
    },
    // 6. Linux Desktop Persona
    {
      name: 'Linux Desktop Persona (deviceProfile: persona)',
      profile: {
        id: 'audit-linux-persona',
        os: 'Linux',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        kernelVersion: '148.0.7778.165',
        fingerprintLaunchSeed: 'seed-linux-gpu-55',
        canvas: 'noise',
        webgl: 'noise',
        privacy: {
          deviceProfile: 'persona',
          timezone: 'Europe/Berlin',
          languages: ['de-DE', 'en'],
        },
      },
      isInject: true,
    },
    // 7. Android Mobile Persona
    {
      name: 'Android Mobile Persona (deviceProfile: persona)',
      profile: {
        id: 'audit-android-persona',
        os: 'Android',
        kernelVersion: '148.0.7778.165',
        fingerprintLaunchSeed: 'seed-android-gpu-66',
        canvas: 'noise',
        webgl: 'noise',
        privacy: {
          deviceProfile: 'persona',
          timezone: 'America/Chicago',
          languages: ['en-US', 'en'],
        },
      },
      isInject: true,
    },
    // 8. iOS Mobile Persona
    {
      name: 'iOS Mobile Persona (deviceProfile: persona)',
      profile: {
        id: 'audit-ios-persona',
        os: 'iOS',
        kernelVersion: '148.0.7778.165',
        fingerprintLaunchSeed: 'seed-ios-gpu-99',
        canvas: 'noise',
        webgl: 'noise',
        privacy: {
          deviceProfile: 'persona',
          timezone: 'America/New_York',
          languages: ['en-US', 'en'],
        },
      },
      isInject: true,
    },
  ];

  const auditResults = [];

  for (let i = 0; i < scenarios.length; i += 1) {
    const sc = scenarios[i];
    console.log(`\n>>> [Scenario ${i + 1}/${scenarios.length}] Running: ${sc.name} ...`);
    const sessionRes = await runSession(sc, server.port);
    sessionRes.issues = evaluateContradictions(sessionRes);
    auditResults.push(sessionRes);

    const p = sessionRes.inBrowserProbe;
    if (p && !p.error) {
      console.log(`    Platform: ${p.identity?.platform} | UA: ${p.identity?.userAgent?.slice(0, 55)}...`);
      console.log(`    WebGL Unmasked: ${p.webgl?.unmaskedVendor} | ${p.webgl?.unmaskedRenderer}`);
      console.log(`    WebGPU Adapter: ${p.webgpu?.adapterInfo?.vendor || 'N/A'} | ${p.webgpu?.adapterInfo?.architecture || 'N/A'} (desc: ${p.webgpu?.adapterInfo?.description || 'N/A'})`);
      console.log(`    Screen: ${p.screen?.width}x${p.screen?.height} DPR=${p.screen?.devicePixelRatio}`);
      console.log(`    Contradictions Detected: ${sessionRes.issues.length}`);
      for (const issue of sessionRes.issues) {
        console.log(`      [${issue.level}] ${issue.code}: ${issue.message}`);
      }
    } else {
      console.log(`    Execution error: ${sessionRes.error || p?.error}`);
    }
  }

  await server.stop();

  // Save Raw Dump
  const rawPath = path.join(reportsDir, 'gpu-persona-consistency-raw.json');
  fs.writeFileSync(rawPath, JSON.stringify(auditResults, null, 2), 'utf8');
  console.log(`\n[Audit Complete] Raw results written to: ${rawPath}`);

  // Summary counts
  let totalP0 = 0;
  let totalP1 = 0;
  for (const r of auditResults) {
    for (const is of r.issues || []) {
      if (is.level === 'P0') totalP0 += 1;
      if (is.level === 'P1') totalP1 += 1;
    }
  }
  console.log(`\nSummary: Scenarios tested: ${auditResults.length}, P0 Contradictions: ${totalP0}, P1 Contradictions: ${totalP1}`);
})();
