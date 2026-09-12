'use strict';

/** Self-test for object helpers. */

const assert = require('assert');
const o = require('./object-utils');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

// ---- type checks ----

check('isPlainObject accepts object literals', () => {
  assert.strictEqual(o.isPlainObject({}), true);
  assert.strictEqual(o.isPlainObject({ a: 1 }), true);
  assert.strictEqual(o.isPlainObject(Object.create(null)), true);
});

check('isPlainObject rejects non-plain values', () => {
  assert.strictEqual(o.isPlainObject(null), false);
  assert.strictEqual(o.isPlainObject([]), false);
  assert.strictEqual(o.isPlainObject(new Date()), false);
  assert.strictEqual(o.isPlainObject(() => {}), false);
  assert.strictEqual(o.isPlainObject('text'), false);
  class Thing {}
  assert.strictEqual(o.isPlainObject(new Thing()), false);
});

check('isEmptyValue flags the values worth dropping', () => {
  assert.strictEqual(o.isEmptyValue(undefined), true);
  assert.strictEqual(o.isEmptyValue(null), true);
  assert.strictEqual(o.isEmptyValue([]), true);
  assert.strictEqual(o.isEmptyValue(''), false);
  assert.strictEqual(o.isEmptyValue(0), false);
  assert.strictEqual(o.isEmptyValue(false), false);
  assert.strictEqual(o.isEmptyValue([1]), false);
});

// ---- filterUndefined ----

check('filterUndefined drops undefined, null and empty arrays', () => {
  const out = o.filterUndefined({ a: 1, b: undefined, c: null, d: [], e: 'x', f: 0, g: false });
  assert.deepStrictEqual(out, { a: 1, e: 'x', f: 0, g: false });
});

check('filterUndefined keeps falsy but meaningful values', () => {
  const out = o.filterUndefined({ zero: 0, no: false, empty: '' });
  assert.deepStrictEqual(out, { zero: 0, no: false, empty: '' });
});

check('filterUndefined does not modify the input', () => {
  const input = { a: 1, b: undefined, c: null, d: [] };
  const snapshot = JSON.stringify(input);
  o.filterUndefined(input);
  assert.strictEqual(JSON.stringify(input), snapshot, 'input unchanged');
  assert.ok('b' in input && 'c' in input && 'd' in input);
});

check('filterUndefined can retain nulls when asked', () => {
  const out = o.filterUndefined({ a: null, b: undefined }, { keepNull: true });
  assert.deepStrictEqual(out, { a: null });
});

check('filterUndefined can drop empty strings when asked', () => {
  const out = o.filterUndefined({ a: '', b: 'x' }, { dropEmptyString: true });
  assert.deepStrictEqual(out, { b: 'x' });
});

check('filterUndefined passes non-objects through', () => {
  assert.strictEqual(o.filterUndefined(null), null);
  assert.deepStrictEqual(o.filterUndefined([1, 2]), [1, 2]);
});

// ---- filterEmptyDeep ----

check('filterEmptyDeep cleans nested objects', () => {
  const out = o.filterEmptyDeep({ a: { b: undefined, c: 1 }, d: 2 });
  assert.deepStrictEqual(out, { a: { c: 1 }, d: 2 });
});

check('filterEmptyDeep removes objects that become empty', () => {
  const out = o.filterEmptyDeep({ keep: 1, drop: { a: undefined, b: null } });
  assert.deepStrictEqual(out, { keep: 1 });
});

check('filterEmptyDeep can retain empty objects when asked', () => {
  const out = o.filterEmptyDeep({ a: { b: undefined } }, { keepEmptyObjects: true });
  assert.deepStrictEqual(out, { a: {} });
});

check('filterEmptyDeep preserves arrays and cleans their members', () => {
  const out = o.filterEmptyDeep({ list: [{ a: 1, b: undefined }, { c: 2 }] });
  assert.deepStrictEqual(out, { list: [{ a: 1 }, { c: 2 }] });
});

