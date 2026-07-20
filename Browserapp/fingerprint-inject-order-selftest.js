'use strict';

/**
 * Welcome-page fingerprint inject order + 148 meta spoof regressions.
 *   node fingerprint-inject-order-selftest.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
} = require('./automation/fingerprint');
const {
  fingerprintForNativeKernelInject,
  mapFingerprintToInitFields,
} = require('./automation/kernel-init-sync');

function main() {
  // --- engine start order: inject before keepDefaultTab ---
  const engineSrc = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
  const startIdx = engineSrc.indexOf('item.startupExtensionGuard');
  assert.ok(startIdx > 0, 'startup block present');
  const block = engineSrc.slice(startIdx, startIdx + 4500);
  // Match call sites only (not comments mentioning keepDefaultTab before inject).
  const injectPos = block.indexOf('await this.applyRuntimeSettings');
  const keepPos = block.indexOf('await this.keepDefaultTab');
  assert.ok(injectPos >= 0 && keepPos >= 0, 'both inject and keepDefaultTab call sites in start tail');
  assert.ok(injectPos < keepPos, 'applyRuntimeSettings must run before keepDefaultTab (welcome page race)');
  assert.ok(block.includes('Fingerprint inject BEFORE'), 'order comment present');
  // CLI must not open start page before CDP inject
  assert.ok(engineSrc.includes("args.push('about:blank')"), 'spawn must use about:blank instead of startUrl on CLI');
  assert.ok(engineSrc.includes('do NOT put the OpenBrowser start page') || engineSrc.includes('Do NOT put the OpenBrowser start page'), 'CLI startUrl deferral comment');
  // re-inject after navigate
  assert.ok(block.includes('start-page re-inject') || block.includes('appliedTargetIds: new Set()'), 're-inject after start page navigate');

  // applyFingerprintToTab enables Page domain
  const fpSrc = fs.readFileSync(path.join(__dirname, 'automation/fingerprint.js'), 'utf8');
  assert.ok(fpSrc.includes("invoke('Page.enable'") || fpSrc.includes('Page.enable'), 'Page.enable required before addScript');
  assert.ok(!/Runtime\.evaluate[\s\S]{0,80}\.catch\(\(\) => \{\}\)/.test(
    fpSrc.slice(fpSrc.indexOf('async function applyFingerprintToTab'))
  ), 'Runtime.evaluate must not swallow inject errors');

  // --- start-page re-samples fingerprint after inject settle ---
  const tpl = fs.readFileSync(path.join(__dirname, 'automation/start-page-template.js'), 'utf8');
  assert.ok(/setTimeout\(function\(\)\{collectFingerprint\([^)]*\)\},350\)/.test(tpl), 'welcome page must re-collect at 350ms');
  assert.ok(/setTimeout\(function\(\)\{collectFingerprint\([^)]*\)\},1200\)/.test(tpl), 'welcome page must re-collect at 1200ms');
  assert.ok(tpl.includes('/api/fingerprint-report'), 'welcome page must POST samples to fingerprint-report');

  // --- registerSession merges expectedFingerprint from engine ---
  const serverSrc = fs.readFileSync(path.join(__dirname, 'automation/start-page-server.js'), 'utf8');
  assert.ok(serverSrc.includes('extras.expectedFingerprint'), 'start-page server must accept full expected fingerprint');
  assert.ok(serverSrc.includes('webglVendor'), 'expectedFingerprint should include webglVendor');

  // --- buildStartPageUrl passes expectedFingerprint from buildFingerprint ---
  assert.ok(engineSrc.includes('expectedFingerprint:'), 'engine buildStartPageUrl must pass expectedFingerprint');
  assert.ok(engineSrc.includes('webglVendor:'), 'engine expected includes webgl vendor');

  // --- 148 native inject: pixel noise off, meta spoof on ---
  const fp = buildFingerprint({
    id: 'order-env-1',
    name: 'order',
    privacy: { canvas: 'noise', webgl: 'noise', webglMeta: 'noise', audio: 'noise' },
    kernelVersion: '148.0.7778.165',
  });
  assert.strictEqual(fp.webgl.mode, 'noise');
  assert.notStrictEqual(fp.webgl.metaMode, 'real');
  assert.ok(fp.webgl.vendor, 'seeded webgl vendor');

  const stripped = fingerprintForNativeKernelInject(fp);
  assert.strictEqual(stripped.canvas.mode, 'real');
  assert.strictEqual(stripped.webgl.mode, 'real');
  assert.notStrictEqual(stripped.webgl.metaMode, 'real');
  assert.ok(stripped.webgl.vendor || stripped.webgl.renderer);

  const mainInject = buildInjectionScript(stripped);
  assert.ok(mainInject.includes('0x9245') || mainInject.includes('UNMASKED_VENDOR'), 'main inject must patch WebGL UNMASKED_* even when mode=real');
  assert.ok(mainInject.includes('metaMode') || mainInject.includes('CFG.webgl.vendor'), 'meta spoof path present');

  const workerInject = buildWorkerInjectionScript(stripped);
  assert.ok(workerInject.includes('0x9245') || workerInject.includes('metaMode'), 'worker inject must keep meta spoof path');

  // init fields still map vendor for Framework
  const fields = mapFingerprintToInitFields(fp, { id: 'order-env-1', language: 'en-US' });
  assert.ok(fields.webgl_vendor || fields.webgl_renderer, 'init.json still gets webgl strings from full fingerprint');

  console.log('fingerprint-inject-order-selftest: ok');
}

main();
