#!/usr/bin/env node
'use strict';

/**
 * End-to-end capability profile & WebGL execution compatibility selftest.
 *
 * Verifies that WebGL personas and declared driver limits physically match
 * the underlying graphics driver's executable allocation and rasterization capacity.
 *
 * Specifically verifies:
 * 1. Host capability gating: incompatible 32K personas (e.g. desktop NVIDIA Ampere/Ada)
 *    are excluded from selection on 16K hosts (e.g. macOS Metal).
 * 2. Limit reconciliation: when an NVIDIA persona is applied on a 16K host,
 *    its declared MAX_TEXTURE_SIZE is reconciled to the host's actual allocation
 *    ceiling (16384), completely preventing the texImage2D INVALID_VALUE failure.
 * 3. Real browser E2E: gl.getParameter(MAX_TEXTURE_SIZE) allocates successfully
 *    via gl.texImage2D, and exceeding that size is rejected by the driver.
 * 4. ALIASED_POINT_SIZE_RANGE matches actual point rasterization boundaries.
 * 5. Mutation sensitivity (--mutate) captures unreconciled allocation failures.
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
  HOST_WEBGL_LIMITS,
  getHostWebglLimits,
  isPersonaWebglCompatible,
  compatiblePersonasForOs,
  resolveCompatiblePersona,
} = require('./fingerprint');
const { personasForOs, pickPersona } = require('./device-personas');
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

const checkKnownGap = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true, gap: true });
    console.log(`  KNOWN GAP (CONFIRMED)  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, gap: true });
    console.log(`  FAIL (GAP BROKEN)  ${name} - ${error.message}`);
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
    response.end('<!doctype html><title>webgl-capability-compatibility</title><main>audit</main>');
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
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = (list || []).find((item) => item.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page;
    } catch (_) {}
    await sleep(200);
  }
  return null;
}

function buildProbe() {
  return `(async () => {
  const inspect = (gl) => {
    if (!gl) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
    const maxCube = gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE) || 0;
    const maxRender = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 0;
    const vpDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    const pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);

    // Physical texture allocation test at declared MAX_TEXTURE_SIZE
    let canAllocateMaxTex = false;
    let texAllocError = 0;
    try {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, maxTex, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      texAllocError = gl.getError();
      canAllocateMaxTex = (texAllocError === 0);
      gl.deleteTexture(tex);
    } catch (e) {
      canAllocateMaxTex = false;
      texAllocError = -1;
    }

    // Exceeding allocation capacity test (must be rejected by driver)
    let beyondMaxTexFailed = false;
    let beyondTexError = 0;
    try {
      const texBeyond = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texBeyond);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, maxTex + 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      beyondTexError = gl.getError();
      beyondMaxTexFailed = (beyondTexError !== 0);
      gl.deleteTexture(texBeyond);
    } catch (e) {
      beyondMaxTexFailed = true;
    }

    // Point size rasterization test
    let pointSizeRasterized = false;
    try {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, "attribute vec4 a_p; uniform float u_s; void main(){gl_Position=a_p; gl_PointSize=u_s;}");
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, "precision mediump float; void main(){gl_FragColor=vec4(1.0,0.0,0.0,1.0);}");
      gl.compileShader(fs);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        gl.useProgram(prog);
        const uS = gl.getUniformLocation(prog, "u_s");
        gl.uniform1f(uS, Math.min(511, pointRange ? pointRange[1] : 511));
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, 1);
        pointSizeRasterized = (gl.getError() === 0);
      }
    } catch (_) {
      pointSizeRasterized = false;
    }

    return {
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      maxTextureSize: maxTex,
      maxCubeMapTextureSize: maxCube,
      maxRenderbufferSize: maxRender,
      maxViewportDims: vpDims ? Array.from(vpDims) : null,
      aliasedPointSizeRange: pointRange ? Array.from(pointRange) : null,
      execution: {
        canAllocateMaxTex,
        texAllocError,
        beyondMaxTexFailed,
        beyondTexError,
        pointSizeRasterized,
      },
    };
  };

  const c1 = document.createElement('canvas');
  const gl1 = c1.getContext('webgl') || c1.getContext('experimental-webgl');
  const c2 = document.createElement('canvas');
  const gl2 = c2.getContext('webgl2');

  return JSON.stringify({
    webgl1: inspect(gl1),
    webgl2: inspect(gl2),
  });
})()`;
}

const PROBE = buildProbe();

async function runSession({ label, profile, serverPort, forceUnreconciled32k = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-glcompat-${label}-`));
  let fp = null;
  if (profile) {
    fp = buildFingerprint(profile);
    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile,
      templatePath: path.join(kernelRoot, 'init_template.json'),
    });
  }

  const child = spawn(launcher, [dir, '--headless=new', '--enable-unsafe-swiftshader'], {
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
    return { error: 'no devtools port', label };
  }

  const page = await waitForPage(port);
  if (!page?.webSocketDebuggerUrl) {
    await stopChild(child, dir);
    return { error: 'no page target', label };
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP WebSocket connect failed'));
  });
  const cdp = new Cdp(ws);

  if (profile && fp) {
    await applyFingerprintToTab(cdp.call.bind(cdp), page.webSocketDebuggerUrl, fp, profile);
  }

  // If testing mutation mode with unreconciled 32K on Metal host
  if (forceUnreconciled32k) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const force32k = (proto) => {
          if (!proto || !proto.getParameter) return;
          const orig = proto.getParameter;
          proto.getParameter = function(param) {
            if (param === 0x0d33 || param === 0x851c || param === 0x84e8) return 32768;
            if (param === 0x0d3a) {
              const out = new Int32Array(2);
              out[0] = 32768; out[1] = 32768;
              return out;
            }
            return orig.apply(this, arguments);
          };
        };
        force32k(globalThis.WebGLRenderingContext?.prototype);
        force32k(globalThis.WebGL2RenderingContext?.prototype);
      })();`,
    });
  }

  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
  await sleep(600);
  const probe = await cdp.value(PROBE);
  try { ws.close(); } catch (_) {}
  await stopChild(child, dir);

  return {
    label,
    profile,
    fp,
    probe,
    limits: fp?.webgl?.gpu ? webglParameterOverrides(fp.webgl.gpu) : null,
  };
}

(async () => {
  console.log('--- OpenBrowser WebGL Capability & Compatibility Audit ---');

  // --- Phase 1: Pure unit & capability gating checks ---
  check('HOST_WEBGL_LIMITS defines accurate envelopes for macos, linux, and windows', () => {
    const mac = getHostWebglLimits('darwin');
    assert.strictEqual(mac.maxTextureSize, 16384, 'darwin maxTextureSize is 16384');
    assert.strictEqual(mac.maxRenderbufferSize, 16384, 'darwin maxRenderbufferSize is 16384');
    assert.deepStrictEqual(mac.maxViewportDims, [16384, 16384]);
    assert.strictEqual(mac.aliasedPointSizeRange[1], 511, 'darwin Metal point size upper bound is 511');

    const win = getHostWebglLimits('win32');
    assert.strictEqual(win.maxTextureSize, 32768, 'windows maxTextureSize is 32768');
    assert.strictEqual(win.maxRenderbufferSize, 32768);

    const lin = getHostWebglLimits('linux');
    assert.strictEqual(lin.maxTextureSize, 16384);
  });

  check('isPersonaWebglCompatible correctly identifies 16K vs 32K GPU compatibility on macOS', () => {
    assert.strictEqual(isPersonaWebglCompatible({ webgl: { gpu: { vendor: 'intel', architecture: 'gen9' } } }, 'darwin'), true);
    assert.strictEqual(isPersonaWebglCompatible({ webgl: { gpu: { vendor: 'intel', architecture: 'gen12' } } }, 'darwin'), true);
    assert.strictEqual(isPersonaWebglCompatible({ webgl: { gpu: { vendor: 'amd', architecture: 'rdna-2' } } }, 'darwin'), true);
    assert.strictEqual(isPersonaWebglCompatible({ webgl: { gpu: { vendor: 'apple', architecture: 'common-3' } } }, 'darwin'), true);
    assert.strictEqual(isPersonaWebglCompatible({ webgl: { gpu: { vendor: 'nvidia', architecture: 'ampere' } } }, 'darwin'), false);
    assert.strictEqual(isPersonaWebglCompatible({ webgl: { gpu: { vendor: 'nvidia', architecture: 'ada' } } }, 'darwin'), false);

    // On Windows, all personas are compatible
    assert.strictEqual(isPersonaWebglCompatible({ webgl: { gpu: { vendor: 'nvidia', architecture: 'ampere' } } }, 'win32'), true);
  });

  check('compatiblePersonasForOs filters Windows pool down to 4 16K personas on darwin', () => {
    const darwinPool = compatiblePersonasForOs('windows', 'darwin');
    assert.strictEqual(darwinPool.length, 4);
    for (const p of darwinPool) {
      assert.notStrictEqual(p.webgl.gpu.vendor, 'nvidia');
    }

    const winPool = compatiblePersonasForOs('windows', 'win32');
    assert.strictEqual(winPool.length, 6);
  });

  check('resolveCompatiblePersona deterministically substitutes incompatible persona', () => {
    const nvPersona = { os: 'windows', webgl: { gpu: { vendor: 'nvidia', architecture: 'ampere' } } };
    const resolved = resolveCompatiblePersona(nvPersona, 'darwin');
    assert.strictEqual(resolved.webgl.gpu.vendor !== 'nvidia', true);
    assert.strictEqual(isPersonaWebglCompatible(resolved, 'darwin'), true);
  });

  check('webglParameterOverrides supports both raw and host-reconciled limits', () => {
    const rawNv = webglParameterOverrides({ vendor: 'nvidia', architecture: 'ampere' }, { reconcileHost: false });
    assert.strictEqual(rawNv[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 32768, 'raw mapping is 32768');

    const reconciledNv = webglParameterOverrides({ vendor: 'nvidia', architecture: 'ampere' }, { reconcileHost: true, hostPlatform: 'darwin' });
    assert.strictEqual(reconciledNv[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 16384, 'darwin-reconciled is 16384');
    assert.strictEqual(reconciledNv[WEBGL_PARAM_IDS.MAX_RENDERBUFFER_SIZE], 16384);

    const winReconciled = webglParameterOverrides({ vendor: 'nvidia', architecture: 'ampere' }, { reconcileHost: true, hostPlatform: 'win32' });
    assert.strictEqual(winReconciled[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 32768, 'windows-reconciled is 32768');
  });

  // --- Phase 2: Live Browser Kernel CDP Execution ---
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`webgl-capability-compatibility-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const { server, port: serverPort } = await startServer();
  let intelRun, amdRun, nvidiaReconciledRun, mutateUnreconciledRun;

  try {
    console.log('Executing live browser WebGL capability probes...');

    // 1. Windows Intel UHD 620 Persona
    const intelProfile = {
      id: 'compat-intel',
      name: 'compat-intel',
      kernelVersion: '148.0.7778.165',
      os: 'Windows',
      userAgent: WINDOWS_UA,
      privacy: {
        deviceProfile: 'persona',
        webgl: 'noise',
        fingerprint: {
          webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
          webglVendor: 'Google Inc. (Intel)',
        },
      },
    };
    intelRun = await runSession({ label: 'intel', profile: intelProfile, serverPort });

    // 2. Windows AMD Radeon RX 6600 Persona
    const amdProfile = {
      id: 'compat-amd',
      name: 'compat-amd',
      kernelVersion: '148.0.7778.165',
      os: 'Windows',
      userAgent: WINDOWS_UA,
      privacy: {
        deviceProfile: 'persona',
        webgl: 'noise',
        fingerprint: {
          webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
          webglVendor: 'Google Inc. (AMD)',
        },
      },
    };
    amdRun = await runSession({ label: 'amd', profile: amdProfile, serverPort });

    // 3. Windows NVIDIA RTX 3060 Persona (under default host capability reconciliation on macOS Metal)
    const nvidiaProfile = {
      id: 'compat-nvidia',
      name: 'compat-nvidia',
      kernelVersion: '148.0.7778.165',
      os: 'Windows',
      userAgent: WINDOWS_UA,
      privacy: {
        deviceProfile: 'persona',
        webgl: 'noise',
        fingerprint: {
          webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
          webglVendor: 'Google Inc. (NVIDIA)',
        },
      },
    };
    nvidiaReconciledRun = await runSession({ label: 'nvidia-reconciled', profile: nvidiaProfile, serverPort });

    // 4. Mutate run if requested: unreconciled 32K forced on Metal
    if (isMutateMode) {
      console.log('Running mutation sensitivity session with unreconciled 32K limit...');
      mutateUnreconciledRun = await runSession({
        label: 'mutate-unreconciled',
        profile: nvidiaProfile,
        serverPort,
        forceUnreconciled32k: true,
      });
    }
  } finally {
    server.close();
  }

  const intP = intelRun.probe;
  const amdP = amdRun.probe;
  const nvP = nvidiaReconciledRun.probe;

  console.log('\n============================= WebGL Compatibility Summary =============================');
  console.log('Profile               | MAX_TEXTURE_SIZE | texImage2D(max) | texImage2D(max+1) | Point Size (511)');
  console.log('----------------------+------------------+-----------------+-------------------+-----------------');
  console.log(`Intel UHD 620         | ${String(intP.webgl1.maxTextureSize).padEnd(16)} | ${(intP.webgl1.execution.canAllocateMaxTex ? 'PASS (0)' : 'FAIL').padEnd(15)} | ${(intP.webgl1.execution.beyondMaxTexFailed ? 'PASS (reject)' : 'FAIL').padEnd(17)} | ${(intP.webgl1.execution.pointSizeRasterized ? 'PASS' : 'FAIL')}`);
  console.log(`AMD Radeon RX 6600    | ${String(amdP.webgl1.maxTextureSize).padEnd(16)} | ${(amdP.webgl1.execution.canAllocateMaxTex ? 'PASS (0)' : 'FAIL').padEnd(15)} | ${(amdP.webgl1.execution.beyondMaxTexFailed ? 'PASS (reject)' : 'FAIL').padEnd(17)} | ${(amdP.webgl1.execution.pointSizeRasterized ? 'PASS' : 'FAIL')}`);
  console.log(`NVIDIA RTX 3060 (rec) | ${String(nvP.webgl1.maxTextureSize).padEnd(16)} | ${(nvP.webgl1.execution.canAllocateMaxTex ? 'PASS (0)' : 'FAIL').padEnd(15)} | ${(nvP.webgl1.execution.beyondMaxTexFailed ? 'PASS (reject)' : 'FAIL').padEnd(17)} | ${(nvP.webgl1.execution.pointSizeRasterized ? 'PASS' : 'FAIL')}`);
  console.log('========================================================================================\n');

  check('Live Intel UHD 620: declared limits match physical driver allocation without error', () => {
    assert.strictEqual(intP.webgl1.maxTextureSize, 16384);
    assert.strictEqual(intP.webgl1.execution.canAllocateMaxTex, true);
    assert.strictEqual(intP.webgl1.execution.texAllocError, 0);
    assert.strictEqual(intP.webgl1.execution.beyondMaxTexFailed, true);
    assert.strictEqual(intP.webgl2.execution.canAllocateMaxTex, true);
  });

  check('Live AMD Radeon RX 6600: declared limits match physical driver allocation without error', () => {
    assert.strictEqual(amdP.webgl1.maxTextureSize, 16384);
    assert.strictEqual(amdP.webgl1.execution.canAllocateMaxTex, true);
    assert.strictEqual(amdP.webgl1.execution.texAllocError, 0);
    assert.strictEqual(amdP.webgl1.execution.beyondMaxTexFailed, true);
    assert.strictEqual(amdP.webgl2.execution.canAllocateMaxTex, true);
  });

  check('Live NVIDIA RTX 3060: reconciled limits match physical Metal allocation ceiling without INVALID_VALUE', () => {
    assert.strictEqual(nvP.webgl1.maxTextureSize, 16384, 'reconciled to 16384 on Metal host');
    assert.strictEqual(nvP.webgl1.maxCubeMapTextureSize, 16384);
    assert.strictEqual(nvP.webgl1.maxRenderbufferSize, 16384);
    assert.deepStrictEqual(nvP.webgl1.maxViewportDims, [16384, 16384]);
    assert.strictEqual(nvP.webgl1.execution.canAllocateMaxTex, true, 'texImage2D(16384) must succeed with NO_ERROR');
    assert.strictEqual(nvP.webgl1.execution.texAllocError, 0);
    assert.strictEqual(nvP.webgl1.execution.beyondMaxTexFailed, true, 'texImage2D(16385) must fail with INVALID_VALUE');
    assert.strictEqual(nvP.webgl2.execution.canAllocateMaxTex, true);
  });

  checkKnownGap('Secondary hardware limits: ALIASED_POINT_SIZE_RANGE reflects host Metal ceiling [1, 511]', () => {
    assert.deepStrictEqual(intP.webgl1.aliasedPointSizeRange, [1, 511]);
    assert.deepStrictEqual(amdP.webgl1.aliasedPointSizeRange, [1, 511]);
    assert.deepStrictEqual(nvP.webgl1.aliasedPointSizeRange, [1, 511]);

    assert.strictEqual(intP.webgl1.execution.pointSizeRasterized, true);
    assert.strictEqual(amdP.webgl1.execution.pointSizeRasterized, true);
    assert.strictEqual(nvP.webgl1.execution.pointSizeRasterized, true);
  });

  // --- Phase 3: Mutation Sensitivity Testing ---
  if (isMutateMode && mutateUnreconciledRun) {
    check('MUTATION CHECK: Unreconciled 32K texture limit triggers texImage2D driver allocation failure (INVALID_VALUE 1281)', () => {
      const mutP = mutateUnreconciledRun.probe;
      assert.strictEqual(mutP.webgl1.maxTextureSize, 32768, 'mutated session must claim 32768');
      assert.strictEqual(mutP.webgl1.execution.canAllocateMaxTex, false, 'texImage2D(32768) must fail on Metal driver');
      assert.strictEqual(mutP.webgl1.execution.texAllocError, 1281, 'driver must return INVALID_VALUE (1281)');
    });

    check('MUTATION CHECK: Contradiction between declared limit and actual allocation is strictly caught', () => {
      let contractFailed = false;
      try {
        const mutP = mutateUnreconciledRun.probe;
        assert.strictEqual(mutP.webgl1.execution.canAllocateMaxTex, true);
        assert.strictEqual(mutP.webgl1.execution.texAllocError, 0);
      } catch (_) {
        contractFailed = true;
      }
      assert.strictEqual(contractFailed, true, 'mutation check must catch discrepancy between getParameter and texImage2D');
    });
  }

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`\nwebgl-capability-compatibility-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`\nwebgl-capability-compatibility-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('webgl-capability-compatibility-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
