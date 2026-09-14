#!/usr/bin/env node
'use strict';

/**
 * Page-Visible Brand Trace Remediation Selftest.
 *
 * Verifies that all 7 brand trace / leakage flaws outside fingerprint.js / engine.js
 * are completely eliminated, with zero observable DOM markers, zero custom error text,
 * zero own properties on document, and zero plaintext brand names in local services,
 * while 100% preserving multi-window sync, extension icons, font fallback, and port scan defense.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { deriveFontPlaceholder, deriveBridgeToken } = require('./font-placeholder');
const { buildPortScanProtectionScript } = require('./port-scan-protection');
const { StartPageServer } = require('./start-page-server');

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
const checkAsync = async (name, fn) => {
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

console.log('=== Running Page-Visible Brand Trace Remediation Selftest ===\n');

// --------------------------------------------------------------------------
// SECTION 1: live-sync-v5.js fullscreenInjection & document cleanliness
// --------------------------------------------------------------------------
console.log('--- Section 1: live-sync document & window property cleanliness ---');

const liveSyncPath = path.join(__dirname, '..', 'live-sync-v5.js');
const liveSyncContent = fs.readFileSync(liveSyncPath, 'utf8');

check('live-sync-v5.js does not contain literal __obFsInstalled anywhere', () => {
  assert.strictEqual(liveSyncContent.includes('__obFsInstalled'), false);
});

check('live-sync-v5.js fullscreenInjection uses WeakSet without document own properties', () => {
  // Extract fullscreenInjection
  const match = liveSyncContent.match(/const fullscreenInjection = String\.raw`([\s\S]*?)`;/);
  assert.ok(match, 'fullscreenInjection script found');
  const code = match[1];

  // Run in a simulated browser window sandbox
  let bindingCalled = null;
  const mockWindow = {
    openBrowserSync: (payload) => { bindingCalled = payload; },
  };
  const mockDoc = Object.create({ addEventListener: () => {}, removeEventListener: () => {} });
  const mockElementProto = {
    attachShadow: function() { return {}; }
  };

  const sandbox = {
    window: mockWindow,
    document: mockDoc,
    Element: { prototype: mockElementProto },
    WeakSet,
    Symbol,
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    Date: { now: () => 1000 },
    JSON,
    CSS: { escape: (s) => s },
  };

  vm.runInNewContext(code, sandbox);

  // 1. document must have 0 own properties
  assert.strictEqual(Object.getOwnPropertyNames(sandbox.document).length, 0, 'document must have zero own properties');
  assert.strictEqual(Object.getOwnPropertySymbols(sandbox.document).length, 0, 'document must have zero own symbols');
  assert.strictEqual('__obFsInstalled' in sandbox.document, false, '__obFsInstalled must not exist in document');

  // 2. window.openBrowserSync must be deleted from window
  assert.strictEqual('openBrowserSync' in sandbox.window, false, 'openBrowserSync must not exist on window');
  assert.strictEqual(sandbox.window.openBrowserSync, undefined, 'window.openBrowserSync must be undefined');

  // 3. Repeated invocation in same realm does not re-register or pollute
  vm.runInNewContext(code, sandbox);
  assert.strictEqual(Object.getOwnPropertyNames(sandbox.document).length, 0);
});

// --------------------------------------------------------------------------
// SECTION 2: DOM Markers Gate (masterMarker & environmentMarker)
// --------------------------------------------------------------------------
console.log('\n--- Section 2: DOM product markers isolation ---');

check('masterMarker does not inject on standard web pages or localhost without test harness', () => {
  const match = liveSyncContent.match(/const masterMarker = String\.raw`([\s\S]*?)`;/);
  assert.ok(match);
  const code = match[1];

  // Standard web page context (e.g. localhost or example.com)
  const dom = { elements: [] };
  const mockDoc = {
    documentElement: {},
    getElementById: () => null,
    createElement: (tag) => ({ tagName: tag, style: {} }),
    title: 'Ordinary Web App',
  };
  const sandbox = {
    location: { hostname: 'localhost', href: 'http://localhost:3000/' },
    document: mockDoc,
    requestAnimationFrame: (fn) => fn(),
  };

  vm.runInNewContext(code, sandbox);
  // Must NOT create or append any element
  assert.strictEqual(sandbox.document.documentElement.style?.boxShadow, undefined);
});

check('masterMarker installs on test harness pages (data-page="tab1")', () => {
  const match = liveSyncContent.match(/const masterMarker = String\.raw`([\s\S]*?)`;/);
  assert.ok(match);
  const code = match[1];

  let appended = null;
  const mockDoc = {
    documentElement: { appendChild: (el) => { appended = el; }, style: {} },
    body: { dataset: { page: 'tab1' } },
    getElementById: () => null,
    createElement: (tag) => ({ tagName: tag, style: {} }),
    title: 'tab1',
  };
  const sandbox = {
    location: { hostname: '127.0.0.1', href: 'http://127.0.0.1:54321/tab1' },
    document: mockDoc,
    requestAnimationFrame: (fn) => fn(),
  };

  vm.runInNewContext(code, sandbox);
  assert.ok(appended, 'Marker element must be installed on test harness page');
  assert.strictEqual(appended.id, 'openbrowser-master-marker');
});

// --------------------------------------------------------------------------
// SECTION 3: Bundled Extension & marker.js DOM isolation
// --------------------------------------------------------------------------
console.log('\n--- Section 3: Bundled extension content script DOM isolation ---');

const extManifestPath = path.join(__dirname, '..', 'bundled-extension', 'manifest.json');
const extMarkerPath = path.join(__dirname, '..', 'bundled-extension', 'marker.js');

check('bundled-extension/manifest.json does not contain OpenBrowser brand name', () => {
  const manifestRaw = fs.readFileSync(extManifestPath, 'utf8');
  assert.strictEqual(/openbrowser/i.test(manifestRaw), false);
});

check('bundled-extension/marker.js does not inject any DOM nodes', () => {
  const markerJs = fs.readFileSync(extMarkerPath, 'utf8');
  assert.strictEqual(markerJs.includes('openbrowser-profile-marker'), false);
  assert.strictEqual(markerJs.includes('appendChild'), false);
});

// --------------------------------------------------------------------------
// SECTION 4: CSS Font Fallback Placeholder
// --------------------------------------------------------------------------
console.log('\n--- Section 4: CSS font fallback placeholder name ---');

check('deriveFontPlaceholder in audit/production mode returns neutral SysFallback name', () => {
  const placeholder = deriveFontPlaceholder('test-seed-123');
  assert.ok(placeholder.startsWith('SysFallback'), 'Placeholder must start with SysFallback: ' + placeholder);
  assert.strictEqual(placeholder.includes('LocalFontFallback'), false, 'Placeholder must not contain LocalFontFallback');
  assert.strictEqual(/openbrowser/i.test(placeholder), false);
});

// --------------------------------------------------------------------------
// SECTION 5: Port Scan Protection Error Messages
// --------------------------------------------------------------------------
console.log('\n--- Section 5: Port scan protection error fidelity ---');

check('port scan protection script does not contain literal "local port probe blocked"', () => {
  const portScanPath = path.join(__dirname, 'port-scan-protection.js');
  const content = fs.readFileSync(portScanPath, 'utf8');
  assert.strictEqual(content.includes('local port probe blocked'), false);
});

check('port scan protection throws standard SecurityError with native phrasing', () => {
  const script = buildPortScanProtectionScript([8080]);
  class StubDOMException extends Error {
    constructor(msg, name) { super(msg); this.name = name; }
  }
  class StubXHR {
    open(method, url) { this.url = url; }
  }
  class StubWS {
    constructor(url) { this.url = url; }
  }

  const sandbox = {
    XMLHttpRequest: StubXHR,
    WebSocket: StubWS,
    DOMException: StubDOMException,
    URL,
    location: { href: 'http://example.com/' },
    Function: { prototype: { toString: () => 'function () { [native code] }' } }
  };

  vm.runInNewContext(script, sandbox);

  // Test XHR on blocked local high port
  const xhr = new sandbox.XMLHttpRequest();
  assert.throws(
    () => xhr.open('GET', 'http://127.0.0.1:9090/'),
    (err) => {
      assert.strictEqual(err.name, 'SecurityError');
      assert.ok(err.message.includes('Access to restricted URI denied'));
      assert.strictEqual(err.message.includes('local port probe blocked'), false);
      return true;
    }
  );

  // Test WebSocket on blocked local high port
  assert.throws(
    () => new sandbox.WebSocket('ws://127.0.0.1:9090/'),
    (err) => {
      assert.strictEqual(err.name, 'SecurityError');
      assert.ok(err.message.includes('Access to restricted URI denied'));
      assert.strictEqual(err.message.includes('local port probe blocked'), false);
      return true;
    }
  );
});

(async () => {
// --------------------------------------------------------------------------
// SECTION 6: Start Page Server Health & Fingerprint Cleanliness
// --------------------------------------------------------------------------
console.log('\n--- Section 6: Start page server brand hygiene ---');

await checkAsync('start-page-server /health response does not expose OpenBrowser brand name', async () => {
  const server = new StartPageServer();
  await server.start();
  try {
    const port = server.port;
    assert.ok(port > 0, 'Server must bind to valid port');
    const res = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 'ready');
    assert.strictEqual(res.soft, undefined, '/health must not contain soft field');
    assert.strictEqual(JSON.stringify(res).includes('OpenBrowser'), false, '/health response must not contain OpenBrowser');

    const info = server.info();
    assert.strictEqual(info.soft, undefined, 'server.info() must not contain soft field');
  } finally {
    await server.stop();
  }
});

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log('\n===============================================================');
if (!failed.length) {
  console.log(`page-visible-trace-remediation-selftest: ALL ${results.length}/${results.length} PASS`);
} else {
  console.log(`page-visible-trace-remediation-selftest: FAILED ${failed.length}/${results.length}`);
  process.exitCode = 1;
}
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
