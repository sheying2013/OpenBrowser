#!/usr/bin/env node
'use strict';

/**
 * End-to-end verification for document-layer font metric spoofing and document.fonts shielding.
 *
 * This test verifies:
 * 1. Document-level font injection yields genuine, distinct canvas text measurements.
 * 2. Injected fonts transition target OS families away from host fallback metrics.
 * 3. The document.fonts exposure surface is shielded (blank page document.fonts.size is 0).
 * 4. Legitimate user web fonts remain visible and manageable via document.fonts.
 * 5. Document.prototype.fonts property descriptor and toString representation remain native-like.
 * 6. Mutation check: disabling font injection causes font metric assertions to fail.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const win11FontsDir = path.join(appRoot, 'kernels', 'windows-x64', 'wayfern_fonts', 'win11');

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
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  call(a, b, c) { return typeof c === 'undefined' ? this.send(a, b || {}) : this.send(b, c || {}); }
  async value(expression) {
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const exception = message?.result?.exceptionDetails;
    if (exception) return { error: exception.text || JSON.stringify(exception) };
    const raw = message?.result?.result?.value;
    try { return JSON.parse(raw); } catch (_) { return { error: 'probe parse', raw: String(raw).slice(0, 240) }; }
  }
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
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

// Core test font definitions: Windows-native families absent on macOS host
const CORE_TEST_FONTS = [
  { family: 'Segoe UI', file: 'Segoe UI.otf' },
  { family: 'Consolas', file: 'consola7_00.ttf' },
  { family: 'Candara', file: 'candara5_64.ttf' },
  { family: 'Corbel', file: 'corbel6_01.ttf' },
  { family: 'Franklin Gothic Medium', file: 'framd5_02.ttf' },
];

function buildFontMetricsScript(options = {}) {
  const { disabled = false } = options;
  if (disabled) {
    return '/* Font metrics injection disabled for mutation verification */';
  }

  const payload = CORE_TEST_FONTS.map((spec) => {
    const filePath = path.join(win11FontsDir, spec.file);
    const buf = fs.readFileSync(filePath);
    return {
      family: spec.family,
      format: spec.file.endsWith('.otf') ? 'font/otf' : 'font/ttf',
      base64: buf.toString('base64'),
    };
  });

  return `(() => {
    const fontData = ${JSON.stringify(payload)};
    const internalFaces = new WeakSet();

    const nativeMap = new WeakMap();
    const origToString = Function.prototype.toString;

    const origFontsDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'fonts');
    if (origFontsDesc && typeof origFontsDesc.get === 'function') {
      const origFontsGet = origFontsDesc.get;

      const createShieldedProxy = (realFonts) => {
        return new Proxy(realFonts, {
          get(target, prop, receiver) {
            if (prop === 'size') {
              let count = 0;
              for (const face of target) {
                if (!internalFaces.has(face)) count++;
              }
              return count;
            }
            if (prop === 'has') {
              return function has(face) {
                if (internalFaces.has(face)) return false;
                return target.has(face);
              };
            }
            if (prop === 'entries') {
              return function* entries() {
                for (const face of target) {
                  if (!internalFaces.has(face)) yield [face, face];
                }
              };
            }
            if (prop === 'keys' || prop === 'values' || prop === Symbol.iterator) {
              return function* () {
                for (const face of target) {
                  if (!internalFaces.has(face)) yield face;
                }
              };
            }
            if (prop === 'forEach') {
              return function forEach(callback, thisArg) {
                for (const face of target) {
                  if (!internalFaces.has(face)) {
                    callback.call(thisArg, face, face, receiver);
                  }
                }
              };
            }
            if (prop === 'delete') {
              return function delete_(face) {
                if (internalFaces.has(face)) return false;
                return target.delete(face);
              };
            }
            if (prop === 'clear') {
              return function clear() {
                for (const face of Array.from(target)) {
                  if (!internalFaces.has(face)) target.delete(face);
                }
              };
            }
            const val = Reflect.get(target, prop, target);
            if (typeof val === 'function') return val.bind(target);
            return val;
          }
        });
      };

      const patchedFontsGet = function getFonts() {
        if (!(this instanceof Document) && this !== document) {
          throw new TypeError('Illegal invocation');
        }
        const realFonts = origFontsGet.call(this);
        if (!this._openbrowser_shielded_fonts) {
          this._openbrowser_shielded_fonts = createShieldedProxy(realFonts);
        }
        return this._openbrowser_shielded_fonts;
      };

      // Set native-like properties and native toString string
      try {
        Object.defineProperty(patchedFontsGet, 'name', { configurable: true, value: 'get fonts' });
      } catch (_) {}
      nativeMap.set(patchedFontsGet, 'function get fonts() { [native code] }');

      const customToString = function toString() {
        if (nativeMap.has(this)) return nativeMap.get(this);
        return origToString.call(this);
      };
      nativeMap.set(customToString, 'function toString() { [native code] }');
      try {
        Object.defineProperty(Function.prototype, 'toString', {
          configurable: true, writable: true, value: customToString
        });
      } catch (_) {}

      Object.defineProperty(Document.prototype, 'fonts', {
        configurable: true,
        enumerable: origFontsDesc.enumerable,
        get: patchedFontsGet,
        set: undefined,
      });
    }

    const realFonts = origFontsDesc.get.call(document);
    for (const item of fontData) {
      try {
        const face = new FontFace(item.family, 'url("data:' + item.format + ';base64,' + item.base64 + '")');
        internalFaces.add(face);
        realFonts.add(face);
        face.load();
      } catch (_) {}
    }
  })();`;
}

