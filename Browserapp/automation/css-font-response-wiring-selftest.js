#!/usr/bin/env node
'use strict';

/**
 * End-to-end verification for production engine CDP Fetch static CSS response rewrite wiring.
 *
 * Verifies:
 * 1. Production engine.js statically imports and instantiates createCssFontResponseRewriter.
 * 2. startWorkerFingerprintInjection wires fontResponseRewriter.handleEvent on incoming CDP events.
 * 3. fontResponseRewriter.enable is called on page/iframe sessions before resuming debugger.
 * 4. Browser connection enables Target.setAutoAttach with flatten: true and waitForDebuggerOnStart: true.
 * 5. Production BrowserEngine.startWorkerFingerprintInjection executes successfully on real browser kernel.
 * 6. Pre-existing initial target (about:blank) synchronization barrier ensures Fetch interception is active before first navigation.
 * 7. Static HTML parser <style> foreign local() font (e.g. Helvetica Neue on macOS host) is rewritten to blocked placeholder.
 * 8. Static external <link rel="stylesheet"> foreign local() font is rewritten to blocked placeholder.
 * 9. Whitelisted persona local fonts (e.g. Arial on Windows persona) remain functional and load successfully.
 * 10. Positive controls (web fonts via data: URI and mixed local+URL sources) load intact.
 * 11. Canvas text metrics confirm fallback to monospace width and hide native host font metrics.
 * 12. CSSOM parsed rules confirm Blink received rewritten local("__ob_font_blocked__") declarations.
 * 13. Compressed (GZIP) static HTML/CSS responses are transparently handled and sanitized via production wiring.
 * 14. CSP protected inline <style> elements have dynamic SHA-256 hash updates and pass Blink security policies.
 * 15. Fetch rewrite request events are logged and non-empty on the production engine connection.
 * 16. Concurrency & stability: zero in-flight request leaks, no Fetch paused deadlocks, worker injection intact.
 * 17. Mutation sensitivity (--mutate): disabling rewrite confirms host fonts leak through static paths.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execSync } = require('child_process');

const { BrowserEngine } = require('../engine');
const { buildFingerprint } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const cdp = require('../cdp');

const appRoot = path.join(__dirname, '..');
const enginePath = path.join(appRoot, 'engine.js');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const fontPath = path.join(appRoot, 'assets', 'font-subsets', 'windows', 'segoe-ui.woff2');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

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

const skip = (name, why) => {
  results.push({ name, ok: true });
  console.log(`  SKIP  ${name}${why ? ' - ' + why : ''}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractMethodSource(fullSource, methodName) {
  const methodRegex = new RegExp(`async\\s+${methodName}\\s*\\([^)]*\\)\\s*\\{`);
  const match = methodRegex.exec(fullSource);
  if (!match) return '';
  const startIndex = match.index;
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let inComment = false;
  let inBlockComment = false;

  for (let i = startIndex; i < fullSource.length; i++) {
    const char = fullSource[i];
    const next = fullSource[i + 1];

    if (inComment) {
      if (char === '\n') inComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (char === '\\') {
        i += 1;
      } else if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return fullSource.slice(startIndex, i + 1);
      }
    }
  }
  return '';
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync('pkill -f "user-data-dir=' + dir + '" 2>/dev/null || true'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function startTestServer(fontBuf) {
  const fontB64 = fontBuf.toString('base64');
  const cspInlineStyle = '@font-face { font-family: "foreign_csp"; src: local("Helvetica Neue"); }';
  const cspSha256 = crypto.createHash('sha256').update(cspInlineStyle).digest('base64');

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 1. Static font binary asset
    if (req.url === '/subset.woff2') {
      res.setHeader('Content-Type', 'font/woff2');
      res.end(fontBuf);
      return;
    }

    // 2. Web worker script for concurrent worker injection verification
    if (req.url === '/worker.js') {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.end(`
        self.onmessage = () => {
          self.postMessage({
            platform: navigator.platform,
            userAgent: navigator.userAgent,
            hasFontProbe: Boolean(self.__workerPersonaFontProbe),
          });
        };
      `);
      return;
    }

    // 3. Primary static test page (HTML parser style & external link)
    if (req.url === '/' || req.url === '/index.html') {
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Production CSS Font Response Rewrite Wiring Verification</title>
  <style>
    @font-face { font-family: "foreign_html"; src: local("Helvetica Neue"); }
    @font-face { font-family: "allowed_arial"; src: local("Arial"); }
    @font-face { font-family: "allowed_data"; src: url("data:font/woff2;base64,${fontB64}"); }
    @font-face { font-family: "allowed_mixed"; src: local("Helvetica Neue"), url("/subset.woff2"); }
  </style>
  <link rel="stylesheet" href="/foreign.css">
</head>
<body>
  <h1>Production Wiring Test</h1>
  <canvas id="c" width="400" height="80"></canvas>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(html));
      res.end(html);
      return;
    }

    // 4. External CSS stylesheet
    if (req.url === '/foreign.css') {
      const css = `@font-face { font-family: "foreign_ext"; src: local("Helvetica Neue"); }
@font-face { font-family: "allowed_ext_arial"; src: local("Arial"); }`;
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(css));
      res.end(css);
      return;
    }

    // 5. GZIP compressed test suite
    if (req.url === '/gzip.html') {
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>GZIP Compressed Response</title>
  <style>
    @font-face { font-family: "foreign_gzip_html"; src: local("Helvetica Neue"); }
    @font-face { font-family: "allowed_gzip_html"; src: local("Arial"); }
  </style>
  <link rel="stylesheet" href="/gzip.css">
</head>
<body><h1>GZIP Test</h1></body>
</html>`;
      const compressed = zlib.gzipSync(Buffer.from(html));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', compressed.length);
      res.end(compressed);
      return;
    }

    if (req.url === '/gzip.css') {
      const css = `@font-face { font-family: "foreign_gzip_css"; src: local("Helvetica Neue"); }
@font-face { font-family: "allowed_gzip_css"; src: local("Arial"); }`;
      const compressed = zlib.gzipSync(Buffer.from(css));
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', compressed.length);
      res.end(compressed);
      return;
    }

    // 6. CSP protected test page with style-src sha256
    if (req.url === '/csp.html') {
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>CSP Protected Response</title>
  <style>${cspInlineStyle}</style>
</head>
<body><h1>CSP Protected Page</h1></body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', `style-src 'sha256-${cspSha256}'`);
      res.setHeader('Content-Length', Buffer.byteLength(html));
      res.end(html);
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function buildMainProbeScript() {
  return `(async () => {
    const out = {
      fonts: {},
      canvas: {},
      cssom: {},
    };

    // 1. Font face loading probes
    const fontNames = [
      'foreign_html',
      'foreign_ext',
      'allowed_arial',
      'allowed_data',
      'allowed_mixed',
      'allowed_ext_arial'
    ];

    for (const name of fontNames) {
      try {
        out.fonts[name] = await document.fonts.load('16px "' + name + '"').then(
          (loaded) => loaded.length,
          (err) => 'ERR:' + err.name
        );
      } catch (e) {
        out.fonts[name] = 'EX:' + e.name;
      }
    }

    // 2. Canvas layout measurement
    const canvas = document.getElementById('c');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (ctx) {
      const testString = 'TheQuickBrownFoxJumpsOverTheLazyDog1234567890';
      ctx.font = '72px monospace';
      const monoWidth = ctx.measureText(testString).width;

      ctx.font = '72px "Helvetica Neue"';
      const nativeHelvWidth = ctx.measureText(testString).width;

      ctx.font = '72px "foreign_html", monospace';
      const probedHelvWidth = ctx.measureText(testString).width;

      out.canvas = {
        monoWidth,
        nativeHelvWidth,
        probedHelvWidth,
        usesMonospaceFallback: Math.abs(probedHelvWidth - monoWidth) < 0.001,
        usesHostFont: Math.abs(probedHelvWidth - nativeHelvWidth) < 0.001
      };
    }

    // 3. CSSOM rules inspection
    try {
      const rules = [];
      for (let i = 0; i < document.styleSheets.length; i++) {
        try {
          for (let j = 0; j < document.styleSheets[i].cssRules.length; j++) {
            rules.push(document.styleSheets[i].cssRules[j].cssText);
          }
        } catch (_) {}
      }
      out.cssom.rules = rules;
    } catch (e) {
      out.cssom.error = String(e);
    }

    return JSON.stringify(out);
  })()`;
}

function buildGzipProbeScript() {
  return `(async () => {
    const out = {};
    try {
      out.htmlHelv = await document.fonts.load('16px "foreign_gzip_html"').then((r) => r.length, (e) => 'ERR:' + e.name);
      out.htmlArial = await document.fonts.load('16px "allowed_gzip_html"').then((r) => r.length, (e) => 'ERR:' + e.name);
      out.cssHelv = await document.fonts.load('16px "foreign_gzip_css"').then((r) => r.length, (e) => 'ERR:' + e.name);
      out.cssArial = await document.fonts.load('16px "allowed_gzip_css"').then((r) => r.length, (e) => 'ERR:' + e.name);
    } catch (e) {
      out.error = String(e);
    }
    return JSON.stringify(out);
  })()`;
}

function buildCspProbeScript() {
  return `(async () => {
    const out = {};
    try {
      out.cspHelv = await document.fonts.load('16px "foreign_csp"').then((r) => r.length, (e) => 'ERR:' + e.name);
    } catch (e) {
      out.cspHelv = 'EX:' + e.name;
    }
    return JSON.stringify(out);
  })()`;
}

function buildWorkerProbeScript() {
  return `(async () => {
    try {
      const worker = new Worker('/worker.js');
      const payloadPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker response timeout')), 5000);
        worker.onmessage = (event) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        worker.onerror = (err) => {
          clearTimeout(timer);
          reject(err);
        };
      });
      worker.postMessage('ping');
      const data = await payloadPromise;
      return JSON.stringify(data);
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  })()`;
}

async function runLiveEngineIntegration(serverPort, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-wire-prod-' + (mutate ? 'mutate-' : 'normal-')));

  const profile = {
    id: mutate ? 'wire-win-mutate' : 'wire-win-normal',
    name: mutate ? 'wire-win-mutate' : 'wire-win-normal',
    language: 'en-US',
    userAgent: WINDOWS_UA,
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    exitIp: '203.0.113.19',
    privacy: { deviceProfile: 'persona' },
  };

  const fp = buildFingerprint(profile);
  let child = null;
  let defaultTabWs = null;
  let devToolsPort = null;

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
    child.unref();

    for (let i = 0; i < 80; i += 1) {
      await sleep(100);
      try {
        const rawPort = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8');
        const portVal = parseInt(rawPort.trim().split('\n')[0], 10);
        if (portVal > 0) {
          devToolsPort = portVal;
          break;
        }
      } catch (_) {}
    }

    if (!devToolsPort) {
      throw new Error('Failed to acquire DevToolsActivePort from browser user-data-dir');
    }

    const engine = new BrowserEngine({ getPath: () => dir });
    const item = { port: devToolsPort, profile, nativeKernelFingerprint: false };

    // Record production rewrite events and handle events
    const rewriteEvents = [];
    const handleEvents = [];

    // Execute production startWorkerFingerprintInjection
    const connection = await engine.startWorkerFingerprintInjection(item, fp);
    assert.ok(connection, 'startWorkerFingerprintInjection must resolve a persistent CDP connection');
    assert.ok(item.cssFontResponseRewriter, 'engine must attach cssFontResponseRewriter to item');

    const rewriter = item.cssFontResponseRewriter;
    const origLogger = rewriter.logger;
    rewriter.logger = (details) => {
      rewriteEvents.push(details);
      if (origLogger) origLogger(details);
    };

    const origHandleEvent = rewriter.handleEvent.bind(rewriter);
    rewriter.handleEvent = (event, conn) => {
      if (event?.method === 'Fetch.requestPaused') {
        handleEvents.push({
          url: event.params?.request?.url,
          resourceType: event.params?.resourceType,
          responseStatusCode: event.params?.responseStatusCode,
          sessionId: event.sessionId,
        });
      }
      return origHandleEvent(event, conn);
    };

    if (mutate) {
      // In mutated mode, disable rewrite handling to verify host font leakage
      rewriter.enabled = false;
    }

    // Synchronization barrier for pre-existing initial about:blank page attach:
    // Chromium attaches the existing about:blank target with waitingForDebugger=false,
    // so we ensure applyFingerprintToSession and fontResponseRewriter.enable have completed
    // on the target session before navigating, matching safe production sequencing.
    let attachReady = false;
    for (let i = 0; i < 50; i += 1) {
      if (item.fpAppliedTargets && item.fpAppliedTargets.size > 0) {
        attachReady = true;
        break;
      }
      await sleep(100);
    }
    if (!attachReady) {
      throw new Error('Timeout waiting for initial target session attach synchronization');
    }

    // Locate initial tab and execute navigation via Page.navigate
    const tabs = await cdp.tabs(devToolsPort);
    const defaultTab = tabs.find((t) => t.type === 'page') || tabs[0];
    if (!defaultTab?.webSocketDebuggerUrl) {
      throw new Error('Failed to locate default page tab for navigation');
    }
    defaultTabWs = defaultTab.webSocketDebuggerUrl;

    await cdp.call(defaultTabWs, 'Page.enable', {});

    // 1. Primary static test page navigation
    await cdp.call(defaultTabWs, 'Page.navigate', { url: `http://127.0.0.1:${serverPort}/index.html` });
    await sleep(1600);

    const mainEval = await cdp.call(defaultTabWs, 'Runtime.evaluate', {
      expression: buildMainProbeScript(),
      awaitPromise: true,
      returnByValue: true,
    });
    if (mainEval?.exceptionDetails) {
      throw new Error('Main probe failed: ' + (mainEval.exceptionDetails.text || JSON.stringify(mainEval.exceptionDetails)));
    }
    const mainResult = JSON.parse(mainEval?.result?.value || '{}');

    // 2. GZIP compressed response navigation
    await cdp.call(defaultTabWs, 'Page.navigate', { url: `http://127.0.0.1:${serverPort}/gzip.html` });
    await sleep(1200);

    const gzipEval = await cdp.call(defaultTabWs, 'Runtime.evaluate', {
      expression: buildGzipProbeScript(),
      awaitPromise: true,
      returnByValue: true,
    });
    const gzipResult = JSON.parse(gzipEval?.result?.value || '{}');

    // 3. CSP protected response navigation
    await cdp.call(defaultTabWs, 'Page.navigate', { url: `http://127.0.0.1:${serverPort}/csp.html` });
    await sleep(1200);

    const cspEval = await cdp.call(defaultTabWs, 'Runtime.evaluate', {
      expression: buildCspProbeScript(),
      awaitPromise: true,
      returnByValue: true,
    });
    const cspResult = JSON.parse(cspEval?.result?.value || '{}');

    // 4. Concurrent worker injection probe
    await cdp.call(defaultTabWs, 'Page.navigate', { url: `http://127.0.0.1:${serverPort}/index.html` });
    await sleep(800);

    const workerEval = await cdp.call(defaultTabWs, 'Runtime.evaluate', {
      expression: buildWorkerProbeScript(),
      awaitPromise: true,
      returnByValue: true,
    });
    const workerResult = JSON.parse(workerEval?.result?.value || '{}');

    return {
      attachReady,
      main: mainResult,
      gzip: gzipResult,
      csp: cspResult,
      worker: workerResult,
      rewriteEvents,
      handleEvents,
      inFlightCount: rewriter.inFlightRequests.size,
      workerFingerprintError: item.workerFingerprintError,
      cssFontResponseRewriteError: item.cssFontResponseRewriteError,
    };
  } finally {
    if (child) {
      await stopChild(child, dir);
    }
  }
}

(async () => {
  console.log(`Starting production CSS font response rewrite wiring selftest (mode: ${isMutateMode ? 'MUTATION' : 'NORMAL'})...\n`);

  const engineSource = fs.readFileSync(enginePath, 'utf8');
  const methodSource = extractMethodSource(engineSource, 'startWorkerFingerprintInjection');

  // Check 1: Engine imports createCssFontResponseRewriter from correct automation path
  check('engine.js statically imports createCssFontResponseRewriter from automation module', () => {
    const importRegex = /const\s*\{\s*createCssFontResponseRewriter\s*\}\s*=\s*require\(\s*['"]\.\/automation\/css-font-response-rewrite['"]\s*\)/;
    assert.ok(importRegex.test(engineSource), 'engine.js must import createCssFontResponseRewriter from ./automation/css-font-response-rewrite');
  });

  // Check 2: startWorkerFingerprintInjection instantiates rewriter with persona fonts and logger
  check('startWorkerFingerprintInjection instantiates rewriter with persona fonts and attaches to item', () => {
    assert.ok(methodSource.includes('createCssFontResponseRewriter'), 'startWorkerFingerprintInjection must call createCssFontResponseRewriter');
    assert.ok(methodSource.includes('personaFonts: fingerprint?.fonts?.list'), 'must pass fingerprint fonts list as personaFonts');
    assert.ok(methodSource.includes('item.cssFontResponseRewriter = fontResponseRewriter'), 'must assign instance to item.cssFontResponseRewriter');
  });

  // Check 3: onAttached dispatches handleEvent before Target.attachedToTarget branch
  check('onAttached dispatches fontResponseRewriter.handleEvent prior to Target.attachedToTarget check', () => {
    const handleIdx = methodSource.indexOf('fontResponseRewriter.handleEvent(event, connection)');
    const targetAttachedIdx = methodSource.indexOf("event.method !== 'Target.attachedToTarget'");
    assert.ok(handleIdx !== -1, 'fontResponseRewriter.handleEvent must be called in onAttached');
    assert.ok(targetAttachedIdx !== -1, 'Target.attachedToTarget check must exist');
    assert.ok(handleIdx < targetAttachedIdx, 'handleEvent must be called before Target.attachedToTarget early return to prevent Fetch deadlocks');
  });

  // Check 4: fontResponseRewriter.enable is awaited for page/iframe sessions before unpause
  check('fontResponseRewriter.enable is called on page and iframe sessions before runIfWaitingForDebugger', () => {
    assert.ok(methodSource.includes("fontResponseRewriter.enable(connection, { sessionId"), 'enable must be called with sessionId');
    const enableIdx = methodSource.indexOf('fontResponseRewriter.enable');
    const runIdx = methodSource.indexOf('Runtime.runIfWaitingForDebugger');
    assert.ok(enableIdx !== -1, 'fontResponseRewriter.enable must be present');
    assert.ok(runIdx !== -1, 'Runtime.runIfWaitingForDebugger must be present');
    assert.ok(enableIdx < runIdx, 'fontResponseRewriter.enable must precede Runtime.runIfWaitingForDebugger');
  });

  // Check 5: Browser connection configures Target.setAutoAttach with flatten: true
  check('browser connection configures Target.setAutoAttach with flatten: true and waitForDebuggerOnStart: true', () => {
    assert.ok(methodSource.includes('Target.setAutoAttach'), 'must invoke Target.setAutoAttach');
    assert.ok(methodSource.includes('flatten: true'), 'must specify flatten: true for session routing');
    assert.ok(methodSource.includes('waitForDebuggerOnStart: true'), 'must specify waitForDebuggerOnStart: true for clean pre-parser attach');
  });

  // Check 6: Live browser kernel availability probe
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available', 'platform or launcher missing');
    console.log(`\ncss-font-response-wiring-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const fontBuf = fs.readFileSync(fontPath);
  const { server, port: serverPort } = await startTestServer(fontBuf);

  let liveResult = null;
  try {
    liveResult = await runLiveEngineIntegration(serverPort, isMutateMode);
  } finally {
    server.close();
  }

  assert.ok(liveResult, 'liveResult must be acquired from browser execution');
  const { attachReady, main, gzip, csp, worker, rewriteEvents, handleEvents, inFlightCount, workerFingerprintError, cssFontResponseRewriteError } = liveResult;

  if (isMutateMode) {
    // Mutation sensitivity assertions: verify that disabling rewrite causes host fonts to leak
    check('MUTATION CHECK: Static HTML parser <style> leaks host font when rewrite is omitted', () => {
      assert.strictEqual(main.fonts.foreign_html, 1, 'Static <style> must leak host font in mutate mode');
    });

    check('MUTATION CHECK: Static external <link> leaks host font when rewrite is omitted', () => {
      assert.strictEqual(main.fonts.foreign_ext, 1, 'Static <link> must leak host font in mutate mode');
    });

    check('MUTATION CHECK: Canvas layout metric matches native host font width when rewrite is omitted', () => {
      assert.strictEqual(main.canvas.usesHostFont, true, 'Canvas must match native host font width in mutate mode');
      assert.strictEqual(main.canvas.usesMonospaceFallback, false, 'Canvas must not fallback in mutate mode');
    });

    check('MUTATION CHECK: CSSOM preserves unmitigated Helvetica Neue local declaration when rewrite is omitted', () => {
      const rules = main.cssom.rules || [];
      const helvRule = rules.find((r) => r.includes('foreign_html'));
      assert.ok(helvRule, 'foreign_html rule must exist');
      assert.ok(helvRule.includes('Helvetica Neue'), 'Rule must retain Helvetica Neue when rewrite is omitted');
    });
  } else {
    // Production normal mode assertions

    // Check 6: Pre-existing initial page target session attached and Fetch enabled
    check('Production wiring: Pre-existing initial page target session attached and Fetch enabled prior to navigation', () => {
      assert.strictEqual(attachReady, true, 'Target attach barrier must confirm session initialization');
    });

    // Check 7: Static HTML <style> foreign font blocked
    check('Production wiring: Static HTML parser <style> foreign local Helvetica Neue blocked with NetworkError', () => {
      assert.strictEqual(main.fonts.foreign_html, 'ERR:NetworkError', 'Foreign font in static <style> must reject with NetworkError');
    });

    // Check 8: Static external <link> foreign font blocked
    check('Production wiring: Static external <link> foreign local Helvetica Neue blocked with NetworkError', () => {
      assert.strictEqual(main.fonts.foreign_ext, 'ERR:NetworkError', 'Foreign font in external <link> must reject with NetworkError');
    });

    // Check 9: Allowed persona local font Arial loads successfully in static style & link
    check('Production wiring: Allowed persona font Arial loads successfully in static style and external link', () => {
      assert.strictEqual(main.fonts.allowed_arial, 1, 'Allowed local font in static <style> must load');
      assert.strictEqual(main.fonts.allowed_ext_arial, 1, 'Allowed local font in external <link> must load');
    });

    // Check 10: Positive controls: data: URI and mixed font sources load successfully
    check('Production wiring: Positive controls (web font via data: URI and mixed fallback) load successfully', () => {
      assert.strictEqual(main.fonts.allowed_data, 1, 'data: URI web font must load');
      assert.strictEqual(main.fonts.allowed_mixed, 1, 'Mixed font must fallback to web font and load');
    });

    // Check 11: Canvas layout measurement falls back to monospace
    check('Production wiring: Canvas text metrics fall back to monospace and hide native host font metrics', () => {
      assert.strictEqual(main.canvas.usesMonospaceFallback, true, 'Canvas must match monospace fallback width');
      assert.strictEqual(main.canvas.usesHostFont, false, 'Canvas must not match native host font width');
    });

    // Check 12: CSSOM rules contain placeholder font
    check('Production wiring: CSSOM rules verified sanitized to local("__ob_font_blocked__") without host font', () => {
      const rules = main.cssom.rules || [];
      const htmlHelv = rules.find((r) => r.includes('foreign_html'));
      const extHelv = rules.find((r) => r.includes('foreign_ext'));
      assert.ok(htmlHelv, 'foreign_html rule must exist in CSSOM');
      assert.ok(htmlHelv.includes('__ob_font_blocked__'), 'foreign_html must be rewritten to blocked placeholder');
      assert.ok(!htmlHelv.includes('Helvetica Neue'), 'foreign_html must not contain Helvetica Neue');
      assert.ok(extHelv, 'foreign_ext rule must exist in CSSOM');
      assert.ok(extHelv.includes('__ob_font_blocked__'), 'foreign_ext must be rewritten to blocked placeholder');
      assert.ok(!extHelv.includes('Helvetica Neue'), 'foreign_ext must not contain Helvetica Neue');
    });

    // Check 13: GZIP compressed response handling
    check('Production wiring: GZIP compressed static response decompressed and sanitized without errors', () => {
      assert.strictEqual(gzip.htmlHelv, 'ERR:NetworkError', 'GZIP static <style> foreign font must be blocked');
      assert.strictEqual(gzip.cssHelv, 'ERR:NetworkError', 'GZIP external <link> foreign font must be blocked');
      assert.strictEqual(gzip.htmlArial, 1, 'GZIP static <style> allowed font must load');
      assert.strictEqual(gzip.cssArial, 1, 'GZIP external <link> allowed font must load');
    });

    // Check 14: CSP dynamic hash update handling
    check('Production wiring: CSP protected static <style> passes Blink policy with dynamic SHA-256 update', () => {
      assert.strictEqual(csp.cspHelv, 'ERR:NetworkError', 'CSP style rule must be accepted by Blink and reject foreign font');
    });

    // Check 15: Fetch rewrite events captured and non-empty
    check('Production wiring: Fetch rewrite events recorded on production engine connection are non-empty', () => {
      assert.ok(rewriteEvents.length > 0, 'Must record at least one rewritten event via logger');
      assert.ok(handleEvents.length > 0, 'Must handle at least one Fetch.requestPaused event');
      const docRewrite = rewriteEvents.find((e) => e.resourceType === 'Document');
      const cssRewrite = rewriteEvents.find((e) => e.resourceType === 'Stylesheet');
      assert.ok(docRewrite, 'Must record Document rewrite event');
      assert.ok(cssRewrite, 'Must record Stylesheet rewrite event');
    });

    // Check 16: Concurrency and stability (deadlocks & worker injection)
    check('Production wiring: No Fetch paused deadlocks (zero in-flight requests) and worker injection intact', () => {
      assert.strictEqual(inFlightCount, 0, 'In-flight requests must be 0 after all responses settle');
      assert.strictEqual(cssFontResponseRewriteError, undefined, 'cssFontResponseRewriteError must be undefined');
      assert.strictEqual(workerFingerprintError, undefined, 'workerFingerprintError must be undefined');
      assert.ok(worker, 'Worker probe must return data');
      assert.strictEqual(worker.platform, 'Win32', 'Worker navigator.platform must match Windows persona');
      assert.strictEqual(worker.userAgent, WINDOWS_UA, 'Worker navigator.userAgent must match persona');
      assert.strictEqual(worker.hasFontProbe, true, 'Worker font presence probe marker must be active');
    });
  }

  const failed = results.filter((item) => !item.ok);
  console.log('');
  if (!failed.length) {
    console.log(`css-font-response-wiring-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`css-font-response-wiring-selftest: FAILED (${failed.length}/${results.length})`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('css-font-response-wiring-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
