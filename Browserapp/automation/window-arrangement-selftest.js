'use strict';

/** Self-test for the window arrangement planner (pure computation). */

const assert = require('assert');
const {
  arrange, planTile, planStack, planCustom, placeWindows,
  distributeAcrossDisplays, availableArea, withinDisplays, minHeightFor, planGridFor, LAYOUT,
} = require('./window-arrangement');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const FHD = { id: 's1', width: 1920, height: 1080, x: 0, y: 0 };
const UHD = { id: 's2', width: 3840, height: 2160, x: 1920, y: 0 };

// ---- area math ----

check('availableArea subtracts margins on both axes', () => {
  const area = availableArea(FHD);
  assert.strictEqual(area.availableWidth, 1920 - 30);
  assert.strictEqual(area.availableHeight, 1080 - 20);
});

check('availableArea honours custom margins', () => {
  const area = availableArea(FHD, { x: 50, y: 40 });
  assert.strictEqual(area.availableWidth, 1820);
  assert.strictEqual(area.availableHeight, 1000);
});

check('availableArea never returns a negative size', () => {
  const area = availableArea({ width: 10, height: 5 });
  assert.strictEqual(area.availableWidth, 0);
  assert.strictEqual(area.availableHeight, 0);
});

check('minHeightFor differs per platform', () => {
  assert.strictEqual(minHeightFor('darwin'), LAYOUT.MIN_HEIGHT_DARWIN);
  assert.strictEqual(minHeightFor('win32'), LAYOUT.MIN_HEIGHT);
  assert.ok(minHeightFor('darwin') > minHeightFor('win32'));
});

// ---- tile planning ----

check('a single window fills the available area', () => {
  const plan = planTile({ totalWindows: 1, availableWidth: 1890, availableHeight: 1060, minWidth: 500, minHeight: 200 });
  assert.strictEqual(plan.colNum, 1);
  assert.strictEqual(plan.winWidth, 1890);
  assert.strictEqual(plan.winHeight, 1060);
});

check('two windows fit on one row when space allows', () => {
  const plan = planTile({ totalWindows: 2, availableWidth: 1890, availableHeight: 1060, minWidth: 500, minHeight: 200 });
  assert.strictEqual(plan.colNum, 2);
  assert.strictEqual(plan.rowNum, 1);
  assert.strictEqual(plan.winWidth, Math.floor((1890 - LAYOUT.GAP_X) / 2));
});

check('four windows use a 2x2 grid on a large screen', () => {
  const plan = planTile({ totalWindows: 4, availableWidth: 1890, availableHeight: 1060, minWidth: 500, minHeight: 200 });
  assert.strictEqual(plan.colNum, 2);
  assert.strictEqual(plan.rowNum, 2);
  assert.strictEqual(plan.winWidth, 937);
  assert.strictEqual(plan.winHeight, 525);
});

check('short screens widen the grid rather than stacking unreadably', () => {
  // 300px cannot hold two 200px rows, so the planner must widen the grid and
  // report that the requested minimums do not actually fit.
  const plan = planTile({ totalWindows: 4, availableWidth: 1890, availableHeight: 300, minWidth: 500, minHeight: 200 });
  assert.ok(plan.colNum >= 3, `expected a wider grid, got ${plan.colNum} columns`);
  assert.ok(plan.winWidth >= 500, 'width minimum still honoured');
  assert.strictEqual(plan.overcrowded, true, 'overflow is surfaced to the caller');
});

check('planner flags an overcrowded grid instead of hiding the overflow', () => {
  const plan = planTile({ totalWindows: 12, availableWidth: 700, availableHeight: 300, minWidth: 500, minHeight: 200 });
  assert.strictEqual(plan.overcrowded, true, 'caller can detect that minimums do not fit');
});

check('five windows prefer a balanced grid over a lopsided one', () => {
  // On a wide screen 3 columns x 2 rows beats 2 x 3 (bigger cells, fuller rows).
  const plan = planTile({ totalWindows: 5, availableWidth: 1900, availableHeight: 800, minWidth: 500, minHeight: 200 });
  assert.strictEqual(plan.colNum, 3);
  assert.strictEqual(plan.rowNum, 2);
});

