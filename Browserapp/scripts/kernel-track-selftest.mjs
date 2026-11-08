'use strict';

/**
 * Dedicated test for Kernel Version Tracking pipeline (kernel-track.mjs).
 */

import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  trackKernelVersions,
  resolveBaselinePath,
  formatMarkdownSummary,
  formatIssueBody,
} from './kernel-track.mjs';

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

  // Test 5: CI mode execution
  const reportCI = await trackKernelVersions({ ci: true });
  ok('CI mode reports enabled', reportCI.ci && reportCI.ci.enabled === true);
  ok('CI mode bypasses repo cache (MISS/isolated cache)', reportCI.fromCache === false);
  ok('CI mode cache location resides in temp directory', reportCI.cachePath.includes(os.tmpdir()));
  ok('CI mode specifies default latest.json output target', typeof reportCI.ci.outputFile === 'string' && reportCI.ci.outputFile.endsWith('latest.json'));

  // Test 6: Baseline path resolver and baseline loading
  const resolvedBase = resolveBaselinePath();
  ok('resolveBaselinePath returns valid path string', typeof resolvedBase === 'string' && resolvedBase.endsWith('kernel-track-baseline.json'));
  ok('baseline evaluation exists in CI report', Boolean(reportCI.baseline && reportCI.baseline.exists));
  ok('baseline evaluation reports sync when matching repository baseline', reportCI.baselineDrift && reportCI.baselineDrift.hasDrift === false);

  // Test 7: Drift detection with custom drifting baseline
  const tmpDriftFile = path.join(os.tmpdir(), `test-drift-baseline-${Date.now()}.json`);
  await fsp.writeFile(
    tmpDriftFile,
    JSON.stringify({
      version: '1.0.0',
      benchmark: {
        officialStable: '120.0.6099.109',
        officialMilestone: 120,
        wayfernStable: '120.0.6099.100',
      },
      local: {
        codeConstant: '148.0.7778.165',
        seeds: {},
      },
    }, null, 2),
    'utf8'
  );
  try {
    const driftReport = await trackKernelVersions({ baseline: tmpDriftFile });
    ok('drift detected with historical baseline', driftReport.baselineDrift && driftReport.baselineDrift.hasDrift === true);
    ok('drift changes identify upstream chrome update', Array.isArray(driftReport.baselineDrift.changes) && driftReport.baselineDrift.changes.some((c) => c.type === 'UPSTREAM_CHROME_STABLE'));
    ok('drift changes record milestone delta', driftReport.baselineDrift.changes.some((c) => c.milestoneDelta > 0));

    // Test 8: Issue body and Markdown summary formatting
    const issueBody = formatIssueBody(driftReport);
    ok('formatIssueBody outputs markdown with alert header', typeof issueBody === 'string' && issueBody.includes('🚨 OpenBrowser 内核版本漂移通知'));
    ok('formatIssueBody includes drift details table', issueBody.includes('基线对比变更详情'));

    const summaryMd = formatMarkdownSummary(driftReport);
    ok('formatMarkdownSummary outputs tracking summary', typeof summaryMd === 'string' && summaryMd.includes('OpenBrowser Kernel Version Tracking Summary'));
  } finally {
    await fsp.unlink(tmpDriftFile).catch(() => {});
  }

  // Test 9: Baseline initialization for uncreated file
  const tmpNewBaseFile = path.join(os.tmpdir(), `test-init-baseline-${Date.now()}.json`);
  try {
    const initReport = await trackKernelVersions({ baseline: tmpNewBaseFile });
    ok('baseline initialization succeeds for missing file', initReport.baselineDrift && initReport.baselineDrift.isInitial === true);
    const writtenRaw = await fsp.readFile(tmpNewBaseFile, 'utf8');
    const parsedInit = JSON.parse(writtenRaw);
    ok('created baseline file has valid structure', parsedInit && parsedInit.benchmark && typeof parsedInit.benchmark.officialStable === 'string');
  } finally {
    await fsp.unlink(tmpNewBaseFile).catch(() => {});
  }

  console.log(`\n======================================================`);
  console.log(`ALL ${passed} KERNEL TRACK SELFTESTS PASSED!`);
  console.log(`======================================================\n`);
  process.exit(0);
})().catch((err) => {
  console.error('FAIL in kernel-track-selftest:', err);
  process.exit(1);
});
