#!/usr/bin/env node
'use strict';

/**
 * End-to-end qualitative evaluation for storage, performance, and crypto interfaces.
 *
 * Verifies that storage estimates, persisted state, performance memory, time origin,
 * performance.now monotonicity, and crypto APIs reflect genuine runtime values
 * without artificial monkey-patching or logical contradictions with device settings.
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
} = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

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
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
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
    try {
      return JSON.parse(raw);
    } catch (_) {
      return { error: 'probe parse', raw: String(raw).slice(0, 240) };
    }
  }
}

async function startServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>storage-perf</title><main>storage-perf</main>');
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

const PROBE = `(async () => {
  const out = {};
  out.__marker = Boolean(window.__marker);

  out.storage = {};
  if (navigator.storage) {
    try {
      const est = await navigator.storage.estimate();
      out.storage.estimate = {
        quota: est.quota,
        usage: est.usage,
        typeQuota: typeof est.quota,
        typeUsage: typeof est.usage,
      };
    } catch (e) {
      out.storage.estimate = { error: String(e && e.message) };
    }
    try {
      out.storage.persisted = await navigator.storage.persisted();
      out.storage.persistedToString = Function.prototype.toString.call(navigator.storage.persisted);
    } catch (e) {
      out.storage.persisted = { error: String(e && e.message) };
    }
    try {
      out.storage.persistResult = await navigator.storage.persist();
      out.storage.persistToString = Function.prototype.toString.call(navigator.storage.persist);
    } catch (e) {
      out.storage.persistResult = { error: String(e && e.message) };
    }
  } else {
    out.storage.missing = true;
  }

  out.performance = {};
  if (window.performance) {
    if (performance.memory) {
      out.performance.memory = {
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        usedJSHeapSize: performance.memory.usedJSHeapSize,
      };
    } else {
      out.performance.memory = null;
    }
    out.performance.timeOrigin = performance.timeOrigin;
    out.performance.timeOriginType = typeof performance.timeOrigin;

    const t1 = performance.now();
    let t2 = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      t2 = performance.now();
    }
    out.performance.nowSample = {
      t1,
      t2,
      monotonic: t2 >= t1,
    };
    out.performance.nowToString = Function.prototype.toString.call(performance.now);
  }

  out.crypto = {};
  if (window.crypto) {
    out.crypto.hasRandomUUID = typeof crypto.randomUUID === 'function';
    out.crypto.hasGetRandomValues = typeof crypto.getRandomValues === 'function';
    out.crypto.randomUUIDToString = typeof crypto.randomUUID === 'function' ? Function.prototype.toString.call(crypto.randomUUID) : null;
    out.crypto.getRandomValuesToString = typeof crypto.getRandomValues === 'function' ? Function.prototype.toString.call(crypto.getRandomValues) : null;
    out.crypto.sampleUUID = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : null;
    const buf = new Uint8Array(8);
    if (typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(buf);
      out.crypto.sampleRandomValues = Array.from(buf);
    }
  }

  out.deviceMemory = navigator.deviceMemory;
  out.hardwareConcurrency = navigator.hardwareConcurrency;

  return JSON.stringify(out);
})()`;

async function runInstance({ label, inject, serverPort }) {
  const profile = {
    id: `storageperf-${label}`,
    name: `storageperf-${label}`,
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona', memory: 8, cores: 8, webgl: 'noise' },
  };
  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-storageperf-${label}-`));
  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const child = spawn(launcher, [dir, '--headless=new', '--enable-unsafe-swiftshader'], {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(300);
    try {
      const value = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (value > 0) { port = value; break; }
    } catch (_) {}
  }
  if (!port) {
    await stopChild(child, dir);
    return { error: 'no devtools port' };
  }

  const page = await waitForPage(port);
  if (!page?.webSocketDebuggerUrl) {
    await stopChild(child, dir);
    return { error: 'no page target' };
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP WebSocket connect failed'));
  });
  const cdp = new Cdp(ws);

  // Critical requirement: Page domain must be enabled before Page.addScriptToEvaluateOnNewDocument
  await cdp.call('Page.enable', {});

  // Register marker first to self-prove that new document scripts actually execute
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__marker = true;' });

  if (inject) {
    const injectionScript = buildInjectionScript(fp);
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: injectionScript });
  }

  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
  await sleep(1200);

  const probe = await cdp.value(PROBE);
  try { ws.close(); } catch (_) {}
  await stopChild(child, dir);
  return { label, probe, fp };
}

(async () => {
  // Pure logic tests that run regardless of platform/kernel presence
  check('injection script does not patch navigator.storage', () => {
    const testFp = buildFingerprint({
      id: 'static-test',
      userAgent: WINDOWS_UA,
      privacy: { deviceProfile: 'persona', memory: 8, cores: 8 },
    });
    const script = buildInjectionScript(testFp);
    assert.ok(!script.includes('navigator.storage'), 'navigator.storage must not be modified in injection script');
  });

  check('injection script does not tamper with runtime performance measurements', () => {
    const testFp = buildFingerprint({
      id: 'static-test-perf',
      userAgent: WINDOWS_UA,
      privacy: { deviceProfile: 'persona', memory: 8, cores: 8 },
    });
    const script = buildInjectionScript(testFp);
    assert.ok(!script.includes('performance.timeOrigin'), 'performance.timeOrigin must not be modified in injection script');
    assert.ok(!script.includes('performance.now'), 'performance.now must not be modified in injection script');
    assert.ok(!script.includes('performance.memory'), 'performance.memory must not be modified in injection script');
  });

  check('injection script preserves crypto entropy and function prototypes', () => {
    const testFp = buildFingerprint({
      id: 'static-test-crypto',
      userAgent: WINDOWS_UA,
      privacy: { deviceProfile: 'persona', memory: 8, cores: 8 },
    });
    const script = buildInjectionScript(testFp);
    assert.ok(!script.includes('crypto.randomUUID'), 'crypto.randomUUID must not be patched in injection script');
    assert.ok(!script.includes('crypto.getRandomValues'), 'crypto.getRandomValues must not be patched in injection script');
  });

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available', 'platform or launcher missing');
    const failed = results.filter((item) => !item.ok);
    if (!failed.length) console.log(`storage-perf-e2e-selftest: OK ${results.length}/${results.length}`);
    else {
      console.log(`storage-perf-e2e-selftest: FAILED ${failed.length}/${results.length}`);
      process.exitCode = 1;
    }
    return;
  }

  const { server, port: serverPort } = await startServer();
  let rawRun = null;
  let injectedRun = null;

  try {
    rawRun = await runInstance({ label: 'raw', inject: false, serverPort });
    injectedRun = await runInstance({ label: 'injected', inject: true, serverPort });
  } finally {
    server.close();
  }

  if (rawRun?.error || injectedRun?.error) {
    check('real browser instances start successfully', () => {
      assert.fail(`Browser launch failed: raw=${rawRun?.error}, injected=${injectedRun?.error}`);
    });
    const failed = results.filter((item) => !item.ok);
    console.log(`storage-perf-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
    return;
  }

  // 1. Probe execution verification
  check('cdp probe scripts execute with marker self-proof on new document', () => {
    assert.strictEqual(rawRun.probe?.__marker, true, 'raw instance marker must be true');
    assert.strictEqual(injectedRun.probe?.__marker, true, 'injected instance marker must be true');
  });

  // 2. Storage estimate qualification
  check('navigator.storage.estimate answers with valid numbers and raw/injected match (no leak)', () => {
    const rawEst = rawRun.probe?.storage?.estimate;
    const injEst = injectedRun.probe?.storage?.estimate;
    assert.ok(rawEst && typeof rawEst.quota === 'number' && rawEst.quota > 0, 'raw quota must be a positive number');
    assert.ok(injEst && typeof injEst.quota === 'number' && injEst.quota > 0, 'injected quota must be a positive number');
    assert.strictEqual(rawEst.typeQuota, 'number');
    assert.strictEqual(injEst.typeQuota, 'number');
    assert.strictEqual(rawEst.typeUsage, 'number');
    assert.strictEqual(injEst.typeUsage, 'number');
    assert.strictEqual(injEst.quota, rawEst.quota, 'storage quota must not be fabricated or modified by injection');
    assert.strictEqual(injEst.usage, rawEst.usage, 'storage usage must remain consistent with runtime state');
  });

  // 3. Storage quota and deviceMemory consistency check
  check('storage quota does not contradict with deviceMemory declaration', () => {
    assert.strictEqual(injectedRun.probe?.deviceMemory, 8, 'profile must advertise 8GB deviceMemory');
    const injQuota = injectedRun.probe?.storage?.estimate?.quota;
    assert.ok(typeof injQuota === 'number' && !Number.isNaN(injQuota), 'quota must be a valid numeric value');
    assert.ok(injQuota >= 1024 * 1024 * 1024, 'quota must be an expected disk storage space (at least 1GB)');
  });

  // 4. Storage persistence qualification
  check('navigator.storage persistence functions exist with native code shape (no leak)', () => {
    const rawStorage = rawRun.probe?.storage || {};
    const injStorage = injectedRun.probe?.storage || {};
    assert.strictEqual(typeof rawStorage.persisted, 'boolean');
    assert.strictEqual(typeof injStorage.persisted, 'boolean');
    assert.strictEqual(typeof rawStorage.persistResult, 'boolean');
    assert.strictEqual(typeof injStorage.persistResult, 'boolean');
    assert.strictEqual(rawStorage.persistedToString, 'function persisted() { [native code] }');
    assert.strictEqual(injStorage.persistedToString, 'function persisted() { [native code] }');
    assert.strictEqual(rawStorage.persistToString, 'function persist() { [native code] }');
    assert.strictEqual(injStorage.persistToString, 'function persist() { [native code] }');
  });

  // 5. Performance memory qualification
  check('performance.memory reflects real V8 heap stats and is unpatched (no leak)', () => {
    const rawMem = rawRun.probe?.performance?.memory;
    const injMem = injectedRun.probe?.performance?.memory;
    assert.ok(rawMem, 'raw performance.memory must be available in Chromium');
    assert.ok(injMem, 'injected performance.memory must be available in Chromium');
    assert.strictEqual(rawMem.jsHeapSizeLimit, 4294967296, 'raw jsHeapSizeLimit must reflect standard 4GB V8 64-bit limit');
    assert.strictEqual(injMem.jsHeapSizeLimit, 4294967296, 'injected jsHeapSizeLimit must remain native 4GB');
    assert.ok(rawMem.totalJSHeapSize > 0 && rawMem.usedJSHeapSize > 0, 'raw heap sizes must be positive integers');
    assert.ok(injMem.totalJSHeapSize > 0 && injMem.usedJSHeapSize > 0, 'injected heap sizes must be positive integers');
    assert.ok(rawMem.usedJSHeapSize <= rawMem.totalJSHeapSize, 'raw used heap must be <= total heap');
    assert.ok(injMem.usedJSHeapSize <= injMem.totalJSHeapSize, 'injected used heap must be <= total heap');
    assert.ok(injMem.totalJSHeapSize <= injMem.jsHeapSizeLimit, 'injected total heap must be <= limit');
    assert.ok(injMem.totalJSHeapSize > rawMem.totalJSHeapSize, 'injected heap size naturally accommodates injected script payload');
  });

  // 6. Performance timeOrigin qualification
  check('performance.timeOrigin is a plausible runtime timestamp and unforgeable (no leak)', () => {
    const rawOrigin = rawRun.probe?.performance?.timeOrigin;
    const injOrigin = injectedRun.probe?.performance?.timeOrigin;
    assert.strictEqual(typeof rawOrigin, 'number');
    assert.strictEqual(typeof injOrigin, 'number');
    assert.ok(rawOrigin > 1700000000000, 'raw timeOrigin must be a plausible unix epoch timestamp');
    assert.ok(injOrigin > 1700000000000, 'injected timeOrigin must be a plausible unix epoch timestamp');
    assert.notStrictEqual(rawOrigin, injOrigin, 'each instance generates independent runtime timeOrigin');
  });

  // 7. Performance now monotonicity qualification
  check('performance.now is monotonic and preserves native function integrity (no leak)', () => {
    const rawPerf = rawRun.probe?.performance || {};
    const injPerf = injectedRun.probe?.performance || {};
    assert.strictEqual(rawPerf.nowSample?.monotonic, true, 'raw performance.now must be monotonic');
    assert.strictEqual(injPerf.nowSample?.monotonic, true, 'injected performance.now must be monotonic');
    assert.strictEqual(rawPerf.nowToString, 'function now() { [native code] }');
    assert.strictEqual(injPerf.nowToString, 'function now() { [native code] }');
  });

  // 8. Crypto APIs qualification
  check('crypto randomUUID and getRandomValues retain native shape and entropy (no leak)', () => {
    const rawCrypto = rawRun.probe?.crypto || {};
    const injCrypto = injectedRun.probe?.crypto || {};
    assert.strictEqual(rawCrypto.hasRandomUUID, true);
    assert.strictEqual(injCrypto.hasRandomUUID, true);
    assert.strictEqual(rawCrypto.hasGetRandomValues, true);
    assert.strictEqual(injCrypto.hasGetRandomValues, true);
    assert.strictEqual(rawCrypto.randomUUIDToString, 'function randomUUID() { [native code] }');
    assert.strictEqual(injCrypto.randomUUIDToString, 'function randomUUID() { [native code] }');
    assert.strictEqual(rawCrypto.getRandomValuesToString, 'function getRandomValues() { [native code] }');
    assert.strictEqual(injCrypto.getRandomValuesToString, 'function getRandomValues() { [native code] }');

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    assert.ok(uuidRegex.test(rawCrypto.sampleUUID), `raw sampleUUID (${rawCrypto.sampleUUID}) must match uuid v4 pattern`);
    assert.ok(uuidRegex.test(injCrypto.sampleUUID), `injected sampleUUID (${injCrypto.sampleUUID}) must match uuid v4 pattern`);

    assert.ok(Array.isArray(rawCrypto.sampleRandomValues) && rawCrypto.sampleRandomValues.length === 8);
    assert.ok(Array.isArray(injCrypto.sampleRandomValues) && injCrypto.sampleRandomValues.length === 8);
    assert.ok(rawCrypto.sampleRandomValues.some((b) => b !== 0), 'raw getRandomValues must generate non-zero entropy');
    assert.ok(injCrypto.sampleRandomValues.some((b) => b !== 0), 'injected getRandomValues must generate non-zero entropy');
  });

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) console.log(`storage-perf-e2e-selftest: OK ${results.length}/${results.length}`);
  else {
    console.log(`storage-perf-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('storage-perf-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
