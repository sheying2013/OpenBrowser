#!/usr/bin/env node
'use strict';

/**
 * End-to-end production verification for document-layer font metric spoofing
 * and document.fonts masking in OpenBrowser.
 *
 * Verifies:
 * 1. window.__marker evaluates to true as the primary injection probe.
 * 2. measureText('72px "Segoe UI"') differs from fallback monospace width and equals 2354.842529296875 +- 0.01.
 * 3. At least 12 core Windows families yield mutually distinct widths.
 * 4. document.fonts is shielded on blank page (size === 0, [...document.fonts].length === 0).
 * 5. Page-registered custom web fonts function normally (size becomes 1, delete reverts to 0).
 * 6. Document.prototype.fonts getter toString returns "function get fonts() { [native code] }".
 * 7. document.fonts.check('72px "Segoe UI"') returns true.
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

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const CORE_WINDOWS_FAMILIES = [
  'Segoe UI',
  'Calibri',
  'Cambria',
  'Candara',
  'Consolas',
  'Constantia',
  'Corbel',
  'Franklin Gothic Medium',
  'Gabriola',
  'Bahnschrift',
  'Lucida Console',
  'Segoe Script',
];

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
  call(method, params = {}) { return this.send(method, params); }
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

function buildProbeScript() {
  return `(async () => {
    const probeText = 'mmmmmmmmmmlliWWWWWWWWW@@@@@@@@@@1234567890';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const realFontsDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'fonts');
    if (realFontsDesc && realFontsDesc.get) {
      try { await realFontsDesc.get.call(document).ready; } catch (_) {}
    }

    ctx.font = '72px "Segoe UI"';
    const segoeWidth = ctx.measureText(probeText).width;

    ctx.font = '72px monospace';
    const monoWidth = ctx.measureText(probeText).width;

    const coreFamilies = ${JSON.stringify(CORE_WINDOWS_FAMILIES)};
    const coreWidths = {};
    for (const fam of coreFamilies) {
      ctx.font = '72px "' + fam + '"';
      coreWidths[fam] = ctx.measureText(probeText).width;
    }

    const blankSize = document.fonts.size;
    const spreadLength = [...document.fonts].length;

    let userFont = null;
    try {
      const userFace = new FontFace('CustomProductionTestFont', 'url("data:font/woff2;base64,AAEAAAASAQA=")');
      document.fonts.add(userFace);
      const sizeAfterAdd = document.fonts.size;
      const deleteResult = document.fonts.delete(userFace);
      const sizeAfterDelete = document.fonts.size;
      userFont = { sizeAfterAdd, deleteResult, sizeAfterDelete };
    } catch (err) {
      userFont = { error: err.message };
    }

    const fontsDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'fonts');
    const getterToString = Function.prototype.toString.call(fontsDesc?.get);

    const segoeCheck = document.fonts.check('72px "Segoe UI"');

    return JSON.stringify({
      marker: typeof window.__marker !== 'undefined' ? window.__marker : null,
      segoeWidth,
      monoWidth,
      coreWidths,
      blankSize,
      spreadLength,
      userFont,
      getterToString,
      segoeCheck,
    });
  })()`;
}

async function runSession(options = {}) {
  const { isMutation = false } = options;
  const profile = {
    id: 'font-metrics-prod-e2e',
    name: 'font-metrics-prod-e2e',
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona' },
  };

  const fp = buildFingerprint(profile);
  if (isMutation) {
    fp.fontMetricsOptions = { disabled: true };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-font-prod-e2e-'));
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

    let port = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      try {
        const fileContent = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8');
        const value = parseInt(fileContent.trim().split('\n')[0], 10);
        if (value > 0) { port = value; break; }
      } catch (_) {}
    }
    if (!port) return { error: 'DevToolsActivePort port not acquired' };

    const page = await waitForPage(port);
    if (!page?.webSocketDebuggerUrl) return { error: 'Target page not available' };

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);

    await cdp.call('Page.enable', {});

    // Register self-evident marker script first as required
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__marker = true;' });

    // Register production injection script built by buildInjectionScript(fp)
    const injectionScript = buildInjectionScript(fp);
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: injectionScript });

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
    console.log(`font-metrics-production-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const isMutationRun = process.argv.includes('--mutate') || process.env.MUTATE === '1';

  console.log(`\nStarting font metrics production E2E selftest (mode: ${isMutationRun ? 'MUTATION' : 'STANDARD'})...`);
  const probe = await runSession({ isMutation: isMutationRun });

  if (probe.error) {
    throw new Error(`Probe failed: ${probe.error}`);
  }

  if (probe.coreWidths) {
    console.log('\nMeasured Core Windows Font Family Widths (72px, canvas measureText):');
    console.log('---------------------------------------------------------------------');
    for (const [fam, width] of Object.entries(probe.coreWidths)) {
      console.log(`  ${fam.padEnd(28)} : ${width.toFixed(4)} px`);
    }
    console.log(`  ${'Fallback monospace'.padEnd(28)} : ${probe.monoWidth.toFixed(4)} px`);
    console.log('---------------------------------------------------------------------\n');
  }

  // 1. window.__marker === true
  check('injection marker window.__marker evaluates to true', () => {
    assert.strictEqual(probe.marker, true, 'window.__marker must be true');
  });

  // 2. measureText('72px "Segoe UI"') !== measureText('72px monospace') and equals 2354.842529296875 +- 0.01
  check('measureText Segoe UI differs from monospace and matches genuine Windows metric', () => {
    assert.notStrictEqual(probe.segoeWidth, probe.monoWidth,
      `Segoe UI width (${probe.segoeWidth}) must not equal monospace fallback width (${probe.monoWidth})`);
    const expectedSegoe = 2354.842529296875;
    const diff = Math.abs(probe.segoeWidth - expectedSegoe);
    assert.ok(diff <= 0.01,
      `Segoe UI width (${probe.segoeWidth}) must equal ${expectedSegoe} +- 0.01 (diff: ${diff})`);
  });

  // 3. At least 12 core Windows families yield mutually distinct widths
  check('at least 12 core Windows families yield mutually distinct widths', () => {
    const widths = Object.values(probe.coreWidths);
    assert.ok(widths.length >= 12, `Must test at least 12 families, got ${widths.length}`);
    const uniqueWidths = new Set(widths);
    assert.strictEqual(uniqueWidths.size, widths.length,
      `All ${widths.length} core Windows families must yield mutually distinct widths, got ${uniqueWidths.size}`);
  });

  // 4. document.fonts.size === 0, [...document.fonts].length === 0
  check('document.fonts is fully shielded on blank page (size === 0, spread === 0)', () => {
    assert.strictEqual(probe.blankSize, 0, 'document.fonts.size must be 0 on blank page');
    assert.strictEqual(probe.spreadLength, 0, '[...document.fonts].length must be 0 on blank page');
  });

  // 5. Custom web fonts can be added and deleted normally
  check('legitimate user web fonts remain functional in document.fonts', () => {
    const uf = probe.userFont;
    assert.ok(uf, 'userFont test result must exist');
    assert.strictEqual(uf.sizeAfterAdd, 1, 'document.fonts.size must become 1 after adding user web font');
    assert.strictEqual(uf.deleteResult, true, 'document.fonts.delete must succeed for user web font');
    assert.strictEqual(uf.sizeAfterDelete, 0, 'document.fonts.size must revert to 0 after deleting user web font');
  });

  // 6. Document.prototype.fonts getter toString retains native code representation
  check('Document.prototype.fonts getter toString returns native code string', () => {
    assert.strictEqual(probe.getterToString, 'function get fonts() { [native code] }',
      `getter toString must be native-like, got: ${probe.getterToString}`);
  });

  // 7. document.fonts.check returns true for Segoe UI
  check('document.fonts.check returns true for Segoe UI', () => {
    assert.strictEqual(probe.segoeCheck, true, 'document.fonts.check must return true for Segoe UI');
  });

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`\nfont-metrics-production-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`\nfont-metrics-production-e2e-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('font-metrics-production-e2e-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
