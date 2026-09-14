#!/usr/bin/env node
'use strict';

/**
 * System font presence exit audit selftest.
 *
 * Enumerate and measure all browser exit surfaces capable of revealing whether
 * a specific system font is installed on the underlying host machine.
 * Compares RAW execution (unmodified engine on host) against INJECTED execution
 * (production buildInjectionScript under Windows persona).
 *
 * Verifies covered spoofing layers and pins KNOWN GAPs across all enumerated exits.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { buildWorkerFontPresenceSource } = require('./worker-font-presence-fallback');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const TEST_FAMILIES = [
  'Helvetica Neue',
  'Luminari',
  'Galvji',
  'Segoe UI',
  'Cambria Math',
];

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log('  PASS  ' + name);
  } catch (error) {
    results.push({ name, ok: false });
    console.log('  FAIL  ' + name + ' - ' + error.message);
    process.exitCode = 1;
  }
};

const skip = (name, why) => {
  results.push({ name, ok: true });
  console.log('  SKIP  ' + name + (why ? ' - ' + why : ''));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve(message);
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
        resolve({ error: { message: 'CDP timeout: ' + method } });
      }, 30000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.ws.send(JSON.stringify(msg));
    });
  }
  call(method, params = {}) { return this.send(method, params); }
  async value(expression) {
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: (exception.exception && exception.exception.description) || exception.text || JSON.stringify(exception) };
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return { error: 'probe parse', raw: String(raw).slice(0, 240) }; }
  }
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync('pkill -f "user-data-dir=' + dir + '" 2>/dev/null || true'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function waitForPage(port, timeoutMs = 16000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = (list || []).find((item) => item.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(300);
  }
  return null;
}

function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/worker.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(`
        self.onmessage = async (e) => {
          const families = e.data.families;
          const output = {};
          for (const fam of families) {
            let check0px = "ERR";
            try { check0px = self.fonts.check('0px "' + fam + '"'); } catch (err) { check0px = "EX:" + err.name; }

            let load16pxLen = "ERR";
            try {
              const loaded = await self.fonts.load('16px "' + fam + '"');
              load16pxLen = loaded.length;
            } catch (err) { load16pxLen = "EX:" + err.name; }

            let fontFaceStatus = "ERR";
            try {
              const ff = new FontFace(fam, 'local("' + fam + '")');
              await ff.load();
              fontFaceStatus = ff.status;
            } catch (err) { fontFaceStatus = "REJ:" + err.name; }

            output[fam] = { check0px, load16pxLen, fontFaceStatus };
          }
          self.postMessage(output);
        };
      `);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>Font Audit</title></head><body><main>Audit</main></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

const PROBE_RUNNER = function(families) {
  return (async () => {
    const testText = "mmmmmmmmmmlli";

    const out = {
      marker: typeof window.__marker !== "undefined" ? window.__marker : null,
      fontsCheck0px: {},
      fontsLoad16px: {},
      fontsCollection: {
        spreadLength: [...document.fonts].length,
        size: document.fonts.size,
      },
      fontFaceLocalLoad: {},
      cssFontFace: {},
      canvasMeasure: {},
      domOffsetWidth: {},
      offscreenCanvas: {},
      worker: {},
      queryLocalFontsResult: null,
      svgComputedTextLength: {},
      canvasThreeWayFallback: {},
      canvasBoundingBox: {},
    };

    // Exit 1: document.fonts.check('0px "<family>"')
    for (const fam of families) {
      try {
        out.fontsCheck0px[fam] = document.fonts.check('0px "' + fam + '"');
      } catch (e) {
        out.fontsCheck0px[fam] = "EX:" + e.name;
      }
    }

    // Exit 2: await document.fonts.load('16px "<family>"') returned array length
    for (const fam of families) {
      try {
        const loaded = await document.fonts.load('16px "' + fam + '"');
        out.fontsLoad16px[fam] = loaded.length;
      } catch (e) {
        out.fontsLoad16px[fam] = "EX:" + e.name;
      }
    }

    // Exit 4: new FontFace(f, 'local("f")').load()
    for (const fam of families) {
      try {
        const ff = new FontFace(fam, 'local("' + fam + '")');
        await ff.load();
        out.fontFaceLocalLoad[fam] = ff.status;
      } catch (e) {
        out.fontFaceLocalLoad[fam] = "REJ:" + e.name;
      }
    }

    // Exit 5: CSS route: inject <style>@font-face { font-family: p_<idx>; src: local("<family>"); }</style>
    let cssIdx = 0;
    for (const fam of families) {
      cssIdx++;
      const alias = "p_" + cssIdx;
      const style = document.createElement("style");
      style.textContent = '@font-face { font-family: "' + alias + '"; src: local("' + fam + '"); }';
      document.head.appendChild(style);
      let checkVal = "ERR";
      let loadLen = "ERR";
      try { checkVal = document.fonts.check('16px "' + alias + '"'); } catch (e) { checkVal = "EX:" + e.name; }
      try {
        const loaded = await document.fonts.load('16px "' + alias + '"');
        loadLen = loaded.length;
      } catch (e) { loadLen = "EX:" + e.name; }
      out.cssFontFace[fam] = { alias, check16px: checkVal, load16pxLen: loadLen };
    }

    // Exit 6: canvas measureText('72px "<family>", monospace') vs '72px monospace'
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = "72px monospace";
    const monoWidth = ctx.measureText(testText).width;
    for (const fam of families) {
      ctx.font = '72px "' + fam + '", monospace';
      const w = ctx.measureText(testText).width;
      out.canvasMeasure[fam] = {
        width: w,
        monoWidth: monoWidth,
        diff: w - monoWidth,
        detected: Math.abs(w - monoWidth) > 0.001,
      };
    }

    // Exit 7: DOM layout: <span style="font:72px '<family>'">mmmmmmmmmmlli</span> offsetWidth
    for (const fam of families) {
      const spanBare = document.createElement("span");
      spanBare.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;font:72px "' + fam + '";';
      spanBare.textContent = testText;
      document.body.appendChild(spanBare);
      const bareWidth = spanBare.offsetWidth;

      const spanFallback = document.createElement("span");
      spanFallback.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;white-space:nowrap;font:72px "' + fam + '", monospace;';
      spanFallback.textContent = testText;
      document.body.appendChild(spanFallback);
      const fallbackWidth = spanFallback.offsetWidth;

      out.domOffsetWidth[fam] = { bareWidth, fallbackWidth };
    }

    // Exit 8: new OffscreenCanvas(1,1).getContext('2d').measureText
    try {
      const off = new OffscreenCanvas(1, 1);
      const offCtx = off.getContext("2d");
      offCtx.font = "72px monospace";
      const offMono = offCtx.measureText(testText).width;
      for (const fam of families) {
        offCtx.font = '72px "' + fam + '", monospace';
        const w = offCtx.measureText(testText).width;
        out.offscreenCanvas[fam] = {
          width: w,
          monoWidth: offMono,
          diff: w - offMono,
          detected: Math.abs(w - offMono) > 0.001,
        };
      }
    } catch (e) {
      out.offscreenCanvas = { error: e.name + ": " + e.message };
    }

    // Exit 9: Web Worker scope
    try {
      const worker = new Worker("/worker.js");
      const workerRes = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: "timeout" }), 4000);
        worker.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
        worker.onerror = (e) => { clearTimeout(timer); resolve({ error: e.message || "worker error" }); };
        worker.postMessage({ families });
      });
      out.worker = workerRes;
      worker.terminate();
    } catch (e) {
      out.worker = { error: e.name + ": " + e.message };
    }

    // Exit 10: queryLocalFonts()
    try {
      if (typeof window.queryLocalFonts !== "function") {
        out.queryLocalFontsResult = "NOT_A_FUNCTION";
      } else {
        const fonts = await window.queryLocalFonts();
        out.queryLocalFontsResult = {
          count: fonts.length,
          familiesSample: fonts.slice(0, 10).map((f) => f.family),
          hasSegoe: fonts.some((f) => f.family === "Segoe UI"),
          hasHelvetica: fonts.some((f) => f.family === "Helvetica Neue"),
        };
      }
    } catch (e) {
      out.queryLocalFontsResult = "ERROR:" + e.name + ": " + e.message;
    }

    // Exit 11 (Extra A): SVG <text> getComputedTextLength()
    try {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.style.position = "absolute";
      svg.style.visibility = "hidden";
      document.body.appendChild(svg);
      const textMono = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textMono.setAttribute("font-family", "monospace");
      textMono.setAttribute("font-size", "72px");
      textMono.textContent = testText;
      svg.appendChild(textMono);
      const svgMonoLen = textMono.getComputedTextLength();

      for (const fam of families) {
        const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        textEl.setAttribute("font-family", '"' + fam + '", monospace');
        textEl.setAttribute("font-size", "72px");
        textEl.textContent = testText;
        svg.appendChild(textEl);
        const len = textEl.getComputedTextLength();
        out.svgComputedTextLength[fam] = {
          length: len,
          monoLength: svgMonoLen,
          diff: len - svgMonoLen,
          detected: Math.abs(len - svgMonoLen) > 0.001,
        };
      }
    } catch (e) {
      out.svgComputedTextLength = { error: e.name + ": " + e.message };
    }

    // Exit 12 (Extra B): Canvas 3-Way Fallback Differential (monospace, sans-serif, serif)
    try {
      const baseFallbacks = ["monospace", "sans-serif", "serif"];
      const baseWidths = {};
      for (const fb of baseFallbacks) {
        ctx.font = "72px " + fb;
        baseWidths[fb] = ctx.measureText(testText).width;
      }
      for (const fam of families) {
        const famWidths = {};
        let matchesCount = 0;
        for (const fb of baseFallbacks) {
          ctx.font = '72px "' + fam + '", ' + fb;
          const w = ctx.measureText(testText).width;
          famWidths[fb] = w;
          const diff = Math.abs(w - baseWidths[fb]);
          if (diff > 0.01) matchesCount++;
        }
        const allEqual = Math.abs(famWidths.monospace - famWidths["sans-serif"]) < 0.001 &&
                         Math.abs(famWidths["sans-serif"] - famWidths.serif) < 0.001;
        out.canvasThreeWayFallback[fam] = {
          widths: famWidths,
          baseWidths,
          allEqual,
          detected: allEqual || matchesCount >= 2,
        };
      }
    } catch (e) {
      out.canvasThreeWayFallback = { error: e.name + ": " + e.message };
    }

    // Exit 13 (Extra C): Canvas actualBoundingBox metrics
    try {
      for (const fam of families) {
        ctx.font = '72px "' + fam + '", monospace';
        const m = ctx.measureText("yMgQ|1");
        out.canvasBoundingBox[fam] = {
          ascent: m.actualBoundingBoxAscent,
          descent: m.actualBoundingBoxDescent,
          left: m.actualBoundingBoxLeft,
          right: m.actualBoundingBoxRight,
        };
      }
    } catch (e) {
      out.canvasBoundingBox = { error: e.name + ": " + e.message };
    }

    return JSON.stringify(out);
  })();
};

function buildProbeScript(families) {
  return '(' + PROBE_RUNNER.toString() + ')(' + JSON.stringify(families) + ')';
}

async function runSession(mode, serverPort) {
  const profile = {
    id: 'font-audit-' + mode,
    name: 'font-audit-' + mode,
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona' },
  };

  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-font-audit-' + mode + '-'));
  let child = null;

  try {
    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile,
      templatePath: path.join(kernelRoot, 'init_template.json'),
    });

    child = spawn(launcher, [dir, '--headless=new', '--enable-unsafe-swiftshader'], {
      cwd: kernelRoot,
      detached: true,
      stdio: 'ignore',
    });

    let port = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      try {
        const fileContent = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8');
        const value = parseInt(fileContent.trim().split('\n')[0], 10);
        if (value > 0) { port = value; break; }
      } catch (_) {}
    }
    if (!port) return { error: 'DevToolsActivePort not acquired' };

    const page = await waitForPage(port);
    if (!page?.webSocketDebuggerUrl) return { error: 'Page target not available' };

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);

    // Page.enable is strictly required before evaluation setup
    await cdp.call('Page.enable', {});

    if (mode === 'injected') {
      // Self-proving marker registration
      await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__marker = true;' });
      const injectionScript = buildInjectionScript(fp);
      await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: injectionScript });

      const workerFontSource = 'self.__workerMarker = true;\n' + buildWorkerFontPresenceSource(fp);
      cdp.ws.addEventListener('message', async (event) => {
        let msg = null;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (msg.method === 'Target.attachedToTarget' && msg.params?.targetInfo?.type === 'worker') {
          const sId = msg.params.sessionId;
          await cdp.send('Runtime.evaluate', { expression: workerFontSource }, sId);
          await cdp.send('Runtime.runIfWaitingForDebugger', {}, sId);
        }
      });
      await cdp.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    }

    await cdp.call('Page.navigate', { url: 'http://127.0.0.1:' + serverPort + '/' });
    await sleep(2000);

    const probeResult = await cdp.value(buildProbeScript(TEST_FAMILIES));
    try { ws.close(); } catch (_) {}
    return probeResult;
  } finally {
    if (child) await stopChild(child, dir);
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
    console.log('font-presence-exit-audit-selftest: OK ' + results.length + '/' + results.length);
    return;
  }

  const { server, port } = await startServer();
  let raw = null;
  let injected = null;

  try {
    console.log('Running raw audit session...');
    raw = await runSession('raw', port);
    if (raw?.error) throw new Error('Raw session failed: ' + raw.error);

    console.log('Running injected audit session...');
    injected = await runSession('injected', port);
    if (injected?.error) throw new Error('Injected session failed: ' + injected.error);
  } finally {
    server.close();
  }

  // 1. Self-evident injection marker
  check('injection marker window.__marker evaluates to true in injected mode', () => {
    assert.strictEqual(raw.marker, null, 'raw mode must not have __marker');
    assert.strictEqual(injected.marker, true, 'injected mode must have __marker === true');
  });

  // 2. document.fonts shielding (Exit 3)
  check('document.fonts is shielded on blank page (size === 0, spread === 0)', () => {
    assert.strictEqual(raw.fontsCollection.size, 0);
    assert.strictEqual(raw.fontsCollection.spreadLength, 0);
    assert.strictEqual(injected.fontsCollection.size, 0);
    assert.strictEqual(injected.fontsCollection.spreadLength, 0);
  });

  // 3. new FontFace local() control (Exit 4)
  check('new FontFace local().load() aligns with Windows persona in injected mode', () => {
    assert.strictEqual(injected.fontFaceLocalLoad['Segoe UI'], 'loaded');
    assert.strictEqual(injected.fontFaceLocalLoad['Cambria Math'], 'loaded');
    assert.strictEqual(injected.fontFaceLocalLoad['Helvetica Neue'], 'REJ:NetworkError');
    assert.strictEqual(injected.fontFaceLocalLoad['Luminari'], 'REJ:NetworkError');
    assert.strictEqual(injected.fontFaceLocalLoad['Galvji'], 'REJ:NetworkError');
  });

  check('new FontFace local().load() leaks host fonts in raw mode (sensitivity baseline)', () => {
    assert.strictEqual(raw.fontFaceLocalLoad['Helvetica Neue'], 'loaded');
    assert.strictEqual(raw.fontFaceLocalLoad['Luminari'], 'loaded');
    assert.strictEqual(raw.fontFaceLocalLoad['Galvji'], 'loaded');
    assert.strictEqual(raw.fontFaceLocalLoad['Segoe UI'], 'REJ:NetworkError');
    assert.strictEqual(raw.fontFaceLocalLoad['Cambria Math'], 'REJ:NetworkError');
  });

  // 4. Canvas measureText Segoe UI spoofing (Exit 6)
  check('canvas measureText spoofs Segoe UI away from fallback via injected font-subset', () => {
    assert.strictEqual(raw.canvasMeasure['Segoe UI'].detected, false, 'raw engine has no Segoe UI');
    assert.strictEqual(injected.canvasMeasure['Segoe UI'].detected, true, 'injected engine measures Segoe UI via font-subset');
    assert.notStrictEqual(injected.canvasMeasure['Segoe UI'].width, injected.canvasMeasure['Segoe UI'].monoWidth);
  });

  // 5. OffscreenCanvas Segoe UI spoofing (Exit 8)
  check('OffscreenCanvas spoofs Segoe UI away from fallback via injected font-subset', () => {
    assert.strictEqual(raw.offscreenCanvas['Segoe UI'].detected, false);
    assert.strictEqual(injected.offscreenCanvas['Segoe UI'].detected, true);
  });

  // 6. Exit 1: document.fonts.check(0px) - foreign families shielded to false
  check('document.fonts.check answers false for foreign families in injected mode', () => {
    assert.strictEqual(raw.fontsCheck0px['Helvetica Neue'], true, 'raw mode detects host Helvetica Neue');
    assert.strictEqual(injected.fontsCheck0px['Helvetica Neue'], false, 'injected mode must shield Helvetica Neue');
    assert.strictEqual(injected.fontsCheck0px['Luminari'], false, 'injected mode must shield Luminari');
    assert.strictEqual(injected.fontsCheck0px['Galvji'], false, 'injected mode must shield Galvji');
    assert.strictEqual(injected.fontsCheck0px['Segoe UI'], true, 'injected mode must report persona Segoe UI as available');
  });

  // 7. Exit 2: await document.fonts.load(16px) - returns 0 for system fonts on blank page
  check('await document.fonts.load(16px) returns 0 for system fonts on blank page', () => {
    assert.strictEqual(raw.fontsLoad16px['Segoe UI'], 0);
    assert.strictEqual(injected.fontsLoad16px['Segoe UI'], 0);
    assert.strictEqual(injected.fontsLoad16px['Helvetica Neue'], 0);
  });

  // 8. Exit 5: CSS @font-face local() src - blocks foreign host fonts with NetworkError, loads persona subsets
  check('CSS @font-face local() gate blocks foreign host fonts and loads persona subsets', () => {
    assert.strictEqual(raw.cssFontFace['Helvetica Neue'].load16pxLen, 1, 'raw mode leaks host Helvetica Neue');
    assert.strictEqual(injected.cssFontFace['Helvetica Neue'].load16pxLen, 'EX:NetworkError', 'injected mode must block Helvetica Neue');
    assert.strictEqual(injected.cssFontFace['Luminari'].load16pxLen, 'EX:NetworkError', 'injected mode must block Luminari');
    assert.strictEqual(injected.cssFontFace['Galvji'].load16pxLen, 'EX:NetworkError', 'injected mode must block Galvji');
    assert.strictEqual(injected.cssFontFace['Segoe UI'].load16pxLen, 1, 'injected mode must load Segoe UI subset');
  });

  // 9. Exit 6: Canvas measureText does not leak host-only fonts
  check('Canvas measureText does not leak host-only fonts (Helvetica Neue, Luminari, Galvji)', () => {
    assert.strictEqual(raw.canvasMeasure['Helvetica Neue'].detected, true, 'raw mode detects Helvetica Neue');
    assert.strictEqual(injected.canvasMeasure['Helvetica Neue'].detected, false, 'injected mode must shield Helvetica Neue');
    assert.strictEqual(injected.canvasMeasure['Luminari'].detected, false, 'injected mode must shield Luminari');
    assert.strictEqual(injected.canvasMeasure['Galvji'].detected, false, 'injected mode must shield Galvji');
  });

  // 10. Exit 7: DOM layout offsetWidth does not leak host-only fonts
  check('DOM offsetWidth layout shields host-only fonts from probe detection', () => {
    assert.notStrictEqual(injected.domOffsetWidth['Helvetica Neue'].fallbackWidth, raw.domOffsetWidth['Helvetica Neue'].fallbackWidth, 'injected mode must not render host Helvetica Neue');
    assert.notStrictEqual(injected.domOffsetWidth['Luminari'].fallbackWidth, raw.domOffsetWidth['Luminari'].fallbackWidth, 'injected mode must not render host Luminari');
    assert.notStrictEqual(injected.domOffsetWidth['Galvji'].fallbackWidth, raw.domOffsetWidth['Galvji'].fallbackWidth, 'injected mode must not render host Galvji');
  });

  // 11. Exit 8: OffscreenCanvas does not leak host-only fonts
  check('OffscreenCanvas does not leak host-only fonts', () => {
    assert.strictEqual(raw.offscreenCanvas['Helvetica Neue'].detected, true, 'raw mode detects Helvetica Neue');
    assert.strictEqual(injected.offscreenCanvas['Helvetica Neue'].detected, false, 'injected mode must shield Helvetica Neue');
    assert.strictEqual(injected.offscreenCanvas['Luminari'].detected, false, 'injected mode must shield Luminari');
    assert.strictEqual(injected.offscreenCanvas['Galvji'].detected, false, 'injected mode must shield Galvji');
  });

  // 12. Exit 9: Web Worker scope shields host fonts and resolves persona fonts
  check('Web Worker scope shields host fonts and resolves persona fonts via FontFace local()', () => {
    assert.strictEqual(raw.worker['Helvetica Neue'].fontFaceStatus, 'loaded', 'raw worker leaks host Helvetica Neue');
    assert.strictEqual(injected.worker['Helvetica Neue'].fontFaceStatus, 'REJ:NetworkError', 'injected worker must reject Helvetica Neue');
    assert.strictEqual(injected.worker['Luminari'].fontFaceStatus, 'REJ:NetworkError', 'injected worker must reject Luminari');
    assert.strictEqual(injected.worker['Galvji'].fontFaceStatus, 'REJ:NetworkError', 'injected worker must reject Galvji');
    assert.strictEqual(injected.worker['Segoe UI'].fontFaceStatus, 'loaded', 'injected worker must resolve Segoe UI');
    assert.strictEqual(injected.worker['Cambria Math'].fontFaceStatus, 'loaded', 'injected worker must resolve Cambria Math');
  });

  // 13. Exit 10: queryLocalFonts user activation requirement preserved
  check('queryLocalFonts requires user activation in both modes', () => {
    assert.strictEqual(raw.queryLocalFontsResult, 'ERROR:SecurityError: User activation is required.');
    assert.strictEqual(injected.queryLocalFontsResult, 'ERROR:SecurityError: User activation is required.');
  });

  // 14. Exit 11: SVG getComputedTextLength does not leak host-only fonts
  check('SVG getComputedTextLength does not leak host-only fonts', () => {
    assert.strictEqual(raw.svgComputedTextLength['Helvetica Neue'].detected, true, 'raw SVG detects Helvetica Neue');
    assert.strictEqual(injected.svgComputedTextLength['Helvetica Neue'].detected, false, 'injected SVG must shield Helvetica Neue');
    assert.strictEqual(injected.svgComputedTextLength['Luminari'].detected, false, 'injected SVG must shield Luminari');
    assert.strictEqual(injected.svgComputedTextLength['Galvji'].detected, false, 'injected SVG must shield Galvji');
  });

  // 15. Exit 12: Canvas 3-way fallback diff does not detect host-only fonts
  check('Canvas 3-way fallback diff does not detect host-only fonts in injected mode', () => {
    assert.strictEqual(raw.canvasThreeWayFallback['Helvetica Neue'].detected, true, 'raw canvas detects Helvetica Neue');
    assert.strictEqual(injected.canvasThreeWayFallback['Helvetica Neue'].detected, false, 'injected canvas must shield Helvetica Neue');
    assert.strictEqual(injected.canvasThreeWayFallback['Luminari'].detected, false, 'injected canvas must shield Luminari');
    assert.strictEqual(injected.canvasThreeWayFallback['Galvji'].detected, false, 'injected canvas must shield Galvji');
  });

  // 16. Exit 13: Canvas actualBoundingBox metrics do not match host metrics
  check('Canvas actualBoundingBox metrics do not expose raw host glyph shapes', () => {
    const rawAscent = raw.canvasBoundingBox['Helvetica Neue'].ascent;
    const injAscent = injected.canvasBoundingBox['Helvetica Neue'].ascent;
    assert.ok(Math.abs(rawAscent - injAscent) > 0.5, 'glyph ascent for Helvetica Neue must differ from host metrics');
  });

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log('font-presence-exit-audit-selftest: OK ' + results.length + '/' + results.length);
  } else {
    console.log('font-presence-exit-audit-selftest: FAILED ' + failed.length + '/' + results.length);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('font-presence-exit-audit-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
