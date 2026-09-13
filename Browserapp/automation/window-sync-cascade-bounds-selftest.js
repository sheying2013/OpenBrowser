#!/usr/bin/env node
'use strict';

/**
 * Unit and boundary selftest for window sync protocol cascade geometry.
 *
 * Verifies:
 * 1. Protocol compatibility: Preserves baseline cascade progression for unconstrained callers.
 * 2. Multi-monitor and negative coordinates: Correctly handles virtual display layouts
 *    (e.g., secondary display to the left x: -1920, top-left x: -1440, y: -900).
 * 3. Small screen accommodation: Width and height scale down to fit small viewports without overflow.
 * 4. High window count scalability: Cascades across 100+ windows with cyclic modulus wrapping,
 *    guaranteeing zero bounds escape the work area.
 * 5. Oversized window requests: Requests larger than workArea are constrained to fit.
 * 6. Out-of-bounds origin clamping: Initial coordinates outside workArea are brought inside.
 * 7. Malformed inputs resilience: Handles null, undefined, strings, NaN, and negative step values.
 * 8. Protocol independence: Protocol outputs satisfy all workArea constraints without relying
 *    on UI-layer clamping.
 * 9. Mutation sensitivity (--mutate): Demonstrates that removing protocol-level clamping causes
 *    out-of-bounds violations, confirming test sensitivity.
 */

const assert = require('assert');
const path = require('path');

const {
  computeCascadeBounds,
  resolveWorkArea,
  DEFAULT_MIN_WINDOW_WIDTH,
  DEFAULT_MIN_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
} = require('./protocol/window-sync-protocol');

const isMutateMode = process.argv.includes('--mutate') || process.env.MUTATE === '1';

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, pass: false, error });
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  }
};

/**
 * Validates that window bounds strictly reside within the specified work area.
 */
function assertBoundsWithinWorkArea(bounds, workArea, context = '') {
  assert.ok(Number.isInteger(bounds.left), `${context} bounds.left must be integer, got ${bounds.left}`);
  assert.ok(Number.isInteger(bounds.top), `${context} bounds.top must be integer, got ${bounds.top}`);
  assert.ok(Number.isInteger(bounds.width), `${context} bounds.width must be integer, got ${bounds.width}`);
  assert.ok(Number.isInteger(bounds.height), `${context} bounds.height must be integer, got ${bounds.height}`);
  assert.ok(bounds.width > 0, `${context} bounds.width must be positive, got ${bounds.width}`);
  assert.ok(bounds.height > 0, `${context} bounds.height must be positive, got ${bounds.height}`);

  const workX = workArea.x ?? workArea.left ?? 0;
  const workY = workArea.y ?? workArea.top ?? 0;
  const workW = workArea.width;
  const workH = workArea.height;

  assert.ok(
    bounds.left >= workX,
    `${context} left boundary violation: ${bounds.left} < workX ${workX}`
  );
  assert.ok(
    bounds.top >= workY,
    `${context} top boundary violation: ${bounds.top} < workY ${workY}`
  );
  assert.ok(
    bounds.left + bounds.width <= workX + workW,
    `${context} right boundary violation: ${bounds.left + bounds.width} > ${workX + workW}`
  );
  assert.ok(
    bounds.top + bounds.height <= workY + workH,
    `${context} bottom boundary violation: ${bounds.top + bounds.height} > ${workY + workH}`
  );
}

/**
 * Reference UI-layer clamping function for comparison.
 */
function referenceUiClamp(bounds, work) {
  const normWidth = Math.round(Number(bounds.width) || 800);
  const normHeight = Math.round(Number(bounds.height) || 600);
  const normLeft = Math.round(Number(bounds.left) || 0);
  const normTop = Math.round(Number(bounds.top) || 0);

  const width = Math.max(Math.min(320, work.width), Math.min(normWidth, work.width));
  const height = Math.max(Math.min(240, work.height), Math.min(normHeight, work.height));
  const maxX = work.x + Math.max(0, work.width - width);
  const maxY = work.y + Math.max(0, work.height - height);
  const left = Math.max(work.x, Math.min(maxX, normLeft));
  const top = Math.max(work.y, Math.min(maxY, normTop));
  return { left, top, width, height };
}