check('narrow screens fall back to a taller grid instead of overflowing columns', () => {
  const plan = planTile({ totalWindows: 5, availableWidth: 1300, availableHeight: 800, minWidth: 500, minHeight: 200 });
  assert.strictEqual(plan.colNum, 2, 'only two columns fit at the minimum width');
  assert.strictEqual(plan.rowNum, 3);
  assert.ok(plan.winWidth >= 500);
});

check('tile never shrinks below the minimum size', () => {
  const plan = planTile({ totalWindows: 9, availableWidth: 600, availableHeight: 400, minWidth: 500, minHeight: 200 });
  assert.ok(plan.winWidth >= 500);
  assert.ok(plan.winHeight >= 200);
});

check('tile redistributes leftover vertical space into the row gap', () => {
  const plan = planTile({ totalWindows: 4, availableWidth: 1200, availableHeight: 1000, minWidth: 500, minHeight: 200 });
  const used = plan.winHeight * 2 + plan.gapY;
  assert.ok(Math.abs(used - 1000) <= 2, `rows should fill the height, used ${used}`);
});

// ---- stack planning ----

check('stack layout overlaps windows horizontally', () => {
  const plan = planStack({ totalWindows: 3, availableWidth: 1800, availableHeight: 1000, minWidth: 500, stackOffset: 80 });
  assert.ok(plan.gapX < 0, 'negative gap produces the overlap');
  assert.strictEqual(plan.winHeight, 1000, 'stacked windows use full height');
  assert.strictEqual(plan.colNum, 3);
});

check('stack falls back gracefully when the offset does not fit', () => {
  const plan = planStack({ totalWindows: 10, availableWidth: 1800, availableHeight: 1000, minWidth: 500, stackOffset: 200 });
  assert.ok(plan.winWidth >= 500, 'never narrower than the minimum');
  assert.ok(Number.isFinite(plan.gapX));
});

check('stack handles a single window and an empty set', () => {
  const one = planStack({ totalWindows: 1, availableWidth: 1800, availableHeight: 1000, minWidth: 500 });
  assert.strictEqual(one.winWidth, 1800);
  const none = planStack({ totalWindows: 0, availableWidth: 1800, availableHeight: 1000, minWidth: 500 });
  assert.strictEqual(none.colNum, 0);
});

// ---- custom planning ----

check('custom layout follows the requested row count', () => {
  const plan = planCustom({
    totalWindows: 6, availableWidth: 1890, availableHeight: 1060,
    minWidth: 500, minHeight: 200, rowNum: 2,
  });
  assert.strictEqual(plan.rowNum, 2);
  assert.strictEqual(plan.colNum, 3);
});

check('custom layout uses the requested window size when given', () => {
  const plan = planCustom({
    totalWindows: 2, availableWidth: 1890, availableHeight: 1060,
    minWidth: 500, minHeight: 200, rowNum: 1, width: 700, height: 600,
  });
  assert.strictEqual(plan.winWidth, 700);
  assert.strictEqual(plan.winHeight, 600);
});

check('custom layout clamps a requested size up to the minimum', () => {
  const plan = planCustom({
    totalWindows: 1, availableWidth: 1890, availableHeight: 1060,
    minWidth: 500, minHeight: 200, rowNum: 1, width: 100, height: 50,
  });
  assert.strictEqual(plan.winWidth, 500);
  assert.strictEqual(plan.winHeight, 200);
});

check('custom layout can overflow when explicitly allowed', () => {
  const options = {
    totalWindows: 4, availableWidth: 1000, availableHeight: 500,
    minWidth: 500, minHeight: 200, rowNum: 1, width: 900, height: 450,
  };
  const overflow = planCustom(Object.assign({}, options, { horizontalOverflow: true, verticalOverflow: true }));
  assert.strictEqual(overflow.winWidth, 900, 'size preserved when overflow is permitted');

  const clipped = planCustom(Object.assign({}, options, { horizontalOverflow: false, verticalOverflow: false }));
  assert.ok(clipped.gapX <= overflow.gapX || clipped.winWidth === 900);
});

// ---- placement ----

