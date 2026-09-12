#!/usr/bin/env node
'use strict';

const assert = require('assert');
const vm = require('vm');
const {
  normalizePortAllowList,
  buildPortScanProtectionScript,
} = require('./port-scan-protection');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${error.message}`); process.exitCode = 1; }
};
const checkAsync = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`  FAIL  ${name} — ${error.message}`); process.exitCode = 1; }
};

function createSandbox(allow) {
  class StubWebSocket {
    constructor(url, protocols) { this.url = url; this.protocols = protocols; }
  }
  class StubEventSource {
    constructor(url, options) { this.url = url; this.options = options; }
  }
  class StubXHR {
    open(method, url) { this.method = method; this.url = url; }
  }
  class StubImage {
    constructor() { this._src = ''; this.attributes = {}; this.events = []; }
    get src() { return this._src; }
    set src(value) { this._src = String(value); this.attributes.src = String(value); }
    setAttribute(name, value) { this.attributes[String(name)] = String(value); if (String(name) === 'src') this._src = String(value); }
    getAttribute(name) { return this.attributes[String(name)]; }
    dispatchEvent(event) { this.events.push(event); return true; }
  }
  class StubDOMException extends Error {
    constructor(message, name) { super(message); this.name = name || 'Error'; }
  }
  const navigator = {
    lastBeacon: null,
    sendBeacon(url, data) { this.lastBeacon = { url: String(url), data }; return true; },
  };
  const sandbox = {
    console,
    URL,
    DOMException: StubDOMException,
    location: { href: 'http://example.test/' },
    navigator,
    WebSocket: StubWebSocket,
    EventSource: StubEventSource,
    XMLHttpRequest: StubXHR,
    HTMLImageElement: StubImage,
    Event: class StubEvent { constructor(type) { this.type = type; } },
    queueMicrotask,
    fetch: (url) => Promise.resolve({ ok: true, url: String(url) }),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(buildPortScanProtectionScript(allow), context);
  return { context, navigator, StubImage };
}

(async () => {
  check('port allow list is normalised and sorted', () => {
    assert.deepStrictEqual(normalizePortAllowList('80, 443, 8080 bad 70000 0 8080'), [80, 443, 8080]);
    assert.deepStrictEqual(normalizePortAllowList([8080, '9000', 9000, -1, 70000]), [8080, 9000]);
  });

  check('generated script parses', () => {
    assert.doesNotThrow(() => new Function(buildPortScanProtectionScript([8080])));
  });

  const allow8080 = createSandbox([8080]);

  await checkAsync('fetch blocks a non-allowlisted loopback high port', async () => {
    await assert.rejects(
      () => allow8080.context.fetch('http://127.0.0.1:9999/'),
      (error) => error && error.name === 'TypeError'
    );
  });

  await checkAsync('fetch allows an allowlisted loopback high port', async () => {
    const response = await allow8080.context.fetch('http://127.0.0.1:8080/');
    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.url, 'http://127.0.0.1:8080/');
  });

  check('WebSocket blocks non-allowlisted loopback ports', () => {
    assert.throws(() => new allow8080.context.WebSocket('ws://127.0.0.1:9999/'), (error) => error && error.name === 'SecurityError');
  });

  check('WebSocket allows allowlisted ports and stays native-looking', () => {
    const socket = new allow8080.context.WebSocket('ws://127.0.0.1:8080/');
    assert.strictEqual(socket.url, 'ws://127.0.0.1:8080/');
    assert.strictEqual(allow8080.context.WebSocket.toString(), 'function WebSocket() { [native code] }');
  });

  check('XMLHttpRequest.open blocks a direct probe', () => {
    assert.throws(
      () => new allow8080.context.XMLHttpRequest().open('GET', 'http://localhost:9999/'),
      (error) => error && error.name === 'SecurityError'
    );
  });

  check('EventSource blocks IPv6 loopback probes', () => {
    assert.throws(
      () => new allow8080.context.EventSource('http://[::1]:9999/'),
      (error) => error && error.name === 'SecurityError'
    );
  });

  check('sendBeacon reports a native-style false result', () => {
    assert.strictEqual(allow8080.navigator.sendBeacon('http://127.0.0.1:9999/', 'x'), false);
    assert.strictEqual(allow8080.navigator.sendBeacon('http://127.0.0.1:8080/', 'x'), true);
  });

  await checkAsync('image src keeps the attempted URL but suppresses the load', async () => {
    const image = new allow8080.context.HTMLImageElement();
    image.src = 'http://127.0.0.1:9999/icon.png';
    assert.strictEqual(image.src, 'http://127.0.0.1:9999/icon.png');
    assert.strictEqual(image.getAttribute('src'), '');
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(image.events.length, 1);
    assert.strictEqual(image.events[0].type, 'error');
  });

  check('non-local targets are untouched', () => {
    const socket = new allow8080.context.WebSocket('ws://example.test:9999/');
    assert.strictEqual(socket.url, 'ws://example.test:9999/');
  });

  const failed = results.filter((item) => !item.ok);
  if (!failed.length) console.log(`port-scan-protection-selftest: OK ${results.length}/${results.length}`);
  else {
    console.log(`port-scan-protection-selftest: FAILED ${failed.length}/${results.length}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error('port-scan-protection-selftest: crashed', (error && error.stack) || error);
  process.exitCode = 1;
});
