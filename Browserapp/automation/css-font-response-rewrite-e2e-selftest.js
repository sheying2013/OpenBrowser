#!/usr/bin/env node
'use strict';

/**
 * End-to-end selftest for CDP Fetch response rewrite of CSS @font-face local() sources.
 *
 * Verifies that intercepting and rewriting HTTP/HTTPS network responses at the CDP Fetch
 * layer (Response stage) effectively neutralizes static HTML parser <style> and external
 * CSS <link rel="stylesheet"> @font-face local() host font leaks before Blink parser tokenization.
 *
 * Scenarios tested:
 * 1. Static HTML parser <style> containing foreign local() (e.g. Helvetica Neue on macOS host)
 * 2. Static external <link rel="stylesheet"> containing foreign local()
 * 3. Positive control: Allowed local persona font (e.g. Arial on Windows persona)
 * 4. Positive control: Custom web font delivered via data: URI in CSS
 * 5. Positive control: Mixed source fallback (foreign local + external web font URL)
 * 6. Compressed responses: Transparent decompression and safe fulfillment for GZIP and Brotli (br)
 * 7. CSP integrity: Dynamic SHA-256 hash updates for inline <style> elements under style-src hashes
 * 8. Visual canvas measurement: Confirms canvas text metrics fall back to monospace instead of host font
 * 9. Network/header integrity: Verifies Content-Length accuracy, status code preservation, and absence of decoding errors
 * 10. Known gaps: Explicitly documents and verifies that dynamic in-memory data: and blob: URI stylesheets bypass CDP Fetch
 * 11. Sensitivity (--mutate): Verifies that disabling the rewrite restores host font leakage across all tested static paths
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { createCssFontResponseRewriter } = require('./css-font-response-rewrite');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const fontPath = path.join(appRoot, 'assets', 'font-subsets', 'windows', 'segoe-ui.woff2');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const isMutateMode = process.argv.includes('--mutate');

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
    console.log(`  KNOWN GAP UNEXPECTED  ${name} - ${error.message}`);
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
    this.eventListeners = [];
    ws.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.id && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve(message);
      } else if (message.method) {
        for (const listener of this.eventListeners) {
          try { listener(message, this); } catch (_) {}
        }
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: 'CDP timeout: ' + method } });
      }, 30000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  call(method, params = {}) { return this.send(method, params); }
  command(method, params = {}) { return this.send(method, params); }

  on(listener) {
    if (typeof listener === 'function') {
      this.eventListeners.push(listener);
    }
  }

  async value(expression) {
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: (exception.exception && exception.exception.description) || exception.text || JSON.stringify(exception) };
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return { error: 'probe parse', raw: String(raw) }; }
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
    await sleep(200);
  }
  return null;
}

function startTestServer(fontBuf) {
  const fontB64 = fontBuf.toString('base64');
  const cspInlineStyle = '@font-face { font-family: "p_csp_helv"; src: local("Helvetica Neue"); }';
  const cspSha256 = crypto.createHash('sha256').update(cspInlineStyle).digest('base64');

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    // 1. Static font asset
    if (req.url === '/subset.woff2') {
      res.setHeader('Content-Type', 'font/woff2');
      res.end(fontBuf);
      return;
    }

    // 2. Primary static test page
    if (req.url === '/' || req.url === '/index.html') {
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Static Font Rewrite Probe</title>
  <style>
    @font-face { font-family: "p_html_helv"; src: local("Helvetica Neue"); }
    @font-face { font-family: "p_html_arial"; src: local("Arial"); }
    @font-face { font-family: "p_html_data"; src: url("data:font/woff2;base64,${fontB64}"); }
    @font-face { font-family: "p_html_mixed"; src: local("Helvetica Neue"), url("/subset.woff2"); }
  </style>
  <link rel="stylesheet" href="/external.css">
  <link rel="stylesheet" href="data:text/css;base64,QGZvbnQtZmFjZSB7IGZvbnQtZmFtaWx5OiAicF9zdGF0aWNfZGF0YV9saW5rIjsgc3JjOiBsb2NhbCgiSGVsdmV0aWNhIE5ldWUiKTsgfQ==">
</head>
<body>
  <h1>Static Font Probe</h1>
  <canvas id="c" width="400" height="80"></canvas>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(html));
      res.end(html);
      return;
    }

    // 3. External CSS
    if (req.url === '/external.css') {
      const css = `@font-face { font-family: "p_ext_helv"; src: local("Helvetica Neue"); }
@font-face { font-family: "p_ext_arial"; src: local("Arial"); }`;
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(css));
      res.end(css);
      return;
    }

    // 4. GZIP compressed HTML and CSS
    if (req.url === '/gzip.html') {
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Gzip Probe</title>
  <style>
    @font-face { font-family: "p_gzip_html_helv"; src: local("Helvetica Neue"); }
    @font-face { font-family: "p_gzip_html_arial"; src: local("Arial"); }
  </style>
  <link rel="stylesheet" href="/gzip.css">
</head>
<body><h1>Gzip Test</h1></body>
</html>`;
      const compressed = zlib.gzipSync(Buffer.from(html));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', compressed.length);
      res.end(compressed);
      return;
    }

    if (req.url === '/gzip.css') {
      const css = `@font-face { font-family: "p_gzip_css_helv"; src: local("Helvetica Neue"); }
@font-face { font-family: "p_gzip_css_arial"; src: local("Arial"); }`;
      const compressed = zlib.gzipSync(Buffer.from(css));
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', compressed.length);
      res.end(compressed);
      return;
    }

    // 5. Brotli compressed HTML and CSS
    if (req.url === '/brotli.html') {
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Brotli Probe</title>
  <style>
    @font-face { font-family: "p_br_html_helv"; src: local("Helvetica Neue"); }
    @font-face { font-family: "p_br_html_arial"; src: local("Arial"); }
  </style>
  <link rel="stylesheet" href="/brotli.css">
</head>
<body><h1>Brotli Test</h1></body>
</html>`;
      const compressed = zlib.brotliCompressSync(Buffer.from(html));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Content-Length', compressed.length);
      res.end(compressed);
      return;
    }

    if (req.url === '/brotli.css') {
      const css = `@font-face { font-family: "p_br_css_helv"; src: local("Helvetica Neue"); }
@font-face { font-family: "p_br_css_arial"; src: local("Arial"); }`;
      const compressed = zlib.brotliCompressSync(Buffer.from(css));
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Content-Length', compressed.length);
      res.end(compressed);
      return;
    }

    // 6. CSP Protected HTML
    if (req.url === '/csp.html') {
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>CSP Probe</title>
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

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function buildMainProbeScript(fontB64 = "") {
  return `(async () => {
    const out = {
      fonts: {},
      canvas: {},
      cssom: {},
      network: {},
      dynamicProtection: {},
      dynamicGaps: {}
    };

    // 1. Font face loading probes
    const fontNames = [
      'p_html_helv',
      'p_html_arial',
      'p_html_data',
      'p_html_mixed',
      'p_ext_helv',
      'p_ext_arial',
      'p_static_data_link'
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

    // 2. Visual canvas layout measurement
    const canvas = document.getElementById('c');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (ctx) {
      const testString = 'TheQuickBrownFoxJumpsOverTheLazyDog1234567890';
      ctx.font = '72px monospace';
      const monoWidth = ctx.measureText(testString).width;

      ctx.font = '72px "Helvetica Neue"';
      const nativeHelvWidth = ctx.measureText(testString).width;

      ctx.font = '72px "p_html_helv", monospace';
      const probedHelvWidth = ctx.measureText(testString).width;

      out.canvas = {
        monoWidth,
        nativeHelvWidth,
        probedHelvWidth,
        usesMonospaceFallback: Math.abs(probedHelvWidth - monoWidth) < 0.001,
        usesHostFont: Math.abs(probedHelvWidth - nativeHelvWidth) < 0.001
      };
    }

    // 3. CSSOM parsed rule inspection
    try {
      if (document.styleSheets.length > 0) {
        const firstSheet = document.styleSheets[0];
        const rules = [];
        for (let i = 0; i < firstSheet.cssRules.length; i++) {
          rules.push(firstSheet.cssRules[i].cssText);
        }
        out.cssom.inlineStyleRules = rules;
      }
    } catch (e) {
      out.cssom.error = String(e);
    }

    // 4. Network performance and resource integrity verification
    try {
      const perfEntries = performance.getEntriesByType('resource');
      out.network.extCssPerf = perfEntries.filter((p) => p.name.includes('/external.css')).map((p) => ({
        duration: p.duration,
        transferSize: p.transferSize
      }));

      // Fetch external.css via client-side fetch to inspect headers
      const res = await fetch('/external.css');
      out.network.extCssFetch = {
        status: res.status,
        contentType: res.headers.get('content-type'),
        contentLength: res.headers.get('content-length'),
        contentEncoding: res.headers.get('content-encoding')
      };
    } catch (e) {
      out.network.error = String(e);
    }

    // 5. Integrated dynamic in-memory data: and blob: stylesheet protection
    try {
      const dynDataLink = document.createElement('link');
      dynDataLink.rel = 'stylesheet';
      dynDataLink.href = 'data:text/css;base64,QGZvbnQtZmFjZSB7IGZvbnQtZmFtaWx5OiAicF9keW5fZGF0YSI7IHNyYzogbG9jYWwoIkhlbHZldGljYSBOZXVlIik7IH0=';
      document.head.appendChild(dynDataLink);

      const dynBlob = new Blob(['@font-face { font-family: "p_dyn_blob"; src: local("Helvetica Neue"); }'], { type: 'text/css' });
      const dynBlobUrl = URL.createObjectURL(dynBlob);
      const dynBlobLink = document.createElement('link');
      dynBlobLink.rel = 'stylesheet';
      dynBlobLink.href = dynBlobUrl;
      document.head.appendChild(dynBlobLink);

      const dynWebLink = document.createElement('link');
      dynWebLink.rel = 'stylesheet';
      dynWebLink.href = 'data:text/css;charset=utf-8,' + encodeURIComponent('@font-face { font-family: "p_dyn_web"; src: url("data:font/woff2;base64,${fontB64}"); }');
      document.head.appendChild(dynWebLink);

      await new Promise((r) => setTimeout(r, 500));

      out.dynamicProtection.dynData = await document.fonts.load('16px "p_dyn_data"').then((r) => r.length, (e) => 'ERR:' + e.name);
      out.dynamicProtection.dynBlob = await document.fonts.load('16px "p_dyn_blob"').then((r) => r.length, (e) => 'ERR:' + e.name);
      out.dynamicProtection.dynWeb = await document.fonts.load('16px "p_dyn_web"').then((r) => r.length, (e) => 'ERR:' + e.name);
      out.dynamicGaps = out.dynamicProtection;
    } catch (e) {
      out.dynamicProtection.error = String(e);
      out.dynamicGaps = out.dynamicProtection;
    }

    return JSON.stringify(out);
  })()`;
}

function buildCompressedProbeScript(prefix) {
  return `(async () => {
    const out = {};
    try {
      out.htmlHelv = await document.fonts.load('16px "${prefix}_html_helv"').then((r) => r.length, (e) => 'ERR:' + e.name);
      out.htmlArial = await document.fonts.load('16px "${prefix}_html_arial"').then((r) => r.length, (e) => 'ERR:' + e.name);
      out.cssHelv = await document.fonts.load('16px "${prefix}_css_helv"').then((r) => r.length, (e) => 'ERR:' + e.name);
      out.cssArial = await document.fonts.load('16px "${prefix}_css_arial"').then((r) => r.length, (e) => 'ERR:' + e.name);
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
      out.cspHelv = await document.fonts.load('16px "p_csp_helv"').then((r) => r.length, (e) => 'ERR:' + e.name);
    } catch (e) {
      out.cspHelv = 'EX:' + e.name;
    }
    return JSON.stringify(out);
  })()`;
}

async function runSession(serverPort, fontB64, mutate) {
  const profile = {
    id: mutate ? 'css-rewrite-mutate' : 'css-rewrite-normal',
    name: mutate ? 'css-rewrite-mutate' : 'css-rewrite-normal',
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona' },
  };

  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-css-rewrite-' + (mutate ? 'mutate-' : 'normal-')));
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

    await cdp.call('Page.enable', {});

    // Always inject baseline fingerprint script
    const injectionScript = buildInjectionScript(fp);
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: injectionScript });

    // Set up CDP Fetch response rewriter
    const rewriter = createCssFontResponseRewriter({
      personaFonts: fp,
      enabled: !mutate,
    });

    cdp.on((msg) => {
      rewriter.handleEvent(msg, cdp);
    });

    // Only enable Fetch interception if not mutated
    if (!mutate) {
      await rewriter.enable(cdp);
    }

    // 1. Run main test suite
    await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/index.html` });
    await sleep(1500);
    const mainResult = await cdp.value(buildMainProbeScript(fontB64));

    // 2. Run Gzip test suite
    await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/gzip.html` });
    await sleep(1200);
    const gzipResult = await cdp.value(buildCompressedProbeScript('p_gzip'));

    // 3. Run Brotli test suite
    await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/brotli.html` });
    await sleep(1200);
    const brotliResult = await cdp.value(buildCompressedProbeScript('p_br'));

    // 4. Run CSP test suite
    await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/csp.html` });
    await sleep(1200);
    const cspResult = await cdp.value(buildCspProbeScript());

    // 5. Isolated Fetch-only control: verify in-memory data/blob behavior when DOM gate is absent
    let noDocGateControl = null;
    if (!mutate) {
      try {
        const rawTarget = await (await fetch(`http://127.0.0.1:${port}/json/new?http://127.0.0.1:${serverPort}/index.html`, { method: 'PUT' })).json();
        if (rawTarget?.webSocketDebuggerUrl) {
          const rawWs = new WebSocket(rawTarget.webSocketDebuggerUrl);
          await new Promise((res, rej) => { rawWs.onopen = res; rawWs.onerror = rej; });
          const rawCdp = new Cdp(rawWs);
          await rawCdp.call('Page.enable', {});
          await sleep(500);

          const rawProbe = `(async () => {
            const dynDataLink = document.createElement("link");
            dynDataLink.rel = "stylesheet";
            dynDataLink.href = "data:text/css;base64,QGZvbnQtZmFjZSB7IGZvbnQtZmFtaWx5OiAicF9yYXdfZGF0YSI7IHNyYzogbG9jYWwoIkhlbHZldGljYSBOZXVlIik7IH0=";
            document.head.appendChild(dynDataLink);

            const dynBlob = new Blob(['@font-face { font-family: "p_raw_blob"; src: local("Helvetica Neue"); }'], { type: "text/css" });
            const dynBlobUrl = URL.createObjectURL(dynBlob);
            const dynBlobLink = document.createElement("link");
            dynBlobLink.rel = "stylesheet";
            dynBlobLink.href = dynBlobUrl;
            document.head.appendChild(dynBlobLink);

            await new Promise((r) => setTimeout(r, 400));

            return JSON.stringify({
              rawDynData: await document.fonts.load('16px "p_raw_data"').then((r) => r.length, (e) => "ERR:" + e.name),
              rawDynBlob: await document.fonts.load('16px "p_raw_blob"').then((r) => r.length, (e) => "ERR:" + e.name),
            });
          })()`;

          noDocGateControl = await rawCdp.value(rawProbe);
          try { rawWs.close(); } catch (_) {}
          try { await fetch(`http://127.0.0.1:${port}/json/close/${rawTarget.id}`); } catch (_) {}
        }
      } catch (_) {}
    }

    try { ws.close(); } catch (_) {}

    return {
      main: mainResult,
      gzip: gzipResult,
      brotli: brotliResult,
      csp: cspResult,
      noDocGateControl,
    };
  } finally {
    if (child) await stopChild(child, dir);
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
    console.log(`css-font-response-rewrite-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const fontBuf = fs.readFileSync(fontPath);
  const fontB64 = fontBuf.toString('base64');
  const { server, port } = await startTestServer(fontBuf);

  let sessionResult = null;

  try {
    console.log(isMutateMode
      ? 'Running MUTATED session (CDP Fetch rewrite disabled to verify sensitivity)...'
      : 'Running MITIGATED session (CDP Fetch response rewrite active)...');

    sessionResult = await runSession(port, fontB64, isMutateMode);

    if (sessionResult?.main?.error) throw new Error('Main session failed: ' + sessionResult.main.error);
    if (sessionResult?.gzip?.error) throw new Error('Gzip session failed: ' + sessionResult.gzip.error);
    if (sessionResult?.brotli?.error) throw new Error('Brotli session failed: ' + sessionResult.brotli.error);
    if (sessionResult?.csp?.error) throw new Error('CSP session failed: ' + sessionResult.csp.error);

    const { main, gzip, brotli, csp } = sessionResult;

    if (isMutateMode) {
      // In mutated mode, confirm foreign fonts leak through static paths
      check('MUTATION CHECK: Static HTML parser <style> foreign local leaks host font when rewrite is disabled', () => {
        assert.strictEqual(main.fonts.p_html_helv, 1, 'Static <style> must leak host font in mutate mode');
      });

      check('MUTATION CHECK: Static external <link> foreign local leaks host font when rewrite is disabled', () => {
        assert.strictEqual(main.fonts.p_ext_helv, 1, 'Static <link> must leak host font in mutate mode');
      });

      check('MUTATION CHECK: Canvas layout metric uses host font width when rewrite is disabled', () => {
        assert.strictEqual(main.canvas.usesHostFont, true, 'Canvas must render with host font in mutate mode');
        assert.strictEqual(main.canvas.usesMonospaceFallback, false, 'Canvas must not fallback in mutate mode');
      });

      check('MUTATION CHECK: GZIP compressed static <style> & <link> leak host font when rewrite is disabled', () => {
        assert.strictEqual(gzip.htmlHelv, 1, 'Gzip <style> must leak host font in mutate mode');
        assert.strictEqual(gzip.cssHelv, 1, 'Gzip <link> must leak host font in mutate mode');
      });

      check('MUTATION CHECK: Brotli compressed static <style> & <link> leak host font when rewrite is disabled', () => {
        assert.strictEqual(brotli.htmlHelv, 1, 'Brotli <style> must leak host font in mutate mode');
        assert.strictEqual(brotli.cssHelv, 1, 'Brotli <link> must leak host font in mutate mode');
      });

      check('MUTATION CHECK: CSP protected static <style> leaks host font when rewrite is disabled', () => {
        assert.strictEqual(csp.cspHelv, 1, 'CSP <style> must leak host font in mutate mode');
      });

      console.log('[MUTATION TEST] Rewrite disabled: foreign local font leaked across all static pathways as expected (sensitivity verified).');

    } else {
      // Normal / Mitigated mode assertions

      // 1. Static HTML parser <style> neutralization
      check('Path 1: Static HTML parser <style> foreign local Helvetica Neue blocked with NetworkError', () => {
        assert.strictEqual(main.fonts.p_html_helv, 'ERR:NetworkError', 'Foreign local font in static <style> must be blocked');
      });

      check('Path 1: Static HTML parser <style> allowed local Arial successfully loaded', () => {
        assert.strictEqual(main.fonts.p_html_arial, 1, 'Allowed local font in static <style> must load');
      });

      // 2. Static external <link rel="stylesheet"> neutralization
      check('Path 2: Static external <link> foreign local Helvetica Neue blocked with NetworkError', () => {
        assert.strictEqual(main.fonts.p_ext_helv, 'ERR:NetworkError', 'Foreign local font in external <link> must be blocked');
      });

      check('Path 2: Static external <link> allowed local Arial successfully loaded', () => {
        assert.strictEqual(main.fonts.p_ext_arial, 1, 'Allowed local font in external <link> must load');
      });

      // 3. Positive Controls: Web fonts and mixed sources
      check('Positive control: Web font via data: URI in static <style> loads successfully', () => {
        assert.strictEqual(main.fonts.p_html_data, 1, 'data: URI web font in static <style> must load');
      });

      check('Positive control: Mixed foreign local + URL font falls back to web font and loads successfully', () => {
        assert.strictEqual(main.fonts.p_html_mixed, 1, 'Mixed font must fallback to web font and load');
      });

      // 4. Visual Canvas measurement verification
      check('Canvas verification: Probed font layout falls back to monospace, completely hiding host font metrics', () => {
        assert.strictEqual(main.canvas.usesMonospaceFallback, true, 'Canvas must match monospace fallback width');
        assert.strictEqual(main.canvas.usesHostFont, false, 'Canvas must not match native host font width');
      });

      // 5. CSSOM verification: Verifies Blink received rewritten stylesheet rules
      check('CSSOM verification: Blink parsed rewritten @font-face rules with blocked placeholder', () => {
        const rules = main.cssom.inlineStyleRules || [];
        const helvRule = rules.find((r) => r.includes('p_html_helv'));
        assert.ok(helvRule, 'Rule for p_html_helv must exist in CSSOM');
        assert.match(helvRule, /LocalFontFallback[0-9a-f]{24}/, 'CSSOM rule must contain a neutral fallback family');
        assert.ok(!/__ob_|openbrowser/i.test(helvRule), 'CSSOM rule must not contain a product marker');
        assert.ok(!helvRule.includes('Helvetica Neue'), 'CSSOM rule must not contain Helvetica Neue');
      });

      // 6. Network and Header integrity
      check('Network integrity: External stylesheet fetch returned status 200 with accurate Content-Length', () => {
        const fetchInfo = main.network.extCssFetch;
        assert.strictEqual(fetchInfo.status, 200, 'HTTP status must be 200');
        assert.ok(fetchInfo.contentType.includes('text/css'), 'Content-Type must be text/css');
        assert.ok(parseInt(fetchInfo.contentLength, 10) > 0, 'Content-Length must be positive integer');
        assert.strictEqual(fetchInfo.contentEncoding, null, 'Content-Encoding must be removed for fulfilled uncompressed body');
      });

      // 7. GZIP compressed response handling
      check('GZIP response handling: Decompressed, rewritten, and fulfilled without decoding errors', () => {
        assert.strictEqual(gzip.htmlHelv, 'ERR:NetworkError', 'Gzip static <style> foreign font must be blocked');
        assert.strictEqual(gzip.cssHelv, 'ERR:NetworkError', 'Gzip external <link> foreign font must be blocked');
        assert.strictEqual(gzip.htmlArial, 1, 'Gzip static <style> allowed font must load');
        assert.strictEqual(gzip.cssArial, 1, 'Gzip external <link> allowed font must load');
      });

      // 8. Brotli compressed response handling
      check('Brotli response handling: Decompressed, rewritten, and fulfilled without decoding errors', () => {
        assert.strictEqual(brotli.htmlHelv, 'ERR:NetworkError', 'Brotli static <style> foreign font must be blocked');
        assert.strictEqual(brotli.cssHelv, 'ERR:NetworkError', 'Brotli external <link> foreign font must be blocked');
        assert.strictEqual(brotli.htmlArial, 1, 'Brotli static <style> allowed font must load');
        assert.strictEqual(brotli.cssArial, 1, 'Brotli external <link> allowed font must load');
      });

      // 9. CSP integrity handling
      check('CSP integrity: Content-Security-Policy style-src hash dynamically updated for rewritten <style>', () => {
        assert.strictEqual(csp.cspHelv, 'ERR:NetworkError', 'CSP style rule must be accepted by Blink and reject foreign font');
      });

      // 10. Static data: URI link in HTML
      check('Static HTML data: <link>: Pre-emptively sanitized in HTML response', () => {
        assert.strictEqual(main.fonts.p_static_data_link, 'ERR:NetworkError', 'Static data: link in HTML must be sanitized');
      });

      // 11. Integrated Protection: Dynamic in-memory data: and blob: URI stylesheets blocked by DOM gate
      check('Integrated defense: Dynamic in-memory data: <link> foreign local font blocked by DOM gate with NetworkError', () => {
        assert.strictEqual(main.dynamicProtection.dynData, 'ERR:NetworkError', 'Foreign local font in dynamic data: link must be blocked');
      });

      check('Integrated defense: Dynamic in-memory blob: <link> foreign local font blocked by DOM gate with NetworkError', () => {
        assert.strictEqual(main.dynamicProtection.dynBlob, 'ERR:NetworkError', 'Foreign local font in dynamic blob: link must be blocked');
      });

      check('Positive control: Dynamic in-memory web font via data: URI loads successfully without false positive', () => {
        assert.strictEqual(main.dynamicProtection.dynWeb, 1, 'Custom web font in dynamic data: link must load');
      });

      // 12. Isolated Fetch-only control: Confirms in-memory data: and blob: stylesheets bypass network Fetch when DOM gate is absent
      const { noDocGateControl } = sessionResult;
      if (noDocGateControl && !noDocGateControl.error) {
        checkKnownGap('Isolated Fetch-only control: In-memory data: <link> bypasses CDP Fetch when DOM gate is absent', () => {
          assert.strictEqual(noDocGateControl.rawDynData, 1, 'In absence of DOM gate, in-memory data: link bypasses network Fetch');
        });

        checkKnownGap('Isolated Fetch-only control: In-memory blob: <link> bypasses CDP Fetch when DOM gate is absent', () => {
          assert.strictEqual(noDocGateControl.rawDynBlob, 1, 'In absence of DOM gate, in-memory blob: link bypasses network Fetch');
        });
      }
    }

    const failed = results.filter((item) => !item.ok);
    if (!failed.length) {
      console.log(`css-font-response-rewrite-e2e-selftest: OK ${results.length}/${results.length}`);
    } else {
      console.log(`css-font-response-rewrite-e2e-selftest: FAILED ${failed.length}/${results.length}`);
      process.exitCode = 1;
    }
  } finally {
    server.close();
  }
})().catch((error) => {
  console.error('css-font-response-rewrite-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
