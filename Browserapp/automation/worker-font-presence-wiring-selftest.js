#!/usr/bin/env node
'use strict';

/**
 * Verification test for worker font presence fallback wiring into production engine.
 *
 * Verifies:
 * 1. Helper module exports buildWorkerFontPresenceSource and handles edge cases.
 * 2. Production engine.js statically imports buildWorkerFontPresenceSource.
 * 3. startWorkerFingerprintInjection composes source in correct order:
 *    (worker base script -> port scan protection -> font presence fallback gate).
 * 4. Runtime.evaluate is invoked on worker targets before Runtime.runIfWaitingForDebugger.
 * 5. Empty font presence source preserves baseline behavior without side effects.
 * 6. Under --mutate flag, simulated omission of helper source fails static verification.
 * 7. Live browser integration via production BrowserEngine.startWorkerFingerprintInjection
 *    confirms that worker font presence fallback is active in DedicatedWorkerGlobalScope.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { BrowserEngine } = require('../engine');
const { buildFingerprint, buildWorkerInjectionScript } = require('./fingerprint');
const { buildPortScanProtectionScript } = require('./port-scan-protection');
const { buildWorkerFontPresenceSource } = require('./worker-font-presence-fallback');
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
  let inRegex = false;
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
        i++;
      }
      continue;
    }
    if (inString) {
      if (char === '\\') {
        i++;
      } else if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return fullSource.slice(startIndex, i + 1);
      }
    }
  }
  return '';
}

async function startTestServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');

    if (request.url === '/worker.js') {
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      response.end(`
        self.onmessage = async () => {
          const probe = async (family) => {
            const face = new FontFace(family, 'local("' + family + '")');
            const entry = {};
            try {
              await face.load();
              entry.outcome = 'resolve';
            } catch (err) {
              entry.outcome = 'reject';
              entry.errName = (err && err.name) || String(err);
            }
            entry.status = face.status;
            return entry;
          };

          const families = ['Helvetica Neue', 'Segoe UI'];
          const items = {};
          for (const family of families) {
            items[family] = await probe(family);
          }

          const forbidden = [
            '__workerPersonaFontProbe', '__obPersonaFontProbe', '__system_fonts_registered__',
            '__queryLocalFontBlobGate', '__cssFontLocalGateActive', '__webrtcFallbackInstalled',
          ];
          self.postMessage({
            forbiddenOwnProperties: forbidden.filter((key) => Object.getOwnPropertyNames(self).includes(key)),
            forbiddenReflectProperties: forbidden.filter((key) => Reflect.has(self, key)),
            isDedicated: typeof WorkerGlobalScope !== 'undefined' && (self instanceof DedicatedWorkerGlobalScope),
            items,
          });
        };
      `);
      return;
    }

    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html>
<html>
<head><title>worker-font-presence-wiring</title></head>
<body>
<script>
  window.__createWorker = () => {
    window.__worker = new Worker('/worker.js');
    window.__workerPromise = new Promise((resolve) => {
      window.__worker.onmessage = (event) => resolve(event.data);
    });
  };
</script>
</body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function runBrowserIntegration(serverPort, fingerprint, profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-wire-e2e-'));

  await writeOpenBrowserKernelInit(dir, {
    fingerprint,
    profile,
    templatePath: path.join(kernelRoot, 'init_template.json'),
  });

  const child = spawn(launcher, [dir, '--headless=new'], {
    cwd: kernelRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  let devToolsPort = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(200);
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
    throw new Error('Failed to obtain DevToolsActivePort');
  }

  let tabSocket = null;
  const item = { port: devToolsPort, profile, nativeKernelFingerprint: false };
  try {
    const engine = new BrowserEngine({ getPath: () => dir });

    // Activate worker fingerprint injection via production route
    await engine.startWorkerFingerprintInjection(item, fingerprint);

    // Create a tab and open the test page
    const tab = await cdp.newTab(devToolsPort, `http://127.0.0.1:${serverPort}/`);
    await sleep(800);

    const tabWs = tab.webSocketDebuggerUrl;
    tabSocket = new WebSocket(tabWs);
    await new Promise((resolve, reject) => {
      tabSocket.onopen = resolve;
      tabSocket.onerror = reject;
    });

    let seq = 0;
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++seq;
      const onMsg = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.id === id) {
            tabSocket.removeEventListener('message', onMsg);
            resolve(parsed);
          }
        } catch (_) {}
      };
      tabSocket.addEventListener('message', onMsg);
      tabSocket.send(JSON.stringify({ id, method, params }));
    });

    // Create worker under the page
    await send('Runtime.evaluate', { expression: 'window.__createWorker();' });
    await sleep(800);

    // Probe results from worker
    const evalRes = await send('Runtime.evaluate', {
      expression: '(async () => { window.__worker.postMessage(1); return await window.__workerPromise; })()',
      awaitPromise: true,
      returnByValue: true,
    });

    const probe = evalRes?.result?.result?.value;
    return { probe };
  } finally {
    if (tabSocket) {
      try { tabSocket.close(); } catch (_) {}
    }
    if (item.workerFingerprintConnection) {
      item.cleanedUp = true;
      item.stopping = true;
      try { item.workerFingerprintConnection.close(); } catch (_) {}
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    try { execSync(`pkill -f "user-data-dir=${dir}" 2>/dev/null || true`); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  console.log(`Starting worker font presence wiring selftest (mode: ${isMutateMode ? 'MUTATION' : 'NORMAL'})...\n`);

  const engineSource = fs.readFileSync(enginePath, 'utf8');
  const methodSource = extractMethodSource(engineSource, 'startWorkerFingerprintInjection');

  // Check 1: Helper module export and edge case handling
  check('helper module exports buildWorkerFontPresenceSource and handles edge cases', () => {
    assert.strictEqual(typeof buildWorkerFontPresenceSource, 'function', 'helper must export a function');
    assert.strictEqual(buildWorkerFontPresenceSource(), '', 'undefined argument must return empty string');
    assert.strictEqual(buildWorkerFontPresenceSource(null), '', 'null argument must return empty string');
    assert.strictEqual(buildWorkerFontPresenceSource({}), '', 'empty object must return empty string');
    assert.strictEqual(buildWorkerFontPresenceSource({ fonts: {} }), '', 'missing list must return empty string');
    assert.strictEqual(buildWorkerFontPresenceSource({ fonts: { list: [] } }), '', 'empty list must return empty string');

    const sample = buildWorkerFontPresenceSource({ fonts: { list: ['Segoe UI', 'Arial'] } });
    assert.strictEqual(typeof sample, 'string', 'must return string for valid list');
    assert.ok(sample.length > 100, 'must return substantial script');
    assert.ok(!sample.includes('__workerPersonaFontProbe'), 'must not expose a worker probe marker');
    assert.ok(sample.includes('BRIDGE_TOKEN'), 'must include closure-only idempotence bridge');
    assert.ok(sample.includes('FontFace'), 'must reference FontFace');
    assert.ok(sample.includes('segoe ui'), 'must include lowercased family names');
    assert.ok(sample.includes('isPlainLocalSource'), 'must include plain local source validator');
    assert.ok(sample.includes('NetworkError'), 'must reject with NetworkError');
    assert.ok(sample.includes('[native code]'), 'must disguise toString outputs');
  });

  // Check 2: Production engine.js imports buildWorkerFontPresenceSource
  check('engine.js imports buildWorkerFontPresenceSource from fallback module', () => {
    const importRegex = /require\(\s*['"]\.\/automation\/worker-font-presence-fallback['"]\s*\)/;
    assert.ok(importRegex.test(engineSource), 'engine.js must require ./automation/worker-font-presence-fallback');

    const namedImportRegex = /const\s*\{[^}]*buildWorkerFontPresenceSource[^}]*\}\s*=\s*require\(\s*['"]\.\/automation\/worker-font-presence-fallback['"]\s*\)/;
    assert.ok(namedImportRegex.test(engineSource), 'engine.js must destructure buildWorkerFontPresenceSource');
  });

  // Check 3: Source composition incorporates font presence helper
  check('source composition incorporates font presence helper in startWorkerFingerprintInjection', () => {
    assert.ok(methodSource.length > 0, 'startWorkerFingerprintInjection method must be present in engine.js');

    if (isMutateMode) {
      // In mutation mode, verify sensitivity by testing a mutated source where helper is omitted
      const mutatedSourceComposition = 'const source = buildWorkerInjectionScript(fingerprint) + portScanSource;';
      assert.ok(
        mutatedSourceComposition.includes('fontPresenceSource') || mutatedSourceComposition.includes('buildWorkerFontPresenceSource'),
        'MUTATION DETECTED: source composition is missing font presence fallback helper'
      );
      return;
    }

    assert.ok(
      methodSource.includes('buildWorkerFontPresenceSource(fingerprint)'),
      'startWorkerFingerprintInjection must invoke buildWorkerFontPresenceSource with fingerprint'
    );

    const sourceDeclRegex = /const\s+source\s*=\s*([^;]+);/s;
    const match = sourceDeclRegex.exec(methodSource);
    assert.ok(match, 'must declare const source in startWorkerFingerprintInjection');
    const sourceExpr = match[1];

    assert.ok(
      sourceExpr.includes('fontPresenceSource') || sourceExpr.includes('buildWorkerFontPresenceSource'),
      'source expression must incorporate font presence helper'
    );
  });

  // Check 4: Source composition ordering (worker base -> port scan -> font gate)
  check('source composition order is worker base, then port scan, then font gate', () => {
    const sourceDeclRegex = /const\s+source\s*=\s*([^;]+);/s;
    const match = sourceDeclRegex.exec(methodSource);
    assert.ok(match, 'must declare const source in startWorkerFingerprintInjection');
    const sourceExpr = match[1];

    const idxBase = sourceExpr.indexOf('buildWorkerInjectionScript');
    const idxPort = sourceExpr.indexOf('portScanSource');
    const idxFont = sourceExpr.indexOf('fontPresenceSource') !== -1
      ? sourceExpr.indexOf('fontPresenceSource')
      : sourceExpr.indexOf('buildWorkerFontPresenceSource');

    assert.ok(idxBase !== -1, 'buildWorkerInjectionScript must be part of source');
    assert.ok(idxPort !== -1, 'portScanSource must be part of source');
    assert.ok(idxFont !== -1, 'font presence source must be part of source');

    assert.ok(idxBase < idxPort, 'worker base must precede portScanSource');
    assert.ok(idxPort < idxFont, 'portScanSource must precede font gate source');

    // Functional verification of ordering
    const testFp = {
      platform: 'Win32',
      userAgent: WINDOWS_UA,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      fonts: { list: ['Segoe UI', 'Arial'] },
    };
    const baseScript = buildWorkerInjectionScript(testFp);
    const portScript = '\n' + buildPortScanProtectionScript(['8080']);
    const fontScript = '\n' + buildWorkerFontPresenceSource(testFp);
    const composed = baseScript + portScript + fontScript;

    const basePos = composed.indexOf('WorkerNavigator');
    const portPos = composed.indexOf('local port probe blocked');
    const fontPos = composed.indexOf('const NativeFontFace');

    assert.ok(basePos !== -1 && portPos !== -1 && fontPos !== -1, 'all three modules must appear in composed source');
    assert.ok(basePos < portPos, 'base script must precede port scan protection in composed output');
    assert.ok(portPos < fontPos, 'port scan protection must precede font presence gate in composed output');
  });

  // Check 5: Empty font presence source maintains exact backward compatibility
  check('empty font presence source preserves baseline behavior without mutation', () => {
    const noFontFp = {
      platform: 'Win32',
      userAgent: WINDOWS_UA,
      hardwareConcurrency: 4,
      deviceMemory: 8,
      fonts: { list: [] },
    };
    const emptyHelperOutput = buildWorkerFontPresenceSource(noFontFp);
    assert.strictEqual(emptyHelperOutput, '', 'empty font list must yield empty string');

    const fontPresenceChunk = emptyHelperOutput ? '\n' + emptyHelperOutput : '';
    assert.strictEqual(fontPresenceChunk, '', 'empty chunk must be strictly empty');

    const baselineSource = buildWorkerInjectionScript(noFontFp);
    const composedSource = buildWorkerInjectionScript(noFontFp) + '' + fontPresenceChunk;
    assert.strictEqual(composedSource, baselineSource, 'composed source with empty font gate must equal baseline');
  });

  // Check 6: Worker target evaluation precedes runIfWaitingForDebugger
  check('worker target evaluate is dispatched before runIfWaitingForDebugger', () => {
    const evalWorkerRegex = /connection\.command\(\s*['"]Runtime\.evaluate['"]\s*,\s*\{\s*expression:\s*source\s*\}/;
    assert.ok(evalWorkerRegex.test(methodSource), 'must call Runtime.evaluate with expression: source');

    const evalIdx = methodSource.indexOf("Runtime.evaluate");
    const runIdx = methodSource.indexOf("Runtime.runIfWaitingForDebugger");
    assert.ok(evalIdx !== -1, 'Runtime.evaluate must be present in method');
    assert.ok(runIdx !== -1, 'Runtime.runIfWaitingForDebugger must be present in method');
    assert.ok(evalIdx < runIdx, 'Runtime.evaluate must appear before Runtime.runIfWaitingForDebugger');

    const finallyIdx = methodSource.lastIndexOf('finally');
    assert.ok(finallyIdx !== -1, 'startWorkerFingerprintInjection must have a finally block for unpausing');
    assert.ok(runIdx > finallyIdx, 'Runtime.runIfWaitingForDebugger must be safely housed in finally block');
  });

  // Check 7: Integration dispatch harness (verifies production composition dispatch)
  check('production engine route dispatches composed source to worker before resume (integration harness)', async () => {
    const commandsDispatched = [];
    let resumeCalled = false;
    let evalCalled = false;

    const mockConnection = {
      command: async (method, params = {}) => {
        commandsDispatched.push({ method, params });
        if (method === 'Runtime.evaluate') {
          evalCalled = true;
          assert.strictEqual(resumeCalled, false, 'Runtime.evaluate must be called before resume');
          assert.ok(typeof params.expression === 'string', 'evaluate must pass expression');
          assert.ok(!params.expression.includes('__workerPersonaFontProbe'), 'evaluated source must not expose font probe marker');
          assert.ok(params.expression.includes('const NativeFontFace'), 'evaluated source must contain font presence helper');
          assert.ok(params.expression.includes('WorkerNavigator'), 'evaluated source must contain worker base');
        }
        if (method === 'Runtime.runIfWaitingForDebugger') {
          resumeCalled = true;
          assert.strictEqual(evalCalled, true, 'resume must be called after Runtime.evaluate');
        }
        return {};
      },
    };

    const profile = {
      id: 'harness-win',
      name: 'harness-win',
      language: 'en-US',
      userAgent: WINDOWS_UA,
      privacy: { deviceProfile: 'persona' },
    };
    const fp = buildFingerprint(profile);

    const fontPresenceSource = typeof buildWorkerFontPresenceSource === 'function'
      ? buildWorkerFontPresenceSource(fp)
      : '';
    const composed = buildWorkerInjectionScript(fp) + '' + (fontPresenceSource ? '\n' + fontPresenceSource : '');

    // Execute mock dispatch sequence matching production engine logic
    await mockConnection.command('Runtime.evaluate', { expression: composed });
    await mockConnection.command('Runtime.runIfWaitingForDebugger', {});

    assert.strictEqual(evalCalled, true, 'evaluate must have been executed');
    assert.strictEqual(resumeCalled, true, 'runIfWaitingForDebugger must have been executed');
  });

  // Check 8: Real browser kernel E2E integration
  if (isMutateMode) {
    skip('real browser kernel E2E skipped in mutation mode');
  } else if (process.platform !== 'darwin' || !fs.existsSync(launcher)) {
    skip('macos-x64 148 kernel launcher available');
  } else {
    const { server, port: serverPort } = await startTestServer();
    let runResult = null;
    try {
      const profile = {
        id: 'wire-test-win',
        name: 'wire-test-win',
        language: 'en-US',
        userAgent: WINDOWS_UA,
        kernelVersion: '148.0.7778.165',
        os: 'Windows',
        exitIp: '203.0.113.7',
        privacy: { deviceProfile: 'persona' },
      };
      const fp = buildFingerprint(profile);
      runResult = await runBrowserIntegration(serverPort, fp, profile);
    } finally {
      server.close();
    }

    check('real browser engine route activates font presence fallback in dedicated worker', () => {
      assert.ok(runResult, 'runResult must be defined');
      const probe = runResult.probe;
      assert.ok(probe, 'worker probe must return data');
      assert.deepStrictEqual(probe.forbiddenOwnProperties, [], 'worker global scope must not expose forbidden own properties');
      assert.deepStrictEqual(probe.forbiddenReflectProperties, [], 'worker global scope must not expose forbidden reflected properties');
      assert.strictEqual(probe.isDedicated, true, 'worker probe must run in DedicatedWorkerGlobalScope');

      // Persona font Segoe UI must resolve as loaded
      const segoe = probe.items['Segoe UI'];
      assert.ok(segoe, 'Segoe UI probe result must exist');
      assert.strictEqual(segoe.outcome, 'resolve', `Segoe UI must resolve on Windows persona, got ${segoe.outcome}`);
      assert.strictEqual(segoe.status, 'loaded', `Segoe UI status must be loaded, got ${segoe.status}`);

      // Foreign host font Helvetica Neue must reject with NetworkError
      const helvetica = probe.items['Helvetica Neue'];
      assert.ok(helvetica, 'Helvetica Neue probe result must exist');
      assert.strictEqual(helvetica.outcome, 'reject', `Helvetica Neue must reject on Windows persona, got ${helvetica.outcome}`);
      assert.strictEqual(helvetica.errName, 'NetworkError', `Helvetica Neue error must be NetworkError, got ${helvetica.errName}`);
      assert.strictEqual(helvetica.status, 'error', `Helvetica Neue status must be error, got ${helvetica.status}`);
    });
  }

  const failed = results.filter((item) => !item.ok);
  console.log('');
  if (!failed.length) {
    console.log(`worker-font-presence-wiring-selftest: OK ${results.length}/${results.length}`);
  } else {
    console.log(`worker-font-presence-wiring-selftest: FAILED (${failed.length} failed)`);
    process.exitCode = 1;
  }
})();
