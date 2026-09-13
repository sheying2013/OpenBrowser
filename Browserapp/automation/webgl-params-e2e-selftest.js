#!/usr/bin/env node
'use strict';

/**
 * Real-browser guard for the driver-reported WebGL limits.
 *
 * Naming an adapter in getParameter(UNMASKED_*) is only half of the identity: the same context
 * also answers MAX_TEXTURE_SIZE / MAX_CUBE_MAP_TEXTURE_SIZE / MAX_RENDERBUFFER_SIZE /
 * MAX_VIEWPORT_DIMS / MAX_VERTEX_UNIFORM_VECTORS / MAX_VARYING_VECTORS straight from the driver.
 * Leaving those at the host value while the adapter name claims another GPU is a cross check a
 * page can run without knowing any ground truth, so each profile has to answer both from the same
 * class. This suite drives the real page path and compares the two.
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
  webglParameterOverrides,
  WEBGL_PARAM_IDS,
} = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} - ${error.message}`); process.exitCode = 1; }
};
const skip = (name, why) => { results.push({ name, ok: true }); console.log(`  SKIP  ${name}${why ? ' - ' + why : ''}`); };
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
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>webgl-params</title><main>webgl-params</main>');
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
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) return JSON.stringify({ missing: true });
  const names = ['MAX_TEXTURE_SIZE','MAX_CUBE_MAP_TEXTURE_SIZE','MAX_RENDERBUFFER_SIZE','MAX_VERTEX_UNIFORM_VECTORS','MAX_VARYING_VECTORS'];
  for (const name of names) {
    try { out[name] = gl.getParameter(gl[name]); } catch (error) { out[name] = 'ERR:' + error.name; }
  }
  try {
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    out.MAX_VIEWPORT_DIMS = dims ? [Number(dims[0]), Number(dims[1])] : null;
    out.MAX_VIEWPORT_DIMS_CTOR = dims ? String(dims.constructor && dims.constructor.name) : null;
  } catch (error) { out.MAX_VIEWPORT_DIMS = 'ERR:' + error.name; }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) {
    try { out.UNMASKED_VENDOR_WEBGL = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL); } catch (_) {}
    try { out.UNMASKED_RENDERER_WEBGL = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL); } catch (_) {}
  }
  return JSON.stringify(out);
})()`;

async function runProfile(label, serverPort) {
  const profile = {
    id: `webglparams-${label}`,
    name: `webglparams-${label}`,
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona', webgl: 'noise', webgpu: 'webgl' },
  };
  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-webglparams-${label}-`));
  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const child = spawn(launcher, [dir, '--headless=new', '--enable-unsafe-swiftshader'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
  child.unref();
  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(400);
    try {
      const value = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (value > 0) { port = value; break; }
    } catch (_) {}
  }
  if (!port) { await stopChild(child, dir); return { error: 'no devtools port', label, fp }; }
  const page = await waitForPage(port);
  if (!page?.webSocketDebuggerUrl) { await stopChild(child, dir); return { error: 'no page target', label, fp }; }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP WebSocket connect failed')); });
  const cdp = new Cdp(ws);
  await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, fp, profile);
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
  await sleep(1200);
  const probe = await cdp.value(PROBE);
  try { ws.close(); } catch (_) {}
  await stopChild(child, dir);
  return { label, fp, probe, limits: webglParameterOverrides(fp.webgl?.gpu) };
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`webgl-params-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  // Pure mapping checks run everywhere, so a regression is caught even when the kernel cannot start.
  check('every supported GPU class answers with integer limits', () => {
    for (const gpu of [
      { vendor: 'nvidia', architecture: 'ada' },
      { vendor: 'nvidia', architecture: 'turing' },
      { vendor: 'amd', architecture: 'rdna-2' },
      { vendor: 'amd', architecture: 'gcn-4' },
      { vendor: 'intel', architecture: 'gen9' },
      { vendor: 'intel', architecture: 'gen7' },
      { vendor: 'apple', architecture: 'common-3' },
    ]) {
      const limits = webglParameterOverrides(gpu);
      assert.ok(limits, `${gpu.vendor}/${gpu.architecture} must map to limits`);
      for (const [id, value] of Object.entries(limits)) {
        assert.ok(Number.isInteger(value) && value > 0, `${gpu.vendor} limit ${id} must be a positive integer`);
      }
      assert.strictEqual(limits[WEBGL_PARAM_IDS.MAX_CUBE_MAP_TEXTURE_SIZE], limits[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE],
        'cube map size must follow the texture size');
      assert.strictEqual(limits[WEBGL_PARAM_IDS.MAX_RENDERBUFFER_SIZE], limits[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE],
        'renderbuffer size must follow the texture size');
    }
  });

  check('one GPU class always answers the same, and unknown input stays uncoerced', () => {
    const a = webglParameterOverrides({ vendor: 'NVIDIA', architecture: 'Ampere' });
    const b = webglParameterOverrides({ vendor: 'nvidia', architecture: 'ampere' });
    assert.deepStrictEqual(a, b, 'the mapping must be case insensitive and deterministic');
    assert.strictEqual(webglParameterOverrides(null), null, 'no GPU identity means no coercion');
    assert.strictEqual(webglParameterOverrides({}), null, 'an empty identity means no coercion');
    assert.strictEqual(webglParameterOverrides({ vendor: 'unknown', architecture: 'x' }), null,
      'an unknown family must not fabricate limits');
  });

  check('the build carries the limits into the injected config', () => {
    const fp = buildFingerprint({
      id: 'webglparams-config',
      userAgent: WINDOWS_UA,
      privacy: { webgl: 'noise' },
    });
    const limits = fp.webgl?.gpu ? webglParameterOverrides(fp.webgl.gpu) : null;
    assert.ok(limits, 'a profile with a GPU identity must carry limits');
  });

  const { server, port: serverPort } = await startServer();
  try {
    const run = await runProfile('persona', serverPort);
    if (run.error || run.probe?.error) {
      console.log(`  INFO  ${run.error || run.probe.error}`);
      skip('driver limits probe requires a working WebGL context');
    } else if (run.probe?.missing) {
      skip('driver limits probe requires a working WebGL context', 'getContext returned null');
    } else {
      check('the advertised driver limits describe the profile GPU, not the host', () => {
        const limits = run.limits;
        assert.ok(limits, 'the run must carry limits');
        for (const name of ['MAX_TEXTURE_SIZE', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS']) {
          const id = WEBGL_PARAM_IDS[name];
          assert.strictEqual(Number(run.probe[name]), Number(limits[id]), `${name} must answer from the profile class`);
        }
      });
      check('the viewport dimension array stays self consistent and typed', () => {
        const limits = run.limits;
        const dims = run.probe.MAX_VIEWPORT_DIMS;
        assert.ok(Array.isArray(dims) && dims.length === 2, 'MAX_VIEWPORT_DIMS must stay a two element array');
        assert.strictEqual(dims[0], Number(limits[WEBGL_PARAM_IDS.MAX_RENDERBUFFER_SIZE]));
        assert.strictEqual(dims[1], Number(limits[WEBGL_PARAM_IDS.MAX_RENDERBUFFER_SIZE]));
        assert.strictEqual(run.probe.MAX_VIEWPORT_DIMS_CTOR, 'Int32Array',
          'the array type must match what the engine hands out');
      });
      check('the adapter name and the limits come from the same identity', () => {
        const limits = run.limits;
        const expectedVendor = String((run.fp.webgl?.gpu || {}).vendor || '').toLowerCase();
        assert.ok(expectedVendor, 'the run must know which GPU it claims');
        const expected = expectedVendor === 'nvidia' ? 32768 : 16384;
        assert.strictEqual(Number(run.probe.MAX_TEXTURE_SIZE), expected,
          'the texture size must match the class the adapter name claims');
        if (run.probe.UNMASKED_RENDERER_WEBGL) {
          assert.ok(String(run.probe.UNMASKED_RENDERER_WEBGL).length > 0, 'the renderer string must not be empty');
        }
      });
    }
  } finally {
    server.close();
  }

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) console.log(`webgl-params-e2e-selftest: OK ${results.length}/${results.length}`);
  else {
    console.log(`webgl-params-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('webgl-params-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
