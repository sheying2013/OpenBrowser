#!/usr/bin/env node
'use strict';

/**
 * Dedicated test suite verifying 1:1 metrics, shape, and structure parity between
 * newly added SFNT font assets (.ttf / .otf) and existing WOFF2 subsets.
 *
 * This guarantees that:
 *   - CSS @font-face rendering results (from WOFF2)
 *   - Local Font Access API FontData.blob() binaries (from SFNT)
 * are mathematically and visually identical, preventing any measureText / getBoundingClientRect
 * vs. FontData.blob() cross-inspection fingerprinters from detecting discrepancies.
 *
 * Validates 6 core dimensions across all 170 font pairs:
 *   1. Container & Identity: Magic header (00010000 / OTTO), sfntVersion, unitsPerEm, numGlyphs,
 *      checkSumAdjustment accounting, and name table (nameIDs 1, 2, 4, 6, 16, 17).
 *   2. Character Coverage: cmap subtable mappings and complete unicode codepoint set equality.
 *   3. Horizontal Metrics: hmtx advanceWidth/lsb per glyph, hhea advanceWidthMax/numberOfHMetrics,
 *      and OS/2 xAvgCharWidth.
 *   4. Vertical / Baseline Metrics: head unitsPerEm, hhea ascent/descent/lineGap,
 *      OS/2 sTypoAscender/sTypoDescender/sTypoLineGap/usWinAscent/usWinDescent.
 *   5. Glyph Outlines & Contours: glyf/loca (TrueType) and CFF (OpenType) table byte identity,
 *      plus RecordingPen verification of commands, coordinates, and contour/point counts.
 *   6. Layout & Auxiliary Tables: GPOS/GSUB/kern/GDEF and hint tables byte-for-byte identity;
 *      verification that head.checkSumAdjustment and head.modified are the only differing attributes.
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const appRoot = path.join(__dirname, '..');
const checkScript = path.join(appRoot, 'scripts', 'font-metrics-parity-check.py');

const isFast = process.argv.includes('--fast');
const isVerbose = process.argv.includes('--verbose');

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`  FAIL  ${name} - ${error.message}`);
  }
};

console.log('=== Running font-sfnt-woff2-metrics-parity-selftest ===');
console.log(`Auditing 170 font subset pairs across Windows, macOS, Linux, Android...`);
console.log(`Mode: ${isFast ? 'Fast (table-level byte comparison)' : 'Full (deep outline RecordingPen verification)'}\n`);

// Execute the Python parity audit engine with JSON output
const args = ['--json'];
if (isFast) {
  args.push('--fast');
}

let auditOutputRaw;
try {
  auditOutputRaw = execFileSync('python3', [checkScript, ...args], {
    cwd: appRoot,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 300000,
  });
} catch (err) {
  console.error('Fatal error executing font-metrics-parity-check.py:', err.message);
  if (err.stdout) {
    auditOutputRaw = err.stdout;
  } else {
    process.exit(1);
  }
}

let audit;
try {
  audit = JSON.parse(auditOutputRaw);
} catch (parseErr) {
  console.error('Failed to parse audit JSON output:', parseErr.message);
  console.error('Raw output was:', auditOutputRaw ? auditOutputRaw.slice(0, 1000) : '<empty>');
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Test Section 1: Pair count and platform completeness
// -----------------------------------------------------------------------------
check('1. Platform inventory completeness (170 pairs: 60 win, 76 mac, 24 linux, 10 android)', () => {
  assert.strictEqual(audit.pairs, 170, `Total pairs must be 170, got: ${audit.pairs}`);
  assert.strictEqual(audit.platforms.windows.total, 60, 'Windows must have 60 font pairs');
  assert.strictEqual(audit.platforms.macos.total, 76, 'macOS must have 76 font pairs');
  assert.strictEqual(audit.platforms.linux.total, 24, 'Linux must have 24 font pairs');
  assert.strictEqual(audit.platforms.android.total, 10, 'Android must have 10 font pairs');

  assert.strictEqual(audit.platforms.windows.ttf, 59, 'Windows must have 59 TTF fonts');
  assert.strictEqual(audit.platforms.windows.otf, 1, 'Windows must have 1 OTF font (times-new-roman.otf)');
  assert.strictEqual(audit.platforms.macos.ttf, 64, 'macOS must have 64 TTF fonts');
  assert.strictEqual(audit.platforms.macos.otf, 12, 'macOS must have 12 OTF fonts');
  assert.strictEqual(audit.platforms.linux.ttf, 16, 'Linux must have 16 TTF fonts');
  assert.strictEqual(audit.platforms.linux.otf, 8, 'Linux must have 8 OTF fonts');
  assert.strictEqual(audit.platforms.android.ttf, 10, 'Android must have 10 TTF fonts');
  assert.strictEqual(audit.platforms.android.otf, 0, 'Android must have 0 OTF fonts');
});

// -----------------------------------------------------------------------------
// Test Section 2: Container & Identity parity
// -----------------------------------------------------------------------------
check('2. Container & Identity: headers, sfntVersion, unitsPerEm, numGlyphs, nameIDs 1/2/4/6/16/17', () => {
  const containerFailures = [];
  for (const item of audit.results) {
    for (const f of item.failures) {
      if (f.section === 'container_identity') {
        containerFailures.push({ font: item.font_id, field: f.field, woff2: f.woff2_val, sfnt: f.sfnt_val });
      }
    }
  }
  assert.strictEqual(
    containerFailures.length,
    0,
    `Found ${containerFailures.length} container & identity mismatches: ${JSON.stringify(containerFailures.slice(0, 3))}`
  );
});

// -----------------------------------------------------------------------------
// Test Section 3: Character Coverage & cmap parity
// -----------------------------------------------------------------------------
check('3. Character Coverage: cmap subtables and complete unicode codepoint set equality', () => {
  const cmapFailures = [];
  for (const item of audit.results) {
    for (const f of item.failures) {
      if (f.section === 'character_coverage') {
        cmapFailures.push({ font: item.font_id, field: f.field, woff2: f.woff2_val, sfnt: f.sfnt_val });
      }
    }
  }
  assert.strictEqual(
    cmapFailures.length,
    0,
    `Found ${cmapFailures.length} character coverage mismatches: ${JSON.stringify(cmapFailures.slice(0, 3))}`
  );
});

// -----------------------------------------------------------------------------
// Test Section 4: Horizontal Metrics parity
// -----------------------------------------------------------------------------
check('4. Horizontal Metrics: hmtx per-glyph advanceWidth/lsb, hhea advanceWidthMax/numberOfHMetrics, OS/2 xAvgCharWidth', () => {
  const hmetricsFailures = [];
  for (const item of audit.results) {
    for (const f of item.failures) {
      if (f.section === 'horizontal_metrics') {
        hmetricsFailures.push({ font: item.font_id, field: f.field, woff2: f.woff2_val, sfnt: f.sfnt_val });
      }
    }
  }
  assert.strictEqual(
    hmetricsFailures.length,
    0,
    `Found ${hmetricsFailures.length} horizontal metrics mismatches: ${JSON.stringify(hmetricsFailures.slice(0, 3))}`
  );
});

// -----------------------------------------------------------------------------
// Test Section 5: Vertical & Baseline Metrics parity
// -----------------------------------------------------------------------------
check('5. Vertical & Baseline Metrics: head unitsPerEm, hhea ascent/descent/lineGap, OS/2 sTypoAscender/Descender/LineGap, usWinAscent/WinDescent', () => {
  const vmetricsFailures = [];
  for (const item of audit.results) {
    for (const f of item.failures) {
      if (f.section === 'vertical_baseline_metrics') {
        vmetricsFailures.push({ font: item.font_id, field: f.field, woff2: f.woff2_val, sfnt: f.sfnt_val });
      }
    }
  }
  assert.strictEqual(
    vmetricsFailures.length,
    0,
    `Found ${vmetricsFailures.length} vertical/baseline metrics mismatches: ${JSON.stringify(vmetricsFailures.slice(0, 3))}`
  );
});

// -----------------------------------------------------------------------------
// Test Section 6: Glyph Outlines & Contours parity
// -----------------------------------------------------------------------------
check('6. Glyph Outlines: glyf/loca and CFF table byte identity, contour counts and point coordinates', () => {
  const outlineFailures = [];
  for (const item of audit.results) {
    for (const f of item.failures) {
      if (f.section === 'glyph_outlines') {
        outlineFailures.push({ font: item.font_id, field: f.field, woff2: f.woff2_val, sfnt: f.sfnt_val });
      }
    }
  }
  assert.strictEqual(
    outlineFailures.length,
    0,
    `Found ${outlineFailures.length} outline mismatches: ${JSON.stringify(outlineFailures.slice(0, 3))}`
  );

  if (!isFast) {
    assert.ok(
      audit.total_glyphs_drawn > 50000,
      `Expected > 50,000 glyphs verified via RecordingPen, got: ${audit.total_glyphs_drawn}`
    );
  }
});

// -----------------------------------------------------------------------------
// Test Section 7: Layout Tables & Table Set Inventory parity
// -----------------------------------------------------------------------------
check('7. Layout & Auxiliary Tables: GPOS/GSUB/kern/GDEF byte identity and strict head attribute attribution', () => {
  const layoutFailures = [];
  for (const item of audit.results) {
    for (const f of item.failures) {
      if (f.section === 'layout_rendering' || f.section === 'table_inventory') {
        layoutFailures.push({ font: item.font_id, field: f.field, woff2: f.woff2_val, sfnt: f.sfnt_val });
      }
    }
  }
  assert.strictEqual(
    layoutFailures.length,
    0,
    `Found ${layoutFailures.length} layout/inventory mismatches: ${JSON.stringify(layoutFailures.slice(0, 3))}`
  );
});

// -----------------------------------------------------------------------------
// Test Section 8: Total Audit Summary
// -----------------------------------------------------------------------------
check('8. Full Parity Summary: pairs=170 ok=170 fail=0 across all platforms', () => {
  assert.strictEqual(audit.ok, 170, `Expected 170 OK pairs, got: ${audit.ok}`);
  assert.strictEqual(audit.fail, 0, `Expected 0 failed pairs, got: ${audit.fail}`);
  assert.strictEqual(audit.results.length, 170, 'Audit results list must contain 170 items');
});

console.log('\n--------------------------------------------------------------------------------');
console.log(`Audit Summary Metrics:`);
console.log(`  pairs=${audit.pairs} ok=${audit.ok} fail=${audit.fail}`);
console.log(`  Total glyph outlines verified: ${audit.total_glyphs_drawn.toLocaleString()}`);
console.log(`  Elapsed verification time: ${audit.elapsed_seconds}s`);
console.log('--------------------------------------------------------------------------------\n');

const failed = results.filter((item) => !item.ok);
if (!failed.length) {
  console.log(`font-sfnt-woff2-metrics-parity-selftest: OK ${results.length}/${results.length}`);
  process.exit(0);
} else {
  console.log(`font-sfnt-woff2-metrics-parity-selftest: FAIL (${failed.length} failed)`);
  process.exit(1);
}
