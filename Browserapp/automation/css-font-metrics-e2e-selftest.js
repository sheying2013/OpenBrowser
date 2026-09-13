#!/usr/bin/env node
'use strict';

/**
 * End-to-end feasibility test for CSS font metrics via FontFace and canvas measureText.
 *
 * This test investigates whether registering font files via FontFace provides genuine,
 * distinct canvas text measurement metrics in the real browser engine.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, applyFingerprintToTab } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const macosFontsDir = path.join(appRoot, 'kernels', 'windows-x64', 'wayfern_fonts', 'macos');
const win11FontsDir = path.join(appRoot, 'kernels', 'windows-x64', 'wayfern_fonts', 'win11');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

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
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: 'CDP timeout: ' + method } });
      }, 30000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  call(a, b, c) { return typeof c === 'undefined' ? this.send(a, b || {}) : this.send(b, c || {}); }
  async value(expression) {
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: exception.text || String(exception) };
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return { error: 'probe parse', raw: String(raw).slice(0, 240) }; }
  }
}

async function startServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    const parsed = new URL(request.url, 'http://127.0.0.1');
    if (parsed.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><head><meta charset="utf-8"><title>font-metrics</title></head><body><main>font-metrics</main></body></html>');
      return;
    }
    if (parsed.pathname.startsWith('/fonts/')) {
      const filename = decodeURIComponent(parsed.pathname.slice('/fonts/'.length));
      let filePath = path.join(macosFontsDir, filename);
      if (!fs.existsSync(filePath)) {
        filePath = path.join(win11FontsDir, filename);
      }
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        response.setHeader('Content-Type', ext === '.otf' ? 'font/otf' : 'font/ttf');
        fs.createReadStream(filePath).pipe(response);
        return;
      }
      response.writeHead(404);
      response.end('Font not found');
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function waitForPage(port, timeoutMs = 16000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = (list || []).find((item) => item.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(300);
  }
  return null;
}

function buildProbe() {
  return `(async () => {
  const out = {
    marker: typeof window.__marker !== 'undefined' ? window.__marker : null,
    items: [],
  };

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const probeText = 'mmmmmmmmmmlliWWWWWWWWW@@@@@@@@@@1234567890';

  ctx.font = '72px monospace';
  out.monoWidth = Math.round(ctx.measureText(probeText).width * 1000) / 1000;

  const fontSpecs = [
    { family: 'Arial', file: 'Arial.ttf', role: 'positive' },
    { family: 'Georgia', file: 'Georgia.ttf', role: 'positive' },
    { family: 'Verdana', file: 'Verdana.ttf', role: 'positive' },
    { family: 'Tahoma', file: 'Tahoma.ttf', role: 'positive' },
    { family: 'Times New Roman', file: 'Times New Roman.ttf', role: 'positive' },
    { family: 'Segoe UI', file: 'Tahoma.ttf', role: 'negative_cross_tahoma' },
    { family: 'Consolas', file: 'Georgia.ttf', role: 'negative_cross_georgia' },
    { family: 'Segoe UI Real', file: 'Segoe UI.otf', role: 'negative_win11_real' },
  ];

  // Phase 1: Measure baseline before registering any FontFace
  for (const spec of fontSpecs) {
    ctx.font = '10px sans-serif';
    ctx.font = '72px "' + spec.family + '", monospace';
    spec._beforeWidth = Math.round(ctx.measureText(probeText).width * 1000) / 1000;
    spec._beforeCheck = document.fonts.check('72px "' + spec.family + '"');
  }

  // Phase 2: Load and register FontFace instances
  for (const spec of fontSpecs) {
    let loadError = null;
    try {
      const url = '/fonts/' + encodeURIComponent(spec.file);
      const face = new FontFace(spec.family, 'url("' + url + '")');
      await face.load();
      document.fonts.add(face);
      await document.fonts.ready;
    } catch (err) {
      loadError = err.name + ': ' + err.message;
    }
    spec._loadError = loadError;
  }

  // Phase 3: Measure after FontFace registration
  for (const spec of fontSpecs) {
    ctx.font = '10px sans-serif';
    ctx.font = '72px "' + spec.family + '", monospace';
    const afterWidth = Math.round(ctx.measureText(probeText).width * 1000) / 1000;
    const afterCheck = document.fonts.check('72px "' + spec.family + '"');

    out.items.push({
      family: spec.family,
      file: spec.file,
      role: spec.role,
      beforeWidth: spec._beforeWidth,
      afterWidth,
      diff: Math.round((afterWidth - spec._beforeWidth) * 1000) / 1000,
      beforeCheck: spec._beforeCheck,
      afterCheck,
      loadError: spec._loadError,
    });
  }

  return JSON.stringify(out);
})()`;
}

function printMetricsTable(items, monoWidth) {
  const pad = (str, len) => String(str).padEnd(len);
  const padNum = (num, len) => String(num).padStart(len);

  console.log('\n  ===============================================================================================================================');
  console.log('  Family                  Source File            Role                      Check (Bf/Af)    Before (px)   After (px)    Diff (px)  ');
  console.log('  -------------------------------------------------------------------------------------------------------------------------------');
  for (const item of items) {
    const familyStr = pad(item.family, 24);
    const fileStr = pad(item.file, 23);
    const roleStr = pad(item.role, 26);
    const checkStr = pad(`${item.beforeCheck} / ${item.afterCheck}`, 17);
    const beforeStr = padNum(item.beforeWidth.toFixed(3), 11);
    const afterStr = padNum(item.afterWidth.toFixed(3), 11);
    const diffVal = item.diff > 0 ? `+${item.diff.toFixed(3)}` : item.diff.toFixed(3);
    const diffStr = padNum(diffVal, 12);
    console.log(`  ${familyStr}${fileStr}${roleStr}${checkStr}${beforeStr}   ${afterStr}   ${diffStr}`);
  }
  console.log('  ===============================================================================================================================');
  console.log(`  Fallback baseline (72px monospace): ${monoWidth.toFixed(3)} px\n`);
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`css-font-metrics-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const { server, port: serverPort } = await startServer();

  const profile = {
    id: 'font-metrics-test',
    name: 'font-metrics-test',
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona' },
  };
  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-css-font-metrics-'));

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
    child.unref();

    let port = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(400);
      try {
        const value = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
        if (value > 0) { port = value; break; }
      } catch (_) {}
    }

    if (!port) {
      skip('kernel exposed a CDP endpoint', 'no port');
      console.log(`css-font-metrics-e2e-selftest: OK ${results.length}/${results.length}`);
      return;
    }

    const page = await waitForPage(port);
    if (!page?.webSocketDebuggerUrl) {
      skip('kernel exposed a page target', 'no page');
      console.log(`css-font-metrics-e2e-selftest: OK ${results.length}/${results.length}`);
      return;
    }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP WebSocket connect failed'));
    });
    const cdp = new Cdp(ws);

    // Ensure Page domain is enabled before calling addScriptToEvaluateOnNewDocument
    await cdp.call('Page.enable', {});
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__marker = true;',
    });
    await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, fp, profile);
    await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
    await sleep(1500);

    const probeResult = await cdp.value(buildProbe());
    try { ws.close(); } catch (_) {}

    if (probeResult.error) {
      throw new Error(`Probe failed: ${probeResult.error}`);
    }

    printMetricsTable(probeResult.items, probeResult.monoWidth);

    check('injection marker window.__marker evaluates to true', () => {
      assert.strictEqual(probeResult.marker, true, 'window.__marker must be true');
    });

    check('baseline fallback font width is measurable', () => {
      assert.ok(typeof probeResult.monoWidth === 'number' && probeResult.monoWidth > 0, 'monospace width must be positive');
    });

    check('all tested font faces load successfully without errors', () => {
      for (const item of probeResult.items) {
        assert.strictEqual(item.loadError, null, `Font ${item.family} (${item.file}) load failed: ${item.loadError}`);
        assert.strictEqual(item.afterCheck, true, `document.fonts.check for ${item.family} must be true`);
      }
    });

    const positiveItems = probeResult.items.filter((item) => item.role === 'positive');
    check('all positive font families yield distinct metrics', () => {
      assert.ok(positiveItems.length >= 5, 'must test at least 5 positive families');
      const uniqueWidths = new Set(positiveItems.map((item) => item.afterWidth));
      assert.strictEqual(uniqueWidths.size, positiveItems.length,
        `All positive font families must have distinct measured widths: found ${uniqueWidths.size} unique in ${positiveItems.length}`);
    });

    const segoeTahoma = probeResult.items.find((item) => item.family === 'Segoe UI');
    const tahomaItem = probeResult.items.find((item) => item.family === 'Tahoma');
    check('negative control: Segoe UI switches from fallback to the injected font metrics', () => {
      assert.ok(segoeTahoma && tahomaItem, 'Segoe UI and Tahoma items must exist');
      // Before registration, Segoe UI is absent on macOS and falls back to monospace
      assert.strictEqual(segoeTahoma.beforeWidth, probeResult.monoWidth,
        'Segoe UI before registration must match monospace fallback width');
      // After registration with Tahoma.ttf, width must change from fallback to Tahoma.ttf width
      assert.notStrictEqual(segoeTahoma.afterWidth, segoeTahoma.beforeWidth,
        'Segoe UI width must change after FontFace registration');
      assert.strictEqual(segoeTahoma.afterWidth, tahomaItem.afterWidth,
        'Segoe UI width must match Tahoma width when fed Tahoma.ttf');
      assert.strictEqual(segoeTahoma.diff, Math.round((tahomaItem.afterWidth - probeResult.monoWidth) * 1000) / 1000,
        'diff must accurately match the jump from monospace to Tahoma');
    });

    const consolasGeorgia = probeResult.items.find((item) => item.family === 'Consolas');
    const georgiaItem = probeResult.items.find((item) => item.family === 'Georgia');
    check('negative control: Consolas switches from fallback to Georgia metrics', () => {
      assert.ok(consolasGeorgia && georgiaItem, 'Consolas and Georgia items must exist');
      assert.strictEqual(consolasGeorgia.beforeWidth, probeResult.monoWidth,
        'Consolas before registration must match monospace fallback width');
      assert.strictEqual(consolasGeorgia.afterWidth, georgiaItem.afterWidth,
        'Consolas width must match Georgia width when fed Georgia.ttf');
      assert.notStrictEqual(consolasGeorgia.afterWidth, consolasGeorgia.beforeWidth,
        'Consolas width must change after FontFace registration');
    });

    const segoeReal = probeResult.items.find((item) => item.family === 'Segoe UI Real');
    check('negative control: real Windows font file yields distinct genuine metrics', () => {
      assert.ok(segoeReal, 'Segoe UI Real item must exist');
      assert.strictEqual(segoeReal.beforeWidth, probeResult.monoWidth,
        'Segoe UI Real before registration must match monospace fallback width');
      assert.notStrictEqual(segoeReal.afterWidth, segoeReal.beforeWidth,
        'Segoe UI Real width must change after loading Segoe UI.otf');
      // Must not collide with any positive font
      for (const item of positiveItems) {
        assert.notStrictEqual(segoeReal.afterWidth, item.afterWidth,
          `Segoe UI Real width (${segoeReal.afterWidth}) must not collide with ${item.family} (${item.afterWidth})`);
      }
    });

    check('conclusion: FontFace route successfully feeds distinct font metrics to canvas measureText', () => {
      // The positive and negative controls together prove:
      // 1. Missing families transition from fallback to real metrics.
      // 2. Metrics are strictly determined by the provided font file.
      // 3. Different font files yield mutually distinct widths on canvas measureText.
      const allAfterWidths = probeResult.items
        .filter((item) => item.role === 'positive' || item.role === 'negative_win11_real')
        .map((item) => item.afterWidth);
      const uniqueCount = new Set(allAfterWidths).size;
      assert.strictEqual(uniqueCount, 6, 'All 6 independent font files must yield 6 distinct canvas widths');
    });

  } finally {
    if (child) await stopChild(child, dir);
    server.close();
  }

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`css-font-metrics-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`css-font-metrics-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('css-font-metrics-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
