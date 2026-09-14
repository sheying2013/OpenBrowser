#!/usr/bin/env node
'use strict';

/**
 * OpenBrowser Round 3 Adversarial Acceptance Consolidated Runner
 *
 * Dedicated unified orchestrator for executing the Round 3 adversarial hardening
 * verification suite and its associated diagnostic audits:
 *
 * 1. Core Unified Acceptance Gate:
 *    - fingerprint-adversarial-round3-selftest.js (V1-V7, H1-H9, N1-N3, C1, X1, X3, X4)
 *
 * 2. Specialized Diagnostic Adversarial Audits:
 *    - navigator-device-adversarial-audit.js (Goodall)
 *    - render-media-worker-adversarial-audit.js (Hubble)
 *    - network-storage-sidechannel-adversarial-audit.js (Planck)
 *    - prototype-shape-toString-audit.js (Dalton)
 *    - mobile-persona-deep-adversarial-audit.js
 *    - desktop-persona-consistency-audit.js
 *    - cross-realm-detection-adversarial-audit.js (optional / in-progress)
 *
 * Evaluation Semantics:
 *   - PASS: Target protection strictly validated against native Chromium baseline.
 *   - WARN: Documented known open gaps in-flight by remediation teams (non-blocking).
 *   - FAIL: Unexpected hard regressions or unhandled crashes (blocks acceptance).
 *
 * All kernel launches strictly use --headless=new and clean up orphan processes.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const isHelp = argv.includes('--help') || argv.includes('-h');

if (isHelp) {
  console.log(`
OpenBrowser Round 3 Adversarial Acceptance Runner
================================================
Usage: node automation/fingerprint-round3-acceptance-runner.js [options]

Options:
  --dry-run      Validate file existence and syntax only
  --timeout=<ms> Timeout per suite in milliseconds (default: 120000)
  --help, -h     Show this message
`);
  process.exit(0);
}

const timeoutArg = argv.find((a) => a.startsWith('--timeout='));
const perSuiteTimeout = timeoutArg ? Math.max(30000, parseInt(timeoutArg.slice(10), 10)) : 120000;

const ROUND3_SUITES = [
  {
    key: 'selftest:round3',
    title: 'Round 3 Unified Adversarial Acceptance Gate (22 Assertions)',
    file: 'automation/fingerprint-adversarial-round3-selftest.js',
    type: 'CORE_GATE',
    required: true,
  },
  {
    key: 'audit:navigatordevice',
    title: 'Navigator & Device Persona Consistency Audit',
    file: 'automation/navigator-device-adversarial-audit.js',
    type: 'DIAGNOSTIC_AUDIT',
    required: true,
  },
  {
    key: 'audit:rendermedia',
    title: 'Rendering & Media Defense Audit',
    file: 'automation/render-media-worker-adversarial-audit.js',
    type: 'DIAGNOSTIC_AUDIT',
    required: true,
  },
  {
    key: 'audit:networksidechannel',
    title: 'Network & Storage Side-Channel Audit',
    file: 'automation/network-storage-sidechannel-adversarial-audit.js',
    type: 'DIAGNOSTIC_AUDIT',
    required: true,
  },
  {
    key: 'audit:prototypeshape',
    title: 'Prototype Shape & ToString Integrity Audit',
    file: 'automation/prototype-shape-toString-audit.js',
    type: 'DIAGNOSTIC_AUDIT',
    required: true,
  },
  {
    key: 'audit:mobiledeep',
    title: 'Deep Mobile Persona Adversarial Audit',
    file: 'automation/mobile-persona-deep-adversarial-audit.js',
    type: 'DIAGNOSTIC_AUDIT',
    required: true,
  },
  {
    key: 'audit:desktoppersona',
    title: 'Desktop Persona Consistency Audit (Linux/Windows)',
    file: 'automation/desktop-persona-consistency-audit.js',
    type: 'DIAGNOSTIC_AUDIT',
    required: true,
  },
  {
    key: 'audit:crossrealm',
    title: 'Cross-Realm Detection Adversarial Audit',
    file: 'automation/cross-realm-detection-adversarial-audit.js',
    type: 'DIAGNOSTIC_AUDIT',
    required: false, // In-progress by sub-agent
  },
];

function reapOrphans() {
  try {
    const reaper = path.join(appRoot, 'automation', 'reap-orphan-kernels.js');
    if (fs.existsSync(reaper)) {
      execFileSync(process.execPath, [reaper], { stdio: 'ignore' });
    }
  } catch (_) {}
}

async function runProcess(cmdArgs, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;

    const child = spawn(process.execPath, cmdArgs, {
      cwd,
      env: {
        ...process.env,
        OPENBROWSER_TEST_HEADLESS: '1',
        CI: '1',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reapOrphans();
      resolve({ code, signal, durationMs: Date.now() - startTime, stdout, stderr, timedOut: killed });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reapOrphans();
      resolve({ code: 1, signal: null, durationMs: Date.now() - startTime, stdout, stderr: stderr + '\n' + err.message, timedOut: false });
    });
  });
}

(async () => {
  console.log('======================================================================');
  console.log('  OpenBrowser Round 3 Adversarial Hardening Acceptance Runner');
  console.log('  Consolidated Acceptance Scorecard Across 5 Hardening Domains');
  console.log('======================================================================\n');

  if (isDryRun) {
    console.log('=== DRY RUN MODE: Validating Round 3 Suite Files and Syntax ===\n');
    let errors = 0;
    for (const suite of ROUND3_SUITES) {
      const fullPath = path.resolve(appRoot, suite.file);
      if (!fs.existsSync(fullPath)) {
        if (!suite.required) {
          console.log(`  SKIP  [OPTIONAL / PENDING] ${suite.key} -> ${suite.file}`);
          continue;
        }
        console.log(`  FAIL  [MISSING FILE] ${suite.key} -> ${suite.file}`);
        errors++;
        continue;
      }
      try {
        execFileSync(process.execPath, ['-c', fullPath], { stdio: 'pipe' });
        console.log(`  PASS  [SYNTAX OK] ${suite.key} (${suite.title})`);
      } catch (err) {
        console.log(`  FAIL  [SYNTAX ERROR] ${suite.key}: ${err.message}`);
        errors++;
      }
    }
    console.log(`\nDry run completed with ${errors} error(s).\n`);
    process.exit(errors > 0 ? 1 : 0);
  }

  reapOrphans();
  const results = [];
  let hardFailures = 0;

  for (const suite of ROUND3_SUITES) {
    const fullPath = path.resolve(appRoot, suite.file);
    if (!fs.existsSync(fullPath)) {
      if (!suite.required) {
        console.log(`>>> Skipping pending suite: ${suite.key} (${suite.file} not on disk yet)\n`);
        results.push({ ...suite, status: 'SKIPPED', durationSec: '0.00' });
        continue;
      }
      console.log(`>>> FAIL: Missing required suite: ${suite.key} (${suite.file})\n`);
      results.push({ ...suite, status: 'FAIL', durationSec: '0.00', reason: 'File missing' });
      hardFailures++;
      continue;
    }

    console.log(`>>> Executing [${suite.key}] ${suite.title}...`);
    const res = await runProcess([fullPath], appRoot, perSuiteTimeout);
    const durSec = (res.durationMs / 1000).toFixed(2);

    let passed = false;
    let summaryLine = '';
    const lines = (res.stdout + '\n' + res.stderr).split(/\r?\n/);
    for (const l of lines) {
      if (/TOTAL CHECKS:\s*\d+/i.test(l) || /SUMMARY/i.test(l) || /OK \d+\/\d+/i.test(l)) {
        summaryLine = l.trim();
      }
    }

    if (res.timedOut) {
      console.log(`  FAIL  [${suite.key}] TIMEOUT after ${durSec}s\n`);
      results.push({ ...suite, status: 'TIMEOUT', durationSec: durSec });
      hardFailures++;
    } else if (res.code === 0) {
      console.log(`  PASS  [${suite.key}] Finished in ${durSec}s ${summaryLine ? '(' + summaryLine + ')' : ''}\n`);
      results.push({ ...suite, status: 'PASS', durationSec: durSec, summary: summaryLine });
    } else {
      console.log(`  FAIL  [${suite.key}] Exited with code ${res.code} in ${durSec}s\n`);
      results.push({ ...suite, status: 'FAIL', durationSec: durSec, code: res.code });
      hardFailures++;
    }
  }

  console.log('======================================================================');
  console.log('  ROUND 3 CONSOLIDATED ACCEPTANCE SUMMARY');
  console.log('======================================================================');
  for (const r of results) {
    const badge = r.status === 'PASS' ? 'PASS' : (r.status === 'SKIPPED' ? 'SKIP' : 'FAIL');
    console.log(`  [${badge.padEnd(4)}] ${r.key.padEnd(26)} (${r.durationSec}s) ${r.summary || ''}`);
  }
  console.log('----------------------------------------------------------------------');
  console.log(`Total Suites: ${results.length} | Hard Failures: ${hardFailures}`);
  console.log('STATUS: ' + (hardFailures === 0 ? 'ACCEPTANCE VERIFIED (PASS)' : 'ACCEPTANCE BLOCKED (FAIL)'));
  console.log('======================================================================\n');

  reapOrphans();
  process.exit(hardFailures > 0 ? 1 : 0);
})();
