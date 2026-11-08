#!/usr/bin/env node
'use strict';

/**
 * Static audit and regression verification for CDP Runtime surface hardening (N1).
 *
 * Verifies that production source files NEVER call or reference `Runtime.enable`.
 * CDP Runtime.enable activates V8 Inspector listeners which expose observable side-channels
 * (e.g. Proxy traps on console.*, microtask scheduling timing differences) allowing anti-bot
 * systems like DataDome, Cloudflare, and Kasada to detect browser automation.
 *
 * Audited production files:
 * - engine.js
 * - automation/fingerprint.js
 * - cdp.js
 * - automation/protocol/** (excluding test files)
 * - proxy-forwarder.js
 * - automation/local-api-server.js
 * - main.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');

const isMutateMode = process.argv.includes('--mutate') || process.env.MUTATE === '1';

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message || String(error) });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

function readSource(relPath) {
  const fullPath = path.join(appRoot, relPath);
  assert.ok(fs.existsSync(fullPath), `Production file must exist: ${relPath}`);
  return fs.readFileSync(fullPath, 'utf8');
}

function findRuntimeEnableMatches(source) {
  const lines = source.split(/\r?\n/);
  const matches = [];
  const regex = /\bRuntime\.enable\b/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Ignore pure comment lines if any
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (regex.test(line)) {
      matches.push({ line: i + 1, text: line.trim() });
    }
  }
  return matches;
}

// 1. engine.js
check('production engine.js contains 0 occurrences of Runtime.enable', () => {
  const source = readSource('engine.js');
  const matches = findRuntimeEnableMatches(source);
  assert.strictEqual(
    matches.length,
    0,
    `engine.js has ${matches.length} Runtime.enable references: ${JSON.stringify(matches)}`
  );
});

// 2. automation/fingerprint.js
check('production automation/fingerprint.js contains 0 occurrences of Runtime.enable', () => {
  const source = readSource('automation/fingerprint.js');
  const matches = findRuntimeEnableMatches(source);
  assert.strictEqual(
    matches.length,
    0,
    `fingerprint.js has ${matches.length} Runtime.enable references: ${JSON.stringify(matches)}`
  );
});

// 3. cdp.js
check('production cdp.js contains 0 occurrences of Runtime.enable', () => {
  const source = readSource('cdp.js');
  const matches = findRuntimeEnableMatches(source);
  assert.strictEqual(
    matches.length,
    0,
    `cdp.js has ${matches.length} Runtime.enable references: ${JSON.stringify(matches)}`
  );
});

// 4. automation/protocol/**
check('production automation/protocol/** modules contain 0 occurrences of Runtime.enable', () => {
  const protocolDir = path.join(appRoot, 'automation', 'protocol');
  const files = fs.readdirSync(protocolDir).filter((f) => {
    return f.endsWith('.js') && !f.includes('selftest') && !f.includes('audit');
  });
  assert.ok(files.length >= 5, `Expected multiple protocol modules, found ${files.length}`);
  for (const file of files) {
    const relPath = path.join('automation', 'protocol', file);
    const source = readSource(relPath);
    const matches = findRuntimeEnableMatches(source);
    assert.strictEqual(
      matches.length,
      0,
      `${relPath} has ${matches.length} Runtime.enable references: ${JSON.stringify(matches)}`
    );
  }
});

// 5. proxy-forwarder.js
check('production proxy-forwarder.js contains 0 occurrences of Runtime.enable', () => {
  const source = readSource('proxy-forwarder.js');
  const matches = findRuntimeEnableMatches(source);
  assert.strictEqual(
    matches.length,
    0,
    `proxy-forwarder.js has ${matches.length} Runtime.enable references: ${JSON.stringify(matches)}`
  );
});

// 6. automation/local-api-server.js
check('production automation/local-api-server.js contains 0 occurrences of Runtime.enable', () => {
  const source = readSource('automation/local-api-server.js');
  const matches = findRuntimeEnableMatches(source);
  assert.strictEqual(
    matches.length,
    0,
    `local-api-server.js has ${matches.length} Runtime.enable references: ${JSON.stringify(matches)}`
  );
});

// 7. main.js
check('production main.js contains 0 occurrences of Runtime.enable', () => {
  const source = readSource('main.js');
  const matches = findRuntimeEnableMatches(source);
  assert.strictEqual(
    matches.length,
    0,
    `main.js has ${matches.length} Runtime.enable references: ${JSON.stringify(matches)}`
  );
});

// 8. fontBlobBridge bindings do not invoke Runtime.enable before Runtime.addBinding
check('fontBlobBridge wiring in engine.js calls Runtime.addBinding directly without Runtime.enable', () => {
  const source = readSource('engine.js');
  // Confirm Runtime.addBinding is present
  assert.ok(source.includes('Runtime.addBinding'), 'engine.js must maintain Runtime.addBinding for fontBlobBridge');
  // Confirm that every Runtime.addBinding call site does NOT have Runtime.enable preceding it
  const addBindingIndices = [];
  let idx = source.indexOf('Runtime.addBinding');
  while (idx !== -1) {
    addBindingIndices.push(idx);
    idx = source.indexOf('Runtime.addBinding', idx + 1);
  }
  assert.ok(addBindingIndices.length >= 2, `Expected at least 2 Runtime.addBinding sites, found ${addBindingIndices.length}`);
  for (const pos of addBindingIndices) {
    const precedingBlock = source.slice(Math.max(0, pos - 200), pos);
    assert.ok(
      !precedingBlock.includes('Runtime.enable'),
      `Runtime.addBinding at index ${pos} preceded by Runtime.enable in block: ${precedingBlock}`
    );
  }
});

// 9. applyFingerprintToTab in fingerprint.js calls Page.enable directly without Runtime.enable
check('applyFingerprintToTab in fingerprint.js retains Page.enable without Runtime.enable', () => {
  const source = readSource('automation/fingerprint.js');
  const applyFnMatch = source.match(/async\s+function\s+applyFingerprintToTab[\s\S]*?\{([\s\S]*?)const\s+softOverride/);
  assert.ok(applyFnMatch, 'applyFingerprintToTab function preamble must be present');
  const preamble = applyFnMatch[1];
  assert.ok(preamble.includes("Page.enable"), 'preamble must retain Page.enable');
  assert.ok(!preamble.includes("Runtime.enable"), 'preamble must not call Runtime.enable');
});

// 10. Mutation sensitivity check
check('audit detector reliably catches synthetic Runtime.enable insertions', () => {
  const syntheticSource = 'async function foo() {\n  await cdp.call(url, "Runtime.enable", {});\n}';
  const matches = findRuntimeEnableMatches(syntheticSource);
  assert.strictEqual(matches.length, 1, 'findRuntimeEnableMatches must catch synthetic occurrence');
  assert.strictEqual(matches[0].line, 2);
});

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\ncdp-runtime-surface-selftest: FAIL ${results.length - failed.length}/${results.length}`);
  process.exitCode = 1;
} else {
  console.log(`\ncdp-runtime-surface-selftest: OK ${results.length}/${results.length}`);
}
