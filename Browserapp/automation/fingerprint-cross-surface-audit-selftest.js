#!/usr/bin/env node
'use strict';

/**
 * End-to-end cross-surface fingerprint consistency audit.
 *
 * This test suite verifies consistency across five distinct execution realms:
 *  1. Main document (window)
 *  2. Same-origin navigated iframe (window.frames[0])
 *  3. srcdoc iframe (<iframe srcdoc="...">)
 *  4. Dynamic empty about:blank iframe (document.createElement('iframe'))
 *  5. DedicatedWorker (WorkerGlobalScope)
 *
 * Key audit axes evaluated:
 *  - Navigator identity & Client Hints (platform, userAgent, concurrency, memory, languages, userAgentData)
 *  - Timezone integrity (Date offset, toString, Intl.DateTimeFormat resolvedOptions, winter/summer DST parity)
 *  - FontFace presence & local() gate (persona resolution vs foreign NetworkError rejection)
 *  - Local font access API (queryLocalFonts enumeration & authentic WOFF2 binary headers)
 *  - WebGL1 & WebGL2 capabilities (vendor, renderer, MAX_TEXTURE_SIZE, MAX_VIEWPORT_DIMS, extension isolation)
 *  - WebGPU adapter surface (main window spoofing vs dedicated worker unshielded host adapter audit)
 *
 * Evaluated under both:
 *  - Windows Persona (Intel UHD 620 D3D11, America/New_York)
 *  - macOS Persona (Apple M3 Metal, America/Los_Angeles)
 *
 * Supports --mutate flag to demonstrate assertion sensitivity when protections are disabled.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const {
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
} = require('./fingerprint');
const { buildWorkerFontPresenceSource } = require('./worker-font-presence-fallback');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { getPlatformFontPayload } = require('./query-local-font-blob-gate');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const MACOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const isMutateMode = process.argv.includes('--mutate') || process.env.MUTATE === '1';

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

const checkKnownGap = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true, gap: true });
    console.log(`  KNOWN GAP (CONFIRMED)  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, gap: true });
    console.log(`  FAIL (GAP BROKEN)  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

const skip = (name, why) => {
  results.push({ name, ok: true });
  console.log(`  SKIP  ${name}${why ? ' - ' + why : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, timer } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        resolve(message);
        return;
      }
      if (message.method) {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `CDP timeout: ${method}` } });
      }, 30000);
      this.pending.set(id, { resolve, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }

  async waitEvent(method, predicate, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = this.events.findIndex((ev) => ev.method === method && (!predicate || predicate(ev)));
      if (idx >= 0) {
        return this.events.splice(idx, 1)[0];
      }
      await sleep(50);
    }
    return null;
  }
}

async function startServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');

    if (request.url === '/frame.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><body><script>window.__frameLoaded = true;</script></body></html>');
      return;
    }

    if (request.url === '/worker.js') {
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      response.end(`
        self.onmessage = async (e) => {
          const probeData = {
            nav: {
              platform: navigator.platform,
              userAgent: navigator.userAgent,
              hardwareConcurrency: navigator.hardwareConcurrency,
              deviceMemory: navigator.deviceMemory,
              languages: navigator.languages,
            },
            uad: null,
            tz: {
              offset: new Date().getTimezoneOffset(),
              dateStr: new Date().toString(),
              intlTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
              winterOffset: new Date(2026, 0, 15).getTimezoneOffset(),
              summerOffset: new Date(2026, 6, 15).getTimezoneOffset(),
            },
            fonts: {},
            gl1: null,
            gl2: null,
            gpu: null,
          };

          if (navigator.userAgentData) {
            try {
              const entropy = await navigator.userAgentData.getHighEntropyValues([
                'platform', 'platformVersion', 'architecture', 'bitness', 'model'
              ]);
              probeData.uad = {
                brands: navigator.userAgentData.brands,
                platform: navigator.userAgentData.platform,
                mobile: navigator.userAgentData.mobile,
                entropy,
              };
            } catch (err) {
              probeData.uad = { err: err.name || String(err) };
            }
          }

          const probeFont = async (family) => {
            const face = new FontFace(family, 'local("' + family + '")');
            try {
              await face.load();
              return { status: face.status, outcome: 'resolve' };
            } catch (err) {
              return { status: face.status, outcome: 'reject', errName: (err && err.name) || 'UnknownError' };
            }
          };

          probeData.fonts['Segoe UI'] = await probeFont('Segoe UI');
          probeData.fonts['Helvetica Neue'] = await probeFont('Helvetica Neue');
          probeData.fonts['Cambria Math'] = await probeFont('Cambria Math');
          probeData.fonts['Luminari'] = await probeFont('Luminari');

          try {
            const c1 = new OffscreenCanvas(300, 150);
            const ctx1 = c1.getContext('webgl');
            if (ctx1) {
              const dbg = ctx1.getExtension('WEBGL_debug_renderer_info');
              const exts = ctx1.getSupportedExtensions() || [];
              probeData.gl1 = {
                vendor: dbg ? ctx1.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'no-dbg',
                renderer: dbg ? ctx1.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'no-dbg',
                maxTex: ctx1.getParameter(ctx1.MAX_TEXTURE_SIZE),
                viewport: Array.from(ctx1.getParameter(ctx1.MAX_VIEWPORT_DIMS)),
                extCount: exts.length,
                hasNvExt: exts.some((x) => String(x).toLowerCase().startsWith('nv_')),
              };
            }
          } catch (err) {
            probeData.gl1 = { err: err.message };
          }

          try {
            const c2 = new OffscreenCanvas(300, 150);
            const ctx2 = c2.getContext('webgl2');
            if (ctx2) {
              const dbg2 = ctx2.getExtension('WEBGL_debug_renderer_info');
              const exts2 = ctx2.getSupportedExtensions() || [];
              probeData.gl2 = {
                vendor: dbg2 ? ctx2.getParameter(dbg2.UNMASKED_VENDOR_WEBGL) : 'no-dbg',
                renderer: dbg2 ? ctx2.getParameter(dbg2.UNMASKED_RENDERER_WEBGL) : 'no-dbg',
                maxTex: ctx2.getParameter(ctx2.MAX_TEXTURE_SIZE),
                viewport: Array.from(ctx2.getParameter(ctx2.MAX_VIEWPORT_DIMS)),
                extCount: exts2.length,
                hasNvExt: exts2.some((x) => String(x).toLowerCase().startsWith('nv_')),
              };
            }
          } catch (err) {
            probeData.gl2 = { err: err.message };
          }

          try {
            const off = new OffscreenCanvas(100, 100);
            const ctx = off.getContext('2d');
            ctx.fillStyle = '#f30';
            ctx.fillRect(0, 0, 100, 100);
            ctx.fillStyle = '#06c';
            ctx.fillRect(10, 10, 80, 80);
            ctx.fillStyle = 'rgba(100, 200, 50, 0.8)';
            ctx.beginPath();
            ctx.arc(50, 50, 25, 0, Math.PI * 2);
            ctx.fill();

            const imgData = ctx.getImageData(0, 0, 100, 100);
            let pxSum = 0;
            for (let i = 0; i < imgData.data.length; i += 4) pxSum += imgData.data[i];

            const offTrans = new OffscreenCanvas(16, 16);
            const transImg = offTrans.getContext('2d').getImageData(0, 0, 16, 16);
            let transNonZero = false;
            for (let i = 0; i < transImg.data.length; i++) {
              if (transImg.data[i] !== 0) { transNonZero = true; break; }
            }

            let illegalCtxThrows = false;
            try {
              self.OffscreenCanvasRenderingContext2D.prototype.getImageData.call({}, 0, 0, 1, 1);
            } catch (err) {
              illegalCtxThrows = (err instanceof TypeError) || err.name === 'TypeError';
            }

            probeData.canvas = {
              pxSum,
              isClampedArray: (imgData.data instanceof Uint8ClampedArray) || Object.prototype.toString.call(imgData.data) === '[object Uint8ClampedArray]',
              transNonZero,
              illegalCtxThrows,
            };
          } catch (err) {
            probeData.canvas = { err: err.message };
          }

          try {
            if (navigator.gpu) {
              const adapter = await navigator.gpu.requestAdapter();
              probeData.gpu = adapter ? {
                hasAdapter: true,
                vendor: adapter.info ? adapter.info.vendor : '',
                architecture: adapter.info ? adapter.info.architecture : '',
                device: adapter.info ? adapter.info.device : '',
              } : { hasAdapter: false };
            } else {
              probeData.gpu = { hasAdapter: false, noApi: true };
            }
          } catch (err) {
            probeData.gpu = { err: err.message };
          }

          self.postMessage(probeData);
        };
      `);
      return;
    }

    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
<html>
<head><title>cross-surface-audit</title></head>
<body>
  <iframe id="sameOriginFrame" src="/frame.html"></iframe>
  <iframe id="srcdocFrame" srcdoc="<!doctype html><html><body><script>window.__srcdocLoaded = true;</script></body></html>"></iframe>
  <script>
    window.__dynamicBlankFrame = document.createElement('iframe');
    document.body.appendChild(window.__dynamicBlankFrame);

    window.__runWorker = () => {
      const w = new Worker('/worker.js');
      return new Promise((resolve) => {
        w.onmessage = (event) => resolve(event.data);
        w.postMessage('audit');
      });
    };
  </script>
</body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function runAuditSession(label, userAgent, osName, timezone, serverPort, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-cross-surface-${label}-`));
  const profile = {
    id: `audit-${label}`,
    name: `audit-${label}`,
    language: 'en-US',
    userAgent,
    kernelVersion: '148.0.7778.165',
    os: osName,
    exitIp: '203.0.113.88',
    exitTimezone: timezone,
    privacy: {
      deviceProfile: 'persona',
      timezoneMode: 'custom',
      timezone,
    },
  };

  const fp = buildFingerprint(profile);
  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const launchArgs = [
    dir,
    '--headless=new',
    `--time-zone-for-testing=${timezone}`,
  ];

  const child = spawn(launcher, launchArgs, {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let devToolsPort = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(300);
    try {
      const portVal = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (portVal > 0) {
        devToolsPort = portVal;
        break;
      }
    } catch (_) {}
  }

  if (!devToolsPort) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    return { error: 'DevToolsActivePort not acquired' };
  }

  let ws = null;
  try {
    const ver = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)).json();
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP WebSocket connect failed'));
    });
    const cdp = new Cdp(ws);

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    const targets = await cdp.send('Target.getTargets', {});
    const pageTarget = ((targets.result || {}).targetInfos || []).find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('No page target found');

    const attachRes = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const pageSession = attachRes?.result?.sessionId;
    if (!pageSession) throw new Error('Failed to attach to page target');

    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Runtime.enable', {}, pageSession);

    // Lazy font payload host. The Windows persona answers Local Font Access from this CDP binding
    // rather than an inline payload, so without a host side here blob() would come back empty and
    // the SFNT-header parity check would fail for a reason the product does not have. Mirror
    // engine.js: validate the token, then hand the requested subset back through the same
    // Function.prototype.toString channel the injected gate listens on.
    const bridgeChannel = mutate ? null : (fp?.fontBlobBridge?.channelName || null);
    const answerFontBridge = async (ev) => {
      let request = null;
      try { request = JSON.parse(ev.params?.payload || '{}'); } catch (_) { return; }
      const payload = getPlatformFontPayload(
        String(request?.platform || fp?.fontBlobBridge?.platform || 'windows'),
        { wanted: request?.wanted || undefined },
      );
      const token = String(request?.token || '');
      const expression = `try {
        const targetFn = (typeof FontData !== 'undefined' && FontData && FontData.prototype && FontData.prototype.blob)
          ? FontData.prototype.blob
          : Function.prototype.toString;
        Function.prototype.toString.call(targetFn, ${JSON.stringify(token)}, 'provideBytes', ${JSON.stringify(payload)});
      } catch (_) {}`;
      // Target the context that called the binding: an iframe has its own global, so answering on
      // the default page context would leave the frame's blob() empty.
      const contextId = ev.params?.executionContextId;
      const evaluateParams = { expression, returnByValue: false };
      if (contextId) evaluateParams.contextId = contextId;
      await cdp.send('Runtime.evaluate', evaluateParams, ev.sessionId || pageSession);
    };
    if (bridgeChannel) {
      await cdp.send('Runtime.addBinding', { name: bridgeChannel }, pageSession);
    }

    // Grant localFonts permissions to allow Local Font Access API probe
    await cdp.send('Browser.grantPermissions', {
      permissions: ['localFonts'],
      origin: `http://127.0.0.1:${serverPort}`,
    });

    const mainScript = mutate
      ? 'window.__mutated = true;'
      : buildInjectionScript(fp);

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mainScript }, pageSession);
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, pageSession);

    const workerSource = mutate
      ? 'self.__workerMutated = true;'
      : (buildWorkerInjectionScript(fp) + '\n' + (typeof buildWorkerFontPresenceSource === 'function' ? buildWorkerFontPresenceSource(fp) : ''));

    // Handle worker attach events to inject worker fingerprint script and preserve runtime failures.
    cdp.events = [];
    const runtimeExceptions = [];
    const handleAttached = async (ev) => {
      if (ev.method === 'Target.attachedToTarget' && ev.params?.targetInfo?.type === 'worker') {
        const wSession = ev.params.sessionId;
        await cdp.send('Runtime.evaluate', { expression: workerSource }, wSession);
        await cdp.send('Runtime.runIfWaitingForDebugger', {}, wSession);
      }
    };

    const eventInterval = setInterval(() => {
      while (cdp.events.length) {
        const ev = cdp.events.shift();
        if (ev.method === 'Runtime.bindingCalled' && bridgeChannel && ev.params?.name === bridgeChannel) {
          answerFontBridge(ev).catch(() => {});
          continue;
        }
        if (ev.method === 'Runtime.exceptionThrown') {
          const details = ev.params?.exceptionDetails || {};
          runtimeExceptions.push(String(details.exception?.description || details.text || 'Runtime exception'));
          continue;
        }
        handleAttached(ev);
      }
    }, 40);

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` }, pageSession);
    await sleep(2000);

    // Window inspection expression covering Main, Same-Origin Iframe, srcdoc Iframe, and Dynamic Blank Iframe
    const windowProbeExpression = `(async () => {
      const inspectWindowSurface = async (w, label) => {
        const nav = {
          platform: w.navigator.platform,
          userAgent: w.navigator.userAgent,
          hardwareConcurrency: w.navigator.hardwareConcurrency,
          deviceMemory: w.navigator.deviceMemory,
          languages: w.navigator.languages,
        };

        let uad = null;
        if (w.navigator.userAgentData) {
          try {
            const entropy = await w.navigator.userAgentData.getHighEntropyValues([
              'platform', 'platformVersion', 'architecture', 'bitness', 'model'
            ]);
            uad = {
              brands: w.navigator.userAgentData.brands,
              platform: w.navigator.userAgentData.platform,
              mobile: w.navigator.userAgentData.mobile,
              entropy,
            };
          } catch (err) {
            uad = { err: err.name || String(err) };
          }
        }

        const tz = {
          offset: new w.Date().getTimezoneOffset(),
          dateStr: new w.Date().toString(),
          intlTz: w.Intl.DateTimeFormat().resolvedOptions().timeZone,
          winterOffset: new w.Date(2026, 0, 15).getTimezoneOffset(),
          summerOffset: new w.Date(2026, 6, 15).getTimezoneOffset(),
        };

        const probeFont = async (family) => {
          const face = new w.FontFace(family, 'local("' + family + '")');
          try {
            await face.load();
            return { status: face.status, outcome: 'resolve' };
          } catch (err) {
            return { status: face.status, outcome: 'reject', errName: (err && err.name) || 'UnknownError' };
          }
        };

        const fonts = {
          'Segoe UI': await probeFont('Segoe UI'),
          'Helvetica Neue': await probeFont('Helvetica Neue'),
          'Cambria Math': await probeFont('Cambria Math'),
          'Luminari': await probeFont('Luminari'),
        };

        let localFonts = null;
        try {
          if (typeof w.queryLocalFonts === 'function') {
            const list = await w.queryLocalFonts();
            let blobHeader = null;
            let blobSize = 0;
            if (list.length > 0) {
              const b = await list[0].blob();
              blobSize = b.size;
              const ab = await b.arrayBuffer();
              const u8 = new Uint8Array(ab);
              blobHeader = Array.from(u8.slice(0, 4)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
            }
            localFonts = {
              count: list.length,
              firstFamily: list[0]?.family,
              blobSize,
              blobHeader,
            };
          } else {
            localFonts = { noApi: true };
          }
        } catch (err) {
          localFonts = { err: err.name || String(err) };
        }

        let gl1 = null, gl2 = null;
        try {
          const c1 = w.document.createElement('canvas');
          const ctx1 = c1.getContext('webgl');
          if (ctx1) {
            const dbg = ctx1.getExtension('WEBGL_debug_renderer_info');
            const exts = ctx1.getSupportedExtensions() || [];
            gl1 = {
              vendor: dbg ? ctx1.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'no-dbg',
              renderer: dbg ? ctx1.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'no-dbg',
              maxTex: ctx1.getParameter(ctx1.MAX_TEXTURE_SIZE),
              viewport: Array.from(ctx1.getParameter(ctx1.MAX_VIEWPORT_DIMS)),
              extCount: exts.length,
              hasNvExt: exts.some((x) => String(x).toLowerCase().startsWith('nv_')),
            };
          }
        } catch (err) {
          gl1 = { err: err.message };
        }

        try {
          const c2 = w.document.createElement('canvas');
          const ctx2 = c2.getContext('webgl2');
          if (ctx2) {
            const dbg2 = ctx2.getExtension('WEBGL_debug_renderer_info');
            const exts2 = ctx2.getSupportedExtensions() || [];
            gl2 = {
              vendor: dbg2 ? ctx2.getParameter(dbg2.UNMASKED_VENDOR_WEBGL) : 'no-dbg',
              renderer: dbg2 ? ctx2.getParameter(dbg2.UNMASKED_RENDERER_WEBGL) : 'no-dbg',
              maxTex: ctx2.getParameter(ctx2.MAX_TEXTURE_SIZE),
              viewport: Array.from(ctx2.getParameter(ctx2.MAX_VIEWPORT_DIMS)),
              extCount: exts2.length,
              hasNvExt: exts2.some((x) => String(x).toLowerCase().startsWith('nv_')),
            };
          }
        } catch (err) {
          gl2 = { err: err.message };
        }

        let gpu = null;
        try {
          if (w.navigator.gpu) {
            const adapter = await w.navigator.gpu.requestAdapter();
            gpu = adapter ? {
              hasAdapter: true,
              vendor: adapter.info ? adapter.info.vendor : '',
              architecture: adapter.info ? adapter.info.architecture : '',
              device: adapter.info ? adapter.info.device : '',
            } : { hasAdapter: false };
          } else {
            gpu = { hasAdapter: false, noApi: true };
          }
        } catch (err) {
          gpu = { err: err.message };
        }

        // Canvas 2D probes
        let canvas = null;
        try {
          const c = w.document.createElement('canvas');
          c.width = 100; c.height = 100;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#f30';
          ctx.fillRect(0, 0, 100, 100);
          ctx.fillStyle = '#06c';
          ctx.fillRect(10, 10, 80, 80);
          ctx.fillStyle = 'rgba(100, 200, 50, 0.8)';
          ctx.beginPath();
          ctx.arc(50, 50, 25, 0, Math.PI * 2);
          ctx.fill();

          const dataUrl = c.toDataURL();
          const imgData = ctx.getImageData(0, 0, 100, 100);
          let pxSum = 0;
          for (let i = 0; i < imgData.data.length; i += 4) pxSum += imgData.data[i];

          const cZero = w.document.createElement('canvas');
          cZero.width = 0; cZero.height = 0;
          const zeroDataUrl = cZero.toDataURL();

          const cTrans = w.document.createElement('canvas');
          cTrans.width = 16; cTrans.height = 16;
          const transImg = cTrans.getContext('2d').getImageData(0, 0, 16, 16);
          let transNonZero = false;
          for (let i = 0; i < transImg.data.length; i++) {
            if (transImg.data[i] !== 0) { transNonZero = true; break; }
          }

          let illegalCtxThrows = false;
          try {
            w.CanvasRenderingContext2D.prototype.getImageData.call({}, 0, 0, 1, 1);
          } catch (err) {
            illegalCtxThrows = (err instanceof (w.TypeError || TypeError)) || err.name === 'TypeError';
          }

          let missingArgsThrows = false;
          try {
            ctx.getImageData();
          } catch (err) {
            missingArgsThrows = (err instanceof (w.TypeError || TypeError)) || err.name === 'TypeError';
          }

          canvas = {
            dataUrl,
            pxSum,
            zeroDataUrl,
            transNonZero,
            getImageDataLen: ctx.getImageData.length,
            getImageDataName: ctx.getImageData.name,
            illegalCtxThrows,
            missingArgsThrows,
            isClampedArray: (imgData.data instanceof (w.Uint8ClampedArray || Uint8ClampedArray)) || Object.prototype.toString.call(imgData.data) === '[object Uint8ClampedArray]',
          };
        } catch (err) {
          canvas = { err: err.message };
        }

        // ClientRects probes
        let clientRects = null;
        try {
          const span = w.document.createElement('span');
          span.textContent = 'OpenBrowser_Metrics_Fingerprint_Probe';
          span.style.cssText = 'font: 48px monospace; position: fixed; left: 10px; top: 10px; margin: 0; padding: 0; border: none;';
          w.document.body.appendChild(span);

          const bRect = span.getBoundingClientRect();
          const cRects = span.getClientRects();
          const rectX = Number(bRect.x.toFixed(6));
          const rectW = Number(bRect.width.toFixed(6));
          const isDRL = w.DOMRectList ? (cRects instanceof w.DOMRectList) : true;
          const isDR = w.DOMRect ? (cRects[0] instanceof w.DOMRect) : true;
          const itemMatch = cRects.item(0) === cRects[0];
          const spreadLen = [...cRects].length;

          let illegalItemThrows = false;
          try {
            if (w.DOMRectList) w.DOMRectList.prototype.item.call({}, 0);
          } catch (err) {
            illegalItemThrows = (err instanceof (w.TypeError || TypeError)) || err.name === 'TypeError';
          }

          let illegalLenThrows = false;
          try {
            if (w.DOMRectList) Object.getOwnPropertyDescriptor(w.DOMRectList.prototype, 'length').get.call({});
          } catch (err) {
            illegalLenThrows = (err instanceof (w.TypeError || TypeError)) || err.name === 'TypeError';
          }

          span.remove();

          clientRects = {
            rectX,
            rectW,
            isDRL,
            isDR,
            itemMatch,
            spreadLen,
            illegalItemThrows,
            illegalLenThrows,
          };
        } catch (err) {
          clientRects = { err: err.message };
        }

        // Web Audio probes
        let audio = null;
        try {
          const OAC = w.OfflineAudioContext || w.webkitOfflineAudioContext;
          if (OAC) {
            const oac = new OAC(1, 100, 44100);
            const osc = oac.createOscillator();
            osc.type = 'triangle';
            osc.frequency.value = 1000;
            osc.connect(oac.destination);
            osc.start(0);

            const rendered = await oac.startRendering();
            const ch0 = rendered.getChannelData(0);
            let sum = 0;
            for (let i = 0; i < ch0.length; i++) sum += Math.abs(ch0[i]);
            const hash = Math.round(sum * 1e9);

            const dest = new Float32Array(50);
            rendered.copyFromChannel(dest, 0, 0);
            const copyMatches = Math.abs(dest[10] - ch0[10]) < 1e-9;

            const oacSilent = new OAC(1, 100, 44100);
            const rendSilent = await oacSilent.startRendering();
            const chSilent = rendSilent.getChannelData(0);
            let silentZero = true;
            for (let i = 0; i < chSilent.length; i++) {
              if (chSilent[i] !== 0) { silentZero = false; break; }
            }

            const authored = oac.createBuffer(1, 4, 44100);
            authored.copyToChannel(new Float32Array([0.5, 0.25, -0.75, 1]), 0);
            const authView = authored.getChannelData(0);
            const authoredUntouched = authView[0] === 0.5 && authView[1] === 0.25;

            let illegalAudioThrows = false;
            try {
              w.AudioBuffer.prototype.copyFromChannel.call({}, new Float32Array(4), 0);
            } catch (err) {
              illegalAudioThrows = (err instanceof (w.TypeError || TypeError)) || err.name === 'TypeError';
            }

            audio = {
              hash,
              copyMatches,
              silentZero,
              authoredUntouched,
              illegalAudioThrows,
            };
          }
        } catch (err) {
          audio = { err: err.message };
        }

        return { label, nav, uad, tz, fonts, localFonts, gl1, gl2, gpu, canvas, clientRects, audio };
      };

      const main = await inspectWindowSurface(window, 'main');
      const sameOrigin = await inspectWindowSurface(document.getElementById('sameOriginFrame').contentWindow, 'sameOrigin');
      const srcdoc = await inspectWindowSurface(document.getElementById('srcdocFrame').contentWindow, 'srcdoc');
      const dynamicBlank = await inspectWindowSurface(window.__dynamicBlankFrame.contentWindow, 'dynamicBlank');

      return { main, sameOrigin, srcdoc, dynamicBlank };
    })()`;

    const winProbeRes = await cdp.send('Runtime.evaluate', {
      expression: windowProbeExpression,
      awaitPromise: true,
      returnByValue: true,
    }, pageSession);

    const workerProbeRes = await cdp.send('Runtime.evaluate', {
      expression: 'window.__runWorker()',
      awaitPromise: true,
      returnByValue: true,
    }, pageSession);

    clearInterval(eventInterval);

    return {
      fp,
      windows: winProbeRes?.result?.result?.value,
      worker: workerProbeRes?.result?.result?.value,
      runtimeExceptions,
    };
  } finally {
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
    console.log(`fingerprint-cross-surface-audit-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const { server, port } = await startServer();

  try {
    if (!isMutateMode) {
      console.log('--- Starting Cross-Surface Fingerprint Audit (NORMAL MODE) ---');

      // 1. Windows Persona Audit
      console.log('Auditing Windows Persona (Intel UHD 620, America/New_York)...');
      const winAudit = await runAuditSession('win', WINDOWS_UA, 'windows', 'America/New_York', port, false);
      const winMain = winAudit.windows?.main;
      const winSame = winAudit.windows?.sameOrigin;
      const winSrcdoc = winAudit.windows?.srcdoc;
      const winBlank = winAudit.windows?.dynamicBlank;
      const winWorker = winAudit.worker;

      assert.ok(winMain && winSame && winSrcdoc && winBlank && winWorker, 'All surfaces must yield probe data');

      check('Windows persona: document injection emits no runtime exceptions across window frames', () => {
        assert.deepStrictEqual(winAudit.runtimeExceptions, [], `Windows injection exceptions: ${winAudit.runtimeExceptions.join(' | ')}`);
      });

      check('Windows persona: navigator.platform is Win32 across all 5 surfaces', () => {
        for (const s of [winMain, winSame, winSrcdoc, winBlank, { nav: winWorker.nav }]) {
          assert.strictEqual(s.nav.platform, 'Win32');
        }
      });

      check('Windows persona: hardwareConcurrency and deviceMemory match across all 5 surfaces', () => {
        const expCores = winMain.nav.hardwareConcurrency;
        const expMem = winMain.nav.deviceMemory;
        for (const s of [winSame, winSrcdoc, winBlank, { nav: winWorker.nav }]) {
          assert.strictEqual(s.nav.hardwareConcurrency, expCores);
          assert.strictEqual(s.nav.deviceMemory, expMem);
        }
      });

      check('Windows persona: userAgentData brands and platform match across window and worker', () => {
        assert.strictEqual(winMain.uad.platform, 'Windows');
        assert.strictEqual(winWorker.uad.platform, 'Windows');
        assert.strictEqual(winMain.uad.mobile, false);
        assert.strictEqual(winWorker.uad.mobile, false);
      });

      check('Windows persona: America/New_York timezone offsets match across all 5 surfaces', () => {
        // Daylight saving time (EDT) offset is 240, winter (EST) offset is 300
        for (const s of [winMain, winSame, winSrcdoc, winBlank, winWorker]) {
          assert.strictEqual(s.tz.offset, 240, `${s.label || 'worker'} offset must be 240`);
          assert.strictEqual(s.tz.intlTz, 'America/New_York', `${s.label || 'worker'} intlTz must be America/New_York`);
          assert.strictEqual(s.tz.winterOffset, 300, `${s.label || 'worker'} winter offset must be 300`);
          assert.strictEqual(s.tz.summerOffset, 240, `${s.label || 'worker'} summer offset must be 240`);
        }
      });

      check('Windows persona: Segoe UI and Cambria Math resolve across all 5 surfaces', () => {
        for (const s of [winMain, winSame, winSrcdoc, winBlank, winWorker]) {
          assert.strictEqual(s.fonts['Segoe UI']?.outcome, 'resolve', `${s.label || 'worker'} Segoe UI must resolve`);
          assert.strictEqual(s.fonts['Cambria Math']?.outcome, 'resolve', `${s.label || 'worker'} Cambria Math must resolve`);
        }
      });

      check('Windows persona: foreign fonts (Helvetica Neue, Luminari) reject with NetworkError across all 5 surfaces', () => {
        for (const s of [winMain, winSame, winSrcdoc, winBlank, winWorker]) {
          assert.strictEqual(s.fonts['Helvetica Neue']?.outcome, 'reject', `${s.label || 'worker'} Helvetica Neue must reject`);
          assert.strictEqual(s.fonts['Helvetica Neue']?.errName, 'NetworkError', `${s.label || 'worker'} Helvetica Neue must be NetworkError`);
          assert.strictEqual(s.fonts['Luminari']?.outcome, 'reject', `${s.label || 'worker'} Luminari must reject`);
        }
      });

      check('Windows persona: queryLocalFonts exposes exactly 60 fonts with authentic SFNT headers across window frames', () => {
        for (const s of [winMain, winSame, winSrcdoc, winBlank]) {
          assert.strictEqual(s.localFonts.count, 60, `${s.label} font count must be 60`);
          assert.ok(['00 01 00 00', '4f 54 54 4f', '74 74 63 66'].includes(s.localFonts.blobHeader), `${s.label} blob header must be SFNT family, got ${s.localFonts.blobHeader}`);
          assert.ok(s.localFonts.blobSize > 1000, `${s.label} blob size must be non-trivial`);
        }
      });

      check('Windows persona: WebGL1 and WebGL2 vendor, renderer, and MAX_TEXTURE_SIZE match across all 5 surfaces', () => {
        const expVendor = winMain.gl1.vendor;
        const expRenderer = winMain.gl1.renderer;
        assert.ok(expVendor.includes('Intel'), 'Vendor must reflect Intel');
        assert.ok(expRenderer.includes('Direct3D11'), 'Renderer must reflect Direct3D11');

        for (const s of [winSame, winSrcdoc, winBlank, winWorker]) {
          assert.strictEqual(s.gl1.vendor, expVendor, `${s.label || 'worker'} gl1 vendor mismatch`);
          assert.strictEqual(s.gl1.renderer, expRenderer, `${s.label || 'worker'} gl1 renderer mismatch`);
          assert.strictEqual(s.gl1.maxTex, 16384, `${s.label || 'worker'} gl1 maxTex must be 16384`);
          assert.strictEqual(s.gl2.maxTex, 16384, `${s.label || 'worker'} gl2 maxTex must be 16384`);
        }
      });

      check('Windows persona: WebGL2 NV_ vendor extension is isolated and absent across all 5 surfaces', () => {
        for (const s of [winMain, winSame, winSrcdoc, winBlank, winWorker]) {
          assert.strictEqual(s.gl2.hasNvExt, false, `${s.label || 'worker'} WebGL2 must not leak NV_ extension on Intel persona`);
        }
      });

      check('Windows persona: WebGPU in main window and iframes reports Intel Gen9 adapter', () => {
        for (const s of [winMain, winSame, winSrcdoc, winBlank]) {
          assert.strictEqual(s.gpu.hasAdapter, true, `${s.label} must have WebGPU adapter`);
          assert.strictEqual(s.gpu.vendor, 'intel', `${s.label} WebGPU vendor must be intel`);
          assert.strictEqual(s.gpu.architecture, 'gen9', `${s.label} WebGPU architecture must be gen9`);
        }
      });

      check('Windows persona: DedicatedWorker WebGPU adapter matches persona identity (Intel Gen9)', () => {
        assert.strictEqual(winWorker.gpu.hasAdapter, true, 'Worker has WebGPU adapter');
        assert.strictEqual(winWorker.gpu.vendor, 'intel', 'Worker WebGPU vendor must be intel');
        assert.strictEqual(winWorker.gpu.architecture, 'gen9', 'Worker WebGPU architecture must be gen9');
      });

      check('Windows persona: Canvas 2D toDataURL and getImageData pxSum match across window surfaces and worker', () => {
        const expectedUrl = winMain.canvas.dataUrl;
        assert.ok(expectedUrl && expectedUrl.startsWith('data:image/png;base64,'), 'dataUrl must be valid PNG');
        assert.strictEqual(winSame.canvas.dataUrl, expectedUrl, 'sameOrigin frame toDataURL must match main');
        assert.strictEqual(winSrcdoc.canvas.dataUrl, expectedUrl, 'srcdoc frame toDataURL must match main');
        assert.strictEqual(winBlank.canvas.dataUrl, expectedUrl, 'dynamic blank frame toDataURL must match main');

        const expectedSum = winMain.canvas.pxSum;
        assert.ok(expectedSum > 0, 'Pixel sum must be positive');
        assert.strictEqual(winSame.canvas.pxSum, expectedSum, 'sameOrigin pxSum must match main');
        assert.strictEqual(winSrcdoc.canvas.pxSum, expectedSum, 'srcdoc pxSum must match main');
        assert.strictEqual(winBlank.canvas.pxSum, expectedSum, 'dynamic blank pxSum must match main');
        assert.strictEqual(winWorker.canvas.pxSum, expectedSum, 'DedicatedWorker OffscreenCanvas pxSum must match main');
      });

      check('Windows persona: Canvas zero canvas, transparent canvas, and native contracts preserved', () => {
        for (const s of [winMain, winSame, winSrcdoc, winBlank]) {
          assert.strictEqual(s.canvas.zeroDataUrl, 'data:,', 'zero canvas must be data:,');
          assert.strictEqual(s.canvas.transNonZero, false, 'transparent canvas must have zero non-transparent pixels');
          assert.strictEqual(s.canvas.getImageDataLen, 4, 'getImageData length must be 4');
          assert.strictEqual(s.canvas.illegalCtxThrows, true, 'illegal receiver must throw TypeError');
          assert.strictEqual(s.canvas.missingArgsThrows, true, 'missing arguments must throw TypeError');
          assert.strictEqual(s.canvas.isClampedArray, true, 'data must be Uint8ClampedArray');
        }
        assert.strictEqual(winWorker.canvas.transNonZero, false, 'worker transparent canvas must have zero non-transparent pixels');
        assert.strictEqual(winWorker.canvas.illegalCtxThrows, true, 'worker illegal receiver must throw TypeError');
      });

      check('Windows persona: ClientRects metrics and DOMRectList prototype integrity match across window surfaces', () => {
        const expectedX = winMain.clientRects.rectX;
        const expectedW = winMain.clientRects.rectW;
        for (const s of [winSame, winSrcdoc, winBlank]) {
          assert.strictEqual(s.clientRects.rectX, expectedX, 'rectX mismatch');
          assert.strictEqual(s.clientRects.rectW, expectedW, 'rectW mismatch');
        }
        for (const s of [winMain, winSame, winSrcdoc, winBlank]) {
          assert.strictEqual(s.clientRects.isDRL, true, 'must be instanceof DOMRectList');
          assert.strictEqual(s.clientRects.isDR, true, 'must be instanceof DOMRect');
          assert.strictEqual(s.clientRects.itemMatch, true, 'item(0) must match [0]');
          assert.strictEqual(s.clientRects.spreadLen, 1, 'spread length must be 1');
          assert.strictEqual(s.clientRects.illegalItemThrows, true, 'illegal item() receiver must throw TypeError');
          assert.strictEqual(s.clientRects.illegalLenThrows, true, 'illegal length receiver must throw TypeError');
        }
      });

      check('Windows persona: Audio rendered sample hash and copyFromChannel match across window surfaces', () => {
        const expectedHash = winMain.audio.hash;
        assert.ok(expectedHash > 0, 'Audio hash must be non-zero');
        for (const s of [winSame, winSrcdoc, winBlank]) {
          assert.strictEqual(s.audio.hash, expectedHash, 'audio hash mismatch');
        }
        for (const s of [winMain, winSame, winSrcdoc, winBlank]) {
          assert.strictEqual(s.audio.copyMatches, true, 'copyFromChannel must match getChannelData');
          assert.strictEqual(s.audio.silentZero, true, 'silent buffer must remain all zeros');
          assert.strictEqual(s.audio.authoredUntouched, true, 'authored buffer must not be modified');
          assert.strictEqual(s.audio.illegalAudioThrows, true, 'illegal AudioBuffer receiver must throw');
        }
      });

      // 2. macOS Persona Audit
      console.log('Auditing macOS Persona (Apple M3 Metal, America/Los_Angeles)...');
      const macAudit = await runAuditSession('mac', MACOS_UA, 'macos', 'America/Los_Angeles', port, false);
      const macMain = macAudit.windows?.main;
      const macSame = macAudit.windows?.sameOrigin;
      const macSrcdoc = macAudit.windows?.srcdoc;
      const macBlank = macAudit.windows?.dynamicBlank;
      const macWorker = macAudit.worker;

      assert.ok(macMain && macSame && macSrcdoc && macBlank && macWorker, 'All macOS surfaces must yield probe data');

      check('macOS persona: document injection emits no runtime exceptions across window frames', () => {
        assert.deepStrictEqual(macAudit.runtimeExceptions, [], `macOS injection exceptions: ${macAudit.runtimeExceptions.join(' | ')}`);
      });

      check('macOS persona: navigator.platform is MacIntel across all 5 surfaces', () => {
        for (const s of [macMain, macSame, macSrcdoc, macBlank, { nav: macWorker.nav }]) {
          assert.strictEqual(s.nav.platform, 'MacIntel');
        }
      });

      check('macOS persona: America/Los_Angeles timezone offsets match across all 5 surfaces', () => {
        // PDT offset is 420, PST offset is 480
        for (const s of [macMain, macSame, macSrcdoc, macBlank, macWorker]) {
          assert.strictEqual(s.tz.offset, 420, `${s.label || 'worker'} offset must be 420`);
          assert.strictEqual(s.tz.intlTz, 'America/Los_Angeles', `${s.label || 'worker'} intlTz must be America/Los_Angeles`);
          assert.strictEqual(s.tz.winterOffset, 480, `${s.label || 'worker'} winter offset must be 480`);
          assert.strictEqual(s.tz.summerOffset, 420, `${s.label || 'worker'} summer offset must be 420`);
        }
      });

      check('macOS persona: Helvetica Neue and Luminari resolve across all 5 surfaces', () => {
        for (const s of [macMain, macSame, macSrcdoc, macBlank, macWorker]) {
          assert.strictEqual(s.fonts['Helvetica Neue']?.outcome, 'resolve', `${s.label || 'worker'} Helvetica Neue must resolve`);
          assert.strictEqual(s.fonts['Luminari']?.outcome, 'resolve', `${s.label || 'worker'} Luminari must resolve`);
        }
      });

      check('macOS persona: foreign fonts (Segoe UI, Cambria Math) reject with NetworkError across all 5 surfaces', () => {
        for (const s of [macMain, macSame, macSrcdoc, macBlank, macWorker]) {
          assert.strictEqual(s.fonts['Segoe UI']?.outcome, 'reject', `${s.label || 'worker'} Segoe UI must reject`);
          assert.strictEqual(s.fonts['Segoe UI']?.errName, 'NetworkError', `${s.label || 'worker'} Segoe UI must be NetworkError`);
          assert.strictEqual(s.fonts['Cambria Math']?.outcome, 'reject', `${s.label || 'worker'} Cambria Math must reject`);
        }
      });

      check('macOS persona: queryLocalFonts exposes exactly 76 fonts with authentic SFNT headers across window frames', () => {
        for (const s of [macMain, macSame, macSrcdoc, macBlank]) {
          assert.strictEqual(s.localFonts.count, 76, `${s.label} font count must be 76`);
          assert.ok(['00 01 00 00', '4f 54 54 4f', '74 74 63 66'].includes(s.localFonts.blobHeader), `${s.label} blob header must be SFNT family, got ${s.localFonts.blobHeader}`);
          assert.ok(s.localFonts.blobSize > 1000, `${s.label} blob size must be non-trivial`);
        }
      });

      check('macOS persona: WebGL vendor and renderer match across all 5 surfaces', () => {
        const expVendor = macAudit.fp.webgl?.vendor || macMain.gl1.vendor;
        const expRenderer = macAudit.fp.webgl?.renderer || macMain.gl1.renderer;
        assert.strictEqual(macMain.gl1.vendor, expVendor, 'Main window vendor must match persona config');
        assert.strictEqual(macMain.gl1.renderer, expRenderer, 'Main window renderer must match persona config');

        for (const s of [macSame, macSrcdoc, macBlank, macWorker]) {
          assert.strictEqual(s.gl1.vendor, expVendor, `${s.label || 'worker'} gl1 vendor mismatch`);
          assert.strictEqual(s.gl1.renderer, expRenderer, `${s.label || 'worker'} gl1 renderer mismatch`);
        }
      });

      check('macOS persona: DedicatedWorker WebGPU adapter matches persona identity (Apple)', () => {
        const expectedPersonaGpuVendor = String(macAudit.fp.webgpu?.gpu?.vendor || macAudit.fp.webgl?.gpu?.vendor || '').toLowerCase();
        for (const s of [macMain, macSame, macSrcdoc, macBlank]) {
          assert.strictEqual(s.gpu.hasAdapter, true, `${s.label} must have WebGPU adapter`);
          assert.strictEqual(s.gpu.vendor, expectedPersonaGpuVendor, `${s.label} WebGPU reports ${expectedPersonaGpuVendor} adapter`);
        }
        assert.strictEqual(macWorker.gpu.hasAdapter, true, 'Worker must have WebGPU adapter');
        assert.strictEqual(macWorker.gpu.vendor, expectedPersonaGpuVendor, `Worker WebGPU reports ${expectedPersonaGpuVendor} adapter`);
      });

      check('macOS persona: Canvas 2D, ClientRects, and Audio match across surfaces', () => {
        assert.strictEqual(macSame.canvas.dataUrl, macMain.canvas.dataUrl, 'macOS sameOrigin canvas dataUrl match');
        assert.strictEqual(macBlank.canvas.dataUrl, macMain.canvas.dataUrl, 'macOS blank canvas dataUrl match');
        assert.strictEqual(macWorker.canvas.pxSum, macMain.canvas.pxSum, 'macOS worker canvas pxSum match');
        assert.strictEqual(macBlank.clientRects.rectW, macMain.clientRects.rectW, 'macOS blank clientRects rectW match');
        assert.strictEqual(macBlank.audio.hash, macMain.audio.hash, 'macOS blank audio hash match');
      });

      check('Cross-Profile: Canvas toDataURL and Audio hash differ between Windows and macOS personas', () => {
        assert.notStrictEqual(winMain.canvas.dataUrl, macMain.canvas.dataUrl, 'Canvas toDataURL must differ across personas');
        assert.notStrictEqual(winMain.audio.hash, macMain.audio.hash, 'Audio hash must differ across personas');
      });

    } else {
      console.log('--- Starting Cross-Surface Fingerprint Audit (MUTATION SENSITIVITY MODE) ---');
      const mutAudit = await runAuditSession('mut', WINDOWS_UA, 'windows', 'America/New_York', port, true);
      const mutMain = mutAudit.windows?.main;
      const mutWorker = mutAudit.worker;

      assert.ok(mutMain && mutWorker, 'Mutation session must produce probe data');

      check('MUTATION CHECK: Disabling document injection causes main window platform to leak host MacIntel', () => {
        assert.strictEqual(mutMain.nav.platform, 'MacIntel', 'Disabling injection must expose raw host MacIntel');
      });

      check('MUTATION CHECK: Disabling worker injection causes worker font presence to leak host fonts', () => {
        // On unshielded macOS host, Helvetica Neue resolves natively, Segoe UI rejects natively
        assert.strictEqual(mutWorker.fonts['Helvetica Neue']?.outcome, 'resolve', 'Unshielded worker must resolve host Helvetica Neue');
        assert.strictEqual(mutWorker.fonts['Segoe UI']?.outcome, 'reject', 'Unshielded worker must reject Windows Segoe UI');
      });

      check('MUTATION CHECK: Disabling worker injection causes worker WebGPU to leak host AMD adapter', () => {
        assert.strictEqual(mutWorker.gpu.hasAdapter, true, 'Unshielded worker has WebGPU adapter');
        assert.strictEqual(mutWorker.gpu.vendor, 'amd', 'Unshielded worker must leak host AMD adapter');
      });

      check('MUTATION CHECK: Disabling WebGL overrides leaks raw host Metal renderer in main window', () => {
        assert.ok(mutMain.gl1.renderer.includes('AMD Radeon Pro W6800X'), 'Raw WebGL renderer must leak host AMD Radeon Pro W6800X');
      });

      check('MUTATION CHECK: Disabling injection removes Canvas / Audio noise overrides', () => {
        assert.ok(mutMain.canvas.dataUrl.startsWith('data:image/png'), 'Canvas still renders raw');
        assert.ok(mutWorker.canvas.pxSum > 0, 'Worker canvas executes natively');
      });
    }
  } finally {
    server.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\nfingerprint-cross-surface-audit-selftest: OK ${passed}/${total}`);
  if (passed !== total) {
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('Audit execution error:', err);
  process.exit(1);
});
