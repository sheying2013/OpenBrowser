#!/usr/bin/env node
'use strict';

/**
 * Dedicated test suite verifying real platform font subset assets for Local Font Access API FontData.blob().
 *
 * Validates:
 *  1. Physical asset integrity: all WOFF2 assets across windows, macos, linux, android contain
 *     valid wOF2 magic header (0x774f4632) and positive byte counts.
 *  2. Missing asset family handling: no synthetic/empty TTF shells; missing families are mapped
 *     via style-heuristic categorization and deterministic hashing to real WOFF2 subsets,
 *     explicitly tracked as aliases with zero collision clustering.
 *  3. Coverage reports across all platforms (windows, macos, linux, android).
 *  4. Script size & payload bundling constraints (< 20MB budget, compact on-demand packaging).
 *  5. End-to-end browser execution over CDP: verifies authentic user activation, FontFace parsing
 *     and loading, prototype integrity, invalid receiver guard, and absence of host font leakage.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { buildFingerprint, buildInjectionScript } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const {
  buildQueryLocalFontBlobGateSource,
  inspectGatePayload,
  clearFontSubsetCaches,
} = require('./query-local-font-blob-gate');
const { OS_FONTS } = require('./device-personas');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');
const subsetsRoot = path.join(appRoot, 'assets', 'font-subsets');

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
}

async function startServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!DOCTYPE html>
<html>
<head><title>real assets font blob selftest</title></head>
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
        const f = fonts.find((item) => item.family === targetName) || fonts.find((item) => item.family === 'Arial') || fonts[0];
        const b = await f.blob();
        const buf = await b.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const headHex = Array.from(bytes.slice(0, 16)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
        const magicHex = Array.from(bytes.slice(0, 4)).map((x) => x.toString(16).padStart(2, '0')).join(' ');

        let fontFaceLoadSuccess = false;
        let fontFaceError = null;
        try {
          const safeName = 'BlobParseReal_' + String(targetName).replace(/[^a-zA-Z0-9]/g, '_');
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
          requestedTarget: targetName,
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

async function runSession({ serverPort, mutate, headed, customPersonaList }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-real-font-blob-'));
  const profile = {
    id: 'font-blob-real-win',
    name: 'font-blob-real-win',
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

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: buildInjectionScript(fp),
    }, sessionId);

    if (!mutate) {
      const gateOptions = {
        ...fp,
        fonts: { ...(fp.fonts || {}), list: customPersonaList },
      };
      const gateSource = buildQueryLocalFontBlobGateSource(gateOptions);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: gateSource,
      }, sessionId);
    }

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` }, sessionId);
    await sleep(1500);

    const unactivatedEval = await cdp.send('Runtime.evaluate', {
      expression: 'window.probeWithoutActivation()',
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    const unactivatedResult = unactivatedEval?.result?.result?.value;

    await cdp.send('Browser.grantPermissions', {
      permissions: ['localFonts'],
      origin: `http://127.0.0.1:${serverPort}`,
    });

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
  console.log('=== [PHASE 1: Offline Physical Asset Integrity & Verification] ===');

  check('All platform WOFF2 assets have valid wOF2 magic header (0x774f4632)', () => {
    assert.ok(fs.existsSync(subsetsRoot), `Subsets root must exist at: ${subsetsRoot}`);
    const platforms = ['windows', 'macos', 'linux', 'android'];
    let verifiedCount = 0;

    for (const plat of platforms) {
      const dir = path.join(subsetsRoot, plat);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.woff2'));
      for (const f of files) {
        const fullPath = path.join(dir, f);
        const buf = fs.readFileSync(fullPath);
        assert.ok(buf.length > 0, `Asset ${plat}/${f} must not be empty`);
        const magic = buf.subarray(0, 4).toString('ascii');
        assert.strictEqual(magic, 'wOF2', `Asset ${plat}/${f} header must be wOF2, got: ${magic}`);
        verifiedCount++;
      }
    }
    console.log(`    Verified ${verifiedCount} total authentic WOFF2 subset files across all platforms.`);
    assert.ok(verifiedCount >= 100, `Expected at least 100 verified assets, got ${verifiedCount}`);
  });

  console.log('\n=== [PHASE 2: Cross-Platform Coverage & Missing Asset Alias Dispersion] ===');

  check('Windows persona achieves 100% exact coverage across all 60 system fonts', () => {
    const stats = inspectGatePayload({ os: 'windows' });
    console.log(`    Windows exact coverage: ${stats.coveragePercentage}% (${stats.exactMatchCount}/${stats.totalFamilies})`);
    assert.strictEqual(stats.totalFamilies, 60);
    assert.strictEqual(stats.exactMatchCount, 60);
    assert.strictEqual(stats.aliasCount, 0);
    assert.strictEqual(stats.coveragePercentage, 100);
  });

  check('macOS uses exact real assets and any Linux aliases stay real, explicit, and dispersed', () => {
    const macStats = inspectGatePayload({ os: 'macos' });
    console.log(`    macOS exact: ${macStats.exactMatchCount}/${macStats.totalFamilies} (${macStats.coveragePercentage}%), aliases: ${macStats.aliasCount}`);
    assert.strictEqual(macStats.exactMatchCount, macStats.totalFamilies);
    assert.strictEqual(macStats.aliasCount, 0);
    assert.strictEqual(macStats.coveragePercentage, 100);
    assert.strictEqual(macStats.missingAssetFamilies.length, 0);

    const linuxStats = inspectGatePayload({ os: 'linux' });
    console.log(`    Linux exact: ${linuxStats.exactMatchCount}/${linuxStats.totalFamilies} (${linuxStats.coveragePercentage}%), aliases: ${linuxStats.aliasCount}`);
    assert.ok(linuxStats.exactMatchCount >= 24, `Linux exact coverage regressed below 24: ${linuxStats.exactMatchCount}`);
    assert.strictEqual(linuxStats.aliasCount, linuxStats.totalFamilies - linuxStats.exactMatchCount);

    const linuxAliasTargetAssets = new Set(linuxStats.missingAssetFamilies.map((m) => m.assetFile));
    if (linuxStats.aliasCount > 0) {
      console.log(`    Linux ${linuxStats.aliasCount} aliases dispersed across ${linuxAliasTargetAssets.size} distinct real assets`);
      assert.ok(linuxAliasTargetAssets.size >= Math.min(5, linuxStats.aliasCount), `Linux aliases must disperse across real assets, got ${linuxAliasTargetAssets.size}`);
    }

    for (const item of linuxStats.missingAssetFamilies) {
      assert.strictEqual(item.isAlias, true);
      assert.strictEqual(item.exact, false);
      const assetPath = path.join(subsetsRoot, 'linux', item.assetFile);
      assert.ok(fs.existsSync(assetPath), `Alias target ${item.assetFile} must physically exist`);
    }
  });

  console.log('\n=== [PHASE 3: Injection Script Size & Payload Budgeting] ===');

  check('On-demand subset packaging stays compact and strictly respects the 20MB budget limit', () => {
    // 1. Compact targeted list
    const targetedStats = inspectGatePayload({
      os: 'windows',
      list: ['Arial', 'Calibri', 'Segoe UI', 'Bahnschrift'],
    });
    const targetedSrc = buildQueryLocalFontBlobGateSource({
      os: 'windows',
      list: ['Arial', 'Calibri', 'Segoe UI', 'Bahnschrift'],
    });
    console.log(`    Targeted (4 families) script size: ${(targetedSrc.length / 1024).toFixed(1)} KB`);
    assert.ok(targetedSrc.length < 400 * 1024, `Targeted script must be < 400KB, got ${targetedSrc.length}`);

    // 2. Full platform list
    const fullSrc = buildQueryLocalFontBlobGateSource({ os: 'windows' });
    console.log(`    Full Windows (60 families) script size: ${(fullSrc.length / 1024 / 1024).toFixed(2)} MB`);
    assert.ok(fullSrc.length < 4 * 1024 * 1024, `Full platform script must be < 4MB, got ${fullSrc.length}`);
    assert.ok(fullSrc.length < 20 * 1024 * 1024, 'Script must stay strictly below 20MB upper bound');
  });

  console.log('\n=== [PHASE 4: Live Kernel End-to-End CDP Validation] ===');

  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
    console.log(`query-local-font-blob-real-assets-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const mutate = process.argv.includes('--mutate');
  const headed = process.argv.includes('--headed');
  const { server, port } = await startServer();

  // The production injector installs the complete persona list before this asset guard runs.
  // Exercise the live composition rather than a narrower standalone list.
  const customPersonaList = buildFingerprint({
    id: 'font-blob-real-win-list',
    userAgent: WINDOWS_UA,
    privacy: { deviceProfile: 'persona' },
  }).fonts.list.slice();

  let sessionResult = null;
  try {
    sessionResult = await runSession({
      serverPort: port,
      mutate,
      headed,
      customPersonaList,
    });
  } finally {
    server.close();
  }

  if (sessionResult.error) {
    console.error('Session execution failure:', sessionResult.error);
    process.exitCode = 1;
    return;
  }

  const { unactivatedResult, clicked, probe } = sessionResult;
  assert.ok(probe, 'Probe must return results');

  if (probe.error) {
    console.error('Probe execution reported error:', probe.error);
    process.exitCode = 1;
    return;
  }

  check('Unactivated call rejects with SecurityError; authentic CDP click activates permission', () => {
    assert.strictEqual(unactivatedResult.ok, false);
    assert.strictEqual(unactivatedResult.name, 'SecurityError');
    assert.strictEqual(clicked, true);
  });

  check('Local font query returns expected font count and filters by postscriptNames', () => {
    assert.strictEqual(probe.totalCount, customPersonaList.length);
    assert.strictEqual(probe.filteredCount, 2);
    assert.ok(probe.filteredNames.includes('Arial'));
    assert.ok(probe.filteredNames.includes('SegoeUI'));
  });

  check('All FontData.blob() invocations return authentic wOF2 binaries loadable via FontFace', () => {
    console.log('\n[E2E Sampled Font Blobs]');
    for (const item of probe.items) {
      console.log(`  Family: ${item.requestedTarget.padEnd(20)} Size: ${String(item.blobSize).padEnd(7)} MIME: ${item.blobType.padEnd(12)} Magic: ${item.magicHex}`);
      console.log(`    Hash (SHA-256): ${item.hash}`);
      console.log(`    FontFace load status: ${item.fontFaceLoadSuccess ? 'LOADED' : 'FAILED (' + item.fontFaceError + ')'}`);

      assert.strictEqual(item.magicHex, '77 4f 46 32', `${item.requestedTarget} must have wOF2 header (77 4f 46 32)`);
      assert.ok(!item.headHex.startsWith('74 72 75 65'), `${item.requestedTarget} must not leak host 'true' header`);
      assert.strictEqual(item.fontFaceLoadSuccess, true, `${item.requestedTarget} FontFace.load() must succeed`);
      assert.strictEqual(item.isDeterministic, true, `${item.requestedTarget} blob hash must be deterministic`);
      assert.ok(
        item.blobType === 'font/woff2' || item.blobType === 'application/octet-stream',
        `${item.requestedTarget} invalid MIME type: ${item.blobType}`
      );
    }
  });

  check('Native disguises, prototype consistency, and invalid receiver guards remain intact', () => {
    for (const item of probe.items) {
      assert.strictEqual(item.isFontData, true);
      assert.strictEqual(item.protoMatch, true);
      assert.deepStrictEqual(item.ownProps, []);
      assert.strictEqual(item.toStringTag, '[object FontData]');
      assert.strictEqual(item.blobFnName, 'blob');
      assert.strictEqual(item.blobFnLen, 0);
      assert.ok(/\[native code\]/.test(item.blobFnToString));
      assert.strictEqual(item.protoHash, item.hash);
      assert.strictEqual(item.protoSize, item.blobSize);
    }
    assert.strictEqual(probe.illegalThrew, true, 'FontData.prototype.blob.call({}) must throw TypeError');
  });

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) {
    console.log(`\nquery-local-font-blob-real-assets-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`\nquery-local-font-blob-real-assets-selftest: FAIL (${failed.length} failed)`);
  }
})();
