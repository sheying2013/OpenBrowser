#!/usr/bin/env node
'use strict';

/**
 * End-to-end verification of HTTP request headers fingerprinting.
 *
 * Verifies that profile user-agent, accept-language, and client hints (sec-ch-ua*)
 * properly land on outgoing HTTP request headers rather than leaking host identity.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const {
  buildFingerprint,
  applyFingerprintToTab,
} = require('./fingerprint');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
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
  call(a, b, c) {
    return typeof c === 'undefined' ? this.send(a, b || {}) : this.send(b, c || {});
  }
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

async function startCollectorServer() {
  let capturedHeaders = null;
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    capturedHeaders = request.headers;
    response.writeHead(200);
    response.end(JSON.stringify(request.headers));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    getHeaders: () => capturedHeaders,
    resetHeaders: () => { capturedHeaders = null; },
  };
}

async function startPageServer(collectorPort) {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.writeHead(200);
    response.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Request Headers Probe</title></head>
<body>
  <div id="status">probing</div>
  <div id="headers"></div>
  <script>
    (async () => {
      try {
        const res = await fetch('http://127.0.0.1:${collectorPort}/probe?_t=' + Date.now());
        const data = await res.json();
        document.getElementById('status').textContent = 'done';
        document.getElementById('headers').textContent = JSON.stringify(data);
        document.title = JSON.stringify(data);
        window.__probeData = data;
      } catch (err) {
        document.getElementById('status').textContent = 'error';
        window.__probeErr = String(err && err.message || err);
      }
    })();
  </script>
</body>
</html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
  };
}

async function waitForHeaders(collector, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = collector.getHeaders();
    if (h) return h;
    await sleep(100);
  }
  return collector.getHeaders();
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`request-headers-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const collector = await startCollectorServer();
  const pageServer = await startPageServer(collector.port);

  const profile = {
    id: 'reqheaders-windows',
    name: 'reqheaders-windows',
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    language: 'ja-JP',
    languages: ['ja-JP', 'ja'],
    privacy: { deviceProfile: 'persona' },
  };
  const fp = buildFingerprint(profile);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-reqheaders-'));
  const child = spawn(launcher, [dir, '--headless=new'], {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let devPort = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(200);
    try {
      const val = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (val > 0) { devPort = val; break; }
    } catch (_) {}
  }

  if (!devPort) {
    await stopChild(child, dir);
    collector.server.close();
    pageServer.server.close();
    throw new Error('DevToolsActivePort not available');
  }

  const page = await waitForPage(devPort);
  if (!page?.webSocketDebuggerUrl) {
    await stopChild(child, dir);
    collector.server.close();
    pageServer.server.close();
    throw new Error('No target page available');
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP WebSocket connect failed'));
  });
  const cdp = new Cdp(ws);

  // Group 1: RAW (un-injected)
  collector.resetHeaders();
  await cdp.call('Page.enable', {});
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${pageServer.port}/?mode=raw` });
  const rawHeadersRaw = await waitForHeaders(collector);
  assert.ok(rawHeadersRaw, 'Raw headers must be captured');
  const rawHeaders = normalizeHeaders(rawHeadersRaw);
  await sleep(600);

  // Group 2: INJECTED
  // Note: Page.enable must be called before Page.addScriptToEvaluateOnNewDocument.
  // The probe registers window.__marker = true for self-verification.
  collector.resetHeaders();
  await cdp.call('Page.enable', {});
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__marker = true;'
  });
  await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, fp, profile);
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${pageServer.port}/?mode=injected` });
  const injectedHeadersRaw = await waitForHeaders(collector);
  assert.ok(injectedHeadersRaw, 'Injected headers must be captured');
  const injectedHeaders = normalizeHeaders(injectedHeadersRaw);

  // Verify probe marker
  const markerEval = await cdp.send('Runtime.evaluate', {
    expression: 'Boolean(window.__marker)',
    returnByValue: true,
  });
  const probeMarker = markerEval?.result?.result?.value;

  // Read recorded page title (DOM probe data)
  let pageProbeData = null;
  for (let i = 0; i < 40; i += 1) {
    const titleEval = await cdp.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    const val = titleEval?.result?.result?.value;
    if (val && val !== 'Request Headers Probe') {
      try {
        pageProbeData = JSON.parse(val);
        if (pageProbeData) break;
      } catch (_) {}
    }
    await sleep(100);
  }

  try { ws.close(); } catch (_) {}
  await stopChild(child, dir);
  collector.server.close();
  pageServer.server.close();

  // Test Assertions
  check('probe marker verified via Page.addScriptToEvaluateOnNewDocument (window.__marker === true)', () => {
    assert.strictEqual(probeMarker, true, 'Probe invalid: window.__marker must be true');
  });

  check('user-agent header lands declared Windows identity instead of host', () => {
    assert.strictEqual(injectedHeaders['user-agent'], WINDOWS_UA);
    assert.ok(!injectedHeaders['user-agent'].includes('Macintosh'), 'user-agent must not leak host OS');
  });

  check('sec-ch-ua-platform header lands "Windows" instead of host "macOS"', () => {
    assert.strictEqual(injectedHeaders['sec-ch-ua-platform'], '"Windows"');
    assert.notStrictEqual(injectedHeaders['sec-ch-ua-platform'], rawHeaders['sec-ch-ua-platform']);
  });

  check('accept-language header carries declared ja-JP instead of host language', () => {
    assert.ok(injectedHeaders['accept-language'].includes('ja'), 'accept-language must contain ja');
    assert.notStrictEqual(injectedHeaders['accept-language'], rawHeaders['accept-language']);
  });

  check('sec-ch-ua header brands reflect Chrome 148 persona instead of host Chrome 147', () => {
    assert.ok(injectedHeaders['sec-ch-ua'].includes('148'), 'sec-ch-ua must match profile Chrome 148');
    assert.notStrictEqual(injectedHeaders['sec-ch-ua'], rawHeaders['sec-ch-ua']);
  });

  check('sec-ch-ua-mobile header reflects desktop profile (?0)', () => {
    assert.strictEqual(injectedHeaders['sec-ch-ua-mobile'], '?0');
  });

  check('high-entropy client hints do not leak host architecture or version when unprompted', () => {
    for (const h of [
      'sec-ch-ua-arch',
      'sec-ch-ua-bitness',
      'sec-ch-ua-model',
      'sec-ch-ua-platform-version',
      'sec-ch-ua-full-version',
      'sec-ch-ua-full-version-list',
    ]) {
      assert.strictEqual(injectedHeaders[h], undefined, `${h} must not be sent unprompted`);
    }
  });

  check('runtime constants (accept-encoding, connection, accept, referer, sec-fetch-*) classified as non-gaps', () => {
    assert.ok(injectedHeaders['accept-encoding'], 'accept-encoding must be present');
    assert.strictEqual(injectedHeaders['connection'], 'keep-alive');
    assert.ok(injectedHeaders['sec-fetch-mode'], 'sec-fetch-mode must be present');
    assert.ok(injectedHeaders['referer'], 'referer must be present');
  });

  check('page script received and stored probe response in document.title and div', () => {
    assert.ok(pageProbeData && typeof pageProbeData === 'object', 'DOM probe data must exist');
    const normProbe = normalizeHeaders(pageProbeData);
    assert.strictEqual(normProbe['user-agent'], WINDOWS_UA);
    assert.strictEqual(normProbe['sec-ch-ua-platform'], '"Windows"');
  });

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`request-headers-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`request-headers-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('request-headers-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
