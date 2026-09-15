#!/usr/bin/env node
'use strict';

/**
 * OpenBrowser Engine Full Pipeline E2E Selftest
 *
 * Exercises the end-to-end launch pipeline with a real Chromium kernel
 * using BrowserEngine + CDP runtime injection on a fresh Windows persona.
 *
 * In one single page execution, verifies all 10 core dimensions:
 *  1. navigator.platform === 'Win32' and navigator.userAgent includes 'Windows NT 10.0'
 *  2. Object.getOwnPropertySymbols(Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform').get).length === 0
 *  3. try { Navigator.prototype.platform } catch(e){ e.name } === 'TypeError'
 *  4. document.fonts.keys.toString() === 'function keys() { [native code] }'
 *  5. CanvasRenderingContext2D.prototype.getImageData has no own Symbols
 *  6. ServiceWorker postMessage reports platform === 'Win32'
 *  7. DedicatedWorker reports navigator.platform === 'Win32'
 *  8. Font lazy-load bridge: queryLocalFonts() returns fonts, FontData.blob() has magic 00 01 00 00
 *  9. Wire header order: sec-ch-ua precedes user-agent
 * 10. Sandboxed iframe (<iframe sandbox="allow-scripts">) reports platform === 'Win32'
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const appRoot = path.join(__dirname, '..');
const kernelRoot = path.join(appRoot, 'kernels', 'macos-x64');
const launcher = path.join(kernelRoot, 'launch_openbrowser.sh');

const { buildFingerprint } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const { BrowserEngine, RequestHeaderRewriter, CHROMIUM_CANONICAL_HEADER_ORDER } = require('../engine');
const cdp = require('../cdp');

// Independent, hand-maintained reference of the real Chrome navigation wire order.
// Deliberately NOT derived from engine's CHROMIUM_CANONICAL_HEADER_ORDER so the
// monotonic wire-order check below validates against an external spec instead of
// self-validating against the very constant under test. Verified against real Chrome
// req.rawHeaders on the loopback HTTP server: accept-language sits immediately after
// accept and before sec-fetch-*, with accept-encoding late (before cookie).
const EXPECTED_CHROMIUM_WIRE_ORDER = Object.freeze([
  'host',
  'connection',
  'cache-control',
  'pragma',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-model',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-form-factors',
  'sec-ch-ua-wow64',
  'upgrade-insecure-requests',
  'user-agent',
  'accept',
  'accept-language',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-user',
  'sec-fetch-dest',
  'sec-fetch-storage-access',
  'referer',
  'origin',
  'accept-encoding',
  'cookie',
  'priority',
]);
const EXPECTED_WIRE_INDEX = new Map(EXPECTED_CHROMIUM_WIRE_ORDER.map((name, i) => [name, i]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  console.log('================================================================');
  console.log('  OpenBrowser Engine Full Pipeline E2E Selftest');
  console.log('================================================================\n');

  let server = null;
  let child = null;
  let serverPort = null;
  let mainNavRawHeaders = null;
  let pageReport = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-pipeline-e2e-'));

  try {
    server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');

      const parsedUrl = new URL(req.url, `http://127.0.0.1:${serverPort || 80}`);
      const p = parsedUrl.pathname;

      if (p === '/') {
        mainNavRawHeaders = req.rawHeaders || [];
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Engine Full Pipeline E2E</title>
</head>
<body>
  <h1>Full Pipeline E2E</h1>
  <button id="runBtn" style="position:absolute;left:0;top:0;width:200px;height:100px;">Run Full Pipeline Checks</button>
  <iframe id="sbFrame" sandbox="allow-scripts" src="/sandbox.html" style="width:100px;height:100px;"></iframe>

  <script>
    window.__pageResults = null;
    let sbPlatform = null;

    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'sandbox-pong') {
        sbPlatform = e.data.platform;
      }
    });

    document.getElementById('runBtn').addEventListener('click', async () => {
      const results = {};

      try {
        // 1. Platform & UserAgent
        results.platform = navigator.platform;
        results.userAgent = navigator.userAgent;

        // 2. Navigator.prototype.platform getter own symbols
        const platDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
        results.platformGetterSymbolsCount = platDesc && platDesc.get
          ? Object.getOwnPropertySymbols(platDesc.get).length
          : -1;

        // 3. Illegal invocation error name on Navigator.prototype.platform
        try {
          const val = Navigator.prototype.platform;
          results.prototypePlatformError = 'no-error:' + val;
        } catch (e) {
          results.prototypePlatformError = e.name;
        }

        // 4. document.fonts.keys.toString()
        try {
          results.fontsKeysToString = document.fonts.keys.toString();
        } catch (e) {
          results.fontsKeysToString = 'error:' + e.message;
        }

        // 5. CanvasRenderingContext2D.prototype.getImageData own symbols
        results.getImageDataSymbolsCount = typeof CanvasRenderingContext2D !== 'undefined'
          ? Object.getOwnPropertySymbols(CanvasRenderingContext2D.prototype.getImageData).length
          : -1;

        // 6. ServiceWorker postMessage
        try {
          if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.register('/sw.js');
            await new Promise((resolve) => {
              if (reg.active) return resolve();
              const sw = reg.installing || reg.waiting;
              if (!sw) return resolve();
              sw.addEventListener('statechange', () => {
                if (sw.state === 'activated') resolve();
              });
              setTimeout(resolve, 2000);
            });

            const swTarget = reg.active || navigator.serviceWorker.controller;
            if (swTarget) {
              const swPromise = new Promise((resolve) => {
                const handler = (ev) => {
                  if (ev.data && ev.data.type === 'sw-pong') {
                    navigator.serviceWorker.removeEventListener('message', handler);
                    resolve(ev.data.platform);
                  }
                };
                navigator.serviceWorker.addEventListener('message', handler);
                setTimeout(() => resolve('timeout'), 3000);
              });
              swTarget.postMessage('ping');
              results.serviceWorkerPlatform = await swPromise;
            } else {
              results.serviceWorkerPlatform = 'no-active-sw';
            }
          } else {
            results.serviceWorkerPlatform = 'unsupported';
          }
        } catch (swErr) {
          results.serviceWorkerPlatform = 'error:' + swErr.message;
        }

        // 7. DedicatedWorker
        try {
          const dw = new Worker('/worker.js');
          const dwPromise = new Promise((resolve) => {
            dw.onmessage = (ev) => {
              if (ev.data && ev.data.type === 'worker-pong') {
                resolve(ev.data.platform);
              }
            };
            setTimeout(() => resolve('timeout'), 3000);
          });
          dw.postMessage('ping');
          results.dedicatedWorkerPlatform = await dwPromise;
          dw.terminate();
        } catch (dwErr) {
          results.dedicatedWorkerPlatform = 'error:' + dwErr.message;
        }

        // 8. Font Lazy Load Bridge (queryLocalFonts + FontData.blob)
        try {
          const qlf = window.queryLocalFonts || navigator.queryLocalFonts;
          if (typeof qlf !== 'function') {
            results.fontBridge = { error: 'queryLocalFonts unavailable' };
          } else {
            const fonts = await qlf();
            if (!fonts || !fonts.length) {
              results.fontBridge = { error: 'empty fonts array' };
            } else {
              const f0 = fonts[0];
              const blob = await f0.blob();
              const buf = await blob.arrayBuffer();
              const u8 = new Uint8Array(buf);
              const magic = Array.from(u8.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ');
              results.fontBridge = {
                count: fonts.length,
                family: f0.family,
                size: blob.size,
                magic: magic,
              };
            }
          }
        } catch (fontErr) {
          results.fontBridge = { error: fontErr.name + ': ' + fontErr.message };
        }

        // 10. Sandboxed iframe platform
        for (let i = 0; i < 20; i++) {
          if (sbPlatform) break;
          await new Promise(r => setTimeout(r, 100));
        }
        results.sandboxFramePlatform = sbPlatform || 'timeout';

        window.__pageResults = results;
        await fetch('/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(results),
        });
      } catch (topErr) {
        await fetch('/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fatalError: topErr.message, stack: topErr.stack }),
        });
      }
    });
  </script>
</body>
</html>`);
        return;
      }

      if (p === '/sandbox.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html><body>
<script>
  window.parent.postMessage({ type: 'sandbox-pong', platform: navigator.platform }, '*');
</script>
</body></html>`);
        return;
      }

      if (p === '/worker.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`
          self.onmessage = function(e) {
            if (e.data === 'ping') {
              self.postMessage({ type: 'worker-pong', platform: navigator.platform });
            }
          };
        `);
        return;
      }

      if (p === '/sw.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(`
          self.addEventListener('install', (e) => { self.skipWaiting(); });
          self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
          self.addEventListener('message', (e) => {
            if (e.data === 'ping') {
              e.source.postMessage({ type: 'sw-pong', platform: navigator.platform });
            }
          });
        `);
        return;
      }

      if (p === '/report' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            pageReport = JSON.parse(body);
          } catch (e) {
            pageReport = { parseError: e.message, raw: body };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    serverPort = server.address().port;

    const engine = new BrowserEngine({ getPath: () => dir });
    const profile = engine.sanitizeProfile({
      id: 'e2e-pipeline-profile',
      name: 'E2E Pipeline Test',
      platform: 'windows',
      os: 'windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    });
    const fp = buildFingerprint(profile);

    await writeOpenBrowserKernelInit(dir, {
      fingerprint: fp,
      profile,
      templatePath: path.join(kernelRoot, 'init_template.json'),
    });

    child = spawn(launcher, [dir, '--headless=new'], { cwd: kernelRoot, detached: true, stdio: 'ignore' });
    child.unref();

    let devToolsPort = null;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      try {
        devToolsPort = parseInt(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split('\n')[0], 10);
        if (devToolsPort > 0) break;
      } catch (_) {}
    }
    assert.ok(devToolsPort, 'DevToolsActivePort must be acquired');

    const item = { port: devToolsPort, profile, nativeKernelFingerprint: false };
    const engineConn = await engine.startWorkerFingerprintInjection(item, fp);

    // Grant localFonts permission
    await engineConn.command('Browser.grantPermissions', {
      permissions: ['localFonts'],
      origin: `http://127.0.0.1:${serverPort}`,
    }).catch(() => {});

    const tabs = await cdp.tabs(devToolsPort);
    const tabWs = tabs[0].webSocketDebuggerUrl;

    // Apply runtime settings
    await engine.applyRuntimeSettings(item.port, profile, fp, { trackOn: item });

    await cdp.call(tabWs, 'Page.enable', {});
    await cdp.call(tabWs, 'Page.navigate', { url: `http://127.0.0.1:${serverPort}/` });
    await sleep(1500);

    // Click button to execute full pipeline tests
    await cdp.call(tabWs, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 50, y: 50 });
    await cdp.call(tabWs, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 50, y: 50, button: 'left', clickCount: 1 });
    await cdp.call(tabWs, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 50, y: 50, button: 'left', clickCount: 1 });

    for (let i = 0; i < 50; i++) {
      await sleep(200);
      if (pageReport) break;
    }

    assert.ok(pageReport, 'Page report must be received via /report');
    assert.ok(!pageReport.fatalError, 'Page report must not contain fatalError: ' + pageReport.fatalError);

    // Evaluation of all 10 dimensions
    const results = [];
    const check = (desc, ok, details) => {
      results.push({ desc, ok, details });
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc} -> ${details}`);
    };

    // 1. platform and userAgent
    const c1 = pageReport.platform === 'Win32' && pageReport.userAgent.includes('Windows NT 10.0');
    check(
      '1. navigator.platform === "Win32" & userAgent contains "Windows NT 10.0"',
      c1,
      `platform="${pageReport.platform}", userAgent="${pageReport.userAgent}"`
    );

    // 2. Navigator.prototype.platform getter own symbols === 0
    const c2 = pageReport.platformGetterSymbolsCount === 0;
    check(
      '2. Object.getOwnPropertySymbols(Navigator.prototype.platform.get).length === 0',
      c2,
      `symbolsCount=${pageReport.platformGetterSymbolsCount}`
    );

    // 3. Illegal invocation throws TypeError
    const c3 = pageReport.prototypePlatformError === 'TypeError';
    check(
      '3. Navigator.prototype.platform illegal invocation throws TypeError',
      c3,
      `errorName="${pageReport.prototypePlatformError}"`
    );

    // 4. document.fonts.keys.toString() === 'function keys() { [native code] }'
    const c4 = pageReport.fontsKeysToString === 'function keys() { [native code] }';
    check(
      '4. document.fonts.keys.toString() === "function keys() { [native code] }"',
      c4,
      `actual="${pageReport.fontsKeysToString}"`
    );

    // 5. CanvasRenderingContext2D.prototype.getImageData has no own Symbols
    const c5 = pageReport.getImageDataSymbolsCount === 0;
    check(
      '5. CanvasRenderingContext2D.prototype.getImageData has zero own symbols',
      c5,
      `symbolsCount=${pageReport.getImageDataSymbolsCount}`
    );

    // 6. ServiceWorker postMessage reports platform === 'Win32'
    const c6 = pageReport.serviceWorkerPlatform === 'Win32';
    check(
      '6. ServiceWorker scope postMessage platform === "Win32"',
      c6,
      `swPlatform="${pageReport.serviceWorkerPlatform}"`
    );

    // 7. DedicatedWorker reports platform === 'Win32'
    const c7 = pageReport.dedicatedWorkerPlatform === 'Win32';
    check(
      '7. DedicatedWorker scope navigator.platform === "Win32"',
      c7,
      `dwPlatform="${pageReport.dedicatedWorkerPlatform}"`
    );

    // 8. Font lazy-load bridge: queryLocalFonts() returns fonts, blob magic is 00 01 00 00
    const fb = pageReport.fontBridge || {};
    const c8 = fb.count > 0 && fb.magic === '00 01 00 00' && fb.size > 0;
    check(
      '8. Font lazy-load bridge: queryLocalFonts() returns SFNT binary (magic 00 01 00 00)',
      c8,
      `count=${fb.count}, family="${fb.family}", size=${fb.size}, magic="${fb.magic}"`
    );

    // 9. Wire header order: hard assertions matching CHROMIUM_CANONICAL_HEADER_ORDER on live request
    const rawList = mainNavRawHeaders || [];
    const lowerHeaders = [];
    for (let i = 0; i < rawList.length; i += 2) {
      lowerHeaders.push(String(rawList[i]).toLowerCase());
    }
    const secChIdx = lowerHeaders.indexOf('sec-ch-ua');
    const uaIdx = lowerHeaders.indexOf('user-agent');
    const acceptIdx = lowerHeaders.indexOf('accept');
    const langIdx = lowerHeaders.indexOf('accept-language');

    // Canonical monotonic sequence check on live wire request, validated against the
    // INDEPENDENT EXPECTED_WIRE_INDEX (not the engine constant) to avoid self-validation.
    let canonicalMonotonic = true;
    let lastRank = -1;
    let rankViolations = [];
    for (const h of lowerHeaders) {
      if (EXPECTED_WIRE_INDEX.has(h)) {
        const currentRank = EXPECTED_WIRE_INDEX.get(h);
        if (currentRank < lastRank) {
          canonicalMonotonic = false;
          rankViolations.push(`${h} (rank ${currentRank}) appeared after rank ${lastRank}`);
        }
        lastRank = currentRank;
      }
    }

    const c9 = secChIdx !== -1 && uaIdx !== -1 && acceptIdx !== -1 &&
      secChIdx < uaIdx && uaIdx < acceptIdx && canonicalMonotonic;
    check(
      '9. Wire header order: full canonical sequence (sec-ch-ua < user-agent < accept < accept-language)',
      c9,
      `sec-ch-ua=${secChIdx}, user-agent=${uaIdx}, accept=${acceptIdx}, accept-language=${langIdx}, monotonic=${canonicalMonotonic}${rankViolations.length ? `, violations: ${rankViolations.join(', ')}` : ''}`
    );

    // 9-drift. Guard: engine's CHROMIUM_CANONICAL_HEADER_ORDER must not diverge from the
    // independent wire spec above. Catches array reordering that the monotonic check alone
    // cannot (the monotonic check would still pass against a drifted-but-self-consistent array).
    const engineOrder = (CHROMIUM_CANONICAL_HEADER_ORDER || []).map((h) => String(h).toLowerCase());
    const expectedOrder = EXPECTED_CHROMIUM_WIRE_ORDER.slice();
    const orderDrift = engineOrder.length !== expectedOrder.length
      ? [`length ${engineOrder.length} != ${expectedOrder.length}`]
      : engineOrder.reduce((acc, h, i) => {
          if (h !== expectedOrder[i]) acc.push(`[${i}] engine="${h}" expected="${expectedOrder[i]}"`);
          return acc;
        }, []);
    check(
      '9-drift. engine CHROMIUM_CANONICAL_HEADER_ORDER matches independent wire spec',
      orderDrift.length === 0,
      orderDrift.length ? orderDrift.slice(0, 4).join('; ') : 'in sync'
    );

    // Helper for wire header variations testing RequestHeaderRewriter
    const runHeaderRewriteSimulation = async (rewriterOpts, reqOpts) => {
      let forwardedHeaders = null;
      const fakeConn = {
        command: async (method, params) => {
          if (method === 'Fetch.continueRequest') {
            forwardedHeaders = params.headers;
          }
          return {};
        },
      };
      const rewriter = new RequestHeaderRewriter(rewriterOpts);
      rewriter.handleEvent({
        method: 'Fetch.requestPaused',
        sessionId: 'sim-s1',
        params: {
          requestId: 'sim-req-1',
          responseStatusCode: null,
          request: reqOpts,
        },
      }, fakeConn);
      await sleep(60);
      return forwardedHeaders || [];
    };

    // 9a. Variation: Without sec-ch-ua* (iOS Persona strictly omits sec-ch-ua* and preserves order)
    const iosHeaders = await runHeaderRewriteSimulation({
      profile: { os: 'iOS', platform: 'iOS', platformNav: 'iPhone', language: 'en-US' },
    }, {
      url: 'https://example.com/',
      headers: {
        'Host': 'example.com',
        'Connection': 'keep-alive',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        'Accept': 'text/html',
        'Accept-Language': 'en-US',
      },
    });
    const iosNames = iosHeaders.map(h => h.name.toLowerCase());
    const iosHasNoCh = iosNames.filter(n => n.startsWith('sec-ch-ua')).length === 0;
    const iosUaIdx = iosNames.indexOf('user-agent');
    const iosAcceptIdx = iosNames.indexOf('accept');
    const c9a = iosHasNoCh && iosUaIdx !== -1 && iosAcceptIdx !== -1 && iosUaIdx < iosAcceptIdx;
    check(
      '9a. Wire header variation: iOS persona strictly omits sec-ch-ua* and preserves order',
      c9a,
      `hasZeroSecChUa=${iosHasNoCh}, user-agent=${iosUaIdx}, accept=${iosAcceptIdx}`
    );

    // 9b. Variation: Without accept-language (e.g. OPTIONS preflight)
    const noLangHeaders = await runHeaderRewriteSimulation({
      profile: { os: 'Windows' },
    }, {
      method: 'OPTIONS',
      url: 'https://example.com/api',
      headers: {
        'Host': 'example.com',
        'Connection': 'keep-alive',
        'User-Agent': 'Host UA',
        'Accept': '*/*',
      },
    });
    const noLangNames = noLangHeaders.map(h => h.name.toLowerCase());
    const noLangAbsent = noLangNames.indexOf('accept-language') === -1;
    const noLangSecChIdx = noLangNames.indexOf('sec-ch-ua');
    const noLangUaIdx = noLangNames.indexOf('user-agent');
    const c9b = noLangAbsent && noLangSecChIdx !== -1 && noLangUaIdx !== -1 && noLangSecChIdx < noLangUaIdx;
    check(
      '9b. Wire header variation: without accept-language (OPTIONS) preserves sec-ch-ua < user-agent',
      c9b,
      `acceptLanguageAbsent=${noLangAbsent}, sec-ch-ua=${noLangSecChIdx}, user-agent=${noLangUaIdx}`
    );

    // 9c. Variation: Custom headers inserted retain order and deduplicate
    const customHeaders = await runHeaderRewriteSimulation({
      profile: { os: 'Windows', language: 'en-US' },
    }, {
      url: 'https://example.com/api',
      headers: {
        'Host': 'example.com',
        'X-Header-Alpha': 'val-1',
        'X-Header-Beta': 'val-2',
        'User-Agent': 'Host UA',
        'X-Header-Gamma': 'val-3',
        'x-header-alpha': 'val-dup',
        'Accept': 'application/json',
      },
    });
    const customNames = customHeaders.map(h => h.name.toLowerCase());
    const alphaIdx = customNames.indexOf('x-header-alpha');
    const betaIdx = customNames.indexOf('x-header-beta');
    const gammaIdx = customNames.indexOf('x-header-gamma');
    const alphaCount = customNames.filter(n => n === 'x-header-alpha').length;
    const c9c = alphaIdx !== -1 && betaIdx !== -1 && gammaIdx !== -1 &&
      alphaIdx < betaIdx && betaIdx < gammaIdx && alphaCount === 1;
    check(
      '9c. Wire header variation: custom headers preserve insertion order and deduplicate',
      c9c,
      `alpha=${alphaIdx}, beta=${betaIdx}, gamma=${gammaIdx}, alphaCount=${alphaCount}`
    );

    // 10. Sandboxed iframe platform === 'Win32'
    const c10 = pageReport.sandboxFramePlatform === 'Win32';
    check(
      '10. <iframe sandbox="allow-scripts"> frame platform === "Win32"',
      c10,
      `sandboxPlatform="${pageReport.sandboxFramePlatform}"`
    );

    console.log('\n================================================================');
    const allPassed = results.every(r => r.ok);
    const passCount = results.filter(r => r.ok).length;
    console.log(`  Selftest Summary: Total: ${results.length} | PASS: ${passCount} | FAIL: ${results.length - passCount}`);
    console.log('================================================================\n');

    if (!allPassed) {
      process.exitCode = 1;
    }
  } finally {
    if (child) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    if (server) {
      try { server.close(); } catch (_) {}
    }
  }
})();