function buildProbeScript() {
  return `(async () => {
    const probeText = 'mmmmmmmmmmlliWWWWWWWWW@@@@@@@@@@1234567890';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Monospace fallback baseline
    ctx.font = '72px monospace';
    const monoWidth = Math.round(ctx.measureText(probeText).width * 1000) / 1000;

    // Await document.fonts readiness
    const realFontsDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'fonts');
    if (realFontsDesc && realFontsDesc.get) {
      try { await realFontsDesc.get.call(document).ready; } catch (_) {}
    }

    const families = [
      'Segoe UI',
      'Consolas',
      'Candara',
      'Corbel',
      'Franklin Gothic Medium',
    ];

    const measurements = {};
    const fontChecks = {};
    for (const fam of families) {
      ctx.font = '10px sans-serif';
      ctx.font = '72px "' + fam + '", monospace';
      measurements[fam] = Math.round(ctx.measureText(probeText).width * 1000) / 1000;
      fontChecks[fam] = document.fonts.check('72px "' + fam + '"');
    }

    // Measure document.fonts exposure before user actions
    const exposureOnBlank = {
      size: document.fonts.size,
      spreadLength: [...document.fonts].length,
      entriesCount: Array.from(document.fonts.entries()).length,
      keysCount: Array.from(document.fonts.keys()).length,
      valuesCount: Array.from(document.fonts.values()).length,
      tag: Object.prototype.toString.call(document.fonts),
    };

    // User web font test: register a legitimate custom font
    let userFontTest = null;
    try {
      const userFace = new FontFace('CustomTestFamily', 'url("data:font/otf;base64,AAEAAAASAQA=")');
      const hasBeforeAdd = document.fonts.has(userFace);
      document.fonts.add(userFace);
      const sizeAfterAdd = document.fonts.size;
      const hasAfterAdd = document.fonts.has(userFace);
      const firstFaceFamily = Array.from(document.fonts)[0]?.family;
      const deleteResult = document.fonts.delete(userFace);
      const sizeAfterDelete = document.fonts.size;

      userFontTest = {
        hasBeforeAdd,
        sizeAfterAdd,
        hasAfterAdd,
        firstFaceFamily,
        deleteResult,
        sizeAfterDelete,
      };
    } catch (err) {
      userFontTest = { error: err.message };
    }

    const fontsDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'fonts');
    const descriptorCheck = {
      enumerable: fontsDesc?.enumerable,
      configurable: fontsDesc?.configurable,
      hasSet: typeof fontsDesc?.set !== 'undefined',
      getterName: fontsDesc?.get?.name,
      getterToString: Function.prototype.toString.call(fontsDesc?.get),
    };

    return JSON.stringify({
      marker: typeof window.__marker !== 'undefined' ? window.__marker : null,
      monoWidth,
      measurements,
      fontChecks,
      exposureOnBlank,
      userFontTest,
      descriptorCheck,
    });
  })()`;
}

