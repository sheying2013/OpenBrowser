'use strict';

/**
 * Coalesced persistence.
 *
 * Two properties matter here: a burst of changes must not produce a burst of
 * writes, and `await request()` must mean "the value is on disk" rather than
 * "the write is queued". The second is what keeps settings durable across a
 * quit that happens right after a change.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { createCoalescedWriter, DEFAULT_DELAY_MS } = require('./coalesced-writer');
const { deepEqual } = require('./object-utils');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

function trackingWriter(state, delayMs = 0, failTimes = 0) {
  return async () => {
    state.calls += 1;
    const call = state.calls;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((r) => setTimeout(r, delayMs));
    state.inFlight -= 1;
    if (call <= failTimes) throw new Error('write failed #' + call);
    state.persisted += 1;
  };
}

// The queue's timer is deliberately unref'd so deferred work never keeps the
// host alive on its own. A test process has nothing else pending, so it needs
// one live timer to reach the writes it is waiting for.
const keepAlive = setInterval(() => {}, 250);

(async () => {
  await checkAsync('a burst of requests produces a single write', async () => {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, persisted: 0 };
    const writer = createCoalescedWriter({ write: trackingWriter(state), delayMs: 25 });
    await Promise.all([1, 2, 3, 4, 5].map(() => writer.request()));
    assert.strictEqual(state.calls, 1, `wrote ${state.calls} times`);
    assert.strictEqual(state.persisted, 1);
  });

  await checkAsync('awaiting a request means the write already happened', async () => {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, persisted: 0 };
    const writer = createCoalescedWriter({ write: trackingWriter(state), delayMs: 5 });
    await writer.request();
    assert.strictEqual(state.persisted, 1, 'the write had not finished when the caller resumed');
    assert.strictEqual(writer.stats().waiters, 0);
  });

  await checkAsync('requests arriving during a write still resolve', async () => {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, persisted: 0 };
    const writer = createCoalescedWriter({ write: trackingWriter(state, 30), delayMs: 1 });
    const first = writer.request();
    await new Promise((r) => setTimeout(r, 10)); // land inside the first write
    const second = writer.request();
    const third = writer.request();
    await Promise.all([first, second, third]);
    assert.strictEqual(state.persisted, 2, `expected two writes, saw ${state.persisted}`);
    assert.strictEqual(state.maxInFlight, 1, 'writes must not overlap');
    assert.strictEqual(writer.stats().waiters, 0, 'a waiter was left behind');
  });

  await checkAsync('a failed write rejects its callers', async () => {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, persisted: 0 };
    const seen = [];
    const writer = createCoalescedWriter({
      write: trackingWriter(state, 0, 1),
      delayMs: 1,
      onError: (error) => seen.push(error.message),
    });
    let error = null;
    try { await writer.request(); } catch (e) { error = e; }
    assert.ok(error && /write failed/.test(error.message), error && error.message);
    assert.deepStrictEqual(seen, ['write failed #1'], 'the observer was not told');
    assert.strictEqual(writer.stats().lastError, 'write failed #1', 'the failure was not recorded');
  });

  await checkAsync('a later request retries the failed write', async () => {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, persisted: 0 };
    const writer = createCoalescedWriter({ write: trackingWriter(state, 0, 1), delayMs: 1 });
    await writer.request().catch(() => {});
    assert.ok(writer.stats().lastError, 'the first failure should be recorded');
    await writer.request();
    assert.strictEqual(state.persisted, 1, 'the retry did not persist');
    assert.strictEqual(writer.stats().lastError, null, 'a successful run should clear the error');
  });

  await checkAsync('flushNow writes without waiting for the quiet period', async () => {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, persisted: 0 };
    const writer = createCoalescedWriter({ write: trackingWriter(state), delayMs: 10000 });
    await writer.request().catch(() => {}); // arms a very long timer
    const started = Date.now();
    await writer.flushNow();
    assert.ok(Date.now() - started < 1000, 'flushNow waited for the quiet period');
    assert.ok(state.persisted >= 1, 'nothing was written');
    await writer.idle();
  });

  await checkAsync('concurrent writers never overlap', async () => {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, persisted: 0 };
    const writer = createCoalescedWriter({ write: trackingWriter(state, 8), delayMs: 1 });
    const rounds = [];
    for (let i = 0; i < 4; i += 1) {
      rounds.push(writer.request());
      await new Promise((r) => setTimeout(r, 3));
    }
    await Promise.all(rounds);
    assert.strictEqual(state.maxInFlight, 1);
    assert.ok(state.persisted >= 1);
  });

  await checkAsync('an unchanged state skips the write and still resolves', async () => {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, persisted: 0 };
    let value = { a: 1, nested: { b: [2, 3] } };
    let written = null;
    const writer = createCoalescedWriter({
      write: async () => { written = JSON.parse(JSON.stringify(value)); await trackingWriter(state)(); },
      shouldWrite: () => written === null || !deepEqual(value, written),
      delayMs: 1,
    });
    await writer.request();
    assert.strictEqual(state.persisted, 1, 'the first save should write');
    // Same content, freshly built object: nothing changed, so nothing is written.
    value = { a: 1, nested: { b: [2, 3] } };
    await writer.request();
    assert.strictEqual(state.persisted, 1, 'an unchanged state wrote again');
    assert.strictEqual(writer.stats().skipped, 1, 'the skip was not recorded');
    assert.strictEqual(writer.stats().waiters, 0);
  });

  await checkAsync('a changed state writes again', async () => {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, persisted: 0 };
    let value = { a: 1 };
    let written = null;
    const writer = createCoalescedWriter({
      write: async () => { written = JSON.parse(JSON.stringify(value)); await trackingWriter(state)(); },
      shouldWrite: () => written === null || !deepEqual(value, written),
      delayMs: 1,
    });
    await writer.request();
    value.a = 2;
    await writer.request();
    assert.strictEqual(state.persisted, 2, 'a changed state must be persisted');
    assert.strictEqual(written.a, 2);
  });

  await checkAsync('requests arriving while a skip is decided still resolve', async () => {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, persisted: 0 };
    let allowChange = false;
    const writer = createCoalescedWriter({
      write: trackingWriter(state, 20),
      shouldWrite: () => allowChange,
      delayMs: 1,
    });
    const first = writer.request(); // skipped
    const second = writer.request();
    const third = writer.request();
    await Promise.all([first, second, third]);
    assert.strictEqual(state.persisted, 0, 'nothing should have been written');
    assert.strictEqual(writer.stats().waiters, 0, 'a waiter was left behind after a skip');
    // Now let it write, to prove the queue is still usable afterwards.
    allowChange = true;
    await writer.request();
    assert.strictEqual(state.persisted, 1);
  });

  await checkAsync('a throwing predicate falls back to writing', async () => {
    const state = { calls: 0, inFlight: 0, maxInFlight: 0, persisted: 0 };
    const writer = createCoalescedWriter({
      write: trackingWriter(state),
      shouldWrite: () => { throw new Error('predicate exploded'); },
      delayMs: 1,
    });
    await writer.request();
    assert.strictEqual(state.persisted, 1, 'a broken predicate must not lose the write');
  });

  check('a writer without a function is rejected', () => {
    assert.throws(() => createCoalescedWriter({}), /write must be a function/);
    assert.throws(() => createCoalescedWriter(), /write must be a function/);
  });

  check('the quiet period has a sensible default', () => {
    assert.ok(Number.isFinite(DEFAULT_DELAY_MS) && DEFAULT_DELAY_MS > 0);
    const writer = createCoalescedWriter({ write: async () => {} });
    assert.strictEqual(writer.stats().delayMs, DEFAULT_DELAY_MS);
  });

  // ---- host wiring ----
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    check('settings go through the coalescing writer', () => {
      assert.ok(/require\('\.\/automation\/coalesced-writer'\)/.test(source), 'writer is not required');
      assert.ok(/const localSettingsWriter = createCoalescedWriter\(/.test(source), 'writer is not created');
      assert.ok(/return localSettingsWriter\.request\(\);/.test(source), 'saveLocalSettings does not use it');
    });
    check('the previous ad-hoc write body is gone from saveLocalSettings', () => {
      const body = source.match(/async function saveLocalSettings\(value\) \{[\s\S]*?\n\}/);
      assert.ok(body, 'saveLocalSettings not found');
      assert.ok(!/\.tmp/.test(body[0]), 'the write body is still inlined');
      assert.ok(!/fsp\.writeFile/.test(body[0]), 'the write body is still inlined');
    });
    check('quitting flushes any pending settings write', () => {
      assert.ok(/localSettingsWriter\.flushNow\(\)/.test(source), 'the quit chain does not flush');
    });
    check('an unchanged cache is not rewritten', () => {
      assert.ok(/require\('\.\/automation\/object-utils'\)/.test(source), 'deepEqual is not imported');
      assert.ok(/shouldWrite: \(\) => persistedSettingsSnapshot === null/.test(source), 'the skip predicate is missing');
      assert.ok(/deepEqual\(localSettingsCache, persistedSettingsSnapshot\)/.test(source), 'the predicate does not compare the cache');
      assert.ok(/persistedSettingsSnapshot = JSON\.parse\(JSON\.stringify\(localSettingsCache\)\)/.test(source),
        'the snapshot is not refreshed after a successful write');
      const body = source.match(/async function writeLocalSettingsFile\(\) \{[\s\S]*?\n\}/);
      assert.ok(body && body[0].includes('persistedSettingsSnapshot ='), 'the snapshot must be set only by the writer');
    });

    check('the file write itself is unchanged in substance', () => {
      assert.ok(/const temporary = localSettingsFile \+ '\.tmp';/.test(source), 'temp-file write is gone');
      assert.ok(/await fsp\.rename\(temporary, localSettingsFile\);/.test(source), 'atomic rename is gone');
    });
  }

  // ================= report =================
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nCOALESCED_WRITER_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${results.filter((r) => r.ok).length}/${results.length}`);
  if (failed.length) process.exitCode = 1;
  clearInterval(keepAlive);
})();