console.log(`Starting Window Sync Cascade Bounds Selftest (mode: ${isMutateMode ? 'MUTATION' : 'NORMAL'})...\n`);

// =========================================================================
// SECTION 1: Baseline Compatibility
// =========================================================================
check('baseline cascade geometry maintains existing test progression', () => {
  const cascade = computeCascadeBounds(['a', 'b', 'c'], { left: 0, top: 0, width: 800, height: 600, vs: 40 });
  assert.strictEqual(cascade.length, 3);
  assert.strictEqual(cascade[0].handle, 'a');
  assert.strictEqual(cascade[0].bounds.left, 0);
  assert.strictEqual(cascade[0].bounds.top, 0);
  assert.strictEqual(cascade[1].handle, 'b');
  assert.strictEqual(cascade[1].bounds.left, 40);
  assert.strictEqual(cascade[2].handle, 'c');
  assert.strictEqual(cascade[2].bounds.left, 80);
});

// =========================================================================
// SECTION 2: Display Work Area Resolution
// =========================================================================
check('resolveWorkArea correctly extracts bounds from diverse parameter formats', () => {
  // Direct workArea object with negative offsets
  const r1 = resolveWorkArea({ workArea: { x: -1920, y: -200, width: 1920, height: 1080 } });
  assert.strictEqual(r1.hasWorkArea, true);
  assert.strictEqual(r1.x, -1920);
  assert.strictEqual(r1.y, -200);
  assert.strictEqual(r1.width, 1920);
  assert.strictEqual(r1.height, 1080);

  // Flat parameters (as used by main.js tile layout)
  const r2 = resolveWorkArea({ left: 100, top: 50, workWidth: 1680, workHeight: 1050 });
  assert.strictEqual(r2.hasWorkArea, true);
  assert.strictEqual(r2.x, 100);
  assert.strictEqual(r2.y, 50);
  assert.strictEqual(r2.width, 1680);
  assert.strictEqual(r2.height, 1050);

  // Missing or empty workArea
  const r3 = resolveWorkArea({});
  assert.strictEqual(r3.hasWorkArea, false);

  // Invalid or zero dimensions
  const r4 = resolveWorkArea({ workArea: { width: 0, height: -100 } });
  assert.strictEqual(r4.hasWorkArea, false);
});

// =========================================================================
// SECTION 3: Multi-Monitor and Negative Coordinates
// =========================================================================
check('cascading on secondary display with negative coordinates preserves containment', () => {
  const monitors = [
    { name: 'left-monitor', workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
    { name: 'top-left-monitor', workArea: { x: -1440, y: -900, width: 1440, height: 900 } },
    { name: 'top-monitor', workArea: { x: 0, y: -1080, width: 1920, height: 1080 } },
    { name: 'right-monitor', workArea: { x: 1920, y: 120, width: 1920, height: 1080 } },
  ];

  for (const mon of monitors) {
    const handles = Array.from({ length: 25 }, (_, i) => `${mon.name}_${i}`);
    const layout = computeCascadeBounds(handles, {
      workArea: mon.workArea,
      width: 1200,
      height: 800,
      vs: 38,
    });

    assert.strictEqual(layout.length, 25);
    layout.forEach((item, index) => {
      assertBoundsWithinWorkArea(item.bounds, mon.workArea, `${mon.name}[${index}]`);
    });
  }
});

// =========================================================================
// SECTION 4: Tiny and Small Screen Adaptation
// =========================================================================
check('small and embedded viewports scale window bounds below standard minimums', () => {
  const smallScreens = [
    { x: 0, y: 0, width: 250, height: 180 },
    { x: 50, y: 50, width: 300, height: 200 },
    { x: -800, y: 0, width: 200, height: 150 },
  ];

  for (const screen of smallScreens) {
    const layout = computeCascadeBounds(['s1', 's2', 's3', 's4'], {
      workArea: screen,
      width: 1200,
      height: 800,
      vs: 30,
    });

    assert.strictEqual(layout.length, 4);
    layout.forEach((item, index) => {
      assertBoundsWithinWorkArea(item.bounds, screen, `small[${screen.width}x${screen.height}][${index}]`);
      assert.ok(item.bounds.width <= screen.width);
      assert.ok(item.bounds.height <= screen.height);
    });
  }
});

// =========================================================================
// SECTION 5: High Window Count Scalability
// =========================================================================
check('cascading 100+ windows wraps cyclically without off-screen drift', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const handles = Array.from({ length: 120 }, (_, i) => `w_${i}`);

  const layout = computeCascadeBounds(handles, {
    workArea,
    width: 1600,
    height: 900,
    vs: 40,
  });

  assert.strictEqual(layout.length, 120);
  layout.forEach((item, index) => {
    assertBoundsWithinWorkArea(item.bounds, workArea, `high-count[${index}]`);
  });

  // Verify that subsequent windows wrap around rather than drifting infinitely
  const firstBatch = layout.slice(0, 10).map((x) => x.bounds.left);
  const laterBatch = layout.slice(50, 60).map((x) => x.bounds.left);
  assert.ok(firstBatch.every((l) => l >= 0 && l <= 320));
  assert.ok(laterBatch.every((l) => l >= 0 && l <= 320));
});

