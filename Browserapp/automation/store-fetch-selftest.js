'use strict';

/**
 * Bounded store lookups.
 *
 * The app centre can ask for dozens of store entries in one go, and every
 * lookup downloads a package. These tests pin the two properties that matter:
 * never more than `concurrency` lookups in flight, and one bad lookup never
 * takes the whole batch down.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { fetchStoreEntries, resolveConcurrency, MAX_ENTRIES } = require('./store-fetch');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const ids = (n) => Array.from({ length: n }, (_, i) => `a`.repeat(32 - String(i).length) + String(i));

/** Fetcher that records concurrency and takes a tick. */
function trackingFetcher(state, delayMs = 5) {
  return async (id) => {
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    state.order.push(id);
    await new Promise((r) => setTimeout(r, delayMs));
    state.inFlight -= 1;
    return `icon:${id}`;
  };
}

(async () => {
  await checkAsync('work never exceeds the configured concurrency', async () => {
    const state = { inFlight: 0, maxInFlight: 0, order: [] };
    const list = ids(12);
    const out = await fetchStoreEntries(list, trackingFetcher(state), { concurrency: 3 });
    assert.strictEqual(state.maxInFlight, 3, `max in flight was ${state.maxInFlight}`);
    assert.strictEqual(Object.keys(out).length, 12);
    assert.strictEqual(out[list[4]], `icon:${list[4]}`);
  });

  await checkAsync('a single entry still works', async () => {
    const state = { inFlight: 0, maxInFlight: 0, order: [] };
    const out = await fetchStoreEntries(['abcdefghijklmnopabcdefghijklmnop'], trackingFetcher(state), { concurrency: 4 });
    assert.deepStrictEqual(out, { abcdefghijklmnopabcdefghijklmnop: 'icon:abcdefghijklmnopabcdefghijklmnop' });
    assert.strictEqual(state.maxInFlight, 1);
  });

  await checkAsync('duplicate ids are looked up once', async () => {
    const state = { inFlight: 0, maxInFlight: 0, order: [] };
    const out = await fetchStoreEntries(['dup', 'dup', 'dup'], trackingFetcher(state));
    assert.strictEqual(state.order.length, 1, 'duplicates were fetched twice');
    assert.deepStrictEqual(Object.keys(out), ['dup']);
  });

  await checkAsync('a failing lookup is dropped, the rest survive', async () => {
    const out = await fetchStoreEntries(['good', 'bad', 'also-good'], async (id) => {
      if (id === 'bad') throw new Error('store said no');
      return `icon:${id}`;
    }, { concurrency: 2 });
    assert.deepStrictEqual(Object.keys(out).sort(), ['also-good', 'good']);
  });

  await checkAsync('a value of null or undefined yields no entry', async () => {
    const out = await fetchStoreEntries(['n', 'u', 'v'], async (id) => (id === 'n' ? null : id === 'u' ? undefined : 'x'));
    assert.deepStrictEqual(out, { v: 'x' });
  });

  await checkAsync('a hung lookup is timed out instead of blocking the batch', async () => {
    const started = Date.now();
    const out = await fetchStoreEntries(['slow', 'fast'], async (id) => {
      if (id === 'slow') return new Promise(() => {}); // never settles
      return 'icon:fast';
    }, { concurrency: 2, timeoutMs: 120 });
    const elapsed = Date.now() - started;
    assert.deepStrictEqual(out, { fast: 'icon:fast' });
    assert.ok(elapsed < 2000, `timeout did not apply (${elapsed}ms)`);
  });

  await checkAsync('the batch is capped', async () => {
    let calls = 0;
    await fetchStoreEntries(ids(200), async () => { calls += 1; return 'x'; }, { concurrency: 8 });
    assert.strictEqual(calls, MAX_ENTRIES, `expected the cap to apply, saw ${calls}`);
  });

  await checkAsync('an empty request is a no-op', async () => {
    assert.deepStrictEqual(await fetchStoreEntries([], async () => { throw new Error('should not run'); }), {});
    assert.deepStrictEqual(await fetchStoreEntries(null, async () => 'x'), {});
  });

  check('a nonsense concurrency falls back to the default', () => {
    assert.strictEqual(resolveConcurrency(0), 4);
    assert.strictEqual(resolveConcurrency(-3), 4);
    assert.strictEqual(resolveConcurrency('abc'), 4);
    assert.strictEqual(resolveConcurrency(2.5), 4);
    assert.strictEqual(resolveConcurrency(6), 6);
    assert.strictEqual(resolveConcurrency(5000), MAX_ENTRIES);
  });

  check('a non-function fetcher is rejected', async () => {
    let error = null;
    try { await fetchStoreEntries(['a'], null); } catch (e) { error = e; }
    assert.ok(error instanceof TypeError);
  });

  // ---- host wiring ----
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    check('both app-centre lookups go through the bounded queue', () => {
      assert.ok(/require\('\.\/automation\/store-fetch'\)/.test(source), 'helper is not required');
      assert.ok(/fetchStoreEntries\(ids, \(id\) => fetchChromeStoreIcon\(id\)\)/.test(source), 'icons are not queued');
      assert.ok(/fetchStoreEntries\(ids, \(id\) => fetchChromeStoreMetadata\(id\)\)/.test(source), 'metadata is not queued');
    });
    check('the unbounded fan-out is gone', () => {
      assert.ok(!/Promise\.all\(ids\.map/.test(source), 'a Promise.all over ids is still present');
      assert.ok(!/entries\.filter\(\(\[, (iconUrl|metadata)\]\)/.test(source), 'the old fan-out shape is still present');
    });
    check('the store id filter still applies', () => {
      assert.ok(/map\(validChromeStoreId\)\.filter\(Boolean\)/.test(source), 'invalid store ids are no longer filtered');
      assert.ok((source.match(/map\(validChromeStoreId\)\.filter\(Boolean\)/g) || []).length >= 2, 'expected both handlers to filter');
    });
  }

  // ================= report =================
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSTORE_FETCH_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${results.filter((r) => r.ok).length}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
