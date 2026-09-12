'use strict';

/**
 * Self-test for the bounded-concurrency task scheduler.
 *
 * Emphasis is on the failure modes that make a queue unusable: a rejected job
 * must not stall the queue, and a timed-out job must release its slot.
 */

const assert = require('assert');
const {
  TaskScheduler,
  SchedulerRegistry,
  withTimeout,
  normalizeConcurrency,
} = require('./task-scheduler');

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

(async () => {
  // ---- configuration ----

  check('normalizeConcurrency rejects invalid limits', () => {
    assert.strictEqual(normalizeConcurrency(4), 4);
    assert.strictEqual(normalizeConcurrency(0), 1);
    assert.strictEqual(normalizeConcurrency(-3), 1);
    assert.strictEqual(normalizeConcurrency(2.5), 1);
    assert.strictEqual(normalizeConcurrency('nope'), 1);
  });

  check('setConcurrency applies a new limit and rejects bad values', () => {
    const s = new TaskScheduler({ concurrency: 1 });
    assert.strictEqual(s.setConcurrency(3), 3);
    assert.strictEqual(s.setConcurrency(0), 1);
  });

  check('stats exposes the queue shape', () => {
    const s = new TaskScheduler({ name: 'probe', concurrency: 2 });
    const stats = s.stats();
    assert.strictEqual(stats.name, 'probe');
    assert.strictEqual(stats.concurrency, 2);
    assert.strictEqual(stats.running, 0);
    assert.strictEqual(stats.pending, 0);
    assert.strictEqual(stats.destroyed, false);
  });

  // ---- withTimeout ----

  await checkAsync('withTimeout passes a fast resolution through', async () => {
    const value = await withTimeout(Promise.resolve('fast'), 50);
    assert.strictEqual(value, 'fast');
  });

  await checkAsync('withTimeout rejects a slow promise', async () => {
    await assert.rejects(() => withTimeout(delay(80).then(() => 'late'), 20), /timed out/);
  });

  await checkAsync('withTimeout propagates the underlying rejection', async () => {
    await assert.rejects(() => withTimeout(Promise.reject(new Error('inner')), 50), /inner/);
  });

  await checkAsync('withTimeout with no limit is a pass-through', async () => {
    assert.strictEqual(await withTimeout(Promise.resolve(7), 0), 7);
    assert.strictEqual(await withTimeout(Promise.resolve(8), null), 8);
  });

  // ---- ordering & concurrency ----

  await checkAsync('a serial scheduler runs jobs one at a time in order', async () => {
    const s = new TaskScheduler({ concurrency: 1 });
    const order = [];
    let active = 0;
    let maxActive = 0;

    const jobs = [1, 2, 3].map((n) => s.schedule(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      order.push(n);
      active -= 1;
      return n;
    }));

    assert.deepStrictEqual(await Promise.all(jobs), [1, 2, 3]);
    assert.deepStrictEqual(order, [1, 2, 3], 'FIFO order preserved');
    assert.strictEqual(maxActive, 1, 'never more than one job at a time');
  });

  await checkAsync('concurrency 2 runs two jobs in parallel', async () => {
    const s = new TaskScheduler({ concurrency: 2 });
    let active = 0;
    let maxActive = 0;

    const jobs = [1, 2, 3, 4].map(() => s.schedule(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(15);
      active -= 1;
    }));

    await Promise.all(jobs);
    assert.strictEqual(maxActive, 2, 'respects the concurrency cap');
  });

  await checkAsync('queued jobs wait until a slot frees', async () => {
    const s = new TaskScheduler({ concurrency: 1 });
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });

    const first = s.schedule(async () => { await gate; return 'first'; });
    const second = s.schedule(async () => 'second');

    await delay(10);
    assert.strictEqual(s.stats().pending, 1, 'second job still queued');

    releaseFirst();
    assert.deepStrictEqual(await Promise.all([first, second]), ['first', 'second']);
  });

  // ---- failure handling (the critical case) ----

  await checkAsync('a rejected job does not stall the queue', async () => {
    const s = new TaskScheduler({ concurrency: 1 });
    const finished = [];

    const jobs = [
      s.schedule(async () => { finished.push('a'); return 'a'; }),
      s.schedule(async () => { finished.push('b'); throw new Error('boom'); }).catch((e) => `err:${e.message}`),
      s.schedule(async () => { finished.push('c'); return 'c'; }),
      s.schedule(async () => { finished.push('d'); return 'd'; }),
    ];

    // The whole batch must settle; before the fix this hung forever.
    const settled = await Promise.race([
      Promise.all(jobs),
      delay(500).then(() => 'TIMEOUT'),
    ]);

    assert.notStrictEqual(settled, 'TIMEOUT', 'queue drained despite the failure');
    assert.deepStrictEqual(settled, ['a', 'err:boom', 'c', 'd']);
    assert.deepStrictEqual(finished, ['a', 'b', 'c', 'd'], 'later jobs still ran');
    assert.strictEqual(s.stats().failed, 1);
    assert.strictEqual(s.stats().completed, 3);
    assert.strictEqual(s.stats().running, 0, 'slot released');
  });

  await checkAsync('several consecutive failures still drain', async () => {
    const s = new TaskScheduler({ concurrency: 2 });
    const jobs = [];
    for (let i = 0; i < 6; i += 1) {
      jobs.push(s.schedule(async () => {
        if (i % 2 === 0) throw new Error(`fail-${i}`);
        return i;
      }).catch((e) => e.message));
    }
    const out = await Promise.race([Promise.all(jobs), delay(500).then(() => 'TIMEOUT')]);
    assert.notStrictEqual(out, 'TIMEOUT');
    assert.strictEqual(s.stats().failed, 3);
    assert.strictEqual(s.stats().completed, 3);
  });

  await checkAsync('a failure does not block siblings running in parallel', async () => {
    const s = new TaskScheduler({ concurrency: 3 });
    const out = await Promise.all([
      s.schedule(async () => 'ok-1'),
      s.schedule(async () => { throw new Error('nope'); }).catch((e) => `err:${e.message}`),
      s.schedule(async () => 'ok-2'),
    ]);
    assert.deepStrictEqual(out, ['ok-1', 'err:nope', 'ok-2']);
  });

  await checkAsync('the error observer is notified', async () => {
    const seen = [];
    const s = new TaskScheduler({ concurrency: 1, onError: (err, ctx) => seen.push({ msg: err.message, ctx }) });
    await s.schedule(async () => { throw new Error('observed'); }, null, { stepName: 'step' }).catch(() => {});
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].msg, 'observed');
    assert.strictEqual(seen[0].ctx.stepName, 'step');
  });

  await checkAsync('a throwing observer does not break the queue', async () => {
    const s = new TaskScheduler({
      concurrency: 1,
      onError: () => { throw new Error('observer blew up'); },
    });
    const out = await Promise.race([
      Promise.all([
        s.schedule(async () => { throw new Error('job'); }).catch(() => 'caught'),
        s.schedule(async () => 'next'),
      ]),
      delay(400).then(() => 'TIMEOUT'),
    ]);
    assert.deepStrictEqual(out, ['caught', 'next']);
  });

  // ---- timeout handling ----

  await checkAsync('a timed-out job releases its slot', async () => {
    const s = new TaskScheduler({ concurrency: 1 });
    const out = await Promise.race([
      Promise.all([
        s.schedule(async () => { await delay(200); return 'slow'; }, null, { timeout: 20 })
          .catch((e) => e.code),
        s.schedule(async () => 'after'),
      ]),
      delay(600).then(() => 'TIMEOUT'),
    ]);

    assert.notStrictEqual(out, 'TIMEOUT', 'queue continued past the timeout');
    assert.deepStrictEqual(out, ['ETIMEDOUT', 'after']);
    assert.strictEqual(s.stats().timedOut, 1);
    assert.strictEqual(s.stats().running, 0);
  });

  await checkAsync('the scheduler default timeout is applied', async () => {
    const s = new TaskScheduler({ concurrency: 1, defaultTimeout: 20 });
    await assert.rejects(() => s.schedule(async () => { await delay(200); }), /timed out/);
  });

  await checkAsync('a per-job timeout overrides the default', async () => {
    const s = new TaskScheduler({ concurrency: 1, defaultTimeout: 200 });
    await assert.rejects(
      () => s.schedule(async () => { await delay(150); }, null, { timeout: 20 }),
      /timed out/
    );
  });

  // ---- serial interval ----

  // Both spacing checks observe the pause request instead of measuring the
  // wall clock. A busy machine inflates elapsed time, which made the parallel
  // assertion fail intermittently under load even when the scheduler was
  // behaving correctly.

  await checkAsync('serialInterval pauses between serial jobs', async () => {
    const pauses = [];
    const s = new TaskScheduler({
      concurrency: 1,
      serialInterval: 40,
      sleep: (ms) => { pauses.push(ms); return Promise.resolve(); },
    });
    await s.schedule(async () => 'one');
    await s.schedule(async () => 'two');
    assert.deepStrictEqual(pauses, [40, 40], 'each serial job waits out the interval');
  });

  await checkAsync('serialInterval is not applied when running in parallel', async () => {
    const pauses = [];
    const s = new TaskScheduler({
      concurrency: 2,
      serialInterval: 60,
      sleep: (ms) => { pauses.push(ms); return Promise.resolve(); },
    });
    await Promise.all([s.schedule(async () => 1), s.schedule(async () => 2)]);
    assert.deepStrictEqual(pauses, [], 'parallel mode must not insert a gap');
  });

  await checkAsync('a zero interval never asks to pause', async () => {
    const pauses = [];
    const s = new TaskScheduler({
      concurrency: 1,
      sleep: (ms) => { pauses.push(ms); return Promise.resolve(); },
    });
    await s.schedule(async () => 'one');
    await s.schedule(async () => 'two');
    assert.deepStrictEqual(pauses, []);
  });

  // ---- lifecycle ----

  await checkAsync('drain waits for the queue to empty', async () => {
    const s = new TaskScheduler({ concurrency: 2 });
    for (let i = 0; i < 4; i += 1) s.schedule(async () => { await delay(10); });
    assert.strictEqual(s.busy, true);
    await s.drain();
    assert.strictEqual(s.busy, false);
    assert.strictEqual(s.stats().completed, 4);
  });

  await checkAsync('destroy rejects queued jobs and refuses new ones', async () => {
    const s = new TaskScheduler({ concurrency: 1 });
    let release;
    const gate = new Promise((r) => { release = r; });
    const running = s.schedule(async () => { await gate; return 'running'; });
    const queued = s.schedule(async () => 'queued');

    await delay(5);
    const dropped = s.destroy();
    assert.strictEqual(dropped, 1, 'the queued job was rejected');
    await assert.rejects(() => queued, /destroyed/);
    await assert.rejects(() => s.schedule(async () => 1), /destroyed/);

    release();
    assert.strictEqual(await running, 'running', 'in-flight work still completes');
  });

  await checkAsync('schedule rejects a non-function handler', async () => {
    const s = new TaskScheduler();
    await assert.rejects(() => s.schedule(null), /must be a function/);
  });

  // ---- registry ----

  await checkAsync('the registry returns a stable scheduler per name', async () => {
    const registry = new SchedulerRegistry();
    const a = registry.get('shared');
    const b = registry.get('shared');
    assert.strictEqual(a, b, 'same instance reused');
    assert.notStrictEqual(a, registry.get('other'));
  });

  await checkAsync('registry.run queues onto the named scheduler', async () => {
    const registry = new SchedulerRegistry();
    const out = await registry.run('jobs', async (payload) => payload * 2, 21, { concurrency: 1 });
    assert.strictEqual(out, 42);
    const again = await registry.run('jobs', async (payload) => payload + 1, 41);
    assert.strictEqual(again, 42, 'reuses the existing scheduler');
  });

  await checkAsync('registry.destroy drops the scheduler and its queue', async () => {
    const registry = new SchedulerRegistry();
    const s = registry.get('doomed');
    let release;
    const gate = new Promise((r) => { release = r; });
    const running = s.schedule(async () => { await gate; });
    const queued = s.schedule(async () => 'blocked');

    await delay(5);
    assert.strictEqual(registry.destroy('doomed'), 1);
    await assert.rejects(() => queued, /destroyed/);
    assert.strictEqual(registry.names().length, 0);
    release();
    await running;
  });

  await checkAsync('a destroyed name can be acquired again', async () => {
    const registry = new SchedulerRegistry();
    registry.get('reusable');
    registry.destroy('reusable');
    const fresh = registry.get('reusable');
    assert.strictEqual(fresh.stats().destroyed, false);
    assert.strictEqual(await fresh.schedule(async () => 'ok'), 'ok');
  });

  await checkAsync('destroyAll clears every scheduler', async () => {
    const registry = new SchedulerRegistry();
    registry.get('a').schedule(async () => { await delay(50); });
    registry.get('b').schedule(async () => { await delay(50); });
    const dropped = registry.destroyAll();
    assert.ok(dropped >= 0);
    assert.deepStrictEqual(registry.names(), []);
  });

  // ---- report ----
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  console.log(`\nTASK_SCHEDULER_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
