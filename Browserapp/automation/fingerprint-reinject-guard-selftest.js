'use strict';

// Guards the re-inject contract of the runtime fingerprint pass.
//
// The injector wraps the live readers, so running an identical config over the same document twice
// adds a second layer of noise and moves canvas / clientRects while the profile is already in use.
// The launch sequence drives two passes back to back (before and after the start page) and the watch
// loop keeps sweeping, so those repeats must not reach the injector:
//   1. same config + recorded hash  -> no inject at all
//   2. same config, no recorded hash -> still trusted (callers that do not track a hash)
//   3. different config              -> every live tab is re-applied, then tracked stays quiet

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  PASS  ' + name); passed += 1; };

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fpreinject-'));
  process.env.OPENBROWSER_FP_LOG = path.join(dir, 'fp.log');

  // Swap the injector for a spy before the engine captures its imports, so counting "did the
  // runtime decide to inject" never needs a live browser.
  const fpPath = require.resolve('./fingerprint');
  const realFingerprint = require(fpPath);
  const injectCalls = [];
  require.cache[fpPath] = {
    id: fpPath,
    filename: fpPath,
    loaded: true,
    exports: {
      ...realFingerprint,
      applyFingerprintToTab: async (...args) => { injectCalls.push(args); },
    },
  };

  const cdp = require('../cdp');
  const { BrowserEngine } = require('../engine.js');

  const originalTabs = cdp.tabs;
  const originalCall = cdp.call;
  const tabs = [
    { id: 'T1', url: 'https://example.com/a', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/1' },
    { id: 'T2', url: 'https://example.com/b', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/2' },
  ];
  cdp.tabs = async () => tabs;
  cdp.call = async () => ({ result: { value: null } });

  const run = (fingerprint, options) => BrowserEngine.prototype.applyRuntimeSettings.call(
    { networkInfo: new Map() }, 9222, { id: 'reinject', advanced: {}, privacy: {} }, fingerprint, options,
  );

  try {
    const tracked = {};
    const fpA = { userAgent: 'UA-A', platform: 'Win32', hardwareConcurrency: 8 };
    const fpB = { userAgent: 'UA-B', platform: 'Win32', hardwareConcurrency: 8 };

    await run(fpA, { appliedTargetIds: new Set(), trackOn: tracked, phase: 'pre-startpage' });
    ok('first pass injects every live tab', injectCalls.length === 2);
    ok('first pass records the config hash', typeof tracked.fpAppliedHash === 'string' && tracked.fpAppliedHash.length > 0);
    ok('first pass records every tab', tracked.fpAppliedTargets instanceof Set && tracked.fpAppliedTargets.size === 2);

    injectCalls.length = 0;
    await run(fpA, {
      appliedTargetIds: tracked.fpAppliedTargets,
      appliedFingerprintHash: tracked.fpAppliedHash,
      trackOn: tracked,
      phase: 'post-startpage',
    });
    ok('identical config after the start page does not re-inject', injectCalls.length === 0);
    ok('re-inject guard still refreshes tracked state', tracked.fpAppliedTargets.size === 2 && tracked.fpAppliedHash.length > 0);

    injectCalls.length = 0;
    await run(fpA, {
      appliedTargetIds: tracked.fpAppliedTargets,
      trackOn: tracked,
      phase: 'watch-ensure',
    });
    ok('a caller that records no hash keeps the tracked cache', injectCalls.length === 0);

    injectCalls.length = 0;
    const previousHash = tracked.fpAppliedHash;
    await run(fpB, {
      appliedTargetIds: tracked.fpAppliedTargets,
      appliedFingerprintHash: previousHash,
      trackOn: tracked,
      phase: 'watch-ensure',
    });
    ok('a different config re-applies every live tab', injectCalls.length === 2);
    ok('a different config replaces the recorded hash', tracked.fpAppliedHash !== previousHash);

    injectCalls.length = 0;
    await run(fpB, {
      appliedTargetIds: tracked.fpAppliedTargets,
      appliedFingerprintHash: tracked.fpAppliedHash,
      trackOn: tracked,
      phase: 'watch-ensure',
    });
    ok('the re-applied config is trusted on the next sweep', injectCalls.length === 0);

    const log = fs.existsSync(process.env.OPENBROWSER_FP_LOG)
      ? await fsp.readFile(process.env.OPENBROWSER_FP_LOG, 'utf8')
      : '';
    ok('guard passes stay out of the diagnostic log', !log.includes('"phase":"watch-ensure"') || log.split('\n').filter(Boolean).length < 40);
  } finally {
    cdp.tabs = originalTabs;
    cdp.call = originalCall;
    delete process.env.OPENBROWSER_FP_LOG;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\nfingerprint-reinject-guard-selftest: ${passed} checks passed.`);
  process.exit(0);
})().catch((error) => {
  console.error('fingerprint-reinject-guard-selftest FAILED:', (error && error.stack) || error);
  process.exit(1);
});
