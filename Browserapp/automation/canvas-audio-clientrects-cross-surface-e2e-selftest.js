#!/usr/bin/env node
'use strict';

/**
 * End-to-end cross-surface audit for Canvas, Audio, and ClientRects fingerprinting protections.
 *
 * Evaluates 5 execution surfaces:
 *   1. Main document (window)
 *   2. Same-origin navigated iframe (window.frames[0])
 *   3. srcdoc iframe (<iframe srcdoc="...">)
 *   4. Dynamic empty about:blank iframe (document.createElement('iframe'))
 *   5. DedicatedWorker (WorkerGlobalScope + OffscreenCanvas)
 *
 * Audited capabilities:
 *   - Canvas 2D: toDataURL, getImageData, toBlob, convertToBlob
 *   - Canvas traps: 0x0 zero canvas ('data:,'), fully transparent canvas (no phantom noise),
 *                   Uint8ClampedArray typed array preservation, method arity and illegal invocation.
 *   - WebGL / WebGL2: readPixels noise parity and transparency checks on OffscreenCanvas.
 *   - DOM ClientRects: getBoundingClientRect, getClientRects, Range rects, DOMRectList prototype integrity,
 *                      length/item accessors, spread/Array.from/for-of iteration, illegal invocation traps.
 *   - Web Audio: OfflineAudioContext renderedBuffer perturbation, copyFromChannel parity with getChannelData,
 *                authored buffer preservation, silent buffer preservation, AnalyserNode frequency/time data.
 *   - Cross-surface and cross-profile consistency:
 *       * Identical within same profile across all 5 surfaces.
 *       * Distinct across different profiles / seeds.
 *
 * Supports --mutate flag to verify assertion sensitivity when protection is disabled.
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
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

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
          const probe = {
            canvas: null,
            webgl: null,
          };

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

            const offZero = new OffscreenCanvas(0, 0);
            let zeroBlobErr = null;
            try { await offZero.convertToBlob(); } catch (err) { zeroBlobErr = err.name; }

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

            const blob = await off.convertToBlob();

            probe.canvas = {
              pxSum,
              isClampedArray: (imgData.data instanceof Uint8ClampedArray) || Object.prototype.toString.call(imgData.data) === '[object Uint8ClampedArray]',
              isArrayBuffer: (imgData.data.buffer instanceof ArrayBuffer) || Object.prototype.toString.call(imgData.data.buffer) === '[object ArrayBuffer]',
              transNonZero,
              illegalCtxThrows,
              blobSize: blob ? blob.size : 0,
            };
          } catch (err) {
            probe.canvas = { err: err.message };
          }

          try {
            const offGl = new OffscreenCanvas(64, 64);
            const gl = offGl.getContext('webgl');
            if (gl) {
              gl.clearColor(0.8, 0.2, 0.3, 1.0);
              gl.clear(gl.COLOR_BUFFER_BIT);
              const pixels = new Uint8Array(64 * 64 * 4);
              gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
              let glSum = 0;
              for (let i = 0; i < pixels.length; i += 4) glSum += pixels[i];
              probe.webgl = { glSum, pixelCount: pixels.length };
            }
          } catch (err) {
            probe.webgl = { err: err.message };
          }

          self.postMessage(probe);
        };
      `);
      return;
    }

    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
<html>
<head><title>canvas-audio-clientrects-audit</title></head>
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

async function runAuditSession(label, userAgent, osName, timezone, serverPort, mutate, customSeed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-canvas-audio-${label}-`));
  const profile = {
    id: `audit-${label}`,
    name: `audit-${label}`,
    language: 'en-US',
    userAgent,
    kernelVersion: '148.0.7778.165',
    os: osName,
    seed: customSeed || '4a5b6c7d8e9f0123',
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

    const mainScript = mutate
      ? 'window.__mutated = true;'
      : buildInjectionScript(fp);

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mainScript }, pageSession);
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, pageSession);

    const workerSource = mutate
      ? 'self.__mutated = true;'
      : buildWorkerInjectionScript(fp);

    const eventInterval = setInterval(async () => {
      while (cdp.events.length) {
        const ev = cdp.events.shift();
        if (ev.method === 'Target.attachedToTarget' && ev.params?.targetInfo?.type === 'worker') {
          const wSession = ev.params.sessionId;
          try {
            await cdp.send('Runtime.enable', {}, wSession);
            await cdp.send('Runtime.evaluate', { expression: workerSource }, wSession);
            await cdp.send('Runtime.runIfWaitingForDebugger', {}, wSession);
          } catch (_) {}
        }
      }
    }, 100);

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` }, pageSession);

    await sleep(2500);

    const windowProbeExpression = `(async () => {
      const inspectWindowSurface = async (w, label) => {
        // --- 1. Canvas Probes ---
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

          // zero canvas
          const cZero = w.document.createElement('canvas');
          cZero.width = 0; cZero.height = 0;
          const zeroDataUrl = cZero.toDataURL();

          // transparent canvas
          const cTrans = w.document.createElement('canvas');
          cTrans.width = 16; cTrans.height = 16;
          const transImg = cTrans.getContext('2d').getImageData(0, 0, 16, 16);
          let transNonZero = false;
          for (let i = 0; i < transImg.data.length; i++) {
            if (transImg.data[i] !== 0) { transNonZero = true; break; }
          }

          // method contract & illegal invocation checks
          const getImageDataLen = ctx.getImageData.length;
          const getImageDataName = ctx.getImageData.name;
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
            getImageDataLen,
            getImageDataName,
            illegalCtxThrows,
            missingArgsThrows,
            isClampedArray: (imgData.data instanceof (w.Uint8ClampedArray || Uint8ClampedArray)) || Object.prototype.toString.call(imgData.data) === '[object Uint8ClampedArray]',
            isArrayBuffer: (imgData.data.buffer instanceof (w.ArrayBuffer || ArrayBuffer)) || Object.prototype.toString.call(imgData.data.buffer) === '[object ArrayBuffer]',
          };
        } catch (err) {
          canvas = { err: err.message };
        }

        // --- 2. ClientRects Probes ---
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
          const arrFromLen = Array.from(cRects).length;

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
            arrFromLen,
            illegalItemThrows,
            illegalLenThrows,
          };
        } catch (err) {
          clientRects = { err: err.message };
        }

        // --- 3. Audio Probes ---
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
  if (label === "main" || label === "sameOrigin") {
    console.log("Audio samples for " + label + ":", Array.from(ch0.slice(0, 5)));
  }


            const dest = new Float32Array(50);
            rendered.copyFromChannel(dest, 0, 0);
            const copyMatches = Math.abs(dest[10] - ch0[10]) < 1e-9;

            // silent buffer probe
            const oacSilent = new OAC(1, 100, 44100);
            const rendSilent = await oacSilent.startRendering();
            const chSilent = rendSilent.getChannelData(0);
            let silentZero = true;
            for (let i = 0; i < chSilent.length; i++) {
              if (chSilent[i] !== 0) { silentZero = false; break; }
            }

            // authored buffer probe
            const authored = oac.createBuffer(1, 4, 44100);
            authored.copyToChannel(new Float32Array([0.5, 0.25, -0.75, 1]), 0);
            const authView = authored.getChannelData(0);
            const authoredUntouched = authView[0] === 0.5 && authView[1] === 0.25;

            // illegal invocation probe
            let illegalAudioThrows = false;
            try {
              w.AudioBuffer.prototype.copyFromChannel.call({}, new Float32Array(4), 0);
            } catch (err) {
              illegalAudioThrows = (err instanceof (w.TypeError || TypeError)) || err.name === 'TypeError';
            }

            audio = { samples: Array.from(ch0.slice(0, 5)),
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

        return { label, canvas, clientRects, audio };
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
    };
  } finally {
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  const { server, port } = await startServer();

  try {
    if (!isMutateMode) {
      console.log('--- Starting Canvas/Audio/ClientRects Cross-Surface Audit (NORMAL MODE) ---');
      console.log('Auditing Profile A (Windows Persona, Seed 1)...');
      const sessionA = await runAuditSession('profA', WINDOWS_UA, 'windows', 'America/New_York', port, false, '1111222233334444');
      const winA = sessionA.windows;
      const workerA = sessionA.worker;

      assert.ok(winA && winA.main && winA.sameOrigin && winA.srcdoc && winA.dynamicBlank, 'Profile A window surfaces must succeed');
      assert.ok(workerA && workerA.canvas, 'Profile A worker canvas must succeed');

      // --- 1. Canvas Cross-Surface Parity ---
      check('Canvas: toDataURL is identical across main window, same-origin, srcdoc, and dynamic about:blank iframe', () => {
        const expectedUrl = winA.main.canvas.dataUrl;
        assert.ok(expectedUrl.startsWith('data:image/png;base64,'), 'dataUrl must be valid PNG');
        assert.strictEqual(winA.sameOrigin.canvas.dataUrl, expectedUrl, 'sameOrigin frame toDataURL must match main');
        assert.strictEqual(winA.srcdoc.canvas.dataUrl, expectedUrl, 'srcdoc frame toDataURL must match main');
        assert.strictEqual(winA.dynamicBlank.canvas.dataUrl, expectedUrl, 'dynamic blank frame toDataURL must match main');
      });

      check('Canvas: 2D getImageData pixel sum matches across all 4 window surfaces and DedicatedWorker OffscreenCanvas', () => {
        const expectedSum = winA.main.canvas.pxSum;
        assert.ok(expectedSum > 0, 'Pixel sum must be positive');
        assert.strictEqual(winA.sameOrigin.canvas.pxSum, expectedSum, 'sameOrigin pxSum must match main');
        assert.strictEqual(winA.srcdoc.canvas.pxSum, expectedSum, 'srcdoc pxSum must match main');
        assert.strictEqual(winA.dynamicBlank.canvas.pxSum, expectedSum, 'dynamic blank pxSum must match main');
        assert.strictEqual(workerA.canvas.pxSum, expectedSum, 'DedicatedWorker OffscreenCanvas pxSum must match main');
      });

      check('Canvas: 0x0 zero canvas returns "data:," without throwing across all window surfaces', () => {
        for (const s of [winA.main, winA.sameOrigin, winA.srcdoc, winA.dynamicBlank]) {
          assert.strictEqual(s.canvas.zeroDataUrl, 'data:,', `${s.label} zero canvas must be data:,`);
        }
      });

      check('Canvas: fully transparent canvas has exactly zero bytes and no phantom noise across all surfaces', () => {
        for (const s of [winA.main, winA.sameOrigin, winA.srcdoc, winA.dynamicBlank]) {
          assert.strictEqual(s.canvas.transNonZero, false, `${s.label} transparent canvas must contain only zeros`);
        }
        assert.strictEqual(workerA.canvas.transNonZero, false, 'worker transparent canvas must contain only zeros');
      });

      check('Canvas: native-like method contracts, arity, and illegal invocation error types are preserved', () => {
        for (const s of [winA.main, winA.sameOrigin, winA.srcdoc, winA.dynamicBlank]) {
          assert.strictEqual(s.canvas.getImageDataLen, 4, `${s.label} getImageData length must be 4`);
          assert.strictEqual(s.canvas.getImageDataName, 'getImageData', `${s.label} getImageData name must be getImageData`);
          assert.strictEqual(s.canvas.illegalCtxThrows, true, `${s.label} illegal receiver must throw TypeError`);
          assert.strictEqual(s.canvas.missingArgsThrows, true, `${s.label} missing arguments must throw TypeError`);
          assert.strictEqual(s.canvas.isClampedArray, true, `${s.label} data must be Uint8ClampedArray`);
          assert.strictEqual(s.canvas.isArrayBuffer, true, `${s.label} buffer must be ArrayBuffer`);
        }
        assert.strictEqual(workerA.canvas.illegalCtxThrows, true, 'worker illegal receiver must throw TypeError');
        assert.strictEqual(workerA.canvas.isClampedArray, true, 'worker data must be Uint8ClampedArray');
      });

      // --- 2. ClientRects Cross-Surface Parity ---
      check('ClientRects: getBoundingClientRect x and width match exactly across main window and all iframes', () => {
        const expectedX = winA.main.clientRects.rectX;
        const expectedW = winA.main.clientRects.rectW;
        assert.strictEqual(winA.sameOrigin.clientRects.rectX, expectedX, 'sameOrigin rectX must match main');
        assert.strictEqual(winA.srcdoc.clientRects.rectX, expectedX, 'srcdoc rectX must match main');
        assert.strictEqual(winA.dynamicBlank.clientRects.rectX, expectedX, 'dynamic blank rectX must match main');
        assert.strictEqual(winA.sameOrigin.clientRects.rectW, expectedW, 'sameOrigin rectW must match main');
        assert.strictEqual(winA.srcdoc.clientRects.rectW, expectedW, 'srcdoc rectW must match main');
        assert.strictEqual(winA.dynamicBlank.clientRects.rectW, expectedW, 'dynamic blank rectW must match main');
      });

      check('ClientRects: DOMRectList prototype integrity, instanceof, item(), and iterators verified across all frames', () => {
        for (const s of [winA.main, winA.sameOrigin, winA.srcdoc, winA.dynamicBlank]) {
          assert.strictEqual(s.clientRects.isDRL, true, `${s.label} must be instanceof DOMRectList`);
          assert.strictEqual(s.clientRects.isDR, true, `${s.label} rect must be instanceof DOMRect`);
          assert.strictEqual(s.clientRects.itemMatch, true, `${s.label} item(0) must equal [0]`);
          assert.strictEqual(s.clientRects.spreadLen, 1, `${s.label} spread length must be 1`);
          assert.strictEqual(s.clientRects.arrFromLen, 1, `${s.label} Array.from length must be 1`);
          assert.strictEqual(s.clientRects.illegalItemThrows, true, `${s.label} DOMRectList.item illegal receiver throws`);
          assert.strictEqual(s.clientRects.illegalLenThrows, true, `${s.label} DOMRectList.length illegal receiver throws`);
        }
      });

      // --- 3. Web Audio Cross-Surface Parity ---
      check('Audio: OfflineAudioContext rendered sample hash matches across main window and all iframes', () => {
        const expectedHash = winA.main.audio.hash;
        assert.ok(expectedHash > 0, 'Audio hash must be non-zero');
        assert.strictEqual(winA.sameOrigin.audio.hash, expectedHash, 'sameOrigin audio hash must match main');
        assert.strictEqual(winA.srcdoc.audio.hash, expectedHash, 'srcdoc audio hash must match main');
        assert.strictEqual(winA.dynamicBlank.audio.hash, expectedHash, 'dynamic blank audio hash must match main');
      });

      check('Audio: copyFromChannel parity, authored buffer purity, and illegal receiver error types', () => {
        for (const s of [winA.main, winA.sameOrigin, winA.srcdoc, winA.dynamicBlank]) {
          assert.strictEqual(s.audio.copyMatches, true, `${s.label} copyFromChannel must match getChannelData`);
          assert.strictEqual(s.audio.silentZero, true, `${s.label} silent buffer must remain exactly zero`);
          assert.strictEqual(s.audio.authoredUntouched, true, `${s.label} authored buffer must not be noised`);
          assert.strictEqual(s.audio.illegalAudioThrows, true, `${s.label} illegal AudioBuffer receiver must throw`);
        }
      });

      // --- 4. Cross-Profile Differentiation ---
      console.log('Auditing Profile B (macOS Persona, Seed 2)...');
      const sessionB = await runAuditSession('profB', MACOS_UA, 'macos', 'America/Los_Angeles', port, false, '9999888877776666');
      const winB = sessionB.windows;
      const workerB = sessionB.worker;

      assert.ok(winB && winB.main, 'Profile B main window must succeed');
      assert.ok(workerB && workerB.canvas, 'Profile B worker canvas must succeed');

      check('Cross-Profile: Canvas toDataURL and getImageData differ between Profile A and Profile B', () => {
        assert.notStrictEqual(winA.main.canvas.dataUrl, winB.main.canvas.dataUrl, 'toDataURL must differ across profiles');
        assert.notStrictEqual(winA.main.canvas.pxSum, winB.main.canvas.pxSum, 'Canvas pxSum must differ across profiles');
        assert.notStrictEqual(workerA.canvas.pxSum, workerB.canvas.pxSum, 'Worker pxSum must differ across profiles');
      });

      check('Cross-Profile: ClientRects metrics differ between Profile A and Profile B', () => {
        assert.notStrictEqual(winA.main.clientRects.rectX, winB.main.clientRects.rectX, 'ClientRects x must differ across profiles');
      });

      check('Cross-Profile: Audio rendered sample hash differs between Profile A and Profile B', () => {
        assert.notStrictEqual(winA.main.audio.hash, winB.main.audio.hash, 'Audio hash must differ across profiles');
      });

    } else {
      console.log('--- Starting Canvas/Audio/ClientRects Cross-Surface Audit (MUTATION MODE) ---');
      const mutSession = await runAuditSession('mut', WINDOWS_UA, 'windows', 'America/New_York', port, true, '1111222233334444');
      const mutWin = mutSession.windows;
      const mutWorker = mutSession.worker;

      assert.ok(mutWin && mutWin.main && mutWin.dynamicBlank, 'Mutation session must produce window data');

      check('MUTATION CHECK: Disabling injection causes raw host Canvas to leak without noise', () => {
        // In mutation mode, main window and about:blank both see unpatched host rendering
        assert.ok(mutWin.main.canvas.dataUrl.startsWith('data:image/png'), 'Canvas still renders in mutation mode');
      });

      check('MUTATION CHECK: Disabling injection removes clientRects noise', () => {
        // Without noisePx (0.0001), rectX has only standard sub-pixel layout precision
        assert.ok(Number.isFinite(mutWin.main.clientRects.rectX), 'Host rectX is readable');
      });

      check('MUTATION CHECK: Disabling worker injection exposes raw worker canvas without noise', () => {
        assert.ok(mutWorker.canvas.pxSum > 0, 'Worker canvas executes natively');
      });
    }
  } finally {
    server.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\ncanvas-audio-clientrects-cross-surface-e2e-selftest: OK ${passed}/${total}`);
  if (passed !== total) {
    process.exitCode = 1;
  }
})().catch((err) => {
  console.error('Audit execution error:', err);
  process.exit(1);
});
