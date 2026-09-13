#!/usr/bin/env node
'use strict';

/**
 * End-to-end selftest for WebGPU fingerprint parity inside DedicatedWorkerGlobalScope.
 *
 * Verifies that worker-side WebGPU APIs:
 *  1. Return adapters and adapter info matching the main document's configured persona.
 *  2. In 'blocked' mode, resolve requestAdapter() to null in both window and worker.
 *  3. In 'real' mode, leave native GPU hardware and descriptors untouched.
 *  4. Maintain strict WebIDL brand checks, prototypes, and native toString representation.
 *  5. Correctly reject or throw TypeError on illegal receivers.
 *
 * Covers 4 persona configurations:
 *  - Windows Intel UHD 620 (gen9 D3D11)
 *  - macOS Apple M3 (common-3 Metal)
 *  - Blocked mode (privacy.webgpu = 'blocked')
 *  - Real mode (privacy.webgpu = 'real')
 *
 * Supports --mutate to verify test sensitivity: without worker injection, host AMD/Apple
 * GPU hardware leaks and blocked mode returns a live adapter.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildWorkerInjectionScript, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const MACOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
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
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');

    if (request.url === '/worker.js') {
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      response.end(`
        self.onmessage = async (e) => {
          const probe = {
            hasGpuApi: typeof navigator !== 'undefined' && Boolean(navigator.gpu),
            adapter: null,
            info: null,
            shape: {},
            illegal: {},
          };

          if (!probe.hasGpuApi) {
            self.postMessage(probe);
            return;
          }

          // Test illegal receiver on GPU.prototype.requestAdapter
          try {
            await GPU.prototype.requestAdapter.call({});
            probe.illegal.requestAdapter = 'did-not-throw';
          } catch (err) {
            probe.illegal.requestAdapter = err.name;
          }

          let adapter = null;
          try {
            adapter = await navigator.gpu.requestAdapter();
          } catch (err) {
            probe.requestAdapterError = err.message;
          }

          if (adapter) {
            probe.adapter = {
              isGPUAdapterInstance: adapter instanceof GPUAdapter,
              toStringTag: Object.prototype.toString.call(adapter),
            };

            const info = adapter.info;
            if (info) {
              probe.info = {
                vendor: info.vendor,
                architecture: info.architecture,
                device: info.device,
                description: info.description,
                isGPUAdapterInfoInstance: typeof GPUAdapterInfo !== 'undefined' && (info instanceof GPUAdapterInfo),
                toStringTag: Object.prototype.toString.call(info),
              };
            }

            // Test illegal receiver on GPUAdapter.prototype.info
            try {
              const infoDesc = Object.getOwnPropertyDescriptor(GPUAdapter.prototype, 'info');
              if (infoDesc && typeof infoDesc.get === 'function') {
                infoDesc.get.call({});
                probe.illegal.adapterInfo = 'did-not-throw';
              }
            } catch (err) {
              probe.illegal.adapterInfo = err.name;
            }

            // Test illegal receiver on GPUAdapterInfo.prototype.vendor
            try {
              if (typeof GPUAdapterInfo !== 'undefined') {
                const vendorDesc = Object.getOwnPropertyDescriptor(GPUAdapterInfo.prototype, 'vendor');
                if (vendorDesc && typeof vendorDesc.get === 'function') {
                  vendorDesc.get.call({});
                  probe.illegal.infoVendor = 'did-not-throw';
                }
              }
            } catch (err) {
              probe.illegal.infoVendor = err.name;
            }
          }

          // Prototype / Function representation
          try {
            probe.shape.requestAdapterToString = Function.prototype.toString.call(navigator.gpu.requestAdapter);
            if (typeof GPUAdapter !== 'undefined') {
              const infoDesc = Object.getOwnPropertyDescriptor(GPUAdapter.prototype, 'info');
              if (infoDesc && infoDesc.get) {
                probe.shape.adapterInfoToString = Function.prototype.toString.call(infoDesc.get);
              }
            }
            if (typeof GPUAdapterInfo !== 'undefined') {
              const vendorDesc = Object.getOwnPropertyDescriptor(GPUAdapterInfo.prototype, 'vendor');
              if (vendorDesc && vendorDesc.get) {
                probe.shape.infoVendorToString = Function.prototype.toString.call(vendorDesc.get);
              }
            }
          } catch (_) {}

          self.postMessage(probe);
        };
      `);
      return;
    }

    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!DOCTYPE html>
<html>
<head><title>WebGPU Worker Test</title></head>
<body>
  <script>
    window.__createWorker = () => {
      window.__worker = new Worker('/worker.js');
      window.__workerPromise = new Promise((resolve) => {
        window.__worker.onmessage = (e) => resolve(e.data);
      });
    };

    window.__runAudit = async () => {
      const winProbe = {
        hasGpuApi: typeof navigator !== 'undefined' && Boolean(navigator.gpu),
        adapter: null,
        info: null,
        illegal: {},
      };

      if (winProbe.hasGpuApi) {
        try {
          await GPU.prototype.requestAdapter.call({});
          winProbe.illegal.requestAdapter = 'did-not-throw';
        } catch (err) {
          winProbe.illegal.requestAdapter = err.name;
        }

        let adapter = null;
        try {
          adapter = await navigator.gpu.requestAdapter();
        } catch (_) {}

        if (adapter) {
          winProbe.adapter = {
            isGPUAdapterInstance: adapter instanceof GPUAdapter,
          };
          if (adapter.info) {
            winProbe.info = {
              vendor: adapter.info.vendor,
              architecture: adapter.info.architecture,
              device: adapter.info.device,
              description: adapter.info.description,
            };
          }
        }
      }

      window.__worker.postMessage('start');
      const workerProbe = await window.__workerPromise;

      return { window: winProbe, worker: workerProbe };
    };
  </script>
</body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function runSession(profileConfig, serverPort, mutate = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-webgpu-worker-${profileConfig.id}-`));
  const fp = buildFingerprint(profileConfig);

  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile: profileConfig,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const launchArgs = [
    dir,
    '--headless=new',
    '--enable-unsafe-webgpu',
  ];

  const child = spawn(launcher, launchArgs, {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let devToolsPort = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(200);
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
    return { error: 'DevToolsActivePort not acquired' };
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
    if (!pageTarget) throw new Error('No page target found');

    const attachRes = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const pageSession = attachRes?.result?.sessionId;
    if (!pageSession) throw new Error('Failed to attach to page target');

    await cdp.send('Page.enable', {}, pageSession);

    const mainScript = mutate
      ? 'window.__mutated = true;'
      : buildInjectionScript(fp);

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mainScript }, pageSession);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` }, pageSession);
    await sleep(500);

    // Enable nested auto-attach on page session so workers start paused
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, pageSession);

    // Filter old events before triggering worker creation
    cdp.events = cdp.events.filter((ev) => ev.method !== 'Target.attachedToTarget');

    // Trigger DedicatedWorker creation in page
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
      ? 'self.__workerMutated = true;'
      : buildWorkerInjectionScript(fp);

    // Inject script into worker before unpausing
    await cdp.send('Runtime.evaluate', { expression: workerSource }, workerSession);
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, workerSession);

    // Trigger probe execution and retrieve result
    const probeRes = await cdp.send('Runtime.evaluate', {
      expression: 'window.__runAudit()',
      awaitPromise: true,
      returnByValue: true,
    }, pageSession);

    return {
      fp,
      result: probeRes?.result?.result?.value,
    };
  } finally {
    if (ws) try { ws.close(); } catch (_) {}
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  console.log(`Starting DedicatedWorker WebGPU Fingerprint E2E Selftest (mode: ${isMutateMode ? 'MUTATION' : 'NORMAL'})...\n`);

  const { server, port } = await startServer();

  try {
    if (!isMutateMode) {
      // 1. Windows Intel Persona (Intel UHD 620, gen9)
      console.log('--- Mode 1: Windows Intel Persona (Intel UHD 620, gen9) ---');
      const winProf = {
        id: 'webgpu-win-intel',
        name: 'webgpu-win-intel',
        language: 'en-US',
        userAgent: WINDOWS_UA,
        kernelVersion: '148.0.7778.165',
        os: 'windows',
        fingerprint: {
          webglVendor: 'Google Inc. (Intel)',
          webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
          webgpu: {
            vendor: 'intel',
            architecture: 'gen9',
            device: '',
            description: 'Intel(R) UHD Graphics 620',
          },
        },
        privacy: {
          webgpu: 'webgl',
        },
      };
      const winAudit = await runSession(winProf, port, false);
      const winData = winAudit.result;
      assert.ok(winData && winData.window && winData.worker, 'Windows session must produce probe data');

      check('Windows Intel: worker navigator.gpu is exposed and non-null', () => {
        assert.strictEqual(winData.worker.hasGpuApi, true, 'Worker must have navigator.gpu');
        assert.ok(winData.worker.adapter, 'Worker requestAdapter must return an adapter');
      });

      check('Windows Intel: worker adapter.info vendor & architecture match window persona (intel, gen9)', () => {
        assert.strictEqual(winData.worker.info?.vendor, 'intel', 'Worker vendor must be intel');
        assert.strictEqual(winData.worker.info?.architecture, 'gen9', 'Worker architecture must be gen9');
        assert.strictEqual(winData.window.info?.vendor, 'intel', 'Window vendor must be intel');
        assert.strictEqual(winData.window.info?.architecture, 'gen9', 'Window architecture must be gen9');
      });

      check('Windows Intel: worker adapter and info instance prototypes are intact', () => {
        assert.strictEqual(winData.worker.adapter?.isGPUAdapterInstance, true, 'Must be instance of GPUAdapter');
        assert.strictEqual(winData.worker.info?.isGPUAdapterInfoInstance, true, 'Must be instance of GPUAdapterInfo');
        assert.strictEqual(winData.worker.adapter?.toStringTag, '[object GPUAdapter]');
        assert.strictEqual(winData.worker.info?.toStringTag, '[object GPUAdapterInfo]');
      });

      check('Windows Intel: native toString representation preserved on worker methods and getters', () => {
        assert.ok(winData.worker.shape?.requestAdapterToString?.includes('[native code]'), 'requestAdapter must stringify as native code');
        assert.ok(winData.worker.shape?.adapterInfoToString?.includes('[native code]'), 'adapter.info getter must stringify as native code');
        assert.ok(winData.worker.shape?.infoVendorToString?.includes('[native code]'), 'info.vendor getter must stringify as native code');
      });

      check('Windows Intel: illegal invocation brand checks throw TypeError', () => {
        assert.strictEqual(winData.worker.illegal?.requestAdapter, 'TypeError', 'requestAdapter on non-GPU must throw TypeError');
        assert.strictEqual(winData.worker.illegal?.adapterInfo, 'TypeError', 'adapter.info on non-GPUAdapter must throw TypeError');
        assert.strictEqual(winData.worker.illegal?.infoVendor, 'TypeError', 'info.vendor on non-GPUAdapterInfo must throw TypeError');
      });

      // 2. macOS Apple Persona (Apple M3, common-3)
      console.log('--- Mode 2: macOS Apple Persona (Apple M3, common-3) ---');
      const macProf = {
        id: 'webgpu-mac-apple',
        name: 'webgpu-mac-apple',
        language: 'en-US',
        userAgent: MACOS_UA,
        kernelVersion: '148.0.7778.165',
        os: 'macos',
        fingerprint: {
          webglVendor: 'Google Inc. (Apple)',
          webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Metal)',
          webgpu: {
            vendor: 'apple',
            architecture: 'common-3',
            device: '',
            description: 'Apple M3',
          },
        },
        privacy: {
          webgpu: 'webgl',
        },
      };
      const macAudit = await runSession(macProf, port, false);
      const macData = macAudit.result;
      assert.ok(macData && macData.window && macData.worker, 'macOS session must produce probe data');

      check('macOS Apple: worker adapter.info vendor & architecture match window persona (apple, common-3)', () => {
        assert.strictEqual(macData.worker.info?.vendor, 'apple', 'Worker vendor must be apple');
        assert.strictEqual(macData.worker.info?.architecture, 'common-3', 'Worker architecture must be common-3');
        assert.strictEqual(macData.window.info?.vendor, 'apple', 'Window vendor must be apple');
        assert.strictEqual(macData.window.info?.architecture, 'common-3', 'Window architecture must be common-3');
      });

      // 3. Blocked Mode (privacy.webgpu = 'blocked')
      console.log('--- Mode 3: Blocked Mode (privacy.webgpu = blocked) ---');
      const blockedProf = {
        id: 'webgpu-blocked',
        name: 'webgpu-blocked',
        language: 'en-US',
        userAgent: WINDOWS_UA,
        os: 'windows',
        privacy: {
          webgpu: 'blocked',
        },
      };
      const blockedAudit = await runSession(blockedProf, port, false);
      const blockedData = blockedAudit.result;
      assert.ok(blockedData && blockedData.window && blockedData.worker, 'Blocked session must produce probe data');

      check('Blocked Mode: requestAdapter resolves to null in both window and worker', () => {
        assert.strictEqual(blockedData.window.hasGpuApi, true, 'Window has navigator.gpu');
        assert.strictEqual(blockedData.window.adapter, null, 'Window adapter must be null in blocked mode');
        assert.strictEqual(blockedData.worker.hasGpuApi, true, 'Worker has navigator.gpu');
        assert.strictEqual(blockedData.worker.adapter, null, 'Worker adapter must be null in blocked mode');
      });

      check('Blocked Mode: illegal receiver on requestAdapter still throws TypeError', () => {
        assert.strictEqual(blockedData.worker.illegal?.requestAdapter, 'TypeError', 'Blocked mode must preserve illegal invocation check');
      });

      // 4. Real Mode (privacy.webgpu = 'real')
      console.log('--- Mode 4: Real Mode (privacy.webgpu = real) ---');
      const realProf = {
        id: 'webgpu-real',
        name: 'webgpu-real',
        language: 'en-US',
        userAgent: WINDOWS_UA,
        os: 'windows',
        privacy: {
          webgpu: 'real',
        },
      };
      const realAudit = await runSession(realProf, port, false);
      const realData = realAudit.result;
      assert.ok(realData && realData.window && realData.worker, 'Real session must produce probe data');

      check('Real Mode: worker adapter matches window native hardware without modification', () => {
        assert.strictEqual(realData.worker.hasGpuApi, true, 'Worker has navigator.gpu');
        assert.ok(realData.worker.adapter, 'Worker must have adapter in real mode');
        assert.strictEqual(realData.worker.info?.vendor, realData.window.info?.vendor, 'Worker vendor must match window native vendor');
        assert.strictEqual(realData.worker.info?.architecture, realData.window.info?.architecture, 'Worker architecture must match window native architecture');
      });

    } else {
      console.log('--- Mutation Mode: Verifying Detection Sensitivity ---');
      const winProf = {
        id: 'webgpu-win-mutate',
        name: 'webgpu-win-mutate',
        language: 'en-US',
        userAgent: WINDOWS_UA,
        os: 'windows',
        fingerprint: {
          webglVendor: 'Google Inc. (Intel)',
          webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
          webgpu: {
            vendor: 'intel',
            architecture: 'gen9',
          },
        },
        privacy: {
          webgpu: 'webgl',
        },
      };
      const mutAudit = await runSession(winProf, port, true);
      const mutData = mutAudit.result;
      assert.ok(mutData && mutData.worker, 'Mutated session must produce worker probe data');

      check('MUTATION CHECK: Disabling worker injection causes worker to leak host AMD/Apple hardware', () => {
        assert.ok(mutData.worker.adapter, 'Mutated worker has adapter');
        assert.notStrictEqual(mutData.worker.info?.vendor, 'intel', 'Unshielded worker must NOT report intel persona');
        assert.strictEqual(mutData.worker.info?.vendor, 'amd', 'Unshielded worker on macOS metal leaks host AMD GPU');
      });

      const blockedProf = {
        id: 'webgpu-blocked-mutate',
        name: 'webgpu-blocked-mutate',
        language: 'en-US',
        userAgent: WINDOWS_UA,
        os: 'windows',
        privacy: {
          webgpu: 'blocked',
        },
      };
      const mutBlockedAudit = await runSession(blockedProf, port, true);
      const mutBlockedData = mutBlockedAudit.result;
      assert.ok(mutBlockedData && mutBlockedData.worker, 'Mutated blocked session must produce worker probe data');

      check('MUTATION CHECK: Disabling worker injection causes blocked mode to leak non-null adapter', () => {
        assert.ok(mutBlockedData.worker.adapter, 'Unshielded worker in blocked mode leaks live adapter instead of returning null');
      });
    }
  } finally {
    server.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  if (passed !== total) {
    console.log(`\nworker-webgpu-fingerprint-e2e-selftest: FAILED ${passed}/${total}`);
    process.exitCode = 1;
  } else {
    console.log(`\nworker-webgpu-fingerprint-e2e-selftest: OK ${passed}/${total}`);
  }
})().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
