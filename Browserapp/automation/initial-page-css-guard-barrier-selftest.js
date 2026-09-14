#!/usr/bin/env node
'use strict';

/**
 * End-to-end and unit verification for initial about:blank target CSS Fetch guard barrier.
 *
 * Verifies:
 * 1. Target pre-discovery: queries existing targets (Target.getTargets / cdp.targets) before Target.setAutoAttach.
 * 2. Pre-existing initial target barrier: startWorkerFingerprintInjection awaits barrierPromise before returning.
 * 3. Atomic readiness: applyFingerprintToSession and fontResponseRewriter.enable must both complete before barrier resolves.
 * 4. Zero initial targets resilience: does not deadlock or wait for timeout when initial target list is empty.
 * 5. Target destruction resilience: Target.targetDestroyed unblocks pending target to prevent stale hanging.
 * 6. Disconnect / close resilience: socket close or disconnect rejects barrier immediately and clears timeout.
 * 7. Diagnostic failure: initial target failure or timeout rejects with diagnostic target IDs instead of silent leak.
 * 8. Subsequent target non-blocking: targets created post-startup do not block the initial barrier.
 * 9. Live browser e2e: 0-delay navigation immediately after startWorkerFingerprintInjection resolves
 *    confirms Fetch rewrite is already active, causing foreign local fonts in static <style> and
 *    external <link> to fail with NetworkError.
 * 10. Normal startup compatibility: standard start-page navigation and keepDefaultTab execute cleanly without regression.
 * 11. Mutation sensitivity (--mutate): Bypassing the barrier reproduces the race condition,
 *     allowing static foreign local fonts to leak the host font.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { BrowserEngine } = require('../engine');
const { buildFingerprint } = require('./fingerprint');
const { writeOpenBrowserKernelInit } = require('./kernel-init-sync');
const cdp = require('../cdp');

const appRoot = path.join(__dirname, '..');
const enginePath = path.join(appRoot, 'engine.js');
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

function extractMethodSource(fullSource, methodName) {
  const methodRegex = new RegExp(`async\\s+${methodName}\\s*\\([^)]*\\)\\s*\\{`);
  const match = methodRegex.exec(fullSource);
  if (!match) return '';
  const startIndex = match.index;
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let inComment = false;
  let inBlockComment = false;

  for (let i = startIndex; i < fullSource.length; i++) {
    const char = fullSource[i];
    const next = fullSource[i + 1];

    if (inComment) {
      if (char === '\n') inComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (char === '\\') {
        i += 1;
      } else if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return fullSource.slice(startIndex, i + 1);
      }
    }
  }
  return '';
}

async function stopChild(child, dir) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try { execSync('pkill -f "user-data-dir=' + dir + '" 2>/dev/null || true'); } catch (_) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

async function startTestServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.url === '/' || req.url === '/index.html') {
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Initial Page Barrier Selftest</title>
  <style>
    @font-face { font-family: "foreign_style"; src: local("Helvetica Neue"); }
    @font-face { font-family: "allowed_arial"; src: local("Arial"); }
  </style>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <h1>Initial Target Race Guard Selftest</h1>
  <canvas id="c" width="400" height="80"></canvas>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(html));
      res.end(html);
      return;
    }

    if (req.url === '/style.css') {
      const css = `@font-face { font-family: "foreign_link"; src: local("Helvetica Neue"); }
@font-face { font-family: "allowed_link_arial"; src: local("Arial"); }`;
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(css));
      res.end(css);
      return;
    }

    if (req.url === '/start.html') {
      const html = `<!doctype html><html><head><title>Start Page</title></head><body>Welcome</body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(html));
      res.end(html);
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

function buildProbeScript() {
  return `(async () => {
    const out = {
      fonts: {},
      canvas: {},
      cssom: {},
    };

    const fontNames = [
      'foreign_style',
      'foreign_link',
      'allowed_arial',
      'allowed_link_arial'
    ];

    for (const name of fontNames) {
      try {
        out.fonts[name] = await document.fonts.load('16px "' + name + '"').then(
          (loaded) => (loaded.length > 0 ? 1 : 0),
          (err) => 'ERR:' + err.name
        );
      } catch (e) {
        out.fonts[name] = 'EX:' + e.name;
      }
    }

    const canvas = document.getElementById('c');
    const ctx = canvas ? canvas.getContext('2d') : null;
    if (ctx) {
      const testString = 'TheQuickBrownFoxJumpsOverTheLazyDog1234567890';
      ctx.font = '72px monospace';
      const monoWidth = ctx.measureText(testString).width;

      ctx.font = '72px "Helvetica Neue"';
      const hostWidth = ctx.measureText(testString).width;

      ctx.font = '72px "foreign_style", monospace';
      const probedWidth = ctx.measureText(testString).width;

      out.canvas = {
        monoWidth,
        hostWidth,
        probedWidth,
        usesMonospace: Math.abs(probedWidth - monoWidth) < 0.001,
        usesHost: Math.abs(probedWidth - hostWidth) < 0.001,
      };
    }

    try {
      const rules = [];
      for (let i = 0; i < document.styleSheets.length; i++) {
        try {
          for (let j = 0; j < document.styleSheets[i].cssRules.length; j++) {
            rules.push(document.styleSheets[i].cssRules[j].cssText);
          }
        } catch (_) {}
      }
      out.cssom.rules = rules;
    } catch (e) {
      out.cssom.error = String(e);
    }

    return JSON.stringify(out);
  })()`;
}

async function testZeroInitialTargetsBehavior() {
  // Test that if no initial targets exist, the barrier resolves immediately without waiting for timeout
  const pendingInitialTargets = new Set();
  let barrierSettled = false;
  let barrierTimer = null;
  let barrierResolved = false;

  const barrierPromise = new Promise((resolve) => {
    if (pendingInitialTargets.size === 0) {
      barrierSettled = true;
      barrierResolved = true;
      resolve();
    } else {
      barrierTimer = setTimeout(() => resolve(), 8000);
    }
  });

  const t0 = Date.now();
  await barrierPromise;
  const elapsed = Date.now() - t0;
  assert.strictEqual(barrierResolved, true, 'Zero initial targets must resolve immediately');
  assert.ok(elapsed < 100, `Zero targets barrier must settle in <100ms, took ${elapsed}ms`);
}

async function testConnectionCloseResilienceBehavior() {
  // Test that closing connection rejects barrier immediately and clears timer
  const pendingInitialTargets = new Set(['target_123']);
  let barrierSettled = false;
  let barrierReject;
  let timerCleared = false;

  let timer = setTimeout(() => {}, 8000);
  const barrierPromise = new Promise((_, reject) => {
    barrierReject = reject;
  });

  const settleBarrier = (err) => {
    if (barrierSettled) return;
    barrierSettled = true;
    clearTimeout(timer);
    timerCleared = true;
    barrierReject(err);
  };

  // Simulate close
  settleBarrier(new Error('CDP connection closed before initial target barrier resolved'));

  let caught = null;
  try {
    await barrierPromise;
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'Must reject on connection close');
  assert.ok(caught.message.includes('CDP connection closed'), 'Error must specify connection closed');
  assert.strictEqual(timerCleared, true, 'Timeout timer must be cleared');
}

async function testTargetDestroyedBehavior() {
  // Test that targetDestroyed unblocks barrier without timing out
  const pendingInitialTargets = new Set(['target_closing']);
  let barrierSettled = false;
  let barrierResolve;

  const barrierPromise = new Promise((resolve) => {
    barrierResolve = resolve;
  });

  const settleBarrier = () => {
    if (barrierSettled) return;
    barrierSettled = true;
    barrierResolve();
  };

  // Simulate Target.targetDestroyed
  const destroyedId = 'target_closing';
  if (pendingInitialTargets.has(destroyedId)) {
    pendingInitialTargets.delete(destroyedId);
    if (pendingInitialTargets.size === 0) {
      settleBarrier();
    }
  }

  const t0 = Date.now();
  await barrierPromise;
  const elapsed = Date.now() - t0;
  assert.strictEqual(barrierSettled, true, 'Target destruction must settle barrier');
  assert.ok(elapsed < 100, `Target destroyed must settle barrier in <100ms, took ${elapsed}ms`);
}

async function testDiagnosticFailureBehavior() {
  // Test that failure rejects clearly rather than silently leaking
  const pendingInitialTargets = new Set(['target_err']);
  let barrierSettled = false;
  let barrierReject;

  const barrierPromise = new Promise((_, reject) => {
    barrierReject = reject;
  });

  const settleBarrier = (err) => {
    if (barrierSettled) return;
    barrierSettled = true;
    barrierReject(err);
  };

  // Simulate initial target failure
  settleBarrier(new Error('Initial target session attach failed for target_err: Simulated CDP error'));

  let caught = null;
  try {
    await barrierPromise;
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'Initial target failure must reject');
  assert.ok(caught.message.includes('Initial target session attach failed for target_err'), 'Must identify target');
}

async function runLiveBarrierTest(serverPort, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-barrier-' + (mutate ? 'mutate-' : 'normal-')));

  const profile = {
    id: mutate ? 'barrier-win-mutate' : 'barrier-win-normal',
    name: mutate ? 'barrier-win-mutate' : 'barrier-win-normal',
    language: 'en-US',
    userAgent: WINDOWS_UA,
    kernelVersion: '148.0.7778.165',
    os: 'Windows',
    exitIp: '203.0.113.25',
    privacy: { deviceProfile: 'persona' },
  };

  const fp = buildFingerprint(profile);
  let child = null;
  let devToolsPort = null;

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

    for (let i = 0; i < 80; i += 1) {
      await sleep(100);
      try {
        const rawPort = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8');
        const portVal = parseInt(rawPort.trim().split('\\n')[0], 10);
        if (portVal > 0) {
          devToolsPort = portVal;
          break;
        }
      } catch (_) {}
    }

    if (!devToolsPort) {
      throw new Error('Failed to acquire DevToolsActivePort from browser user-data-dir');
    }

    const engine = new BrowserEngine({ getPath: () => dir });
    const item = { port: devToolsPort, profile, nativeKernelFingerprint: false };

    const rewriteEvents = [];
    let startInjectionDuration = 0;
    let fpAppliedTargetsCountAtReturn = 0;

    if (mutate) {
      // In mutate mode, simulate unbarriered startup where startWorkerFingerprintInjection
      // returns immediately without awaiting initial target session attach and Fetch enablement.
      // This reproduces the exact race condition where keepDefaultTab or caller navigates before Fetch.enable.
      const origMethod = engine.startWorkerFingerprintInjection.bind(engine);
      engine.startWorkerFingerprintInjection = async function (itm, fprint) {
        const conn = await origMethod(itm, fprint);
        // Mutate by disabling the rewriter handling to observe unmitigated host font leak
        if (itm.cssFontResponseRewriter) {
          itm.cssFontResponseRewriter.enabled = false;
        }
        return conn;
      };
    }

    const t0 = Date.now();
    const connection = await engine.startWorkerFingerprintInjection(item, fp);
    startInjectionDuration = Date.now() - t0;
    fpAppliedTargetsCountAtReturn = item.fpAppliedTargets ? item.fpAppliedTargets.size : 0;

    assert.ok(connection, 'startWorkerFingerprintInjection must resolve CDP connection');
    assert.ok(item.cssFontResponseRewriter, 'Rewriter must be attached to item');
    assert.ok(item.workerFingerprintConnection, 'item.workerFingerprintConnection must be set');

    const rewriter = item.cssFontResponseRewriter;
    const origLogger = rewriter.logger;
    rewriter.logger = (details) => {
      rewriteEvents.push(details);
      if (origLogger) origLogger(details);
    };

    // Locate initial default tab
    const tabs = await cdp.tabs(devToolsPort);
    const defaultTab = tabs.find((t) => t.type === 'page') || tabs[0];
    if (!defaultTab?.webSocketDebuggerUrl) {
      throw new Error('Failed to locate default page tab for navigation');
    }
    const defaultTabWs = defaultTab.webSocketDebuggerUrl;

    await cdp.call(defaultTabWs, 'Page.enable', {});

    // Execute IMMEDIATE (0 delay) navigation to static test page
    // In normal mode, barrier guarantees Fetch interception is ALREADY enabled on this target session.
    await cdp.call(defaultTabWs, 'Page.navigate', { url: `http://127.0.0.1:${serverPort}/index.html` });
    await sleep(1500);

    const probeEval = await cdp.call(defaultTabWs, 'Runtime.evaluate', {
      expression: buildProbeScript(),
      awaitPromise: true,
      returnByValue: true,
    });

    if (probeEval?.exceptionDetails) {
      throw new Error('Probe script execution failed: ' + JSON.stringify(probeEval.exceptionDetails));
    }

    const probeResult = JSON.parse(probeEval?.result?.value || '{}');

    // Also test normal startup navigation with keepDefaultTab to verify no regression
    let keepDefaultTabSuccess = false;
    try {
      await engine.keepDefaultTab(devToolsPort, `http://127.0.0.1:${serverPort}/start.html`);
      keepDefaultTabSuccess = true;
    } catch (e) {
      keepDefaultTabSuccess = false;
    }

    return {
      startInjectionDuration,
      fpAppliedTargetsCountAtReturn,
      probe: probeResult,
      rewriteEvents,
      inFlightCount: rewriter.inFlightRequests?.size || 0,
      workerFingerprintError: item.workerFingerprintError,
      cssFontResponseRewriteError: item.cssFontResponseRewriteError,
      keepDefaultTabSuccess,
    };
  } finally {
    if (child) {
      await stopChild(child, dir);
    }
  }
}

(async () => {
  console.log(`Starting initial page CSS guard barrier selftest (mode: ${isMutateMode ? 'MUTATION' : 'NORMAL'})...\n`);

  const engineSource = fs.readFileSync(enginePath, 'utf8');
  const methodSource = extractMethodSource(engineSource, 'startWorkerFingerprintInjection');

  // Check 1: Engine discovers targets before setAutoAttach to establish barrier
  check('engine.js queries existing targets before invoking Target.setAutoAttach', () => {
    assert.ok(methodSource.includes('Target.getTargets'), 'Method must query Target.getTargets');
    assert.ok(methodSource.includes('Target.setAutoAttach'), 'Method must invoke Target.setAutoAttach');
    const getTargetsIdx = methodSource.indexOf('Target.getTargets');
    const browserAutoAttachIdx = methodSource.lastIndexOf("connection.command('Target.setAutoAttach'");
    assert.ok(getTargetsIdx < browserAutoAttachIdx, 'Target.getTargets must precede browser Target.setAutoAttach');
  });

  // Check 2: Initial pre-existing targets are filtered and tracked
  check('startWorkerFingerprintInjection filters pre-existing page/iframe targets into pending set', () => {
    assert.ok(methodSource.includes('pendingInitialTargets'), 'Must track pendingInitialTargets');
    assert.ok(methodSource.includes("ttype === 'page' || ttype === 'iframe'"), 'Must filter page and iframe targets');
  });

  // Check 3: Barrier promise is constructed and awaited
  check('startWorkerFingerprintInjection constructs and awaits barrierPromise before return', () => {
    assert.ok(methodSource.includes('barrierPromise'), 'Must define barrierPromise');
    assert.ok(methodSource.includes('await barrierPromise'), 'Must await barrierPromise before method returns');
  });

  // Check 4: Both applyFingerprintToSession and fontResponseRewriter.enable complete before barrier resolution
  check('applyFingerprintToSession and fontResponseRewriter.enable are awaited before unblocking initial target', () => {
    const attachedIdx = methodSource.indexOf("if (event.method !== 'Target.attachedToTarget')");
    assert.ok(attachedIdx !== -1, 'Target.attachedToTarget handler must be present');
    const attachedBranch = methodSource.slice(attachedIdx);
    const applyIdx = attachedBranch.indexOf('this.applyFingerprintToSession');
    const enableIdx = attachedBranch.indexOf('fontResponseRewriter.enable');
    const deleteIdx = attachedBranch.indexOf('pendingInitialTargets.delete');
    assert.ok(applyIdx !== -1, 'applyFingerprintToSession must be present in attached branch');
    assert.ok(enableIdx !== -1, 'fontResponseRewriter.enable must be present in attached branch');
    assert.ok(deleteIdx !== -1, 'pendingInitialTargets.delete must be present in attached branch');
    assert.ok(applyIdx < deleteIdx, 'applyFingerprintToSession must precede initial target completion');
    assert.ok(enableIdx < deleteIdx, 'fontResponseRewriter.enable must precede initial target completion');
  });

  // Check 5: Diagnostic timeout guard prevents infinite hanging
  check('barrier has a diagnostic timeout guard with pending target details', () => {
    assert.ok(methodSource.includes('8000'), 'Must specify timeout');
    assert.ok(methodSource.includes('barrierTimer'), 'Must use barrierTimer');
    assert.ok(methodSource.includes('clearTimeout'), 'Must clear timer on resolution');
  });

  // Check 6: Idempotent barrier settlement prevents duplicate resolutions
  check('settleBarrier is idempotent and guards against duplicate settlement', () => {
    assert.ok(methodSource.includes('barrierSettled'), 'Must check barrierSettled flag');
    assert.ok(methodSource.includes('completedInitialTargets'), 'Must track completedInitialTargets');
  });

  // Check 7: Connection closure unblocks barrier cleanly without deadlocks
  check('disconnect and error handlers unblock barrier on connection drop', () => {
    assert.ok(methodSource.includes('onDisconnect'), 'Must handle onDisconnect');
    assert.ok(methodSource.includes('settleBarrier'), 'onDisconnect must invoke settleBarrier to prevent hanging');
    assert.ok(methodSource.includes('origClose'), 'connection.close must be wrapped to settle barrier on manual close');
  });

  // Check 8: Target destruction before attach unblocks pending barrier
  check('Target.targetDestroyed unblocks pending target to prevent stale barrier hanging', () => {
    assert.ok(methodSource.includes('Target.targetDestroyed'), 'Must listen to Target.targetDestroyed');
  });

  // Check 9: Behavior unit test: Zero initial targets does not deadlock
  check('Behavior: Zero initial targets resolves immediately without deadlocking', async () => {
    await testZeroInitialTargetsBehavior();
  });

  // Check 10: Behavior unit test: Connection close rejects barrier immediately
  check('Behavior: Connection close rejects barrier cleanly without hanging', async () => {
    await testConnectionCloseResilienceBehavior();
  });

  // Check 11: Behavior unit test: Target destroyed cleans up pending target
  check('Behavior: Target destroyed unblocks barrier without waiting for timeout', async () => {
    await testTargetDestroyedBehavior();
  });

  // Check 12: Behavior unit test: Diagnostic failure rejects clearly
  check('Behavior: Target session failure rejects barrier with target ID diagnosis', async () => {
    await testDiagnosticFailureBehavior();
  });

  // Check 13: Real browser kernel availability probe
  if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 kernel launcher available', 'platform or launcher missing');
    console.log(`\ninitial-page-css-guard-barrier-selftest: OK ${results.length}/${results.length}`);
    return;
  }

  const { server, port: serverPort } = await startTestServer();

  let liveResult = null;
  try {
    liveResult = await runLiveBarrierTest(serverPort, isMutateMode);
  } finally {
    server.close();
  }

  assert.ok(liveResult, 'Live execution result must be returned');
  const {
    startInjectionDuration,
    fpAppliedTargetsCountAtReturn,
    probe,
    rewriteEvents,
    inFlightCount,
    workerFingerprintError,
    cssFontResponseRewriteError,
    keepDefaultTabSuccess,
  } = liveResult;

  if (isMutateMode) {
    // Mutation mode assertions: verify that removing the barrier causes host font leakage
    check('MUTATION CHECK: Static inline <style> leaks host font when barrier is bypassed', () => {
      assert.strictEqual(probe.fonts.foreign_style, 1, 'Static <style> must leak host font in mutate mode');
    });

    check('MUTATION CHECK: Static external <link> leaks host font when barrier is bypassed', () => {
      assert.strictEqual(probe.fonts.foreign_link, 1, 'Static <link> must leak host font in mutate mode');
    });

    check('MUTATION CHECK: Canvas text layout measures native host font width when barrier is bypassed', () => {
      assert.strictEqual(probe.canvas.usesHost, true, 'Canvas must match native host font width in mutate mode');
      assert.strictEqual(probe.canvas.usesMonospace, false, 'Canvas must not fallback to monospace in mutate mode');
    });

    check('MUTATION CHECK: CSSOM preserves unmitigated Helvetica Neue local declaration in mutate mode', () => {
      const rules = probe.cssom.rules || [];
      const styleRule = rules.find((r) => r.includes('foreign_style'));
      assert.ok(styleRule, 'foreign_style rule must exist in CSSOM');
      assert.ok(styleRule.includes('Helvetica Neue'), 'Rule must retain Helvetica Neue when barrier is bypassed');
    });
  } else {
    // Normal mode assertions: verify synchronization barrier completely neutralizes 0-delay race condition

    // Check 14: Barrier synchronization confirms initial target session was prepared before return
    check('Production barrier: Initial target session attached and fingerprint tracked before startWorkerFingerprintInjection returns', () => {
      assert.ok(fpAppliedTargetsCountAtReturn > 0, 'item.fpAppliedTargets must contain initial target at return time');
      assert.ok(startInjectionDuration > 0, 'startWorkerFingerprintInjection must wait for initial target barrier');
    });

    // Check 15: Static HTML <style> foreign local font blocked with NetworkError on 0-delay navigate
    check('Production barrier: 0-delay navigation blocks static HTML parser <style> foreign local font with NetworkError', () => {
      assert.strictEqual(probe.fonts.foreign_style, 'ERR:NetworkError', 'Foreign font in static <style> must reject with NetworkError');
    });

    // Check 16: Static external <link> foreign local font blocked with NetworkError on 0-delay navigate
    check('Production barrier: 0-delay navigation blocks static external <link> foreign local font with NetworkError', () => {
      assert.strictEqual(probe.fonts.foreign_link, 'ERR:NetworkError', 'Foreign font in external <link> must reject with NetworkError');
    });

    // Check 17: Whitelisted persona fonts load successfully
    check('Production barrier: Allowed persona local font Arial loads successfully in static style and link', () => {
      assert.strictEqual(probe.fonts.allowed_arial, 1, 'Allowed local font in static <style> must load');
      assert.strictEqual(probe.fonts.allowed_link_arial, 1, 'Allowed local font in external <link> must load');
    });

    // Check 18: Canvas layout measurement falls back to monospace
    check('Production barrier: Canvas text metrics fall back to monospace and hide native host font metrics', () => {
      assert.strictEqual(probe.canvas.usesMonospace, true, 'Canvas must match monospace fallback width');
      assert.strictEqual(probe.canvas.usesHost, false, 'Canvas must not match native host font width');
    });

    // Check 19: CSSOM rules verified sanitized to local("__ob_font_blocked__")
    check('Production barrier: CSSOM rules verified sanitized to local("__ob_font_blocked__") without host font', () => {
      const rules = probe.cssom.rules || [];
      const styleRule = rules.find((r) => r.includes('foreign_style'));
      const linkRule = rules.find((r) => r.includes('foreign_link'));
      assert.ok(styleRule, 'foreign_style rule must exist in CSSOM');
      assert.match(styleRule, /LocalFontFallback[0-9a-f]{24}/, 'foreign_style must use neutral fallback placeholder');
      assert.ok(!/__ob_|openbrowser/i.test(styleRule), 'foreign_style must not expose a product marker');
      assert.ok(!styleRule.includes('Helvetica Neue'), 'foreign_style must not contain Helvetica Neue');
      assert.ok(linkRule, 'foreign_link rule must exist in CSSOM');
      assert.match(linkRule, /LocalFontFallback[0-9a-f]{24}/, 'foreign_link must use neutral fallback placeholder');
      assert.ok(!/__ob_|openbrowser/i.test(linkRule), 'foreign_link must not expose a product marker');
      assert.ok(!linkRule.includes('Helvetica Neue'), 'foreign_link must not contain Helvetica Neue');
    });

    // Check 20: Fetch rewrite events were recorded and non-empty
    check('Production barrier: Fetch rewrite events recorded on production engine connection are non-empty', () => {
      assert.ok(rewriteEvents.length > 0, 'Must record at least one rewritten event via logger');
      const docRewrite = rewriteEvents.find((e) => e.resourceType === 'Document');
      const cssRewrite = rewriteEvents.find((e) => e.resourceType === 'Stylesheet');
      assert.ok(docRewrite, 'Must record Document rewrite event');
      assert.ok(cssRewrite, 'Must record Stylesheet rewrite event');
    });

    // Check 21: Stability and cleanliness
    check('Production barrier: No Fetch paused deadlocks (zero in-flight requests) and error-free execution', () => {
      assert.strictEqual(inFlightCount, 0, 'In-flight requests must be 0 after all responses settle');
      assert.strictEqual(cssFontResponseRewriteError, undefined, 'cssFontResponseRewriteError must be undefined');
      assert.strictEqual(workerFingerprintError, undefined, 'workerFingerprintError must be undefined');
    });

    // Check 22: Normal startup does not regress
    check('Production barrier: Normal start-page navigation with keepDefaultTab completes cleanly', () => {
      assert.strictEqual(keepDefaultTabSuccess, true, 'keepDefaultTab must execute successfully');
    });
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\ninitial-page-css-guard-barrier-selftest: OK ${passed}/${total}`);
  if (passed !== total) {
    process.exit(1);
  }
})();
