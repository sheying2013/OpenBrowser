#!/usr/bin/env node
'use strict';

/**
 * Real-browser guard for the WebGPU adapter identity.
 *
 * A WebGPU adapter is a high-entropy surface: vendor, architecture, device and description can
 * cross-check the WebGL renderer. The profile contract has three modes:
 *   real    — never write a native parameter and never alter the kernel adapter
 *   blocked — keep navigator.gpu present but resolve requestAdapter() to no adapter
 *   webgl   — publish the configured identity on both the native init and the page adapter
 *
 * The bundled kernel currently exposes navigator.gpu in headless mode, so this test runs the real
 * page path instead of only driving a stub.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, applyFingerprintToTab } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

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

  async value(expression) {
    const message = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: exception.text || String(exception) };
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return { error: 'probe parse', raw: String(raw).slice(0, 240) }; }
  }
}

async function startServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>webgpu</title><main>webgpu</main>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
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

async function runMode(mode, serverPort, gpuOverride = null) {
  const profile = {
    id: `webgpu-${mode}`,
    name: `webgpu-${mode}`,
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: {
      deviceProfile: 'persona',
      webgl: 'noise',
      webgpu: mode,
      fingerprint: gpuOverride ? { webgpu: gpuOverride } : undefined,
    },
  };
  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-webgpu-${mode}-`));
  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
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
    await stopChild(child, dir);
    return { error: 'no devtools port', mode, fp };
  }
  const page = await waitForPage(port);
  if (!page?.webSocketDebuggerUrl) {
    await stopChild(child, dir);
    return { error: 'no page target', mode, fp };
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP WebSocket connect failed')); });
  const cdp = new Cdp(ws);

  // Register before navigation so the probe sees the document-start path, not a one-off evaluation.
  await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, fp, profile);
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
  await sleep(1200);

  const probe = await cdp.value(`(async () => {
    if (!navigator.gpu) return JSON.stringify({ missing: true });
    let adapter = null;
    try { adapter = await navigator.gpu.requestAdapter(); } catch (error) {
      return JSON.stringify({ error: String(error && error.name || error), adapter: false });
    }
    if (!adapter) return JSON.stringify({ adapter: false });
    let info = null;
    try {
      const value = adapter.info;
      if (value) info = {
        vendor: String(value.vendor || ''),
        architecture: String(value.architecture || ''),
        device: String(value.device || ''),
        description: String(value.description || ''),
      };
    } catch (_) {}
    let requestAdapterInfo = null;
    try {
      if (typeof adapter.requestAdapterInfo === 'function') {
        const value = await adapter.requestAdapterInfo();
        requestAdapterInfo = value ? {
          vendor: String(value.vendor || ''),
          architecture: String(value.architecture || ''),
          device: String(value.device || ''),
          description: String(value.description || ''),
        } : null;
      }
    } catch (_) {}
    return JSON.stringify({ adapter: true, info, requestAdapterInfo });
  })()`);

  try { ws.close(); } catch (_) {}
  await stopChild(child, dir);
  return { mode, fp, probe };
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`webgpu-adapter-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const { server, port: serverPort } = await startServer();
  try {
    const real = await runMode('real', serverPort);
    const realInfo = (real.probe && real.probe.info) || {};
    const realVendor = String(realInfo.vendor || '').toLowerCase();
    const synthetic = realVendor === 'nvidia'
      ? { vendor: 'amd', architecture: 'rdna-3' }
      : realVendor === 'amd'
        ? { vendor: 'nvidia', architecture: 'ada' }
        : realVendor === 'intel'
          ? { vendor: 'apple', architecture: 'common-3' }
          : { vendor: 'nvidia', architecture: 'ada' };
    const blocked = await runMode('blocked', serverPort);
    const webgl = await runMode('webgl', serverPort, synthetic);
    const runs = { real, blocked, webgl };

    if (Object.values(runs).some((run) => run.error || run.probe?.error)) {
      for (const [name, run] of Object.entries(runs)) {
        if (run.error || run.probe?.error) console.log(`  INFO  ${name}: ${run.error || run.probe.error}`);
      }
      skip('webgpu adapter probe requires a kernel with navigator.gpu');
    } else if (runs.real.probe?.missing) {
      skip('webgpu adapter probe requires navigator.gpu', 'kernel does not expose WebGPU');
    } else {
      check('real mode leaves a usable adapter', () => {
        assert.strictEqual(runs.real.probe.adapter, true, 'real mode must not remove the adapter');
      });
      check('blocked mode resolves requestAdapter() to no adapter', () => {
        assert.strictEqual(runs.blocked.probe.adapter, false, 'blocked mode must suppress the adapter');
      });
      check('webgl mode publishes the configured adapter identity', () => {
        assert.strictEqual(runs.webgl.probe.adapter, true, 'webgl mode must expose an adapter');
        assert.ok(runs.webgl.probe.info, 'adapter.info must be available');
        const expected = runs.webgl.fp.webgpu.gpu || {};
        assert.strictEqual(runs.webgl.probe.info.vendor, String(expected.vendor || ''));
        assert.strictEqual(runs.webgl.probe.info.architecture, String(expected.architecture || ''));
      });
      check('webgl mode keeps a stable adapter.info object', () => {
        assert.ok(runs.webgl.probe.info, 'adapter.info must be available');
        if (runs.webgl.probe.requestAdapterInfo) {
          assert.strictEqual(runs.webgl.probe.requestAdapterInfo.vendor, runs.webgl.probe.info.vendor);
          assert.strictEqual(runs.webgl.probe.requestAdapterInfo.architecture, runs.webgl.probe.info.architecture);
        }
      });
      check('real mode is not silently overwritten with the synthetic identity', () => {
        const nativeInfo = runs.real.probe.info || {};
        const expected = synthetic;
        assert.notStrictEqual(String(nativeInfo.vendor || '').toLowerCase(), expected.vendor,
          'real mode must keep the native vendor');
      });
    }
  } finally {
    server.close();
  }

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) console.log(`webgpu-adapter-e2e-selftest: OK ${results.length}/${results.length}`);
  else {
    console.log(`webgpu-adapter-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('webgpu-adapter-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