// =========================================================================
// SECTION 6: Oversized Window Requests
// =========================================================================
check('window sizes larger than workArea are constrained to fit available dimensions', () => {
  const workArea = { x: 100, y: 50, width: 1280, height: 720 };
  const layout = computeCascadeBounds(['huge1', 'huge2'], {
    workArea,
    width: 2560,
    height: 1440,
  });

  assert.strictEqual(layout.length, 2);
  layout.forEach((item, index) => {
    assertBoundsWithinWorkArea(item.bounds, workArea, `oversized[${index}]`);
    assert.strictEqual(item.bounds.width, 1280);
    assert.strictEqual(item.bounds.height, 720);
    assert.strictEqual(item.bounds.left, 100);
    assert.strictEqual(item.bounds.top, 50);
  });
});

// =========================================================================
// SECTION 7: Out-of-Bounds Origin Clamping
// =========================================================================
check('initial coordinates outside workArea are safely clamped to the valid region', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const layout = computeCascadeBounds(['oob1', 'oob2'], {
    workArea,
    left: -5000,
    top: 9999,
    width: 1000,
    height: 600,
  });

  assert.strictEqual(layout.length, 2);
  layout.forEach((item, index) => {
    assertBoundsWithinWorkArea(item.bounds, workArea, `oob[${index}]`);
    assert.ok(item.bounds.left >= 0 && item.bounds.left <= 920);
    assert.ok(item.bounds.top >= 0 && item.bounds.top <= 480);
  });
});

// =========================================================================
// SECTION 8: Malformed and Edge-Case Inputs
// =========================================================================
check('resilient against null, undefined, empty, and non-numeric parameter inputs', () => {
  // Null and empty handles
  assert.deepStrictEqual(computeCascadeBounds(null), []);
  assert.deepStrictEqual(computeCascadeBounds(undefined), []);
  assert.deepStrictEqual(computeCascadeBounds([]), []);
  assert.deepStrictEqual(computeCascadeBounds(''), []);

  // Comma-delimited string
  const strLayout = computeCascadeBounds('id1, id2, id3', { workArea: { x: 0, y: 0, width: 1000, height: 800 } });
  assert.strictEqual(strLayout.length, 3);
  assert.strictEqual(strLayout[0].handle, 'id1');
  assert.strictEqual(strLayout[1].handle, 'id2');
  assert.strictEqual(strLayout[2].handle, 'id3');

  // Object elements
  const objLayout = computeCascadeBounds([{ id: 'obj1' }, { handle: 'obj2' }], {
    workArea: { x: 0, y: 0, width: 1000, height: 800 },
  });
  assert.strictEqual(objLayout[0].handle, 'obj1');
  assert.strictEqual(objLayout[1].handle, 'obj2');

  // Non-numeric and negative step values
  const weirdOptionsLayout = computeCascadeBounds(['w1'], {
    workArea: { x: 0, y: 0, width: 1000, height: 800 },
    vs: -50,
    width: 'invalid',
    height: NaN,
  });
  assert.strictEqual(weirdOptionsLayout.length, 1);
  assertBoundsWithinWorkArea(weirdOptionsLayout[0].bounds, { x: 0, y: 0, width: 1000, height: 800 }, 'weird-options');

  // Explicit dual-argument contract: handles array as 1st arg, options object with workArea as 2nd arg
  const dualArgLayout = computeCascadeBounds(['dual_a', 'dual_b'], {
    workArea: { x: -1920, y: -1080, width: 1920, height: 1080 },
    width: 1400,
    height: 900,
    vs: 40,
  });
  assert.strictEqual(dualArgLayout.length, 2);
  assert.strictEqual(dualArgLayout[0].handle, 'dual_a');
  assert.strictEqual(dualArgLayout[1].handle, 'dual_b');
  assertBoundsWithinWorkArea(dualArgLayout[0].bounds, { x: -1920, y: -1080, width: 1920, height: 1080 }, 'dual-arg[0]');
  assertBoundsWithinWorkArea(dualArgLayout[1].bounds, { x: -1920, y: -1080, width: 1920, height: 1080 }, 'dual-arg[1]');
});

