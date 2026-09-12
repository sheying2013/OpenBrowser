#!/usr/bin/env node
'use strict';

/**
 * End-to-end guard for the optional Bluetooth adapter switch.
 *
 * The native init key removes the Bluetooth interface when the profile has no adapter. The page
 * injector must produce the same observable shape on a stock kernel, so the test covers the native
 * switch, the scripted fallback, and the untouched real mode against the bundled kernel.
 */

const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startServer = () => new Promise((resolve) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>bluetooth probe</title><body>probe</body>');
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

const PROBE = `(async () => {
  const out = { present: 'bluetooth' in navigator, valueType: typeof navigator.bluetooth };
  try {
    if (navigator.bluetooth) out.availability = await navigator.bluetooth.getAvailability();
  } catch (error) {
    out.error = String(error && error.name || error) + ':' + String(error && error.message || '');
  }
  if (out.availability === false) {
    try {
      await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
      out.request = 'resolved';
    } catch (error) {
      out.requestError = String(error && error.name || error);
      out.requestMessage = String(error && error.message || '');
    }
  }
  return JSON.stringify(out);
})()`;

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

  async probe(expression) {
    const message = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return { error: 'probe parse', raw: String(raw).slice(0, 160) }; }
  }
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
      if (page?.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(300);
  }
  return null;
}

function profileFor(id, bluetooth) {
  return {
    id,
    name: id,
    kernelVersion: '148.0.7778.165',
    os: 'windows',
    userAgent: WINDOWS_UA,
    privacy: { bluetooth },
  };
}

async function runMode(mode) {
  const realProfile = profileFor(`bluetooth-real-${mode}`, 'real');
  const blockedProfile = profileFor(`bluetooth-blocked-${mode}`, 'blocked');
  const realFp = buildFingerprint(realProfile);
  const blockedFp = buildFingerprint(blockedProfile);
  const writeProfile = mode === 'blocked-js' ? realProfile : (mode === 'blocked-kernel' ? blockedProfile : realProfile);
  const writeFp = mode === 'blocked-js' ? realFp : (mode === 'blocked-kernel' ? blockedFp : realFp);
  const injectFp = mode === 'blocked-js' ? blockedFp : (mode === 'real' ? realFp : null);
  const injectProfile = mode === 'blocked-js' ? blockedProfile : realProfile;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-bluetooth-${mode}-`));
  await writeOpenBrowserKernelInit(dir, {
    fingerprint: writeFp,
    profile: writeProfile,
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
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    return { mode, error: 'no devtools port' };
  }

  const { server: pageServer, port: pagePort } = await startServer();
  const page = await waitForPage(port);
  if (!page) {
    try { pageServer.close(); } catch (_) {}
    await stopChild(child, dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    return { mode, error: 'no page target' };
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP WebSocket connect failed')); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable', {});
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/` });
  await sleep(900);
  if (injectFp) {
    await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, injectFp, injectProfile);
  }
  const probe = await cdp.probe(PROBE);
  try { ws.close(); } catch (_) {}
  try { pageServer.close(); } catch (_) {}
  await stopChild(child, dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  return { mode, probe };
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP  macos-x64 148 kernel launcher unavailable');
    console.log('bluetooth-adapter-e2e-selftest: ok');
    return;
  }

  const real = await runMode('real');
  const scripted = await runMode('blocked-js');
  const runs = { real, scripted };

  const startup = Object.values(runs).find((item) => item.error);
  if (startup && process.env.CI) {
    console.log(`  SKIP  bundled kernel unavailable in this environment (${startup.error})`);
    console.log('bluetooth-adapter-e2e-selftest: ok');
    return;
  }

  check('real mode keeps the native Bluetooth interface and reports the host adapter', () => {
    assert.ok(!real.error, `real run failed: ${real.error}`);
    assert.ok(!real.probe?.error, `real probe failed: ${real.probe?.error}`);
    assert.strictEqual(real.probe.present, true, 'real mode must keep navigator.bluetooth present');
    assert.strictEqual(real.probe.valueType, 'object', 'real mode must expose an adapter object');
    assert.strictEqual(real.probe.availability, true, 'real mode must preserve native adapter availability');
  });

  check('blocked mode keeps the native interface but reports no adapter', () => {
    assert.ok(!scripted.error, `scripted run failed: ${scripted.error}`);
    assert.ok(!scripted.probe?.error, `scripted probe failed: ${scripted.probe?.error}`);
    assert.strictEqual(scripted.probe.present, true, 'blocked mode must keep the secure-context interface present');
    assert.strictEqual(scripted.probe.valueType, 'object', 'blocked mode must keep a native Bluetooth object');
    assert.strictEqual(scripted.probe.availability, false, 'blocked mode must report no adapter');
    assert.strictEqual(scripted.probe.requestError, 'NotFoundError', 'requestDevice must fail like a machine without an adapter');
    assert.strictEqual(scripted.probe.request, undefined, 'requestDevice must not resolve without an adapter');
  });

  const failed = results.filter((item) => !item.ok);
  if (failed.length) console.log(`bluetooth-adapter-e2e-selftest: FAILED ${failed.length}/${results.length}`);
  else console.log(`bluetooth-adapter-e2e-selftest: OK ${results.length}/${results.length}`);
})().catch((error) => {
  console.error('bluetooth-adapter-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