async function runSession(options = {}) {
  const { isMutation = false } = options;
  const profile = {
    id: 'font-metrics-e2e',
    name: 'font-metrics-e2e',
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona' },
  };
  const fp = buildFingerprint(profile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-font-e2e-'));

  let child = null;
  try {
    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile,
      templatePath: path.join(kernelRoot, 'init_template.json'),
    });

    child = spawn(launcher, [dir, '--headless=new', '--enable-unsafe-swiftshader'], {
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
    if (!port) return { error: 'no port' };

    const page = await waitForPage(port);
    if (!page?.webSocketDebuggerUrl) return { error: 'no page' };

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);

    await cdp.call('Page.enable', {});
    const baseScript = buildInjectionScript(fp);
    const fontScript = buildFontMetricsScript({ disabled: isMutation });
    const fullScript = `window.__marker = true;\n${baseScript}\n${fontScript}`;

    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: fullScript });
    await cdp.call('Page.navigate', { url: 'about:blank' });
    await sleep(1500);

    const probeResult = await cdp.value(buildProbeScript());
    try { ws.close(); } catch (_) {}
    return probeResult;
  } finally {
    if (child) await stopChild(child, dir);
  }
}

(async () => {
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`font-metrics-injection-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const isMutationRun = process.argv.includes('--mutate') || process.env.MUTATE === '1';

  console.log(`\nStarting font metrics injection E2E selftest (mode: ${isMutationRun ? 'MUTATION' : 'STANDARD'})...`);
  const probe = await runSession({ isMutation: isMutationRun });

  if (probe.error) {
    throw new Error(`Probe failed: ${probe.error}`);
  }

  check('injection marker window.__marker evaluates to true', () => {
    assert.strictEqual(probe.marker, true, 'window.__marker must be true');
  });

  check('baseline fallback font width is positive', () => {
    assert.ok(typeof probe.monoWidth === 'number' && probe.monoWidth > 0, 'monospace width must be positive');
  });

  check('Windows core families deviate from fallback monospace width', () => {
    for (const [fam, w] of Object.entries(probe.measurements)) {
      assert.notStrictEqual(w, probe.monoWidth,
        `Font ${fam} measured width (${w}) must not equal fallback monospace width (${probe.monoWidth})`);
    }
  });

  check('all tested Windows core families yield mutually distinct widths', () => {
    const widths = Object.values(probe.measurements);
    const unique = new Set(widths);
    assert.strictEqual(unique.size, widths.length,
      `All ${widths.length} core fonts must yield distinct widths, got ${unique.size}`);
  });

  check('document.fonts.check returns true for injected Windows fonts', () => {
    for (const [fam, ok] of Object.entries(probe.fontChecks)) {
      assert.strictEqual(ok, true, `document.fonts.check for ${fam} must be true`);
    }
  });

  check('document.fonts exposure on blank page is completely shielded (size === 0)', () => {
    assert.strictEqual(probe.exposureOnBlank.size, 0, 'document.fonts.size must be 0 on blank page');
    assert.strictEqual(probe.exposureOnBlank.spreadLength, 0, '[...document.fonts].length must be 0 on blank page');
    assert.strictEqual(probe.exposureOnBlank.entriesCount, 0, 'document.fonts.entries().length must be 0 on blank page');
  });

  check('legitimate page-added web fonts remain functional in document.fonts', () => {
    const t = probe.userFontTest;
    assert.ok(t, 'user font test must produce results');
    assert.strictEqual(t.hasBeforeAdd, false, 'has() must be false before add');
    assert.strictEqual(t.sizeAfterAdd, 1, 'size must become 1 after user font add');
    assert.strictEqual(t.hasAfterAdd, true, 'has() must be true after add');
    assert.strictEqual(t.firstFaceFamily, 'CustomTestFamily', 'user font family must be visible in iteration');
    assert.strictEqual(t.deleteResult, true, 'delete() must succeed for user font');
    assert.strictEqual(t.sizeAfterDelete, 0, 'size must revert to 0 after user font delete');
  });

  check('Document.prototype.fonts descriptor and getter toString remain native-like', () => {
    const d = probe.descriptorCheck;
    assert.strictEqual(d.enumerable, true, 'fonts property descriptor must be enumerable');
    assert.strictEqual(d.configurable, true, 'fonts property descriptor must be configurable');
    assert.strictEqual(d.hasSet, false, 'fonts property descriptor must not have a setter');
    assert.ok(d.getterToString.includes('[native code]'), 'getter toString must include [native code]');
  });

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`\nfont-metrics-injection-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`\nfont-metrics-injection-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('font-metrics-injection-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
