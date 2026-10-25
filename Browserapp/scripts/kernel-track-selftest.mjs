'use strict';

/**
 * Dedicated test for Kernel Version Tracking pipeline (kernel-track.mjs).
 */

import assert from 'node:assert';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { trackKernelVersions } from './kernel-track.mjs';

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  PASS  ' + name);
  passed += 1;
};

(async () => {
  console.log('Running Kernel Track Pipeline Selftests...\n');

  // Test 1: Programmatic execution
  const report = await trackKernelVersions({ force: false });
  ok('trackKernelVersions returns report object', report && typeof report === 'object');
  ok('report has ISO timestamp', typeof report.timestamp === 'string' && !isNaN(Date.parse(report.timestamp)));
  ok('report has officialStable version string', typeof report.officialStable === 'string' && report.officialStable.length > 0);
  ok('report officialMilestone is a positive integer', Number.isInteger(report.officialMilestone) && report.officialMilestone > 100);

  // Test 2: Local inventory detection
  ok('local inventory detected codebase constant', report.local && report.local.codeConstant === '148.0.7778.165');
  ok('local inventory detected seeds', report.local.seeds && typeof report.local.seeds === 'object');
  ok('macos-x64 seed detected', Boolean(report.local.seeds['macos-x64']));
  ok('windows-x64 seed detected', Boolean(report.local.seeds['windows-x64']));
  ok('macos-arm64 seed detected', Boolean(report.local.seeds['macos-arm64']));

  // Test 3: Diff analysis
  ok('diffs array is populated', Array.isArray(report.diffs) && report.diffs.length >= 3);
  const codeDiff = report.diffs.find((d) => d.component.includes('Code Constant'));
  ok('code constant diff exists', Boolean(codeDiff));
  ok('code constant local version is 148.0.7778.165', codeDiff.localVersion === '148.0.7778.165');
  ok('code constant delta is negative (behind)', codeDiff.milestoneDelta < 0);
  ok('code constant status is BEHIND', codeDiff.status === 'BEHIND');
  ok('code constant risk is evaluated', ['HIGH', 'MEDIUM', 'LOW'].includes(codeDiff.risk));

  // Test 4: Caching behavior
  // A second call without force should hit cache
  const reportCached = await trackKernelVersions({ force: false });
  ok('subsequent execution hits cache', reportCached.fromCache === true);

  console.log(`\n======================================================`);
  console.log(`ALL ${passed} KERNEL TRACK SELFTESTS PASSED!`);
  console.log(`======================================================\n`);
  process.exit(0);
})().catch((err) => {
  console.error('FAIL in kernel-track-selftest:', err);
  process.exit(1);
});
