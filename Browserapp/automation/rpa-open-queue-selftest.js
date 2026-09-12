'use strict';

/**
 * Bounded profile launches for RPA plans.
 *
 * A plan can cover many profiles. Every profile that is not already running
 * needs a browser environment launched, which is the single heaviest step in
 * the whole flow, so the launches are queued instead of all firing at once.
 *
 * Everything here is driven through the real RpaEngine.ensureProfileRunning
 * with a stand-in engine: no CDP, no browser, no network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { RpaEngine, resolveOpenConcurrency, DEFAULT_OPEN_CONCURRENCY } = require('./rpa-engine');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

/** Engine stand-in that records how many launches overlap. */
function makeEngine(profileIds, { delayMs = 12, failFor = null } = {}) {
  const state = { inFlight: 0, maxInFlight: 0, starts: [], running: new Map() };
  return {
    state,
    running: state.running,
    profiles: new Map(profileIds.map((id) => [id, { id, name: id }])),
    async start(profile) {
      state.starts.push(profile.id);
      if (failFor && failFor.includes(profile.id)) throw new Error('launch failed: ' + profile.id);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      state.inFlight -= 1;
      const entry = { id: profile.id, port: 9000 + state.running.size };
      state.running.set(profile.id, entry);
      return entry;
    },
  };
}

function makeRpa(engine, options = {}) {
  return new RpaEngine({ engine, store: null, emit: () => {}, ...options });
}

(async () => {
  await checkAsync('many launches never exceed the queue limit', async () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    const engine = makeEngine(ids, { delayMs: 15 });
    const rpa = makeRpa(engine, { openConcurrency: 2 });
    await Promise.all(ids.map((id) => rpa.ensureProfileRunning(id)));
    assert.strictEqual(engine.state.maxInFlight, 2, `max overlapping launches was ${engine.state.maxInFlight}`);
    assert.strictEqual(engine.state.starts.length, 8);
    assert.strictEqual(engine.state.running.size, 8);
  });

  await checkAsync('a launch limit of one serialises the work', async () => {
    const ids = ['a', 'b', 'c'];
    const engine = makeEngine(ids, { delayMs: 8 });
    const rpa = makeRpa(engine, { openConcurrency: 1 });
    await Promise.all(ids.map((id) => rpa.ensureProfileRunning(id)));
    assert.strictEqual(engine.state.maxInFlight, 1);
    assert.deepStrictEqual(engine.state.starts, ['a', 'b', 'c']);
  });

  await checkAsync('the default limit is used when none is configured', async () => {
    const ids = ['d1', 'd2', 'd3', 'd4', 'd5'];
    const engine = makeEngine(ids, { delayMs: 10 });
    const rpa = makeRpa(engine);
    assert.strictEqual(rpa.openScheduler.concurrency, DEFAULT_OPEN_CONCURRENCY);
    await Promise.all(ids.map((id) => rpa.ensureProfileRunning(id)));
    assert.ok(engine.state.maxInFlight <= DEFAULT_OPEN_CONCURRENCY, `saw ${engine.state.maxInFlight}`);
  });

  await checkAsync('an already running profile is not launched again', async () => {
    const engine = makeEngine(['r1']);
    engine.running.set('r1', { id: 'r1', port: 9222 });
    const rpa = makeRpa(engine);
    const entry = await rpa.ensureProfileRunning('r1');
    assert.strictEqual(entry.port, 9222);
    assert.strictEqual(engine.state.starts.length, 0, 'a running profile must not be restarted');
  });

  await checkAsync('concurrent requests for one profile share a single launch', async () => {
    const engine = makeEngine(['s1'], { delayMs: 20 });
    const rpa = makeRpa(engine, { openConcurrency: 4 });
    const [a, b, c] = await Promise.all([
      rpa.ensureProfileRunning('s1'),
      rpa.ensureProfileRunning('s1'),
      rpa.ensureProfileRunning('s1'),
    ]);
    assert.strictEqual(engine.state.starts.length, 1, `launched ${engine.state.starts.length} times`);
    assert.strictEqual(a.port, b.port);
    assert.strictEqual(b.port, c.port);
  });

  await checkAsync('a failed launch does not strand the queue', async () => {
    const ids = ['ok1', 'bad', 'ok2', 'ok3'];
    const engine = makeEngine(ids, { delayMs: 6, failFor: ['bad'] });
    const rpa = makeRpa(engine, { openConcurrency: 2 });
    const settled = await Promise.allSettled(ids.map((id) => rpa.ensureProfileRunning(id)));
    assert.strictEqual(settled.filter((r) => r.status === 'rejected').length, 1);
    assert.strictEqual(engine.state.running.size, 3, 'the remaining launches should still complete');
  });

  await checkAsync('a missing profile is still rejected with a clear message', async () => {
    const engine = makeEngine([]);
    const rpa = makeRpa(engine);
    let error = null;
    try { await rpa.ensureProfileRunning('nope'); } catch (e) { error = e; }
    assert.ok(error && /Profile not found/.test(error.message), error && error.message);
    let emptyError = null;
    try { await rpa.ensureProfileRunning(''); } catch (e) { emptyError = e; }
    assert.ok(emptyError && /missing profile_id/.test(emptyError.message), emptyError && emptyError.message);
  });

  check('the concurrency policy is sane and overridable', () => {
    assert.strictEqual(DEFAULT_OPEN_CONCURRENCY, 2);
    assert.strictEqual(resolveOpenConcurrency(undefined) >= 1, true);
    assert.strictEqual(resolveOpenConcurrency(1), 1);
    assert.strictEqual(resolveOpenConcurrency(3), 3);
    assert.strictEqual(resolveOpenConcurrency(0), DEFAULT_OPEN_CONCURRENCY);
    assert.strictEqual(resolveOpenConcurrency(-4), DEFAULT_OPEN_CONCURRENCY);
    assert.strictEqual(resolveOpenConcurrency('nonsense'), DEFAULT_OPEN_CONCURRENCY);
    assert.strictEqual(resolveOpenConcurrency(2.5), DEFAULT_OPEN_CONCURRENCY);
    assert.strictEqual(resolveOpenConcurrency(999), 16);
  });

  check('the engine goes through the queue instead of calling start directly', () => {
    const source = fs.readFileSync(path.join(__dirname, 'rpa-engine.js'), 'utf8');
    assert.ok(/this\.openScheduler\s*\n?\s*\.schedule\(\(\) => this\.engine\.start\(profile\)/.test(source),
      'the launch does not go through the scheduler');
    assert.ok(!/\.then\(\(\) => this\.engine\.start\(profile\)\)/.test(source),
      'an unbounded launch path is still present');
    assert.ok(/new TaskScheduler\(\{[\s\S]{0,120}name: 'rpa-open'/.test(source), 'the named scheduler is missing');
  });

  // ================= report =================
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nRPA_OPEN_QUEUE_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${results.filter((r) => r.ok).length}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