// =========================================================================
// SECTION 9: Independence from UI-Layer Clamping
// =========================================================================
check('protocol layout matches reference UI-clamped bounds identically without mutation', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  const count = 16;
  const handles = Array.from({ length: count }, (_, i) => `sync_${i}`);

  const layout = computeCascadeBounds(handles, {
    left: work.x,
    top: work.y,
    width: 1700,
    height: 860,
    vs: 38,
    workWidth: work.width,
    workHeight: work.height,
  });

  layout.forEach((item, index) => {
    const raw = item.bounds;
    const clamped = referenceUiClamp(raw, work);
    assert.strictEqual(raw.left, clamped.left, `index ${index} left mismatch`);
    assert.strictEqual(raw.top, clamped.top, `index ${index} top mismatch`);
    assert.strictEqual(raw.width, clamped.width, `index ${index} width mismatch`);
    assert.strictEqual(raw.height, clamped.height, `index ${index} height mismatch`);
  });
});

// =========================================================================
// SECTION 10: Mutation Sensitivity Verification
// =========================================================================
check('mutation sensitivity: disabling protocol clamp causes out-of-bounds violations', () => {
  // Case A: Tiny screen overflow when clamping is disabled
  const tinyWorkArea = { x: 0, y: 0, width: 250, height: 180 };
  const unclampedTiny = computeCascadeBounds(['t1'], {
    workArea: tinyWorkArea,
    _disableClamp: true,
  });

  let tinyViolationCaught = false;
  try {
    assertBoundsWithinWorkArea(unclampedTiny[0].bounds, tinyWorkArea, 'unclamped-tiny');
  } catch (err) {
    tinyViolationCaught = true;
  }
  assert.ok(tinyViolationCaught, 'Disabling clamping must cause tiny screen overflow assertion failure');

  // Case B: Oversized window overflow when clamping is disabled
  const standardWorkArea = { x: 0, y: 0, width: 1280, height: 720 };
  const unclampedOversized = computeCascadeBounds(['big1'], {
    workArea: standardWorkArea,
    width: 2000,
    height: 1200,
    _disableClamp: true,
  });

  let oversizedViolationCaught = false;
  try {
    assertBoundsWithinWorkArea(unclampedOversized[0].bounds, standardWorkArea, 'unclamped-oversized');
  } catch (err) {
    oversizedViolationCaught = true;
  }
  assert.ok(oversizedViolationCaught, 'Disabling clamping must cause oversized window overflow assertion failure');

  // Case C: High window count runaway cascade when clamping is disabled
  const handles = Array.from({ length: 50 }, (_, i) => `drift_${i}`);
  const unclampedHighCount = computeCascadeBounds(handles, {
    workWidth: 1000,
    workHeight: 800,
    width: 980,
    height: 750,
    vs: 40,
    _disableClamp: true,
  });

  let runawayViolationCaught = false;
  try {
    unclampedHighCount.forEach((item, index) => {
      assertBoundsWithinWorkArea(item.bounds, { x: 0, y: 0, width: 1000, height: 800 }, `unclamped-drift[${index}]`);
    });
  } catch (err) {
    runawayViolationCaught = true;
  }
  assert.ok(runawayViolationCaught, 'Disabling clamping must cause runaway drift overflow assertion failure');
});

console.log(`\nwindow-sync-cascade-bounds-selftest: OK ${results.filter((r) => r.pass).length}/${results.length}`);
