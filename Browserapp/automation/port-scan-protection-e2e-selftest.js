#!/usr/bin/env node
'use strict';

/**
 * Real-browser guard for the page-level local-port protection.
 *
 * Three local servers are used:
 *   A: page origin
 *   B: allow-listed local server
 *   C: blocked local server that is nevertheless reachable before the guard is installed
 *
 * The test first proves the blocked server is reachable without the guard, then installs the
 * generated document-start script and proves that B remains reachable while C is suppressed. A
 * Blob worker runs the same guard to cover the worker realm.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { buildPortScanProtectionScript } = require('./port-scan-protection');
const { buildFingerprint, applyFingerprintToTab } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${error.message}`); process.exitCode = 1; }
};
const skip = (name, why) => { results.push({ name, ok: true }); console.log(`  SKIP  ${name}${why ? ' — ' + why : ''}`); };
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
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: 'timeout' } }); }, 30000);
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

function makeServer(kind) {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cache-Control', 'no-store');
    if (kind === 'page') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><title>port-scan</title><main>ready</main>');
      return;
    }
    if (request.url === '/icon.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, kind }));
  });
  return server;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
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

function buildProbeExpression(allowedPort, blockedPort, guardSource) {
  const allowedBase = JSON.stringify(`http://127.0.0.1:${allowedPort}`);
  const blockedBase = JSON.stringify(`http://127.0.0.1:${blockedPort}`);
  const blockedWs = JSON.stringify(`ws://127.0.0.1:${blockedPort}/ws`);
  const workerCode = [
    guardSource,
    ';(async () => {',
    '  const result = {};',
    `  try { await fetch(${allowedBase} + '/ok'); result.fetchAllowed = 'ok'; } catch (error) { result.fetchAllowed = 'ERR:' + error.name; }`,
    `  try { await fetch(${blockedBase} + '/ok'); result.fetchBlocked = 'ok'; } catch (error) { result.fetchBlocked = 'ERR:' + error.name; }`,
    `  try { new WebSocket(${blockedWs}); result.wsBlocked = 'ok'; } catch (error) { result.wsBlocked = 'ERR:' + error.name; }`,
    '  try {',
    "    if (typeof XMLHttpRequest === 'undefined') result.xhrBlocked = 'missing';",
    `    else { new XMLHttpRequest().open('GET', ${blockedBase} + '/ok'); result.xhrBlocked = 'ok'; }`,
    "  } catch (error) { result.xhrBlocked = 'ERR:' + error.name; }",
    '  postMessage(JSON.stringify(result));',
    '})();',
  ].join('\n');

  return [
    '(async () => {',
    '  const out = {};',
    `  try { out.fetchAllowed = await (await fetch(${allowedBase} + '/ok')).json(); }`,
    "  catch (error) { out.fetchAllowed = 'ERR:' + error.name; }",
    `  try { out.fetchBlocked = await (await fetch(${blockedBase} + '/ok')).json(); }`,
    "  catch (error) { out.fetchBlocked = 'ERR:' + error.name; }",
    `  try { new XMLHttpRequest().open('GET', ${allowedBase} + '/ok'); out.xhrAllowed = 'ok'; }`,
    "  catch (error) { out.xhrAllowed = 'ERR:' + error.name; }",
    `  try { new XMLHttpRequest().open('GET', ${blockedBase} + '/ok'); out.xhrBlocked = 'ok'; }`,
    "  catch (error) { out.xhrBlocked = 'ERR:' + error.name; }",
    `  try { out.beaconAllowed = navigator.sendBeacon(${allowedBase} + '/beacon', 'x'); }`,
    "  catch (error) { out.beaconAllowed = 'ERR:' + error.name; }",
    `  try { out.beaconBlocked = navigator.sendBeacon(${blockedBase} + '/beacon', 'x'); }`,
    "  catch (error) { out.beaconBlocked = 'ERR:' + error.name; }",
    `  try { out.wsBlocked = (() => { new WebSocket(${blockedWs}); return 'ok'; })(); }`,
    "  catch (error) { out.wsBlocked = 'ERR:' + error.name; }",
    '  out.imageBlocked = await new Promise((resolve) => {',
    '    const image = new Image();',
    "    const timer = setTimeout(() => resolve('timeout'), 2000);",
    "    image.onload = () => { clearTimeout(timer); resolve('load'); };",
    "    image.onerror = () => { clearTimeout(timer); resolve('error'); };",
    `    image.src = ${blockedBase} + '/icon.svg';`,
    '  });',
    '  out.worker = await new Promise((resolve) => {',
    `    const workerSource = ${JSON.stringify(workerCode)};`,
    "    const blob = new Blob([workerSource], { type: 'application/javascript' });",
    '    const url = URL.createObjectURL(blob);',
    '    const worker = new Worker(url);',
    "    const timer = setTimeout(() => resolve('timeout'), 3000);",
    '    worker.onmessage = (event) => {',
    '      clearTimeout(timer);',
    '      URL.revokeObjectURL(url);',
    "      try { resolve(JSON.parse(event.data)); } catch (_) { resolve('parse'); }",
    '    };',
    '    worker.onerror = (event) => {',
    '      clearTimeout(timer);',
    '      URL.revokeObjectURL(url);',
    "      resolve('error:' + String(event.message || ''));",
    '    };',
    '  });',
    '  out.webdriver = navigator.webdriver;',
    '  out.platform = navigator.platform;',
    "  out.fetchNative = String(fetch).includes('[native code]');",
    '  return JSON.stringify(out);',
    '})()',
  ].join('\n');
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`port-scan-protection-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const pageServer = makeServer('page');
  const allowedServer = makeServer('allowed');
  const blockedServer = makeServer('blocked');
  const pagePort = await listen(pageServer);
  const allowedPort = await listen(allowedServer);
  const blockedPort = await listen(blockedServer);
  const guard = buildPortScanProtectionScript([allowedPort]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-portscan-'));
  const profile = {
    id: 'portscan-e2e',
    name: 'portscan-e2e',
    kernelVersion: '148.0.7778.165',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    privacy: {
      portScanProtect: true,
      portScanAllow: String(allowedPort),
    },
  };
  const fp = buildFingerprint(profile);
  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });
  const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();

  try {
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
    } else {
      const page = await waitForPage(port);
      if (!page?.webSocketDebuggerUrl) {
        skip('kernel exposed a page target', 'no page');
      } else {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP WebSocket connect failed')); });
        const cdp = new Cdp(ws);

        await cdp.call('Page.navigate', { url: `http://127.0.0.1:${pagePort}/` });
        await sleep(800);
        const baseline = await cdp.value(buildProbeExpression(allowedPort, blockedPort, guard));

        await cdp.call('Page.enable', {});
        await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, fp, profile);
        await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: guard });
        await cdp.call('Page.navigate', { url: `http://127.0.0.1:${pagePort}/` });
        await sleep(1000);
        const guarded = await cdp.value(buildProbeExpression(allowedPort, blockedPort, guard));
        try { ws.close(); } catch (_) {}

        check('baseline proves the blocked server is reachable before the guard', () => {
          assert.ok(baseline && !baseline.error, `baseline: ${baseline && baseline.error}`);
          assert.deepStrictEqual(baseline.fetchBlocked, { ok: true, kind: 'blocked' });
          assert.strictEqual(baseline.beaconBlocked, true);
        });
        check('guard keeps the allow-listed local server reachable', () => {
          assert.deepStrictEqual(guarded.fetchAllowed, { ok: true, kind: 'allowed' });
          assert.strictEqual(guarded.xhrAllowed, 'ok');
          assert.strictEqual(guarded.beaconAllowed, true);
        });
        check('guard blocks fetch, XHR, beacon and WebSocket probes to the other local port', () => {
          assert.strictEqual(guarded.fetchBlocked, 'ERR:TypeError');
          assert.strictEqual(guarded.xhrBlocked, 'ERR:SecurityError');
          assert.strictEqual(guarded.beaconBlocked, false);
          assert.strictEqual(guarded.wsBlocked, 'ERR:SecurityError');
        });
        check('guard converts an image probe to the normal error path', () => {
          assert.notStrictEqual(guarded.imageBlocked, 'load');
          assert.notStrictEqual(guarded.imageBlocked, 'timeout');
          assert.strictEqual(guarded.imageBlocked, 'error');
        });
        check('guard preserves the fingerprint disguise chain', () => {
          assert.strictEqual(guarded.webdriver, false, 'navigator.webdriver must stay hidden');
          assert.strictEqual(guarded.platform, fp.platform, 'navigator.platform must stay spoofed');
          assert.strictEqual(guarded.fetchNative, true, 'fetch must still look native after the guard');
        });
        check('guard is worker-safe', () => {
          assert.ok(guarded.worker && typeof guarded.worker === 'object', 'worker must report a result');
          assert.strictEqual(guarded.worker.fetchAllowed, 'ok');
          assert.strictEqual(guarded.worker.fetchBlocked, 'ERR:TypeError');
          assert.strictEqual(guarded.worker.wsBlocked, 'ERR:SecurityError');
          assert.ok(guarded.worker.xhrBlocked === 'missing' || guarded.worker.xhrBlocked === 'ERR:SecurityError');
        });
      }
    }
  } finally {
    await stopChild(child, dir);
    pageServer.close();
    allowedServer.close();
    blockedServer.close();
  }

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) console.log(`port-scan-protection-e2e-selftest: OK ${results.length}/${results.length}`);
  else {
    console.log(`port-scan-protection-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('port-scan-protection-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
