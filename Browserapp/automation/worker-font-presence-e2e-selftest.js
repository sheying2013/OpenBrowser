#!/usr/bin/env node
'use strict';

/**
 * End-to-end selftest for font presence handling inside DedicatedWorkerGlobalScope.
 *
 * Web workers expose the FontFace constructor and allow pages to probe for installed
 * local fonts via plain local() sources. In cross-platform personas (such as a Windows
 * persona hosted on macOS), the unshielded worker scope reveals the host operating
 * system fonts (e.g. Helvetica Neue resolves, Segoe UI rejects).
 *
 * This test drives the real 148 browser kernel, intercepts worker targets at creation
 * time via Target.setAutoAttach before execution starts, injects the worker font presence
 * fallback source, and verifies in a DedicatedWorker that:
 *  1. Injection marker confirms execution inside DedicatedWorkerGlobalScope.
 *  2. Foreign platform families reject with DOMException NetworkError.
 *  3. Persona families resolve with status 'loaded'.
 *  4. Web fonts loaded via url() / data: and mixed local()+url() candidates pass through.
 *  5. FontFace constructor and methods preserve native function shapes and [native code] strings.
 *  6. FontFace instances carry no own property leaks and reflect consistent status.
 *
 * Supports --mutate to verify test sensitivity: disabling the fallback must cause foreign
 * rejection assertions to fail on the host platform.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { buildWorkerFontPresenceSource } = require('./worker-font-presence-fallback');

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
    this.events = [];
    ws.addEventListener('message', (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, timer } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        resolve(message);
        return;
      }
      if (message.method) {
        this.events.push(message);
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
        resolve({ error: { message: `CDP timeout: ${method}` } });
      }, 30000);
      this.pending.set(id, { resolve, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }

  async waitEvent(method, predicate, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const idx = this.events.findIndex((ev) => ev.method === method && (!predicate || predicate(ev)));
      if (idx >= 0) {
        return this.events.splice(idx, 1)[0];
      }
      await sleep(50);
    }
    return null;
  }
}

async function startServer() {
  const subsetPath = path.join(appRoot, 'assets', 'font-subsets', 'windows', 'segoe-ui.woff2');
  const subsetBuf = fs.existsSync(subsetPath) ? fs.readFileSync(subsetPath) : Buffer.alloc(0);

  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');

    if (request.url === '/subset.woff2') {
      response.setHeader('Content-Type', 'font/woff2');
      response.end(subsetBuf);
      return;
    }

    if (request.url === '/worker.js') {
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      response.end(`
        self.onmessage = async () => {
          const probe = async (family) => {
            const face = new FontFace(family, 'local("' + family + '")');
            const entry = {};
            try {
              await face.load();
              entry.outcome = 'resolve';
            } catch (err) {
              entry.outcome = 'reject';
              entry.errName = (err && err.name) || 'UnknownError';
            }
            try {
              entry.status = face.status;
            } catch (_) {
              entry.status = 'throw';
            }
            entry.ownProps = Object.getOwnPropertyNames(face);
            return entry;
          };

          const families = [
            'Helvetica Neue',
            'Luminari',
            'Segoe UI',
            'Cambria Math',
            'Microsoft YaHei'
          ];

          const items = {};
          for (const family of families) {
            items[family] = await probe(family);
          }

          // Test url data font pass-through
          let urlDataFont = 'unloaded';
          try {
            const resp = await fetch('/subset.woff2');
            const buf = await resp.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const dataUrl = 'url("data:font/woff2;base64,' + btoa(binary) + '")';
            const dataFace = new FontFace('AuditDataFont', dataUrl);
            await dataFace.load();
            urlDataFont = dataFace.status;
          } catch (err) {
            urlDataFont = 'err:' + ((err && err.name) || String(err));
          }

          // Test mixed local() + url candidate source pass-through
          let mixedFont = 'unloaded';
          try {
            const resp = await fetch('/subset.woff2');
            const buf = await resp.arrayBuffer();
            const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'font/woff2' }));
            const mixedFace = new FontFace('AuditMixed', 'local("NoSuchLocalFontZZZ"), url("' + blobUrl + '")');
            await mixedFace.load();
            mixedFont = mixedFace.status;
          } catch (err) {
            mixedFont = 'err:' + ((err && err.name) || String(err));
          }

          const shape = {
            type: typeof FontFace,
            name: FontFace.name,
            length: FontFace.length,
            toStringCtor: Function.prototype.toString.call(FontFace),
            toStringLoad: Function.prototype.toString.call(FontFace.prototype.load),
            toStringStatus: Function.prototype.toString.call(Object.getOwnPropertyDescriptor(FontFace.prototype, 'status').get),
            toStringHasSource: /localOnlyFamily|isPlainLocalSource/.test(Function.prototype.toString.call(FontFace.prototype.load)),
          };

          const isDedicated = typeof WorkerGlobalScope !== 'undefined'
            && (self instanceof DedicatedWorkerGlobalScope)
            && typeof window === 'undefined';

          self.postMessage({
            marker: Boolean(self.__workerMarker),
            isDedicated,
            items,
            urlDataFont,
            mixedFont,
            shape,
          });
        };
      `);
      return;
    }

    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
<html>
<head><title>worker-font-presence</title></head>
<body>
<script>
  window.__createWorker = () => {
    window.__worker = new Worker('/worker.js');
    window.__workerPromise = new Promise((resolve) => {
      window.__worker.onmessage = (event) => resolve(event.data);
    });
  };
</script>
</body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function runTest(serverPort, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-worker-font-'));
  const profile = {
    id: 'worker-font-win',
    name: 'worker-font-win',
    language: 'en-US',
    userAgent: WINDOWS_UA,
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    exitIp: '203.0.113.7',
    privacy: { deviceProfile: 'persona' },
  };
  const fp = buildFingerprint(profile);

  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const child = spawn(launcher, [dir, '--headless=new'], {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let devToolsPort = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(400);
    try {
      const portVal = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
      if (portVal > 0) {
        devToolsPort = portVal;
        break;
      }
    } catch (_) {}
  }

  if (!devToolsPort) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    return { error: 'Failed to obtain DevTools port' };
  }

  let ws = null;
  try {
    const ver = await (await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)).json();
    ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP WebSocket connect failed'));
    });
    const cdp = new Cdp(ws);

    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    const targets = await cdp.send('Target.getTargets', {});
    const pageTarget = ((targets.result || {}).targetInfos || []).find((t) => t.type === 'page');
    if (!pageTarget) {
      throw new Error('No page target found');
    }

    const attachRes = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const pageSession = attachRes?.result?.sessionId;
    if (!pageSession) {
      throw new Error('Failed to attach to page target');
    }

    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` }, pageSession);
    await sleep(600);

    // Enable nested auto-attach on the page session so workers start paused
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, pageSession);

    // Trigger DedicatedWorker creation in page
    cdp.events = cdp.events.filter((ev) => ev.method !== 'Target.attachedToTarget');
    await cdp.send('Runtime.evaluate', { expression: 'window.__createWorker();' }, pageSession);

    const attachEvent = await cdp.waitEvent('Target.attachedToTarget', (ev) => {
      const info = ev.params?.targetInfo || {};
      return info.type === 'worker';
    }, 15000);

    if (!attachEvent) {
      throw new Error('Worker target was not attached via CDP');
    }

    const workerSession = attachEvent.params.sessionId;
    const workerSource = mutate
      ? 'self.__workerMarker = true;\n/* mutation: worker font presence disabled */'
      : 'self.__workerMarker = true;\n' + buildWorkerFontPresenceSource(fp);

    // Inject fallback script into worker target before unpausing
    await cdp.send('Runtime.evaluate', { expression: workerSource }, workerSession);
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, workerSession);

    // Trigger probe execution and retrieve result
    const evalRes = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        window.__worker.postMessage(1);
        return await window.__workerPromise;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }, pageSession);

    const probe = evalRes?.result?.result?.value;
    return { probe };
  } finally {
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`worker-font-presence-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const mutate = process.argv.includes('--mutate');
  const { server, port } = await startServer();

  let runResult = null;
  try {
    runResult = await runTest(port, mutate);
  } finally {
    server.close();
  }

  if (runResult.error) {
    console.error('Test run failure:', runResult.error);
    process.exitCode = 1;
    return;
  }

  const probe = runResult.probe;
  assert.ok(probe, 'worker probe must return data');

  check('worker marker proves script injected into DedicatedWorkerGlobalScope', () => {
    assert.strictEqual(probe.marker, true, 'self.__workerMarker must be true in worker');
    assert.strictEqual(probe.isDedicated, true, 'must run inside DedicatedWorkerGlobalScope');
  });

  check('foreign families reject with a NetworkError on a Windows persona', () => {
    for (const family of ['Helvetica Neue', 'Luminari']) {
      const entry = probe.items[family];
      assert.ok(entry, `probe entry for ${family} must exist`);
      assert.strictEqual(entry.outcome, 'reject', `${family} must reject on a Windows persona, got ${entry.outcome}`);
      assert.strictEqual(entry.errName, 'NetworkError', `${family} rejection must be a NetworkError`);
      assert.strictEqual(entry.status, 'error', `${family} status must be error, got ${entry.status}`);
    }
  });

  check('persona families resolve on a Windows persona', () => {
    for (const family of ['Segoe UI', 'Cambria Math', 'Microsoft YaHei']) {
      const entry = probe.items[family];
      assert.ok(entry, `probe entry for ${family} must exist`);
      assert.strictEqual(entry.outcome, 'resolve', `${family} must resolve on a Windows persona, got ${entry.outcome}`);
      assert.strictEqual(entry.status, 'loaded', `${family} status must be loaded, got ${entry.status}`);
    }
  });

  check('url data font and mixed local()+url load normally in worker', () => {
    assert.strictEqual(probe.urlDataFont, 'loaded', `url data font must load, got ${probe.urlDataFont}`);
    assert.strictEqual(probe.mixedFont, 'loaded', `mixed local()+url font must load, got ${probe.mixedFont}`);
  });

  check('FontFace in worker keeps native shape and toString disguises', () => {
    const shape = probe.shape;
    assert.strictEqual(shape.type, 'function');
    assert.strictEqual(shape.name, 'FontFace');
    assert.strictEqual(shape.length, 2);
    assert.ok(/\[native code\]/.test(shape.toStringCtor), 'FontFace.toString must look native');
    assert.ok(/\[native code\]/.test(shape.toStringLoad), 'FontFace.prototype.load.toString must look native');
    assert.ok(/\[native code\]/.test(shape.toStringStatus), 'status getter toString must look native');
    assert.strictEqual(shape.toStringHasSource, false, 'FontFace methods must not leak wrapper internals');
  });

  check('status agrees with outcome and faces remain own-property clean', () => {
    for (const family of ['Segoe UI', 'Helvetica Neue']) {
      const entry = probe.items[family];
      const expected = entry.outcome === 'resolve' ? 'loaded' : 'error';
      assert.strictEqual(entry.status, expected, `${family} status must be ${expected}, got ${entry.status}`);
      assert.deepStrictEqual(entry.ownProps, [], `${family} face must carry no own properties`);
    }
  });

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`worker-font-presence-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`worker-font-presence-e2e-selftest: FAIL (${failed.length} failed)`);
  }
})();
