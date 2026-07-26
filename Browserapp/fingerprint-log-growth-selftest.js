'use strict';

// Guards the steady-state cost of fingerprint injection diagnostics.
//
// The watch loop re-runs applyRuntimeSettings for every running profile every ~2.4s. Before
// this guard, each pass wrote begin/skip-per-tab/end lines to an always-on, uncapped,
// append-only log — constant disk I/O plus every tab URL persisted forever. Two invariants:
//   1. when all live tabs already carry the inject, the pass is silent (no log writes)
//   2. the log rotates at a size cap instead of growing without bound

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const assert = require('assert');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  PASS  ' + n); passed += 1; };

(async () => {
  // --- 1. rotation caps the log ---
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fplog-'));
    const file = path.join(dir, 'fingerprint-inject.log');
    const { rotateIfOversized } = require('./automation/fingerprint-debug-log');

    await fsp.writeFile(file, 'x'.repeat(1000));
    ok('under the cap: no rotation', (await rotateIfOversized(file, 5000)) === false);
    ok('under the cap: original still present', fs.existsSync(file) && !fs.existsSync(file + '.1'));

    await fsp.writeFile(file, 'x'.repeat(6000));
    ok('over the cap: rotates', (await rotateIfOversized(file, 5000)) === true);
    ok('over the cap: backup created, primary cleared', fs.existsSync(file + '.1') && !fs.existsSync(file));

    ok('missing file never throws', (await rotateIfOversized(path.join(dir, 'nope.log'), 5000)) === false);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  // --- 2. steady-state injection pass writes nothing ---
  {
    // Point the log at a temp file, then drive applyRuntimeSettings with stubs where every
    // live tab is already in appliedTargetIds (the watch-loop steady state).
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fpsteady-'));
    const logFile = path.join(dir, 'fp.log');
    process.env.OPENBROWSER_FP_LOG = logFile;

    const cdp = require('./cdp');
    const { BrowserEngine } = require('./engine.js');
    const originalTabs = cdp.tabs;
    cdp.tabs = async () => ([
      { id: 'T1', url: 'https://example.com/a', webSocketDebuggerUrl: 'ws://127.0.0.1/1' },
      { id: 'T2', url: 'https://example.com/b', webSocketDebuggerUrl: 'ws://127.0.0.1/2' },
    ]);
    try {
      const profile = {
        id: 'steady', advanced: {}, privacy: {},
      };
      const ctx = { networkInfo: new Map() };
      const applied = new Set(['T1', 'T2']);          // both tabs already injected
      const tracked = {};
      const fingerprint = { userAgent: 'UA', platform: 'MacIntel' };

      await BrowserEngine.prototype.applyRuntimeSettings.call(
        ctx, 9222, profile, fingerprint,
        { appliedTargetIds: applied, trackOn: tracked, phase: 'watch-ensure' },
      );

      const wrote = fs.existsSync(logFile) ? (await fsp.readFile(logFile, 'utf8')).trim() : '';
      ok('steady-state pass writes no diagnostics', wrote === '');
      ok('steady-state still refreshes tracked state', tracked.fpAppliedTargets === applied && tracked.fingerprint === fingerprint);

      // A closed tab must be pruned so the set cannot grow forever.
      const stale = new Set(['T1', 'T2', 'GONE']);
      await BrowserEngine.prototype.applyRuntimeSettings.call(
        ctx, 9222, profile, fingerprint,
        { appliedTargetIds: stale, trackOn: {}, phase: 'watch-ensure' },
      );
      ok('closed targets are pruned from the applied set', !stale.has('GONE') && stale.size === 2);
    } finally {
      cdp.tabs = originalTabs;
      delete process.env.OPENBROWSER_FP_LOG;
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(`\nfingerprint-log-growth-selftest: ${passed} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error('fingerprint-log-growth-selftest FAILED:', e); process.exit(1); });
