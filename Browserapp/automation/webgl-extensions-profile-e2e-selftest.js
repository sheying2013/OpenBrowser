#!/usr/bin/env node
'use strict';

/**
 * End-to-end capability profile and WebGL/WebGL2 extension audit.
 *
 * Background:
 * OpenBrowser patches WebGL vendor, renderer, and key numeric limits (e.g., MAX_TEXTURE_SIZE),
 * but the extension set (extCount ~35 for WebGL1 and ~31 for WebGL2) currently remains identical
 * between the raw host context and injected Windows GPU personas.
 *
 * This test suite:
 * 1. Collects live capabilities from the real macOS-x64 148 Chromium kernel for:
 *    - Raw host (macOS Metal)
 *    - Windows NVIDIA GeForce RTX 3060 Direct3D11 persona (Ampere)
 *    - Windows AMD Radeon RX 6600 Direct3D11 persona (RDNA-2)
 *    - Windows Intel UHD Graphics 620 Direct3D11 persona (Gen9)
 * 2. Compares sorted getSupportedExtensions lists and verifies getExtension() non-null validity.
 * 3. Audits MAX* parameter limits, constructor types, shader precisions, and drawing buffer attributes.
 * 4. Checks static contradictions across personas (e.g., vendor extension leakage and host constraints).
 * 5. Asserts authentic behaviors and confirms documented KNOWN GAPs without false greens.
 * 6. Supports optional --mutate flag for testing verification sensitivity.
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
    response.end('<!doctype html><title>webgl-extensions-audit</title><main>audit</main>');
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
    await sleep(200);
  }
  return null;
}

function buildProbe() {
  return `(async () => {
  const inspectContext = (gl, isWebgl2) => {
    if (!gl) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const extList = gl.getSupportedExtensions() || [];
    const sortedExts = [...extList].sort();
    const extMap = {};
    let nullExtCount = 0;
    for (const name of sortedExts) {
      try {
        const obj = gl.getExtension(name);
        const hasObj = Boolean(obj);
        if (!hasObj) nullExtCount += 1;
        extMap[name] = hasObj;
      } catch (e) {
        nullExtCount += 1;
        extMap[name] = 'ERR:' + e.message;
      }
    }

    const limits = {};
    const limitNames = [
      'MAX_TEXTURE_SIZE',
      'MAX_CUBE_MAP_TEXTURE_SIZE',
      'MAX_RENDERBUFFER_SIZE',
      'MAX_VERTEX_UNIFORM_VECTORS',
      'MAX_VARYING_VECTORS',
      'MAX_VERTEX_ATTRIBS',
      'MAX_COMBINED_TEXTURE_IMAGE_UNITS',
      'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
      'MAX_TEXTURE_IMAGE_UNITS',
      'MAX_FRAGMENT_UNIFORM_VECTORS',
    ];
    for (const k of limitNames) {
      if (typeof gl[k] !== 'undefined') {
        limits[k] = gl.getParameter(gl[k]);
      }
    }

    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    limits.MAX_VIEWPORT_DIMS = vp ? Array.from(vp) : null;
    limits.MAX_VIEWPORT_DIMS_CTOR = vp ? (vp.constructor ? vp.constructor.name : null) : null;

    const lw = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE);
    limits.ALIASED_LINE_WIDTH_RANGE = lw ? Array.from(lw) : null;
    limits.ALIASED_LINE_WIDTH_RANGE_CTOR = lw ? (lw.constructor ? lw.constructor.name : null) : null;

    const ps = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    limits.ALIASED_POINT_SIZE_RANGE = ps ? Array.from(ps) : null;
    limits.ALIASED_POINT_SIZE_RANGE_CTOR = ps ? (ps.constructor ? ps.constructor.name : null) : null;

    const precisions = {};
    const stages = ['VERTEX_SHADER', 'FRAGMENT_SHADER'];
    const ptypes = ['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT'];
    for (const s of stages) {
      precisions[s] = {};
      for (const p of ptypes) {
        if (typeof gl[s] !== 'undefined' && typeof gl[p] !== 'undefined') {
          const fmt = gl.getShaderPrecisionFormat(gl[s], gl[p]);
          precisions[s][p] = fmt ? { rangeMin: fmt.rangeMin, rangeMax: fmt.rangeMax, precision: fmt.precision } : null;
        }
      }
    }

    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    const maxAnisotropy = aniso ? gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : null;

    let directNvExt = false;
    try {
      directNvExt = Boolean(gl.getExtension('NV_shader_noperspective_interpolation'));
    } catch (_) {
      directNvExt = false;
    }

    // Real execution capability probe: test actual texture allocation vs declared MAX_TEXTURE_SIZE
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
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
        gl.uniform1f(uS, Math.min(511, ps ? ps[1] : 511));
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
      isWebgl2: Boolean(isWebgl2),
      execution: {
        canAllocateMaxTex,
        texAllocError,
        beyondMaxTexFailed,
        beyondTexError,
        pointSizeRasterized,
      },
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      extCount: sortedExts.length,
      extensions: sortedExts,
      nullExtCount,
      extMap,
      directNvExt,
      limits,
      precisions,
      maxAnisotropy,
      contextAttributes: gl.getContextAttributes(),
      drawingBuffer: {
        width: gl.drawingBufferWidth,
        height: gl.drawingBufferHeight,
        colorSpace: gl.drawingBufferColorSpace || null,
      },
    };
  };

  const c1 = document.createElement('canvas');
  const gl1 = c1.getContext('webgl') || c1.getContext('experimental-webgl');
  const c2 = document.createElement('canvas');
  const gl2 = c2.getContext('webgl2');

  return JSON.stringify({
    webgl1: inspectContext(gl1, false),
    webgl2: inspectContext(gl2, true),
  });
})()`;
}

const PROBE = buildProbe();

async function runSession({ label, profile, serverPort, mutate = false, mutateVendorLeak = false, forceUnreconciled32k = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ob-webglaudit-${label}-`));
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

  // In mutation mode, inject an unsafe fake extension into the page to test audit sensitivity
  if (mutate) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const hook = (proto) => {
          if (!proto || !proto.getSupportedExtensions) return;
          const orig = proto.getSupportedExtensions;
          proto.getSupportedExtensions = function() {
            const list = orig.apply(this, arguments) || [];
            return [...list, 'WEBGL_synthetic_injected_dummy_extension'];
          };
        };
        hook(globalThis.WebGLRenderingContext?.prototype);
        hook(globalThis.WebGL2RenderingContext?.prototype);
      })();`,
    });
  }

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

  if (mutateVendorLeak) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const restoreVendorLeak = (proto) => {
          if (!proto || !proto.getSupportedExtensions) return;
          const origSupported = proto.getSupportedExtensions;
          proto.getSupportedExtensions = function() {
            const list = origSupported.apply(this, arguments) || [];
            if (!list.includes('NV_shader_noperspective_interpolation')) {
              return [...list, 'NV_shader_noperspective_interpolation'];
            }
            return list;
          };
          const origExt = proto.getExtension;
          proto.getExtension = function(name) {
            if (String(name || '').toLowerCase() === 'nv_shader_noperspective_interpolation') {
              return { __synthetic_leaked_nv_ext: true };
            }
            return origExt.apply(this, arguments);
          };
        };
        restoreVendorLeak(globalThis.WebGL2RenderingContext?.prototype);
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
  console.log('--- OpenBrowser WebGL & WebGL2 Capabilities & Extension Audit ---');
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`webgl-extensions-profile-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  check('macos-x64 148 kernel launcher is present and executable', () => {
    assert.strictEqual(fs.existsSync(launcher), true, 'launcher must exist');
  });

  const { server, port: serverPort } = await startServer();

  let rawRun, nvidiaRun, amdRun, intelRun, mutateAmdRun, mutateDummyRun, mutateUnreconciledRun;
  try {
    console.log('Executing live browser probes across host and 3 Windows personas...');

    // 1. Raw host (no injection)
    rawRun = await runSession({ label: 'raw', profile: null, serverPort });

    // 2. Persona 1: Windows NVIDIA RTX 3060 (Ampere)
    const nvidiaProfile = {
      id: 'persona-nvidia',
      name: 'persona-nvidia',
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
    nvidiaRun = await runSession({ label: 'nvidia', profile: nvidiaProfile, serverPort });

    // 3. Persona 2: Windows AMD Radeon RX 6600 (RDNA-2)
    const amdProfile = {
      id: 'persona-amd',
      name: 'persona-amd',
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

    // 4. Persona 3: Windows Intel UHD Graphics 620 (Gen9)
    const intelProfile = {
      id: 'persona-intel',
      name: 'persona-intel',
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

    // 5. Mutate runs if requested or for sensitivity verification
    if (isMutateMode) {
      console.log('Running mutation sensitivity sessions (--mutate)...');
      mutateAmdRun = await runSession({ label: 'mutate-amd', profile: amdProfile, serverPort, mutateVendorLeak: true });
      mutateDummyRun = await runSession({ label: 'mutate-dummy', profile: nvidiaProfile, serverPort, mutate: true });
      mutateUnreconciledRun = await runSession({ label: 'mutate-unreconciled', profile: nvidiaProfile, serverPort, forceUnreconciled32k: true });
    }
  } finally {
    server.close();
  }

  const rawP = rawRun.probe;
  const nvP = nvidiaRun.probe;
  const amdP = amdRun.probe;
  const intelP = intelRun.probe;

  // Print numerical overview table
  console.log('\n============================= WebGL Audit Numerical Summary =============================');
  console.log('Field                          | Raw Host (Metal)   | NVIDIA (D3D11)     | AMD (D3D11)        | Intel (D3D11)');
  console.log('-------------------------------+--------------------+--------------------+--------------------+--------------------');
  console.log(`WebGL1 Vendor                  | ${(rawP.webgl1.unmaskedVendor || '').slice(0, 18).padEnd(18)} | ${(nvP.webgl1.unmaskedVendor || '').slice(0, 18).padEnd(18)} | ${(amdP.webgl1.unmaskedVendor || '').slice(0, 18).padEnd(18)} | ${(intelP.webgl1.unmaskedVendor || '').slice(0, 18).padEnd(18)}`);
  console.log(`WebGL1 extCount                | ${String(rawP.webgl1.extCount).padEnd(18)} | ${String(nvP.webgl1.extCount).padEnd(18)} | ${String(amdP.webgl1.extCount).padEnd(18)} | ${String(intelP.webgl1.extCount).padEnd(18)}`);
  console.log(`WebGL2 extCount                | ${String(rawP.webgl2.extCount).padEnd(18)} | ${String(nvP.webgl2.extCount).padEnd(18)} | ${String(amdP.webgl2.extCount).padEnd(18)} | ${String(intelP.webgl2.extCount).padEnd(18)}`);
  console.log(`MAX_TEXTURE_SIZE               | ${String(rawP.webgl1.limits.MAX_TEXTURE_SIZE).padEnd(18)} | ${String(nvP.webgl1.limits.MAX_TEXTURE_SIZE).padEnd(18)} | ${String(amdP.webgl1.limits.MAX_TEXTURE_SIZE).padEnd(18)} | ${String(intelP.webgl1.limits.MAX_TEXTURE_SIZE).padEnd(18)}`);
  console.log(`texImage2D(maxTex) alloc      | ${(rawP.webgl1.execution?.canAllocateMaxTex ? 'PASS (0)' : 'FAIL').padEnd(18)} | ${(nvP.webgl1.execution?.canAllocateMaxTex ? 'PASS (0)' : 'FAIL').padEnd(18)} | ${(amdP.webgl1.execution?.canAllocateMaxTex ? 'PASS (0)' : 'FAIL').padEnd(18)} | ${(intelP.webgl1.execution?.canAllocateMaxTex ? 'PASS (0)' : 'FAIL').padEnd(18)}`);
  console.log(`point-size rasterization      | ${(rawP.webgl1.execution?.pointSizeRasterized ? 'PASS (511)' : 'FAIL').padEnd(18)} | ${(nvP.webgl1.execution?.pointSizeRasterized ? 'PASS (511)' : 'FAIL').padEnd(18)} | ${(amdP.webgl1.execution?.pointSizeRasterized ? 'PASS (511)' : 'FAIL').padEnd(18)} | ${(intelP.webgl1.execution?.pointSizeRasterized ? 'PASS (511)' : 'FAIL').padEnd(18)}`);
  console.log(`MAX_VIEWPORT_DIMS              | ${JSON.stringify(rawP.webgl1.limits.MAX_VIEWPORT_DIMS).padEnd(18)} | ${JSON.stringify(nvP.webgl1.limits.MAX_VIEWPORT_DIMS).padEnd(18)} | ${JSON.stringify(amdP.webgl1.limits.MAX_VIEWPORT_DIMS).padEnd(18)} | ${JSON.stringify(intelP.webgl1.limits.MAX_VIEWPORT_DIMS).padEnd(18)}`);
  console.log(`MAX_VARYING_VECTORS            | ${String(rawP.webgl1.limits.MAX_VARYING_VECTORS).padEnd(18)} | ${String(nvP.webgl1.limits.MAX_VARYING_VECTORS).padEnd(18)} | ${String(amdP.webgl1.limits.MAX_VARYING_VECTORS).padEnd(18)} | ${String(intelP.webgl1.limits.MAX_VARYING_VECTORS).padEnd(18)}`);
  console.log(`ALIASED_POINT_SIZE_RANGE       | ${JSON.stringify(rawP.webgl1.limits.ALIASED_POINT_SIZE_RANGE).padEnd(18)} | ${JSON.stringify(nvP.webgl1.limits.ALIASED_POINT_SIZE_RANGE).padEnd(18)} | ${JSON.stringify(amdP.webgl1.limits.ALIASED_POINT_SIZE_RANGE).padEnd(18)} | ${JSON.stringify(intelP.webgl1.limits.ALIASED_POINT_SIZE_RANGE).padEnd(18)}`);
  console.log(`ALIASED_LINE_WIDTH_RANGE       | ${JSON.stringify(rawP.webgl1.limits.ALIASED_LINE_WIDTH_RANGE).padEnd(18)} | ${JSON.stringify(nvP.webgl1.limits.ALIASED_LINE_WIDTH_RANGE).padEnd(18)} | ${JSON.stringify(amdP.webgl1.limits.ALIASED_LINE_WIDTH_RANGE).padEnd(18)} | ${JSON.stringify(intelP.webgl1.limits.ALIASED_LINE_WIDTH_RANGE).padEnd(18)}`);
  console.log(`MAX_TEXTURE_MAX_ANISOTROPY     | ${String(rawP.webgl1.maxAnisotropy).padEnd(18)} | ${String(nvP.webgl1.maxAnisotropy).padEnd(18)} | ${String(amdP.webgl1.maxAnisotropy).padEnd(18)} | ${String(intelP.webgl1.maxAnisotropy).padEnd(18)}`);
  console.log('=========================================================================================\n');

  // Assertions Section

  check('Raw WebGL1 and WebGL2 contexts initialize with valid context attributes', () => {
    assert.ok(rawP.webgl1, 'raw WebGL1 context must exist');
    assert.ok(rawP.webgl2, 'raw WebGL2 context must exist');
    assert.strictEqual(typeof rawP.webgl1.contextAttributes, 'object');
    assert.strictEqual(rawP.webgl1.contextAttributes.alpha, true);
    assert.strictEqual(rawP.webgl1.contextAttributes.depth, true);
    assert.strictEqual(rawP.webgl1.contextAttributes.failIfMajorPerformanceCaveat, false);
  });

  check('All advertised extensions in WebGL1 and WebGL2 resolve to non-null objects via getExtension', () => {
    assert.strictEqual(rawP.webgl1.nullExtCount, 0, 'every WebGL1 extension must resolve');
    assert.strictEqual(rawP.webgl2.nullExtCount, 0, 'every WebGL2 extension must resolve');
    assert.strictEqual(nvP.webgl1.nullExtCount, 0, 'injected NVIDIA WebGL1 extensions must resolve');
    assert.strictEqual(nvP.webgl2.nullExtCount, 0, 'injected NVIDIA WebGL2 extensions must resolve');
    assert.strictEqual(amdP.webgl1.nullExtCount, 0, 'injected AMD WebGL1 extensions must resolve');
    assert.strictEqual(amdP.webgl2.nullExtCount, 0, 'injected AMD WebGL2 extensions must resolve');
    assert.strictEqual(intelP.webgl1.nullExtCount, 0, 'injected Intel WebGL1 extensions must resolve');
    assert.strictEqual(intelP.webgl2.nullExtCount, 0, 'injected Intel WebGL2 extensions must resolve');
  });

  check('WebGL1 vs WebGL2 extension promotion: core WebGL2 features are absent from WebGL2 extension list', () => {
    // Standard WebGL1 extensions promoted to core in WebGL2
    const promotedToCore = [
      'ANGLE_instanced_arrays',
      'EXT_blend_minmax',
      'EXT_frag_depth',
      'EXT_sRGB',
      'EXT_shader_texture_lod',
      'OES_element_index_uint',
      'OES_standard_derivatives',
      'OES_texture_float',
      'OES_texture_half_float',
      'OES_vertex_array_object',
      'WEBGL_depth_texture',
      'WEBGL_draw_buffers',
    ];
    for (const ext of promotedToCore) {
      assert.strictEqual(rawP.webgl1.extensions.includes(ext), true, `WebGL1 must support ${ext}`);
      assert.strictEqual(rawP.webgl2.extensions.includes(ext), false, `WebGL2 must NOT list promoted ${ext}`);
      assert.strictEqual(nvP.webgl2.extensions.includes(ext), false, `injected WebGL2 must NOT list promoted ${ext}`);
    }
  });

  check('Injected Windows personas reflect unmasked vendor and renderer strings matching profile identity', () => {
    assert.strictEqual(nvP.webgl1.unmaskedVendor, 'Google Inc. (NVIDIA)');
    assert.ok(nvP.webgl1.unmaskedRenderer.includes('RTX 3060') && nvP.webgl1.unmaskedRenderer.includes('Direct3D11'));

    assert.strictEqual(amdP.webgl1.unmaskedVendor, 'Google Inc. (AMD)');
    assert.ok(amdP.webgl1.unmaskedRenderer.includes('RX 6600') && amdP.webgl1.unmaskedRenderer.includes('Direct3D11'));

    assert.strictEqual(intelP.webgl1.unmaskedVendor, 'Google Inc. (Intel)');
    assert.ok(intelP.webgl1.unmaskedRenderer.includes('UHD Graphics 620') && intelP.webgl1.unmaskedRenderer.includes('Direct3D11'));
  });

  check('Driver limit compatibility & texImage2D execution matching: declared limits physically allocatable', () => {
    // 1. Raw host allocations
    assert.strictEqual(rawP.webgl1.execution.canAllocateMaxTex, true, 'raw host must allocate MAX_TEXTURE_SIZE');
    assert.strictEqual(rawP.webgl1.execution.texAllocError, 0, 'raw host texImage2D must succeed without error');
    assert.strictEqual(rawP.webgl1.execution.beyondMaxTexFailed, true, 'raw host must reject texture > MAX_TEXTURE_SIZE');

    // 2. Intel & AMD personas (natively 16K class)
    assert.strictEqual(Number(intelP.webgl1.limits.MAX_TEXTURE_SIZE), 16384, 'Intel Gen9 reports 16384 texture size');
    assert.strictEqual(intelP.webgl1.execution.canAllocateMaxTex, true, 'Intel persona texImage2D(16384) must succeed');
    assert.strictEqual(intelP.webgl1.execution.beyondMaxTexFailed, true, 'Intel persona texImage2D(16385) must fail');

    assert.strictEqual(Number(amdP.webgl1.limits.MAX_TEXTURE_SIZE), 16384, 'AMD RDNA-2 reports 16384 texture size');
    assert.strictEqual(amdP.webgl1.execution.canAllocateMaxTex, true, 'AMD persona texImage2D(16384) must succeed');
    assert.strictEqual(amdP.webgl1.execution.beyondMaxTexFailed, true, 'AMD persona texImage2D(16385) must fail');

    // 3. NVIDIA persona on macOS Metal: reconciled to host physical execution ceiling (16384)
    // On macOS Metal host, the driver cannot allocate 32K. By reconciling declared limit to 16384,
    // gl.getParameter(MAX_TEXTURE_SIZE) matches physical texImage2D capacity without INVALID_VALUE.
    assert.strictEqual(Number(nvP.webgl1.limits.MAX_TEXTURE_SIZE), 16384, 'NVIDIA persona on Metal host reconciled to 16384');
    assert.strictEqual(Number(nvP.webgl1.limits.MAX_CUBE_MAP_TEXTURE_SIZE), 16384);
    assert.strictEqual(Number(nvP.webgl1.limits.MAX_RENDERBUFFER_SIZE), 16384);
    assert.strictEqual(nvP.webgl1.execution.canAllocateMaxTex, true, 'reconciled NVIDIA texImage2D(16384) must succeed with NO_ERROR');
    assert.strictEqual(nvP.webgl1.execution.beyondMaxTexFailed, true, 'reconciled NVIDIA texImage2D(16385) must fail with INVALID_VALUE');

    // 4. Raw unconstrained mapping verification (shows raw GPU class value remains 32768 for Windows native)
    const rawNvLimits = webglParameterOverrides({ vendor: 'nvidia', architecture: 'ampere' }, { reconcileHost: false });
    assert.strictEqual(rawNvLimits[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 32768, 'unconstrained raw table mapping remains 32K for native Windows D3D11');
  });

  check('Selection strategy and capability gating: incompatible 32K personas excluded on macOS Metal', () => {
    // Verify isPersonaWebglCompatible logic
    assert.strictEqual(isPersonaWebglCompatible({ webgl: { gpu: { vendor: 'intel', architecture: 'gen9' } } }, 'darwin'), true);
    assert.strictEqual(isPersonaWebglCompatible({ webgl: { gpu: { vendor: 'amd', architecture: 'rdna-2' } } }, 'darwin'), true);
    assert.strictEqual(isPersonaWebglCompatible({ webgl: { gpu: { vendor: 'nvidia', architecture: 'ampere' } } }, 'darwin'), false, 'NVIDIA Ampere 32K is incompatible with darwin 16K host');
    assert.strictEqual(isPersonaWebglCompatible({ webgl: { gpu: { vendor: 'nvidia', architecture: 'ada' } } }, 'darwin'), false, 'NVIDIA Ada 32K is incompatible with darwin 16K host');

    // Verify compatiblePersonasForOs filtering
    const darwinWindowsPool = compatiblePersonasForOs('windows', 'darwin');
    assert.strictEqual(darwinWindowsPool.length, 4, 'darwin host must filter Windows pool down to 4 16K-compatible personas');
    for (const p of darwinWindowsPool) {
      assert.notStrictEqual(p.webgl.gpu.vendor, 'nvidia', 'no 32K NVIDIA persona may be present in darwin-compatible pool');
    }

    // Windows native host retains all 6 personas
    const winPool = compatiblePersonasForOs('windows', 'win32');
    assert.strictEqual(winPool.length, 6, 'Windows host retains all 6 personas including 32K NVIDIA');
  });

  check('Parameter types and array constructors remain faithful to engine specifications', () => {
    assert.strictEqual(rawP.webgl1.limits.MAX_VIEWPORT_DIMS_CTOR, 'Int32Array');
    assert.strictEqual(nvP.webgl1.limits.MAX_VIEWPORT_DIMS_CTOR, 'Int32Array');
    assert.strictEqual(rawP.webgl1.limits.ALIASED_LINE_WIDTH_RANGE_CTOR, 'Float32Array');
    assert.strictEqual(rawP.webgl1.limits.ALIASED_POINT_SIZE_RANGE_CTOR, 'Float32Array');

    assert.deepStrictEqual(nvP.webgl1.limits.MAX_VIEWPORT_DIMS, [16384, 16384]);
    assert.deepStrictEqual(amdP.webgl1.limits.MAX_VIEWPORT_DIMS, [16384, 16384]);
    assert.deepStrictEqual(intelP.webgl1.limits.MAX_VIEWPORT_DIMS, [16384, 16384]);
  });

  check('Shader precision format adheres to desktop IEEE-754 single-precision float standards', () => {
    const prec = rawP.webgl1.precisions.FRAGMENT_SHADER.HIGH_FLOAT;
    assert.ok(prec, 'HIGH_FLOAT precision must exist');
    assert.strictEqual(prec.rangeMin, 127);
    assert.strictEqual(prec.rangeMax, 127);
    assert.strictEqual(prec.precision, 23);

    const nvPrec = nvP.webgl1.precisions.FRAGMENT_SHADER.HIGH_FLOAT;
    assert.strictEqual(nvPrec.precision, 23);
  });

  check('Drawing buffer defaults match viewport canvas sizing and color space', () => {
    assert.strictEqual(rawP.webgl1.drawingBuffer.width, 300);
    assert.strictEqual(rawP.webgl1.drawingBuffer.height, 150);
    assert.strictEqual(rawP.webgl1.drawingBuffer.colorSpace, 'srgb');
  });

  // Verified extension counts and cross-vendor isolation
  check('Extension set parity and isolation: WebGL1 retains 35 extensions across all personas; WebGL2 isolates vendor extensions', () => {
    assert.strictEqual(rawP.webgl1.extCount, 35, 'host WebGL1 has 35 extensions');
    assert.strictEqual(rawP.webgl2.extCount, 31, 'host WebGL2 has 31 extensions');
    assert.strictEqual(nvP.webgl1.extCount, 35, 'NVIDIA persona retains 35 extensions');
    assert.strictEqual(nvP.webgl2.extCount, 31, 'NVIDIA persona retains 31 extensions including NV_');
    assert.strictEqual(amdP.webgl1.extCount, 35, 'AMD persona retains 35 extensions');
    assert.strictEqual(amdP.webgl2.extCount, 30, 'AMD persona filters NV_ extension down to 30');
    assert.strictEqual(intelP.webgl1.extCount, 35, 'Intel persona retains 35 extensions');
    assert.strictEqual(intelP.webgl2.extCount, 30, 'Intel persona filters NV_ extension down to 30');
    assert.deepStrictEqual(nvP.webgl1.extensions, rawP.webgl1.extensions, 'WebGL1 extensions are pass-through');
  });

  check('Vendor extension isolation: NV_shader_noperspective_interpolation isolated to NVIDIA and blocked on AMD/Intel', () => {
    // Host Metal backend advertises NV_shader_noperspective_interpolation in WebGL2.
    assert.strictEqual(rawP.webgl2.extensions.includes('NV_shader_noperspective_interpolation'), true,
      'host WebGL2 exposes NV_shader_noperspective_interpolation');
    assert.strictEqual(rawP.webgl2.directNvExt, true,
      'host getExtension(NV_shader_noperspective_interpolation) resolves native object');

    // NVIDIA persona retains NV_shader_noperspective_interpolation in getSupportedExtensions and getExtension resolves genuine native object.
    assert.strictEqual(nvP.webgl2.extensions.includes('NV_shader_noperspective_interpolation'), true,
      'NVIDIA persona must retain NV_shader_noperspective_interpolation in getSupportedExtensions');
    assert.strictEqual(nvP.webgl2.extMap['NV_shader_noperspective_interpolation'], true,
      'NVIDIA persona must resolve non-null native object for advertised NV_shader_noperspective_interpolation');
    assert.strictEqual(nvP.webgl2.directNvExt, true,
      'NVIDIA persona getExtension(NV_shader_noperspective_interpolation) must resolve native object');

    // AMD persona filters NV_shader_noperspective_interpolation: absent from getSupportedExtensions, getExtension returns null.
    assert.strictEqual(amdP.webgl2.extensions.includes('NV_shader_noperspective_interpolation'), false,
      'AMD persona must NOT list NV_shader_noperspective_interpolation in getSupportedExtensions');
    assert.strictEqual(amdP.webgl2.directNvExt, false,
      'AMD persona getExtension(NV_shader_noperspective_interpolation) must return null');

    // Intel persona filters NV_shader_noperspective_interpolation: absent from getSupportedExtensions, getExtension returns null.
    assert.strictEqual(intelP.webgl2.extensions.includes('NV_shader_noperspective_interpolation'), false,
      'Intel persona must NOT list NV_shader_noperspective_interpolation in getSupportedExtensions');
    assert.strictEqual(intelP.webgl2.directNvExt, false,
      'Intel persona getExtension(NV_shader_noperspective_interpolation) must return null');
  });

  checkKnownGap('Secondary hardware limits: ALIASED_POINT_SIZE_RANGE remains bound to host Metal limit [1, 511]', () => {
    // Real Windows Direct3D11 on desktop GPUs typically supports point sizes up to 1024 or 2048.
    // Host Metal driver clamps to [1, 511]. The parameter [1, 511] matches actual rasterization behavior.
    assert.deepStrictEqual(nvP.webgl1.limits.ALIASED_POINT_SIZE_RANGE, [1, 511]);
    assert.deepStrictEqual(amdP.webgl1.limits.ALIASED_POINT_SIZE_RANGE, [1, 511]);
    assert.deepStrictEqual(intelP.webgl1.limits.ALIASED_POINT_SIZE_RANGE, [1, 511]);

    // Live rasterization verification: points within range draw successfully
    assert.strictEqual(nvP.webgl1.execution.pointSizeRasterized, true, 'NVIDIA persona point drawing succeeds');
    assert.strictEqual(amdP.webgl1.execution.pointSizeRasterized, true, 'AMD persona point drawing succeeds');
    assert.strictEqual(intelP.webgl1.execution.pointSizeRasterized, true, 'Intel persona point drawing succeeds');
  });

  check('Configuration architecture key normalization: gen-9 and gen9 both resolve to 16384 texture size', () => {
    const unnormalizedLimits = webglParameterOverrides({ vendor: 'intel', architecture: 'gen-9' });
    const normalizedLimits = webglParameterOverrides({ vendor: 'intel', architecture: 'gen9' });
    assert.strictEqual(unnormalizedLimits[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 16384, 'gen-9 normalizes to gen9 and resolves 16384');
    assert.strictEqual(normalizedLimits[WEBGL_PARAM_IDS.MAX_TEXTURE_SIZE], 16384, 'gen9 resolves 16384');
  });

  // Mutation mode verification (--mutate)
  if (isMutateMode && mutateAmdRun && mutateDummyRun && mutateUnreconciledRun) {
    check('MUTATION CHECK: Unreconciled 32K texture claim triggers texImage2D driver allocation failure (INVALID_VALUE 1281)', () => {
      const mutNvP = mutateUnreconciledRun.probe;
      assert.strictEqual(Number(mutNvP.webgl1.limits.MAX_TEXTURE_SIZE), 32768, 'mutated session must claim 32768 texture size');
      assert.strictEqual(mutNvP.webgl1.execution.canAllocateMaxTex, false, 'texImage2D(32768) must fail on Metal host');
      assert.strictEqual(mutNvP.webgl1.execution.texAllocError, 1281, 'driver must report INVALID_VALUE (1281)');
    });

    check('MUTATION CHECK: Capability compatibility contract fails when unreconciled 32K limit is forced', () => {
      let contractFailed = false;
      try {
        const mutNvP = mutateUnreconciledRun.probe;
        assert.strictEqual(mutNvP.webgl1.execution.canAllocateMaxTex, true);
        assert.strictEqual(mutNvP.webgl1.execution.texAllocError, 0);
      } catch (_) {
        contractFailed = true;
      }
      assert.strictEqual(contractFailed, true, 'capability compatibility contract must catch unreconciled 32K failure');
    });
    check('MUTATION CHECK: Disabling vendor extension filter restores NV_ extension leak on AMD in getSupportedExtensions', () => {
      const mutAmdP = mutateAmdRun.probe;
      assert.strictEqual(mutAmdP.webgl2.extensions.includes('NV_shader_noperspective_interpolation'), true,
        'mutated AMD session must leak NV_shader_noperspective_interpolation');
    });

    check('MUTATION CHECK: Disabling vendor extension filter restores non-null getExtension for NV_ extension on AMD', () => {
      const mutAmdP = mutateAmdRun.probe;
      assert.strictEqual(mutAmdP.webgl2.directNvExt, true,
        'mutated AMD session must resolve non-null getExtension for leaked NV_ extension');
    });

    check('MUTATION CHECK: Vendor isolation contract assertion fails when leak is restored', () => {
      let contractFailed = false;
      try {
        assert.strictEqual(mutateAmdRun.probe.webgl2.extensions.includes('NV_shader_noperspective_interpolation'), false);
      } catch (_) {
        contractFailed = true;
      }
      assert.strictEqual(contractFailed, true,
        'vendor isolation contract assertion must fail when leak is restored');
    });

    check('MUTATION CHECK: Synthetic extension advertised in getSupportedExtensions fails getExtension resolution', () => {
      const mutDummyP = mutateDummyRun.probe;
      assert.ok(mutDummyP.webgl1.extensions.includes('WEBGL_synthetic_injected_dummy_extension'),
        'mutated session must include dummy extension');
      assert.strictEqual(mutDummyP.webgl1.nullExtCount > 0, true,
        'dummy extension without native backing object must produce null getExtension and trigger contract violation');
    });
  }

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`\nwebgl-extensions-profile-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`\nwebgl-extensions-profile-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('webgl-extensions-profile-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
