'use strict';

/** Self-test for port helpers, the deferred queue, and DoH URL/IP utilities. */

const assert = require('assert');
const net = require('net');
const ports = require('./port-utils');
const { DeferredQueue } = require('./deferred-queue');
const { getIpFromAnswer, buildFullPath, isAbsoluteUrl, combineUrls } = require('./doh-resolver');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Occupy a port for the duration of a test. */
async function occupyPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    release: () => new Promise((resolve) => server.close(resolve)),
  };
}

(async () => {
  // ================= port helpers =================

  await checkAsync('findFreePort returns a usable port number', async () => {
    const port = await ports.findFreePort();
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `unexpected port ${port}`);
    // The port should not be occupied right after being released.
    assert.strictEqual(await ports.isPortOpen('127.0.0.1', port, 300), false);
  });

  await checkAsync('isPortOpen reports a listening port as open', async () => {
    const held = await occupyPort();
    try {
      assert.strictEqual(await ports.isPortOpen('127.0.0.1', held.port, 1000), true);
    } finally {
      await held.release();
    }
  });

  await checkAsync('isPortOpen reports a closed port as free', async () => {
    const port = await ports.findFreePort();
    assert.strictEqual(await ports.isPortOpen('127.0.0.1', port, 300), false);
  });

  await checkAsync('resolveAvailablePort keeps the preferred port when free', async () => {
    const preferred = await ports.findFreePort();
    const resolved = await ports.resolveAvailablePort(preferred);
    assert.strictEqual(resolved, preferred);
  });

  await checkAsync('resolveAvailablePort moves away from a busy port', async () => {
    const held = await occupyPort();
    try {
      const resolved = await ports.resolveAvailablePort(held.port);
      assert.notStrictEqual(resolved, held.port, 'busy port must not be handed out');
      assert.ok(resolved > 0);
    } finally {
      await held.release();
    }
  });

  await checkAsync('resolveAvailablePort ignores an invalid preference', async () => {
    const resolved = await ports.resolveAvailablePort('nonsense');
    assert.ok(Number.isInteger(resolved) && resolved > 0);
    const tooBig = await ports.resolveAvailablePort(99999);
    assert.ok(tooBig !== 99999);
  });

  await checkAsync('resolveAvailablePorts returns distinct ports', async () => {
    const list = await ports.resolveAvailablePorts(3);
    assert.strictEqual(new Set(list).size, list.length, 'no duplicates');
    assert.ok(list.length <= 3);
  });

  await checkAsync('resolveAvailablePorts handles a zero request', async () => {
    assert.deepStrictEqual(await ports.resolveAvailablePorts(0), []);
  });

  // ================= deferred queue =================

  check('add and addAll accumulate items', () => {
    const q = new DeferredQueue({ delayMs: 5, handler: async () => {} });
    q.add('a').add('b');
    q.addAll(['c', 'd']);
    assert.strictEqual(q.size, 4);
  });

  check('addAll ignores non-arrays', () => {
    const q = new DeferredQueue({ handler: async () => {} });
    q.addAll(null);
    assert.strictEqual(q.size, 0);
  });

  check('start refuses to schedule an empty queue', () => {
    const q = new DeferredQueue({ delayMs: 5, handler: async () => {} });
    assert.strictEqual(q.start(), false);
    assert.strictEqual(q.scheduled, false);
  });

  await checkAsync('start runs the handler after the delay', async () => {
    const batches = [];
    const q = new DeferredQueue({ delayMs: 20, handler: async (items) => { batches.push(items); } });
    q.add(1).add(2);
    assert.strictEqual(q.start(), true);
    assert.strictEqual(q.scheduled, true);

    await delay(60);
    assert.deepStrictEqual(batches, [[1, 2]]);
    assert.strictEqual(q.size, 0);
    assert.strictEqual(q.scheduled, false);
  });

  await checkAsync('start restarts the quiet period when called again', async () => {
    const batches = [];
    const q = new DeferredQueue({ delayMs: 30, handler: async (items) => { batches.push(items); } });
    q.add(1);
    q.start();
    await delay(15);
    q.add(2);
    q.start(); // restart

    await delay(20);
    assert.strictEqual(batches.length, 0, 'run was postponed');

    await delay(40);
    assert.deepStrictEqual(batches, [[1, 2]], 'both items handled once');
  });

  await checkAsync('pause cancels the run but keeps the queue', async () => {
    const batches = [];
    const q = new DeferredQueue({ delayMs: 15, handler: async (items) => { batches.push(items); } });
    q.add('kept');
    q.start();
    assert.strictEqual(q.pause(), true);
    await delay(40);
    assert.deepStrictEqual(batches, []);
    assert.strictEqual(q.size, 1, 'items retained');
    assert.strictEqual(q.pause(), false, 'nothing left to pause');
  });

  await checkAsync('cancel clears the queue and reports the count', async () => {
    const q = new DeferredQueue({ delayMs: 15, handler: async () => {} });
    q.addAll([1, 2, 3]);
    q.start();
    assert.strictEqual(q.cancel(), 3);
    assert.strictEqual(q.size, 0);
    await delay(40);
    assert.strictEqual(q.stats().runs, 0);
  });

  await checkAsync('flush processes everything immediately', async () => {
    const q = new DeferredQueue({ delayMs: 1000, handler: async () => {} });
    q.addAll([1, 2, 3]);
    const processed = await q.flush();
    assert.strictEqual(processed, 3);
    assert.strictEqual(q.size, 0);
    assert.strictEqual(q.stats().processed, 3);
  });

  await checkAsync('flush on an empty queue is a no-op', async () => {
    const q = new DeferredQueue({ handler: async () => {} });
    assert.strictEqual(await q.flush(), 0);
    assert.strictEqual(q.stats().runs, 0);
  });

  await checkAsync('items added during a run are left for the next one', async () => {
    const seen = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const q = new DeferredQueue({
      handler: async (items) => { seen.push(items); await gate; },
    });
    q.add('first');
    const running = q.flush();
    await delay(5);
    q.add('second');
    release();
    await running;

    assert.deepStrictEqual(seen, [['first']]);
    assert.strictEqual(q.size, 1, 'late item queued for the next run');
    assert.strictEqual(await q.flush(), 1);
    assert.deepStrictEqual(seen[1], ['second']);
  });

  await checkAsync('a failing handler requeues the batch', async () => {
    let attempt = 0;
    const errors = [];
    const q = new DeferredQueue({
      handler: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('transient');
      },
      onError: (err, items) => errors.push({ msg: err.message, count: items.length }),
    });
    q.addAll(['x', 'y']);
    assert.strictEqual(await q.flush(), 0, 'nothing processed on failure');
    assert.strictEqual(q.size, 2, 'batch requeued');
    assert.deepStrictEqual(errors, [{ msg: 'transient', count: 2 }]);

    assert.strictEqual(await q.flush(), 2, 'second attempt succeeds');
    assert.strictEqual(q.size, 0);
  });

  await checkAsync('a throwing error observer does not break the queue', async () => {
    let calls = 0;
    const q = new DeferredQueue({
      handler: async () => { calls += 1; if (calls === 1) throw new Error('boom'); },
      onError: () => { throw new Error('observer blew up'); },
    });
    q.add(1);
    await q.flush();
    assert.strictEqual(await q.flush(), 1, 'queue still usable');
  });

  await checkAsync('concurrent flush calls do not double-process', async () => {
    let batches = 0;
    const q = new DeferredQueue({ handler: async () => { batches += 1; await delay(20); } });
    q.addAll([1, 2]);
    const [a, b] = await Promise.all([q.flush(), q.flush()]);
    assert.strictEqual(batches, 1, 'handler ran once');
    assert.strictEqual(a + b, 2, 'the batch was processed exactly once');
  });

  await checkAsync('idle waits for the in-flight run', async () => {
    let finished = false;
    const q = new DeferredQueue({ handler: async () => { await delay(20); finished = true; } });
    q.add(1);
    void q.flush();
    await q.idle();
    assert.strictEqual(finished, true);
  });

  check('stats reports the queue shape', () => {
    const q = new DeferredQueue({ delayMs: 42, handler: async () => {} });
    const stats = q.stats();
    assert.strictEqual(stats.pending, 0);
    assert.strictEqual(stats.running, false);
    assert.strictEqual(stats.delayMs, 42);
  });

  // ================= DoH url / ip helpers =================

  check('getIpFromAnswer takes the last valid address', () => {
    assert.strictEqual(getIpFromAnswer(['1.1.1.1', '2.2.2.2']), '2.2.2.2');
  });

  check('getIpFromAnswer skips entries that are not addresses', () => {
    assert.strictEqual(getIpFromAnswer(['cname.example.com', '3.3.3.3', 'trailing']), '3.3.3.3');
  });

  check('getIpFromAnswer accepts IPv6', () => {
    assert.strictEqual(getIpFromAnswer(['2001:db8::1']), '2001:db8::1');
  });

  check('getIpFromAnswer returns null when nothing is usable', () => {
    assert.strictEqual(getIpFromAnswer([]), null);
    assert.strictEqual(getIpFromAnswer(['not-an-ip']), null);
    assert.strictEqual(getIpFromAnswer(null), null);
    assert.strictEqual(getIpFromAnswer([42]), null);
  });

  check('isAbsoluteUrl recognises schemes and protocol-relative paths', () => {
    assert.strictEqual(isAbsoluteUrl('https://a.test/x'), true);
    assert.strictEqual(isAbsoluteUrl('http://a.test'), true);
    assert.strictEqual(isAbsoluteUrl('//cdn.test/x'), true);
    assert.strictEqual(isAbsoluteUrl('/api/x'), false);
    assert.strictEqual(isAbsoluteUrl('api/x'), false);
  });

  check('combineUrls joins without doubling or dropping slashes', () => {
    assert.strictEqual(combineUrls('https://a.test/api/', 'v1'), 'https://a.test/api/v1');
    assert.strictEqual(combineUrls('https://a.test/api', '/v1'), 'https://a.test/api/v1');
    assert.strictEqual(combineUrls('https://a.test/', '/v1'), 'https://a.test/v1');
  });

  check('buildFullPath resolves relative paths against the base', () => {
    assert.strictEqual(buildFullPath('https://a.test/api/', 'v1/x'), 'https://a.test/api/v1/x');
    assert.strictEqual(buildFullPath('https://a.test/api', 'v1'), 'https://a.test/api/v1');
  });

  check('buildFullPath leaves absolute requests untouched', () => {
    assert.strictEqual(buildFullPath('https://a.test/api/', 'https://b.test/y'), 'https://b.test/y');
    assert.strictEqual(buildFullPath(null, '/local'), '/local');
  });

  // ================= report =================
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  console.log(`\nRUNTIME_UTILS_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
