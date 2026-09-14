#!/usr/bin/env node
'use strict';

/**
 * Desktop Persona Consistency Audit (Linux & Windows vs macOS Baseline)
 * Red-Team Adversarial Perspective
 *
 * Exhaustive A/B/C adversarial consistency audit comparing:
 *  1. Native Stock Chromium Kernel Baseline (macOS host, un-injected)
 *  2. Linux Desktop Persona (Linux x86_64, Chrome 148, Mesa Intel GPU, Europe/London, en-GB)
 *  3. Windows Desktop Persona (Win32 / Windows NT 10.0, Chrome 148, Intel D3D11 GPU, America/New_York, en-US)
 *
 * Covers 6 core domains:
 *  1. Identity & Navigator (UA, platform, vendor, Client Hints, cores, memory, languages, timezone)
 *  2. Screen & Hardware (panel size, DPR, matchMedia pointer/hover/resolution, colorDepth/pixelDepth, dynamic-range/color-gamut)
 *  3. GPU & Fonts (WebGL vendor/renderer, shader precision 127/127/23, WebGL2 limits, font family detection & cross-platform leakage)
 *  4. Wire Layer (HTTP headers on navigation/fetch/worker vs JS userAgentData, Accept-Language q-values, sec-ch-ua* ordering)
 *  5. Media & Speech (mediaDevices.enumerateDevices labels, speechSynthesis voice platform isolation)
 *  6. Kernel Init Mapping (kernel-init-sync mapFingerprintToInitFields, invariants, WebRTC media labels, detectOs accuracy)
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
  mapPlatformToSubsetKey,
} = require('./fingerprint');
const {
  writeOpenBrowserKernelInit,
  mapFingerprintToInitFields,
  validateKernelInitInvariants,
  detectOs,
  detectInitOs,
  MEDIA_POOLS_BY_OS,
} = require('./kernel-init-sync');
const { RequestHeaderRewriter } = require('../engine');
const { fontsForOs, exclusiveFontsForOtherOs, pickPersona, OS_FONTS } = require('./device-personas');

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
      mainFetch: null,
      clientHintsFetch: null,
      iframeDoc: null,
      workerFetch: null,
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

      if (p === '/api/fetch') {
        this.recordedRequests.mainFetch = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, source: 'mainFetch' }));
        return;
      }

      if (p === '/api/opt-in-ch') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Accept-CH': 'sec-ch-ua-arch, sec-ch-ua-bitness, sec-ch-ua-full-version, sec-ch-ua-full-version-list, sec-ch-ua-model, sec-ch-ua-platform-version, sec-ch-ua-form-factors, sec-ch-ua-wow64',
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
        res.end('<!doctype html><html><body><h1>Desktop Iframe Subpage</h1></body></html>');
        return;
      }

      if (p === '/worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(this.getWorkerJs());
        return;
      }

      if (p === '/api/worker-fetch') {
        this.recordedRequests.workerFetch = extractRawHeaders(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, source: 'workerFetch' }));
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
            const he = await (navigator.userAgentData.getHighEntropyValues
              ? navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'wow64', 'formFactors'])
              : Promise.resolve(null));
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
          workerFetchResp
        };

        self.postMessage(report);
      };
    `;
  }

  getMainHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Desktop Persona Consistency Audit</title>
</head>
<body>
  <h1>Desktop Persona In-Browser Probe</h1>
  <script>
    (async () => {
      const out = {};

      // ============================================================
      // 1. Identity & Navigator
      // ============================================================
      out.identity = {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        vendor: navigator.vendor,
        appVersion: navigator.appVersion,
        maxTouchPoints: navigator.maxTouchPoints,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        languages: Array.from(navigator.languages || []),
        language: navigator.language,
        languagesIdentity: navigator.languages === navigator.languages,
        languagesFrozen: Object.isFrozen(navigator.languages),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dateOffset: new Date().getTimezoneOffset(),
        dateProtoWritable: Object.getOwnPropertyDescriptor(Date, 'prototype')?.writable,
        intlProtoWritable: Object.getOwnPropertyDescriptor(Intl.DateTimeFormat, 'prototype')?.writable,
        dateOwnPropertyNames: Object.getOwnPropertyNames(Date),
      };

      // Client Hints in JS
      if (navigator.userAgentData) {
        let he = null;
        try {
          he = await navigator.userAgentData.getHighEntropyValues([
            'model', 'platformVersion', 'architecture', 'bitness', 'mobile', 'wow64', 'formFactors'
          ]);
        } catch (e) {
          he = { error: String(e) };
        }
        out.identity.userAgentData = {
          exists: true,
          platform: navigator.userAgentData.platform,
          mobile: navigator.userAgentData.mobile,
          brands: navigator.userAgentData.brands,
          instanceofNavigatorUAData: typeof NavigatorUAData !== 'undefined' && navigator.userAgentData instanceof NavigatorUAData,
          highEntropy: he
        };
      } else {
        out.identity.userAgentData = { exists: false };
      }

      // ============================================================
      // 2. Screen & Hardware Geometry
      // ============================================================
      const dpr = window.devicePixelRatio;
      out.screenAndHardware = {
        screenWidth: screen.width,
        screenHeight: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        availLeft: screen.availLeft,
        availTop: screen.availTop,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
        devicePixelRatio: dpr,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        visualViewport: {
          scale: window.visualViewport?.scale,
          width: window.visualViewport?.width,
          height: window.visualViewport?.height,
          offsetLeft: window.visualViewport?.offsetLeft,
          offsetTop: window.visualViewport?.offsetTop,
        },
        matchMedia: {
          pointerFine: matchMedia('(pointer: fine)').matches,
          pointerCoarse: matchMedia('(pointer: coarse)').matches,
          pointerNone: matchMedia('(pointer: none)').matches,
          hoverHover: matchMedia('(hover: hover)').matches,
          hoverNone: matchMedia('(hover: none)').matches,
          anyPointerFine: matchMedia('(any-pointer: fine)').matches,
          anyPointerCoarse: matchMedia('(any-pointer: coarse)').matches,
          anyHoverHover: matchMedia('(any-hover: hover)').matches,
          res1dppx: matchMedia('(resolution: 1dppx)').matches,
          res2dppx: matchMedia('(resolution: 2dppx)').matches,
          resDprDppx: matchMedia('(resolution: ' + dpr + 'dppx)').matches,
          resDprExact: matchMedia('(resolution: ' + Number(dpr.toFixed(3)) + 'dppx)').matches,
          dynamicRangeHigh: matchMedia('(dynamic-range: high)').matches,
          dynamicRangeStandard: matchMedia('(dynamic-range: standard)').matches,
          colorGamutSrgb: matchMedia('(color-gamut: srgb)').matches,
          colorGamutP3: matchMedia('(color-gamut: p3)').matches,
          colorGamutRec2020: matchMedia('(color-gamut: rec2020)').matches,
          forcedColorsActive: matchMedia('(forced-colors: active)').matches,
          forcedColorsNone: matchMedia('(forced-colors: none)').matches,
          prefersColorSchemeDark: matchMedia('(prefers-color-scheme: dark)').matches,
          prefersColorSchemeLight: matchMedia('(prefers-color-scheme: light)').matches,
        }
      };

      // ============================================================
      // 3. Media & Speech
      // ============================================================
      out.mediaAndSpeech = {};

      // 3.1 MediaDevices
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
          const devs = await navigator.mediaDevices.enumerateDevices();
          const unauthorizedLabels = devs.map(d => d.label).filter(l => l && l.length > 0);
          out.mediaAndSpeech.devices = {
            total: devs.length,
            kinds: devs.map(d => d.kind),
            audioInputCount: devs.filter(d => d.kind === 'audioinput').length,
            audioOutputCount: devs.filter(d => d.kind === 'audiooutput').length,
            videoInputCount: devs.filter(d => d.kind === 'videoinput').length,
            unauthorizedLabelsExposed: unauthorizedLabels,
            hasLabelsLeak: unauthorizedLabels.length > 0,
          };
        } else {
          out.mediaAndSpeech.devices = 'unavailable';
        }
      } catch (e) {
        out.mediaAndSpeech.devices = { error: String(e) };
      }

      // 3.2 SpeechSynthesis
      try {
        if ('speechSynthesis' in window) {
          let voices = window.speechSynthesis.getVoices();
          if (!voices || !voices.length) {
            await new Promise((r) => {
              window.speechSynthesis.onvoiceschanged = () => r();
              setTimeout(r, 400);
            });
            voices = window.speechSynthesis.getVoices() || [];
          }

          const voiceNames = voices.map(v => v.name);
          const hasWindowsVoice = voiceNames.some(n => /microsoft|david|zira|mark|george|susan|yaoyao|kangkang/i.test(n));
          const hasMacVoice = voiceNames.some(n => /alex|samantha|victoria|fred|ting-ting|sin-ji|kyoko|yuna|xander/i.test(n));
          const hasGoogleVoice = voiceNames.some(n => /google/i.test(n));
          const sampleVoice = voices[0] || null;

          out.mediaAndSpeech.speech = {
            count: voices.length,
            hasWindowsVoice,
            hasMacVoice,
            hasGoogleVoice,
            sampleVoices: voices.slice(0, 5).map(v => ({ name: v.name, lang: v.lang, default: v.default, localService: v.localService })),
            allVoiceNames: voiceNames,
            firstVoiceProtoCheck: sampleVoice ? {
              instanceofSpeechSynthesisVoice: typeof SpeechSynthesisVoice !== 'undefined' && sampleVoice instanceof SpeechSynthesisVoice,
              ownKeys: Object.getOwnPropertyNames(sampleVoice)
            } : null
          };
        } else {
          out.mediaAndSpeech.speech = 'unavailable';
        }
      } catch (e) {
        out.mediaAndSpeech.speech = { error: String(e) };
      }

      // ============================================================
      // 4. GPU (WebGL & WebGPU)
      // ============================================================
      out.gpu = {};
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        const gl2 = c.getContext('webgl2');
        if (gl) {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          const unmaskedVendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null;
          const unmaskedRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;

          const getPrec = (target, type) => {
            const p = gl.getShaderPrecisionFormat(target, type);
            return p ? { rangeMin: p.rangeMin, rangeMax: p.rangeMax, precision: p.precision } : null;
          };

          out.gpu.webgl = {
            unmaskedVendor,
            unmaskedRenderer,
            maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
            maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || []),
            aliasedPointSizeRange: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || []),
            vertexHighp: getPrec(gl.VERTEX_SHADER, gl.HIGH_FLOAT),
            vertexMediump: getPrec(gl.VERTEX_SHADER, gl.MEDIUM_FLOAT),
            vertexLowp: getPrec(gl.VERTEX_SHADER, gl.LOW_FLOAT),
            fragmentHighp: getPrec(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT),
            fragmentMediump: getPrec(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT),
            fragmentLowp: getPrec(gl.FRAGMENT_SHADER, gl.LOW_FLOAT),
            webgl2: gl2 ? {
              uniformBufferOffsetAlignment: gl2.getParameter(gl2.UNIFORM_BUFFER_OFFSET_ALIGNMENT || 0x8A34),
              maxUniformBlockSize: gl2.getParameter(gl2.MAX_UNIFORM_BLOCK_SIZE || 0x8A30),
            } : 'webgl2-unavailable'
          };
        } else {
          out.gpu.webgl = 'webgl-unavailable';
        }
      } catch (e) {
        out.gpu.webgl = { error: String(e) };
      }

      // WebGPU
      try {
        if (navigator.gpu) {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
            out.gpu.webgpu = {
              exists: true,
              vendor: info?.vendor,
              architecture: info?.architecture,
              device: info?.device,
              description: info?.description,
              features: Array.from(adapter.features || []),
              limits: {
                minUniformBufferOffsetAlignment: adapter.limits?.minUniformBufferOffsetAlignment,
                maxTextureDimension2D: adapter.limits?.maxTextureDimension2D,
                maxComputeWorkgroupSizeX: adapter.limits?.maxComputeWorkgroupSizeX,
                maxBufferSize: adapter.limits?.maxBufferSize
              }
            };
          } else {
            out.gpu.webgpu = { exists: true, adapter: null };
          }
        } else {
          out.gpu.webgpu = { exists: false };
        }
      } catch (e) {
        out.gpu.webgpu = { error: String(e) };
      }

      // ============================================================
      // 5. Fonts (Probing & Cross-Platform Leakage)
      // ============================================================
      out.fonts = {};
      try {
        const testFamilies = [
          // Linux native fonts
          'Ubuntu', 'DejaVu Sans', 'Liberation Sans', 'FreeSans', 'Cantarell', 'Nimbus Sans',
          // Windows native fonts
          'Segoe UI', 'Calibri', 'Bahnschrift', 'Cambria', 'Consolas', 'Arial', 'Times New Roman',
          // macOS native fonts (Host)
          'PingFang SC', 'Menlo', 'Monaco', 'Helvetica Neue', 'Apple Color Emoji', 'Apple Symbols'
        ];

        const c = document.createElement('canvas');
        const ctx = c.getContext('2d');
        const probeText = 'mmmmmmmmmmlliWWWWWWWWW@@@@@@@@@@1234567890';
        ctx.font = '72px monospace';
        const monoW = Math.round(ctx.measureText(probeText).width * 1000) / 1000;
        ctx.font = '72px sans-serif';
        const sansW = Math.round(ctx.measureText(probeText).width * 1000) / 1000;

        const results = {};
        for (const fam of testFamilies) {
          ctx.font = '72px "' + fam + '", monospace';
          const wMono = Math.round(ctx.measureText(probeText).width * 1000) / 1000;
          ctx.font = '72px "' + fam + '", sans-serif';
          const wSans = Math.round(ctx.measureText(probeText).width * 1000) / 1000;
          const detected = (wMono !== monoW) || (wSans !== sansW);
          const checkDocFonts = document.fonts ? document.fonts.check('16px "' + fam + '"') : null;
          results[fam] = { detected, wMono, wSans, checkDocFonts };
        }
        out.fonts.probed = results;
        out.fonts.hasQueryLocalFonts = typeof navigator.queryLocalFonts === 'function';
      } catch (e) {
        out.fonts = { error: String(e) };
      }

      // ============================================================
      // 6. Cross-Context (Iframe & DedicatedWorker)
      // ============================================================
      out.crossContext = {};

      // 6.1 Iframe
      try {
        const ifr = document.createElement('iframe');
        ifr.src = '/iframe-page';
        const ifrPromise = new Promise((resolve) => {
          ifr.onload = () => resolve(true);
          ifr.onerror = () => resolve(false);
          setTimeout(() => resolve(false), 3000);
        });
        document.body.appendChild(ifr);
        await ifrPromise;

        const iWin = ifr.contentWindow;
        out.crossContext.iframe = {
          platform: iWin.navigator.platform,
          userAgent: iWin.navigator.userAgent,
          maxTouchPoints: iWin.navigator.maxTouchPoints,
          dpr: iWin.devicePixelRatio,
          screenWidth: iWin.screen.width,
          screenHeight: iWin.screen.height,
        };
        ifr.remove();
      } catch (e) {
        out.crossContext.iframe = { error: String(e) };
      }

      // 6.2 DedicatedWorker
      try {
        const worker = new Worker('/worker.js');
        const workerPromise = new Promise((resolve) => {
          worker.onmessage = (e) => resolve(e.data);
          worker.onerror = (e) => resolve({ error: e.message || 'Worker error' });
          setTimeout(() => resolve({ timeout: true }), 3000);
        });
        worker.postMessage({ cmd: 'audit' });
        out.crossContext.dedicatedWorker = await workerPromise;
        worker.terminate();
      } catch (e) {
        out.crossContext.dedicatedWorker = { error: String(e) };
      }

      // ============================================================
      // 7. Network Triggers for Server Headers
      // ============================================================
      try {
        await fetch('/api/fetch');
        await fetch('/api/opt-in-ch');
        await fetch('/api/fetch-ch');
      } catch (e) {}

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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-desk-audit-' + profileConfig.id + '-'));
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

      // Enable Fetch interception for header rewriting
      await connection.command('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      }, { sessionId, timeout: 5000 }).catch(() => {});

      // Call applyFingerprintToTab for production Emulation / script injection
      const sessionCall = async (method, params = {}) => {
        return connection.command(method, params, { sessionId, timeout: 30000 });
      };
            await applyFingerprintToTab(sessionCall, null, fp, profileConfig, {
        applyKey: `session:${sessionId}`,
      });
    }

    await connection.command('Page.enable', {}, { sessionId });
    await connection.command('Runtime.enable', {}, { sessionId });

    const mainUrl = `http://127.0.0.1:${server.port}/main`;
        await connection.command('Page.navigate', { url: mainUrl }, { sessionId });
    
    // Poll for probe completion
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
  console.log('  OpenBrowser Desktop Persona Consistency Audit (Linux & Windows)');
  console.log('  Red-Team Adversarial Perspective');
  console.log('================================================================\n');

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.error('ERROR: This audit requires the macos-x64 Chromium kernel at', launcher);
    process.exit(1);
  }

  const server = new AuditServer();
  await server.start();
  console.log(`[AuditServer] Running on http://127.0.0.1:${server.port}`);

  // 1. Session 1: Baseline
  console.log('\n>>> [Session 1/3] Running Native Baseline (Stock Chromium on macOS)...');
  const baselineConfig = { id: 'audit-baseline', name: 'Baseline Stock Kernel' };
  const baselineRes = await runSession(baselineConfig, false, server);
  console.log('    Baseline finished. Client error:', baselineRes.client?.error || 'none');

  // 2. Session 2: Linux Desktop Persona
  console.log('\n>>> [Session 2/3] Running Linux Desktop Persona (Ubuntu / Linux x86_64, Chrome 148)...');
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
    },
  };
  const linuxRes = await runSession(linuxConfig, true, server);
  console.log('    Linux session finished. Client error:', linuxRes.client?.error || 'none');

  // 3. Session 3: Windows Desktop Persona
  console.log('\n>>> [Session 3/3] Running Windows Desktop Persona (Windows 10/11 x64, Chrome 148)...');
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
    },
  };
  const windowsRes = await runSession(windowsConfig, true, server);
  console.log('    Windows session finished. Client error:', windowsRes.client?.error || 'none');

  await server.stop();

  // 4. Kernel Init Mapping Audit (Static / In-memory)
  console.log('\n>>> [Kernel Init] Auditing Kernel Init Mapping for Linux & Windows...');
  const fpLinux = buildFingerprint(linuxConfig);
  const initLinux = mapFingerprintToInitFields(fpLinux, linuxConfig);
  const invariantsLinux = validateKernelInitInvariants(initLinux);

  const fpWindows = buildFingerprint(windowsConfig);
  const initWindows = mapFingerprintToInitFields(fpWindows, windowsConfig);
  const invariantsWindows = validateKernelInitInvariants(initWindows);

  // Also test omission of userAgent (bug inspection)
  const linuxNoUa = {
    id: 'audit-linux-no-ua',
    os: 'Linux',
    fingerprintLaunchSeed: 'seed-no-ua-linux',
    privacy: { deviceProfile: 'persona' },
  };
  const fpLinuxNoUa = buildFingerprint(linuxNoUa);

  // Also test omission of deviceProfile: 'persona' (font shielding check)
  const linuxNoPersona = {
    id: 'audit-linux-no-persona',
    os: 'Linux',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    fingerprintLaunchSeed: 'seed-no-persona-linux',
  };
  const fpLinuxNoPersona = buildFingerprint(linuxNoPersona);

  const kernelInitAudit = {
    linux: {
      platform: initLinux.platform,
      detectedOs: detectOs(fpLinux, linuxConfig, initLinux),
      detectedInitOs: detectInitOs(initLinux),
      webrtc_media_labels: initLinux.webrtc_media_labels,
      invariants: invariantsLinux,
      cmdLineUa: initLinux.cmd_line?.['user-agent'],
      cmdLineUaMetadata: initLinux.cmd_line?.['user-agent-metadata'],
    },
    windows: {
      platform: initWindows.platform,
      detectedOs: detectOs(fpWindows, windowsConfig, initWindows),
      detectedInitOs: detectInitOs(initWindows),
      webrtc_media_labels: initWindows.webrtc_media_labels,
      invariants: invariantsWindows,
      cmdLineUa: initWindows.cmd_line?.['user-agent'],
      cmdLineUaMetadata: initWindows.cmd_line?.['user-agent-metadata'],
    },
    edgeCases: {
      linuxWithoutUaParsedOs: fpLinuxNoUa.uaProfile?.os,
      linuxWithoutUaPlatform: fpLinuxNoUa.platform,
      linuxWithoutUaUa: fpLinuxNoUa.userAgent,
      linuxNoPersonaFonts: fpLinuxNoPersona.fonts,
    }
  };

  const rawDump = {
    timestamp: new Date().toISOString(),
    baseline: baselineRes,
    linux: linuxRes,
    windows: windowsRes,
    kernelInitAudit,
  };

  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  const dumpPath = path.join(reportsDir, 'desktop-persona-raw-dump.json');
  fs.writeFileSync(dumpPath, JSON.stringify(rawDump, null, 2), 'utf8');
  console.log(`[RawDump] Written to ${dumpPath}`);

  // Summary outputs for console
  const bClient = baselineRes.client || {};
  const lClient = linuxRes.client || {};
  const wClient = windowsRes.client || {};

  const bHead = baselineRes.headers || {};
  const lHead = linuxRes.headers || {};
  const wHead = windowsRes.headers || {};

  console.log('\n================================================================');
  console.log('  DESKTOP PERSONA AUDIT RESULTS SUMMARY');
  console.log('================================================================\n');

  console.log('--- 1. IDENTITY & NAVIGATOR ---');
  console.log('User-Agent:');
  console.log('  Baseline:', bClient.identity?.userAgent);
  console.log('  Linux:   ', lClient.identity?.userAgent);
  console.log('  Windows: ', wClient.identity?.userAgent);

  console.log('\nPlatform:');
  console.log('  Baseline:', bClient.identity?.platform);
  console.log('  Linux:   ', lClient.identity?.platform);
  console.log('  Windows: ', wClient.identity?.platform);

  console.log('\nVendor:');
  console.log('  Baseline:', bClient.identity?.vendor);
  console.log('  Linux:   ', lClient.identity?.vendor);
  console.log('  Windows: ', wClient.identity?.vendor);

  console.log('\nuserAgentData:');
  console.log('  Baseline:', bClient.identity?.userAgentData?.platform, 'mobile =', bClient.identity?.userAgentData?.mobile);
  console.log('  Linux:   ', lClient.identity?.userAgentData?.platform, 'mobile =', lClient.identity?.userAgentData?.mobile, 'arch =', lClient.identity?.userAgentData?.highEntropy?.architecture, 'model =', lClient.identity?.userAgentData?.highEntropy?.model);
  console.log('  Windows: ', wClient.identity?.userAgentData?.platform, 'mobile =', wClient.identity?.userAgentData?.mobile, 'arch =', wClient.identity?.userAgentData?.highEntropy?.architecture, 'model =', wClient.identity?.userAgentData?.highEntropy?.model);

  console.log('\nLanguages & Identity:');
  console.log('  Baseline:', bClient.identity?.languages, 'identity =', bClient.identity?.languagesIdentity);
  console.log('  Linux:   ', lClient.identity?.languages, 'identity =', lClient.identity?.languagesIdentity);
  console.log('  Windows: ', wClient.identity?.languages, 'identity =', wClient.identity?.languagesIdentity);

  console.log('\nTimezone & Date:');
  console.log('  Baseline: tz =', bClient.identity?.timezone, 'offset =', bClient.identity?.dateOffset);
  console.log('  Linux:    tz =', lClient.identity?.timezone, 'offset =', lClient.identity?.dateOffset);
  console.log('  Windows:  tz =', wClient.identity?.timezone, 'offset =', wClient.identity?.dateOffset);

  console.log('\n--- 2. SCREEN & HARDWARE ---');
  console.log('Screen Resolution & DPR:');
  console.log('  Baseline: ', `${bClient.screenAndHardware?.screenWidth}x${bClient.screenAndHardware?.screenHeight}`, 'dpr =', bClient.screenAndHardware?.devicePixelRatio);
  console.log('  Linux:    ', `${lClient.screenAndHardware?.screenWidth}x${lClient.screenAndHardware?.screenHeight}`, 'dpr =', lClient.screenAndHardware?.devicePixelRatio);
  console.log('  Windows:  ', `${wClient.screenAndHardware?.screenWidth}x${wClient.screenAndHardware?.screenHeight}`, 'dpr =', wClient.screenAndHardware?.devicePixelRatio);

  console.log('DPR vs matchMedia resolution:');
  console.log('  Baseline: dpr =', bClient.screenAndHardware?.devicePixelRatio, '1dppx =', bClient.screenAndHardware?.matchMedia?.res1dppx, 'resDpr =', bClient.screenAndHardware?.matchMedia?.resDprDppx);
  console.log('  Linux:    dpr =', lClient.screenAndHardware?.devicePixelRatio, '1dppx =', lClient.screenAndHardware?.matchMedia?.res1dppx, 'resDpr =', lClient.screenAndHardware?.matchMedia?.resDprDppx);
  console.log('  Windows:  dpr =', wClient.screenAndHardware?.devicePixelRatio, '1dppx =', wClient.screenAndHardware?.matchMedia?.res1dppx, 'resDpr =', wClient.screenAndHardware?.matchMedia?.resDprDppx);

  console.log('Pointer & Hover:');
  console.log('  Linux:   pointerFine =', lClient.screenAndHardware?.matchMedia?.pointerFine, 'hoverHover =', lClient.screenAndHardware?.matchMedia?.hoverHover);
  console.log('  Windows: pointerFine =', wClient.screenAndHardware?.matchMedia?.pointerFine, 'hoverHover =', wClient.screenAndHardware?.matchMedia?.hoverHover);

  console.log('\n--- 3. GPU & FONTS ---');
  console.log('WebGL UNMASKED Vendor & Renderer:');
  console.log('  Baseline:', bClient.gpu?.webgl?.unmaskedVendor, '|', bClient.gpu?.webgl?.unmaskedRenderer);
  console.log('  Linux:   ', lClient.gpu?.webgl?.unmaskedVendor, '|', lClient.gpu?.webgl?.unmaskedRenderer);
  console.log('  Windows: ', wClient.gpu?.webgl?.unmaskedVendor, '|', wClient.gpu?.webgl?.unmaskedRenderer);

  console.log('Shader Precision (Fragment highp / mediump / lowp):');
  console.log('  Baseline: highp =', bClient.gpu?.webgl?.fragmentHighp, 'mediump =', bClient.gpu?.webgl?.fragmentMediump);
  console.log('  Linux:    highp =', lClient.gpu?.webgl?.fragmentHighp, 'mediump =', lClient.gpu?.webgl?.fragmentMediump);
  console.log('  Windows:  highp =', wClient.gpu?.webgl?.fragmentHighp, 'mediump =', wClient.gpu?.webgl?.fragmentMediump);

  console.log('Font Probing (Key cross-platform samples):');
  const checkFont = (res, name) => res.fonts?.probed?.[name]?.detected;
  console.log('  Baseline: PingFang =', checkFont(bClient, 'PingFang SC'), 'AppleEmoji =', checkFont(bClient, 'Apple Color Emoji'), 'SegoeUI =', checkFont(bClient, 'Segoe UI'), 'Ubuntu =', checkFont(bClient, 'Ubuntu'), 'DejaVu =', checkFont(bClient, 'DejaVu Sans'));
  console.log('  Linux:    PingFang =', checkFont(lClient, 'PingFang SC'), 'AppleEmoji =', checkFont(lClient, 'Apple Color Emoji'), 'SegoeUI =', checkFont(lClient, 'Segoe UI'), 'Ubuntu =', checkFont(lClient, 'Ubuntu'), 'DejaVu =', checkFont(lClient, 'DejaVu Sans'));
  console.log('  Windows:  PingFang =', checkFont(wClient, 'PingFang SC'), 'AppleEmoji =', checkFont(wClient, 'Apple Color Emoji'), 'SegoeUI =', checkFont(wClient, 'Segoe UI'), 'Ubuntu =', checkFont(wClient, 'Ubuntu'), 'DejaVu =', checkFont(wClient, 'DejaVu Sans'));

  console.log('\n--- 4. CLIENT HINTS & HEADERS ON WIRE ---');
  console.log('Main Page HTTP Headers:');
  console.log('  Linux User-Agent:        ', lHead.mainPage?.map?.['user-agent']);
  console.log('  Linux Accept-Language:   ', lHead.mainPage?.map?.['accept-language']);
  console.log('  Linux sec-ch-ua:         ', lHead.mainPage?.map?.['sec-ch-ua']);
  console.log('  Linux sec-ch-ua-mobile:  ', lHead.mainPage?.map?.['sec-ch-ua-mobile']);
  console.log('  Linux sec-ch-ua-platform:', lHead.mainPage?.map?.['sec-ch-ua-platform']);
  console.log('  Windows User-Agent:        ', wHead.mainPage?.map?.['user-agent']);
  console.log('  Windows Accept-Language:   ', wHead.mainPage?.map?.['accept-language']);
  console.log('  Windows sec-ch-ua:         ', wHead.mainPage?.map?.['sec-ch-ua']);
  console.log('  Windows sec-ch-ua-mobile:  ', wHead.mainPage?.map?.['sec-ch-ua-mobile']);
  console.log('  Windows sec-ch-ua-platform:', wHead.mainPage?.map?.['sec-ch-ua-platform']);

  console.log('\n--- 5. MEDIA & SPEECH ---');
  console.log('MediaDevices Unauthorized Labels:');
  console.log('  Baseline labels leak:', bClient.mediaAndSpeech?.devices?.unauthorizedLabelsExposed);
  console.log('  Linux labels leak:   ', lClient.mediaAndSpeech?.devices?.unauthorizedLabelsExposed);
  console.log('  Windows labels leak: ', wClient.mediaAndSpeech?.devices?.unauthorizedLabelsExposed);

  console.log('SpeechSynthesis Voices:');
  console.log('  Baseline count:', bClient.mediaAndSpeech?.speech?.count);
  console.log('  Linux count:   ', lClient.mediaAndSpeech?.speech?.count, 'hasWindows =', lClient.mediaAndSpeech?.speech?.hasWindowsVoice, 'hasMac =', lClient.mediaAndSpeech?.speech?.hasMacVoice, 'hasGoogle =', lClient.mediaAndSpeech?.speech?.hasGoogleVoice);
  console.log('  Windows count: ', wClient.mediaAndSpeech?.speech?.count, 'hasWindows =', wClient.mediaAndSpeech?.speech?.hasWindowsVoice, 'hasMac =', wClient.mediaAndSpeech?.speech?.hasMacVoice, 'hasGoogle =', wClient.mediaAndSpeech?.speech?.hasGoogleVoice);

  console.log('\n--- 6. KERNEL INIT & INVARIANTS ---');
  console.log('Linux:');
  console.log('  platform:           ', kernelInitAudit.linux.platform);
  console.log('  detectedOs:         ', kernelInitAudit.linux.detectedOs);
  console.log('  detectedInitOs:     ', kernelInitAudit.linux.detectedInitOs);
  console.log('  webrtc_media_labels:', kernelInitAudit.linux.webrtc_media_labels);
  console.log('  invariants valid:   ', kernelInitAudit.linux.invariants?.valid, kernelInitAudit.linux.invariants?.issues);
  console.log('Windows:');
  console.log('  platform:           ', kernelInitAudit.windows.platform);
  console.log('  detectedOs:         ', kernelInitAudit.windows.detectedOs);
  console.log('  detectedInitOs:     ', kernelInitAudit.windows.detectedInitOs);
  console.log('  webrtc_media_labels:', kernelInitAudit.windows.webrtc_media_labels);
  console.log('  invariants valid:   ', kernelInitAudit.windows.invariants?.valid, kernelInitAudit.windows.invariants?.issues);

  console.log('\nEdge Cases (Omission Tests):');
  console.log('  linuxWithoutUaParsedOs: ', kernelInitAudit.edgeCases.linuxWithoutUaParsedOs);
  console.log('  linuxWithoutUaPlatform: ', kernelInitAudit.edgeCases.linuxWithoutUaPlatform);
  console.log('  linuxNoPersonaFonts:    ', kernelInitAudit.edgeCases.linuxNoPersonaFonts);

  // ============================================================
  // REGRESSION ASSERTIONS (APPLE-COLOR-EMOJI-LEAK P0 FIX)
  // ============================================================
  console.log('\n--- 7. REGRESSION ASSERTIONS ---');
  assert.strictEqual(checkFont(lClient, 'Apple Color Emoji'), false, 'Regression FAIL: Linux persona must not leak Apple Color Emoji');
  assert.strictEqual(checkFont(wClient, 'Apple Color Emoji'), false, 'Regression FAIL: Windows persona must not leak Apple Color Emoji');
  assert.strictEqual(checkFont(lClient, 'PingFang SC'), false, 'Linux persona must not leak PingFang SC');
  assert.strictEqual(checkFont(wClient, 'PingFang SC'), false, 'Windows persona must not leak PingFang SC');
  assert.strictEqual(checkFont(lClient, 'Ubuntu'), true, 'Linux persona must report Ubuntu font');
  assert.strictEqual(checkFont(wClient, 'Segoe UI'), true, 'Windows persona must report Segoe UI font');
  console.log('  PASS: Linux & Windows personas successfully block Apple Color Emoji (absent)');
  console.log('  PASS: Platform specific fonts (Ubuntu / Segoe UI) correctly detected');

  console.log('\n>>> Desktop persona audit completed successfully.');
})();
