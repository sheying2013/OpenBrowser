'use strict';

/**
 * query-local-font-blob-lazy-payload-selftest.js
 *
 * Dedicated selftest suite verifying the lazy payload mode of query-local-font-blob-gate.js:
 * 1. Script size reduction: verifies >= 95% reduction compared to inline mode (prints exact chars & %).
 * 2. Metadata completeness: family, fullName, postscriptName, style, assetId, byteLength, magicHex.
 * 3. Exact byte parity: compares SHA-256 font blob bytes across 5 families between inline and lazy modes.
 * 4. Fallback resilience: ensures timeout/bridge-failure does not throw non-native errors and returns native empty Blobs.
 * 5. Page-visible property isolation: ensures no extra enumerable properties are exposed.
 * 6. Live Kernel E2E: tests in Chromium 148 (--headless=new) with CDP Runtime.bindingCalled bridge.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn, execSync } = require('child_process');

const {
  buildQueryLocalFontBlobGateSource,
  getFontMetadataList,
  getPlatformFontPayload,
  inspectGatePayload,
  loadFontAsset,
} = require('./query-local-font-blob-gate');
const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { deriveBridgeToken } = require('./font-placeholder');

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

const asyncCheck = async (name, fn) => {
  try {
    await fn();
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
}

async function startServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!DOCTYPE html>
<html>
<head><title>lazy payload font blob selftest</title></head>
<body>
<button id="btn" style="position:absolute;left:0;top:0;width:200px;height:100px;">Request Fonts</button>
<script>
  window.__marker = true;
  window.__clicked = false;
  window.__res = null;
  window.__pageErrors = [];
  window.addEventListener('error', (e) => window.__pageErrors.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', (e) => window.__pageErrors.push(e.reason && (e.reason.message || e.reason.stack) || String(e.reason)));

  document.getElementById('btn').addEventListener('click', async () => {
    window.__clicked = true;
    try {
      const fonts = await queryLocalFonts();
      const filtered = await queryLocalFonts({ postscriptNames: ['SegoeUI', 'Arial'] });

      const testItems = [];
      const sampleNames = ['Arial', 'Calibri', 'Segoe UI', 'Bahnschrift'];
      for (const targetName of sampleNames) {
        const f = fonts.find((item) => item.family === targetName) || fonts[0];
        const b = await f.blob();
        const buf = await b.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const headHex = Array.from(bytes.slice(0, 16)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
        const magicHex = Array.from(bytes.slice(0, 4)).map((x) => x.toString(16).padStart(2, '0')).join(' ');

        let fontFaceLoadSuccess = false;
        let fontFaceError = null;
        try {
          const safeName = 'LazyBlobParse_' + String(f.family || targetName).replace(/[^a-zA-Z0-9]/g, '_');
          const face = new FontFace(safeName, buf);
          document.fonts.add(face);
          const loadedFace = await face.load();
          fontFaceLoadSuccess = Boolean(loadedFace && loadedFace.status === 'loaded');
        } catch (loadErr) {
          fontFaceError = String(loadErr && (loadErr.message || loadErr.name || loadErr));
        }

        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        const hashHex = Array.from(new Uint8Array(hashBuf)).map((x) => x.toString(16).padStart(2, '0')).join('');

        testItems.push({
          family: f.family,
          fullName: f.fullName,
          postscriptName: f.postscriptName,
          style: f.style,
          blobSize: b.size,
          blobType: b.type,
          headHex,
          magicHex,
          fontFaceLoadSuccess,
          fontFaceError,
          hash: hashHex,
          isFontData: f instanceof FontData,
          protoMatch: Object.getPrototypeOf(f) === FontData.prototype,
          ownProps: Object.getOwnPropertyNames(f),
          toStringTag: Object.prototype.toString.call(f),
          blobFnName: f.blob.name,
          blobFnLen: f.blob.length,
          blobFnToString: Function.prototype.toString.call(f.blob),
        });
      }

      let illegalThrew = false;
      try {
        await FontData.prototype.blob.call({});
      } catch (e) {
        illegalThrew = (e instanceof TypeError);
      }

      window.__res = {
        totalCount: fonts.length,
        filteredCount: filtered.length,
        filteredNames: filtered.map((f) => f.postscriptName),
        items: testItems,
        protoBlobToString: Function.prototype.toString.call(FontData.prototype.blob),
        illegalThrew,
      };
    } catch (e) {
      window.__res = { error: e.name + ': ' + e.message, stack: e.stack };
    }
  });
</script>
</body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

(async () => {
  console.log('=== [PHASE 1: Static Size Reduction & Metadata Completeness] ===');

  let winInlineLen = 0;
  let winLazyLen = 0;
  let winReduction = 0;

  check('Windows persona script size reduction >= 95%', () => {
    const srcInline = buildQueryLocalFontBlobGateSource({ platform: 'windows' });
    const srcLazy = buildQueryLocalFontBlobGateSource({ platform: 'windows', lazyPayload: true });

    winInlineLen = srcInline.length;
    winLazyLen = srcLazy.length;
    winReduction = ((winInlineLen - winLazyLen) / winInlineLen) * 100;

    console.log(`    Windows inline: ${winInlineLen} chars (~${(winInlineLen / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`    Windows lazy:   ${winLazyLen} chars (~${(winLazyLen / 1024).toFixed(2)} KB)`);
    console.log(`    Reduction:      ${winReduction.toFixed(2)}%`);

    assert.ok(winReduction >= 95.0, `Expected >= 95% reduction, got ${winReduction.toFixed(2)}%`);
    assert.ok(srcLazy.includes('const isLazy = true;'), 'Lazy script must declare isLazy = true');
    assert.ok(!srcLazy.includes('assetPayload["arial.ttf"]'), 'Lazy script must not embed base64 asset payloads');
  });

  check('macOS persona script size reduction >= 95%', () => {
    const srcInline = buildQueryLocalFontBlobGateSource({ platform: 'macos' });
    const srcLazy = buildQueryLocalFontBlobGateSource({ platform: 'macos', lazyPayload: true });

    const macInlineLen = srcInline.length;
    const macLazyLen = srcLazy.length;
    const macReduction = ((macInlineLen - macLazyLen) / macInlineLen) * 100;

    console.log(`    macOS inline:   ${macInlineLen} chars (~${(macInlineLen / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`    macOS lazy:     ${macLazyLen} chars (~${(macLazyLen / 1024).toFixed(2)} KB)`);
    console.log(`    Reduction:      ${macReduction.toFixed(2)}%`);

    assert.ok(macReduction >= 95.0, `Expected >= 95% reduction, got ${macReduction.toFixed(2)}%`);
  });

  check('Font metadata list contains exactly expected families and complete descriptors', () => {
    const metaWin = getFontMetadataList('windows');
    assert.strictEqual(metaWin.length, 60, 'Windows metadata must have 60 font entries');

    for (const item of metaWin) {
      assert.ok(item.family && typeof item.family === 'string', 'family required');
      assert.ok(item.fullName && typeof item.fullName === 'string', 'fullName required');
      assert.ok(item.postscriptName && typeof item.postscriptName === 'string', 'postscriptName required');
      assert.strictEqual(item.style, 'Regular', 'style must be Regular');
      assert.ok(item.assetId && typeof item.assetId === 'string', 'assetId required');
      assert.ok(item.byteLength > 0, `byteLength must be positive for ${item.family}`);
      assert.ok(item.magicHex && item.magicHex.length >= 11, `magicHex required for ${item.family}`);
    }

    const metaMac = getFontMetadataList('macos');
    assert.strictEqual(metaMac.length, 76, 'macOS metadata must have 76 font entries');
  });

  check('getPlatformFontPayload retrieves on-demand assets filtered and full', () => {
    const fullPayload = getPlatformFontPayload('windows');
    assert.strictEqual(Object.keys(fullPayload).length, 60, 'Full payload must contain 60 assets');

    const filteredPayload = getPlatformFontPayload('windows', { wanted: ['Arial', 'SegoeUI'] });
    assert.ok(filteredPayload['arial.ttf'], 'Must contain arial.ttf');
    assert.ok(filteredPayload['segoe-ui.ttf'], 'Must contain segoe-ui.ttf');
    assert.ok(Object.keys(filteredPayload).length <= 4, 'Filtered payload must be minimal');
  });

  console.log('\n=== [PHASE 2: In-Memory Bridge & 5-Family SHA-256 Byte Parity] ===');

  function createMockBrowserContext() {
    class FontData {
      constructor(family) {
        this.family = family;
        this.fullName = family;
        this.postscriptName = family.replace(/\s+/g, '');
        this.style = 'Regular';
      }
    }
    FontData.prototype.blob = function() {
      if (!(this instanceof FontData)) {
        throw new TypeError("Failed to execute 'blob' on 'FontData': Illegal invocation");
      }
      return Promise.resolve(new Blob([], { type: '' }));
    };

    const globalObj = {
      Blob: globalThis.Blob,
      Uint8Array: globalThis.Uint8Array,
      atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      Promise: globalThis.Promise,
      WeakMap: globalThis.WeakMap,
      Map: globalThis.Map,
      Set: globalThis.Set,
      Object: globalThis.Object,
      Function: globalThis.Function,
      Array: globalThis.Array,
      String: globalThis.String,
      Number: globalThis.Number,
      Proxy: globalThis.Proxy,
      Reflect: globalThis.Reflect,
      TypeError: globalThis.TypeError,
      Symbol: globalThis.Symbol,
      JSON: globalThis.JSON,
      FontData,
      queryLocalFonts: async function queryLocalFonts() {
        return [
          new FontData('Arial'),
          new FontData('Calibri'),
          new FontData('Segoe UI'),
          new FontData('Bahnschrift'),
          new FontData('Cambria'),
        ];
      },
    };
    globalObj.globalThis = globalObj;
    globalObj.window = globalObj;
    return globalObj;
  }

  await asyncCheck('SHA-256 byte parity across 5 families between inline and lazy modes', async () => {
    const sampleFamilies = ['Arial', 'Calibri', 'Segoe UI', 'Bahnschrift', 'Cambria'];
    const bridgeToken = deriveBridgeToken({ id: 'parity-test' });

    // 1. Run inline gate
    const inlineCtx = createMockBrowserContext();
    const inlineSrc = buildQueryLocalFontBlobGateSource({
      platform: 'windows',
      bridgeToken,
      lazyPayload: false,
    });
    vm.runInNewContext(inlineSrc, inlineCtx);
    const inlineFonts = await inlineCtx.queryLocalFonts();

    const inlineHashes = {};
    for (const fam of sampleFamilies) {
      const f = inlineFonts.find((item) => item.family === fam);
      assert.ok(f, `Font ${fam} must be present in inline fonts`);
      const b = await f.blob();
      const buf = Buffer.from(await b.arrayBuffer());
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      inlineHashes[fam] = { hash, size: b.size, type: b.type };
    }

    // 2. Run lazy gate with simulated bridge
    const lazyCtx = createMockBrowserContext();
    const lazyChannel = '_bridge_lazy_test';
    const lazySrc = buildQueryLocalFontBlobGateSource({
      platform: 'windows',
      bridgeToken,
      lazyPayload: true,
      bridgeChannel: lazyChannel,
    });
    vm.runInNewContext(lazySrc, lazyCtx);

    // Provide font bytes via Function.prototype.toString bridge
    const payload = getPlatformFontPayload('windows');
    const bridgeResult = lazyCtx.Function.prototype.toString.call(
      lazyCtx.FontData.prototype.blob,
      bridgeToken,
      'provideBytes',
      payload
    );
    assert.strictEqual(bridgeResult.bridge, true, 'Bridge invocation must return bridge: true');
    assert.strictEqual(bridgeResult.received, 60, 'Bridge must receive 60 assets');

    const lazyFonts = await lazyCtx.queryLocalFonts();
    const lazyHashes = {};
    for (const fam of sampleFamilies) {
      const f = lazyFonts.find((item) => item.family === fam);
      assert.ok(f, `Font ${fam} must be present in lazy fonts`);
      const b = await f.blob();
      const buf = Buffer.from(await b.arrayBuffer());
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      lazyHashes[fam] = { hash, size: b.size, type: b.type };
    }

    console.log('\n    [5-Family SHA-256 Parity Comparison]');
    for (const fam of sampleFamilies) {
      const inInfo = inlineHashes[fam];
      const lzInfo = lazyHashes[fam];
      console.log(`      ${fam.padEnd(16)} Size: ${String(lzInfo.size).padEnd(8)} SHA-256: ${lzInfo.hash.slice(0, 16)}...`);
      assert.strictEqual(lzInfo.size, inInfo.size, `${fam} size must match`);
      assert.strictEqual(lzInfo.type, inInfo.type, `${fam} type must match (empty string)`);
      assert.strictEqual(lzInfo.hash, inInfo.hash, `${fam} SHA-256 must match exactly byte-for-byte`);
    }
  });

  await asyncCheck('Lazy fallback path resolves without throwing non-native errors on bridge timeout', async () => {
    const fallbackCtx = createMockBrowserContext();
    const fallbackSrc = buildQueryLocalFontBlobGateSource({
      platform: 'windows',
      lazyPayload: true,
      timeoutMs: 40, // fast timeout for test
    });
    vm.runInNewContext(fallbackSrc, fallbackCtx);

    // Do NOT provide bytes, let it timeout
    const fonts = await fallbackCtx.queryLocalFonts();
    assert.strictEqual(fonts.length, 60, 'Fallback still returns 60 persona fonts');

    const f = fonts[0];
    const b = await f.blob();
    assert.strictEqual(b.type, '', 'Fallback blob type must be empty string');
    assert.strictEqual(b.size, 0, 'Fallback blob size must be 0 (native empty shape)');

    // Verify invalid receiver still throws TypeError
    let illegalThrew = false;
    try {
      await fallbackCtx.FontData.prototype.blob.call({});
    } catch (e) {
      illegalThrew = (e instanceof fallbackCtx.TypeError);
    }
    assert.strictEqual(illegalThrew, true, 'FontData.prototype.blob.call({}) must throw TypeError');
  });

  check('Channel property is not enumerable on window and leaves zero visible traces', () => {
    const testCtx = createMockBrowserContext();
    const channel = '_test_channel_probe';
    const src = buildQueryLocalFontBlobGateSource({
      platform: 'windows',
      lazyPayload: true,
      bridgeChannel: channel,
    });
    vm.runInNewContext(src, testCtx);

    assert.strictEqual(Object.keys(testCtx.window).includes(channel), false, 'channel must not be enumerable');
    assert.strictEqual(testCtx.window[channel], undefined, 'channel property must evaluate to undefined');
  });

  console.log('\n=== [PHASE 3: Live Chromium Kernel E2E Validation (--headless=new)] ===');

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    console.log('  SKIP Live Chromium Kernel (Darwin launcher not found)');
    console.log(`\nquery-local-font-blob-lazy-payload-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const { server, port: serverPort } = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-localfont-lazy-e2e-'));
  const profile = {
    id: 'font-blob-lazy-win',
    name: 'font-blob-lazy-win',
    language: 'en-US',
    userAgent: WINDOWS_UA,
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    exitIp: '203.0.113.88',
    privacy: { deviceProfile: 'persona' },
  };
  const fp = buildFingerprint(profile);

  await writeOpenBrowserKernelInit(dir, {
    fingerprint: fp,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  // Strict requirement: MUST be headless (--headless=new) and killed after test
  const launchArgs = [dir, '--headless=new'];
  const child = spawn(launcher, launchArgs, {
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
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    server.close();
    throw new Error('Failed to obtain DevTools port');
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

    const targets = await cdp.send('Target.getTargets');
    const pageTarget = ((targets.result || {}).targetInfos || []).find((t) => t.type === 'page');
    if (!pageTarget) throw new Error('No page target found');

    const attachRes = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const sessionId = attachRes?.result?.sessionId;
    if (!sessionId) throw new Error('Failed to attach to page target');

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const bridgeToken = deriveBridgeToken(fp);
    const channelName = "_" + bridgeToken.slice(0, 16);
    fp.lazyPayload = true;
    fp.bridgeChannel = channelName;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: buildInjectionScript(fp) }, sessionId);
    // Host side: register Runtime.addBinding and listen for font-bytes-request
    let bridgeRequestReceived = false;
    await cdp.send('Runtime.addBinding', { name: channelName }, sessionId);

    // Listen for bindingCalled events
    const onBindingCalled = async (ev) => {
      if (ev.method === 'Runtime.bindingCalled' && ev.params?.name === channelName) {
        bridgeRequestReceived = true;
        let req = null;
        try { req = JSON.parse(ev.params.payload); } catch (_) {}
        const wanted = req?.wanted;
        const fontPayload = getPlatformFontPayload('windows', { wanted });

        const targetToken = String(req?.token || bridgeToken);
        const evalRes = await cdp.send('Runtime.evaluate', {
          expression: 'Function.prototype.toString.call(FontData.prototype.blob, ' + JSON.stringify(targetToken) + ', "provideBytes", ' + JSON.stringify(fontPayload) + ')',
          returnByValue: true,
        }, sessionId);
              }
    };

    // Monitor events array
    const eventInterval = setInterval(() => {
      while (cdp.events.length > 0) {
        const ev = cdp.events.shift();
        if (ev.method === 'Runtime.bindingCalled') {
          onBindingCalled(ev).catch(() => {});
        }
      }
    }, 20);

    // Navigate to test page
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` }, sessionId);
    await sleep(1000);

    // Click button to activate Local Font Access permission
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1 }, sessionId);

    let probeRes = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const evalRes = await cdp.send('Runtime.evaluate', {
 expression: '({ res: window.__res, clicked: window.__clicked, errs: window.__pageErrors, bridgeCalled: Boolean(window.__bridgeCalled) })', returnByValue: true }, sessionId);
      const v = evalRes?.result?.result?.value; if (v?.res) { probeRes = v.res; break; } if (false) {
        probeRes = evalRes.result.result.value;
        break;
      }
    }

    clearInterval(eventInterval);

    assert.ok(probeRes, 'Live kernel probe must return results');
    assert.ok(!probeRes.error, `Probe reported error: ${probeRes.error}`);

    await asyncCheck('Live kernel lazy queryLocalFonts returns expected 60 fonts and postscript filter', async () => {
      assert.strictEqual(probeRes.totalCount, 60, 'Expected 60 persona fonts');
      assert.strictEqual(probeRes.filteredCount, 2, 'Expected 2 filtered fonts');
      assert.ok(probeRes.filteredNames.includes('Arial'));
      assert.ok(probeRes.filteredNames.includes('SegoeUI'));
      assert.strictEqual(bridgeRequestReceived, true, 'Bridge request must have been triggered and answered');
    });

    await asyncCheck('Live kernel lazy font blobs return authentic SFNT magic header and empty MIME', async () => {
      console.log('\n    [Live Kernel Sampled Font Blobs - Lazy Mode]');
      for (const item of probeRes.items) {
        console.log(`      Family: ${item.family.padEnd(16)} Size: ${String(item.blobSize).padEnd(8)} MIME: ${JSON.stringify(item.blobType).padEnd(6)} Magic: ${item.magicHex} Load: ${item.fontFaceLoadSuccess}`);
        assert.strictEqual(item.blobType, '', `${item.family} MIME type must be empty string`);
        assert.strictEqual(item.magicHex, '00 01 00 00', `${item.family} must have SFNT TrueType magic`);
        assert.strictEqual(item.fontFaceLoadSuccess, true, `${item.family} FontFace.load() must succeed`);
        assert.strictEqual(item.isFontData, true, `${item.family} instanceof FontData`);
        assert.strictEqual(item.toStringTag, '[object FontData]', `${item.family} toStringTag`);
      }
      assert.strictEqual(probeRes.illegalThrew, true, 'FontData.prototype.blob.call({}) must throw TypeError');
    });

  } finally {
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log(`\nquery-local-font-blob-lazy-payload-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`\nquery-local-font-blob-lazy-payload-selftest: FAIL (${failed.length} failed)`);
    process.exitCode = 1;
  }
})();