check('placement honours the display origin', () => {
  const plan = planTile({ totalWindows: 1, availableWidth: 1890, availableHeight: 1060, minWidth: 500, minHeight: 200 });
  const placed = placeWindows({ totalWindows: 1, display: UHD, plan });
  assert.strictEqual(placed[0].x, 1920 + LAYOUT.MARGIN_X);
  assert.strictEqual(placed[0].y, LAYOUT.MARGIN_Y);
  assert.strictEqual(placed[0].displayId, 's2');
});

check('placement advances by size plus gap', () => {
  const plan = { winWidth: 900, winHeight: 500, gapX: 15, gapY: 10, colNum: 2 };
  const placed = placeWindows({ totalWindows: 3, display: FHD, plan });
  assert.strictEqual(placed[0].x, 15);
  assert.strictEqual(placed[1].x, 15 + 915);
  assert.strictEqual(placed[2].x, 15);
  assert.strictEqual(placed[2].y, 10 + 510);
});

// ---- distribution ----

check('distribution splits proportionally to display width', () => {
  const alloc = distributeAcrossDisplays(6, [FHD, UHD]);
  assert.strictEqual(alloc.reduce((a, b) => a + b, 0), 6, 'every window is assigned');
  assert.ok(alloc[1] >= alloc[0], 'the wider display gets at least as many');
});

check('distribution assigns every window when shares do not divide evenly', () => {
  for (const total of [1, 2, 3, 5, 7, 11]) {
    const alloc = distributeAcrossDisplays(total, [FHD, UHD, FHD]);
    assert.strictEqual(alloc.reduce((a, b) => a + b, 0), total, `total ${total} fully assigned`);
  }
});

check('distribution handles degenerate input', () => {
  assert.deepStrictEqual(distributeAcrossDisplays(0, [FHD]), []);
  assert.deepStrictEqual(distributeAcrossDisplays(5, []), []);
});

// ---- end to end ----

check('arrange places four windows in a 2x2 grid', () => {
  const positions = arrange({ totalWindows: 4, displays: [FHD], platform: 'win32' });
  assert.strictEqual(positions.length, 4);
  assert.strictEqual(positions[0].width, 937);
  assert.strictEqual(positions[0].height, 525);
  assert.ok(withinDisplays(positions, [FHD]), 'all windows stay on screen');
});

check('arrange keeps everything inside a single 1080p display', () => {
  for (const layout of ['tile', 'stack']) {
    for (const count of [1, 2, 3, 4, 6, 9]) {
      const positions = arrange({ totalWindows: count, displays: [FHD], layout, platform: 'win32' });
      assert.strictEqual(positions.length, count, `${layout}/${count} produced the right count`);
      assert.ok(withinDisplays(positions, [FHD]), `${layout}/${count} stayed on screen`);
    }
  }
});

check('arrange spreads windows across multiple displays', () => {
  const displays = [FHD, UHD];
  const positions = arrange({ totalWindows: 8, displays, platform: 'win32' });
  assert.strictEqual(positions.length, 8);
  const usedDisplays = new Set(positions.map((p) => p.displayId));
  assert.strictEqual(usedDisplays.size, 2, 'both displays contribute');
  assert.ok(withinDisplays(positions, displays), 'each window sits on its own display');
});

check('arrange respects a macOS minimum height', () => {
  const shortScreen = { id: 's', width: 1200, height: 900, x: 0, y: 0 };
  const mac = arrange({ totalWindows: 4, displays: [shortScreen], platform: 'darwin' });
  assert.ok(mac.every((p) => p.height >= LAYOUT.MIN_HEIGHT_DARWIN), 'macOS floor applied');
});

check('arrange returns nothing for degenerate input', () => {
  assert.deepStrictEqual(arrange({ totalWindows: 0, displays: [FHD] }), []);
  assert.deepStrictEqual(arrange({ totalWindows: 4, displays: [] }), []);
});

check('arrange accepts a custom layout request', () => {
  const positions = arrange({
    totalWindows: 4,
    displays: [FHD],
    layout: 'custom',
    platform: 'win32',
    options: { rowNum: 2, width: 800, height: 400 },
  });
  assert.strictEqual(positions.length, 4);
  assert.strictEqual(positions[0].width, 800);
  assert.strictEqual(positions[0].height, 400);
});

