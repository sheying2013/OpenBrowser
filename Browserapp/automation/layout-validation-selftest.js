'use strict';

/** Self-test for window arrangement validation and grid placement. */

const assert = require('assert');
const {
  checkArrangeConfig,
  normalizeArrangeConfig,
  describeArrangeConfigProblems,
  computeGrid,
  minHeightForPlatform,
  LIMITS,
} = require('./layout-validation');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const VALID = { x: 10, y: 10, width: 600, height: 500, gapX: 20, gapY: 20, colNum: 3, screenId: 0 };

check('accepts a well-formed config', () => {
  assert.strictEqual(checkArrangeConfig(VALID, 'win32'), true);
  assert.strictEqual(checkArrangeConfig(VALID, 'darwin'), true);
});

check('rejects non-integer values', () => {
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { x: 1.5 }), 'win32'), false);
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { colNum: '3' }), 'win32'), false);
});

check('rejects missing fields', () => {
  const partial = Object.assign({}, VALID);
  delete partial.colNum;
  assert.strictEqual(checkArrangeConfig(partial, 'win32'), false);
});

check('rejects out-of-range positions', () => {
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { x: -1 }), 'win32'), false);
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { y: 10000 }), 'win32'), false);
});

check('enforces the minimum window width', () => {
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { width: 499 }), 'win32'), false);
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { width: 500 }), 'win32'), true);
});

check('applies a taller minimum height on macOS', () => {
  assert.strictEqual(minHeightForPlatform('darwin'), 400);
  assert.strictEqual(minHeightForPlatform('win32'), 200);
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { height: 300 }), 'win32'), true);
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { height: 300 }), 'darwin'), false);
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { height: 400 }), 'darwin'), true);
});

check('allows negative gaps down to the limit', () => {
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { gapX: -1 }), 'win32'), true);
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { gapX: -10000 }), 'win32'), false);
});

check('bounds the column count', () => {
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { colNum: 0 }), 'win32'), false);
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { colNum: 100 }), 'win32'), false);
  assert.strictEqual(checkArrangeConfig(Object.assign({}, VALID, { colNum: 99 }), 'win32'), true);
});

check('rejects non-object input', () => {
  assert.strictEqual(checkArrangeConfig(null, 'win32'), false);
  assert.strictEqual(checkArrangeConfig('nope', 'win32'), false);
});

// ---- normalization ----

check('normalize fills missing fields with defaults', () => {
  const out = normalizeArrangeConfig({}, 'win32');
  assert.strictEqual(checkArrangeConfig(out, 'win32'), true);
  assert.strictEqual(out.width, 600);
  assert.strictEqual(out.colNum, 3);
});

check('normalize clamps out-of-range values', () => {
  const out = normalizeArrangeConfig({ x: -50, y: 99999, width: 10, height: 99999, colNum: 500 }, 'win32');
  assert.strictEqual(out.x, LIMITS.MIN_POSITION);
  assert.strictEqual(out.y, LIMITS.MAX_POSITION);
  assert.strictEqual(out.width, LIMITS.MIN_WIDTH);
  assert.strictEqual(out.height, LIMITS.MAX_HEIGHT);
  assert.strictEqual(out.colNum, LIMITS.MAX_COL_NUM);
  assert.strictEqual(checkArrangeConfig(out, 'win32'), true);
});

check('normalize rounds floats and tolerates junk input', () => {
  const out = normalizeArrangeConfig({ x: 10.6, gapX: 'abc', colNum: 2.4 }, 'win32');
  assert.strictEqual(out.x, 11);
  assert.strictEqual(out.gapX, 20, 'junk falls back to the default');
  assert.strictEqual(out.colNum, 2);
});

check('normalize respects the platform height floor', () => {
  const win = normalizeArrangeConfig({ height: 100 }, 'win32');
  const mac = normalizeArrangeConfig({ height: 100 }, 'darwin');
  assert.strictEqual(win.height, LIMITS.MIN_HEIGHT);
  assert.strictEqual(mac.height, LIMITS.MAC_MIN_HEIGHT);
  assert.strictEqual(checkArrangeConfig(mac, 'darwin'), true);
});

// ---- diagnostics ----

check('describes each invalid field with a reason', () => {
  const problems = describeArrangeConfigProblems({ x: -1, width: 10, colNum: 0, y: 1, height: 500, gapX: 0, gapY: 0, screenId: 0 }, 'win32');
  const keys = problems.map((p) => p.key).sort();
  assert.deepStrictEqual(keys, ['colNum', 'width', 'x']);
  assert.ok(problems.every((p) => typeof p.reason === 'string' && p.reason.length > 0));
});

check('describes non-object input', () => {
  const problems = describeArrangeConfigProblems(null, 'win32');
  assert.strictEqual(problems.length, 1);
  assert.strictEqual(problems[0].key, '*');
});

check('reports no problems for a valid config', () => {
  assert.deepStrictEqual(describeArrangeConfigProblems(VALID, 'win32'), []);
});

check('reports non-integer fields', () => {
  const problems = describeArrangeConfigProblems(Object.assign({}, VALID, { x: 1.5 }), 'win32');
  assert.ok(problems.some((p) => p.key === 'x' && /integer/.test(p.reason)));
});

// ---- grid placement ----

check('computeGrid lays out a single row when columns allow', () => {
  // width is raised to the 500px floor, so stride becomes width + gapX.
  const grid = computeGrid({ x: 0, y: 0, width: 500, height: 300, gapX: 10, gapY: 10, colNum: 3, screenId: 0 }, 3, 'win32');
  assert.deepStrictEqual(grid.map((p) => p.x), [0, 510, 1020]);
  assert.deepStrictEqual(grid.map((p) => p.y), [0, 0, 0]);
  assert.ok(grid.every((p) => p.width === 500));
});

check('computeGrid wraps to a new row', () => {
  const grid = computeGrid({ x: 5, y: 5, width: 500, height: 300, gapX: 10, gapY: 20, colNum: 2, screenId: 0 }, 5, 'win32');
  assert.deepStrictEqual(grid.map((p) => p.x), [5, 515, 5, 515, 5]);
  assert.deepStrictEqual(grid.map((p) => p.y), [5, 5, 325, 325, 645]);
});

check('computeGrid returns nothing for zero windows', () => {
  assert.deepStrictEqual(computeGrid(VALID, 0, 'win32'), []);
});

check('computeGrid tolerates an invalid config by normalizing first', () => {
  const grid = computeGrid({ colNum: 100, width: 1 }, 2, 'darwin');
  assert.strictEqual(grid.length, 2);
  assert.ok(grid[0].width >= LIMITS.MIN_WIDTH, 'width was clamped');
  assert.ok(grid[0].height >= LIMITS.MAC_MIN_HEIGHT, 'height respects macOS floor');
});

check('negative gaps allow overlapping placements', () => {
  const grid = computeGrid({ x: 0, y: 0, width: 600, height: 500, gapX: -100, gapY: 0, colNum: 2, screenId: 0 }, 2, 'win32');
  assert.deepStrictEqual(grid.map((p) => p.x), [0, 500]);
  assert.strictEqual(grid[1].x, grid[0].x + 600 - 100);
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nLAYOUT_VALIDATION_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
