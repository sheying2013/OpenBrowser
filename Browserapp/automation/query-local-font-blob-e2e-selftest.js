#!/usr/bin/env node
'use strict';

/**
 * End-to-end selftest for Local Font Access API FontData.blob() isolation.
 *
 * Local Font Access API (queryLocalFonts) returns FontData entries. When a page has
 * user activation and calls queryLocalFonts(), invoking .blob() on the returned FontData
 * resolves to a binary font file Blob.
 *
 * In cross-platform personas (such as a Windows persona executed on macOS), unshielded
 * FontData.blob() invocations return the host system font file bytes. As a result, inspectable
 * properties (size, MIME type, first 16 bytes/magic header, and cryptographic hash) reveal
 * the host operating system font package (e.g. Apple TrueType 0x74727565 'true' header,
 * identical host font blobs across all persona fonts).
 *
 * This test drives the real 148 browser kernel over CDP, exercises authentic user activation
 * via Input.dispatchMouseEvent on an interactive page button, grants local-fonts permission,
 * and validates:
 *  1. Distinguishes authentic user activation from unactivated SecurityError rejection.
 *  2. Raw vs Injected comparison: injected gate replaces host font blobs with authentic,
 *     parseable, and loadable platform font subset WOFF2 binaries.
 *  3. queryLocalFonts returned font list arrives with expected persona count.
 *  4. postscriptNames filter option correctly narrows the returned list.
 *  5. FontData shape integrity: prototype chain, instanceof FontData, Object.prototype.toString,
 *     and zero own properties on FontData instances.
 *  6. Function disguises: f.blob and FontData.prototype.blob keep native code toString and [native code].
 *  7. blob() metadata: valid font MIME type, positive size, first 4 bytes match wOF2 magic
 *     (0x774f4632), deterministic hash per family, and distinct binaries across distinct families.
 *  8. In-browser FontFace parsing: new FontFace('...', await blob.arrayBuffer()).load() succeeds,
 *     verifying the returned font is fully valid and loadable rather than an empty synthetic shell.
 *  9. Windows persona blobs do not leak macOS host font package characteristics (no 'true' magic).
 * 10. FontData.prototype.blob.call(f) matches f.blob(), while illegal invocations throw TypeError.
 *
 * Supports --mutate to verify test sensitivity: disabling the gate exposes the host font byte leak.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { buildQueryLocalFontBlobGateSource, inspectGatePayload } = require('./query-local-font-blob-gate');

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
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!DOCTYPE html>
<html>
<head><title>queryLocalFonts blob gate selftest</title></head>
<body>
<button id="btn" style="position:absolute;left:0;top:0;width:200px;height:100px;">Request Fonts</button>
<script>
  window.__marker = true;
  window.__clicked = false;
  window.__res = null;
  window.__pageErrors = [];
  window.addEventListener('error', (e) => window.__pageErrors.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', (e) => window.__pageErrors.push(e.reason && (e.reason.message || e.reason.stack) || String(e.reason)));

  window.probeWithoutActivation = async () => {
    try {
      const fonts = await queryLocalFonts();
      return { ok: true, count: fonts.length };
    } catch (e) {
      return { ok: false, name: e.name, message: e.message };
    }
  };

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

        // Verify that the font binary is valid and parseable by the browser engine
        let fontFaceLoadSuccess = false;
        let fontFaceError = null;
        try {
          const safeName = 'BlobParse_' + String(f.family || targetName).replace(/[^a-zA-Z0-9]/g, '_');
          const face = new FontFace(safeName, buf);
          document.fonts.add(face);
          const loadedFace = await face.load();
          fontFaceLoadSuccess = Boolean(loadedFace && loadedFace.status === 'loaded');
        } catch (loadErr) {
          fontFaceError = String(loadErr && (loadErr.message || loadErr.name || loadErr));
        }

        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        const hashHex = Array.from(new Uint8Array(hashBuf)).map((x) => x.toString(16).padStart(2, '0')).join('');

        const bRepeat = await f.blob();
        const bufRepeat = await bRepeat.arrayBuffer();
        const hashBufRepeat = await crypto.subtle.digest('SHA-256', bufRepeat);
        const hashHexRepeat = Array.from(new Uint8Array(hashBufRepeat)).map((x) => x.toString(16).padStart(2, '0')).join('');

        let protoHashHex = null;
        let protoSize = null;
        try {
          const protoBlob = await FontData.prototype.blob.call(f);
          protoSize = protoBlob.size;
          const protoBuf = await protoBlob.arrayBuffer();
          const protoHashBuf = await crypto.subtle.digest('SHA-256', protoBuf);
          protoHashHex = Array.from(new Uint8Array(protoHashBuf)).map((x) => x.toString(16).padStart(2, '0')).join('');
        } catch (err) {
          protoHashHex = 'err:' + (err && err.name);
        }

        testItems.push({
          family: f.family,
          fullName: f.fullName,
          postscriptName: f.postscriptName,
          style: f.style,
          blobSize: b.size,
          blobType: b.type,
          headHex: headHex,
          magicHex: magicHex,
          fontFaceLoadSuccess: fontFaceLoadSuccess,
          fontFaceError: fontFaceError,
          hash: hashHex,
          hashRepeat: hashHexRepeat,
          isDeterministic: hashHex === hashHexRepeat,
          protoHash: protoHashHex,
          protoSize: protoSize,
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

async function runSession({ serverPort, mutate, headed }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-localfont-blob-'));
  const profile = {
    id: 'font-blob-win',
    name: 'font-blob-win',
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

  const launchArgs = [dir];
  if (!headed) {
    launchArgs.push('--headless=new');
  }

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

    const targets = await cdp.send('Target.getTargets');
    const pageTarget = ((targets.result || {}).targetInfos || []).find((t) => t.type === 'page');
    if (!pageTarget) {
      throw new Error('No page target found');
    }

    const attachRes = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    const sessionId = attachRes?.result?.sessionId;
    if (!sessionId) {
      throw new Error('Failed to attach to page target');
    }

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    // Injected scripts: always inject fingerprint.js baseline
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: buildInjectionScript(fp),
    }, sessionId);

    // When not mutated, inject the FontData.blob() isolation gate with real WOFF2 subsets
    if (!mutate) {
      const gateSource = buildQueryLocalFontBlobGateSource(fp);
      const gateStats = inspectGatePayload(fp);
      console.log('\n[Gate Injection Statistics]');
      console.log(`  Script size: ${gateSource.length} chars (~${(gateSource.length / 1024 / 1024).toFixed(2)} MB)`);
      console.log(`  Target platform: ${gateStats.platform}`);
      console.log(`  Covered families: ${gateStats.totalFamilies}`);
      console.log(`  Exact asset matches: ${gateStats.exactMatchCount}`);
      console.log(`  Alias mappings: ${gateStats.aliasCount}`);
      console.log(`  Coverage percentage: ${gateStats.coveragePercentage}%`);
      console.log(`  Unique asset files bundled: ${gateStats.uniqueAssetCount}`);
      console.log(`  Total WOFF2 binary payload: ${gateStats.totalWoff2Bytes} bytes (~${(gateStats.totalWoff2Bytes / 1024 / 1024).toFixed(2)} MB)`);

      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: gateSource,
      }, sessionId);
    }

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` }, sessionId);
    await sleep(1500);

    // Step 1: Probe without user activation or permission grant
    const unactivatedEval = await cdp.send('Runtime.evaluate', {
      expression: 'window.probeWithoutActivation()',
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    const unactivatedResult = unactivatedEval?.result?.result?.value;

    // Step 2: Grant local-fonts permission via CDP
    await cdp.send('Browser.grantPermissions', {
      permissions: ['localFonts'],
      origin: `http://127.0.0.1:${serverPort}`,
    });

    // Step 3: Dispatch CDP mouse events on the button to provide authentic transient activation
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 50 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 50, button: 'left', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 50, button: 'left', clickCount: 1 }, sessionId);

    let probe = null;
    let clicked = false;
    let pageErrors = [];
    const deadline = Date.now() + 10000;

    while (Date.now() < deadline) {
      const clickCheck = await cdp.send('Runtime.evaluate', {
        expression: 'window.__clicked',
        returnByValue: true,
      }, sessionId);
      clicked = Boolean(clickCheck?.result?.result?.value);

      const evalRes = await cdp.send('Runtime.evaluate', {
        expression: 'window.__res',
        returnByValue: true,
      }, sessionId);
      probe = evalRes?.result?.result?.value;

      const errCheck = await cdp.send('Runtime.evaluate', {
        expression: 'window.__pageErrors || []',
        returnByValue: true,
      }, sessionId);
      pageErrors = errCheck?.result?.result?.value || [];

      if (probe !== null && probe !== undefined) {
        break;
      }
      await sleep(100);
    }

    if (!probe) {
      console.error('DIAGNOSTIC FAILURE in ' + path.basename(file_path) + ':');
      console.error('  window.__clicked:', clicked);
      console.error('  window.__res:', probe);
      console.error('  page errors:', pageErrors);
    }

    return {
      unactivatedResult,
      clicked,
      probe,
    };
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
    console.log(`query-local-font-blob-e2e-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const mutate = process.argv.includes('--mutate');
  const headed = process.argv.includes('--headed');
  const { server, port } = await startServer();

  let sessionResult = null;
  try {
    sessionResult = await runSession({ serverPort: port, mutate, headed });
  } finally {
    server.close();
  }

  if (sessionResult.error) {
    console.error('Session execution failure:', sessionResult.error);
    process.exitCode = 1;
    return;
  }

  const { unactivatedResult, clicked, probe } = sessionResult;
  assert.ok(probe, 'FontData query probe must return data');

  if (probe.error) {
    console.error('Probe execution reported error:', probe.error);
    process.exitCode = 1;
    return;
  }

  console.log(`\n--- Execution Mode: ${mutate ? 'MUTATED (Gate Disabled)' : 'INJECTED (Gate Active)'} ---`);

  // Step 1: Distinction between SecurityError and User Activation
  check('unactivated queryLocalFonts rejects with SecurityError without user gesture or permission', () => {
    assert.ok(unactivatedResult, 'unactivated probe result must exist');
    assert.strictEqual(unactivatedResult.ok, false, 'unactivated call must fail');
    assert.strictEqual(unactivatedResult.name, 'SecurityError', `expected SecurityError, got ${unactivatedResult.name}`);
  });

  // Step 2: Confirmation of authentic CDP user gesture activation
  check('CDP mouse click generates authentic user activation on interactive element', () => {
    assert.strictEqual(clicked, true, 'page button click must register');
  });

  // Step 3: Local font query succeeds and returns persona font list
  check('queryLocalFonts resolves and returns persona font list', () => {
    assert.strictEqual(typeof probe.totalCount, 'number');
    assert.strictEqual(probe.totalCount, 60, `expected 60 persona fonts, got ${probe.totalCount}`);
  });

  // Step 4: postscriptNames filtering works
  check('queryLocalFonts postscriptNames filter option narrows returned list', () => {
    assert.strictEqual(probe.filteredCount, 2, `expected 2 filtered fonts, got ${probe.filteredCount}`);
    assert.ok(probe.filteredNames.includes('Arial'), 'filtered list must contain Arial');
    assert.ok(probe.filteredNames.includes('SegoeUI'), 'filtered list must contain SegoeUI');
  });

  // Print sample font blobs
  console.log('\n[Sampled FontData Blobs]');
  for (const item of probe.items) {
    console.log(`  Family: ${item.family.padEnd(14)} Size: ${String(item.blobSize).padEnd(7)} MIME: ${item.blobType.padEnd(24)} Header: ${item.headHex}`);
    console.log(`    Hash (SHA-256): ${item.hash}`);
    console.log(`    FontFace loadable: ${item.fontFaceLoadSuccess} (magic: ${item.magicHex})`);
  }
  console.log('');

  if (mutate) {
    // In mutation mode, verify and expose the raw host font leak
    const f0 = probe.items[0];
    const f1 = probe.items[1];
    const isHostHeader = f0.headHex.startsWith('74 72 75 65');
    const isClonedSize = f0.blobSize === f1.blobSize;
    const isClonedHash = f0.hash === f1.hash;

    console.log('[MUTATION VERIFICATION: Raw Host Font Leakage Exposed]');
    console.log(`  Header has Apple TrueType magic (0x74727565): ${isHostHeader} (${f0.headHex.slice(0, 11)})`);
    console.log(`  Shared host blob size across different fonts: ${isClonedSize} (${f0.blobSize} bytes)`);
    console.log(`  Shared host blob hash across different fonts: ${isClonedHash} (${f0.hash.slice(0, 16)}...)`);

    check('Windows persona font blobs do not leak macOS host font package characteristics', () => {
      assert.strictEqual(isHostHeader, false, `host font Apple TrueType magic leaked: ${f0.headHex}`);
      assert.strictEqual(isClonedSize, false, `host font size cloned across distinct fonts: ${f0.blobSize}`);
      assert.strictEqual(isClonedHash, false, `host font hash cloned across distinct fonts: ${f0.hash}`);
    });
  } else {
    // Normal / Injected assertions
    check('FontData instances retain native shape and leak no own properties', () => {
      for (const item of probe.items) {
        assert.strictEqual(item.isFontData, true, `${item.family} must be instanceof FontData`);
        assert.strictEqual(item.protoMatch, true, `${item.family} prototype must match FontData.prototype`);
        assert.deepStrictEqual(item.ownProps, [], `${item.family} must have no own properties`);
        assert.strictEqual(item.toStringTag, '[object FontData]', `${item.family} toString tag must be [object FontData]`);
      }
    });

    check('blob method and FontData prototype disguise function representations', () => {
      for (const item of probe.items) {
        assert.strictEqual(item.blobFnName, 'blob', `${item.family} blob method name must be 'blob'`);
        assert.strictEqual(item.blobFnLen, 0, `${item.family} blob method length must be 0`);
        assert.ok(/\[native code\]/.test(item.blobFnToString), `${item.family} blob method toString must look native`);
      }
      assert.ok(/\[native code\]/.test(probe.protoBlobToString), 'FontData.prototype.blob toString must look native');
    });

    check('FontData.prototype.blob.call maintains parity and guards invalid receiver', () => {
      for (const item of probe.items) {
        assert.strictEqual(item.protoHash, item.hash, `${item.family} prototype blob hash must match direct blob hash`);
        assert.strictEqual(item.protoSize, item.blobSize, `${item.family} prototype blob size must match direct blob size`);
      }
      assert.strictEqual(probe.illegalThrew, true, 'FontData.prototype.blob.call({}) must throw TypeError');
    });

    check('blob output is deterministic with valid font MIME type', () => {
      for (const item of probe.items) {
        assert.ok(
          item.blobType === 'font/woff2' || item.blobType === 'application/octet-stream',
          `${item.family} blob MIME type must be font/woff2 or application/octet-stream, got ${item.blobType}`
        );
        assert.ok(item.blobSize > 0, `${item.family} blob size must be positive`);
        assert.strictEqual(item.isDeterministic, true, `${item.family} blob hash must be deterministic across repeated calls`);
      }
    });

    check('Windows persona font blobs are authentic parseable WOFF2 binaries and do not leak macOS host artifacts', () => {
      for (const item of probe.items) {
        // Assert wOF2 header magic (0x774f4632)
        assert.strictEqual(item.magicHex, '77 4f 46 32', `${item.family} header must start with wOF2 magic (77 4f 46 32), got ${item.magicHex}`);
        // Assert absence of host macOS Apple TrueType header (0x74727565 'true')
        assert.ok(!item.headHex.startsWith('74 72 75 65'), `${item.family} header must not contain Apple 'true' tag`);
        // Assert successful in-browser FontFace parsing and loading
        assert.strictEqual(item.fontFaceLoadSuccess, true, `${item.family} FontFace load must succeed: ${item.fontFaceError}`);
      }

      // Distinct families must have distinct sizes and hashes (authentic diverse binaries)
      const f0 = probe.items[0]; // Arial
      const f1 = probe.items[1]; // Calibri
      const f2 = probe.items[2]; // Segoe UI
      assert.notStrictEqual(f0.blobSize, f1.blobSize, 'Arial and Calibri must have distinct blob sizes');
      assert.notStrictEqual(f0.hash, f1.hash, 'Arial and Calibri must have distinct blob hashes');
      assert.notStrictEqual(f1.hash, f2.hash, 'Calibri and Segoe UI must have distinct blob hashes');
    });
  }

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`\nquery-local-font-blob-e2e-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`\nquery-local-font-blob-e2e-selftest: FAIL (${failed.length} failed)`);
  }
})();