check('withinDisplays rejects an off-screen rectangle', () => {
  assert.strictEqual(withinDisplays([{ displayId: 's1', x: 5000, y: 0, width: 100, height: 100 }], [FHD]), false);
  assert.strictEqual(withinDisplays([{ displayId: 'unknown', x: 0, y: 0, width: 10, height: 10 }], [FHD]), false);
});

// ---- grid choice for a work area ----

/** The minimums the bounds clamp actually enforces. */
const GRID_MIN_WIDTH = 320;
const gridMinHeight = (platform) => Math.max(240, minHeightFor(platform));
const grid = (count, area, platform = 'linux') => planGridFor({
  totalWindows: count,
  workArea: area,
  minWidth: GRID_MIN_WIDTH,
  minHeight: gridMinHeight(platform),
  platform,
});

check('a single window takes the whole work area', () => {
  const g = grid(1, { width: 1920, height: 1080 });
  assert.deepStrictEqual({ cols: g.cols, rows: g.rows }, { cols: 1, rows: 1 });
  assert.strictEqual(g.overcrowded, false);
});

check('two windows go side by side rather than stacked', () => {
  const g = grid(2, { width: 1920, height: 1080 });
  assert.deepStrictEqual({ cols: g.cols, rows: g.rows }, { cols: 2, rows: 1 });
});

check('a row of very narrow windows is not chosen just because it fits', () => {
  // Five minimum-width windows technically fit across a 1920px area, but the
  // result is five 372px strips. A two-row grid is the usable answer.
  const g = grid(5, { width: 1920, height: 1080 });
  assert.strictEqual(g.rows, 2, 'must use two rows');
  assert.ok(g.cols >= 3 && g.cols <= 5, `unexpected column count ${g.cols}`);
  assert.ok(g.winWidth >= GRID_MIN_WIDTH, 'windows stay usable');
});

check('a wide display puts three windows in one row', () => {
  const g = grid(3, { width: 1920, height: 1080 });
  assert.deepStrictEqual({ cols: g.cols, rows: g.rows }, { cols: 3, rows: 1 });
});

check('the chosen grid never returns a cell below the minimums', () => {
  for (const area of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    for (let count = 1; count <= 9; count += 1) {
      const g = grid(count, area);
      if (g.overcrowded) continue;
      assert.ok(g.winWidth >= GRID_MIN_WIDTH, `${count} on ${area.width} width`);
      assert.ok(g.winHeight >= gridMinHeight('linux'), `${count} on ${area.width} height`);
    }
  }
});

check('an impossible layout is flagged instead of silently overlapping', () => {
  const g = grid(16, { width: 1280, height: 720 });
  assert.strictEqual(g.overcrowded, true, 'sixteen windows cannot meet the minimums here');
  const roomy = grid(4, { width: 1920, height: 1080 });
  assert.strictEqual(roomy.overcrowded, false);
});

check('the platform minimum height is respected on macOS', () => {
  const tall = grid(9, { width: 1920, height: 900 }, 'darwin');
  const short = grid(9, { width: 1920, height: 900 }, 'linux');
  assert.ok(minHeightFor('darwin') > minHeightFor('linux'), 'macOS has the taller minimum');
  // The taller floor can only make a layout harder to satisfy.
  assert.ok(tall.overcrowded || tall.rows <= short.rows, 'macOS must not pack more rows than linux');
});

check('degenerate input returns a safe shape instead of throwing', () => {
  for (const bad of [0, -3, NaN, undefined, null]) {
    const g = planGridFor({ totalWindows: bad, workArea: { width: 1920, height: 1080 } });
    assert.strictEqual(g.cols, 0);
    assert.strictEqual(g.rows, 0);
    assert.strictEqual(g.overcrowded, false);
  }
  const g = planGridFor({ totalWindows: 4 });
  assert.strictEqual(g.cols, 1, 'a missing work area collapses to a single cell');
  assert.strictEqual(g.overcrowded, true, 'and reports that it does not fit');
});

// ---- report ----
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
}
console.log(`\nWINDOW_ARRANGEMENT_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
if (failed.length) process.exitCode = 1;
