'use strict';

/**
 * Local API server port behaviour.
 *
 * A busy port used to reject `start()`, which took the whole automation stack
 * (Local API + RPA + window sync + app centre + proxy library) down with it.
 * These tests drive the REAL server over a REAL socket: no mocks.
 */

const http = require('http');
const net = require('net');
const assert = require('assert');
const { LocalApiServer } = require('./local-api-server.js');
const { findFreePort, isPortOpen } = require('./port-utils.js');

const results = [];
function record(name, ok, err) {
  results.push({ name, ok, err });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  -> ${err}`}`);
}
function check(name, fn) {
  try { fn(); record(name, true); }
  catch (e) { record(name, false, e.message || String(e)); }
}
async function checkAsync(name, fn) {
  try { await fn(); record(name, true); }
  catch (e) { record(name, false, e.message || String(e)); }
}

/** Hold a port for the duration of one test. */
async function occupyPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    release: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function httpGet(port, pathname, apiKey) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: apiKey ? { 'api-key': apiKey } : {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('request timed out')));
    req.end();
  });
}

function newServer(options) {
  return new LocalApiServer({ apiKey: 'port-test-key', ...options });
}

(async () => {
  // ---------- preferred port is free ----------
  await checkAsync('keeps the preferred port when it is free', async () => {
    const preferred = await findFreePort();
    const api = newServer({ port: preferred });
    const info = await api.start();
    assert.strictEqual(info.port, preferred, 'bound port should equal the preferred one');
    assert.strictEqual(info.requestedPort, preferred);
    assert.strictEqual(info.portFallback, null, 'no fallback should be recorded');
    assert.strictEqual(await isPortOpen('127.0.0.1', preferred, 500), true, 'kernel should be listening');
    await api.stop();
  });

  // ---------- preferred port is busy ----------
  await checkAsync('falls back to a free port when the preferred one is busy', async () => {
    const held = await occupyPort();
    const api = newServer({ port: held.port });
    const info = await api.start();
    assert.notStrictEqual(info.port, held.port, 'must not report the busy port');
    assert.ok(Number.isInteger(info.port) && info.port > 0, `unexpected port ${info.port}`);
    assert.strictEqual(info.requestedPort, held.port, 'the request is still reported');
    assert.ok(info.portFallback && info.portFallback.reason, 'fallback reason should be reported');
    assert.strictEqual(info.portFallback.port, info.port);
    await api.stop();
    await held.release();
  });

  await checkAsync('the fallback port really serves requests', async () => {
    const held = await occupyPort();
    const api = newServer({ port: held.port });
    const info = await api.start();
    const res = await httpGet(info.port, '/status', 'port-test-key');
    assert.strictEqual(res.status, 200, `unexpected status ${res.status}`);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.code, 0);
    assert.strictEqual(payload.data.port, info.port, 'body should report the live port');
    assert.strictEqual(payload.data.name, 'openbrowser-local-api');
    await api.stop();
    await held.release();
  });

  await checkAsync('reports the fallback through info() so MCP clients can follow', async () => {
    const held = await occupyPort();
    const api = newServer({ port: held.port });
    await api.start();
    const info = api.info();
    assert.strictEqual(typeof info.url, 'string');
    assert.ok(info.url.endsWith(`:${info.port}/`), `url should carry the live port: ${info.url}`);
    assert.strictEqual(info.portFallback.requested, held.port);
    await api.stop();
    await held.release();
  });

  // ---------- fallback disabled ----------
  await checkAsync('honours allowPortFallback:false and surfaces the bind error', async () => {
    const held = await occupyPort();
    const api = newServer({ port: held.port, allowPortFallback: false });
    let error = null;
    try { await api.start(); } catch (e) { error = e; }
    assert.ok(error, 'start() should reject');
    assert.strictEqual(error.code, 'EADDRINUSE');
    assert.strictEqual(api.server, null, 'the failed server must not stay around');
    await held.release();
  });

  await checkAsync('a failed bind leaves the instance reusable', async () => {
    const held = await occupyPort();
    const api = newServer({ port: held.port, allowPortFallback: false });
    await api.start().catch(() => {});
    // Free the port and retry: a stale listener would throw EADDRINUSE again.
    const preferred = held.port;
    await held.release();
    const info = await api.start();
    assert.strictEqual(info.port, preferred);
    assert.strictEqual(info.portFallback, null);
    await api.stop();
  });

  // ---------- port 0 ----------
  await checkAsync('port 0 asks the OS for a port without recording a fallback', async () => {
    const api = newServer({ port: 0 });
    const info = await api.start();
    assert.ok(Number.isInteger(info.port) && info.port > 0, `unexpected port ${info.port}`);
    assert.strictEqual(info.requestedPort, 0);
    assert.strictEqual(info.portFallback, null);
    await api.stop();
  });

  // ---------- invalid preference ----------
  check('a nonsense port falls back to the documented default', () => {
    const api = newServer({ port: 'not-a-port' });
    assert.strictEqual(api.requestedPort, 50325);
    assert.strictEqual(api.port, 50325);
  });

  check('an out-of-range port falls back to the documented default', () => {
    assert.strictEqual(newServer({ port: 99999 }).requestedPort, 50325);
    assert.strictEqual(newServer({ port: 70000 }).requestedPort, 50325);
  });

  check('a negative port falls back to the documented default', () => {
    assert.strictEqual(newServer({ port: -1 }).requestedPort, 50325);
  });

  check('an omitted port keeps the documented default', () => {
    assert.strictEqual(newServer({}).requestedPort, 50325);
  });

  // ---------- lifecycle ----------
  await checkAsync('stop() releases the port and clears fallback state', async () => {
    const held = await occupyPort();
    const api = newServer({ port: held.port });
    const info = await api.start();
    assert.ok(info.portFallback);
    await api.stop();
    assert.strictEqual(api.portFallback, null, 'fallback state should be cleared');
    assert.strictEqual(api.server, null);
    assert.strictEqual(await isPortOpen('127.0.0.1', info.port, 500), false, 'port should be free again');
    await held.release();
  });

  await checkAsync('start() is idempotent and reports the same live port', async () => {
    const preferred = await findFreePort();
    const api = newServer({ port: preferred });
    const first = await api.start();
    const second = await api.start();
    assert.strictEqual(second.port, first.port);
    assert.strictEqual(second.startedAt, first.startedAt);
    await api.stop();
  });

  // ---------- whole automation stack ----------
  await checkAsync('the automation stack survives a busy port and stops cleanly', async () => {
    const os = require('os');
    const fsp = require('fs/promises');
    const path = require('path');
    const { startAutomation } = require('./index.js');
    const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-port-stack-'));
    const held = await occupyPort();
    const events = [];
    const stack = await startAutomation({
      app: { getPath: () => userData, getVersion: () => '1.0.0' },
      engine: { running: new Map() },
      port: held.port,
      emit: (event) => events.push(event),
    });
    assert.notStrictEqual(stack.info.port, held.port, 'the stack must not claim the busy port');
    assert.ok(stack.info.portFallback, 'the stack should report why it moved');
    const emitted = events.find((event) => event.type === 'local-api');
    assert.ok(emitted, 'a local-api event should be emitted');
    assert.strictEqual(emitted.port, stack.info.port, 'the event must carry the live port');
    const res = await httpGet(stack.info.port, '/status', stack.apiKey);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.parse(res.body).data.port, stack.info.port);
    await stack.stop();
    assert.strictEqual(await isPortOpen('127.0.0.1', stack.info.port, 500), false, 'the port should be released');
    await held.release();
  });

  // ================= report =================
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\nLOCAL_API_PORT_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