check('filterEmptyDeep does not modify the input', () => {
  const input = { a: { b: undefined } };
  o.filterEmptyDeep(input);
  assert.ok('b' in input.a, 'nested key preserved in the original');
});

check('filterEmptyDeep handles primitives', () => {
  assert.strictEqual(o.filterEmptyDeep(5), 5);
  assert.strictEqual(o.filterEmptyDeep('x'), 'x');
  assert.strictEqual(o.filterEmptyDeep(null), null);
});

// ---- pick / omit ----

check('pick keeps only the requested keys', () => {
  assert.deepStrictEqual(o.pick({ a: 1, b: 2, c: 3 }, ['a', 'c']), { a: 1, c: 3 });
});

check('pick ignores keys that are absent', () => {
  assert.deepStrictEqual(o.pick({ a: 1 }, ['a', 'zzz']), { a: 1 });
});

check('pick on a non-object yields an empty object', () => {
  assert.deepStrictEqual(o.pick(null, ['a']), {});
  assert.deepStrictEqual(o.pick([1], ['a']), {});
});

check('omit removes the listed keys', () => {
  assert.deepStrictEqual(o.omit({ a: 1, b: 2, c: 3 }, ['b']), { a: 1, c: 3 });
});

check('omit leaves the input untouched', () => {
  const input = { a: 1, b: 2 };
  o.omit(input, ['a']);
  assert.deepStrictEqual(input, { a: 1, b: 2 });
});

// ---- mergeDefined ----

check('mergeDefined applies defined overrides only', () => {
  const out = o.mergeDefined({ a: 1, b: 2 }, { b: 9, c: undefined });
  assert.deepStrictEqual(out, { a: 1, b: 9 }, 'undefined override ignored');
});

check('mergeDefined accepts null as a real override', () => {
  const out = o.mergeDefined({ a: 1 }, { a: null });
  assert.deepStrictEqual(out, { a: null });
});

check('mergeDefined does not modify the target', () => {
  const target = { a: 1 };
  o.mergeDefined(target, { a: 2 });
  assert.deepStrictEqual(target, { a: 1 });
});

check('mergeDefined tolerates a missing source', () => {
  assert.deepStrictEqual(o.mergeDefined({ a: 1 }, null), { a: 1 });
  assert.deepStrictEqual(o.mergeDefined(null, { a: 1 }), { a: 1 });
});

// ---- deepEqual ----

check('deepEqual compares primitives', () => {
  assert.strictEqual(o.deepEqual(1, 1), true);
  assert.strictEqual(o.deepEqual(1, 2), false);
  assert.strictEqual(o.deepEqual('a', 'a'), true);
  assert.strictEqual(o.deepEqual(null, null), true);
  assert.strictEqual(o.deepEqual(undefined, undefined), true);
  assert.strictEqual(o.deepEqual(1, '1'), false);
});

check('deepEqual handles NaN', () => {
  assert.strictEqual(o.deepEqual(NaN, NaN), true);
});

check('deepEqual compares nested objects regardless of key order', () => {
  assert.strictEqual(o.deepEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }), true);
  assert.strictEqual(o.deepEqual({ a: 1 }, { a: 2 }), false);
  assert.strictEqual(o.deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
});

check('deepEqual compares arrays by position', () => {
  assert.strictEqual(o.deepEqual([1, 2, 3], [1, 2, 3]), true);
  assert.strictEqual(o.deepEqual([1, 2], [2, 1]), false);
  assert.strictEqual(o.deepEqual([1], { 0: 1 }), false);
});

check('deepEqual survives cyclic structures', () => {
  const a = { name: 'x' };
  a.self = a;
  const b = { name: 'x' };
  b.self = b;
  assert.strictEqual(o.deepEqual(a, b), true);

  const c = { name: 'y' };
  c.self = c;
  assert.strictEqual(o.deepEqual(a, c), false);
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nOBJECT_UTILS_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
