#!/usr/bin/env node
'use strict';

/**
 * Real-browser verification for WebGL architecture key normalization.
 *
 * Verifies:
 * 1. Architecture key normalization correctly handles Intel Gen variants ("gen-9", "gen9",
 *    "gen-12lp", "gen12", "gen-11", "gen11", "gen-7", "gen7").
 * 2. Driver limits for "gen-9" and "gen-12lp" correctly map to Gen9 and Gen12 limits (16384).
 * 3. Non-existent architectures maintain a deterministic, stable fallback to conservative limits.
 * 4. Device personas with Intel UHD 620 ("gen-9") produce MAX_TEXTURE_SIZE 16384 (not 8192).
 * 5. Live browser E2E: WebGL and WebGL2 contexts report MAX_TEXTURE_SIZE 16384 under Intel UHD 620.
 * 6. Mutation sensitivity (--mutate): Unnormalized resolution falls back to 8192, confirming test sensitivity.
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
  applyFingerprintToTab,
  webglParameterOverrides,
  normalizeGpuArchitecture,
  WEBGL_PARAM_IDS,
} = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

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
    this.seq += 1;
    const id = this.seq;
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
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: exception.text || String(exception) };
    return message?.result?.result?.value;
  }
}

let _seq = 0;
function seqCount() {
  return ++_seq;
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

const PROBE_CODE = `(() => {
  const c1 = document.createElement('canvas');
  const gl1 = c1.getContext('webgl');
  const c2 = document.createElement('canvas');
  const gl2 = c2.getContext('webgl2');
  const dbg1 = gl1 ? gl1.getExtension('WEBGL_debug_renderer_info') : null;
  const dbg2 = gl2 ? gl2.getExtension('WEBGL_debug_renderer_info') : null;

  return {
    hasGl1: Boolean(gl1),
    hasGl2: Boolean(gl2),
    gl1: gl1 ? {
      renderer: dbg1 ? gl1.getParameter(dbg1.UNMASKED_RENDERER_WEBGL) : null,
      vendor: dbg1 ? gl1.getParameter(dbg1.UNMASKED_VENDOR_WEBGL) : null,
      maxTextureSize: gl1.getParameter(gl1.MAX_TEXTURE_SIZE),
      maxCubeMapSize: gl1.getParameter(gl1.MAX_CUBE_MAP_TEXTURE_SIZE),
      maxRenderbufferSize: gl1.getParameter(gl1.MAX_RENDERBUFFER_SIZE),
      maxVertexUniformVectors: gl1.getParameter(gl1.MAX_VERTEX_UNIFORM_VECTORS),
      maxVaryingVectors: gl1.getParameter(gl1.MAX_VARYING_VECTORS),
      maxViewportDims: Array.from(gl1.getParameter(gl1.MAX_VIEWPORT_DIMS)),
    } : null,
    gl2: gl2 ? {
      renderer: dbg2 ? gl2.getParameter(dbg2.UNMASKED_RENDERER_WEBGL) : null,
      vendor: dbg2 ? gl2.getParameter(dbg2.UNMASKED_VENDOR_WEBGL) : null,
      maxTextureSize: gl2.getParameter(gl2.MAX_TEXTURE_SIZE),
      maxCubeMapSize: gl2.getParameter(gl2.MAX_CUBE_MAP_TEXTURE_SIZE),
      maxRenderbufferSize: gl2.getParameter(gl2.MAX_RENDERBUFFER_SIZE),
      maxVertexUniformVectors: gl2.getParameter(gl2.MAX_VERTEX_UNIFORM_VECTORS),
      maxVaryingVectors: gl2.getParameter(gl2.MAX_VARYING_VECTORS),
      maxViewportDims: Array.from(gl2.getParameter(gl2.MAX_VIEWPORT_DIMS)),
    } : null,
  };
})()`;

async function runLiveBrowser(mutate = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-arch-norm-${mutate ? 'mutate' : 'normal'}-`));
  const profile = {
    id: `arch-norm-${mutate ? 'mutate' : 'normal'}`,
    name: `arch-norm-${mutate ? 'mutate' : 'normal'}`,
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    fingerprint: {
      webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      webglVendor: 'Google Inc. (Intel)',
      gpuVendor: 'intel',
      gpuArchitecture: 'gen-9',
    },
    privacy: {
      webgl: 'noise',
      webgpu: 'webgl',
    },
  };

  const fp = buildFingerprint(profile);

  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const child = spawn(launcher, [dir, '--headless=new', '--ignore-gpu-blocklist', '--enable-webgl'], {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let port = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(200);
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
    ws.onerror = () => reject(new Error('CDP connect failed'));
  });

  const cdp = new Cdp(ws);

  if (mutate) {
    // In mutate mode, construct an injection source with simulated unnormalized limits (falling back to gen7 8192)
    const mutatedLimits = {
      0x0d33: 8192,
      0x851c: 8192,
      0x84e8: 8192,
      0x8dfb: 1024,
      0x8dfc: 32,
      0x0d3a: [8192, 8192],
    };
    const clonedFp = JSON.parse(JSON.stringify(fp));
    const origSource = buildInjectionScript(clonedFp);
    const mutatedSource = origSource.replace(
      /"limits":\{[^}]*\}/,
      `"limits":${JSON.stringify(mutatedLimits)}`
    );
    await cdp.call('Page.enable', {});
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: mutatedSource });
  } else {
    await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, fp, profile);
  }

  await cdp.call('Page.navigate', { url: 'about:blank' });
  await sleep(600);

  const probe = await cdp.value(PROBE_CODE);

  try { ws.close(); } catch (_) {}
  await stopChild(child, dir);

  return { fp, probe };
}

(async () => {
  console.log(`Starting WebGL architecture normalization selftest (mode: ${isMutateMode ? 'MUTATION' : 'NORMAL'})...\n`);

  // Check 1: Normalization function handles Intel Gen architecture keys
  check('normalizeGpuArchitecture canonicalizes Intel Gen architecture keys', () => {
    assert.strictEqual(normalizeGpuArchitecture('intel', 'gen-9'), 'gen9');
    assert.strictEqual(normalizeGpuArchitecture('intel', 'gen9'), 'gen9');
    assert.strictEqual(normalizeGpuArchitecture('intel', 'gen-12lp'), 'gen12');
    assert.strictEqual(normalizeGpuArchitecture('intel', 'gen12lp'), 'gen12');
    assert.strictEqual(normalizeGpuArchitecture('intel', 'gen-12'), 'gen12');
    assert.strictEqual(normalizeGpuArchitecture('intel', 'gen12'), 'gen12');
    assert.strictEqual(normalizeGpuArchitecture('intel', 'gen-11'), 'gen11');
    assert.strictEqual(normalizeGpuArchitecture('intel', 'gen11'), 'gen11');
    assert.strictEqual(normalizeGpuArchitecture('intel', 'gen-7'), 'gen7');
    assert.strictEqual(normalizeGpuArchitecture('intel', 'gen7'), 'gen7');
    assert.strictEqual(normalizeGpuArchitecture('intel', 'alchemist'), 'alchemist');
  });

  // Check 2: Normalization function handles AMD and Apple architecture keys
  check('normalizeGpuArchitecture canonicalizes AMD and Apple architecture keys', () => {
    assert.strictEqual(normalizeGpuArchitecture('amd', 'rdna-3'), 'rdna-3');
    assert.strictEqual(normalizeGpuArchitecture('amd', 'rdna3'), 'rdna-3');
    assert.strictEqual(normalizeGpuArchitecture('amd', 'rdna-2'), 'rdna-2');
    assert.strictEqual(normalizeGpuArchitecture('amd', 'rdna2'), 'rdna-2');
    assert.strictEqual(normalizeGpuArchitecture('amd', 'gcn-4'), 'gcn-4');
    assert.strictEqual(normalizeGpuArchitecture('amd', 'gcn4'), 'gcn-4');
    assert.strictEqual(normalizeGpuArchitecture('apple', 'apple-m1'), 'common-3');
    assert.strictEqual(normalizeGpuArchitecture('apple', 'apple-m2'), 'common-3');
    assert.strictEqual(normalizeGpuArchitecture('apple', 'm3'), 'common-3');
  });

  // Check 3: webglParameterOverrides resolves Intel Gen-9 to 16384 (not 8192)
  check('webglParameterOverrides resolves Intel gen-9 and gen9 to 16384 texture size', () => {
    const limitsHyphen = webglParameterOverrides({ vendor: 'intel', architecture: 'gen-9' });
    const limitsPlain = webglParameterOverrides({ vendor: 'intel', architecture: 'gen9' });

    assert.ok(limitsHyphen, 'gen-9 limits must be defined');
    assert.ok(limitsPlain, 'gen9 limits must be defined');
    assert.strictEqual(limitsHyphen[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 16384, 'gen-9 MAX_TEXTURE_SIZE must be 16384');
    assert.strictEqual(limitsPlain[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 16384, 'gen9 MAX_TEXTURE_SIZE must be 16384');
    assert.strictEqual(limitsHyphen[WEBGL_PARAM_IDS.MAX_RENDERBUFFER_SIZE], 16384);
    assert.strictEqual(limitsHyphen[WEBGL_PARAM_IDS.MAX_CUBE_MAP_TEXTURE_SIZE], 16384);
    assert.strictEqual(limitsHyphen[WEBGL_PARAM_IDS.MAX_VERTEX_UNIFORM_VECTORS], 1024);
    assert.strictEqual(limitsHyphen[WEBGL_PARAM_IDS.MAX_VARYING_VECTORS], 32);
    assert.deepStrictEqual(limitsHyphen, limitsPlain, 'gen-9 and gen9 limits must be identical');
  });

  // Check 4: webglParameterOverrides resolves Intel gen-12lp and gen12 to 16384
  check('webglParameterOverrides resolves Intel gen-12lp and gen12 to 16384 texture size', () => {
    const limitsLp = webglParameterOverrides({ vendor: 'intel', architecture: 'gen-12lp' });
    const limitsPlain = webglParameterOverrides({ vendor: 'intel', architecture: 'gen12' });

    assert.ok(limitsLp, 'gen-12lp limits must be defined');
    assert.ok(limitsPlain, 'gen12 limits must be defined');
    assert.strictEqual(limitsLp[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 16384, 'gen-12lp MAX_TEXTURE_SIZE must be 16384');
    assert.strictEqual(limitsPlain[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 16384, 'gen12 MAX_TEXTURE_SIZE must be 16384');
    assert.deepStrictEqual(limitsLp, limitsPlain, 'gen-12lp and gen12 limits must be identical');
  });

  // Check 5: Non-existent or empty architecture maintains stable conservative fallback
  check('webglParameterOverrides maintains stable fallback for non-existent architecture', () => {
    const fallback = webglParameterOverrides({ vendor: 'intel', architecture: 'unrecognized-future-arch' });
    assert.ok(fallback, 'unknown architecture under known vendor must produce fallback limits');
    assert.strictEqual(fallback[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 8192, 'Intel fallback is gen7 with texture 8192');
    assert.strictEqual(fallback[WEBGL_PARAM_IDS.MAX_VARYING_VECTORS], 32);

    const emptyArch = webglParameterOverrides({ vendor: 'intel', architecture: '' });
    assert.ok(emptyArch, 'empty architecture under known vendor must produce fallback limits');
    assert.strictEqual(emptyArch[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 8192);

    assert.strictEqual(webglParameterOverrides({ vendor: 'unknown-vendor', architecture: 'gen9' }), null);
    assert.strictEqual(webglParameterOverrides(null), null);
    assert.strictEqual(webglParameterOverrides({}), null);
  });

  // Check 6: Device personas with Intel UHD 620 generate 16384 texture limits
  check('buildFingerprint for Intel UHD 620 carries normalized 16384 limits', () => {
    const profile = {
      id: 'test-uhd620-cfg',
      name: 'test-uhd620-cfg',
      kernelVersion: '148.0.7778.165',
      os: 'Windows',
      userAgent: WINDOWS_UA,
      fingerprint: {
        webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        webglVendor: 'Google Inc. (Intel)',
        gpuVendor: 'intel',
        gpuArchitecture: 'gen-9',
      },
      privacy: { webgl: 'noise' },
    };
    const fp = buildFingerprint(profile);
    assert.strictEqual(fp.webgl?.gpu?.architecture, 'gen-9', 'architecture retains configured form');
    const limits = webglParameterOverrides(fp.webgl?.gpu);
    assert.ok(limits, 'limits must be computed');
    assert.strictEqual(limits[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 16384, 'UHD 620 must carry 16384 texture size');
  });

  // Live browser execution
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available');
  } else {
    const live = await runLiveBrowser(isMutateMode);
    assert.ok(!live.error, `Live browser run failed: ${live.error}`);
    const probe = live.probe;
    assert.ok(probe, 'Probe result must be available');
    assert.strictEqual(probe.hasGl1, true, 'WebGL context must exist');

    if (isMutateMode) {
      check('MUTATION CHECK: Unnormalized fallback drops MAX_TEXTURE_SIZE to 8192 in WebGL1', () => {
        assert.strictEqual(probe.gl1.maxTextureSize, 8192,
          `In mutate mode, MAX_TEXTURE_SIZE must be 8192, got ${probe.gl1.maxTextureSize}`);
        assert.deepStrictEqual(probe.gl1.maxViewportDims, [8192, 8192],
          'In mutate mode, MAX_VIEWPORT_DIMS must be [8192, 8192]');
      });

      if (probe.hasGl2) {
        check('MUTATION CHECK: Unnormalized fallback drops MAX_TEXTURE_SIZE to 8192 in WebGL2', () => {
          assert.strictEqual(probe.gl2.maxTextureSize, 8192,
            `In mutate mode, WebGL2 MAX_TEXTURE_SIZE must be 8192, got ${probe.gl2.maxTextureSize}`);
        });
      }
    } else {
      check('Live browser: Intel UHD 620 receives MAX_TEXTURE_SIZE 16384 (not 8192)', () => {
        assert.strictEqual(probe.gl1.maxTextureSize, 16384,
          `WebGL1 MAX_TEXTURE_SIZE must be 16384 (not 8192), got ${probe.gl1.maxTextureSize}`);
        assert.strictEqual(probe.gl1.maxCubeMapSize, 16384,
          `WebGL1 MAX_CUBE_MAP_TEXTURE_SIZE must be 16384, got ${probe.gl1.maxCubeMapSize}`);
        assert.strictEqual(probe.gl1.maxRenderbufferSize, 16384,
          `WebGL1 MAX_RENDERBUFFER_SIZE must be 16384, got ${probe.gl1.maxRenderbufferSize}`);
        assert.deepStrictEqual(probe.gl1.maxViewportDims, [16384, 16384],
          `WebGL1 MAX_VIEWPORT_DIMS must be [16384, 16384], got ${JSON.stringify(probe.gl1.maxViewportDims)}`);
      });

      if (probe.hasGl2) {
        check('Live browser: WebGL2 context consistently receives MAX_TEXTURE_SIZE 16384', () => {
          assert.strictEqual(probe.gl2.maxTextureSize, 16384,
            `WebGL2 MAX_TEXTURE_SIZE must be 16384, got ${probe.gl2.maxTextureSize}`);
          assert.strictEqual(probe.gl2.maxCubeMapSize, 16384);
          assert.strictEqual(probe.gl2.maxRenderbufferSize, 16384);
          assert.deepStrictEqual(probe.gl2.maxViewportDims, [16384, 16384]);
        });
      }

      check('Live browser: UNMASKED_RENDERER_WEBGL reflects Intel UHD 620 identity', () => {
        assert.ok(probe.gl1.renderer.includes('Intel(R) UHD Graphics 620'),
          `Renderer must include UHD Graphics 620, got ${probe.gl1.renderer}`);
        assert.strictEqual(probe.gl1.vendor, 'Google Inc. (Intel)');
      });
    }
  }

  const failed = results.filter((item) => !item.ok);
  console.log('');
  if (!failed.length) {
    console.log(`webgl-architecture-normalization-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`webgl-architecture-normalization-e2e-selftest: FAILED (${failed.length} failed)`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('webgl-architecture-normalization-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
